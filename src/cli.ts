#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatInspection, inspectCassette } from './inspect.js';
import { recordSession } from './record.js';
import { replayCassette } from './replay.js';
import type { InspectFormat } from './types.js';

export const CLI_VERSION = '0.1.0';

const MAIN_HELP = `mcp-cassette v${CLI_VERSION}
Deterministic MCP stdio traffic recorder, secret-redacting cassette serializer, and offline CI replay mock server.

Usage:
  mcp-cassette record --stdio "<cmd>" --out <cassette.json> [--redact-env] [--timeout <ms>]
  mcp-cassette replay --cassette <cassette.json> [--strict] [--latency-ms <n>]
  mcp-cassette inspect <cassette.json> [--format pretty|json|markdown]

Commands:
  record    Spawn downstream MCP stdio server, proxy JSON-RPC traffic, redact secrets, and write sorted cassette JSON
  replay    Run an offline zero-network stdio MCP mock server backed by a recorded cassette
  inspect   Summarize cassette interactions, unique methods/tools, byte/token footprint, p50/p95 latency, and redactions

Global Options:
  -h, --help      Show help information
  -v, --version   Print version number
`;

const RECORD_HELP = `Usage:
  mcp-cassette record --stdio "<cmd>" --out <cassette.json> [--redact-env] [--timeout <ms>]

Options:
  --stdio <cmd>     Target MCP server command line (parsed safely with shell: false)
  --out <file>      Output path for sorted Cassette Format v1 JSON
  --redact-env      Also scrub sensitive process.env values (>= 8 chars matching *KEY*, *TOKEN*, *SECRET*, *PASS*)
  --timeout <ms>    Maximum session duration in milliseconds before reaping the server process tree
  -h, --help        Show help for record
`;

const REPLAY_HELP = `Usage:
  mcp-cassette replay --cassette <cassette.json> [--strict] [--latency-ms <n>]

Options:
  --cassette <file>  Path to recorded .mcp-cassette.json file (<= 20 MB)
  --strict           Immediately return JSON-RPC -32001 error on any unrecorded method/params or repeat mismatch
  --latency-ms <n>   Optional deterministic artificial response delay in milliseconds (default: 0)
  -h, --help         Show help for replay
`;

const INSPECT_HELP = `Usage:
  mcp-cassette inspect <cassette.json> [--format pretty|json|markdown]

Options:
  --cassette <file>  Alternative flag to specify cassette file path
  --format <fmt>     Output format: pretty (default), json, or markdown
  -h, --help         Show help for inspect
`;

async function handleRecord(rawArgs: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      stdio: { type: 'string' },
      out: { type: 'string' },
      'redact-env': { type: 'boolean', default: false },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${RECORD_HELP}\n`);
    return 0;
  }

  if (!values.stdio || values.stdio.trim().length === 0) {
    process.stderr.write('Error: `mcp-cassette record` requires `--stdio "<cmd>"`.\n');
    return 1;
  }

  if (!values.out || values.out.trim().length === 0) {
    process.stderr.write('Error: `mcp-cassette record` requires `--out <cassette.json>`.\n');
    return 1;
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsedTimeout = Number(values.timeout);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      process.stderr.write('Error: `--timeout` must be a positive number in milliseconds.\n');
      return 1;
    }
    timeoutMs = parsedTimeout;
  }

  const result = await recordSession({
    stdioCommand: values.stdio,
    outPath: values.out,
    redactEnv: Boolean(values['redact-env']),
    timeoutMs,
  });

  if (result.timedOut) {
    process.stderr.write(
      `[mcp-cassette] Session timeout (${timeoutMs}ms) reached; child process tree reaped and cassette saved to ${values.out}.\n`,
    );
    return 1;
  }

  if (
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    result.cassette.interactions.length === 0
  ) {
    return result.exitCode;
  }

  return 0;
}

async function handleReplay(rawArgs: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      cassette: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'latency-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`${REPLAY_HELP}\n`);
    return 0;
  }

  const cassettePath = values.cassette ?? positionals[0];
  if (!cassettePath || cassettePath.trim().length === 0) {
    process.stderr.write(
      'Error: `mcp-cassette replay` requires `--cassette <cassette.json>`.\n',
    );
    return 1;
  }

  let latencyMs = 0;
  if (values['latency-ms'] !== undefined) {
    const parsedLatency = Number(values['latency-ms']);
    if (!Number.isFinite(parsedLatency) || parsedLatency < 0) {
      process.stderr.write('Error: `--latency-ms` must be a non-negative number.\n');
      return 1;
    }
    latencyMs = parsedLatency;
  }

  await replayCassette({
    cassette: cassettePath,
    strict: Boolean(values.strict),
    latencyMs,
  });

  return 0;
}

async function handleInspect(rawArgs: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      cassette: { type: 'string' },
      format: { type: 'string', default: 'pretty' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`${INSPECT_HELP}\n`);
    return 0;
  }

  const cassettePath = values.cassette ?? positionals[0];
  if (!cassettePath || cassettePath.trim().length === 0) {
    process.stderr.write(
      'Error: `mcp-cassette inspect` requires `<cassette.json>`.\n',
    );
    return 1;
  }

  const fmt = values.format ?? 'pretty';
  if (fmt !== 'pretty' && fmt !== 'json' && fmt !== 'markdown') {
    process.stderr.write(
      `Error: unsupported --format "${fmt}". Expected pretty, json, or markdown.\n`,
    );
    return 1;
  }

  const inspection = inspectCassette(cassettePath);
  const formatted = formatInspection(inspection, fmt as InspectFormat);
  process.stdout.write(`${formatted}\n`);
  return 0;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const first = argv[0];

  if (!first || first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(`${MAIN_HELP}\n`);
    return 0;
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const rest = argv.slice(1);

  try {
    switch (first) {
      case 'record':
        return await handleRecord(rest);
      case 'replay':
        return await handleReplay(rest);
      case 'inspect':
        return await handleInspect(rest);
      default:
        process.stderr.write(
          `Error: unknown command "${first}". Run \`mcp-cassette --help\` for usage.\n`,
        );
        return 1;
    }
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const currentFile = fs.realpathSync(fileURLToPath(import.meta.url));
    const invokedFile = fs.realpathSync(path.resolve(entryArg));
    return currentFile === invokedFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(
        `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
