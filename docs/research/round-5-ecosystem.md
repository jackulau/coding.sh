# Round 5 ecosystem notes

Scout: ecosystem. Window: 2026-11-20 to 2026-11-21. Baseline: [round-4-ecosystem.md](round-4-ecosystem.md),
which covered releases up to 2026-11-20. Competitor gaps CG-1 to CG-13, listed in the round 4 notes,
are left to the other scout and get no candidate here.

## Method

- Read each agent's GitHub releases with `gh api repos/<org>/<repo>/releases`. For changes not yet
  released, read merged pull requests with
  `gh api search/issues -f q="repo:<repo> is:pr is:merged merged:>=2026-11-19"`.
- Read npm `dist-tags` for agents that ship there (opencode-ai, droid, @github/copilot).
- Read the source of OpenCode's 2.x schema and the GenAI semconv v0.1.0 changelog. I kept
  downloaded copies in a scratch folder outside the repo.
- Compared each change with `docs/ADAPTERS.md` and the adapter source under
  `packages/coding.sh/src/adapters`.

## Round 4 candidates: status

| # | Candidate | Status |
|---|---|---|
| 1 | Cursor subagent parent link | open |
| 2 | Codex PreModelRequest / PostModelRequest hooks | open. `MATCHERLESS` names them, but `CODEX_HOOK_EVENTS` does not register them |
| 3 | T3 Code Antigravity provider | open |
| 4 | OTLP structured tool arguments | done (703300fe) |
| 5 | Claude Code `pasted_content` titles | open |
| 6 | Goose denied calls | open |
| 7 | Gemini cancelled and scheduled calls | open |
| 8 | Claude Code PostToolBatch | open |

## Agents

### OpenCode: 2.x storage is not what the adapter reads

This is the main finding of the round.

