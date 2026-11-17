# Round 2 ecosystem scan (2026-11-14)

Scout: "ecosystem". Question: what changed upstream since the round 1 scan (2026-11-06) that breaks
or improves coding.sh. The baseline is `docs/ADAPTERS.md` (verified 2026-11-06),
`docs/research/round-1-ecosystem.md`, and the current source in `packages/coding.sh/src`.

**How this was checked**

- Release data comes from GitHub releases via `gh api repos/<owner>/<repo>/releases` (dates are
  `published_at`, UTC), from official changelog pages, and from PR bodies read with
  `gh api repos/<owner>/<repo>/pulls/<n>`.
- A claim marked **code** was checked against the coding.sh source with grep.
- A claim marked **ran** was reproduced locally on Windows 11 with the CLI run from source. Each run
  used temp dirs for `HOME`, `USERPROFILE`, `CODING_SH_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  Codex rollouts were copied into the temp `CODEX_HOME`. The real sessions were only read. The
  temp copy was deleted after the run.
- Personal content found in real sessions is not quoted here.

## 0. Round 1 candidates: status on 2026-11-14

| # | Round 1 candidate | Status |
|---|---|---|
| 1 | OTel usage cache correctness | Implemented (**code**) |
| 2 | Sinks `cache_write` | Implemented (**code**) |
| 3 | Codex `.jsonl.zst` rollouts | **Still open.** Confirmed on real data; see 1.1 |
| 4 | Cursor subagent transcripts and `model_id` | **Still open.** See 1.4 |
| 5 | Copilot `traceparent` | Implemented (**code**) |
| 6 | Runner per-run OTel | Implemented (**code**) |
| 7 | ATIF / Harbor 1.4 | Implemented (**code**) |
| 8 | Skill-load detection | Implemented (**code**, `execute_tool load_skill` in `src/otel/map.ts`) |

Round 1 watch-list items are still unused: Claude `permissions.denyInsteadOfPrompting` and Pi
`totalFromProvider` (no match in `src`).

## 1. Findings that need code changes

### 1.1 Codex: backfill misses every compressed rollout (round 1 item 3, now measured)

- Codex has compressed rollouts older than 7 days to `rollout-*.jsonl.zst` since rust-v0.164.0
  (2026-10-23): <https://github.com/openai/codex/releases/tag/rust-v0.164.0>, PR
  <https://github.com/openai/codex/pull/54008>. Plain `.jsonl` wins when both exist (PR
  <https://github.com/openai/codex/pull/53997>).
- **code:** `src/adapters/codex.ts` line 981 walks with `match: (n) => /^rollout-.*\.jsonl$/.test(n)`.
  The fallback id regex on line 821 also expects `\.jsonl$`. `convertRollout` reads with
  `readJsonl(path)`, which has no zstd path. `src/store/fs-blobs.ts` already imports
  `zstdDecompressSync` from `node:zlib`, so no dependency is needed.
- **ran:** a local Codex home (codex-cli 0.163.0 installed, rollouts written by cli_version 0.144.2
  to 0.167.0) holds 101 rollouts: 95 `.jsonl.zst` and 6 `.jsonl`. `ingest --backfill -a codex
  --json` produced 2036 events and 5 sessions. `sessions -a codex --json` listed 5. About 95% of
  this user's Codex history is invisible. This is not Windows-specific.
- Record types in the rollouts were stable from 0.144.2 through 0.167.0. The new record types seen
  (`thread_settings_applied`, `world_state`, `inter_agent_communication_metadata`) are ignored by the
  converter today, which is safe. `world_state` can carry the user's instruction files, so it must
  stay unstored unless it goes through redaction.

### 1.2 OpenCode 2.3.0: background subagents by default

- v2.3.0 (2026-11-13) <https://github.com/anomalyco/opencode/releases/tag/v2.3.0> makes background
  subagents the default. PR #63382 (merged 2026-11-11): the subagent tool returns a `sessionID` at
  once instead of the child's answer. PR #63209 (merged 2026-11-11): the parent receives a
  `<subagent>` message each time the child goes idle, delivered through the job outbox and
  `SessionInbox`. A `notify: false` metadata flag suppresses the wake.
- Effects on `src/adapters/opencode.ts` (**code**):
  - The subagent tool's result no longer holds the child's output, so a tool result read as
    "subagent result" is just an id.
  - `subagent.start` already comes from `session.created` with `parentID`, and `subagent.end` from the
    child going idle. With background children the parent keeps working, so parent turns and child
    turns overlap in time. Any stat that assumes the parent waits (idle time, phase timing) can be
    off.
  - The plugin skips `part.synthetic` text parts. Whether the `<subagent>` report is marked synthetic
    is not known. If it is not, each report counts as a user prompt and can become the session
    title or a turn boundary.
- v2.2.6 (2026-11-06) <https://github.com/anomalyco/opencode/releases/tag/v2.2.6>: `run -w/--worktree`,
  `run --archived`, `run` waits for background jobs and emits a `background_wait` JSON event,
  SIGTERM exits 143.
- v2.2.7 (2026-11-10) <https://github.com/anomalyco/opencode/releases/tag/v2.2.7>: Copilot charged cost
  replaces the catalog estimate. `session.generate` and cache-warming tokens now count in session
  totals.

### 1.3 Claude Code: new hook events and non-human UserPromptSubmit

Releases: v2.1.321 (2026-11-09), v2.1.322 (11-10), v2.1.323 (11-12), v2.1.325 (11-13), at
<https://github.com/anthropics/claude-code/releases/tag/v2.1.325> and siblings. Locally installed:
2.1.316.

- The hooks reference <https://code.claude.com/docs/en/hooks> now states that `UserPromptSubmit`
  fires on more than typed prompts:
  - a session-scoped scheduled task or a `/loop` iteration
  - a background subagent reporting back
  - a message from another session (cross-session messaging,
    <https://code.claude.com/docs/en/cross-session-messaging>)
  - Code Mode output (`source` `poll_event`)
- **code:** `src/adapters/claude-code.ts` maps every `UserPromptSubmit` to `user.message`
  unconditionally. `SYNTHETIC_PROMPT` in `src/core/sessions.ts` line 156 covers
  `<task-notification>`, which handles background subagent reports. It does not cover the other
  three sources. They count as human turns, can set the title, and inflate prompt counts on the
  hook path. The transcript path skips `isMeta` entries, so backfill is less affected.
- New common hook field `prompt_id`, which matches the OTel `prompt.id` attribute. **code:** not
  read anywhere in `src`. It would give an exact join between hook events and the OTel logs that the
  receiver ingests, in place of time-window matching.
- Events not registered by `CLAUDE_HOOK_EVENTS` (**code**):
  - `PostCompact` (`trigger`, `compact_summary`; agent_id and agent_type in subagents since 2.1.325)
  - `PostToolBatch` (`tool_calls[]` with the `tool_response` the model saw)
  - `PreModelSwitch` and `PostModelSwitch` (since 2.1.251; `source` `"auto"` on an automatic fallback,
    or `"resume"`)
  - Model switches and fallbacks are already folded from transcripts (`src/core/models.ts`), so
    PostModelSwitch only matters for hook-only sessions.
  - PostCompact is the higher-value event: today only `PreCompact` is registered, so a live session
    knows a compaction started but not what it kept.
- Code Mode (2.1.323, <https://code.claude.com/docs/en/code-mode>): a `REPL` tool whose
  `tool_input.code` runs inner tool calls, each of which goes through PreToolUse hooks. Code Mode is
  interactive only and is off with `-p` or when OTel export is on. **code:** REPL cells are already
  handled (`src/core/cells.ts`, fold version 16).
- 2.1.325 also:
  - OTel `user_prompt` mid-turn events carry `delivery.mode`.
  - An unknown model id assumes a 1M context window.
  - OTel defaults to `http/protobuf` when no protocol is set.
  - One malformed `OTEL_RESOURCE_ATTRIBUTES` entry no longer drops the rest.
  - Subagent transcripts are no longer saved separately after a subagent enters a WorktreeCreate
    worktree.
- Fable 5.2 (`claude-fable-5-2`, $8 / $40 per MTok, cache read $0.20) is already priced
  (**code**, `src/core/pricing.ts` line 220).

### 1.4 Cursor: subagent transcripts become orphan sessions (round 1 item 4)

- No Cursor changelog entries after v2026.10.22 (<https://cursor.com/changelog>), so round 1 still
  stands.
- **code:** `src/adapters/cursor.ts` line 232 walks every `*.jsonl` under `agent-transcripts/` to
  depth 4 and uses the basename as the session id. A file at
  `agent-transcripts/<parent>/subagents/<id>.jsonl` becomes a top-level session with no parent. The
  `subagentStop` hook handler (lines 195 to 215) links the child live, but backfill does not.
  `model_id` is not read.

### 1.5 OTel GenAI semantic conventions

The conventions now live in <https://github.com/open-telemetry/semantic-conventions-genai>, with no
tagged releases and Development status. Merges since round 1 (PR links are
`https://github.com/open-telemetry/semantic-conventions-genai/pull/<n>`):

