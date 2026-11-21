import type {
  CassetteV1,
  JsonValue,
  RedactionResult,
  RedactorOptions,
} from './types.js';

const SENSITIVE_ENV_MARKERS = ['KEY', 'TOKEN', 'SECRET', 'PASS'] as const;

// Strictly linear-time regexes (star-height <= 1, disjoint character classes, bounded quantifiers).
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{4,512}\.eyJ[A-Za-z0-9_-]{4,1024}\.[A-Za-z0-9_-]{6,1024}\b/g;
const OPENAI_ANTHROPIC_PATTERN = /\bsk-[A-Za-z0-9_-]{12,256}\b/g;
const GITHUB_CLASSIC_PATTERN = /\bgh[pousr]_[A-Za-z0-9_]{16,255}\b/g;
const GITHUB_FINE_GRAINED_PATTERN = /\bgithub_pat_[A-Za-z0-9_]{16,255}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bA[KS]IA[0-9A-Z]{16}\b/g;
const APIFY_TOKEN_PATTERN = /\bapify_api_[A-Za-z0-9_]{12,128}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{12,128}\b/g;
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9]{16,128}\b/g;
const HF_TOKEN_PATTERN = /\bhf_[A-Za-z0-9]{16,128}\b/g;

const INLINE_AUTH_SCHEME_PATTERN =
  /\b((?:Proxy-)?Authorization[ \t]{0,16}:[ \t]{0,16}(?:B(?:earer|asic)|Token|ApiKey|Digest)[ \t]{1,16})([A-Za-z0-9._~+/=-]{6,1024})/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer[ \t]{1,16})([A-Za-z0-9._~+/=-]{8,1024})/g;

const PLACEHOLDER_CHECK_PATTERN = /^<REDACTED_TOKEN_\d{1,9}>$/;
const PLACEHOLDER_SCAN_PATTERN = /<REDACTED_TOKEN_\d{1,9}>/g;

const AUTH_HEADER_SCHEMES = ['bearer', 'basic', 'token', 'apikey', 'digest'] as const;

export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  for (const marker of SENSITIVE_ENV_MARKERS) {
    if (upper.includes(marker)) {
      return true;
    }
  }
  return false;
}

export function collectSensitiveEnvValues(env: NodeJS.ProcessEnv): string[] {
  const seen: Record<string, true> = Object.create(null) as Record<string, true>;
  const values: string[] = [];

  for (const key of Object.keys(env)) {
    if (!Object.hasOwn(env, key) || !isSensitiveEnvName(key)) {
      continue;
    }
    const raw = env[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length < 8 || PLACEHOLDER_CHECK_PATTERN.test(trimmed)) {
      continue;
    }
    if (!Object.hasOwn(seen, trimmed)) {
      seen[trimmed] = true;
      values.push(trimmed);
    }
  }

  // Sort longest-first, then lexicographically for deterministic replacement when secrets overlap.
  values.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return values;
}

function replaceAllLiteral(
  input: string,
  needle: string,
  getReplacement: () => string,
): string {
  if (needle.length === 0 || !input.includes(needle)) {
    return input;
  }
  let result = '';
  let cursor = 0;
  while (cursor <= input.length) {
    const idx = input.indexOf(needle, cursor);
    if (idx === -1) {
      result += input.slice(cursor);
      break;
    }
    // Avoid matching inside an already-emitted <REDACTED_TOKEN_N> placeholder.
    result += input.slice(cursor, idx) + getReplacement();
    cursor = idx + needle.length;
  }
  return result;
}

export interface SecretRedactor {
  redactString(input: string): string;
  redactValue<T extends JsonValue>(value: T): T;
  getRedactionCount(): number;
  getUniqueSecretsCount(): number;
}

