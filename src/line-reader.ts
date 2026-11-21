import { StringDecoder } from 'node:string_decoder';

export const MAX_JSONRPC_LINE_BYTES = 20 * 1024 * 1024; // 20 MB cap

export interface JsonLineReaderOptions {
  maxLineBytes?: number;
  onLine: (line: string) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Streaming newline-delimited reader with strict per-line byte ceiling and zero regexes.
 * Strips optional trailing `\r` from `\r\n` endings cleanly.
 */
export function attachLineReader(
  stream: NodeJS.ReadableStream,
  options: JsonLineReaderOptions,
): () => void {
  const maxBytes = options.maxLineBytes ?? MAX_JSONRPC_LINE_BYTES;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let bufferedBytes = 0;
  let closed = false;

  const emitLine = (rawLine: string): void => {
    const cleaned = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (cleaned.length > 0) {
      options.onLine(cleaned);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    const chunkByteLen = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let start = 0;
    let newlineIdx = str.indexOf('\n', start);

    if (newlineIdx === -1) {
      bufferedBytes += chunkByteLen;
      if (bufferedBytes > maxBytes) {
        closed = true;
        options.onError?.(
          new Error(`JSON-RPC line exceeds maximum allowed size of ${maxBytes} bytes.`),
        );
        return;
      }
      buffer += str;
      return;
    }

    while (newlineIdx !== -1) {
      const segment = str.slice(start, newlineIdx);
      const lineByteLen = bufferedBytes + Buffer.byteLength(segment, 'utf8');
      if (lineByteLen > maxBytes) {
        closed = true;
        options.onError?.(
          new Error(`JSON-RPC line exceeds maximum allowed size of ${maxBytes} bytes.`),
        );
        return;
      }
      const fullLine = buffer + segment;
      buffer = '';
      bufferedBytes = 0;
      emitLine(fullLine);

      start = newlineIdx + 1;
      newlineIdx = str.indexOf('\n', start);
    }

    if (start < str.length) {
      buffer = str.slice(start);
      bufferedBytes = Buffer.byteLength(buffer, 'utf8');
      if (bufferedBytes > maxBytes) {
        closed = true;
        options.onError?.(
          new Error(`JSON-RPC line exceeds maximum allowed size of ${maxBytes} bytes.`),
        );
      }
    }
  };

  const onEnd = (): void => {
    if (closed) return;
    closed = true;
    const remainder = decoder.end();
    if (remainder.length > 0) {
      buffer += remainder;
      bufferedBytes += Buffer.byteLength(remainder, 'utf8');
    }
    if (bufferedBytes > maxBytes) {
      options.onError?.(
        new Error(`JSON-RPC line exceeds maximum allowed size of ${maxBytes} bytes.`),
      );
      return;
    }
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = '';
      bufferedBytes = 0;
    }
    options.onEnd?.();
  };

  const onError = (err: Error): void => {
    if (closed) return;
    closed = true;
    options.onError?.(err);
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);

  return () => {
    closed = true;
    stream.off('data', onData);
    stream.off('end', onEnd);
    stream.off('error', onError);
  };
}