- **#634 (2026-11-05):** content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, tool definitions) must be structured AnyValue. The JSON-string
  fallback is removed.
  - Receiver side (**code**): `src/otel/json.ts` and `src/otel/proto.ts` decode `arrayValue` and
    `kvlistValue`. `messagesFrom` in `src/otel/map.ts` takes arrays and objects as well as JSON
    strings. Ingest is fine.
  - Exporter side (**code**): `src/sinks/otlp.ts` line 105 `content()` returns
    `JSON.stringify(v)` capped at 8192 chars. Its `AnyValue` type (line 31) has no `kvlistValue`.
    The sink now emits the deprecated form.
- **#571 (2026-11-05):**
  - `invoke_workflow` folds into `invoke_agent` with span kind INTERNAL.
  - Framework entry points become `invoke_{entrypoint}`, for example `invoke_runner`.
  - `gen_ai.workflow.name` is removed.
  - Usage attributes are allowed on `invoke_agent` spans.
  - **code:** `src/otel/map.ts` line 307 classes unknown operations as "other", and line 30 takes
    usage only from model-call spans. That avoids double counting. It also means a trace whose only
    usage sits on `invoke_agent` reports zero tokens.
- **#636:** `gen_ai.execute_tool` refinements `.transfer`, `.load_skill`, `.read_skill_resource`,
  `.command`. `load_skill` and `command` are already read (**code**, map.ts line 933).
