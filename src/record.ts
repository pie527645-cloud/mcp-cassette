import { performance } from 'node:perf_hooks';
import { tokenizeCommand } from './argv.js';
import { saveCassette } from './cassette.js';
import { attachLineReader } from './line-reader.js';
import { killProcessTree, spawnMcpChild } from './process-tree.js';
import { redactCassette } from './redact.js';
import type {
  CassetteInteraction,
  CassetteServerInfo,
  CassetteV1,
  JsonObject,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonValue,
  RecordOptions,
  RecordSessionResult,
} from './types.js';

interface PendingRequestEntry {
  slotIndex: number;
  method: string;
  startedAt: number;
}

function makeRpcIdKey(id: JsonRpcId): string {
  if (id === null) return 'null:null';
  return `${typeof id}:${String(id)}`;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidRpcId(val: unknown): val is JsonRpcId {
  return val === null || typeof val === 'string' || typeof val === 'number';
}

/**
 * Runs a transparent bidirectional stdio JSON-RPC recording proxy in front of a
 * downstream MCP server, measuring turn latencies, scrubbing secrets prior to disk
 * serialization, and cleanly reaping the child + grandchild process tree on exit.
 */
export async function recordSession(options: RecordOptions): Promise<RecordSessionResult> {
  const commandTokens =
    typeof options.stdioCommand === 'string'
      ? tokenizeCommand(options.stdioCommand)
      : [...options.stdioCommand];

  if (commandTokens.length === 0 || !commandTokens[0]) {
    throw new Error('recordSession requires a non-empty stdioCommand.');
  }

  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('--timeout must be a positive number of milliseconds.');
  }

  const inputStream = options.inputStream ?? process.stdin;
  const outputStream = options.outputStream ?? process.stdout;
  const stderrStream = options.stderrStream ?? process.stderr;
  const recordedAt = options.recordedAt ?? new Date().toISOString();

  const child = spawnMcpChild(commandTokens, { env: options.env });

  const interactions: CassetteInteraction[] = [];
  const pendingById: Record<string, PendingRequestEntry> = Object.create(null) as Record<
    string,
    PendingRequestEntry
  >;
  let pendingCount = 0;
  let protocolVersion: string | null = null;
  let serverInfo: CassetteServerInfo | null = null;

  let inputEnded = false;
  let finalizing = false;
  let timedOut = false;
  let proxyInitiatedKill = false;
  let childExitCode: number | null = null;

  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (sessionTimer !== undefined) {
      clearTimeout(sessionTimer);
      sessionTimer = undefined;
    }
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  return new Promise<RecordSessionResult>((resolve, reject) => {
    let detachInput = (): void => {};
    let detachChildStdout = (): void => {};

    const onStderrData = (chunk: Buffer | string): void => {
      try {
        stderrStream.write(chunk);
      } catch {
        // ignore downstream stderr write errors
      }
    };

    if (child.stderr) {
      child.stderr.on('data', onStderrData);
    }

    const onSignal = (): void => {
      void finalize('signal');
    };

    const removeSignalListeners = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const buildRedactedCassette = (): CassetteV1 => {
      const unredactedCassette: CassetteV1 = {
        version: 1,
        recordedAt,
        serverCommand: commandTokens,
        protocolVersion,
        serverInfo,
        redactionCount: 0,
        interactions: interactions.map((item, idx) => ({ ...item, index: idx })),
      };

      return redactCassette(unredactedCassette, {
        redactEnv: Boolean(options.redactEnv),
        env: options.env ?? process.env,
      });
    };

    const flushCheckpoint = (): CassetteV1 => {
      const redactedCassette = buildRedactedCassette();
      if (options.outPath) {
        saveCassette(options.outPath, redactedCassette);
      }
      return redactedCassette;
    };

    const finalize = async (reason: 'eof' | 'child_exit' | 'timeout' | 'signal'): Promise<void> => {
      if (finalizing) return;
      finalizing = true;
      if (reason === 'timeout') {
        timedOut = true;
      }
      if (reason === 'eof' || reason === 'timeout' || reason === 'signal') {
        proxyInitiatedKill = true;
      }

      clearTimers();
      removeSignalListeners();
      detachInput();
      detachChildStdout();
      if (child.stderr) {
        child.stderr.off('data', onStderrData);
      }

      try {
        child.stdin?.end();
      } catch {
        // ignore
      }

      // Synchronously persist redacted cassette BEFORE async child-tree reaping so trailing
      // notifications or unanswered requests are guaranteed on disk even if parent terminates us.
      let redactedCassette: CassetteV1;
      let checkpointErr: Error | undefined;
      try {
        redactedCassette = flushCheckpoint();
      } catch (err) {
        checkpointErr = err instanceof Error ? err : new Error(String(err));
        redactedCassette = buildRedactedCassette();
      }

      await killProcessTree(child);

      if (checkpointErr) {
        reject(checkpointErr);
        return;
      }

      resolve({
        cassette: redactedCassette,
        timedOut,
        exitCode: proxyInitiatedKill ? 0 : childExitCode,
      });
    };

    const scheduleSettleFinalize = (delayMs = 25): void => {
      if (finalizing || settleTimer !== undefined) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        void finalize('eof');
      }, delayMs);
      settleTimer.unref();
    };

    child.on('error', (err) => {
      if (finalizing) return;
      finalizing = true;
      clearTimers();
      removeSignalListeners();
      detachInput();
      detachChildStdout();
      if (child.stderr) {
        child.stderr.off('data', onStderrData);
      }
      reject(
        new Error(
          `Failed to spawn downstream MCP server "${commandTokens[0]}": ${err.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      childExitCode = code;
      if (!finalizing) {
        void finalize('child_exit');
      }
    });

    const handleClientMessageObject = (msg: Record<string, unknown>): void => {
      const method = msg.method;
      if (typeof method !== 'string' || method.length === 0) {
        return;
      }

      if (Object.hasOwn(msg, 'id') && msg.id !== undefined && isValidRpcId(msg.id)) {
        const slotIndex = interactions.length;
        const interaction: CassetteInteraction = {
          index: slotIndex,
          kind: 'request',
          method,
          requestId: msg.id,
          latencyMs: 0,
        };
        if (Object.hasOwn(msg, 'params') && msg.params !== undefined) {
          interaction.params = msg.params as JsonValue;
        }
        interactions.push(interaction);

        const key = makeRpcIdKey(msg.id);
        pendingById[key] = {
          slotIndex,
          method,
          startedAt: performance.now(),
        };
        pendingCount += 1;
      } else if (!Object.hasOwn(msg, 'id')) {
        const interaction: CassetteInteraction = {
          index: interactions.length,
          kind: 'client_notification',
          method,
          latencyMs: 0,
        };
        if (Object.hasOwn(msg, 'params') && msg.params !== undefined) {
          interaction.params = msg.params as JsonValue;
        }
        interactions.push(interaction);
      }
    };

    const handleServerMessageObject = (
      msg: Record<string, unknown>,
    ): { handled: boolean; shouldSettle: boolean } => {
      if (
        Object.hasOwn(msg, 'id') &&
        msg.id !== undefined &&
        isValidRpcId(msg.id) &&
        !Object.hasOwn(msg, 'method')
      ) {
        const key = makeRpcIdKey(msg.id);
        if (Object.hasOwn(pendingById, key)) {
          const entry = pendingById[key]!;
          delete pendingById[key];
          pendingCount = Math.max(0, pendingCount - 1);

          const elapsed = Math.max(
            0,
            Math.round((performance.now() - entry.startedAt) * 1000) / 1000,
          );
          const slot = interactions[entry.slotIndex];
          if (slot) {
            slot.latencyMs = elapsed;
            if (Object.hasOwn(msg, 'error') && isPlainObject(msg.error)) {
              const errObj: JsonRpcErrorObject = {
                code: typeof msg.error.code === 'number' ? msg.error.code : -32603,
                message:
                  typeof msg.error.message === 'string' ? msg.error.message : 'Unknown error',
              };
              if (Object.hasOwn(msg.error, 'data') && msg.error.data !== undefined) {
                errObj.data = msg.error.data as JsonValue;
              }
              slot.response = { error: errObj };
            } else {
              slot.response = {
                result: (Object.hasOwn(msg, 'result') ? msg.result : null) as JsonValue,
              };
            }

            if (entry.method === 'initialize' && isPlainObject(msg.result)) {
              const resObj = msg.result as JsonObject;
              if (typeof resObj.protocolVersion === 'string') {
                protocolVersion = resObj.protocolVersion;
              }
              if (
                isPlainObject(resObj.serverInfo) &&
                typeof resObj.serverInfo.name === 'string' &&
                typeof resObj.serverInfo.version === 'string'
              ) {
                serverInfo = resObj.serverInfo as CassetteServerInfo;
              }
            }
          }

          return {
            handled: true,
            shouldSettle: inputEnded && pendingCount === 0,
          };
        }
        return { handled: false, shouldSettle: false };
      }

      if (typeof msg.method === 'string' && msg.method.length > 0 && !Object.hasOwn(msg, 'id')) {
        const interaction: CassetteInteraction = {
          index: interactions.length,
          kind: 'server_notification',
          method: msg.method,
          latencyMs: 0,
        };
        if (Object.hasOwn(msg, 'params') && msg.params !== undefined) {
          interaction.params = msg.params as JsonValue;
        }
        interactions.push(interaction);
        return { handled: true, shouldSettle: false };
      }

      return { handled: false, shouldSettle: false };
    };

    if (child.stdout) {
      detachChildStdout = attachLineReader(child.stdout, {
        onLine: (line) => {
          // 1. Parse JSON and record interaction/latency BEFORE disk checkpoint I/O
          let parsed: unknown = null;
          let isJson = false;
          try {
            parsed = JSON.parse(line);
            isJson = true;
          } catch {
            isJson = false;
          }

          let anyHandled = false;
          let shouldSettle = false;

          if (isJson) {
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (isPlainObject(item)) {
                  const outcome = handleServerMessageObject(item);
                  anyHandled = anyHandled || outcome.handled;
                  shouldSettle = shouldSettle || outcome.shouldSettle;
                }
              }
            } else if (isPlainObject(parsed)) {
              const outcome = handleServerMessageObject(parsed);
              anyHandled = outcome.handled;
              shouldSettle = outcome.shouldSettle;
            }
          }

          // 2. Atomically flush redacted checkpoint BEFORE forwarding line to host stdout,
          //    eliminating any race if the host hard-kills mcp-cassette upon reading the response.
          if (anyHandled) {
            try {
              flushCheckpoint();
            } catch (err) {
              if (!finalizing) {
                void finalize('child_exit').then(() => {}, () => {});
                reject(err instanceof Error ? err : new Error(String(err)));
              }
              return;
            }
          }

          // 3. Forward raw line to host stdout
          try {
            outputStream.write(`${line}\n`);
          } catch {
            // ignore broken downstream stdout pipe
          }

          if (shouldSettle) {
            scheduleSettleFinalize(25);
          }
        },
        onError: (err) => {
          if (!finalizing) {
            void finalize('child_exit').then(() => {}, () => {});
            reject(err);
          }
        },
      });
    }

    detachInput = attachLineReader(inputStream, {
      onLine: (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Still forward raw line transparently even if non-JSON
          parsed = null;
        }

        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (isPlainObject(item)) {
              handleClientMessageObject(item);
            }
          }
        } else if (isPlainObject(parsed)) {
          handleClientMessageObject(parsed);
        }

        try {
          child.stdin?.write(`${line}\n`);
        } catch {
          // child stdin already closed
        }
      },
      onEnd: () => {
        inputEnded = true;
        if (pendingCount === 0) {
          scheduleSettleFinalize(30);
        } else {
          const drainBudgetMs =
            options.timeoutMs !== undefined
              ? Math.min(options.timeoutMs, 5000)
              : 5000;
          drainTimer = setTimeout(() => {
            drainTimer = undefined;
            void finalize('eof');
          }, drainBudgetMs);
          drainTimer.unref();
        }
      },
      onError: (err) => {
        if (!finalizing) {
          finalizing = true;
          clearTimers();
          removeSignalListeners();
          void killProcessTree(child).finally(() => reject(err));
        }
      },
    });

    if (options.timeoutMs !== undefined) {
      sessionTimer = setTimeout(() => {
        sessionTimer = undefined;
        void finalize('timeout');
      }, options.timeoutMs);
      sessionTimer.unref();
    }
  });
}
