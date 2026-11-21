import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatInspection, inspectCassette } from '../src/inspect.js';
import type { CassetteV1 } from '../src/types.js';

describe('inspectCassette & formatInspection', () => {
  const sampleCassette: CassetteV1 = {
    version: 1,
    recordedAt: '2026-11-21T09:15:00.000Z',
    serverCommand: ['node', 'server.js'],
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'analytics-mcp', version: '2.0.0' },
    redactionCount: 3,
    interactions: [
      {
        index: 0,
        kind: 'request',
        method: 'initialize',
        requestId: 1,
        params: { protocolVersion: '2024-11-05' },
        response: {
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'analytics-mcp', version: '2.0.0' },
          },
        },
        latencyMs: 10,
      },
      {
        index: 1,
        kind: 'client_notification',
        method: 'notifications/initialized',
        latencyMs: 0,
      },
      {
        index: 2,
        kind: 'request',
        method: 'tools/call',
        requestId: 2,
        params: { name: 'query_metrics', arguments: { key: '<REDACTED_TOKEN_1>' } },
        response: {
          result: {
            tokenA: '<REDACTED_TOKEN_1>',
            tokenB: '<REDACTED_TOKEN_2>',
          },
        },
        latencyMs: 40,
      },
      {
        index: 3,
        kind: 'request',
        method: 'tools/call',
        requestId: 3,
        params: { name: 'export_summary', arguments: {} },
        response: { result: { status: 'done' } },
        latencyMs: 90,
      },
    ],
  };

  it('computes accurate counts, unique methods/tools, bytes, ceil(chars/4) tokens, p50/p95 latency, and redactions', () => {
    const report = inspectCassette(sampleCassette);

    assert.equal(report.interactionCount, 4);
    assert.equal(report.requestCount, 3);
    assert.equal(report.clientNotificationCount, 1);
    assert.equal(report.serverNotificationCount, 0);
    assert.deepEqual(report.uniqueMethods, [
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    assert.deepEqual(report.uniqueToolNames, ['export_summary', 'query_metrics']);
    assert.ok(report.payloadBytes.totalBytes > 0);
    assert.equal(
      report.payloadBytes.totalBytes,
      report.payloadBytes.requestBytes + report.payloadBytes.responseBytes,
    );
    assert.ok(report.estimatedTokens > 0);
    assert.equal(report.latencyMs.p50, 40);
    assert.equal(report.latencyMs.p95, 90);
    assert.equal(report.redactionCount, 3);
    assert.equal(report.uniquePlaceholders, 2);
  });

  it('formats output cleanly in pretty, json, and markdown modes', () => {
    const report = inspectCassette(sampleCassette);

    const pretty = formatInspection(report, 'pretty');
    assert.ok(pretty.includes('MCP Cassette Summary'));
    assert.ok(pretty.includes('export_summary, query_metrics'));

    const jsonStr = formatInspection(report, 'json');
    const reparsed = JSON.parse(jsonStr) as Record<string, unknown>;
    assert.equal(reparsed.interactionCount, 4);
    assert.equal(reparsed.redactionCount, 3);

    const md = formatInspection(report, 'markdown');
    assert.ok(md.includes('## MCP Cassette Inspection Report'));
    assert.ok(md.includes('| Unique Tools Called (2) | `export_summary, query_metrics` |'));
  });
});
