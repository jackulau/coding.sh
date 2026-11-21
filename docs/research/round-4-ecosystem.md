# Round 4: ecosystem changes (2026-11-17 to 2026-11-20)

Scout: ecosystem. Baseline: [round-3-ecosystem.md](round-3-ecosystem.md), dated 2026-11-17.
Competitor gaps already filed in `D:/cs/research/competitors.md` (CG-1 to CG-13: plan quota,
online evaluators, spend budgets, alerts, cost by MCP, skill or subagent, live board, review
queue, MCP tool description drift, Langfuse-compatible OTel, `/metrics` cost, saved views,
viewer comments, batch scores) are not repeated here.

## Method

- Read the GitHub releases of each agent from 2026-11-17 on, with `gh api`, and the PRs behind
  the lines that touch hooks, transcripts, OTel or session storage.
- Read the vendor release notes pages where a project has no GitHub releases (Cursor, Amp).
- Compared each change with `docs/ADAPTERS.md` and with the adapter source in
  `packages/coding.sh/src/adapters`.
- No agent CLI was run. No repo code was run. No code was changed.
- Not checked: Factory Droid. `docs.factory.ai` and `docs.factory.com` did not resolve
  (ENOTFOUND) from this machine. `cursor.com/changelog` also did not resolve; the release notes
  page at `cursor.com/docs/release-notes` did.

## Round 3 open items: status