export function createRedactor(options: RedactorOptions = {}): SecretRedactor {
  const secretToPlaceholder: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let uniqueSecretsCount = 0;
  let redactionCount = 0;

  const literalSecrets: string[] = [];
  const literalSeen: Record<string, true> = Object.create(null) as Record<string, true>;

  if (options.redactEnv) {
    const envSource = options.env ?? process.env;
    for (const secret of collectSensitiveEnvValues(envSource)) {
      if (!Object.hasOwn(literalSeen, secret)) {
        literalSeen[secret] = true;
        literalSecrets.push(secret);
      }
    }
  }

  if (Array.isArray(options.extraSecrets)) {
    for (const raw of options.extraSecrets) {
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (
          trimmed.length >= 8 &&
          !PLACEHOLDER_CHECK_PATTERN.test(trimmed) &&
          !Object.hasOwn(literalSeen, trimmed)
        ) {
          literalSeen[trimmed] = true;
          literalSecrets.push(trimmed);
        }
      }
    }
  }

  literalSecrets.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const assignPlaceholder = (secret: string): string => {
    if (secret.length === 0 || secret.includes('<REDACTED_TOKEN_')) {
      return secret;
    }
    redactionCount += 1;
    if (Object.hasOwn(secretToPlaceholder, secret)) {
      return secretToPlaceholder[secret]!;
    }
    uniqueSecretsCount += 1;
    const placeholder = `<REDACTED_TOKEN_${uniqueSecretsCount}>`;
    secretToPlaceholder[secret] = placeholder;
    return placeholder;
  };

  const redactString = (input: string): string => {
    if (input.length === 0) {
      return input;
    }

    let out = input;

    // Pass 1: Configured environment / explicit literal secrets (>= 8 chars, longest-first).
    for (const secret of literalSecrets) {
      if (out.includes(secret)) {
        out = replaceAllLiteral(out, secret, () => assignPlaceholder(secret));
      }
    }

    // Pass 2: Structured token patterns (strictly linear regexes).
    const tokenPatterns = [
      JWT_PATTERN,
      OPENAI_ANTHROPIC_PATTERN,
      GITHUB_FINE_GRAINED_PATTERN,
      GITHUB_CLASSIC_PATTERN,
      AWS_ACCESS_KEY_PATTERN,
      APIFY_TOKEN_PATTERN,
      SLACK_TOKEN_PATTERN,
      NPM_TOKEN_PATTERN,
      HF_TOKEN_PATTERN,
    ];

    for (const pattern of tokenPatterns) {
      out = out.replace(pattern, (match) => assignPlaceholder(match));
    }

    // Pass 3: Inline HTTP Authorization headers and Bearer tokens.
    out = out.replace(
      INLINE_AUTH_SCHEME_PATTERN,
      (_full, prefix: string, credential: string) => `${prefix}${assignPlaceholder(credential)}`,
    );

    out = out.replace(
      BEARER_TOKEN_PATTERN,
      (_full, prefix: string, credential: string) => `${prefix}${assignPlaceholder(credential)}`,
    );

    return out;
  };

  const redactAuthHeaderValue = (raw: string): string => {
    const afterStandard = redactString(raw);
    if (afterStandard.includes('<REDACTED_TOKEN_')) {
      return afterStandard;
    }
    const trimmed = afterStandard.trim();
    if (trimmed.length === 0) {
      return afterStandard;
    }
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0) {
      const scheme = trimmed.slice(0, spaceIdx);
      const rest = trimmed.slice(spaceIdx + 1).trim();
      if (
        rest.length > 0 &&
        (AUTH_HEADER_SCHEMES as readonly string[]).includes(scheme.toLowerCase())
      ) {
        return `${scheme} ${assignPlaceholder(rest)}`;
      }
    }
    return assignPlaceholder(trimmed);
  };

  const redactNode = (val: JsonValue, depth: number): JsonValue => {
    if (depth > 64) {
      return val;
    }
    if (typeof val === 'string') {
      return redactString(val);
    }
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map((item) => redactNode(item, depth + 1));
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(val)) {
      if (!Object.hasOwn(val, key)) {
        continue;
      }
      const childVal = val[key];
      if (childVal === undefined) {
        continue;
      }
      const lowerKey = key.toLowerCase();
      const nextVal =
        typeof childVal === 'string' &&
        (lowerKey === 'authorization' || lowerKey === 'proxy-authorization')
          ? redactAuthHeaderValue(childVal)
          : redactNode(childVal, depth + 1);
      Object.defineProperty(result, key, {
        value: nextVal,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  };

  return {
    redactString,
    redactValue<T extends JsonValue>(value: T): T {
      return redactNode(value, 0) as T;
    },
    getRedactionCount(): number {
      return redactionCount;
    },
    getUniqueSecretsCount(): number {
      return uniqueSecretsCount;
    },
  };
}

export function redactValue<T extends JsonValue>(
  value: T,
  options: RedactorOptions = {},
): RedactionResult<T> {
  const redactor = createRedactor(options);
  const redacted = redactor.redactValue(value);
  return {
    value: redacted,
    redactionCount: redactor.getRedactionCount(),
    uniqueSecretsCount: redactor.getUniqueSecretsCount(),
  };
}

export function redactCassette(
  cassette: CassetteV1,
  options: RedactorOptions = {},
): CassetteV1 {
  const redactor = createRedactor(options);

  const serverCommand = cassette.serverCommand.map((arg) => redactor.redactString(arg));
  const serverInfo =
    cassette.serverInfo !== null
      ? (redactor.redactValue(cassette.serverInfo) as CassetteV1['serverInfo'])
      : null;

  const interactions = cassette.interactions.map((interaction, idx) => {
    const redactedParams =
      interaction.params !== undefined ? redactor.redactValue(interaction.params) : undefined;
    const redactedResponse =
      interaction.response !== undefined
        ? (redactor.redactValue(
            interaction.response as unknown as JsonValue,
          ) as CassetteV1['interactions'][number]['response'])
        : undefined;

    return {
      index: idx,
      kind: interaction.kind,
      method: interaction.method,
      ...(interaction.requestId !== undefined ? { requestId: interaction.requestId } : {}),
      ...(redactedParams !== undefined ? { params: redactedParams } : {}),
      ...(redactedResponse !== undefined ? { response: redactedResponse } : {}),
      latencyMs: interaction.latencyMs,
    };
  });

  return {
    version: 1,
    recordedAt: cassette.recordedAt,
    serverCommand,
    protocolVersion: cassette.protocolVersion,
    serverInfo,
    redactionCount: cassette.redactionCount + redactor.getRedactionCount(),
    interactions,
  };
}

export function countUniquePlaceholdersInText(serialized: string): number {
  const seen: Record<string, true> = Object.create(null) as Record<string, true>;
  let count = 0;
  for (const match of serialized.matchAll(PLACEHOLDER_SCAN_PATTERN)) {
    const token = match[0];
    if (token && !Object.hasOwn(seen, token)) {
      seen[token] = true;
      count += 1;
    }
  }
  return count;
}
