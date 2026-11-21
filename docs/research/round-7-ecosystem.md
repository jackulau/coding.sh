# Round 7 ecosystem notes

Scout: ecosystem. Window: 2026-11-21 (after the round 6 notes) to 2026-11-21 18:49 UTC, plus
older changes that round 6 did not cover. Baseline: [round-6-ecosystem.md](round-6-ecosystem.md).
Competitor gaps CG-1 to CG-13 belong to the other scout. None of the candidates here covers one of
them.

## Method

- Read each agent's GitHub releases and the pull requests merged since 2026-11-20 with
  `gh api`. Read npm `dist-tags` for opencode-ai, droid, @github/copilot and the Amp CLI.
- Read the Claude Code changelog
  (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) and the Code Mode
  page (https://code.claude.com/docs/en/code-mode).
- Read Pi's session format, message types and codemode docs
  (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md,
  https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/message-types.md,
  https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/codemode.md).
- Read Codex's MCP call telemetry
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/mcp_tool_call/telemetry.rs).
- Read the OpenInference decision span spec
  (https://github.com/Arize-ai/openinference/blob/main/spec/decision_spans.md).
- Compared each change with `docs/ADAPTERS.md` and the source under `packages/coding.sh/src`.
  I kept one downloaded changelog in a scratch folder outside the repo and deleted it afterwards.

## Round 6 candidates: status

| # | Candidate | Status |
|---|---|---|
| R6-15 | OpenCode 2.x message and part shapes | open. `convertStoredSession` in `src/adapters/opencode.ts` still reads 1.x names |
| R6-6 | Leading-dash instruction files | open |
| R6-10 | Reasoning effort per call | open. `src/adapters/_shared/claude-transcript.ts` reads no `effort` |
| R6-17 | OTLP sink semconv | open. `src/sinks/otlp.ts` still writes schema URL 1.37.0 |
| R6-25 | T3 Code multi-repo task folders | open. No adapter reads `task_folders` |
| R6-14 | `pasted_content` titles | open |
| - | Receiver semconv v0.1.0 | built in 0be451ca |
| - | Pi aborted turns, Gemini cancelled turns | built in 79d952ae |

## Agents

### Claude Code

- v2.1.330 (2026-11-20) is the newest release
  (https://github.com/anthropics/claude-code/releases/tag/v2.1.330). npm `stable` is 2.1.323.
- The 2.1.330 fixes are a `--resume` crash on a missing timestamp, fast mode billing and Code
  Mode fixes. Our transcript reader already falls back to the last timestamp. Fast mode is already
  priced in `src/core/pricing.ts`.
- Code Mode is an opt-in, set with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`. It needs v2.1.323 or
  later (https://code.claude.com/docs/en/code-mode). Claude writes JavaScript that a tool named
  `REPL` runs. The tool input is `tool_input.code`. The result has `code`, `result`, `stdout`,
  `stderr`, `toolsUsed`, and sometimes `error` and `refusedCalls`.
- Shell commands in Code Mode are tagged templates such as ``$`npm test` ``. Edits are calls such
  as `edit(path, old, new)`.
- `PreToolUse` hooks fire for each nested call under its usual name, such as `Bash`, so the hook
  path sees nested calls. A transcript-only import sees the `REPL` call.
- `src/core/cells.ts` reads shell commands from REPL cells. It knows `bash(...)`, `subprocess.*`
  and IPython `!` lines, but not ``$`...` ``. A Code Mode cell that runs the tests does not count
  as verification on the transcript path.
- Code Mode refuses to start while OpenTelemetry export is on, so OTel-only capture never sees it.
- I did not record a Code Mode transcript. Whether the nested calls also appear as their own
  transcript entries is not verified.

### Codex

- rust-v0.173.0-alpha.4 (2026-11-21, https://github.com/openai/codex/releases).
- #62888 (ToolCallId) and #62898 (ConversationItemId,
  https://github.com/openai/codex/pull/62898) are type refactors. The serialized rollout does not
  change.
- #62589 (2026-11-19) removes `mcp_attribution` from rollouts and adds `model_search_state`.
  `src/adapters/codex.ts` reads neither.
- #62092 lets compression skip recent rollouts. We already read `.zst` rollouts.
- #62833 (merged 2026-11-20) adds an OTel span `mcp.tools.call` for each MCP tool call
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/mcp_tool_call/telemetry.rs).
  Its attributes:
  - `rpc.system=jsonrpc` and `rpc.method=tools/call`;
  - `mcp.server.name` and `mcp.transport`;
  - `tool.name` and `tool.call_id`;
  - `conversation.id`, `session.id` and `turn.id`;
  - `error.type`, `codex.mcp.error.code`, `rpc.jsonrpc.error_code`;
  - `codex.mcp.call.outcome`, one of ok, error and interrupted.
  It sets no `gen_ai.operation.name`.
- `classifySpan` in `src/otel/map.ts` still files this span as a tool, because `tool.name` is set.
  But the tool mapping reads the call id only from `gen_ai.tool.call.id`, `ai.toolCall.id`,
  `tool.id`, `tool_call.id` and `tool_use_id`, so it misses `tool.call_id`. It does not read the
  server name or the outcome. An interrupted or failed MCP call from Codex OTel looks like a plain
  success under the bare tool name.
- #62903 (https://github.com/openai/codex/pull/62903) runs reasoning summaries concurrently.
  Watch for a change in event order.

### OpenCode

- npm `latest` is still 1.19.6. v2.3.2 shipped on 2026-11-18
  (https://github.com/anomalyco/opencode/releases).
- #64784 (2026-11-21) promoted dev to production.
- #65193 (2026-11-21) rewrites a top-level Code Mode tool call to `execute`.
- #64324 gives each Code Mode nested call its own ID in plugin hooks.
- `full_codemode` is dev only (#64515, #65208).
- #65296 replaces the automations flag with a config key. #65300 adds session full-text search in
  dev builds.
- None of this changes the 1.x storage our adapter reads. The 2.x shapes stay R6-15.

### T3 Code

- Nightly v0.1.12-nightly.20261121.5051 (https://github.com/pingdotgg/t3code). There is no
  migration after 105.
- #40220 reports ACP context usage after a turn ends. No change to the store we read was found.

### Pi

- v1.6.0 (2026-11-20, https://github.com/earendil-works/pi/releases).
- Later PRs: #12358 (https://github.com/earendil-works/pi/pull/12358) records cache tokens for the
  Decisions API, #12335 adds decision classifiers and #12360
  (https://github.com/earendil-works/pi/pull/12360).
- Pi records usage in four places besides assistant messages. PR #6671 (2026-07-20) added them,
  and the session format doc lists them:
  - a `usage` entry: `{type: "usage", kind, provider, model, usage}`. `kind` is for example
    `cache_warm`;
  - `usage` on a `compaction` entry;
  - `usage` on a `branch_summary` entry;
  - `usage` on a tool result message, for model work a tool did, such as a classifier call or
    image generation.
- `src/adapters/more/pi.ts` (parseVersion 5) handles `session`, `model_change`, `compaction`
  (without its usage) and `message`. It does not read `usage` or `branch_summary` entries. It
  reads usage only from assistant messages. A Pi session's cost is too low when it warmed the
  cache, compacted, summarized a branch, or ran a classifier.
- A tool result also records `nestedCalls: {calls: [{id, name, arguments?, argumentsBytes?,
  status, durationMs?, error?}], complete}` when the opt-in codemode extension runs. `status` is
  ok, error or unfinished. The adapter reads none of it, so a codemode step shows as one tool
  call.

### Gemini CLI, Copilot CLI, Droid, Goose, Aider, Amp, Cursor

- Gemini CLI: v0.70.0 stable, 0.71.0-preview.0, and a nightly from 2026-11-21
  (https://github.com/google-gemini/gemini-cli/releases). #30389 changes the order of resumed
  messages and a fix handles Windows tilde paths. No format change.
- Copilot CLI: 1.0.114 stable and the 1.0.115-5 prerelease. The changelog has no new entry
  (https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md).
- Droid: 1.17.0 and 1.17.1 (2026-11-21). The CLI changelog lists v1.16.0 (2026-11-20) with a
  metrics name prefix for org collectors (https://docs.factory.com/changelog/cli-updates). There
  is no hook change.
- Goose v1.60.2 (https://github.com/aaif-goose/goose/releases) and Aider v0.86.0: no change.
- Amp: a new npm build on 2026-11-21. No public changelog entry.
- Cursor: no entry in the window (https://cursor.com/changelog).

## Specs

### OpenTelemetry GenAI

- v0.1.0 (2026-11-21,
  https://github.com/open-telemetry/semantic-conventions-genai/releases/tag/v0.1.0). #707 makes
  `gen_ai.provider.name` Conditionally Required on `invoke_agent`.
- The transcript fallback chat spans in `src/sinks/otlp.ts` set no `gen_ai.provider.name`. This
  adds to R6-17.
- Open PRs to watch:
  - #443: `gen_ai.usage.cost.amount`, `.currency` and `.source`. The receiver reads only
    `gen_ai.usage.cost`;
  - #718: service tier;
  - #238: agent finish reason;
  - #689: `gen_ai.agent.invocation.root`;
  - #596: decision model conventions;
  - #580 and #535.

### OpenInference

- OpenInference added a DECISION span kind in #3825 (2026-10-01,
  https://github.com/Arize-ai/openinference/pull/3825) and #3900. The OpenAI instrumentors emit it
  (#3967, #3994), and so does the AI SDK one (#4005). Its attributes:
  - `decision.model_name`, `decision.request.model_name` and `decision.response.model_name`;
  - `decision.system` and `decision.provider`;
  - `decision.token_count.input` and `decision.token_count.output`.
- `classifySpan` in `src/otel/map.ts` returns "other" for DECISION. These calls cost money and
  carry tokens, but the receiver drops them.

### OpenAI Decisions API

- OpenAI's `POST /v1/decisions` returns a choice from a fixed set, not text. The public beta began
  on 2026-10-06 and it reached general availability on 2026-10-22
  (https://grantry.ai/blog/openai-decisions-api-ga-2026/). It runs on `gpt-6-luna`.
- Input costs $0.10 per million tokens and output is free.
- The cached input price differs by source. Grantry gives $0.01 per million. Pi #12358 prices
  cache reads at the input rate.
- `src/core/pricing.ts` prices `gpt-6-luna` as a text model, with output at $0.50 per million.
- `src/proxy/wire.ts` does not route `/v1/decisions`, so the proxy files it under "other" and
  does not count its usage.

### MCP

- No new spec. 2026-07-28 is current.
- SEP-3415, Events, was registered on 2026-11-20
  (https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3568).
- The release cycle blog post (#3541, 2026-11-11) and SEP-3398
  (https://modelcontextprotocol.io/seps/3398-release-cycle-updates) set the next spec for
  2027-03-30, then one every six months.

## Competitors

- Langfuse v4.83.0 (https://github.com/langfuse/langfuse/releases). The later PRs are budget
  warnings (#20605, https://github.com/langfuse/langfuse/pull/20605), billable units (#20597,
  #20598) and gateway costs marked as calculated (#20578). All of these are CG-3 work.
- Arize Phoenix v22.0.0 (2026-11-20,
  https://github.com/Arize-ai/phoenix/compare/arize-phoenix-v21.3.0...arize-phoenix-v22.0.0)
  prices DECISION and EMBEDDING spans (#17764, https://github.com/Arize-ai/phoenix/issues/17764).
  This is the one competitor change that sits outside CG-1 to CG-13. It backs candidates 3 and 4.
- LangSmith Claude Code plugin 0.7.0
  (https://github.com/langchain-ai/langsmith-claude-code-plugins/releases/tag/0.7.0) and the
  Braintrust plugin v3.0.6: nothing new for us.
- Magpie v0.1.4656 (https://github.com/yetone/magpie): no change that touches our formats.
- Harbor v0.27.0 and SDK 0.3.0
  (https://github.com/harbor-framework/harbor/releases/tag/v0.27.0): no adapter change.
- W&B Weave v0.54.1, judgeval v1.9.3, git-ai v1.7.6 and Entire nightly 0.13.5: no change.

## Candidates

1. Pi usage outside assistant messages counts toward session cost (`src/adapters/more`).
2. Pi codemode nested calls become tool steps (`src/adapters/more`).
3. The OTel receiver turns OpenInference DECISION spans into model calls (`src/otel`).
4. A Decisions price tier with free output (`src/core`).
5. The proxy records `/v1/decisions` calls (`src/proxy`).
6. The receiver reads Codex `mcp.tools.call` spans: call id, server, outcome (`src/otel`).
7. Claude Code Code Mode cells: ``$`cmd` `` counts as a shell command (`src/core`).
8. The OTLP sink sets `gen_ai.provider.name` on transcript chat spans. This extends R6-17
   (`src/sinks`).

## Watch list

- OpenCode Code Mode: the `execute` rewrite (#65193), nested call IDs in hooks (#64324) and
  `full_codemode`.
- Claude Code Code Mode transcript shape. Record one with `scripts/e2e` before changing the
  transcript reader.
- Codex concurrent reasoning summaries (#62903).
- Copilot CLI 1.0.115 storage.
- MCP SEP-3415 Events.
- semconv #443, #596, #718, #238 and #689.
- T3 Code #40220.
- Droid metrics name prefix.