- [v1.19.6](https://github.com/anomalyco/opencode/releases/tag/v1.19.6) (2026-11-17, npm `latest`) offers
  users the upgrade to OpenCode 2.0 and keeps their sessions. 2.x ships only as GitHub release
  assets (for example v2.3.2), not on npm.
- [anomalyco/opencode#65039](https://github.com/anomalyco/opencode/pull/65039), merged 2026-11-20
  and not yet released, turns `experimental.part_rows` on by default. Each assistant content part
  then becomes a `session_part` row. Before it, 2.x stored assistant content inline in
  `session_message.data.content`.
- The 2.x shapes, from `packages/schema/src/session-message.ts` and
  `packages/core/src/session/sql.ts`:
  - The `type` column of `session_message` holds the role. `data` has no `type` or `id`.
  - A user message carries its prompt as `data.text`, not as a part.
  - An assistant message has `data.model = {id, providerID, variant?}`, plus `tokens`
    (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), `cost`, `finish`, `error`,
    `time` (`created`, `firstToken`, `streamed`, `completed`) and `content[]`.
  - A tool part is `{type: "tool", id, name, state: {status, input, content[], error, metadata},
    time: {created, ran?, completed?}}`. `status` is one of streaming, running, completed and
    error. `error` is an object, not a string.
  - The columns of `session_part` are message_id, session_id, ordinal, type, call_id, the
    timestamps and data.
- What `src/adapters/opencode.ts` (parseVersion 3) does with this:
  - It reads only `m.parts`, so a user prompt in `data.text` and inline `data.content` are lost.
  - It reads the 1.x names `p.tool`, `state.time.start/end`, `state.output` and
    `data.modelID`/`providerID`. On 2.x rows the tool name comes out "unknown", and the tool
    times, tool output and model are missing.
  - `str(st.error)` drops an error object.
- The test for the v2 path (`test/adapters/opencode.test.ts`, about line 94) builds `session_part`
  rows with 1.x part data, so it passes. The real fixture and the e2e pin
  (`scripts/e2e/real-capture.mjs`, `opencode-ai@1.19.5`) are 1.x. No test has seen a real 2.x
  database.
- Other OpenCode changes: #65076 adds session_search tools, and #65080 renames the Code Mode
  session tools.
- Harbor [v0.27.0](https://github.com/laude-institute/harbor/releases/tag/v0.27.0) (2026-11-21)
  ships an `opencode-v2` agent and a fix for its trajectory conversion (#4382). Other tools are
  already treating 2.x as a separate format.

### Pi

- [v1.6.0](https://github.com/earendil-works/pi/releases/tag/v1.6.0) (2026-11-20), commit 4438c58b,
  closes #9986. When the user presses Esc during a tool batch, each call that has not started gets
  a tool result "Operation aborted" with `isError: true`.
- `src/adapters/more/pi.ts` sets `ok = msg.isError !== true` (line 309, and line 240 on the hook
  path). `INTERRUPT_TEXT` in `src/core/failures.ts` does not match "Operation aborted". Each
  aborted call counts as a real tool error, not in `stats.interruptedToolCalls`, so the
  repeated-tool-failure flag can fire on a user's Esc.
- Also in v1.6.0: a transcript notice when OpenAI drops reasoning items, `pi.exec` exit codes of
  128 plus the signal number, and Copilot reasoning tokens that are no longer always 0.

### Claude Code

- [v2.1.330](https://github.com/anthropics/claude-code/releases/tag/v2.1.330) (2026-11-20). No
  change to hook events or the transcript format.
- `--continue` and `--resume` now handle an entry with a missing or bad timestamp. Our parser
  already falls back to the last timestamp (`toMs(e.timestamp, this.lastTs)`).
- With `bashEditDiffEnabled` off (self-hosted runners), a transcript can lack the file diff of a
  Bash edit. `filesChanged` from shell calls (fold version 24) does not depend on that diff.
- Session files had grown by megabytes from MCP tool schemas the API refused. That is fixed.
- An MCP server is no longer shut down when one subagent finishes.
- Prompt hooks accept model aliases. The max_tokens retry change from 2.1.329 was reverted.

### Codex

- [rust-v0.171.0](https://github.com/openai/codex/releases) (2026-11-20) and 0.173.0-alpha.1 to
  alpha.4 (2026-11-20 and 11-21). Merged pull requests that touch what we read:
  - #62589 removes cumulative MCP attribution (`mcp_attribution`) from requests and rollouts. We
    do not read it.
  - #62567 adds subagent lifecycle telemetry: `codex.multi_agent.spawned` (root_thread_id,
    child_thread_id, parent_turn_id), `codex.multi_agent.turn.lifecycle` (status, turn_kind,
    abort_reason, error_kind) and `codex.multi_agent.stop_accepted`. The receiver links Codex
    subagents today through `parent.conversation.id` on `agent_response`.
  - #62810 adds `estimated_usage_usd_micros` and `native_usage_usd_micros` to ChatGPT turn cost
    telemetry.
  - #62831 adds a per-handler hook setting `onFailure: continue|block`. Our hook exits 0, so the
    default (continue) holds.
  - #62833 puts MCP tool call outcomes in traces. #62898 separates conversation item IDs from
    Responses IDs. #62888 shares one ToolCallId type.
- Round 4 candidate 2 (PreModelRequest and PostModelRequest, from 0.170) is still open.

### T3 Code

- Nightly v0.1.12-nightly.20261121.
- #35925 (2026-11-21) adds projects with several repositories (migrations
  104_ProjectionProjectsTrackedFolders and 105_TaskFolders). A project folder need not be a git
  repository. Watch whether thread cwd still names the repository.
- #40220: ACP keeps context usage after a turn ends. #36643: Codex thread recovery. #40075:
  truncated Claude text stays valid Unicode.

### Other agents

- Gemini CLI: 0.71.0-preview.0 and nightlies. Only #30389 (resume picks the most recently active
  session). No format change.
- Copilot CLI: 1.0.115-2 to -5 prereleases (2026-11-20 and 11-21). "Long-running local sessions
  take up less disk space and resume faster" may change `events.jsonl`; check it when 1.0.115 is
  stable. A sessionEnd hook is skipped when a session closes before its first prompt. Subagent
  events name the fallback model.
- Cursor: nothing after v2026.11.17.
- Amp: nothing on formats after the 2026-11-17 Windows app.
- Droid: npm `droid` went from 1.13.0 to 1.17.0 between 11-17 and 11-21. `docs/ADAPTERS.md` was
  verified on 1.6.0. The changelog site did not resolve from here. Search results say v1.15.0
  (11-19) stops SessionStart hooks from running during shutdown. Worth a re-verify of the adapter.
- Goose: v1.60.2 (11-20), covered in round 4. Aider: no release since v0.86.0.

## Specs

### OpenTelemetry GenAI semantic conventions v0.1.0

[v0.1.0](https://github.com/open-telemetry/semantic-conventions-genai/releases/tag/v0.1.0)
was released on 2026-11-21. It is the first release from the new GenAI repository. Its schema URL
is `https://opentelemetry.io/schemas/semconv-genai-dev/0.1.0-dev`, and it builds on core semconv
1.45.0. Changes that touch coding.sh:

- `invoke_workflow` spans become `gen_ai.invoke_agent.internal` with operation `invoke_workflow`,
  and `gen_ai.workflow.name` becomes `gen_ai.agent.name`. Our receiver (`classifySpan` in
  `src/otel/map.ts`) maps `invoke_workflow` to "other".
- Time to first chunk is now `gen_ai.client.inference.time_to_first_chunk`. `SPAN_TTFT_S` lists
  only `gen_ai.response.time_to_first_chunk` (`src/otel/map.ts:836`).
- On MCP spans, `rpc.response.status_code` becomes `rpc.status_code`. The receiver reads neither.
- The provider name `mistral_ai` becomes `mistral`.
- `cache_creation` becomes `cache_write` in token usage. Both the receiver and the OTLP sink
  already handle this.
- JSON-schema attributes must be structured values on spans; the JSON-string fallback is gone
  (#634). Our sink sends structured tool arguments since 703300fe.
- New: `gen_ai.request.reasoning.level`, a `plan` operation, the `gen_ai.main_agent` entity,
  `gen_ai.conversation.compacted` with a CompactionPart message schema, and the
  `gen_ai.invoke_agent.inference_calls` and `tool_calls` metrics.
- #736 says `gen_ai.usage.*` on spans of different types must not be summed.
- Our OTLP sink still stamps `SEMCONV_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0"`
  (`src/sinks/otlp.ts:27`) on both scope and resource.

### MCP

- No spec release since 2026-07-28.
- SEP-3415, the Events Extension, was merged on 2026-11-19
  ([modelcontextprotocol#3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415))
  and registered on 11-20 (#3568). No agent emits it yet. Watch it.

## Competitors

- Langfuse [v4.83.0](https://github.com/langfuse/langfuse/releases/tag/v4.83.0) (11-19): no
  release since round 4.
- Arize Phoenix [v22.0.0](https://github.com/Arize-ai/phoenix/releases/tag/arize-phoenix-v22.0.0)
  (11-20): cost tracking for decision and embedding spans, model types in the cost manifest, and a
  migration. No new agent feature.
- judgeval v1.9.3 (11-19). W&B Weave v0.54.1 (11-05). git-ai v1.7.6 (11-05). No change since
  round 4.
- Harbor [v0.27.0](https://github.com/laude-institute/harbor/releases/tag/v0.27.0) (11-21):
  interrupted trials are recorded as cancelled (#4212), an `opencode-v2` agent with Code Mode
  (#4207, #4382), and LangGraph writes ATIF trajectories (#4296).
- LangSmith, Braintrust, Entire and Magpie: nothing new found for 11-20 and 11-21.

## Candidates

1. OpenCode 2.x backfill reads the real 2.x shapes (`src/adapters/opencode.ts`).
2. A real OpenCode 2.x capture in `scripts/e2e`.
3. Pi's "Operation aborted" counts as interrupted (`src/core/failures.ts`).
4. The OTLP sink stamps the GenAI semconv schema URL (`src/sinks/otlp.ts`).
5. The OTel receiver reads the semconv v0.1.0 renames (`src/otel/map.ts`).
6. Codex PreModelRequest and PostModelRequest (carried from round 4).
7. Claude Code PostToolBatch (carried from round 4).
8. Cursor subagent parent link (carried from round 4).

## Watch list

- OpenCode release with `part_rows` on by default (#65039).
- Copilot CLI 1.0.115 session storage change.
- Droid 1.17: re-verify the adapter, since ADAPTERS.md names 1.6.0.
- T3 Code multi-repository projects (#35925).
- MCP Events Extension (SEP-3415).
- Codex subagent lifecycle telemetry (#62567) and USD turn cost (#62810).
