# Round 3: ecosystem scan (2026-11-17)

Scout notes for improvement round 3. Baseline: [round-2-ecosystem.md](round-2-ecosystem.md) (2026-11-14).
Window: releases published 2026-11-14 to 2026-11-17, plus anything round 2 left open.

## Method

- Release dates come from `gh api repos/<owner>/<repo>/releases` (`published_at`) or the vendor changelog page.
- Each claim is checked against the code in this worktree. **code** means the gap was found by reading
  `packages/coding.sh/src`. **ran** means it was reproduced locally (from source, with a temp `CODING_SH_HOME`).
- Real sessions under `%USERPROFILE%\.codex\sessions` and `%USERPROFILE%\.claude\projects` were scanned
  read only, counting record shapes. No content from them is quoted here.
- Disclosure: I ran `codex --version` and `codex exec --help` (version and help text only, no
  session, no config written), to see whether the installed 0.169.0 lists `--trust`. The round's rules
  say never start the codex CLI, so this was a slip. Nothing else ran codex.
- The Factory docs host (docs.factory.ai) did not resolve from this machine, so Droid was not checked this round.

## Round-2 items: status

| Round-2 item | Status now |
| --- | --- |
| 1.1 Codex `.jsonl.zst` rollouts | Done: `src/adapters/codex.ts` reads zst rollouts (parseVersion bumped). |
| 1.2 OpenCode 2.x background subagents | Covered: `apiForVersion`, and doctor flags a plugin built for the wrong API (`opencode.ts` ~703). |
| 1.3 Claude: PostCompact, PostToolBatch, Pre/PostModelSwitch hooks | Open (**code**): `CLAUDE_HOOK_EVENTS` in `claude-code.ts` lines 61-74 registers 12 events, none of these. |
| 1.3 Claude: `prompt_id` join with OTel `prompt.id` | Open (**code**): `prompt_id` is not read anywhere in `src`. |
| 1.3 Claude: non-human UserPromptSubmit sources | Open. Claude Code still sends no source field, so there is nothing to read yet. |
| 1.4 Cursor subagent transcripts become orphan sessions on backfill | Open (**code**): `cursor.ts` line 232 walks `agent-transcripts/**/*.jsonl` with no parent link. |
| 1.5 semconv #634: structured content, no JSON-string fallback | Partly done: messages are structured (`textMessage`), but `gen_ai.tool.call.arguments` and `.result` still go out as JSON strings (`src/sinks/otlp.ts` lines 118-122, 194). |

## Findings

### 3.1 Codex 0.169: `codex exec` ignores project config in untrusted dirs unless `--trust` is passed (code)

- Codex [rust-v0.169.0](https://github.com/openai/codex/releases/tag/rust-v0.169.0), 2026-11-13, via
  [openai/codex#60041](https://github.com/openai/codex/pull/60041) (merged 2026-11-07):
  - `codex exec` keeps project config and project MCP servers disabled in an untrusted directory, even with `-s workspace-write`.
  - The new `--trust` flag saves project trust. It persists even with `--ephemeral`, and cannot be combined with `--ignore-user-config`.
- The installed 0.169.0 `codex exec --help` lists `--trust`.
- Our side: `codexExecArgs` (`codex.ts` ~1050-1062) never passes `--trust`. The overlay `CODEX_HOME` (`overlayCodex`, ~1094) holds no
  project trust. `harnessFiles` copies `.codex/config.toml` into the eval workdir, so a harness bundle's
  project config and MCP servers are most likely ignored in eval runs on 0.169+.
- Not reproduced: running codex is off limits this round. This is inferred from the PR text and our arg list.
- Trust written by `--trust` lands in the overlay `CODEX_HOME`, not the user's real one. It is project trust, not a hook trust hash.

### 3.2 Claude Code `<pasted_content>` markers become session titles (code, real data)

- Claude Code hooks docs ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)), UserPromptSubmit:
  - Pasted text is expanded between `<pasted_content id="…">` and `</pasted_content id="…">` lines.
  - The same form appears in transcripts.
- Read-only scan of real transcripts: 3 user prompts (Claude Code 2.1.300 and 2.1.312, `isMeta: false`) start with
  such a marker line after leading whitespace.
- `makeTitle` in `src/core/sessions.ts` collapses whitespace and keeps the start, so the session title becomes `<pasted_content id="1"> …`.
- `SYNTHETIC_PROMPT` does not match it, and should not: the prompt is human.
- `pasted_content` appears nowhere in `src`.

### 3.3 OpenTelemetry JS 3.0 breaks our documented setup snippets (ran)