- **#667 to #670:** exception events such as `gen_ai.invoke_agent.exception` and
  `gen_ai.execute_tool.exception`. Not read or written (**code**).
- **#513** `gen_ai.request.stream`, **#665** `inference_calls` counts logical operations, **#394**
  realtime sessions, **#644 and #645** retrieval span, **#663** `ollama` provider value.

### 1.6 Codex releases since round 1

rust-v0.167.0 (2026-11-06), 0.167.1 (11-10), 0.167.2 (11-11), 0.168.0 (11-13), 0.169.0 (11-13):
<https://github.com/openai/codex/releases/tag/rust-v0.168.0> and siblings.

- #59973: Code Mode output truncation is on by default.
- #59778, #60122, #60673: rollout trace changes. No new record types appeared in rollouts up to
  0.167.0. The 0.168 and 0.169 changes were not measured.
- #58959: inherited history is recovered from alternate rollout copies.
- #59000: hosted child threads inherit the root session id. A child with the root's session id
  could collide with the parent's id in our store. Watch this.
- #59041: assistant content token counts.
- #60492: local-only Claude Code skill migration.
- #58166: rollout recording failures are made explicit.

### 1.7 Other agents

- **Copilot CLI** 1.0.109 (2026-11-10) to 1.0.112 (2026-11-13),
  <https://github.com/github/copilot-cli/blob/main/changelog.md>:
  - `-p --output-format json` emits a final result record with an exit status even when a run fails
    early (1.0.109). A later entry adds auth failure and blank prompt.
  - Multiple `userPromptSubmitted` hook contexts now merge.
  - `-p --trust-folder` from a subdirectory warns that the repository-root hooks did not load. A
    coding.sh project hook can be silently skipped in that case.
  - Signal-killed shell commands report 137 and 139.
  - **code:** the runner (`src/adapters/more/copilot-cli.ts` `run`) reads only `assistant.usage` and
    `session.shutdown`.
  - Harbor's Copilot agent now reads usage and cost from `--usage-output-file` (Harbor PR #3990).
    That flag is not in the Copilot changelog window I read, so it is unverified here.
