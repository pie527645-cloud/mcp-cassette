import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCassette } from '../src/cassette.js';
import { recordSession } from '../src/record.js';
import { STRICT_MISMATCH_ERROR_CODE, replayCassette } from '../src/replay.js';
import type { CassetteV1, JsonRpcResponse } from '../src/types.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_SCRIPT = path.resolve(CURRENT_DIR, 'fixtures', 'mock-mcp-server.js');

function collectLines(stream: PassThrough): () => string[] {
  let raw = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    raw += chunk;
  });
  return () =>
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
}

describe('live stdio proxy record -> automatic redaction -> offline deterministic replay', () => {
  it('records MCP traffic, scrubs secrets before disk write, and replays deterministically offline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-e2e-'));
    try {
      const cassettePath = path.join(tmpDir, 'session.mcp-cassette.json');
      const envSecret = ['env', 'sensitive', 'secret', 'val', '4242'].join('-');

      const recordInput = new PassThrough();
      const recordOutput = new PassThrough();
      const getRecordedWireLines = collectLines(recordOutput);

      const sessionPromise = recordSession({
        stdioCommand: `"${process.execPath}" "${MOCK_SERVER_SCRIPT}"`,
        outPath: cassettePath,
        redactEnv: true,
        env: {
          ...process.env,
          TEST_DYNAMIC_SERVICE_SECRET: envSecret,
        },
        inputStream: recordInput,
        outputStream: recordOutput,
        recordedAt: '2026-11-21T09:05:00.000Z',
      });

      const requests = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.1.0' },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: { emitServerNotice: true },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/list',
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'prompts/list',
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'fetch_secret_report',
            arguments: { region: 'eu-central-1', nested: { z: 9, a: 1 } },
          },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'next_sequence',
            arguments: { stream: 'alpha', filter: { b: 2, a: 1 } },
          },
        },
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'next_sequence',
            arguments: { stream: 'alpha', filter: { a: 1, b: 2 } },
          },
        },
        {
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: {
            name: 'fail_tool',
            arguments: {},
          },
        },
      ];

      for (const req of requests) {
        recordInput.write(`${JSON.stringify(req)}\n`);
      }
      recordInput.end();

      const recordRes = await sessionPromise;
      assert.equal(recordRes.timedOut, false);
      assert.ok(fs.existsSync(cassettePath));

      // Live wire traffic forwarded to client during recording had real unredacted responses
      const liveLines = getRecordedWireLines();
      assert.equal(liveLines.length, 9); // 8 responses + 1 server notification

      // Saved cassette file on disk MUST have zero raw secrets!
      const savedDiskJson = fs.readFileSync(cassettePath, 'utf8');
      assert.equal(savedDiskJson.includes('SyntheticDemoKey9876543210ABCDEF'), false);
      assert.equal(savedDiskJson.includes('IOSFODNN7EXAMPLE'), false);
      assert.equal(savedDiskJson.includes(envSecret), false);
      assert.equal(savedDiskJson.includes('9988776655443322'), false);
      assert.ok(savedDiskJson.includes('<REDACTED_TOKEN_1>'));

      const { cassette } = loadCassette(cassettePath);
      assert.equal(cassette.version, 1);
      assert.equal(cassette.protocolVersion, '2024-11-05');
      assert.deepEqual(cassette.serverInfo, {
        name: 'fixture-mcp-server',
        version: '1.2.0',
      });
      assert.ok(cassette.redactionCount >= 6);
      assert.equal(cassette.interactions.length, 10); // 8 requests + 1 client notif + 1 server notif

      // Offline deterministic replay in --strict mode (no child process spawned!)
      const replayInput = new PassThrough();
      const replayOutput = new PassThrough();
      const getReplayLines = collectLines(replayOutput);

      const replayPromise = replayCassette({
        cassette: cassettePath,
        strict: true,
        inputStream: replayInput,
        outputStream: replayOutput,
      });

      const replayRequests = [
        // Different request IDs and reversed nested key order in params — must still match!
        {
          jsonrpc: '2.0',
          id: 'req-init',
          method: 'initialize',
          params: {
            clientInfo: { version: '0.1.0', name: 'test-client' },
            capabilities: {},
            protocolVersion: '2024-11-05',
          },
        },
        // Notification must emit ZERO responses on stdout!
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        {
          jsonrpc: '2.0',
          id: 'req-tools',
          method: 'tools/list',
        },
        {
          jsonrpc: '2.0',
          id: 'req-secret',
          method: 'tools/call',
          params: {
            arguments: { nested: { a: 1, z: 9 }, region: 'eu-central-1' },
            name: 'fetch_secret_report',
          },
        },
        // Repeated stateful call #1 -> must return sequence=1
        {
          jsonrpc: '2.0',
          id: 'seq-1',
          method: 'tools/call',
          params: {
            arguments: { filter: { b: 2, a: 1 }, stream: 'alpha' },
            name: 'next_sequence',
          },
        },
        // Repeated stateful call #2 -> must return sequence=2
        {
          jsonrpc: '2.0',
          id: 'seq-2',
          method: 'tools/call',
          params: {
            name: 'next_sequence',
            arguments: { stream: 'alpha', filter: { a: 1, b: 2 } },
          },
        },
        // Repeated stateful call #3 (exceeds recorded 2 calls) -> in --strict must return -32001!
        {
          jsonrpc: '2.0',
          id: 'seq-3-exhausted',
          method: 'tools/call',
          params: {
            name: 'next_sequence',
            arguments: { stream: 'alpha', filter: { a: 1, b: 2 } },
          },
        },
        // Recorded error response -> must replay recorded -32010 error
        {
          jsonrpc: '2.0',
          id: 'req-fail',
          method: 'tools/call',
          params: {
            name: 'fail_tool',
            arguments: {},
          },
        },
        // Unrecorded tool arguments -> in --strict must immediately return -32001!
        {
          jsonrpc: '2.0',
          id: 'unrecorded-call',
          method: 'tools/call',
          params: {
            name: 'fetch_secret_report',
            arguments: { region: 'ap-northeast-1' },
          },
        },
      ];

      for (const req of replayRequests) {
        replayInput.write(`${JSON.stringify(req)}\n`);
      }
      replayInput.end();

      await replayPromise;

      const replayLines = getReplayLines();
      // 9 messages sent, 1 was notifications/initialized -> exactly 8 responses!
      assert.equal(replayLines.length, 8);

      const responses = replayLines.map((l) => JSON.parse(l) as JsonRpcResponse);
      assert.equal(responses[0]?.id, 'req-init');
      assert.equal(
        (responses[0]?.result as Record<string, unknown>)?.protocolVersion,
        '2024-11-05',
      );

      assert.equal(responses[1]?.id, 'req-tools');
      assert.equal(
        ((responses[1]?.result as Record<string, unknown>)?.tools as unknown[])?.length,
        3,
      );

      assert.equal(responses[2]?.id, 'req-secret');
      assert.ok(JSON.stringify(responses[2]?.result).includes('<REDACTED_TOKEN_'));

      assert.equal(responses[3]?.id, 'seq-1');
      assert.equal((responses[3]?.result as Record<string, unknown>)?.sequence, 1);

      assert.equal(responses[4]?.id, 'seq-2');
      assert.equal((responses[4]?.result as Record<string, unknown>)?.sequence, 2);

      // 3rd call exhausted bucket in --strict -> -32001
      assert.equal(responses[5]?.id, 'seq-3-exhausted');
      assert.equal(responses[5]?.error?.code, STRICT_MISMATCH_ERROR_CODE);

      // Recorded -32010 error replayed accurately
      assert.equal(responses[6]?.id, 'req-fail');
      assert.equal(responses[6]?.error?.code, -32010);

      // Unrecorded params in --strict -> -32001
      assert.equal(responses[7]?.id, 'unrecorded-call');
      assert.equal(responses[7]?.error?.code, STRICT_MISMATCH_ERROR_CODE);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports non-strict fallback replay and --latency-ms pacing', async () => {
    const cassette: CassetteV1 = {
      version: 1,
      recordedAt: '2026-11-21T09:10:00.000Z',
      serverCommand: ['node', 'mock.js'],
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'demo', version: '0.1.0' },
      redactionCount: 0,
      interactions: [
        {
          index: 0,
          kind: 'request' as const,
          method: 'initialize',
          requestId: 1,
          params: { protocolVersion: '2024-11-05', clientInfo: { name: 'old', version: '1' } },
          response: {
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'demo', version: '0.1.0' },
            },
          },
          latencyMs: 2,
        },
        {
          index: 1,
          kind: 'request' as const,
          method: 'tools/call',
          requestId: 2,
          params: { name: 'ping_tool', arguments: {} },
          response: { result: { pong: true } },
          latencyMs: 3,
        },
      ],
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const getLines = collectLines(output);

    const start = Date.now();
    const run = replayCassette({
      cassette,
      strict: false,
      latencyMs: 25,
      inputStream: input,
      outputStream: output,
    });

    // Different clientInfo in non-strict mode falls back cleanly to recorded initialize
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', clientInfo: { name: 'ci-runner', version: '9' } },
      })}\n`,
    );
    // Repeat ping_tool twice (only recorded once) -> non-strict replays fallback
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'ping_tool', arguments: {} },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'ping_tool', arguments: {} },
      })}\n`,
    );
    input.end();

    await run;
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 50, `Expected artificial latency >= 50ms, got ${elapsed}ms`);

    const parsed = getLines().map((l) => JSON.parse(l) as JsonRpcResponse);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[1]?.result, { pong: true });
    assert.deepEqual(parsed[2]?.result, { pong: true });
  });
});
