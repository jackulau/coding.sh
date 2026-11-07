# Changelog

All notable changes to coding.sh are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will
follow [Semantic Versioning](https://semver.org/) from the first npm release.

Each release opens with a short summary. The list under it has one line per change,
grouped by area, with links to the docs for the details.

## [0.1.0] - Unreleased

The first public release, still pre-1.0. coding.sh records what your AI agents do, with coding
agents first-class, on your own machine, shows it in a local viewer, and turns those sessions into evals and A/B experiments.
It also runs as a server on SQLite or Postgres, with SDKs for apps that call model APIs.

### Added

- **Install.** `curl -fsSL https://coding.sh/install | sh` checks for Node 22.15+, installs with npm, runs `init` and opens the viewer.
- **Install.** Or `npm install -g coding.sh && coding.sh init`. `init` shows one plan and asks one Y/n. [Install guide](https://coding.sh/docs/install).
- **Install.** `coding.sh` with no command opens the viewer, and sets up capture on its first run.
- **Install.** Commands print one dim line when a release is out, checked in the background at most once a day.
- **Install.** `coding.sh update` installs the new release. The check is off in CI and [can be turned off](https://github.com/jackulau/coding.sh/blob/main/docs/guides/install.md).
- **Install.** `coding.sh uninstall` restores each agent config byte for byte if nothing else has edited it since.
- **Capture.** Hooks record prompts, tool calls, file changes, turns and errors to a local spool, then ingest them into sessions.
- **Capture.** Secrets are redacted before anything is stored. [Privacy](https://github.com/jackulau/coding.sh/blob/main/docs/guides/privacy.md).
- **Capture.** `coding.sh run -- <cmd>` wraps any agent and snapshots the tree before and after in shadow git, not your repo.
- **Capture.** Every model call becomes an `llm.call` event with model, tokens, duration and time to first token.
- **Capture.** Subagent starts and ends are captured and linked to their child sessions.
- **Capture.** No ingest step: reads, the viewer and MCP ingest new events first; a session end starts a locked background ingest.
- **Capture.** `coding.sh collector` takes OTLP/HTTP traces and logs, protobuf or JSON, on 127.0.0.1:4318. [OTLP setup](https://coding.sh/docs/otel).
- **Capture.** The receiver reads OTel GenAI semconv, OpenInference, the Vercel AI SDK, and Claude Code, Codex and Gemini CLI logs.
- **Agents.** Verified on real sessions: Claude Code, Codex and Antigravity. [Agent matrix](https://coding.sh/docs/agents).
- **Agents.** Fixture-tested so far: opencode, cursor, gemini-cli, copilot-cli, amp, pi, droid, goose, t3code, aider, the wrapper.
- **Agents.** Every adapter has fixture tests, and an `ingest --backfill` path where the agent keeps history.
- **Agents.** Antigravity backfill reads agy transcripts and conversation DBs: model, tokens, cache reads and latency per call.
- **Agents.** agy tool steps missing from its transcript count as failures, prompts drop agy's wrapper, and hooks reply `{}`.
- **Agents.** T3 Code threads import from its local store; Codex and Claude Code runs in T3 count once, agent in `provider`.
- **Agents.** `coding.sh usage --by agent-model` compares tokens per turn and cache-read share across harnesses.
- **Storage.** One SQLite index (node:sqlite, no native deps) and a content-addressed, zstd-compressed blob store. [Storage](https://coding.sh/docs/storage).
- **Storage.** OTLP and HTTP sinks send metadata only by default.
- **Viewer.** `coding.sh ui` serves a local viewer: sessions, search, a timeline of turns, tools and subagents, and outcome labels.
- **MCP.** `coding.sh mcp` lets agents query sessions, failures, latency, usage, subagents and experiments over stdio. [MCP](https://coding.sh/docs/mcp).
- **MCP.** `init` registers it with Claude Code, Codex, Cursor, OpenCode and Gemini CLI. `--no-mcp` skips that.
- **CLI.** 27 commands, from `init` and `sessions` to `eval`, `exp` and `serve`, all with `--json` output. [CLI reference](https://coding.sh/docs/cli).
- **Evals.** Repo-replay tasks start from the snapshot taken before the agent ran. [Evals](https://coding.sh/docs/evals).
- **Evals.** `eval validate` checks verifiers: a do-nothing run fails, the reference fix passes k of k, near-misses fail, nothing leaks.
- **Evals.** Datasets with deterministic graders, command graders and LLM judges.
- **Evals.** Judges are calibrated on human labels with Cohen's kappa on a held-out split. Reports flag uncalibrated judges.
- **Evals.** Experiments run two arms on the same cases: a paired bootstrap CI of the difference and exact McNemar on flips.
- **Benchmarks.** `coding.sh bench` samples fresh cases each day from a command, failed sessions, GitHub issues, a sitemap or a dataset, freezes them as a dataset version and runs every contender on that set in random order. [Benchmarks](https://github.com/jackulau/coding.sh/blob/main/docs/guides/benchmarks.md).
- **Benchmarks.** Shared timeout and retries, quota and rate-limit cases dropped for every contender, a budget cap, and history that counts only the first complete scheduled run per day.
- **Benchmarks.** `bench report` writes a static HTML page and JSON with the trend, paired gaps to a reference, head-to-head stats and failures. `bench regrade` re-scores stored outputs. `bench schedule` prints a cron line and a pinned GitHub Actions workflow.
- **Benchmarks.** `bench run --resume` finishes a run stopped by the budget or an interrupt, with the same seed and cases, keeping the calls that finished.
- **Benchmarks.** An `[anchor]` set: fixed cases that run every day next to the fresh ones and are scored apart, so their trend has no day-to-day difficulty in it. `bench history --anchor` and a report section.
- **Benchmarks.** `seed = "secret"`: each run reveals its salt and publishes the hash of the next day's, and `bench show` checks the chain, so nobody can predict a sample or pick one after looking.
- **Benchmarks.** Each case's content hash goes into the freshness ledger, so the same content under a new key isn't fresh. History warns when a key's content changes, and regrade checks stored inputs against their hashes.
- **Benchmarks.** Input and output tokens are kept apart, and each cost says where it came from: reported, `costPerRun`, the shared price table, or unknown.
- **Benchmarks.** `history --vs` and the report pool each daily gap over a fixed window (random effects with the Hartung-Knapp interval), and the report adds a difficulty chart.
- **MCP.** A `benchmarks` tool lists benchmarks and reads results and history.
- **Evals.** Harness compare adds per-arm Wilson intervals and the first step where the traces diverge.
- **Evals.** [Tool evals](https://coding.sh/docs/tool-evals) for CLI and MCP surfaces: description size, schema checks, per-task tool-call metrics in a sandbox.
- **Production.** `coding.sh serve` runs ingest (OTLP/HTTP and `POST /v1/ingest`), the viewer and its API on one port. [Production](https://coding.sh/docs/production).
- **Production.** Set the store with `CODING_SH_STORE_URL` or `DATABASE_URL`, and blobs with `CODING_SH_BLOB_URL` (file, postgres, s3).
- **Production.** Writes are acked after commit, a full queue answers 429 with `Retry-After`, and retries never duplicate.
- **Production.** Ingest keys pick the project and read keys open the viewer. `serve keygen` and `serve healthcheck` help.
- **Production.** `/healthz`, `/readyz`, Prometheus `/metrics`, and one writer lock with `--role viewer` replicas.
- **Production.** `CODING_SH_RETENTION_DAYS` sets retention and `CODING_SH_CAPTURE_MODE=metadata` drops message text and tool I/O.
- **Production.** `coding.sh-store-postgres` keeps the index, and blobs by default, in Postgres. Passes the store conformance suite.
- **Production.** Store URLs take `sqlite://`, `postgres://` or `postgresql://`.
- **Production.** `coding.sh-store-s3` keeps blobs in S3, R2 or MinIO. SigV4, no AWS SDK, credentials only from `AWS_*` env vars.
- **Production.** A Dockerfile with both store plugins, a Compose stack (serve, Postgres, MinIO), and examples in examples/production.
- **Production.** Deploy recipes for Fly, Railway and Render. [Deploy guides](https://github.com/jackulau/coding.sh/tree/main/docs/production).
- **Production.** `--store <url>` or `CODING_SH_STORE_URL` points `sessions`, `show`, `search`, `mcp`, `dataset` and `exp` at the serve database.
- **Production.** `sessions` and `search` take `--project`.
- **SDKs.** `@coding.sh/sdk` for TypeScript: `observe(client)` for OpenAI and Anthropic, `observeFetch()`, `aiSdkTracer()`, `withSession`.
- **SDKs.** `coding-sh` for Python: `observe(client)` and OTel setup.
- **SDKs.** Both batch, retry on 429 and never throw into your app. Not on npm or PyPI yet.
- **Integrations.** Sessions sent through the Vercel AI Gateway are tagged `gateway:vercel`. [AI Gateway](https://coding.sh/docs/ai-gateway).
- **Integrations.** `coding.sh gateway status|enrich` adds billed cost, serving provider, client session join and the `vmc/` model per call.
- **Integrations.** The receiver maps gateway trace drains and AI SDK `gateway` spans.
- **Integrations.** `compare --gateway` and the `gateway` grader provider run arms across models with one key.
- **Integrations.** eve: span enrichment, a read-only importer for its local traces, and an experiment task that drives a local agent.
- **Docs.** README with a quickstart, the agent matrix, OTLP setup, storage, privacy and uninstall.
- **Docs.** CONTRIBUTING, SECURITY and a release checklist in docs/RELEASE.md.

[0.1.0]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.0
