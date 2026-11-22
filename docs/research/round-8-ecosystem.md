# Round 8 ecosystem notes

Scout: ecosystem. Window: 2026-11-21 18:49 UTC (the end of the round 7 notes) to 2026-11-22
00:15 UTC. It also covers older changes that round 7 missed. Baseline:
[round-7-ecosystem.md](round-7-ecosystem.md). Competitor gaps CG-1 to CG-13 belong to the other
scout, and no candidate here covers one of them.

## Method

- Read each agent's GitHub releases with `gh api`, and the pull requests merged since 2026-11-20.
  Read npm `dist-tags` for opencode-ai, droid, @github/copilot and @ampcode/cli.
- Read the Claude Code changelog
  (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) and its hooks page
  (https://code.claude.com/docs/en/hooks).
- Read the Copilot CLI changelog
  (https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md).
- Read the Goose hooks guide
  (https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/hooks.md).
- Read the Amp news feed (https://ampcode.com/news).
- Read the help strings of the current Amp CLI binary, `@ampcode/cli` 0.0.1795291233-g08aa82
  (npm, modified 2026-11-21). I downloaded the package to a scratch folder outside the repo,
  searched its strings without running it, and deleted it.
- Compared each change with `docs/ADAPTERS.md` and the source under `packages/coding.sh/src`.
- Checked prices with `resolvePrice` from `packages/coding.sh/src/core/pricing.ts`, in a
  throwaway home.

## Round 7 candidates: status

None of the round 7 candidates is built yet. They stay in the queue (`tasks/research-queue.md`):

| # | Candidate | Status |
|---|---|---|
| R7-5 | Pi usage outside assistant messages | open |
| R7-19 | Pi codemode nested calls | open |
| R7-12 | OpenInference DECISION spans in the receiver | open |
| R7-11 | Decisions price tier | open |
| - | Proxy `/v1/decisions` | open |
| R7-8 | Codex `mcp.tools.call` span fields | open |
| R7-9 | Claude Code Code Mode ``$`cmd` `` cells | open. See the correction below |
| R6-17 | OTLP sink semconv and `gen_ai.provider.name` | open. `src/sinks/otlp.ts` still writes schema URL 1.37.0 |

A correction to round 7: the notes said Claude Code Code Mode does not start while OTel is on.
Claude Code 2.1.329 (2026-11-19) changed this. Code Mode now runs with OTel events and metrics
on, and each nested tool call sends its own events. Only tracing still turns Code Mode off.
R7-9 therefore applies to OTel sessions as well as to transcripts.

## Agents

### Goose

- Goose has a `PreToolUseResult` hook event, added in
  https://github.com/aaif-goose/goose/pull/11120 (2026-08-21). It fires after the approval policy
  decides a call. Its payload has `decision` (`allow` or `deny`), `policy_evaluated`,
  `blocked_by`, `reason`, `cause` (`policy_denial` or `hook_failure`) and `tool_call_id`.
- In https://github.com/aaif-goose/goose/pull/13566 (2026-11-16, shipped in v1.60.0),
  `PreToolUse` fires once per call, before approval. A denial is appended as the call's error
  response. The guide says `PostToolUseFailure` fires "after a tool fails or a tool call is
  denied by approval policy".
- `src/adapters/more/goose.ts` does not register `PreToolUseResult`. `GOOSE_HOOK_EVENTS` lists
  eight events. `PostToolUseFailure` always closes the call with `ok: false` and the error
  "tool failed". So a call the user or policy denied counts as a real tool error. It does not
  count as an interrupted call, and the reason is lost. This is candidate 1.
- v1.60.1 and v1.60.2 have nothing that touches our formats.

### Amp

- "Bye Bye, Dial" (https://ampcode.com/news/bye-bye-dial, 2026-11-12) retires the Dial modes. A
  model picker on each thread replaces them.
- The current CLI help has a `--model` flag: "Run new threads on this model, such as
  openai/gpt-6-astra (instead of --mode)". It rejects a value that is not `provider/name`, and it
  rejects `--model` together with `--mode`. A new `--effort` flag needs a model.
- `src/adapters/more/amp.ts` passes `--mode` only for `low`, `medium`, `high` and `ultra`. For
  any other model it drops the value and notes that Amp picks models itself. That note is now
  wrong. `coding.sh run amp --model openai/gpt-6-astra` runs on Amp's default model, and the
  session does not show the model that was asked for. This is candidate 2.
- The npm package moved from `@sourcegraph/amp` to `@ampcode/cli` in May 2026. The repo
  mentions neither name.
- Other news in the window: "Puck in the Car" (2026-11-21) and the Windows app (2026-11-17). No
  format change.

### T3 Code

- Nightly v0.1.12-nightly.20261121.5064 (2026-11-21 21:19 UTC).
- https://github.com/pingdotgg/t3code/pull/40352 (2026-11-21 14:22) prices Antigravity
  Orchestrator models at their base Gemini 4 rate. It strips `-orchestrator`, maps `neon` to
  `gemini-4-neon` and maps `g1-pro` to `gemini-4-argon`. The models are
  `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro` and
  `gemini-4-hydrogen-orchestrator`.
- In coding.sh, `resolvePrice` in `src/core/pricing.ts` finds no rate for any of these names. It
  also finds none for `gemini-4-neon` and `gemini-4-hydrogen`. The only Gemini 4 row is
  `gemini-4-argon`, and `VARIANT_SUFFIX` does not strip `-orchestrator`. Antigravity and T3 Code
  sessions on these models have no cost. This is candidate 3.
- https://github.com/pingdotgg/t3code/pull/40629 (2026-11-22 00:10): a late ACP update no longer
  marks a stopped thread active. This is a fix inside T3 Code, and the stored shape is the same.
  There is no new T3 migration in the window.

### Claude Code

- No release after v2.1.330 in the window.
- Since 2.1.145, the `Stop` and `SubagentStop` input carries `background_tasks` and
  `session_crons`. Since 2.1.329, a Monitor shows up there as `monitor`.
- `src/adapters/claude-code.ts` reads neither field. A session that ends its turn while a
  background shell, subagent or monitor still runs looks the same as one that finished its work.
  This is candidate 4.
- The hooks page lists 33 events. coding.sh registers 12. The unregistered ones include
  `PermissionDenied` (2.1.89), `TaskCreated`, `DirectoryAdded`, `MessageDisplay`,
  `PreModelSwitch`, `PostModelSwitch` and `PostToolBatch` (R5-21). The common input fields
  `prompt_id`, `scratchpad_dir` and `effort` (R6-10) are also unread.

### Codex

- No release after rust-v0.173.0-alpha.4. Merges since 18:00 UTC are a Code Mode exec catalog
  refresh (https://github.com/openai/codex/pull/63046) and TUI fixes. No rollout change.
- Older change, not covered before: rollout budgets.
  https://github.com/openai/codex/pull/61579 (2026-11-14) adds `features.rollout_budget` with
  `limit_budget`. https://github.com/openai/codex/pull/61581 (2026-11-15) records a
  `<turn_aborted>` marker when a session runs over its budget. `TurnAbortReason` is now
  `interrupted`, `replaced`, `review_ended` or `budget_limited`.
- `src/adapters/codex.ts` maps `turn_aborted` to a `turn.end` event whose status is the reason.
  Nothing in `src/core` reads that status, so a turn stopped by the budget looks like one the
  user interrupted. This is candidate 5.

### OpenCode

- https://github.com/anomalyco/opencode/pull/63477 (2026-11-21 23:07, on `dev`) adds a native
  Rust CLI in `packages/cli-rs` (`opencode-native`). It is a client of the TypeScript server and
  uses the same sessions, so storage does not change. It is not shipped yet.
- https://github.com/anomalyco/opencode/pull/65269 asks permission for shell commands the
  scanner cannot analyze. https://github.com/anomalyco/opencode/pull/65493 adds Code Mode catalog
  descriptions. Neither changes the stored shape.

### Copilot CLI

- v1.0.115-6 (2026-11-21 20:57 UTC).
- 1.0.115-5 says "Long-running local sessions take up less disk space and resume faster". That
  may change `events.jsonl`. It is not yet checked against a recorded session.
- The 1.0.114 entry (2026-11-18) adds the Fusion and HydraFusion routing profiles.
  `src/adapters/more/copilot-cli.ts` reads the model from `session.usage_record` and
  `selectedModel`. It does not know the Fusion profiles. Watch list.

### Gemini CLI, Pi, Cursor, Droid, Aider

- Gemini CLI v0.70.0, v0.71.0-preview.0 and the 2026-11-21 nightly: no format change.
- Pi v1.6.0: no release in the window.
- Cursor: the last changelog entries are voice (2026-11-06) and the Agent SDK (2026-10-20),
  which round 3 covered.
- Droid and Aider: no release in the window.

## Specs

### OpenTelemetry GenAI

- https://github.com/open-telemetry/semantic-conventions-genai/pull/707 (2026-11-21 18:48) and
  #711 merged. Neither renames an attribute that `src/otel/map.ts` reads. The receiver already
  handles v0.1.0. The sink still writes schema URL 1.37.0 (R6-17).

### OpenInference

- https://github.com/Arize-ai/openinference/pull/4423 (2026-11-21) adds a semantic convention
  registry, v0.0.1, that `weaver registry live-check` can test against. This is for reference
  only. The DECISION span candidate (R7-12) is still open.

### MCP

- No new spec version. 2026-07-28 is still current. The merges in the window
  are docs only (https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3573 and
  #3572). SEP-3415 Events is on the watch list from round 7.

## Competitors

- Arize Phoenix v22.0.1 (https://github.com/Arize-ai/phoenix/releases, 2026-11-21) fixes batch
  loading only.
- Magpie v0.1.4657 (https://github.com/yetone/magpie): no change that touches our formats.
- Langfuse: no release after v4.83.0. The merges since 2026-11-20 are budgets, billing and roles
  (https://github.com/langfuse/langfuse/pull/20605, #20597, #20598, #20583, #20578, #20235). The
  budget work is CG-3. The rest is enterprise work with no gap for us.
- Braintrust 3.44.0 (2026-11-11), LangSmith SDK v0.14.9 (2026-10-15), W&B Weave v0.54.1
  (2026-11-05), judgeval v1.9.3 (2026-11-19), git-ai v1.7.6 (2026-11-05), Entire nightly 0.13.5
  (2026-11-16) and Harbor v0.27.0 (2026-11-21): no change since round 7.

## Candidates

1. Goose `PreToolUseResult`: a denied call closes as interrupted and keeps its reason
   (`src/adapters/more`).
2. `coding.sh run amp` passes a `provider/name` model with `--model` (`src/adapters/more`).
3. Prices for Antigravity Orchestrator models (`src/core`).
4. Claude Code `Stop` with background work still running gets a tag (`src/adapters`).
5. A Codex turn stopped by the rollout budget gets a tag and is not counted as a user interrupt
   (`src/adapters`).

## Watch list

- Copilot CLI 1.0.115 storage changes and the Fusion routing profiles.
- OpenCode `opencode-native` (#63477), once it ships.
- Claude Code `PermissionDenied`, `PostToolBatch` (R5-21) and the model switch hooks.
- Gemini 4 neon and hydrogen list prices. Add rows when Google publishes them.
- OpenInference registry live-check (#4423).
- From round 7: OpenCode Code Mode, Codex concurrent reasoning summaries (#62903), MCP SEP-3415,
  semconv #443, #596, #718, #238 and #689, and the Droid metrics name prefix.