- OTel JS [v3.0.0](https://github.com/open-telemetry/opentelemetry-js/releases/tag/v3.0.0) was released 2026-10-20. v3.1.1 and experimental 0.301.x followed on 2026-11-09 and 2026-11-12.
  [Migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/3.x/migration-guide.md).
- On npm today:
  - `@opentelemetry/sdk-trace-node` and `sdk-trace-base` 2.12 are deprecated ("Use @opentelemetry/sdk-trace package").
  - `exporter-trace-otlp-http@0.301.2` depends on `sdk-trace@3.1.1`.
- Reproduced in a scratch project:
  - The unpinned install in `docs/how-to/trace-durable-workflow.md` (lines 63-84) fails with `ERESOLVE`:
    `sdk-trace-node@2.12.1` peers `api <1.10.0`, while `exporter-trace-otlp-http@0.301.2` peers `api ^1.10.0`.
  - `new BatchSpanProcessor(exporter)` (positional, as in `docs/how-to/tee-agent-runs.md` lines 27-28 and 54-55)
    throws `TypeError: Cannot read properties of undefined (reading 'export')` on flush under 3.x.
  - [Phoenix-otel 3.1.0](https://github.com/Arize-ai/phoenix/releases) (2026-11-17) notes the same failure mode.
- Working 3.x form:
  - `TracerProvider` from `@opentelemetry/sdk-trace`, then `trace.setGlobalTracerProvider(provider)`. There is no `register()`.
  - `context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())` from `@opentelemetry/context-async-hooks`.
  - `new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url }) })`.
  - Sent to `coding.sh collector --port 14399` (from source, temp `CODING_SH_HOME`), this produced a session:
    agent `research-app`, model `claude-x`, 120 input and 30 output tokens.
- Other places with the 2.x shape:
  - `apps/site/src/pages/docs/otel.astro` lines 214-226;
  - `docs/PRODUCTION.md` ~805;
  - the comment in `src/otel/receiver.ts` lines 41-43 and 82.
- `scripts/e2e/agent-runs-capture.mjs` pins `sdk-trace-base@2.2.0`, so it is unaffected.

### 3.4 Claude Code v2.1.326 (2026-11-16)

[Release](https://github.com/anthropics/claude-code/releases/tag/v2.1.326):

- `OTEL_RESOURCE_INCLUDE_HOST` adds `host.name` and `host.id` to the OTel resource. It is off by default.
  `src/otel/map.ts` does not read `host.*` for agent sessions; only `src/otel/durable.ts:166` does.
- A fix: PreToolUse hooks from managed settings now leave an OTel `tool_decision` event.
- A fix: parallel MCP calls no longer read another call's persisted result. Sessions captured before this may show wrong tool results.
- "Changed a hook's `"decision": "block"` to hold in more cases".
- Plan-mode auto compaction uses the answering model, so it can cost more.
- Bash delete and overwrite commands are no longer summarized as read or search.
- No new hook events. The docs list 33 events.
  - Common fields: `prompt_id` (equal to OTel `prompt.id`), `scratchpad_dir` (2.1.257+), `effort {level}` on tool events, `permission_mode`.
  - UserPromptSubmit also sends `session_title` when the session has one.

### 3.5 Codex rollouts: the item path (real data, no bug)

- [Entire nightly 2026-11-16](https://github.com/entireio/cli/releases) reworked its Codex adapter for
  `item_completed` UserMessage and AgentMessage items (commits 3cffd5087, 502bc7912, fc319343b).
- Read-only scan of 164 real rollouts (cli 0.144.2 to 0.167.1):
  - 162 use the items path and 161 carry a UserMessage item.
  - The one with AgentMessage items but no UserMessage item is a `thread_spawn` subagent with inherited history. The existing `agent_message` fallback handles it.
- Not a bug for us. Unhandled record types seen, each harmless today: `world_state`, `thread_settings_applied`,
  `inter_agent_communication_metadata`, `realtime_item`, and `additional_tools` on response_item.
- Codex [rust-v0.168.0](https://github.com/openai/codex/releases/tag/rust-v0.168.0) (2026-11-13):
  - #58829: agent follow-ups go through native turn input.
  - #59479: `agents.enabled`.
- 0.169.0 also has:
  - #59778: acceptance metadata and code-cell links in rollout traces.
  - #59785: decouples message lifecycle from item ids.
- Alphas 0.171.0-alpha.6 to .12 came out 2026-11-15 to 11-17. No stable 0.170 exists (`releases/tags/rust-v0.170.0` returns 404).

### 3.6 Other agents

| Agent | Latest | Date | Relevant to us |
| --- | --- | --- | --- |
| OpenCode | [v1.19.6](https://github.com/anomalyco/opencode/releases/tag/v1.19.6) | 2026-11-17 | Desktop now offers the upgrade to 2.0 ("Plugins made for OpenCode 1 need an update"). Doctor already flags a plugin built for the wrong API. Image history is capped at 25 MiB. |
| Copilot CLI | [1.0.113](https://github.com/github/copilot-cli/blob/main/changelog.md) | 2026-11-17 | 1.0.113 adds the browserUse admin setting. 1.0.112 (11-13) warns that an untrusted folder skips workspace MCP, and counts AI credits on resume. |
| Goose | v1.59.2 | 2026-11-16 | Databricks fix only. |
| Gemini CLI | v0.68.0 / v0.69.0-preview.0 | 2026-11-10 | Nothing new. |
| Pi | v1.5.2 | 2026-11-10 | Nothing new. |
| Aider | v0.86.0 | (unchanged) | Nothing new. |
| Amp | [news](https://ampcode.com/news) | 2026-11-12 | Model selector replaces the Dial. Boxes, Portals and Spaces. No plugin API or `--stream-json` format change was announced. |
| Cursor | [changelog](https://cursor.com/changelog) | 2026-11-06 | Voice chat and live apps. The Agent SDK (10-20) keeps "a complete record of every message and tool call" per conversation; watch whether it gets a file format we can read. No hook changes. |
| Droid | (not checked) | | docs.factory.ai did not resolve. |

### 3.7 Specs

- **OTel GenAI semconv:** no commits in the GenAI area since 2026-11-06 (#692, #513 `gen_ai.request.stream`, #635
  `gen_ai.client.invoke_agent.duration`, #634, …). Core semconv v1.45.0 came out 2026-11-02. #634 still stands:
  content attributes are structured AnyValue, and there is no JSON-string fallback (see the round-2 table above).
- **MCP:** no spec release since 2026-07-28.
  - A blog post (modelcontextprotocol#3541, 2026-11-11) sets a six-month release cadence (SEP-3398). The next spec targets 2027-03-30.
  - #3565 (11-17) aligns the extensions overview with SEP-3392.
  - #3515 is a blog post on the file upload and download extension.
  - Nothing for us to change now.

## Competitors

| Product | Release | Date | What changed |
| --- | --- | --- | --- |
| Langfuse | [v4.81.0, v4.82.0](https://github.com/langfuse/langfuse/releases) | 2026-11-16, 11-17 | Native OTel events get model pricing and enrichment (#19959), normalized provider identity (#19960), reconstructed provider input and output (#19961), and normalized usage plus supplied costs (#19962). Also: Gemini evaluators, Topics maps, a dataset item status filter, and eval connections that pause on 429 (#20289). |
| Judgment Labs | [judgeval v1.9.0, v1.9.1](https://github.com/JudgmentLabs/judgeval/releases) | 2026-11-16, 11-17 | Conversation observations without traces (#847), native MCP call capture (#844), external judges and feedback (#843), and function judges that grade whole conversations (#852, #854). |
| Arize Phoenix | phoenix-otel 3.1.0, client 8.0.1, cli 1.22.1 | 2026-11-17 | Moved to OTel JS 3 (sampler, spanLimits, env-var warnings). |
| Entire | nightly | 2026-11-16 | Streaming Codex rollout adapter on the item path (see 3.5). |
| Harbor / Terminal-Bench | v0.26.0 | 2026-11-13 | No newer release. |
| Braintrust | 3.44.0 | 2026-11-11 | Unchanged since round 2. |
| W&B Weave | v0.54.1 | 2026-11-05 | Unchanged. |
| LangSmith SDK | v0.14.9 | 2026-10-15 | Unchanged. |
| git-ai | v1.7.6 | 2026-11-05 | Unchanged. |

Langfuse's #19962 ("supplied costs") and our `coding_sh.cost_usd` overlap. When coding.sh tees to Langfuse,
the semconv cost attribute would show our cost there; check its name once Langfuse documents it.

## Watch list

- Codex 0.171 stable: whether any rollout record changes from the alphas land (`world_state`, `thread_settings_applied`).
- OpenCode 2.0 on Desktop: watch for doctor reports of v1 plugins left on a 2.x install.
- Claude Code: a `source` field on UserPromptSubmit (still missing). Lets us drop the scheduled and `/loop` prompt heuristics.
- Cursor Agent SDK session records: a possible new capture source.
- MCP 2027-03-30 spec: the extensions framework (SEP-3392) and file transfer.
- Langfuse cost attribute name for supplied costs.
