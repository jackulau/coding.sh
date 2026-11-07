# Changelog

All notable changes to coding.sh are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will
follow [Semantic Versioning](https://semver.org/) from the first npm release.

Each release opens with a short summary. The list under it has one line per change,
grouped by area, with links to the docs for the details.

## [0.1.1] - 2026-11-07

Daily benchmarks for any AI agent: `coding.sh bench` runs every contender on fresh cases each day,
and experiments add cluster bootstrap, an A/A noise floor, interleaved runs, early stopping and `compare --without`.
Seven more agents are verified on a real install, the viewer and the site work on phones, and the installer uses npm once the package is there.

### Added

- **Benchmarks.** `coding.sh bench` samples fresh cases each day from a command, failed sessions, GitHub issues, a sitemap or a dataset, freezes them as a dataset version and runs every contender on that set in random order. [Benchmarks](https://github.com/jackulau/coding.sh/blob/main/docs/guides/benchmarks.md).
- **Benchmarks.** Shared timeout and retries, a budget cap, quota and rate-limit cases dropped for every contender, and `bench run --resume` to finish a stopped run with the same seed and cases.
- **Benchmarks.** `bench report` writes a static HTML page and JSON: trend, gaps to a reference pooled over a fixed window, head-to-head stats, difficulty and failures. `bench regrade` re-scores stored outputs and `bench schedule` prints a cron line and a GitHub Actions workflow.
- **Benchmarks.** An `[anchor]` set of fixed cases runs every day next to the fresh ones and is scored apart, so its trend has no day-to-day difficulty in it.
- **Benchmarks.** `seed = "secret"` publishes the hash of each next day's salt and `bench show` checks the chain. Content hashes keep the same case under a new key from counting as fresh.
- **Benchmarks.** Input and output tokens are kept apart, and each cost says where it came from: reported, `costPerRun`, the shared price table, or unknown.
- **MCP.** A `benchmarks` tool lists benchmarks and reads results and history.
- **Experiments.** `exp compare --cluster <key>` resamples by repo or session and warns under 10 clusters. [Evals](https://coding.sh/docs/evals).
- **Experiments.** `exp aa` measures the run-to-run noise floor, and power planning uses it.
- **Experiments.** Compare flags uneven attrition between arms (Fisher exact) and splits infra errors from agent errors.
- **Experiments.** Under 100 paired cases, compare also reports P(B>A) from a paired posterior.
- **Experiments.** `exp run --arm a=<task> --arm b=<task>` interleaves both arms case by case in a seeded random order.
- **Experiments.** `--stop-early` checks at planned looks with O'Brien-Fleming alpha spending and reports a repeated confidence interval.
- **Experiments.** Pairwise judges see both outputs in both orders. `exp compare --pairwise` reports win rate, ties and position bias.
- **Experiments.** `exp sweep` races task configs on a train split and reports the winner's optimism gap on held-out cases.
- **Compare.** `compare <bundle> --without <path>` measures what one skill, AGENTS.md, CLAUDE.md or MCP config is worth. [Compare agents](https://coding.sh/docs/how-to/compare-agents).
- **Compare.** With 2+ attempts per task, failed runs split into bad runs, arm limits and tasks no arm solves, with variance shares.
- **Compare.** Cost rows show how many runs had a known cost, and "cheaper" needs a known cost for 80% of each arm.
- **Agents.** Verified on a real install against a local stub model: opencode, copilot-cli, droid, goose, pi, t3code and aider. [Agent matrix](https://coding.sh/docs/agents).
- **Agents.** Antigravity backfill reads agy transcripts and conversation DBs for model, tokens, cache reads and latency per call. Tool steps missing from the transcript count as failures, and hooks reply `{}`.
- **Viewer.** Phone layouts: 44px targets, filters in a bottom sheet, a compact session header and safe-area insets.
- **Viewer.** The Benchmarks tab shows anchors, pooled gaps, difficulty, cost sources and tokens, and ranks follow the pooled gaps.
- **Site.** Mobile pass: touch targets, safe areas, stacked agent cards and 16px body text on phones.
- **Site.** A new landing page, a changelog page and docs pages.
- **Install.** `install.sh` installs from npm when the registry has the version, else from the GitHub release. `CODING_SH_SOURCE=npm|github` picks one.
- **Release.** A tag creates its GitHub release as soon as the checks pass, so the installer gets it right away.
- **Release.** The release workflow can publish all five packages to npm and PyPI with trusted publishing. Nothing is on npm or PyPI yet.
- **Docs.** A new README, reference pages, how-to guides and a code of conduct.

### Fixed

- **Fixes.** Safer installs: symlinked and JSONC agent configs survive, `init --dry-run` prints a short plan, and blockers show before the Y/n.
- **Fixes.** Each SQLite migration runs once when the hook and the CLI open a new index at the same time.
- **Fixes.** Experiments stop cleanly on Ctrl-C, kill their child processes and keep every finished run.
- **Fixes.** Capture, ingest and storage state bugs from an audit of each state machine. Sessions are priced locally at ingest.
- **Fixes.** Adapter fixes for opencode, goose, copilot-cli, droid, aider and t3code, found running each on a real install.
- **Fixes.** `coding.sh run --agent <name>` records sessions for names with no adapter.
- **Fixes.** `exp aa` refuses to compare a run with itself.
- **Fixes.** `coding.sh ui` prints the viewer URL once in a terminal.
- **Fixes.** Muted text in the viewer passes WCAG AA in both themes.
- **Fixes.** Timing tests compare against a baseline, so a loaded machine no longer fails them.

## [0.1.0] - 2026-11-06

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
- **Capture.** `run` spools secret flag values (`--openai-api-key X`, `--api-key=X`) redacted, and ingest redacts them in any argv.
- **Capture.** Pi, Goose, Copilot CLI, Droid, Gemini CLI and Antigravity sessions seen by hooks and by `ingest --backfill` store each call, reply and turn once, and count tokens once.
- **Capture.** A session seen by hooks and by `ingest --backfill` keeps one session start and one end, for every agent.
- **Capture.** `coding.sh run -- <cmd>` wraps any agent and snapshots the tree before and after in shadow git, not your repo.
- **Capture.** Every model call becomes an `llm.call` event with model, tokens, duration and time to first token.
- **Capture.** Subagent starts and ends are captured and linked to their child sessions.
- **Capture.** No ingest step: reads, the viewer and MCP ingest new events first; a session end starts a locked background ingest.
- **Capture.** `coding.sh collector` takes OTLP/HTTP traces and logs, protobuf or JSON, on 127.0.0.1:4318. [OTLP setup](https://coding.sh/docs/otel).
- **Capture.** The receiver reads OTel GenAI semconv, OpenInference, the Vercel AI SDK, and Claude Code, Codex and Gemini CLI logs.
- **Agents.** Verified on real sessions: Claude Code, Codex and Antigravity. [Agent matrix](https://coding.sh/docs/agents).
- **Agents.** Fixture-tested so far: opencode, cursor, gemini-cli, copilot-cli, amp, pi, droid, goose, t3code and aider.
- **Agents.** Every adapter has fixture tests, and an `ingest --backfill` path where the agent keeps history.
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

[0.1.1]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.1
[0.1.0]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.0
