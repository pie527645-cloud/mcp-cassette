/**
 * Quote-aware command-line tokenizer for safe `spawn(cmd, args, { shell: false })`.
 *
 * Rules:
 * - Rejects empty commands, null bytes, and unclosed single/double quotes.
 * - Single quotes `'...'` preserve everything literally until the closing `'`.
 * - Double quotes `"..."` use the cross-platform `CommandLineToArgvW` backslash rule:
 *   2n backslashes before `"` -> n backslashes + quote boundary;
 *   2n+1 backslashes before `"` -> n backslashes + literal `"`;
 *   backslashes not followed by `"` are preserved literally (keeping Windows paths intact).
 * - Outside quotes, `\` followed by whitespace, `"`, or `'` escapes that character;
 *   all other backslashes (such as `C:\path\to\server.js`) are preserved literally.
 */
export function tokenizeCommand(commandLine: string): string[] {
  if (commandLine.includes('\0')) {
    throw new Error('Invalid command: null byte is not allowed in --stdio command.');
  }

  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quoteMode: 'none' | 'single' | 'double' = 'none';
  let i = 0;
  const len = commandLine.length;

  while (i < len) {
    const ch = commandLine[i]!;

    if (quoteMode === 'single') {
      if (ch === "'") {
        quoteMode = 'none';
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }

    if (quoteMode === 'double') {
      if (ch === '\\') {
        let slashCount = 0;
        while (i + slashCount < len && commandLine[i + slashCount] === '\\') {
          slashCount += 1;
        }
        const nextChar = commandLine[i + slashCount];
        if (nextChar === '"') {
          current += '\\'.repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 0) {
            quoteMode = 'none';
          } else {
            current += '"';
          }
          i += slashCount + 1;
          continue;
        }
        current += '\\'.repeat(slashCount);
        i += slashCount;
        continue;
      }

      if (ch === '"') {
        quoteMode = 'none';
        i += 1;
        continue;
      }

      current += ch;
      i += 1;
      continue;
    }

    // quoteMode === 'none'
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      quoteMode = 'single';
      hasToken = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoteMode = 'double';
      hasToken = true;
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const next = commandLine[i + 1];
      if (next === ' ' || next === '\t' || next === '"' || next === "'") {
        current += next;
        hasToken = true;
        i += 2;
        continue;
      }
      current += ch;
      hasToken = true;
      i += 1;
      continue;
    }

    current += ch;
    hasToken = true;
    i += 1;
  }

  if (quoteMode !== 'none') {
    throw new Error(`Invalid command: unclosed ${quoteMode} quote in --stdio command.`);
  }

  if (hasToken) {
    tokens.push(current);
  }

  if (tokens.length === 0 || !tokens[0]) {
    throw new Error('Invalid command: --stdio command must specify an executable.');
  }

  return tokens;
}
