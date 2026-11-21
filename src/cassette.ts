import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CassetteInteraction, CassetteServerInfo, CassetteV1, JsonValue } from './types.js';

export const MAX_CASSETTE_BYTES = 20 * 1024 * 1024; // 20 MB ceiling

/**
 * Recursively produces a canonical null-prototype structure with lexicographically sorted keys.
 */
export function canonicalizeValue(value: unknown, depth = 0): JsonValue {
  if (depth > 64) {
    throw new Error('Maximum JSON nesting depth (64) exceeded while canonicalizing value.');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalizeValue(item, depth + 1)));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, JsonValue> = {};
    for (const key of sortedKeys) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      const prop = record[key];
      if (prop !== undefined) {
        Object.defineProperty(out, key, {
          value: canonicalizeValue(prop, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return null;
}

/**
 * Deterministic sorted-key JSON stringification.
 */
export function canonicalStringify(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalizeValue(value), null, indent);
}

/**
 * Produces a canonical key string for matching JSON-RPC `params`.
 * Distinguishes omitted `params` (`undefined`) from explicit values, while treating
 * nested object keys independent of property insertion order.
 */
export function canonicalParamsKey(params: unknown): string {
  if (params === undefined) {
    return '';
  }
  return canonicalStringify(params);
}

/**
 * Serializes a CassetteV1 into deterministic sorted-key JSON with trailing newline.
 */
export function serializeCassette(cassette: CassetteV1): string {
  const serialized = `${canonicalStringify(cassette, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_CASSETTE_BYTES) {
    throw new Error(
      `Serialized cassette size (${bytes} bytes) exceeds maximum allowed limit (${MAX_CASSETTE_BYTES} bytes).`,
    );
  }
  return serialized;
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Parses and validates a Cassette Format v1 JSON string with strict 20 MB cap.
 */
export function parseCassette(rawJson: string): CassetteV1 {
  const byteLength = Buffer.byteLength(rawJson, 'utf8');
  if (byteLength > MAX_CASSETTE_BYTES) {
    throw new Error(
      `Cassette payload (${byteLength} bytes) exceeds 20 MB maximum limit (${MAX_CASSETTE_BYTES} bytes).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `Invalid cassette JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainRecord(parsed)) {
    throw new Error('Invalid cassette: root value must be a JSON object.');
  }

  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported cassette version: expected 1, received ${String(parsed.version)}.`,
    );
  }

  if (typeof parsed.recordedAt !== 'string' || parsed.recordedAt.length === 0) {
    throw new Error('Invalid cassette: recordedAt must be a non-empty ISO timestamp string.');
  }

  if (
    !Array.isArray(parsed.serverCommand) ||
    !parsed.serverCommand.every((item) => typeof item === 'string')
  ) {
    throw new Error('Invalid cassette: serverCommand must be an array of strings.');
  }

  if (parsed.protocolVersion !== null && typeof parsed.protocolVersion !== 'string') {
    throw new Error('Invalid cassette: protocolVersion must be a string or null.');
  }

  let serverInfo: CassetteServerInfo | null = null;
  if (parsed.serverInfo !== null) {
    if (
      !isPlainRecord(parsed.serverInfo) ||
      typeof parsed.serverInfo.name !== 'string' ||
      typeof parsed.serverInfo.version !== 'string'
    ) {
      throw new Error(
        'Invalid cassette: serverInfo must be null or an object with string name and version.',
      );
    }
    serverInfo = canonicalizeValue(parsed.serverInfo) as CassetteServerInfo;
  }

  if (
    typeof parsed.redactionCount !== 'number' ||
    !Number.isInteger(parsed.redactionCount) ||
    parsed.redactionCount < 0
  ) {
    throw new Error('Invalid cassette: redactionCount must be a non-negative integer.');
  }

  if (!Array.isArray(parsed.interactions)) {
    throw new Error('Invalid cassette: interactions must be an array.');
  }

  const interactions: CassetteInteraction[] = parsed.interactions.map((rawItem, idx) => {
    if (!isPlainRecord(rawItem)) {
      throw new Error(`Invalid cassette interaction at index ${idx}: expected object.`);
    }
    const kind = rawItem.kind;
    if (
      kind !== 'request' &&
      kind !== 'client_notification' &&
      kind !== 'server_notification'
    ) {
      throw new Error(
        `Invalid cassette interaction at index ${idx}: unsupported kind "${String(kind)}".`,
      );
    }
    if (typeof rawItem.method !== 'string' || rawItem.method.length === 0) {
      throw new Error(`Invalid cassette interaction at index ${idx}: method must be a string.`);
    }
    const latencyMs =
      typeof rawItem.latencyMs === 'number' && Number.isFinite(rawItem.latencyMs) && rawItem.latencyMs >= 0
        ? rawItem.latencyMs
        : 0;

    const interaction: CassetteInteraction = {
      index: typeof rawItem.index === 'number' ? rawItem.index : idx,
      kind,
      method: rawItem.method,
      latencyMs,
    };

    if (Object.hasOwn(rawItem, 'requestId') && rawItem.requestId !== undefined) {
      const reqId = rawItem.requestId;
      if (reqId !== null && typeof reqId !== 'string' && typeof reqId !== 'number') {
        throw new Error(
          `Invalid cassette interaction at index ${idx}: requestId must be string, number, or null.`,
        );
      }
      interaction.requestId = reqId;
    }

    if (Object.hasOwn(rawItem, 'params') && rawItem.params !== undefined) {
      interaction.params = canonicalizeValue(rawItem.params);
    }

    if (Object.hasOwn(rawItem, 'response') && rawItem.response !== undefined) {
      if (!isPlainRecord(rawItem.response)) {
        throw new Error(`Invalid cassette interaction at index ${idx}: response must be an object.`);
      }
      interaction.response = canonicalizeValue(
        rawItem.response,
      ) as CassetteInteraction['response'];
    }

    return interaction;
  });

  return {
    version: 1,
    recordedAt: parsed.recordedAt,
    serverCommand: [...parsed.serverCommand],
    protocolVersion: parsed.protocolVersion,
    serverInfo,
    redactionCount: parsed.redactionCount,
    interactions,
  };
}

/**
 * Loads a CassetteV1 from disk after enforcing the 20 MB file size cap.
 */
export function loadCassette(filePath: string): { cassette: CassetteV1; byteSize: number } {
  const resolved = path.resolve(filePath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    throw new Error(
      `Unable to read cassette file "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(`Cassette path "${resolved}" is not a regular file.`);
  }

  if (stats.size > MAX_CASSETTE_BYTES) {
    throw new Error(
      `Cassette file "${resolved}" (${stats.size} bytes) exceeds 20 MB maximum limit (${MAX_CASSETTE_BYTES} bytes).`,
    );
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const cassette = parseCassette(raw);
  return { cassette, byteSize: stats.size };
}

/**
 * Saves a CassetteV1 to disk in deterministic sorted-key JSON format.
 */
export function saveCassette(filePath: string, cassette: CassetteV1): string {
  const resolved = path.resolve(filePath);
  const serialized = serializeCassette(cassette);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, serialized, 'utf8');
  return serialized;
}
