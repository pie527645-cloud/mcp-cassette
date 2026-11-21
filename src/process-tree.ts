import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnChildOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Spawns a downstream MCP stdio server strictly with `shell: false`.
 * On POSIX, creates a dedicated process group (`detached: true`) so child + grandchild
 * processes can be reaped atomically via `-pid`.
 */
export function spawnMcpChild(
  commandTokens: readonly string[],
  options: SpawnChildOptions = {},
): ChildProcess {
  const executable = commandTokens[0];
  if (!executable) {
    throw new Error('Cannot spawn MCP server: missing executable.');
  }
  const args = commandTokens.slice(1);

  return spawn(executable, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
}

function runExecIgnoreErrors(cmd: string, args: string[], timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve(null);
      }
    }, timeoutMs);
    timer.unref();

    proc.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

/**
 * Cleanly reaps a spawned child process AND any grandchild processes on both Windows and POSIX.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0 || !Number.isInteger(pid)) {
    return;
  }

  try {
    child.stdin?.destroy();
  } catch {
    // ignore
  }

  if (process.platform === 'win32') {
    // Tier 1: taskkill /T /F kills the root process and all descendant processes when root is alive.
    const exitCode = await runExecIgnoreErrors('taskkill.exe', ['/PID', String(pid), '/T', '/F']);

    // Tier 2: If root process already exited before taskkill ran, reap any orphaned descendants
    // whose ParentProcessId still references `pid`.
    if (exitCode !== 0) {
      const psScript =
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }`;
      await runExecIgnoreErrors('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
      ]);
    }

    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // ignore
    }
    return;
  }

  // POSIX: child was spawned with `detached: true`, so `-pid` addresses the entire process group.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isPidAlive(pid)) {
      break;
    }
    await delay(25);
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      if (isPidAlive(pid)) {
        child.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }

  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch {
    // ignore
  }
}