| Item | Status on improve/r4-desktop |
| --- | --- |
| Codex `--trust` for hooks | Done (`src/adapters/codex.ts`, around line 1058). |
| OTel JS 3 docs | Done. |
| 3.2 `<pasted_content>` markers become titles | Open. `pasted_content` still appears nowhere in `src`; `SYNTHETIC_PROMPT` in `src/core/sessions.ts` does not cover it. Claude Code 2.1.329 now marks pasted text on more setups, so the problem reaches more users. |
| Claude PostCompact, PostToolBatch, model switch hooks | Open. `CLAUDE_HOOK_EVENTS` in `src/adapters/claude-code.ts` still has 12 events. |
| 1.4 Cursor subagent transcripts become orphans | Open, and now confirmed by Cursor's own notes (see Cursor below). |
| Tool arguments as structured values (semconv #634) | Open. `content()` in `src/sinks/otlp.ts` still calls `JSON.stringify`. |

## Agents

### Claude Code

Releases: v2.1.327 (2026-11-17), v2.1.328 (2026-11-19), v2.1.329 (2026-11-19).
Source: <https://github.com/anthropics/claude-code/releases>. The hooks page still lists 33
events: <https://code.claude.com/docs/en/hooks>.

- 2.1.329: a managed PostToolUse hook no longer fires for a call that was refused before it ran.
  PostToolBatch now gets most of those calls. coding.sh does not register PostToolBatch, so a
  refused call seen only by the hook stays open until the transcript backfill closes it.
- 2.1.329: pasted text is now marked as pasted on third-party providers and with telemetry off.
  This widens round-3 item 3.2.
- 2.1.329: Code Mode runs with OTel events on, and each tool call inside it sends its own events.
  The OTLP receiver should see more `tool_result` log records per session than before.
- 2.1.328: spinner and subagent token counts no longer count retries twice. This is display
  only; transcripts are unchanged.
- 2.1.328: a failing SubagentStop or SessionEnd hook is now shown to the user. Our hook exits 0,
  so this matters only if it ever fails.
- 2.1.328: one malformed `OTEL_RESOURCE_ATTRIBUTES` entry no longer drops the other labels.
  `claude doctor` warns when an OTel exporter has no endpoint.
- 2.1.328: `onFailure: block` for `mcp_tool` hooks, and `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME`.
- 2.1.327: `claude mcp add-json <name> -` reads JSON from stdin. A fix stops `.mcp.json` losing
  other keys. A fix stops `/statusline` writing `~/.claude/settings.json` when
  `CLAUDE_CONFIG_DIR` is set.

### Codex

Releases: rust-v0.170.0 (2026-11-18), rust-v0.171.0 (2026-11-20).
Source: <https://github.com/openai/codex/releases>.

- Model request hooks now carry `request_id` and `attempt_number` (openai/codex#61587, merged
  2026-11-15, shipped in 0.171). One lifecycle now covers sampling and compaction
  (openai/codex#61562).
- The hook schemas at rust-v0.171.0 include PreModelRequest, PostModelRequest, Interrupt,
  PermissionRequest and PostCompact. PostModelRequest carries `status`, `error`, `response_id`
  and `token_usage`. Every model request event also carries `kind`, `model`, `request_id` and
  `attempt_number`.
- `src/adapters/codex.ts` says, in its header comment, that Codex has no per-call timing in
  hooks, so `llm.call` events come from the rollout at Stop time. With a shared `request_id` on
  Pre and Post, the hook can now time each request and count retries. `CODEX_HOOK_EVENTS` does
  not register either event, though `MATCHERLESS` already names them.
- Rollout traces are now stored in zstd shards, trace schema v3 (openai/codex#61222), with
  storage limits (openai/codex#61896). This is the separate trace store, not the rollout JSONL
  that the adapter reads. Watch it: if rollouts move to the same store, backfill breaks.
- MCP statusline providers (openai/codex#61248, #61249, #61979), behind
  `tui_extensions_statusline`. The provider tool must return a single `ui://` resource; the
  snapshot arrives in `com.openai/codex-statusline-state` metadata. The snapshot gains
  `account.rate_limits` (#61417) and thread `total_cost_usd` and `total_credits` (#61410).
  This overlaps CG-1 (plan quota) and is not filed again.
- `codex exec --remote` (#61707). 0.170 refreshes the OTel HTTP exporter auth headers (#61028).

### OpenCode

Releases: v2.3.1 and v2.3.2 (2026-11-18).
Source: <https://github.com/anomalyco/opencode/releases>.

- Background compaction is on by default (anomalyco/opencode#64290). A summary that is never
  used still costs tokens. The adapter emits `context.compact` with `trigger: "auto"` for
  `session.compacted` and `session.compaction.ended`, so these now show up more often. No
  format change.
- Automations, behind a flag, can send prompts (#64160). Such a prompt looks like a user prompt
  in the session.
- v2.3.2 fixes uncached system prompts for GPT-6.2. Cache-read ratios on older sessions with
  that model will look worse than new ones.

### Gemini CLI

Releases: v0.69.0 and v0.70.0 (both 2026-11-19).
Source: <https://github.com/google-gemini/gemini-cli/releases>.

- google-gemini/gemini-cli#30204: tool calls are written to the session file when scheduled,
  updated in place, and cancelled calls are now recorded too. The adapter reads
  `status ?? "success"` and treats any other status as an error, so a cancelled or still
  scheduled call becomes a tool failure.
- Headless runs now exit with 130, 143 or 129 on SIGINT, SIGTERM or SIGHUP.
- #30186: the JSONL session file is written asynchronously. A read during a turn can see a
  partial last line; the shared JSONL reader already skips a bad last line.

### Goose

Releases: v1.60.0 (2026-11-17) to v1.60.2 (2026-11-20).
Source: <https://github.com/block/goose/releases>.

- block/goose#13566: PreToolUse now fires before approval. A denied call gets no PostToolUse.
  A hook-measured duration now includes the time the user took to approve.
- #13486: UserPromptSubmit also fires on reply, on steer, and when a subagent starts or resumes.
  Turn counts from hooks can rise.
- #13422: token counts are i64. No effect on JSON parsing.
- The adapter was verified against 1.57.0 (`src/adapters/more/goose.ts`).

### T3 Code

Release: v0.1.11 (2026-11-20).
Source: <https://github.com/pingdotgg/t3code/releases/tag/v0.1.11>.

- Adds an Antigravity driver. T3 runs agy with its own profile at
  `<stateDir>/providers/antigravity/<sha256(instanceId)>/antigravity-acp/conversations/<sessionId>.db`.
- `DRIVER_AGENT` in `src/adapters/t3code.ts` has no antigravity entry, and `NativeIndex` has no
  antigravity branch. The antigravity adapter looks only under `~/.gemini`
  (`AGY_PRODUCT_DIRS`). So a T3 Antigravity thread gets T3's own events and nothing from the
  native conversation: no model calls, no tokens.

### Cursor

Source: <https://cursor.com/docs/release-notes>.

- v2026.10.17: subagent transcripts are saved under `agent-transcripts/<parent>/subagents/`.
  `backfillCursor` walks to depth 4 and takes any `.jsonl` under `agent-transcripts`, so it finds
  these files and makes each one a top-level session with no parent. This confirms round-3
  item 1.4.
- 3.27: `parent_agent_id` on subagentStart and subagentStop. Hook payloads on Windows are clean
  UTF-8.
- 3.29 (week of 2026-11-09): `parent_agent_name`, and the parent turn's `generation_id`, on the
  same events.
- v2026.11.04: sessionStart has a `surface` field.
- v2026.11.17: prompt hooks can be set in the team dashboard.

### Others

- Copilot CLI 1.0.114 (2026-11-18): nothing that touches hooks or session files.
- Amp: a Windows app (2026-11-17) and Dial removed (2026-11-12). No format news.
  <https://ampcode.com/news>
- Pi v1.5.2 and Aider v0.86.0: no release since round 3.
- Droid: not checked.

## Specs

- MCP: no spec release since 2026-07-28. <https://modelcontextprotocol.io/specification>
- OTel GenAI semconv (<https://github.com/open-telemetry/semantic-conventions-genai>):
  - #733 (2026-11-19) sets the schema URL family
    `https://opentelemetry.io/schemas/semconv-genai-dev/X.Y.Z-dev`. A first release, 0.1.0, is
    planned. `SEMCONV_SCHEMA_URL` in `src/sinks/otlp.ts` is still core 1.37.0. Wait for 0.1.0
    before changing it.
  - #696 (2026-11-19) adds structured `gen_ai.prompt.variables`.
  - #721 (2026-11-18) clarifies the scope of `gen_ai.tool.definitions`.
  - Core semconv v1.45.0 is from 2026-11-02.

## Competitors

| Project | Release (date) | What changed | Gap for coding.sh |
| --- | --- | --- | --- |
| Arize Phoenix | v22.0.0 (2026-11-20) | Costs for DECISION and EMBEDDING spans. | None new. |
| Arize Phoenix | v21.3.0 (2026-11-20) | Dataset label CLI; Bedrock regional Claude prices (Arize-ai/phoenix#18052). | Check that our price table does not bill `us.anthropic.*` ids at the first-party rate. |
| Arize Phoenix | v21.2.1 | `phoenix-harbor` skill with task and verifier best practices (#17821). | Our eval skills could cite the same verifier checks; low priority. |
| Judgment Labs judgeval | v1.9.2 (2026-11-19) | Conversation targets for external judge feedback (#850). | Close to CG-13 (batch scores). |
| Judgment Labs judgeval | v1.9.3 (2026-11-19) | MCP injection controls (#859). | None new. |
| Langfuse | v4.83.0 (2026-11-19) | Covered by competitors.md. | |
| Braintrust 3.44.0, W&B Weave 0.54.1, LangSmith 0.14.9, git-ai 1.7.6, Harbor 0.26.0, Entire nightly 2026-11-16 | | No release since round 3. | |

Releases: <https://github.com/Arize-ai/phoenix/releases>,
<https://github.com/JudgmentLabs/judgeval/releases>.

## Candidates

1. Cursor backfill links subagent transcripts to their parent (`src/adapters/cursor.ts`).
2. Codex Pre and PostModelRequest hooks give per-call timing and retries (`src/adapters/codex.ts`).
3. T3 Code Antigravity threads read the T3-managed agy profile (`src/adapters/t3code.ts`).
4. The OTLP sink sends tool arguments and results as structured values (`src/sinks/otlp.ts`).
5. `<pasted_content>` markers no longer become session titles (`src/core/sessions.ts`).
6. Goose denied tool calls close as denied, not running (`src/adapters/more/goose.ts`).
7. Gemini CLI cancelled and scheduled tool calls are not tool failures
   (`src/adapters/more/gemini-cli.ts`).
8. Claude Code PostToolBatch closes calls refused before they ran
   (`src/adapters/claude-code.ts`).

## Watch list

- Codex trace store v3: if rollouts move into zstd shards, Codex backfill breaks.
- OTel GenAI semconv 0.1.0: move `SEMCONV_SCHEMA_URL` to the new family when it ships.
- Codex MCP statusline providers: a route for CG-1 once the feature flag is gone.
- Cursor `surface` on sessionStart: could tag sessions by surface (IDE, CLI, cloud).
- Droid: check its changelog next round.
