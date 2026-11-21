import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCassette } from '../src/cassette.js';
import { attachLineReader } from '../src/line-reader.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Compiled CLI lives at `<repo>/dist/cli.js`; compiled mock fixture lives at `<repo>/dist-test/tests/fixtures/mock-mcp-server.js`
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const DIST_CLI = path.join(DIST_DIR, 'cli.js');
const MOCK_SERVER_SCRIPT = path.resolve(CURRENT_DIR, 'fixtures', 'mock-mcp-server.js');

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNodeCli(
  cliScriptPath: string,
  args: string[],
  stdinText?: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliScriptPath, ...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    }
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('CLI entrypoint, symlink execution, and cross-platform child + grandchild reaping', () => {
  it('supports --help and --version both directly and through a symlinked entrypoint', async () => {
    const directHelp = await runNodeCli(DIST_CLI, ['--help']);
    assert.equal(directHelp.code, 0);
    assert.ok(directHelp.stdout.includes('mcp-cassette record'));
    assert.ok(directHelp.stdout.includes('mcp-cassette replay'));
    assert.ok(directHelp.stdout.includes('mcp-cassette inspect'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-symlink-'));
    try {
      let linkedCliPath: string;
      const candidateFileLink = path.join(tmpDir, 'mcp-cassette-link.js');

      try {
        fs.symlinkSync(DIST_CLI, candidateFileLink, 'file');
        linkedCliPath = candidateFileLink;
      } catch {
        // Unprivileged Windows fallback: create a directory junction to `dist/`
        const linkedDistDir = path.join(tmpDir, 'linked-dist');
        fs.symlinkSync(DIST_DIR, linkedDistDir, 'junction');
        linkedCliPath = path.join(linkedDistDir, 'cli.js');
      }

      assert.notEqual(path.resolve(linkedCliPath), path.resolve(DIST_CLI));
      assert.equal(fs.realpathSync(linkedCliPath), fs.realpathSync(DIST_CLI));

      const symlinkHelp = await runNodeCli(linkedCliPath, ['--help']);
      assert.equal(symlinkHelp.code, 0);
      assert.ok(symlinkHelp.stdout.includes('mcp-cassette v0.1.0'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reaps both child and detached grandchild processes on EOF and on --timeout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-reap-'));
    try {
      // 1. Normal EOF exit reaping test
      const eofPidFile = path.join(tmpDir, 'eof-pids.json');
      const eofCassette = path.join(tmpDir, 'eof.mcp-cassette.json');
      const initReq = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      })}\n`;

      const eofRes = await runNodeCli(
        DIST_CLI,
        [
          'record',
          '--stdio',
          `"${process.execPath}" "${MOCK_SERVER_SCRIPT}" --spawn-grandchild "${eofPidFile}"`,
          '--out',
          eofCassette,
        ],
        initReq,
      );

      assert.equal(eofRes.code, 0);
      assert.ok(fs.existsSync(eofPidFile));
      assert.ok(fs.existsSync(eofCassette));

      const eofPids = JSON.parse(fs.readFileSync(eofPidFile, 'utf8')) as {
        childPid: number;
        grandchildPid: number;
      };
      assert.ok(eofPids.childPid > 0);
      assert.ok(eofPids.grandchildPid > 0);

      // Give OS kernel a brief settle window and verify both child and grandchild are dead
      await sleep(100);
      assert.equal(
        isPidRunning(eofPids.childPid),
        false,
        `Expected child PID ${eofPids.childPid} to be reaped after EOF`,
      );
      assert.equal(
        isPidRunning(eofPids.grandchildPid),
        false,
        `Expected grandchild PID ${eofPids.grandchildPid} to be reaped after EOF`,
      );

      // 2. Hung server --timeout reaping test
      const timeoutPidFile = path.join(tmpDir, 'timeout-pids.json');
      const timeoutCassette = path.join(tmpDir, 'timeout.mcp-cassette.json');

      const hungReq = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
      })}\n`;

      const timeoutRes = await runNodeCli(
        DIST_CLI,
        [
          'record',
          '--stdio',
          `"${process.execPath}" "${MOCK_SERVER_SCRIPT}" --spawn-grandchild "${timeoutPidFile}" --hang-on tools/list`,
          '--out',
          timeoutCassette,
          '--timeout',
          '400',
        ],
        hungReq,
      );

      assert.equal(timeoutRes.code, 1);
      assert.ok(timeoutRes.stderr.includes('timeout'));
      assert.ok(fs.existsSync(timeoutPidFile));
      assert.ok(fs.existsSync(timeoutCassette));

      const timeoutPids = JSON.parse(fs.readFileSync(timeoutPidFile, 'utf8')) as {
        childPid: number;
        grandchildPid: number;
      };

      await sleep(100);
      assert.equal(
        isPidRunning(timeoutPids.childPid),
        false,
        `Expected hung child PID ${timeoutPids.childPid} to be reaped on timeout`,
      );
      assert.equal(
        isPidRunning(timeoutPids.grandchildPid),
        false,
        `Expected hung grandchild PID ${timeoutPids.grandchildPid} to be reaped on timeout`,
      );

      // 3. CLI inspect & replay smoke check against the recorded EOF cassette
      const inspectRes = await runNodeCli(DIST_CLI, [
        'inspect',
        eofCassette,
        '--format',
        'json',
      ]);
      assert.equal(inspectRes.code, 0);
      const inspectData = JSON.parse(inspectRes.stdout) as Record<string, unknown>;
      assert.equal(inspectData.interactionCount, 1);

      const replayRes = await runNodeCli(
        DIST_CLI,
        ['replay', '--cassette', eofCassette, '--strict'],
        initReq,
      );
      assert.equal(replayRes.code, 0);
      const replayObj = JSON.parse(replayRes.stdout.trim()) as Record<string, unknown>;
      assert.equal(replayObj.id, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flushes cassette atomically before forwarding stdout response when host immediately hard-kills record', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cassette-hardkill-'));
    try {
      const cassettePath = path.join(tmpDir, 'hardkill.mcp-cassette.json');

      const recordProc = spawn(
        process.execPath,
        [
          DIST_CLI,
          'record',
          '--stdio',
          `"${process.execPath}" "${MOCK_SERVER_SCRIPT}"`,
          '--out',
          cassettePath,
        ],
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      );

      const sequenceMessages = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-doctor-like-host', version: '1.0.0' },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        },
      ];
      const wirePayload = `${sequenceMessages.map((m) => JSON.stringify(m)).join('\n')}\n`;

      await new Promise<void>((resolve, reject) => {
        let killed = false;
        recordProc.on('error', reject);
        recordProc.on('close', () => resolve());

        attachLineReader(recordProc.stdout, {
          onLine: (line) => {
            if (killed) return;
            let msg: Record<string, unknown> | null = null;
            try {
              msg = JSON.parse(line) as Record<string, unknown>;
            } catch {
              msg = null;
            }
            // Immediately hard-kill `record` the instant `tools/list` (id: 2) response arrives,
            // without closing stdin and without allowing any async finalize timer to run.
            if (msg && msg.id === 2) {
              killed = true;
              const pid = recordProc.pid;
              if (typeof pid === 'number' && pid > 0) {
                if (process.platform === 'win32') {
                  try {
                    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                      stdio: 'ignore',
                      windowsHide: true,
                    });
                  } catch {
                    // ignore if already exited
                  }
                } else {
                  try {
                    process.kill(-pid, 'SIGKILL');
                  } catch {
                    try {
                      recordProc.kill('SIGKILL');
                    } catch {
                      // ignore
                    }
                  }
                }
              }
            }
          },
        });

        // Write messages while keeping stdin open (exact host behavior)
        recordProc.stdin.write(wirePayload);
      });

      // Cassette MUST exist on disk with zero leftover .tmp files
      assert.equal(fs.existsSync(cassettePath), true, 'Expected cassette file to exist after hard-kill');
      const leftoverTmp = fs.readdirSync(tmpDir).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(leftoverTmp, []);

      const { cassette } = loadCassette(cassettePath);
      assert.equal(cassette.version, 1);
      assert.equal(cassette.protocolVersion, '2024-11-05');
      assert.deepEqual(cassette.serverInfo, {
        name: 'fixture-mcp-server',
        version: '1.2.0',
      });
      assert.equal(cassette.interactions.length, 3);
      assert.deepEqual(
        cassette.interactions.map((item) => item.method),
        ['initialize', 'notifications/initialized', 'tools/list'],
      );
      assert.ok(cassette.interactions[0]?.response?.result !== undefined);
      assert.ok(cassette.interactions[2]?.response?.result !== undefined);

      // Verify strict offline replay against the hard-kill recorded cassette
      const replayRes = await runNodeCli(
        DIST_CLI,
        ['replay', '--cassette', cassettePath, '--strict'],
        wirePayload,
      );
      assert.equal(replayRes.code, 0);
      const replayLines = replayRes.stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(replayLines.length, 2);
      assert.equal(replayLines[0]?.id, 1);
      assert.equal(replayLines[1]?.id, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
