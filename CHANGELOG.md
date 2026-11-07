# Changelog

All notable changes to coding.sh are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will
follow [Semantic Versioning](https://semver.org/) from the first npm release.

Each release opens with a short summary. The list under it has one line per change,
grouped by area, with links to the docs for the details.

## [0.1.2] - Unreleased

coding.sh runs on Windows, and CI tests it there.

### Added

- **Install.** Windows: run the installer from Git Bash. Hook commands use `C:/…` paths that cmd.exe, PowerShell and Git Bash all run. CI runs the tests and the installer on Windows. [Install guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/install.md#windows).
- **Capture.** CI runs real OpenCode, Pi, Goose, Factory Droid, GitHub Copilot CLI and Aider sessions on Linux and Windows against a stub model, checks the recorded prompt, tool call, file change, model and reply, and checks that `ingest --backfill` adds no duplicates. [Install guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/install.md#windows).
- **Gateways.** OpenRouter, LiteLLM, Cloudflare AI Gateway, Portkey, Helicone and Ramp Router (router.com) join Vercel: sessions get a `gateway:<name>` tag, `gateway enrich` fetches billed cost where the gateway has a lookup API, `gateway status` shows one row per gateway, and `compare --gateway <name>` routes runs through it. [AI gateways](https://coding.sh/docs/ai-gateway).
- **SDKs.** The TypeScript and Python SDKs detect all twelve gateways, not only Vercel: by base URL, a self-hosted gateway's URL env var, a response header (`cf-aig-log-id`, `helicone-id`, `x-litellm-call-id`, `x-portkey-trace-id`, …) or the response id. Each model call records the gateway and its request id, so SDK sessions get the `gateway:<name>` tag and `gateway enrich` can fetch their billed cost. The SDK tables are generated from the server's gateway list. [AI gateways](https://coding.sh/docs/ai-gateway#sdk).
- **Experiments.** `exp metrics` A/Bs two commands that print numbers (ms, bytes) in interleaved pairs, with a 95% paired bootstrap CI and a sign test per metric. `--fail-on-worse` exits 1 for CI. [Evals](https://coding.sh/docs/evals#metrics).
- **Capture.** Sessions stored before an adapter's parsing changed are re-parsed from their transcripts and spool in the background, so this release's dedupe fixes reach data already captured. `coding.sh ingest --rebuild` does it now. [Troubleshooting](https://github.com/jackulau/coding.sh/blob/main/docs/troubleshooting.md#old-sessions-show-doubled-counts).
- **Harness A/B.** `compare --gate` answers "ship B or not": `Ship it: B wins 9 tasks, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 3 tasks A solved` with the broken tasks listed. It exits 0 only for "Ship it" (SAGE, arXiv 2609.36043). `--by suite:` gates each tagged suite too, and one broken suite blocks a pooled "Ship it". Each arm's failed runs are split by the agent's own last test run: `A fails 12: own tests green 7 (58%), red 3, stale 1, none 1`, where green fails are silent misses (BOBA, arXiv 2611.02207). `compare --promote` also keeps a B that is cheaper at the same quality: `pareto: support 0.93 ≥ 0.70 → promote (cost-cut: …)` or `→ hold`, exit 0 only on promote (ParetoSaddler, arXiv 2611.02079). When B adds or removes one rule, skill or context file, the report adds a one-item gate scored only on tasks where the item reached the agent's context: `item gate k=3 τ=.34 m=2: KEEP · …`, or RECHECK, KILL, RERUN, and ACCEPT, REJECT, UNMEASURED for removals; `--item-gate` sets the exit code (Cortex, arXiv 2610.14216). CI checks the gate and the own-tests split on real Claude Code and Codex sessions against a stub model. The MCP `harness_compare` tool lists these A/B results and returns one with its gates and own-tests split. [Compare agents](https://github.com/jackulau/coding.sh/blob/main/docs/how-to/compare-agents.md#ship-it-or-not).
- **Experiments.** `exp compare --gate` gives the same ship-or-hold answer per case and exits 1 unless it is "Ship it". `exp sweep` ends with `adopt <winner>` or `keep <start>` and the reason. The MCP `experiment_compare` tool returns the gate too. With 2+ trials, `exp compare` also lists the cases B gained and lost (passed in any trial), counts cases that got more or less reliable, and warns when the two halves of the trials disagree; `--matrix` prints the success counts (EvoAudit, arXiv 2611.07624). [Evals](https://coding.sh/docs/evals#compare).
- **Durable workflows.** A Vercel Workflow or Temporal run is one session across processes, traces, crashes and deploys (keyed by run id). `show`, `workflows show` and the viewer list each step with its attempts, failed and lost ones included, show sleeps as waiting rather than work, mark where the run resumed after a crash, deploy or restart, and leave replayed model calls out of tokens. New flags `step-retried` and `resumed`. Inngest, Restate, DBOS and LangGraph are read from their documented attributes. [Trace a durable workflow](https://coding.sh/docs/how-to/trace-durable-workflow).
- **Viewer.** Cost shows in the session list, the session header and on each model call. Estimates read `~$0.04` (hover: "Estimated from list prices", and which price a call used); billed and reported costs have no mark; a call with no price shows `—` and says why.
- **Judges.** Judge prompts escape data tags in the judged text and say it is untrusted, so an output can't close `</output>` and order a pass. `judge calibrate --probe-injection judge.json` plants a "respond pass" order in human-fail cases and reports how many verdicts flip; any flip exits 1. Default-prompt judges get new version ids. [Evals](https://coding.sh/docs/evals#calibration).
- **Judges.** Checklist items can grade rule compliance from the trace with no model call: `ran-command`, `read-path`, `wrote-identifier`, and `follows-rules`, which checks every imperative line that names a backticked command, flag, path or identifier (``Never use `git push --force` ``) against what the agent did. [Evals guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#checklists-and-trace-checks).
- **Cost.** Estimates price each model call at the rates it ran at: long-context rates past the model's threshold (OpenAI over 272K, Gemini Pro and Claude Sonnet 4.5 1M over 200K, Haiku 5.5 over 100K), and batch, flex, priority, fast or Claude fast-mode rates from the call's recorded service tier. The call's `payload.priceTier` says which, and shows in `show` and the viewer's cost tooltip. `usage --json` adds `estimatedCostByTier`. `[prices]` takes `long_context` and tier tables. Claude 1-hour cache writes are priced at 2x input instead of 1.25x, from Claude Code's `cache_creation.ephemeral_1h_input_tokens` and OpenTelemetry `cache_creation_1h_tokens`, and Claude 4.6+ calls with `inference_geo: "us"` at 1.1x (`[prices]` takes `cache_write_1h` and a `geo` table). Stored estimates reprice by themselves. [Where cost comes from](https://github.com/jackulau/coding.sh/blob/main/docs/how-to/expensive-sessions.md#where-cost-comes-from).
- **Judges.** `judge calibrate --grader tests` audits a test or command verifier: `--sample-passes 40` lists unlabelled passing cases to label, and the audit reports precision (how many passes a person would accept) with a Wilson interval and the false accepts. `exp show` and `exp compare` then print the precision and a pass rate corrected for it. [Evals guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#auditing-a-test-verifier).
- **Workflows.** `workflows compare` checks replay experiments for a control fork. When the candidate resumes from recorded runs (`resumeFromRunId`) and no baseline run resumes from the same ones, it notes "no control fork", since the difference would mix the edit with the replay itself. With a control, it reports how often the control's outcome changed from its source run as the replay noise floor (`control.drift` in `--json`). [Workflows guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#workflows).
- **Production.** `coding.sh-store-clickhouse` runs serve, the CLI and MCP on ClickHouse: `--store 'clickhouse://user:pass@host:8123/db'` (`clickhouses://` for TLS). It has no runtime dependencies and passes the store conformance suite; blobs stay on `file://` or S3. The same page shows how to send sessions to an OpenTelemetry Collector that writes to ClickHouse, with SQL for cost, slow tools and failed sessions. [Self-host for a team](https://github.com/jackulau/coding.sh/blob/main/docs/how-to/self-host-team.md#clickhouse).
- **Evals.** `eval validate` flags hidden tests that name a helper or file only the reference adds and the instruction never mentions, which fail valid fixes written differently (`--strict-coupling` makes it blocking). `eval crosscheck <task>` has a reviewer model judge stored runs' diffs against the instruction and lists the runs where it disagrees with the verifier, as false rejects or false accepts. `--solver <bundle>` solves the task once first. The counts are stored on the task in the same shape as a human verifier audit. [Evals guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#session-to-eval)
- **Experiments.** Long runs survive interruptions. `exp run`, `exp aa`, `exp sweep`, `compare`, `bench run` and `workflows run` save each trial as it finishes, and `--resume [<id>]` re-runs only the unfinished ones, with the same seed, order and `--stop-early` decision as an uninterrupted run. A changed config refuses to resume and names what changed. The first Ctrl-C lets trials in flight finish. Rate limits, 5xx and network errors are retried with backoff (`--retries`, default 3), task failures never are. `--trial-timeout` caps a trial, and `exp status` shows progress, ETA and cost so far. [Evals guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#long-runs-resume-retries-status).
- **Judges.** `follows-rules` reads rule-file frontmatter: a Claude Code rule with `paths:`, a Cursor rule with `globs:` (or neither glob nor `alwaysApply`), or a Copilot rule with `applyTo:` is graded only after the agent touches a matching file or opens the rule. Before that the agent never saw it, so it no longer counts as skipped. [Evals guide](https://github.com/jackulau/coding.sh/blob/main/docs/guides/evals.md#checklists-and-trace-checks)
- **Docs.** A Workflow experiments page: capture and score multi-agent runs, `workflows compare`, replays, the control fork and the replay noise floor. [Workflow experiments](https://coding.sh/docs/workflows)
- **Site.** Pages are ready about 0.5 s sooner on a slow phone, with half the font bytes and less layout shift. A Lighthouse A/B with budgets runs on every site change. [Site speed](https://coding.sh/docs/perf).

### Fixed

- **Viewer.** API sessions with a failed request are red in the session list again, with the reason: `1 failed request (429)`, the first error on hover. Sessions carry `stats.llmErrors`, counted at ingest (existing indexes are filled in on upgrade), and a list page costs the same store queries at any length.
- **Viewer.** The top bar fits from 320px up: between 641 and 820px search folds to its icon instead of squeezing the theme button, and every top bar control has a 44px hit area.
- **Windows.** `coding.sh update` and the MCP launcher run npm and `coding.sh` without a shell, so paths with spaces or `&` arrive intact.
- **Windows.** Goose's config is found under `%APPDATA%\Block\goose\config`, where Goose keeps it on Windows. Eval runs find agent binaries on PATH (Windows spells it `Path`), and Amp and Pi hooks use the `node` on PATH, as elsewhere, instead of the one that ran `init`.
- **Aider.** Eval runs pass `--no-show-release-notes`: on a new version's first run, `--yes-always` made aider open its release notes in a browser.
- **Codex.** Code mode: a command run inside an `exec` cell now points at the cell, the cell fails when a command in it fails, and session stats count each command once instead of twice (hooks and backfill agree).
- **Viewer.** A big ingest no longer blanks reads: `coding.sh ui` opens at once (0.3 s, was 41 s on a 25k-line spool) and indexes in a background worker with an "Indexing N files…" pill, and `status`, `sessions` and `search` answer within 1.5 s, noting what is still pending (`--fresh` waits). [CLI reference](https://github.com/jackulau/coding.sh/blob/main/docs/reference/cli.md).
- **Capture.** A full ingest of a 25k-line spool takes 4 s instead of 294 s on macOS, and 39 s instead of 153 s on Linux: blobs are made durable once per checkpoint instead of with two fsyncs per line, and each checkpoint commits its events, session rows and spool cursors in one transaction, so a crash mid-drain neither loses nor duplicates events.
- **Cost.** `coding.sh collector` prices model calls with tokens and no cost, as `serve` and `ingest` do, using your `[prices]`.
- **Viewer.** The top bar fits a 360px phone.
- **MCP.** Tool calls no longer wait for a big ingest: they answer within 1.5 s from what is indexed, with `pending: {files, indexing}` in the result. [CLI reference](https://github.com/jackulau/coding.sh/blob/main/docs/reference/cli.md#codingsh-mcp).
- **CLI.** `status`, `sessions` and `search` with `--json` carry `"pending": {"files", "indexing"}` while captures are still waiting, instead of dropping the note. [CLI reference](https://github.com/jackulau/coding.sh/blob/main/docs/reference/cli.md#codingsh-status).

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
- **Capture.** A Claude Code or Codex compaction seen by hooks and by `ingest --backfill` is stored once; Codex transcripts no longer record each compaction twice.
- **Capture.** Cursor prompts and replies seen by hooks and by `ingest --backfill` are stored once, though Cursor transcripts carry no timestamps.
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
- **Cost.** Calls with tokens and no cost get one from a dated price table (Claude, OpenAI, Gemini, open models), marked estimated; billed and reported costs win. [Where cost comes from](https://github.com/jackulau/coding.sh/blob/main/docs/how-to/expensive-sessions.md#where-cost-comes-from).
- **Cost.** `[prices."<model>"]` in config.toml sets your own rates; `usage --reprice` recomputes stored estimates.
- **Cost.** A model call nested in another, or a repeated response id, counts once in session totals.
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

[0.1.2]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.2
[0.1.1]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.1
[0.1.0]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.0
