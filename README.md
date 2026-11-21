# @pie527645-cloud/mcp-cassette

Deterministic **Model Context Protocol (MCP)** stdio traffic recorder, secret-redacting cassette serializer, and zero-network offline CI replay mock server.

`mcp-cassette` sits transparently between any MCP client and stdio MCP server during recording, captures exact bidirectional JSON-RPC 2.0 interactions with turn latency metrics, scrubs credentials into deterministic placeholders (`<REDACTED_TOKEN_1>`) **before** writing canonical sorted-key JSON to disk, and replays those interactions offline in CI with zero network access and zero downstream server dependencies.

---

## Architecture & Workflow

```mermaid
sequenceDiagram
    autonumber
    participant Client as MCP Client / Test Suite
    participant Proxy as mcp-cassette (record)
    participant Server as Live MCP Server (stdio)
    participant Disk as session.mcp-cassette.json
    participant Mock as mcp-cassette (replay --strict)

    rect rgb(235, 245, 255)
    Note over Client,Disk: Phase 1: Local Recording & Pre-Disk Secret Scrubbing
    Client->>Proxy: JSON-RPC Request (initialize, tools/list, tools/call)
    Proxy->>Server: Forward Request (shell: false)
    Server-->>Proxy: JSON-RPC Response / Notification
    Proxy-->>Client: Forward Live Response (unmodified)
    Proxy->>Disk: Scrub secrets + canonical sorted-key JSON (Cassette v1)
    end

    rect rgb(235, 255, 240)
    Note over Client,Mock: Phase 2: Zero-Network Deterministic CI Replay
    Mock->>Disk: Load & validate cassette (<= 20 MB cap)
    Client->>Mock: JSON-RPC Request (method + canonicalized params)
    Mock-->>Client: Deterministic Recorded Response (or -32001 on strict mismatch)
    Client->>Mock: notifications/initialized
    Note right of Mock: Silent no-op (strict JSON-RPC 2.0)
    end
```

---

## Key Capabilities

- **Transparent Bidirectional Stdio Proxy (`record`):** Spawns any downstream MCP server safely (`shell: false`), forwards newline-delimited JSON-RPC 2.0 frames with sub-millisecond overhead, tracks per-request turn latency (`latencyMs`), captures `protocolVersion` and `serverInfo`, and cleanly reaps the entire child + grandchild process tree on EOF, `SIGINT`/`SIGTERM`, or `--timeout`.
- **Automatic Pre-Disk Secret Redaction:** Scrubs OpenAI/Anthropic keys (`sk-...`), GitHub tokens (`gh[pousr]_...`, `github_pat_...`), AWS access keys (`AKIA...`, `ASIA...`), Apify tokens (`apify_api_...`), Slack/npm/HuggingFace tokens, JWTs, `Bearer` credentials, and `Authorization` / `Proxy-Authorization` headers—plus optional `--redact-env` scrubbing for sensitive environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASS*` with length `>= 8`)—replacing identical secrets with deterministic `<REDACTED_TOKEN_N>` placeholders before touching disk.
- **Canonical Sorted-Key Cassette Format v1:** Every nested JSON object key is sorted lexicographically so cassettes produce clean, reproducible Git diffs and match incoming `params` regardless of key insertion order.
- **Stateful Zero-Network CI Replay (`replay`):** Matches `initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`, and custom MCP requests by `method` + canonicalized `params`, maintaining a per-bucket sequence cursor when identical calls repeat statefully.
- **Regression-Catching `--strict` Mode:** Immediately returns JSON-RPC error `-32001` when an unrecorded method, unrecorded argument payload, or extra repeat call occurs in CI. Handles `notifications/initialized` and other JSON-RPC 2.0 notifications silently with zero stdout frames.
- **Token & Latency Analytics (`inspect`):** Reports interaction counts, unique MCP methods and tool names, request/response byte totals, estimated token footprint (`Math.ceil(chars / 4)`), `p50`/`p95` latencies, and redacted secret counts in `pretty`, `json`, or `markdown` formats.
- **Zero Runtime Dependencies:** Built exclusively on Node.js `>=20.18.1` standard library modules.

---

## Setup from Source

```bash
git clone https://github.com/pie527645-cloud/mcp-cassette.git
cd mcp-cassette
npm install
npm run build
node dist/cli.js --help
```

Optional local symlink for shell usage:

```bash
npm link
mcp-cassette --version
```

---

## CLI Usage

### 1. Record a Live MCP Session

```bash
node dist/cli.js record \
  --stdio "node ./path/to/my-mcp-server.js --mode production" \
  --out ./cassettes/weather-tools.mcp-cassette.json \
  --redact-env \
  --timeout 30000
```

| Flag | Description |
| --- | --- |
| `--stdio "<cmd>"` | Downstream MCP server command tokenized with quote awareness (`shell: false`). |
| `--out <path>` | Output path for the redacted, sorted-key `.mcp-cassette.json` file. |
| `--redact-env` | Scrub values of sensitive `process.env` variables (`>= 8` chars matching `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASS*`). |
| `--timeout <ms>` | Optional session ceiling in milliseconds; reaps child + grandchild process tree on expiry. |

### 2. Replay Offline as an MCP Mock Server

Point your MCP client, agent harness, or integration test runner at `replay` instead of the live server command:

```bash
node dist/cli.js replay \
  --cassette ./cassettes/weather-tools.mcp-cassette.json \
  --strict \
  --latency-ms 0
