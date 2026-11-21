import { canonicalStringify, loadCassette, serializeCassette } from './cassette.js';
import { countUniquePlaceholdersInText } from './redact.js';
import type { CassetteInspection, CassetteV1, InspectFormat } from './types.js';

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function computePercentile(sortedAsc: readonly number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = Math.ceil((percentile / 100) * sortedAsc.length) - 1;
  const clamped = Math.max(0, Math.min(sortedAsc.length - 1, rank));
  return Math.round(sortedAsc[clamped]! * 1000) / 1000;
}

/**
 * Computes deterministic analytics for a CassetteV1 (from path or parsed object).
 */
export function inspectCassette(source: string | CassetteV1): CassetteInspection {
  let cassette: CassetteV1;
  let cassettePath: string | undefined;
  let cassetteBytes: number | undefined;

  if (typeof source === 'string') {
    const loaded = loadCassette(source);
    cassette = loaded.cassette;
    cassettePath = source;
    cassetteBytes = loaded.byteSize;
  } else {
    cassette = source;
  }

  const methodsSeen: Record<string, true> = Object.create(null) as Record<string, true>;
  const toolsSeen: Record<string, true> = Object.create(null) as Record<string, true>;

  let requestCount = 0;
  let clientNotificationCount = 0;
  let serverNotificationCount = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let payloadChars = 0;

  const requestLatencies: number[] = [];

  for (const interaction of cassette.interactions) {
    methodsSeen[interaction.method] = true;

    if (interaction.kind === 'request') {
      requestCount += 1;
      requestLatencies.push(interaction.latencyMs);
      const reqEnvelope = {
        jsonrpc: '2.0',
        id: interaction.requestId ?? null,
        method: interaction.method,
        ...(interaction.params !== undefined ? { params: interaction.params } : {}),
      };
      const reqJson = JSON.stringify(reqEnvelope);
      requestBytes += Buffer.byteLength(reqJson, 'utf8');
      payloadChars += reqJson.length;

      if (interaction.response !== undefined) {
        const resEnvelope = {
          jsonrpc: '2.0',
          id: interaction.requestId ?? null,
          ...interaction.response,
        };
        const resJson = JSON.stringify(resEnvelope);
        responseBytes += Buffer.byteLength(resJson, 'utf8');
        payloadChars += resJson.length;
      }
    } else if (interaction.kind === 'client_notification') {
      clientNotificationCount += 1;
      const notifEnvelope = {
        jsonrpc: '2.0',
        method: interaction.method,
        ...(interaction.params !== undefined ? { params: interaction.params } : {}),
      };
      const notifJson = JSON.stringify(notifEnvelope);
      requestBytes += Buffer.byteLength(notifJson, 'utf8');
      payloadChars += notifJson.length;
    } else {
      serverNotificationCount += 1;
      const notifEnvelope = {
        jsonrpc: '2.0',
        method: interaction.method,
        ...(interaction.params !== undefined ? { params: interaction.params } : {}),
      };
      const notifJson = JSON.stringify(notifEnvelope);
      responseBytes += Buffer.byteLength(notifJson, 'utf8');
      payloadChars += notifJson.length;
    }

    if (
      interaction.method === 'tools/call' &&
      isPlainObject(interaction.params) &&
      typeof interaction.params.name === 'string' &&
      interaction.params.name.length > 0
    ) {
      toolsSeen[interaction.params.name] = true;
    }
  }

  requestLatencies.sort((a, b) => a - b);
  const totalLatency =
    Math.round(requestLatencies.reduce((acc, v) => acc + v, 0) * 1000) / 1000;
  const minLatency =
    requestLatencies.length > 0 ? Math.round(requestLatencies[0]! * 1000) / 1000 : 0;
  const maxLatency =
    requestLatencies.length > 0
      ? Math.round(requestLatencies[requestLatencies.length - 1]! * 1000) / 1000
      : 0;

  const serializedCassette = serializeCassette(cassette);
  const uniquePlaceholders = countUniquePlaceholdersInText(serializedCassette);

  return {
    ...(cassettePath !== undefined ? { cassettePath } : {}),
    version: cassette.version,
    recordedAt: cassette.recordedAt,
    serverCommand: [...cassette.serverCommand],
    protocolVersion: cassette.protocolVersion,
    serverInfo: cassette.serverInfo,
    interactionCount: cassette.interactions.length,
    requestCount,
    clientNotificationCount,
    serverNotificationCount,
    uniqueMethods: Object.keys(methodsSeen).sort(),
    uniqueToolNames: Object.keys(toolsSeen).sort(),
    payloadBytes: {
      requestBytes,
      responseBytes,
      totalBytes: requestBytes + responseBytes,
      ...(cassetteBytes !== undefined ? { cassetteBytes } : {}),
    },
    estimatedTokens: Math.ceil(payloadChars / 4),
    latencyMs: {
      p50: computePercentile(requestLatencies, 50),
      p95: computePercentile(requestLatencies, 95),
      min: minLatency,
      max: maxLatency,
      total: totalLatency,
    },
    redactionCount: cassette.redactionCount,
    uniquePlaceholders,
  };
}

