# @agent-layer/bench

Single local smoke/benchmark harness for provider packages.

Currently implemented provider:

- `codex`

## Run bench

Default (Codex):

```bash
bun bench
```

Custom timeout and prompt:

```bash
CODEX_APPROVAL_POLICY=never CODEX_SANDBOX_MODE=read-only bun bench -- -- --timeout-ms 120000 "Explain what changed in this repo"
```

Explicit provider selection (kept for multi-provider compatibility):

```bash
bun bench -- -- --provider codex "Inspect this repository briefly"
```

Show streamed tool events (`tool-call`, `tool-result`, etc.):

```bash
CODEX_APPROVAL_POLICY=never CODEX_SANDBOX_MODE=read-only bun bench -- -- --stream-events "Inspect this repository briefly"
```

## Run tests

Offline e2e (no network/API needed):

```bash
bun integration-test
```

Unit tests (arg/provider parsing):

```bash
bun test
```

Live e2e against your installed/authenticated Codex SDK:

```bash
RUN_CODEX_LIVE_E2E=1 bun integration-test
```

## Optional env vars for codex

- `CODEX_MODEL` (default: `gpt-5`)
- `CODEX_SANDBOX_MODE` (`read-only`, `workspace-write`, `danger-full-access`; default: `read-only`)
- `CODEX_APPROVAL_POLICY` (`never`, `on-request`, `on-failure`, `untrusted`; default: `never`)
- `BENCH_TIMEOUT_MS` (milliseconds; default: `30000`)
- `BENCH_STREAM_EVENTS` (`1` to include streamed tool events)
- `CODEX_PATH_OVERRIDE` (path to codex executable, useful for local testing)
- `CODEX_API_KEY` (optional API-key auth)
- `CODEX_BASE_URL` or `OPENAI_BASE_URL` (optional endpoint override)
- `BENCH_PROVIDER` (default provider, currently `codex`)
