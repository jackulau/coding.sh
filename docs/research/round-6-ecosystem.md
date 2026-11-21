# Round 6 ecosystem notes

Scout: ecosystem. Window: 2026-11-20 to 2026-11-21. Baseline: [round-5-ecosystem.md](round-5-ecosystem.md).
Competitor gaps CG-1 to CG-13 belong to the other scout. None of the candidates here covers one of
them.

## Method

- Read each agent's GitHub releases with `gh api repos/<org>/<repo>/releases`. For changes not yet
  released, read merged pull requests with a `gh api search/issues` query of the form
  `repo:<repo> is:pr is:merged merged:>=2026-11-20`.
- Read npm `dist-tags` for opencode-ai, droid and @github/copilot.
- Read the source of OpenCode's 2.x shell tool, T3 Code's task folder migration, Pi's abort commit,
  and Harbor's Pi, OpenCode and Cursor agents. I kept downloaded copies in a scratch folder
  outside the repo and deleted it afterwards.
- Compared each change with `docs/ADAPTERS.md` and the source under `packages/coding.sh/src`.

## Round 5 candidates: status

None of the round 5 candidates was built at d350aa65.

| # | Candidate | Status |
|---|---|---|
| 1 | OpenCode 2.x message and part shapes | open. `convertStoredSession` in `src/adapters/opencode.ts` still reads 1.x names |
| 2 | OpenCode 2.x capture | open |
| 3 | Pi "Operation aborted" tool results | open. `INTERRUPT_TEXT` in `src/core/failures.ts` does not match it |
| 4 | OTLP sink schema URL | open. `src/sinks/otlp.ts` still sends `https://opentelemetry.io/schemas/1.37.0` |
| 5 | Receiver reads semconv renames | open |
| 6 | Codex PreModelRequest / PostModelRequest | open |
| 7 | Claude Code PostToolBatch | open |
| 8 | Cursor subagent parent link | open |

One round 5 note needs a fix. Round 5 said the receiver should rename the time-to-first-chunk
attribute. The v0.1.0 rename affects the metric, not the span attribute.
`gen_ai.response.time_to_first_chunk` in `SPAN_TTFT_S` (`src/otel/map.ts`) is still correct, and the
receiver does not ingest metrics.

## Agents

