import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_CASSETTE_BYTES,
  canonicalParamsKey,
  canonicalStringify,
  loadCassette,
  parseCassette,
  saveCassette,
  serializeCassette,
} from '../src/cassette.js';
import { createCassetteMatcher } from '../src/replay.js';
import type { CassetteV1 } from '../src/types.js';

describe('canonical cassette serializer & loader', () => {
  it('produces identical canonical JSON regardless of nested key insertion order', () => {
    const first = {
      z: 10,
      a: {
        delta: [true, { y: 2, x: 1 }],
        alpha: 'ok',
      },
    };
    const second = {
      a: {
        alpha: 'ok',
        delta: [true, { x: 1, y: 2 }],
      },
      z: 10,
    };

    assert.equal(canonicalStringify(first), canonicalStringify(second));
    assert.equal(canonicalParamsKey(first), canonicalParamsKey(second));
    assert.equal(canonicalParamsKey(undefined), '');
    assert.notEqual(canonicalParamsKey(undefined), canonicalParamsKey({}));
  });

  it('safely handles prototype-related property names without prototype pollution', () => {
    const trickyJson =
      '{"__proto__":{"polluted":true},"constructor":"ctor","toString":"str","valueOf":42}';
    const parsed = JSON.parse(trickyJson) as unknown;
    const serialized = canonicalStringify(parsed);
    assert.ok(serialized.includes('"__proto__"'));
    assert.ok(serialized.includes('"constructor"'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);

    // Also verify replay matcher handles method names like "__proto__", "constructor", "toString" safely
    const matcher = createCassetteMatcher(
      {
        version: 1,
        recordedAt: '2026-11-21T00:00:00Z',
        serverCommand: ['node'],
        protocolVersion: '2024-11-05',
        serverInfo: null,
        redactionCount: 0,
        interactions: [],
      },
      { strict: true },
    );
    for (const protoMethod of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      const res = matcher.handleMessage({ jsonrpc: '2.0', id: 1, method: protoMethod });
      assert.ok(res && !Array.isArray(res));
      assert.equal(res.error?.code, -32001);
    }
  });

  it('round-trips Cassette Format v1 deterministically with sorted keys', () => {
    const sample: CassetteV1 = {
      version: 1,
      recordedAt: '2026-11-21T09:00:00.000Z',
      serverCommand: ['node', 'server.js'],
      protocolVersion: '2024-11-05',
      serverInfo: { version: '1.0.0', name: 'demo-server' },
      redactionCount: 2,
      interactions: [
        {
          index: 0,
          kind: 'request',
          method: 'tools/call',
          requestId: 1,
          params: { arguments: { b: 2, a: 1 }, name: 'demo' },
          response: { result: { ok: true, token: '<REDACTED_TOKEN_1>' } },
          latencyMs: 4.5,
        },
      ],
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-canon-'));
    try {
      const outFile = path.join(tmpDir, 'sample.mcp-cassette.json');
      const written = saveCassette(outFile, sample);
      const { cassette: reloaded } = loadCassette(outFile);
      assert.equal(serializeCassette(reloaded), written);

      // Verify keys in params.arguments were written in sorted order ("a" before "b")
      const aPos = written.indexOf('"a": 1');
      const bPos = written.indexOf('"b": 2');
      assert.ok(aPos > 0 && bPos > aPos);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces the 20 MB ceiling on parseCassette and loadCassette', () => {
    const oversizedPayload = 'x'.repeat(MAX_CASSETTE_BYTES + 128);
    assert.throws(() => parseCassette(oversizedPayload), /exceeds 20 MB maximum limit/);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-cap-'));
    try {
      const hugePath = path.join(tmpDir, 'huge.mcp-cassette.json');
      const fd = fs.openSync(hugePath, 'w');
      try {
        // Create sparse/truncated file slightly above 20 MB quickly
        fs.ftruncateSync(fd, MAX_CASSETTE_BYTES + 1024);
      } finally {
        fs.closeSync(fd);
      }
      assert.throws(() => loadCassette(hugePath), /exceeds 20 MB maximum limit/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported cassette schema versions', () => {
    assert.throws(
      () =>
        parseCassette(
          JSON.stringify({
            version: 2,
            recordedAt: '2026-11-21T00:00:00Z',
            serverCommand: ['node'],
            protocolVersion: null,
            serverInfo: null,
            redactionCount: 0,
            interactions: [],
          }),
        ),
      /Unsupported cassette version/,
    );
  });
});