```

| Flag | Description |
| --- | --- |
| `--cassette <path>` | Recorded `.mcp-cassette.json` file (`<= 20 MB`). |
| `--strict` | Return JSON-RPC `-32001` error immediately on any unrecorded method, parameter mismatch, or exhausted repeat sequence. |
| `--latency-ms <n>` | Optional fixed artificial response delay in milliseconds (defaults to `0` for instant CI execution). |

### 3. Inspect Cassette Footprint & Latency

```bash
node dist/cli.js inspect ./cassettes/weather-tools.mcp-cassette.json --format pretty
node dist/cli.js inspect ./cassettes/weather-tools.mcp-cassette.json --format json
node dist/cli.js inspect ./cassettes/weather-tools.mcp-cassette.json --format markdown
```

---

## GitHub Actions Offline CI Replay Example

Commit sanitized `.mcp-cassette.json` fixtures into your repository and run full MCP agent/tool integration suites in GitHub Actions with zero API keys and zero external network calls:

```yaml
name: MCP Offline Integration Suite

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify-mcp-workflows:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout project
        uses: actions/checkout@v4

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 20.x

      - name: Build mcp-cassette from source
        run: |
          git clone https://github.com/pie527645-cloud/mcp-cassette.git .tools/mcp-cassette
          cd .tools/mcp-cassette
          npm ci
          npm run build

      - name: Publish cassette telemetry to Job Summary
        run: |
          node .tools/mcp-cassette/dist/cli.js inspect \
            ./tests/cassettes/agent-smoke.mcp-cassette.json \
            --format markdown >> "$GITHUB_STEP_SUMMARY"

      - name: Run integration tests against strict offline MCP replay server
        env:
          MCP_SERVER_CMD: "node .tools/mcp-cassette/dist/cli.js replay --cassette ./tests/cassettes/agent-smoke.mcp-cassette.json --strict"
        run: npm test
```

---

## Cassette Format v1 Specification

Cassettes are serialized with deterministically sorted keys across every object level:

```json
{
  "interactions": [
    {
      "index": 0,
      "kind": "request",
      "latencyMs": 3.412,
      "method": "initialize",
      "params": {
        "capabilities": {},
        "clientInfo": {
          "name": "ci-agent",
          "version": "1.0.0"
        },
        "protocolVersion": "2024-11-05"
      },
      "requestId": 1,
      "response": {
        "result": {
          "capabilities": {
            "tools": {}
          },
          "protocolVersion": "2024-11-05",
          "serverInfo": {
            "name": "example-mcp",
            "version": "1.2.0"
          }
        }
      }
    },
    {
      "index": 1,
      "kind": "client_notification",
      "latencyMs": 0,
      "method": "notifications/initialized"
    },
    {
      "index": 2,
      "kind": "request",
      "latencyMs": 18.75,
      "method": "tools/call",
      "params": {
        "arguments": {
          "query": "status"
        },
        "name": "check_upstream"
      },
      "requestId": 2,
      "response": {
        "result": {
          "Authorization": "Bearer <REDACTED_TOKEN_1>",
          "content": [
            {
              "text": "Upstream healthy",
              "type": "text"
            }
          ]
        }
      }
    }
  ],
  "protocolVersion": "2024-11-05",
  "recordedAt": "2026-11-21T09:05:00.000Z",
  "redactionCount": 1,
  "serverCommand": [
    "node",
    "./server.js"
  ],
  "serverInfo": {
    "name": "example-mcp",
    "version": "1.2.0"
  },
  "version": 1
}
```

---

## Programmatic API

```ts
import {
  recordSession,
  replayCassette,
  inspectCassette,
  redactValue,
  loadCassette,
} from '@pie527645-cloud/mcp-cassette';

// 1. Scrub arbitrary JSON payloads deterministically
const scrubbed = redactValue(
  { headers: { Authorization: 'Bearer example_credential_value' } },
  { redactEnv: true },
);

// 2. Inspect a saved cassette programmatically
const stats = inspectCassette('./cassettes/session.mcp-cassette.json');
console.log(stats.uniqueToolNames, stats.estimatedTokens, stats.latencyMs.p95);

// 3. Load a validated cassette (enforces <= 20 MB ceiling)
const { cassette } = loadCassette('./cassettes/session.mcp-cassette.json');
```

---

## Security & Reliability Invariants

- **Zero Shell Injection:** `--stdio` commands are parsed by a quote-aware tokenizer and executed via `spawn(executable, args, { shell: false })`.
- **Full Process-Tree Reaping:** On Windows (`taskkill /T /F` plus `Win32_Process` orphan fallback) and POSIX (`detached` process group `-pid` `SIGTERM` -> `SIGKILL`), both child and detached grandchild processes are reaped on EOF, signals, or `--timeout`.
- **Bounded Memory:** Cassette loading and single JSON-RPC line framing strictly enforce a `20 MB` (`20,971,520` byte) ceiling.
- **ReDoS & Prototype-Pollution Hardened:** All token matchers use linear bounded character classes with zero nested quantifiers or lazy dot-all patterns; all lookup tables use `Object.create(null)` and `Object.hasOwn`.

---

## Development

```bash
npm run lint
npm run build
npm test
```

## License

MIT
