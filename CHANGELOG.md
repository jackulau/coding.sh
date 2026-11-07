# Changelog

All notable changes to coding.sh are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will
follow [Semantic Versioning](https://semver.org/) from the first npm release.

## [0.1.0] - Unreleased

First public release, pre-1.0. Install with `npm install -g coding.sh && coding.sh init`, or `curl -fsSL https://coding.sh/install | sh`.

### Added

- **Vercel AI Gateway.** Sessions routed through the gateway are tagged `gateway:vercel`. `coding.sh gateway status|enrich` adds billed cost, serving provider, client session join and the resolved `vmc/` model per call. The receiver maps gateway trace drains and AI SDK `gateway` spans. `compare --gateway` and the `gateway` grader provider run arms across models with one key.
- **Install.** `curl -fsSL https://coding.sh/install | sh` checks for Node 22.15+, installs the latest release with npm, runs `coding.sh init` (one plan, one Y/n) and opens the viewer. After that, `coding.sh` with no command opens the viewer; on first run it sets up capture.
- **MCP server.** `coding.sh mcp` lets agents query captured sessions, failures, latency, usage, subagents and experiments over stdio. `coding.sh init` registers it with Claude Code, Codex, Cursor, OpenCode and Gemini CLI (`--no-mcp` to skip). `coding.sh uninstall` restores each config file byte-for-byte if nothing else edited it since.
- **Update alerts.** Commands print one dim line when a newer release is out. The check runs in the background at most once a day; `coding.sh update` installs the release. Off in CI and with `NO_UPDATE_NOTIFIER=1`, `CODING_SH_NO_UPDATE_CHECK=1` or `[update] check = false`.
- **No ingest step.** Read commands, the viewer and the MCP server ingest new hook events first, and the hook starts a background ingest (lock-guarded) when a session ends.
- **Capture.** Hook-based capture for coding agents: prompts, tool calls, file changes, turns and errors, written to a local spool and ingested into sessions. Secrets are redacted before anything is stored.
- **Capture.** `coding.sh run -- <cmd>` wraps any agent and takes shadow-git snapshots of the working tree before and after, without writing to your repository.
- **Adapters.** claude-code, codex, opencode, cursor, gemini-cli, antigravity, copilot-cli, amp, pi, droid, goose, t3code, aider, and the generic wrapper. Each one has fixture tests and an `ingest --backfill` path where the agent keeps history. Claude Code, Codex and Antigravity are verified on real sessions; the rest are fixture-tested so far.
- **T3 Code.** The t3code adapter imports T3 Code threads from its local store. Codex and Claude Code sessions that T3 runs become one t3code session, with the underlying agent in `provider`, instead of being counted twice. `coding.sh usage --by agent-model` compares tokens per turn and cache-read share across harnesses.
- **Subagents.** Subagent starts and ends are captured and linked to their child sessions.
- **OTLP receiver.** `coding.sh collector` accepts OTLP/HTTP traces and logs (protobuf or JSON) on 127.0.0.1:4318. It understands OTel GenAI semconv, OpenInference, the Vercel AI SDK and Claude Code / Codex / Gemini CLI log events.
- **Latency.** Every model call becomes an `llm.call` event with model, token usage, duration and time to first token.
- **Storage.** A single SQLite index (node:sqlite, no native deps) plus a content-addressed, zstd-compressed blob store. OTLP and HTTP sinks are metadata-only by default.
- **Viewer.** `coding.sh ui` serves a local viewer: sessions, search, a timeline of turns, tools and subagents, and outcome labels.
- **Evals.** Repo-replay eval tasks that start from the snapshot taken before the agent ran. `eval validate` checks the verifier: a do-nothing attempt fails, the reference fix passes k of k, near-misses fail, and nothing leaks.
- **Evals.** Datasets with deterministic graders, command graders and LLM judges. Judges are calibrated against human labels with Cohen's kappa on a held-out split; uncalibrated judges are flagged in every report.
- **Experiments.** Run two arms on the same cases and compare them with a paired bootstrap CI of the difference and an exact McNemar test on flipped cases. Harness compare adds per-arm Wilson intervals and the first step where traces diverge.
- **Tool evals.** Evals for CLI and MCP tool surfaces: description size, schema checks, and per-task tool-call metrics against a sandbox.
- **Integrations.** eve: span enrichment, a read-only importer for eve's local traces, and an experiment task that drives a local eve agent.
- **CLI.** `init`, `doctor`, `status`, `ingest`, `run`, `collector`, `uninstall`, `sessions`, `show`, `search`, `usage`, `ui`, `mcp`, `eval`, `dataset`, `exp`, `judge`, `toolevals`, `workflows`, `harness`, `compare`, `gateway`, `gc`, `config`, `update`, `version`, with `--json` output.
- **Docs.** README with a quickstart, the agent matrix, OTLP setup, storage, privacy and uninstall; CONTRIBUTING, SECURITY and a release checklist (docs/RELEASE.md).

[0.1.0]: https://github.com/jackulau/coding.sh/releases/tag/v0.1.0