- **Gemini CLI** v0.68.0 (2026-11-10) <https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0>:
  `gemini hooks migrate` copies Claude hooks into Gemini settings, mapping SubagentStop to AfterAgent
  (#30111). A user who runs it gets coding.sh's Claude hook command in Gemini settings, which
  would send Claude-shaped events from Gemini. `doctor` could flag a Gemini hook entry whose
  command carries the Claude agent id.
- **Pi** v1.5.1 (2026-11-09), v1.5.2 (2026-11-10) <https://github.com/earendil-works/pi/releases>:
  - Anthropic message threads send only new messages.
  - Idle cache warming prints a "Cache warmed: $" line, a cost the agent incurs while idle.
  - Fable 5.2 support.
  - Forking a session whose folder is gone gives a new id.
- **Goose** v1.58.0 (2026-11-09), v1.59.0 (11-10), v1.59.1 (11-14)
  <https://github.com/aaif-goose/goose/releases>:
  - Completed delegates can be resumed (#13106).
  - GDK stop, approval and tool hook operations (#13169).
  - Session id shown in `/status`.
- **Aider:** still v0.86.0 (2025-08-09). **Amp, Droid:** no adapter-relevant changes found.
- **MCP:** no spec release since 2026-07-28 (<https://modelcontextprotocol.io/specification>).

## 2. Competitors (2026-11-06 to 2026-11-14)

| Project | Release (date) | What matters for coding.sh |
|---|---|---|
| Harbor | v0.26.0 (2026-11-13) <https://github.com/harbor-framework/harbor/releases/tag/v0.26.0> | Reuses an agent the environment ships (#3657). Installed-version check used for opencode (#3823). Copilot usage and cost via `--usage-output-file` (#3990). Windows unit test and artifact probing fixes (#3910, #3912). "Cracking down on reward hacking" post (#3968). |
| Entire | v0.13.3 (2026-11-12), v0.13.4 (2026-11-13) <https://github.com/entireio/cli/releases> | Blanks injected request text in checkpoints: Claude system prompt, instruction files, memory notes, and the `session_context` attachment, which carried the developer's email. Codex base instructions are blanked too. Opt-in `redaction.drop_images`. Codex tool results gain `exitCode`, `declined`, `cwd`. Pi capture survives `/reload`, `/new`, `/resume`. |
| Langfuse | v4.77.0 (11-09) to v4.80.0 (2026-11-13) <https://github.com/langfuse/langfuse/releases> | Native Rust OTLP decoding, normalized tool definitions and calls from OTel. Scheduled trace transcript evaluations (#20006). "Topics" clustering of traces. AI gateway providers. v4 cloud cutover 2026-11-16. |
| Arize Phoenix | arize-phoenix v21.1.0 (2026-11-13), phoenix-client 8.0.0, phoenix-otel 3.0.0, phoenix-cli 1.22.0 (2026-11-11), evals 3.10.0 (2026-11-10) <https://github.com/Arize-ai/phoenix/releases> | Major client and otel package bumps; bodies not reviewed in detail. |
| Judgment Labs | judgeval v1.7.0, v1.8.0 (2026-11-11) <https://github.com/JudgmentLabs/judgeval/releases/tag/v1.8.0> | `Judge.metric()` for trace metrics in test-suite runs (#845). |
| Braintrust | JS SDK 3.44.0 (2026-11-11) | Release body not found at the expected tag. |
| W&B Weave | v0.54.1 (2026-11-05) | Nothing new since round 1. |
| LangSmith | SDK v0.14.9 (2026-10-15) | Nothing new since round 1. |
| git-ai | v1.7.6 (2026-11-05) | Unchanged. |

Notes:

- Entire's blanking of the Claude `session_context` attachment matters for coding.sh. **code:**
  `src/adapters/_shared/claude-transcript.ts` line 530 says non-memory attachment types are
  skipped, so coding.sh does not store `session_context` today. Keep it that way, and add a test.
- Langfuse scheduled transcript evals and Judgment's trace metrics match coding.sh's local judge
  and eval features. No new gap from them.

## 3. Watch list

- Codex #59000: child threads that share the root session id.
- Codex 0.168 and 0.169 rollout trace changes: re-measure against a fresh capture.
- OpenCode `run --archived` and `background_wait`: useful to the eval runner once 2.3.0 is common.
- Pi and OpenCode cache-warming tokens: these are idle spend, which `cache-breaks` could report as a
  separate line.
- Claude Code 2.1.325 behavior for unknown model ids (assumes 1M context) can change our context
  percentage on models missing from the pricing table.
- Copilot `--usage-output-file` (seen in Harbor, not confirmed in the Copilot changelog).
- semconv #571 `invoke_{entrypoint}` names and #667 to #670 exception events, both in Development
  status.