/**
 * Formats a CassetteInspection into `pretty`, `json`, or `markdown`.
 */
export function formatInspection(
  inspection: CassetteInspection,
  format: InspectFormat = 'pretty',
): string {
  if (format === 'json') {
    return canonicalStringify(inspection, 2);
  }

  const serverLabel = inspection.serverInfo
    ? `${inspection.serverInfo.name}@${inspection.serverInfo.version}`
    : 'unknown';
  const methodsLabel =
    inspection.uniqueMethods.length > 0 ? inspection.uniqueMethods.join(', ') : '(none)';
  const toolsLabel =
    inspection.uniqueToolNames.length > 0 ? inspection.uniqueToolNames.join(', ') : '(none)';

  if (format === 'markdown') {
    const lines = [
      '## MCP Cassette Inspection Report',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      ...(inspection.cassettePath !== undefined
        ? [`| Cassette File | \`${inspection.cassettePath}\` |`]
        : []),
      `| Format Version | \`v${inspection.version}\` |`,
      `| Recorded At | \`${inspection.recordedAt}\` |`,
      `| Server Info | \`${serverLabel}\` |`,
      `| Protocol Version | \`${inspection.protocolVersion ?? 'unknown'}\` |`,
      `| Interactions | ${inspection.interactionCount} (${inspection.requestCount} requests, ${inspection.clientNotificationCount} client notifications, ${inspection.serverNotificationCount} server notifications) |`,
      `| Unique Methods (${inspection.uniqueMethods.length}) | \`${methodsLabel}\` |`,
      `| Unique Tools Called (${inspection.uniqueToolNames.length}) | \`${toolsLabel}\` |`,
      `| Payload Bytes | ${inspection.payloadBytes.totalBytes} B (req: ${inspection.payloadBytes.requestBytes} B, res: ${inspection.payloadBytes.responseBytes} B) |`,
      `| Estimated Tokens | ~${inspection.estimatedTokens} tokens |`,
      `| Latency (p50 / p95) | ${inspection.latencyMs.p50} ms / ${inspection.latencyMs.p95} ms (min: ${inspection.latencyMs.min} ms, max: ${inspection.latencyMs.max} ms) |`,
      `| Redacted Secrets | ${inspection.redactionCount} (${inspection.uniquePlaceholders} unique placeholder(s)) |`,
    ];
    return lines.join('\n');
  }

  // Default: `pretty`
  const lines = [
    'MCP Cassette Summary',
    '====================',
    ...(inspection.cassettePath !== undefined
      ? [`Cassette Path     : ${inspection.cassettePath}`]
      : []),
    `Format Version    : v${inspection.version}`,
    `Recorded At       : ${inspection.recordedAt}`,
    `Server Info       : ${serverLabel}`,
    `Protocol Version  : ${inspection.protocolVersion ?? 'unknown'}`,
    `Server Command    : ${inspection.serverCommand.join(' ')}`,
    `Interactions      : ${inspection.interactionCount} total (${inspection.requestCount} requests, ${inspection.clientNotificationCount} client notifs, ${inspection.serverNotificationCount} server notifs)`,
    `Unique Methods    : ${methodsLabel}`,
    `Unique Tools      : ${toolsLabel}`,
    `Payload Bytes     : ${inspection.payloadBytes.totalBytes} B (requests: ${inspection.payloadBytes.requestBytes} B, responses: ${inspection.payloadBytes.responseBytes} B)`,
    `Estimated Tokens  : ${inspection.estimatedTokens} (ceil(chars / 4))`,
    `Latency (ms)      : p50=${inspection.latencyMs.p50} ms, p95=${inspection.latencyMs.p95} ms (min=${inspection.latencyMs.min} ms, max=${inspection.latencyMs.max} ms)`,
    `Redacted Secrets  : ${inspection.redactionCount} (${inspection.uniquePlaceholders} unique placeholder(s))`,
  ];
  return lines.join('\n');
}
