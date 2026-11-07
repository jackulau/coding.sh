# Round 1 ecosystem scan (2026-11-06)

Scout: "ecosystem". Question: what changed upstream (agent CLIs, MCP, OTel GenAI semconv,
competitors) that breaks or improves coding.sh, measured against `docs/ADAPTERS.md` (verified
2026-11-06) and the current source in `packages/coding.sh/src`.

**How this was checked**

- Release data comes from GitHub releases via `gh api repos/<owner>/<repo>/releases` (dates are
  `published_at`, UTC), from the official changelog pages linked below, and from PR bodies read
  with `gh api repos/<owner>/<repo>/pulls/<n>`.
- Every claim marked **code** was checked against the coding.sh source with grep. Every claim
  marked **(secondary)** comes from a blog or aggregator and was not confirmed upstream.
- ADAPTERS.md is already very current. Items that ADAPTERS.md or the adapters already handle are
  listed under "Already handled" so nobody re-does them.

## 1. Findings that need code changes

### 1.1 Codex compresses rollouts older than 7 days to `.jsonl.zst` (breaks backfill)

- Codex rust-v0.164.0 (2026-10-23) shipped rollout compression:
  <https://github.com/openai/codex/releases/tag/rust-v0.164.0>.
  - PR #54008 (merged 2026-10-14): "Compression replaces `.jsonl` rollout files with `.jsonl.zst`
    files" <https://github.com/openai/codex/pull/54008>.
  - PR #53997: plain `.jsonl` is preferred when both exist <https://github.com/openai/codex/pull/53997>.
  - `codex-rs/rollout/src/compression.rs`: `COMPRESSED_SUFFIX = ".zst"`, `COMPRESSION_LEVEL = 3`,
    `MIN_ROLLOUT_AGE = 7 days`. A compressed rollout is decompressed back to `.jsonl` before an
    append (resume).
- **code:** `src/adapters/codex.ts` backfill matches `/^rollout-.*\.jsonl$/`, so every Codex session
  older than a week is invisible to `backfill`. Node >= 22.15 ships `zlib.zstdDecompressSync` and
  `zlib.createZstdDecompress` (checked on the local Node 22.19). `src/store/fs-blobs.ts` already uses
  zstd.

### 1.2 OTel GenAI semconv: token totals now include cached and reasoning tokens (double counting)

- The GenAI conventions left the core repo in semantic-conventions v1.42.0 (2026-06-12) and now live
  in <https://github.com/open-telemetry/semantic-conventions-genai> (no tagged releases; everything
  is "Development"). Summary with dates: <https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/>.
- Registry text, <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md>:
  - `gen_ai.usage.input_tokens`: "This value SHOULD include cached tokens".
  - `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_write.input_tokens`: "SHOULD be
    included in `gen_ai.usage.input_tokens`".
  - `gen_ai.usage.output_tokens`: "SHOULD include reasoning tokens". New
    `gen_ai.usage.reasoning.output_tokens` is a subset.
  - `gen_ai.usage.cache_creation.input_tokens` was renamed to `cache_write` (2025-08-20).
- **code (ingest):** coding.sh's internal convention is Anthropic-style. `Usage.inputTokens` is the
  uncached part (`src/adapters/_shared/normalize.ts` `openaiUsage` subtracts cached tokens).
  `src/otel/map.ts` `usageOf()` copies `gen_ai.usage.input_tokens` (and OpenInference
  `llm.token_count.prompt` and AI SDK `ai.usage.inputTokens`, also cache-inclusive) straight into
  `inputTokens` and *also* sets `cacheReadTokens`. `test/otel/map.test.ts:44` asserts
  `{inputTokens:120, cacheReadTokens:20}` for a span whose input total is 120, so the session total
  reads 140 instead of 120 and cost estimates come out inflated.
- **code (export):** `src/sinks/otlp.ts` `usageAttrs()` writes `gen_ai.usage.input_tokens =
  inputTokens` (uncached only, so it under-reports by the cache) and still uses the deprecated
  `gen_ai.usage.cache_creation.input_tokens`.
