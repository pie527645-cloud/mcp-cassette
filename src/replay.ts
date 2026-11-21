import { canonicalParamsKey, loadCassette } from './cassette.js';
import { attachLineReader } from './line-reader.js';
import { redactValue } from './redact.js';
import type {
  CassetteInteraction,
  CassetteV1,
  JsonRpcId,
  JsonRpcResponse,
  JsonValue,
  ReplayOptions,
} from './types.js';

export const STRICT_MISMATCH_ERROR_CODE = -32001;

interface InteractionBucket {
  entries: CassetteInteraction[];
  cursor: number;
}

const DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'ping',
]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidRpcId(val: unknown): val is JsonRpcId {
  return val === null || typeof val === 'string' || typeof val === 'number';
}

function buildJsonRpcResponse(id: JsonRpcId, interaction: CassetteInteraction): JsonRpcResponse {
  if (interaction.response?.error !== undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: interaction.response.error,
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    result: interaction.response?.result !== undefined ? interaction.response.result : null,
  };
}

export interface CassetteMatcher {
  handleMessage(rawMessage: unknown): JsonRpcResponse | JsonRpcResponse[] | null;
}

/**
 * Stateful in-memory JSON-RPC 2.0 matcher backed by a recorded CassetteV1.
 * Uses `Object.create(null)` maps and `Object.hasOwn` to eliminate prototype-key collisions.
 */
