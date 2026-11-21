import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedactor, redactCassette, redactValue } from '../src/redact.js';
import type { CassetteV1 } from '../src/types.js';

describe('secret redactor (built-in patterns + --redact-env)', () => {
  it('scrubs OpenAI/Anthropic, GitHub, AWS, Apify, JWT, Bearer, and Authorization headers deterministically', () => {
    const openAi = ['sk', 'proj', 'AlphaBetaGammaDelta1234567890'].join('-');
    const anthropic = ['sk', 'ant', 'api03', 'Omega9876543210abcdefXYZ'].join('-');
    const ghClassic = `${'gh'}${'p'}_${'Q'.repeat(28)}`;
    const ghFine = `${'github'}_${'pat'}_${'R'.repeat(28)}`;
    const awsKey = `${'AK'}${'IA'}${'J5EXAMPLEKEY1234'}`;
    const apify = `${'apify'}_${'api'}_${'M'.repeat(22)}`;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: '1234567890', role: 'ci' })).toString('base64url'),
      'SigPartSyntheticTokenVerification9876543210',
    ].join('.');
    const opaqueBearer = ['custom', 'opaque', 'token', '77889900'].join('_');
    const basicCred = 'dXNlcjpzdXBlcnNlY3JldA==';

    const payload = {
      openaiField: openAi,
      repeatedOpenaiInBearer: `Authorization: Bearer ${openAi}`,
      anthropicField: anthropic,
      ghClassic,
      ghFine,
      awsKey,
      apify,
      jwt,
      inlineBearer: `Use Bearer ${opaqueBearer} for upstream requests`,
      headers: {
        Authorization: `Basic ${basicCred}`,
        'Proxy-Authorization': 'raw-proxy-secret-credential',
      },
    };

    const { value: scrubbed, redactionCount, uniqueSecretsCount } = redactValue(payload);
    const serialized = JSON.stringify(scrubbed);

    // Ensure zero raw secrets survive anywhere in output
    for (const secret of [
      openAi,
      anthropic,
      ghClassic,
      ghFine,
      awsKey,
      apify,
      jwt,
      opaqueBearer,
      basicCred,
      'raw-proxy-secret-credential',
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `Expected secret "${secret}" to be scrubbed`,
      );
    }

    // Verify deterministic reuse: openAi appeared both bare and inside `Authorization: Bearer ...`
    assert.equal(scrubbed.openaiField, '<REDACTED_TOKEN_1>');
    assert.equal(scrubbed.repeatedOpenaiInBearer, 'Authorization: Bearer <REDACTED_TOKEN_1>');
    assert.equal(scrubbed.headers.Authorization, `Basic <REDACTED_TOKEN_${uniqueSecretsCount - 1}>`);
    assert.equal(
      scrubbed.headers['Proxy-Authorization'],
      `<REDACTED_TOKEN_${uniqueSecretsCount}>`,
    );
    assert.equal(uniqueSecretsCount, 10);
    assert.equal(redactionCount, 11);

    // Idempotency: re-running redactor on already-scrubbed data must not double-redact placeholders
    const secondPass = redactValue(scrubbed);
    assert.equal(secondPass.redactionCount, 0);
    assert.deepEqual(secondPass.value, scrubbed);
  });

  it('scrubs sensitive env vars >= 8 chars when redactEnv is enabled while ignoring benign or short vars', () => {
    const customSecretVal = ['my', 'custom', 'db', 'passphrase', '999'].join('-');
    const customTokenVal = ['internal', 'service', 'tok', '8888'].join('_');
    const benignVal = 'production-us-west-2-cluster';

    const fakeEnv: NodeJS.ProcessEnv = {
      CUSTOM_DB_PASSWORD: customSecretVal,
      SERVICE_ACCESS_TOKEN: customTokenVal,
      SHORT_API_KEY: 'short7',
      APP_DEPLOYMENT_REGION: benignVal,
    };

    const redactor = createRedactor({ redactEnv: true, env: fakeEnv });
    const out = redactor.redactValue({
      dsn: `postgres://admin:${customSecretVal}@db.internal:5432/app`,
      tokenUsed: customTokenVal,
      shortEcho: 'short7',
      region: benignVal,
    });

    assert.equal(out.dsn, 'postgres://admin:<REDACTED_TOKEN_1>@db.internal:5432/app');
    assert.equal(out.tokenUsed, '<REDACTED_TOKEN_2>');
    assert.equal(out.shortEcho, 'short7');
    assert.equal(out.region, benignVal);
    assert.equal(redactor.getRedactionCount(), 2);
  });

  it('also scrubs secrets accidentally passed in cassette serverCommand arguments', () => {
    const cliKey = ['sk', 'live', 'CommandArgLeak999988887777'].join('-');
    const cassette: CassetteV1 = {
      version: 1,
      recordedAt: '2026-11-21T09:00:00.000Z',
      serverCommand: ['node', 'server.js', `--api-key=${cliKey}`],
      protocolVersion: '2024-11-05',
      serverInfo: null,
      redactionCount: 0,
      interactions: [],
    };

    const redacted = redactCassette(cassette);
    assert.equal(redacted.serverCommand[2], '--api-key=<REDACTED_TOKEN_1>');
    assert.equal(redacted.redactionCount, 1);
  });
});