- Other semconv additions that coding.sh does not map yet:
  - `gen_ai.skill.name`, `gen_ai.skill.source.uri`, `gen_ai.skill.script.exit_code` on
    `execute_tool load_skill` spans (PR #498, merged 2026-09-29)
    <https://github.com/open-telemetry/semantic-conventions-genai/pull/498>.
  - Agent transfer refinement `gen_ai.execute_tool.transfer.*` (PR #447, merged 2026-10-26).
  - `gen_ai.main_agent` resource entity (`gen_ai.main_agent.id/name/description`, PR #270, merged
    2026-09-30).
  - `gen_ai.conversation.compacted` (boolean, only ever `true`).
  - New operation names: `invoke_workflow`, `invoke_runner`, `plan`, `retrieval`, memory ops.
  - The `gen_ai.evaluation.result` event (`gen_ai.evaluation.name`, `.score.value`, `.score.label`,
    `.explanation`, parented to the evaluated span or correlated by `gen_ai.response.id`)
    <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md>.
  - `gen_ai.tool.call.id` is conditionally required only when the provider supplied it (PR #525).
- Weave 0.53.13 (2026-10-22) switched to "current OTel GenAI attribute names" (wandb/weave#8045),
  so cache-inclusive totals are arriving from real exporters now.

### 1.3 Cursor CLI moved subagent transcripts under the parent (backfill mislinks them)

- Cursor CLI changelog <https://cursor.com/docs/cli/changelog>, v2026.10.17:
  - Subagent transcripts are saved at `agent-transcripts/<parent>/subagents/`.
  - Hooks inside a subagent receive that file as `transcript_path` and `CURSOR_TRANSCRIPT_PATH`.
  - `postToolUse`/`postToolUseFailure` matching `Task` now fire when a subagent finishes or fails.
- v2026.10.22: a subagent whose pinned model can't run falls back to the parent's model.
- Hooks doc <https://cursor.com/docs/agent/hooks>: `model` is "legacy model slug". Optional
  `model_id` and `model_params` are now common fields.
- **code:** `src/adapters/cursor.ts` backfill walks `agent-transcripts` with `maxDepth: 4` and sets
  `sessionId = basename(file)`, so a subagent file becomes an orphan top-level session with no
  parent link. `model_id` is never read. The fixtures have no `subagents/` directory.

### 1.4 Copilot CLI hooks carry W3C trace context

- Copilot CLI v1.0.81 (2026-08-27) <https://github.com/github/copilot-cli/releases/tag/v1.0.81>:
  "Hooks can now receive the current OpenTelemetry trace context". Hook inputs gain `traceparent`
  (plus `tracestate` when present), and command hooks also get them as env vars. Hook lifecycle
  events from subagent hooks are now kept on the subagent session and re-emitted on the parent.
- Copilot CLI 1.0.106 line (2026-11-01 to 11-06) <https://github.com/github/copilot-cli/releases>:
  - `COPILOT_HOOK_DEPTH` env for command hooks.
  - JSON output now includes compaction and truncation events and no longer writes 8-bit control
    characters.
  - Hook files with a UTF-8 BOM are accepted.
  - `modifiedArgs: null` no longer fails a tool call.
- **code:** no adapter reads `traceparent`. `AgentEvent` already has `traceId`, `spanId` and
  `parentSpanId`, and `src/otel/map.ts` keeps a `TraceSessionMap`, so hook events and OTLP spans
  from the same Copilot run could be joined by trace id.

### 1.5 Claude Code headless runs accept inbound trace context

- Monitoring docs <https://code.claude.com/docs/en/monitoring-usage>:
  - "in Agent SDK and `claude -p` sessions, Claude Code reads `TRACEPARENT` and `TRACESTATE` from
    its environment" (interactive sessions ignore it).
  - Bash and PowerShell subprocesses inherit `TRACEPARENT` from the active tool span.
  - `OTEL_*` variables are not forwarded to hooks, MCP servers or Bash.
  - Beta spans: `claude_code.interaction`, `.llm_request` (with `ttft_ms`, `stop_reason`, `attempt`),
    `.tool`, `.tool.execution`, `.tool.blocked_on_user`, and `.hook` (detailed beta only).
- Changelog <https://code.claude.com/docs/en/changelog>:
  - 2.1.317 (2026-11-03) added `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider` and
    `anthropic.custom_base_url` to OTel metrics, events and spans.
  - 2.1.312 (2026-10-27) stopped sending `claude_code.safety_event`.
- **code:** `src/runner/run.ts` sets `CODING_SH_RUN_ID` only. The receiver docstring says "Tag eval
  runs with OTEL_RESOURCE_ATTRIBUTES=coding_sh.run_id=<id>", and `map.ts` reads `coding_sh.run_id`,
  but nothing sets either automatically. `startReceiver({port: 0})` already supports an ephemeral
  port.

### 1.6 Harbor: ATIF trajectories and task schema 1.4

- Harbor v0.25.0 (2026-10-25) <https://github.com/harbor-framework/harbor/releases/tag/v0.25.0>:
  - `harbor lint` (#3674), with rules configurable in `[metadata.harbor.lint]`.
  - Separate verifier is the default for new tasks (#3712).
  - Stale reward files are removed before verification (#3692).
  - Kimi Code now emits ATIF.
  - Releases v0.21 to v0.25 came out between 2026-08-10 and 2026-10-25.
- ATIF (Agent Trajectory Interchange Format), current `ATIF-v1.8`:
  <https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md>.
  - Root: `schema_version`, `session_id?`, `trajectory_id?`, `agent{name,version,model_name?}`,
    `steps[]`, `final_metrics?`, `subagent_trajectories?`, `extra?`.
  - Step: `step_id` (1-based, sequential), `source` (`system|user|agent`), `message`, `timestamp?`,
    `model_name?`, `reasoning_content?`, `tool_calls[{tool_call_id,function_name,arguments}]`,
    `observation{results[{source_call_id,content}]}`, `metrics{prompt_tokens (cache-inclusive),
    completion_tokens, cached_tokens, cost_usd, extra}`, `llm_call_count?`.
  - v1.7 added embedded subagents and per-document `trajectory_id`.
  - Harbor's viewer reads `agent/trajectory.json`. Validator:
    `python -m harbor.utils.trajectory_validator`. A `harbor-atif2otel` package exists in the repo.
- Task config <https://github.com/harbor-framework/harbor/blob/main/docs-mintlify/tasks/configuration.mdx>:
  - `schema_version = "1.4"`. Legacy top-level `version` is still accepted via
    `handle_version_rename` in `src/harbor/models/task/config.py`.
  - `[verifier] environment_mode = "shared"|"separate"`.
  - Rewards in `/logs/verifier/reward.txt` or `reward.json` (multi-metric; JSON wins).
- **code:** `src/eval/task.ts` `exportHarbor` writes `version = "1.0"`, relies on implicit shared
  verification (its `cp -R /tests/files/. /app/` breaks under a separate verifier), and has no ATIF
  output. Phoenix client 3.6 and 3.7 (2026-10-30, 2026-11-05) added Harbor experiment
  integration, so ATIF is becoming the exchange format.

### 1.7 Skill loads are becoming a first-class signal

- Langfuse v4.75.0 (2026-11-04) <https://github.com/langfuse/langfuse/releases/tag/v4.75.0>: "trace
  Codex skill resource loads" (#19586). Codex tool calls that `cat` skill files produce skill
  resource loads, using a shared argument parser that recognizes literal `cat` args, stops at
  command boundaries and rejects traversal.
- OTel semconv PR #498 (2026-09-29) models a skill load as `execute_tool load_skill` with
  `gen_ai.skill.name` and `gen_ai.skill.source.uri`.
- **code:** `src/adapters/_shared/tools.ts` classifies shell, edit and patch tools but not skill
  loads. For a harness lab whose bundles ship skills, "did the agent load the skill under test?"
  is a primary metric.

## 2. Already handled (no action)

- **Gemini CLI `$patch` delta records:** v0.64.0 (2026-10-13), PR google-gemini/gemini-cli#29568.
  `src/adapters/more/gemini-cli.ts` already replays `$set`, `$rewindTo` and `$patch`.
- **Gemini hook timeout units:** v0.67.0 (2026-11-04) fixed "convert Claude hook timeout from seconds
  to milliseconds during migration" (#29899). Our gemini adapter writes `timeout: 5000` (ms).
  Correct.
- **OpenCode tool name:** v2.2.5 (2026-10-30) routes calls to `bash` to `shell`. `SHELL_TOOLS`
  already includes both.
- **OpenCode TUI plugins:** need OpenTUI 0.8 (v2.2.3), which does not affect our server plugin.
  New `plugin.use` managed-policy action (v2.2.3): `doctor` could mention it.
- **MCP 2026-07-28** <https://blog.modelcontextprotocol.io/posts/2026-07-28/>: stateless core,
  `server/discover`, `Mcp-Method` and `Mcp-Name` headers, tasks moved to an extension. Already
  designed into `docs/TOOL-EVALS.md` §5.3 and §10.
- **Claude Code `SubagentStop` firing twice a minute per running subagent:** fixed in 2.1.311
  (2026-10-26). Our keyed event ids dedupe it, but on older versions `subagent.end` can carry the
  time of the first spurious fire.
- **Claude Code 2.1.311 stream-json escapes:** DEL, C1 and format characters are now written as
  `\uXXXX`. Parsed values are unchanged.
- **Codex hooks:** PreToolUse, permission and post-tool hooks now report the command `cwd`
  (rust-v0.166.0, #57198 and #57203, 2026-10-29). Plugin hook approval is bound to plugin contents
  (#54619). Neither changes our install path.

## 3. Watch list (no change yet)

- **Claude Code:**
  - 2.1.319 (2026-11-06) added `permissions.denyInsteadOfPrompting`, which denies instead of hanging
    on a permission prompt. It could be a runner overlay default instead of `bypassPermissions` for
    "safe" runs.
  - 2.1.317 added `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID`, and `claude -p` inside a runner session
    now gets its own session id.
  - 2.1.312 caps prompt and agent hooks at 24 concurrent per session.
  - 2.1.314 cuts PreCompact hook output at 10,000 chars.
- **Codex:**
  - Managed OTel config requirements (#57649, #57658, rust-v0.166.0).
  - Rollout trace changes: tool calls classified by runtime handler (#57194), full MCP results
    preserved (#57280).
  - The rollout schema keeps churning, so re-record fixtures each round.
- **Pi v1.5.0 (2026-11-02):**
  - `Usage.cost.totalFromProvider` separates billed totals from catalog estimates.
  - Session entries carry a `messageId` and an ISO `timestamp`.
  - Failed session writes no longer leave dangling parents (#11460).
- **Goose:**
  - v1.57.0 (2026-10-28) added caller-supplied session ids, but only through the library
    `SessionManager` (#13098), not the CLI.
  - v1.56.0 added resumable delegate subagents and `GOOSE_MAX_CONCURRENT_SUBAGENTS`.
- **Aider:** still v0.86.0 (2025-08-09). Tier C confirmed.
- **Antigravity CLI (`agy`)** replaced the consumer Gemini CLI on 2026-06-18 (secondary:
  <https://amux.io/guides/gemini-cli-to-antigravity-cli/>). Gemini CLI keeps shipping weekly for
  enterprise (v0.67.0, 2026-11-04).
- **Amp:** no plugin API change found for October 2026 (secondary:
  <https://www.havoptic.com/tools/amp>).
- **Factory Droid:** release tracking is unreliable (secondary:
  <https://www.havoptic.com/tools/factory-droid>). Re-verify hooks before the next fixture refresh.

## 4. Competitors

| Product | What shipped | Date | Link | Relevance |
|---|---|---|---|---|
| Judgment Labs | General access for agent behavior monitoring. "Behavior labels" are applied by binary or classification judges with online monitoring, and labels feed search, datasets and automations. | GA 2026-10-27 (secondary); blog 2026-07-08 | <https://judgmentlabs.ai/blogs/behaviors-ai-agent-improvement>, <https://runtimewire.com/article/judgment-labs-general-access-agent-monitoring> | coding.sh has `Label` plus judges. Online judges over captured sessions are the gap. |
| Judgeval SDK | v1.6.0 ports agent judges to `/v1/judges`. | 2026-10-27 | <https://github.com/JudgmentLabs/judgeval/releases/tag/v1.6.0> | — |
| LangSmith | Traces Claude Code, Codex, Cursor, Copilot Chat, Pi, OpenCode and dcode into one schema, with cross-agent compare and save-to-eval. | 2026-07-14 | <https://langchain.com/blog/your-coding-agents-are-a-black-box-heres-how-to-crack-them-open> | Direct overlap with capture. Our differentiators remain replay from snapshot, a validated verifier and harness A/B. |
| Langfuse | v4 Cloud cutover (v3 APIs removed). Codex skill-load tracing (v4.75.0). Chronological session list and Topics in API/MCP (v4.76.0). | cutover 2026-11-16; 2026-11-04; 2026-11-05 | <https://langfuse.com/changelog/2026-08-17-langfuse-v4>, <https://github.com/langfuse/langfuse/releases> | Our `http` sink and OTLP export target Langfuse. Re-test against v4 endpoints after 11-16. |
| Arize Phoenix | DECISION and AGENT annotator kinds (v21.0.0). Harbor experiment integration (client 3.6/3.7). Dataset labels (client 7.18). | 2026-10-30 to 2026-11-05 | <https://github.com/Arize-ai/phoenix/releases> | Harbor/ATIF is the interop point. `Label.by` could carry an annotator kind. |
| W&B Weave | Emits current OTel GenAI names (#8045). Trace server moved to wandb/core. | 2026-10-22, 2026-10-23 | <https://github.com/wandb/weave/releases> | Our OTel ingest sees cache-inclusive totals (see 1.2). |
| Braintrust | Topics (log clustering) GA, pricing changes. No October/November changelog found. | 2026-06 (secondary) | <https://pricingsaas.com/companies/braintrust/diffs/2026W24> | — |
| Entire | v0.13.1: OpenCode 2 support (plugin at `.opencode/plugin/entire.ts`). Codex transcript mapping for current Codex. Token totals include nested Claude subagents. Hooks warn when the binary is on PATH but fails. | 2026-11-06 | <https://github.com/entireio/cli/releases/tag/v0.13.1> | `doctor` should run the installed hook command once (as Entire now does). Check nested subagent totals. |
| git-ai | v1.7.6 (notes still generating). Agent Trace spec at 0.1.0 RFC. | 2026-11-05 | <https://github.com/git-ai-project/git-ai/releases/tag/v1.7.6>, <https://agent-trace.dev/> | — |
| Harbor / Terminal-Bench | v0.25.0: lint, separate verifier default, ATIF-v1.8. | 2026-10-25 | see 1.6 | Export target. |

## 5. Candidate improvements (summary)

The full specs are returned to the orchestrator.

1. `src/otel`: make semconv usage cache-correct, and map reasoning tokens, skill attributes, the
   compaction flag and the main_agent resource.
2. `src/sinks`: OTLP export emits cache-inclusive totals and the `cache_write` name.
3. `src/adapters`: Codex backfill reads `.jsonl.zst` rollouts.
4. `src/adapters`: Cursor subagent transcripts under `<parent>/subagents/`, plus `model_id`.
5. `src/adapters`: Copilot `traceparent` becomes `traceId`/`parentSpanId` on hook events.
6. `src/runner`: per-run OTel wiring (ephemeral receiver, `TRACEPARENT`, `coding_sh.run_id`,
   Claude Code telemetry env).
7. `src/eval`: ATIF-v1.8 trajectory export, and Harbor `task.toml` schema 1.4 with explicit shared
   verifier.
8. `src/adapters`: skill-load detection on `tool.start` (`payload.skill`).