export function createCassetteMatcher(
  cassette: CassetteV1,
  options: { strict?: boolean } = {},
): CassetteMatcher {
  const strict = Boolean(options.strict);

  const exactBuckets: Record<string, InteractionBucket> = Object.create(null) as Record<
    string,
    InteractionBucket
  >;
  const byMethod: Record<string, CassetteInteraction[]> = Object.create(null) as Record<
    string,
    CassetteInteraction[]
  >;
  const recordedToolsSet: Record<string, true> = Object.create(null) as Record<string, true>;

  for (const interaction of cassette.interactions) {
    if (interaction.kind !== 'request' || interaction.response === undefined) {
      continue;
    }
    const method = interaction.method;
    const paramKey = canonicalParamsKey(interaction.params);
    const compositeKey = `${method}\0${paramKey}`;

    if (!Object.hasOwn(exactBuckets, compositeKey)) {
      exactBuckets[compositeKey] = { entries: [], cursor: 0 };
    }
    exactBuckets[compositeKey]!.entries.push(interaction);

    if (!Object.hasOwn(byMethod, method)) {
      byMethod[method] = [];
    }
    byMethod[method]!.push(interaction);

    if (
      method === 'tools/call' &&
      isPlainObject(interaction.params) &&
      typeof interaction.params.name === 'string'
    ) {
      recordedToolsSet[interaction.params.name] = true;
    }
  }

  const recordedMethods = Object.keys(byMethod).sort();
  const recordedTools = Object.keys(recordedToolsSet).sort();

  const matchSingleObject = (msg: unknown): JsonRpcResponse | null => {
    if (!isPlainObject(msg)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request: expected JSON-RPC 2.0 object.',
        },
      };
    }

    const hasId = Object.hasOwn(msg, 'id');
    const rawId = hasId ? msg.id : undefined;

    if (typeof msg.method !== 'string' || msg.method.length === 0) {
      const respId: JsonRpcId = isValidRpcId(rawId) ? rawId : null;
      return {
        jsonrpc: '2.0',
        id: respId,
        error: {
          code: -32600,
          message: 'Invalid Request: missing string "method".',
        },
      };
    }

    // Strict JSON-RPC 2.0 notification handling (e.g. `notifications/initialized`):
    // notifications MUST NOT receive any response on stdout.
    if (!hasId) {
      return null;
    }

    if (!isValidRpcId(rawId)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request: "id" must be a string, number, or null.',
        },
      };
    }

    const requestId: JsonRpcId = rawId;
    const method = msg.method;
    const rawParams = Object.hasOwn(msg, 'params') ? msg.params : undefined;
    const primaryParamKey = canonicalParamsKey(rawParams);
    const primaryComposite = `${method}\0${primaryParamKey}`;

    let matchedBucket: InteractionBucket | undefined = Object.hasOwn(
      exactBuckets,
      primaryComposite,
    )
      ? exactBuckets[primaryComposite]
      : undefined;

    // Secondary check: if incoming params carried a secret that would have been scrubbed
    // into `<REDACTED_TOKEN_1>` during recording, check redacted canonical form as well.
    if (matchedBucket === undefined && rawParams !== undefined) {
      const redacted = redactValue(rawParams as JsonValue);
      if (redacted.redactionCount > 0) {
        const redactedComposite = `${method}\0${canonicalParamsKey(redacted.value)}`;
        if (Object.hasOwn(exactBuckets, redactedComposite)) {
          matchedBucket = exactBuckets[redactedComposite];
        }
      }
    }

    if (matchedBucket !== undefined) {
      if (matchedBucket.cursor < matchedBucket.entries.length) {
        const entry = matchedBucket.entries[matchedBucket.cursor]!;
        matchedBucket.cursor += 1;
        return buildJsonRpcResponse(requestId, entry);
      }

      if (strict) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: STRICT_MISMATCH_ERROR_CODE,
            message: `Strict replay mismatch: interaction sequence exhausted for method "${method}" (recorded ${matchedBucket.entries.length} call(s)).`,
            data: {
              method,
              recordedCallCount: matchedBucket.entries.length,
            },
          },
        };
      }

      const fallbackEntry = matchedBucket.entries[matchedBucket.entries.length - 1]!;
      return buildJsonRpcResponse(requestId, fallbackEntry);
    }

    // No exact (method, params) match found:
    if (strict) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: STRICT_MISMATCH_ERROR_CODE,
          message: `Strict replay mismatch: unrecorded MCP request for method "${method}".`,
          data: {
            method,
            recordedMethods,
            ...(method === 'tools/call' ? { recordedTools } : {}),
          },
        },
      };
    }

    // Non-strict mode: helpful fallback for handshake/discovery methods, or structured closest error.
    if (DISCOVERY_METHODS.has(method)) {
      if (Object.hasOwn(byMethod, method) && byMethod[method]!.length > 0) {
        return buildJsonRpcResponse(requestId, byMethod[method]![0]!);
      }
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: requestId,
          result: {
            protocolVersion: cassette.protocolVersion ?? '2024-11-05',
            capabilities: {},
            serverInfo: cassette.serverInfo ?? {
              name: 'mcp-cassette-replay',
              version: '0.1.0',
            },
          },
        };
      }
    }

    if (method === 'tools/call') {
      const requestedTool =
        isPlainObject(rawParams) && typeof rawParams.name === 'string'
          ? rawParams.name
          : null;
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: STRICT_MISMATCH_ERROR_CODE,
          message:
            requestedTool !== null
              ? `No recorded interaction matched tools/call for tool "${requestedTool}" with the provided arguments.`
              : 'No recorded interaction matched tools/call with the provided params.',
          data: {
            method,
            requestedTool,
            recordedTools,
          },
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32601,
        message: `Method "${method}" with provided params was not found in cassette.`,
        data: {
          method,
          recordedMethods,
        },
      },
    };
  };

  return {
    handleMessage(rawMessage: unknown): JsonRpcResponse | JsonRpcResponse[] | null {
      if (Array.isArray(rawMessage)) {
        if (rawMessage.length === 0) {
          return {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message: 'Invalid Request: empty JSON-RPC batch.',
            },
          };
        }
        const batchResponses: JsonRpcResponse[] = [];
        for (const elem of rawMessage) {
          const res = matchSingleObject(elem);
          if (res !== null) {
            batchResponses.push(res);
          }
        }
        return batchResponses.length > 0 ? batchResponses : null;
      }

      return matchSingleObject(rawMessage);
    },
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs an offline zero-network stdio MCP mock server backed by a recorded cassette.
 */
export async function replayCassette(options: ReplayOptions): Promise<void> {
  const cassette =
    typeof options.cassette === 'string'
      ? loadCassette(options.cassette).cassette
      : options.cassette;

  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error('--latency-ms must be a non-negative number.');
  }

  const inputStream = options.inputStream ?? process.stdin;
  const outputStream = options.outputStream ?? process.stdout;
  const matcher = createCassetteMatcher(cassette, { strict: options.strict });

  let queue: Promise<void> = Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const detach = attachLineReader(inputStream, {
      onLine: (line) => {
        queue = queue.then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            const parseErr: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32700,
                message: 'Parse error: invalid JSON received by replay server.',
              },
            };
            outputStream.write(`${JSON.stringify(parseErr)}\n`);
            return;
          }

          const response = matcher.handleMessage(parsed);
          if (response === null) {
            return;
          }

          if (latencyMs > 0) {
            await waitMs(latencyMs);
          }

          outputStream.write(`${JSON.stringify(response)}\n`);
        });
      },
      onEnd: () => {
        queue.then(
          () => {
            detach();
            resolve();
          },
          (err) => {
            detach();
            reject(err);
          },
        );
      },
      onError: (err) => {
        detach();
        reject(err);
      },
    });
  });
}
