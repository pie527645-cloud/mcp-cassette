import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
});
