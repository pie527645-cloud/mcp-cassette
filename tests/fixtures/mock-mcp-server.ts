import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { attachLineReader } from '../../src/line-reader.js';

// Parse fixture options
const args = process.argv.slice(2);
let grandchildPidFile: string | undefined;
let hangOnMethod: string | undefined;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--spawn-grandchild' && args[i + 1]) {
    grandchildPidFile = args[i + 1];
    i += 1;
  } else if (arg === '--hang-on' && args[i + 1]) {
    hangOnMethod = args[i + 1];
    i += 1;
  }
}

if (grandchildPidFile) {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    {
      shell: false,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );
  grandchild.unref();
  fs.writeFileSync(
    grandchildPidFile,
    JSON.stringify({
      childPid: process.pid,
      grandchildPid: grandchild.pid ?? null,
    }),
    'utf8',
  );
}

let sequenceCounter = 0;

function buildSyntheticSecrets(): Record<string, string> {
  const openAiKey = ['sk', 'proj', 'SyntheticDemoKey9876543210ABCDEF'].join('-');
  const githubPat = `${'gh'}${'p'}_${'X'.repeat(30)}`;
  const awsKey = `${'AK'}${'IA'}${'IOSFODNN7EXAMPLE'}`;
  const apifyKey = `${'apify'}_${'api'}_${'Z'.repeat(24)}`;
  const bearerTok = `Bearer ${['tok', 'live', '9988776655443322'].join('_')}`;
  const envSecret = process.env.TEST_DYNAMIC_SERVICE_SECRET ?? 'no-env-secret';
  return {
    openAiKey,
    githubPat,
    awsKey,
    apifyKey,
    bearerTok,
    envSecret,
  };
}

function sendJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

attachLineReader(process.stdin, {
  onLine: (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      sendJson({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    if (!isRecord(msg) || typeof msg.method !== 'string') {
      return;
    }

    const method = msg.method;
    if (hangOnMethod && method === hangOnMethod) {
      // Intentionally never respond so --timeout reaping can be verified.
      return;
    }

    // Client notification (e.g. notifications/initialized)
    if (!Object.hasOwn(msg, 'id')) {
      if (
        method === 'notifications/initialized' &&
        isRecord(msg.params) &&
        msg.params.emitServerNotice === true
      ) {
        sendJson({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data: 'Server ready' },
        });
      }
      return;
    }

    const id = msg.id;

    if (method === 'initialize') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: 'fixture-mcp-server',
            version: '1.2.0',
          },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'fetch_secret_report',
              description: 'Returns synthetic diagnostic tokens for redaction tests',
              inputSchema: { type: 'object', properties: { region: { type: 'string' } } },
            },
            {
              name: 'next_sequence',
              description: 'Returns incrementing sequence number across identical calls',
              inputSchema: { type: 'object', properties: { stream: { type: 'string' } } },
            },
            {
              name: 'fail_tool',
              description: 'Returns a deterministic JSON-RPC error',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
      return;
    }

    if (method === 'resources/list') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'file:///workspace/architecture.md',
              name: 'architecture.md',
              mimeType: 'text/markdown',
            },
          ],
        },
      });
      return;
    }

    if (method === 'prompts/list') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          prompts: [
            {
              name: 'summarize_build',
              description: 'Summarizes CI build status',
            },
          ],
        },
      });
      return;
    }

    if (method === 'tools/call' && isRecord(msg.params)) {
      const toolName = msg.params.name;
      const toolArgs = isRecord(msg.params.arguments) ? msg.params.arguments : {};

      if (toolName === 'fetch_secret_report') {
        const secrets = buildSyntheticSecrets();
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Region=${String(toolArgs.region ?? 'us-east-1')} openai=${secrets.openAiKey} github=${secrets.githubPat} aws=${secrets.awsKey} apify=${secrets.apifyKey} auth=${secrets.bearerTok} env=${secrets.envSecret}`,
              },
            ],
            headers: {
              Authorization: secrets.bearerTok,
            },
          },
        });
        return;
      }

      if (toolName === 'next_sequence') {
        sequenceCounter += 1;
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `seq=${sequenceCounter} stream=${String(toolArgs.stream ?? 'default')}`,
              },
            ],
            sequence: sequenceCounter,
          },
        });
        return;
      }

      if (toolName === 'fail_tool') {
        sendJson({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32010,
            message: 'Simulated downstream tool error',
          },
        });
        return;
      }
    }

    sendJson({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  },
});

// Keep event loop alive while stdin is open (and longer if spawned with --spawn-grandchild)
const keepAlive = setInterval(() => {}, 5000);
process.stdin.on('end', () => {
  if (!grandchildPidFile && !hangOnMethod) {
    clearInterval(keepAlive);
  }
});