**Claude Code.** [v2.1.330](https://github.com/anthropics/claude-code/releases/tag/v2.1.330)
(2026-11-20) is still the latest. It has no hook or transcript format change. The transcripts we
already record have a top-level `effort` field on assistant lines ("high", "medium") and a
`perTurnEffort` field. See the claude-code `fallback` fixture under
`packages/coding.sh/test/fixtures/adapters/claude-code/`. `src/adapters/_shared/claude-transcript.ts`
reads `usage.service_tier` but not `effort`. The LangSmith plugin started reading both on 2026-11-20
(see Competitors).

**Codex.** The latest is rust-v0.173.0-alpha.4 (2026-11-21), from
[openai/codex releases](https://github.com/openai/codex/releases). Pull requests merged on 2026-11-21:

- [#62933](https://github.com/openai/codex/pull/62933) skips empty permission messages.
- [#62898](https://github.com/openai/codex/pull/62898) separates conversation item IDs from Responses IDs.
- [#62903](https://github.com/openai/codex/pull/62903) turns concurrent reasoning summaries on by default.
- [#62883](https://github.com/openai/codex/pull/62883) adds a `cot_removed` tag.
- [#62906](https://github.com/openai/codex/pull/62906) makes `exec` report HTTP MCP startup problems.

None of these changes the rollout format. Codex turn_context lines carry a reasoning effort. In the
recorded fixtures it sits under `collaboration_mode.settings.reasoning_effort`, which is null there.

**OpenCode.** [v2.3.2](https://github.com/anomalyco/opencode/releases) shipped on 2026-11-18. The
npm `latest` tag is still 1.19.6, so most users run 1.x. Changes merged on 2026-11-21:

- [#65365](https://github.com/anomalyco/opencode/pull/65365): the shell tool's structured result
  keeps `killed` and reports `exitCode` as `output.exit ?? null`, and its metadata has `status`.
- [#65282](https://github.com/anomalyco/opencode/pull/65282): MCP clients probe `server/discover`
  first and fall back to `initialize`. Our MCP server (`src/mcp/protocol.ts`) already answers
  `server/discover`.
- [#65292](https://github.com/anomalyco/opencode/pull/65292): undeclared dotted tool names are
  sanitized only in outgoing requests, so the stored session keeps the original name.
- An `mcp_events` flag gates a `list_mcp_events` tool and automations triggered by MCP events
  ([#63269](https://github.com/anomalyco/opencode/pull/63269),
  [#64586](https://github.com/anomalyco/opencode/pull/64586)). See the watch list.

`src/adapters/opencode.ts` lists the 2.x tables in `SQL_SCHEMAS`, but `convertStoredSession` reads
the 1.x field names. Harbor's opencode-v2 agent (see Competitors) notes that 2.x can finish its
final text without a `step_finish` event. `runOpencode` sums usage only from `step_finish`, so it
can miss the last step.

**T3 Code.** The latest nightly is v0.1.12-nightly.20261121.5038.
[#35925](https://github.com/pingdotgg/t3code/pull/35925) (merged 2026-11-21) adds multi-repo
projects:

- Migration 104 adds `projection_projects.tracked_folders_json`.
- Migration 105 adds a `task_folders` table. Its columns are `root`, `real_root`, `project_id`,
  `project_root`, `anchor`, `project_path`, `project_is_worktree`, `repositories_json` and
  `created_at`.
- `repositories_json` is a list of `{repositoryPath, worktreePath, name}`.
- When `project_is_worktree` is 0, the thread's working folder is a plain folder that holds
  several repos, so it is not a git repo itself.

`src/adapters/t3code.ts` sets a thread's cwd to `worktree_path ?? project.workspace_root`. For a
multi-repo task, that folder has no repo, so the session loses its repo. Other T3 Code changes:

- [#40170](https://github.com/pingdotgg/t3code/pull/40170) sends a note when background work is
  cancelled because the provider exited.
- [#40352](https://github.com/pingdotgg/t3code/pull/40352) prices Antigravity orchestrator models
  at the base Gemini 4 rate.
- [#40136](https://github.com/pingdotgg/t3code/pull/40136) names the reasoning option
  `thought_level`.

**Pi.** [v1.6.0](https://github.com/earendil-works/pi/releases) shipped on 2026-11-20. Commit
4438c58b (issue [#9986](https://github.com/earendil-works/pi/issues/9986)) writes an error tool
result with the text "Operation aborted" for each call that Esc skips mid-batch. Our fold counts
these as failures, not interruptions. Pull requests since then
([#12358](https://github.com/earendil-works/pi/pull/12358) for cache tokens on OpenAI decisions and
[#12360](https://github.com/earendil-works/pi/pull/12360) for loading long compacted sessions) do
not change the format.

**Gemini CLI.** [v0.70.0](https://github.com/google-gemini/gemini-cli/releases) is the latest
stable. 0.71.0-preview.0 and the 2026-11-21 nightly add nothing that touches hooks or the
session format.

**Copilot CLI.** 1.0.114 is the latest stable. The 1.0.115-5 prerelease (2026-11-21) says long
local sessions take less disk space and resume faster. That may change `events.jsonl`. I could not
confirm it: the Linux package is a single binary with compressed JavaScript. See the watch list.

**Droid.** npm 1.17.0 shipped on 2026-11-21. The changelog at docs.factory.ai redirects to
docs.factory.com, which did not resolve from here. A third-party pull request confirmed that the
SessionStart hook works on 1.17.0. `docs/ADAPTERS.md` should point at the new docs host after a
recheck.

**Cursor, Amp, Goose, Aider.**

- Cursor: the [changelog](https://cursor.com/changelog) has voice chat on Nov 6 and the Agent SDK
  on Nov 5 and Oct 20. Nothing changes hooks or the session format.
- Amp: Windows support was the latest news, on 2026-11-17. No format change.
- Goose: [v1.60.2](https://github.com/aaif-goose/goose/releases) shipped on 2026-11-20, and the
  repository moved from block/goose to aaif-goose/goose. Thinking levels were added in #13673.
  No format change.
- Aider: v0.86.0 (2025-08-09) is still the latest.

## Specs

**OTel GenAI semantic conventions.**
[v0.1.0](https://github.com/open-telemetry/semantic-conventions-genai/releases/tag/v0.1.0)
(2026-11-21) is the first release from the new GenAI repo. It depends on core semconv 1.45.0, and
`https://opentelemetry.io/schemas/1.45.0` resolves. The manifest's own schema URL
(`https://opentelemetry.io/schemas/semconv-genai-dev/0.1.0-dev`) returned 404 on 2026-11-21.

The release makes these breaking changes:

- The `invoke_workflow` span merges into `gen_ai.invoke_agent.internal`.
  `gen_ai.operation.name` stays `invoke_workflow`.
- `gen_ai.workflow.name` becomes `gen_ai.agent.name`.
- The provider value `mistral_ai` becomes `mistral`.
- MCP spans report errors in `rpc.status_code`.

It adds these:

- the `plan` operation
- `gen_ai.request.reasoning.level`
- `gen_ai.conversation.compacted`
- `gen_ai.main_agent.name`

Pull requests merged after the release:

- [#742](https://github.com/open-telemetry/semantic-conventions-genai/pull/742) moves the repo to
  0.2.0-unreleased.
- [#741](https://github.com/open-telemetry/semantic-conventions-genai/pull/741) updates the
  conformance scenarios, which now expect `gen_ai.skill.*` on skill tool spans.
- [#736](https://github.com/open-telemetry/semantic-conventions-genai/pull/736) documents how to
  aggregate tokens.

What we already handle:

- `src/otel/map.ts` reads `gen_ai.skill.*`, `gen_ai.conversation.compacted` and
  `gen_ai.main_agent.name`.
- `classifySpan` maps `invoke_workflow` to "other" (not "agent"), and nothing reads
  `gen_ai.request.reasoning.level` or `rpc.status_code`.
- `src/sinks/otlp.ts` sends schema URL 1.37.0 for both resource and scope, a fixed scope version
  "0.0.1", no reasoning level and no `gen_ai.skill.name`.

**MCP.** No spec release since 2026-07-28. `src/mcp/protocol.ts` supports that version and
`server/discover`. [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3568)
(MCP Events) was registered on 2026-11-20, and a docs pull request
([#3572](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3572)) followed on
2026-11-21. It is a proposal, so it stays on the watch list.

## Competitors

- **Harbor.** [v0.27.0](https://github.com/harbor-framework/harbor/releases/tag/v0.27.0) shipped
  on 2026-11-21.
  - [#2963](https://github.com/harbor-framework/harbor/pull/2963) (merged 2026-11-18) changes how
    the instruction reaches Pi. Pi got the instruction as an argument, so an instruction that
    starts with `-` failed with "Unknown option". This happened on 6 of 6 runs of one
    Terminal-Bench 2.1 task. The fix pipes the prompt on stdin with `pi --print --mode json`, which
    Pi supports from 0.47.0. Pi honors `--` only from 0.85.0. Keeping the instruction out of argv
    also stops a task's `pkill -f` from matching the agent process.
  - Harbor's OpenCode and Cursor agents put `--` before the instruction.
  - Other items: cancelled trials (#4212), opencode-v2 (#4207, #4382), LangGraph ATIF (#4296).
  - Our `runCursor` (`src/adapters/cursor.ts`), `runOpencode` (`src/adapters/opencode.ts`) and
    Pi `run` (`src/adapters/more/pi.ts`) still append the instruction as a bare argument.
    `src/adapters/more/devin.ts` already uses `--`.
- **LangSmith.** The Claude Code plugin
  [0.7.0](https://github.com/langchain-ai/langsmith-claude-code-plugins/releases/tag/0.7.0)
  (2026-11-20):
  - #81 reads the transcript's top-level `effort` and `service_tier` into the invocation params of
    each model run.
  - #80 adds a command that prints the trace link.
- **Langfuse.** [v4.83.0](https://github.com/langfuse/langfuse/releases) (2026-11-19) is the
  latest. Since then, budget warning thresholds for the gateway
  ([#20605](https://github.com/langfuse/langfuse/pull/20605)) and billable units (#20597, #20598)
  have merged. Budgets are CG-3, so I propose nothing here.
- **Magpie.** v0.1.4647 to v0.1.4656 (2026-11-21) add:
  - Codex window usage weighted by plan tier. This is plan quota, CG-1.
  - `ctx.caller` in gateway middleware.
  - MCP and skill rows in the router view. This is cost by MCP and skill, CG-5.
- **Braintrust.** Per its changelog (www.braintrust.dev did not resolve here, so I relied on
  search results), it now:
  - records the plugin and agent versions in `span_origin`
  - ends Codex tool spans that never get output
  - fixes Cursor traces on Windows

  The Claude plugin is at v3.0.6 (2026-11-10).
- **Arize Phoenix** [v22.0.0](https://github.com/Arize-ai/phoenix/releases) (2026-11-20),
  **W&B Weave** v0.54.1 (2026-11-05), **judgeval** v1.9.3 (2026-11-19), **git-ai** v1.7.6
  (2026-11-05) and **Entire** nightly 0.13.5 (2026-11-16) had no change that bears on our
  formats.

## Candidates

1. **OpenCode 2.x backfill reads the 2.x shapes** (`src/adapters/opencode.ts`). Carried from round
   5 and still open. 2.x users get empty or tool-less sessions.
2. **A leading-dash instruction stays out of option parsing** (`src/adapters`). Harbor #2963 shows
   the failure on a real benchmark task.
3. **Pi "Operation aborted" counts as an interruption** (`src/core/failures.ts`). Carried from
   round 5.
4. **Reasoning effort per model call** (`src/adapters`). The data is in transcripts we already
   record. LangSmith 0.7.0 and semconv v0.1.0 both expose it.
5. **The OTLP sink follows semconv v0.1.0** (`src/sinks/otlp.ts`).
6. **The OTLP receiver reads the v0.1.0 changes** (`src/otel/map.ts`).
7. **T3 Code multi-repo tasks keep their repo** (`src/adapters/t3code.ts`).
8. **`<pasted_content>` prompts stop becoming titles** (`src/core/sessions.ts`). Carried from
   rounds 3 to 5.

## Watch list

- Copilot CLI 1.0.115 storage. Recheck `events.jsonl` once it reaches stable.
- Droid 1.17. Recheck the hooks and the session file on the new docs host.
- OpenCode part rows ([#65039](https://github.com/anomalyco/opencode/pull/65039)) and MCP-event
  automations behind `mcp_events`.
- OpenCode `run` without a final `step_finish`. Usage may be undercounted on 2.x.
- T3 Code background-work-cancelled notes (#40170). They may show up as user prompts.
- MCP SEP-3415 Events.
- Codex concurrent reasoning summaries (#62903).
- Carried from earlier rounds:
  - Codex PreModelRequest and PostModelRequest hooks
  - Claude Code PostToolBatch
  - Cursor subagent parent link
  - Goose denied calls
  - Gemini cancelled and scheduled calls
