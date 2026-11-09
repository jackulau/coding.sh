# Agent adapters: integration matrix (verified 2026-11-06)

Sources: official docs and agent source, plus a read-only review of git-ai, entireio/cli and
agent-beacon. Items marked **(U)** are unverified and must be checked against source before shipping.

Repository moves: OpenCode → `anomalyco/opencode` (2.x). Pi → `earendil-works/pi`. Goose →
`aaif-goose/goose`. Factory docs → docs.factory.com. Gemini CLI consumer tiers moved to Antigravity CLI
(`agy`) on 2026-06-18. The `antigravity` adapter covers agy and was checked against agy 1.5.2 on real
sessions; `gemini-cli` stays for older Gemini CLI history. Aider is stale (last release 2025-08), so it is tier C.

## Live capture

| Agent | Hook config | Events | Payload ids |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` / `.claude/settings.json` → `hooks.<Event>[{matcher:"*",hooks:[{type:"command",command,timeout}]}]` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart/Stop, PreCompact, SessionEnd | `session_id`, `transcript_path`, `cwd`. `model` only on SessionStart; otherwise take it from the transcript tail `message.model`. |
| Codex | `$CODEX_HOME/hooks.json` or `.codex/hooks.json` (Claude-shaped). `[features] hooks=true`. Our entries are appended after the user's, because trust is stored per position. | SessionStart/End, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Pre/PostModelRequest, Pre/PostCompact, SubagentStart/Stop, Stop | `session_id`, `turn_id`, `transcript_path` (null with `--ephemeral`), `cwd`, `model`. Subagents are threads: SubagentStart/Stop carry `agent_id` (and `agent_transcript_path`). |
| OpenCode 2.x | TS plugin `~/.config/opencode/plugins/<x>.ts`, `Plugin.define({setup(ctx)})` | `ctx.tool.hook("execute.before"/"execute.after")`; `ctx.event.subscribe`: `session.created/idle`, `session.tool.*`, `session.usage.updated` | `sessionID`, `model{providerID,id}`, `ctx.location.directory`. No transcript path. |
| Amp | TS plugin `~/.config/amp/plugins/x.ts`. The first line must be the `// @i-know-the-amp-plugin-api-is-wip…` marker. | `session.start`, `tool.call`, `tool.result`, `agent.start`, `agent.end`, `changes.prompt` | `thread.id` only. No cwd, no model, and no payload carries a subagent field. |
| Gemini CLI | `~/.gemini/settings.json` `hooks.BeforeTool[{matcher,hooks:[…]}]` (+ `tools.enableHooks`) | Before/AfterTool, Before/AfterAgent, Before/AfterModel, SessionStart/End, PreCompress | `session_id`, `transcript_path`, `cwd`. Model comes from `llm_request.model`. Before/AfterTool and BeforeModel also fire inside subagents, with the main `session_id` and no subagent field. |
| Cursor CLI (`agent`) | `~/.cursor/hooks.json` `{version:1,hooks:{postToolUse:[{command}]}}` | 21 events. We register no permission events (they block on empty output), so subagents come from `subagentStop` only: `subagentStart` is a permission gate and is not registered. **In `-p` mode, `stop` and `beforeSubmitPrompt` do not fire.** | `conversation_id`, `model`, `workspace_roots`. `transcript_path` is null in the CLI. |
| Copilot CLI | `~/.copilot/hooks/<x>.json` or `.github/hooks/*.json` `{version:1,hooks:{preToolUse:[{type:"command",bash,powershell,timeoutSec}]}}`. **The key is `bash`, not `command`.** The file has no ownership marker, so ownership is recorded in `~/.coding.sh/installs.json`. | sessionStart/End, userPromptSubmitted, pre/postToolUse, agentStop, subagentStart/Stop, preCompact | `sessionId`, `cwd`. `transcriptPath` only on agentStop/preCompact. No model. `subagentStart` has `agentName` but no `agentId`; `subagentStop` has `agentId`, `agentType`, `agentName`, `response`, `stopReason`. Hooks fired inside a subagent add `agentId`, `agentType`, `parentAgentId`. On 1.0.107 `postToolUse` carries `toolCallId`, and `sessionStart.initialPrompt` repeats the first `userPromptSubmitted`. |
| Pi | Extension `~/.pi/agent/extensions/x.ts`. Project extensions need trust, or `--approve` headless. | `session_start/shutdown`, `tool_call/result`, `agent_settled` (the true end of a run), `model_select` | `ctx.sessionManager.getSessionFile()/getSessionId()`, `ctx.model`. No subagents. Per-call latency comes from `message.timestamp` to `message_end`. |
| Factory Droid | `~/.factory/hooks.json` (falls back to `settings.json` hooks), Claude-shaped | Claude's events, except there is no SubagentStart | `session_id`, `transcript_path`, `cwd`. Model from the `<id>.settings.json` sidecar. SubagentStop has `task_name`, `task_result`, `task_error`, `stop_hook_active`. Tool hooks carry no call id (1.6.0), so they pair through the transcript's `tool_use` id; `tool_response` is a JSON string. |
| Goose | Plugin `~/.agents/plugins/<n>/hooks/hooks.json` | 12 events, including SessionStart/End, Stop, Pre/PostToolUse, AfterFileEdit. No SubagentStart/Stop. | `session_id`, `working_dir` (tool events only). No model. Hooks inside a subagent carry the child `session_id`. Payload checked on 1.57.0. |
| Cline CLI | One executable per event in `~/.cline/hooks/<Event>`. **Must print `{"cancel":false}` on stdout.** | TaskStart/Resume/Complete/Error, Pre/PostToolUse, UserPromptSubmit, SessionShutdown | `taskId`, `workspaceRoots`. `model.{slug,provider}` (U) |
| Kiro CLI v3 | `~/.kiro/hooks/*.json` | SessionStart/End, UserPromptSubmit, Pre/PostToolUse, Stop, File* | `session_id`, `cwd`. Workspace trust required. |
| Qwen Code | `~/.qwen/settings.json`, Claude-shaped | Claude events + PostToolBatch, Todo*, FileChanged | `session_id`, `transcript_path`, `cwd`. **Unapproved project hooks are dropped headless.** |
| Crush | `crushrc` or JSON `hooks` key | Pre/PostToolUse, Session*, TurnStart/End | `session_id`, `cwd`. Subagents fire no hooks. |
| Antigravity CLI (`agy`) | `~/.gemini/config/hooks.json` (shared by the agy CLI, App and IDE) or `.agents/hooks.json`. **A hook must print a JSON object on stdout**, so ours run with `--reply={}`. | SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop | camelCase: `conversationId`, `workspacePaths`, `transcriptPath`, `modelName` (often `"auto"`, which we drop), `lastUserInput` (wrapped in `<USER_REQUEST>`, which we strip), `toolCall{name,args}`, `stepIdx`, `error`, `invocationNum`, `terminationReason`. No tool output, tokens or cost; backfill fills those in. |
| Aider | None | — | — |
| T3 Code | None of its own. Its Codex and Claude runs fire the codex/claude-code hooks. | Those agents' events | The hook records T3's env marker as `host`: `T3CODE_THREAD_ID` (Claude Agent SDK) or `CODEX_INTERNAL_ORIGINATOR_OVERRIDE="T3 Code"` (`codex app-server`). |

## Transcripts, headless runs, isolation

| Agent | History | Headless | Isolation and overlay | Tier |
|---|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl` + `subagents/agent-*.jsonl` | `claude -p --output-format stream-json --verbose --model M --permission-mode bypassPermissions --max-turns N --max-budget-usd X --session-id U` | `CLAUDE_CONFIG_DIR`, `--settings <json>`, `--setting-sources project`, `--strict-mcp-config --mcp-config`, `--append-system-prompt`, `--plugin-dir`. `--bare` skips user hooks and plugins. | A |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta`, `turn_context`, `response_item`, `event_msg`; schema churns) | `codex exec --json -m M -s workspace-write -C dir --skip-git-repo-check -o last.txt --ignore-user-config --dangerously-bypass-hook-trust` | `CODEX_HOME`, `-c k=v` (`model_instructions_file`, `developer_instructions`, `mcp_servers.*`). AGENTS.md, `.agents/skills`. | A |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` (2.x: `session_v2`, `session_message`, `session_part`; 1.x: `session`, `message`, `part`) | `opencode run "…" -m prov/model --format json --auto --standalone` | `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`. **Use `--standalone`, or the shared server ignores your env.** OpenCode 2.x does not read CLAUDE.md. | A |
| Amp | Threads are server-side; local cache `~/.local/share/amp/threads/<T-id>.json` (U); `amp threads export` | `amp -x "…" --stream-json --mode M` | `--settings-file`, `--mcp-config <json>`. AGENTS.md, `.agents/skills`. | A (plugin) |
| Gemini CLI | `~/.gemini/tmp/<project-slug>/chats/session-*.jsonl` | `gemini -p "…" -o stream-json -m M --approval-mode=yolo --skip-trust` | `GEMINI_CLI_HOME`, `GEMINI_SYSTEM_MD=/path`. Max turns only via `model.maxSessionTurns`. | A |
| Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli/` (also `antigravity/`, `antigravity-ide/`): `brain/<id>/.system_generated/logs/transcript_full.jsonl` (preferred; `transcript.jsonl` cuts long fields) plus `conversations/<id>.db`. Transcript rows: `step_index`, `type` (USER_INPUT, PLANNER_RESPONSE, GENERIC, ERROR_MESSAGE, …), `status`, `tool_calls[{name,args}]` with string args; each tool result is the GENERIC row after its planner step. **Failed tool steps are left out of the transcript**; the DB `steps.status` (7 error, 6 canceled, 12 interrupted) and `error_details` mark them. The DB `gen_metadata` protobuf has model, uncached input, output, cache read/write, provider, time to first token and stream time per model call; `executor_metadata` has the workspace. We copy the DB with its WAL before reading. | `agy -p "…" --output-format stream-json --model M --dangerously-skip-permissions` (U: not run here) | `--settings <json>` (not saved), `--sandbox`, `--add-dir`. | A |
| Cursor CLI | `~/.cursor/projects/<sanitized>/agent-transcripts/<id>.jsonl` (format undocumented) | `agent -p --output-format stream-json --force --model M --trust --approve-mcps --workspace d` | `CURSOR_CONFIG_DIR`. `.cursor/rules`, AGENTS.md, `.cursor/mcp.json`. No max-turns flag. | B |
| Copilot CLI | `$COPILOT_HOME/session-state/<id>/events.jsonl` + `session-store.db` | `copilot -p "…" --output-format=json --model M --allow-all --no-ask-user --max-autopilot-continues N` | `COPILOT_HOME`, `--additional-mcp-config @f`, `--no-custom-instructions`. `.github/copilot-instructions.md`. | A |
| Pi | `~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl` (v3 tree, `id`/`parentId`) | `pi -p "…" --mode json --provider P --model M --approve` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `--system-prompt`, `--append-system-prompt` | A |
| Factory Droid | `~/.factory/sessions/-<cwd>/<uuid>.jsonl` + `.settings.json` | `droid exec "…" -m M -o stream-json --auto high --cwd d` | Override `HOME` (no env var of its own), `--settings f`, `--append-system-prompt-file` | A |
| Goose | SQLite `~/.local/share/goose/sessions/sessions.db` | `goose run -t "…" --output-format stream-json --max-turns N --provider P --model M --system S -q` | `GOOSE_PATH_ROOT` + `HOME` | A |
| Cline CLI | `~/.cline/data/sessions/<id>/*.json` + SQLite index | `cline "…" --json -m M -t <sec>` | `CLINE_DIR`, `--data-dir`, `-s <system>` | A |
| Kiro CLI | SQLite under `~/.kiro/` (U) | `kiro-cli chat --no-interactive --trust-all-tools --v3 --output-format stream-json --model M "…"` | `KIRO_HOME`, `.kiro/steering` | B |
| Qwen Code | `~/.qwen/projects/<cwd>/chats/*.jsonl` | `qwen -p "…" -o stream-json -m M --yolo --max-session-turns N --max-wall-time 10m` | `QWEN_HOME`, `--system-prompt`, `QWEN_SYSTEM_MD` | A |
| Crush | SQLite `./.crush/crush.db` | `crush run -q -y -m prov/model -c cwd -D datadir` (text output only) | `CRUSH_GLOBAL_CONFIG`, `CRUSH_GLOBAL_DATA` | B |
| Aider | `.aider.chat.history.md` (markdown, no session id). Usage from its `Tokens: … sent, … received` and `Cost: $… message, $… session` lines. | `aider -m "…" --yes-always --no-auto-commits --model M --no-stream --no-pretty` | `-c file`, `--read CONVENTIONS.md` | C |
| T3 Code | SQLite `$T3CODE_HOME/userdata/statev2.sqlite` (default `~/.t3`; `orchestration_v2_projection_*`), v1 `state.sqlite`. Read as copies. | None (desktop GUI) | — | B |

**History on read.** Before `coding.sh init` installs its hooks, a read (`usage`, `sessions`,
`show`, `ui`) imports Claude Code's transcripts already on disk, so `coding.sh usage` works with no
setup and shows all of your history. Once the hooks are installed, live capture and the spool take
over and the transcripts are not re-read on every read (an explicit `ingest --backfill` still does).
Imports key on the session id, so running `init` later never doubles a session. Codex does the same,
but only for the narrow window after `init` while its hooks are untrusted or disabled (see below).

## Subagents

How each agent marks a subagent, and where coding.sh pairs it with its parent:

| Agent | Spawned by | Child id and parent link |
|---|---|---|
| Claude Code | `Agent` tool | SubagentStart/Stop `agent_id`; transcript `subagents/agent-*.jsonl`, with its `description` in the `.meta.json` sidecar. `SubagentStop` lacks `tool_use_id`. Internal forks (the compaction summarizer, prompt suggestions) fire a `SubagentStop` with an empty `agent_type` and no transcript; coding.sh records no session for them. Some agents (`web-fetch`) fire no SubagentStart or SubagentStop: the parent's `PostToolUse` for the `Agent` call carries `agentId`, `agentType`, `content`, `resolvedModel` and `totalDurationMs`, which link and end the child. A fork (`subagent_type: "fork"`; the sidecar has `isFork: true` and the parent's `toolUseId`) opens its transcript with the parent's context: every parent entry copied with its uuid and `message.id`, or a `fork-context-ref` line and a copy of the parent's Agent call. Its own entries start at the user entry with the `tool_result` for `toolUseId` ("Fork started"). coding.sh skips everything before that entry (backfill and live windows), opens the fork's turn with the Agent call's `prompt`, and records how much context it inherited (`stats.inheritedTokens`). Without that entry the transcript is read whole. |
| Codex | Threads | SubagentStart/Stop `agent_id`. |
| Gemini CLI | `invoke_agent` tool `{agent_name,prompt}` | Child chat `chats/<parentSessionId>/<agentId>.jsonl` with `kind:'subagent'` and `sessionId == agentId`; the parent's `toolCalls[].agentId` names the child file. Hooks inside it carry the main `session_id`. |
| Amp | `Task`, `oracle`, `librarian`, `finder` tools; `create_thread` makes child threads | No payload carries a subagent field. |
| Factory Droid | `Task` tool: `subagent_type`, `description`, `prompt` (optional `image_paths`, `complexity`, `run_in_background`, `resume`) | SubagentStop only. |
| Goose | `delegate` tool (summon extension) | `sessions.db` `session_type='sub_agent'` and `parent_session_id`. Hooks inside carry the child `session_id`. |
| Copilot CLI | Subagent tools | `subagentStart` `agentName`; `subagentStop` `agentId`; hooks inside add `agentId`, `parentAgentId`. `events.jsonl` has `subagent.started/completed/failed` keyed by `toolCallId`. |
| Antigravity | `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents` tools | From the brain transcript. |
| Cursor CLI | Subagent tool | `subagentStop` only (`duration_ms`). |
| Pi | None | — |

Harness surfaces:
- `AGENTS.md` is read by nearly every agent.
- Per-agent instruction files: CLAUDE.md, GEMINI.md, QWEN.md, `.cursor/rules/*.mdc`, `.github/instructions/**`, `.clinerules/`, `.kiro/steering/`, `.goosehints`, CRUSH.md.
- `.agents/skills` is close to a universal skills directory. Claude Code uses `.claude/skills` instead.

## Replay

`coding.sh replay` rebuilds the files a session touched from its tool calls (see
[Explore](guides/explore.md#replay)). What each agent's capture gives it, checked on the fixtures in
`test/fixtures/adapters` by `test/core/replay.test.ts`:

| Agent | Content known from | Left unknown |
|---|---|---|
| Claude Code | Write content, Edit and Write `originalFile`, Read output (numbered lines), diffs it records for shell changes. | Nothing in the fixtures. |
| Codex | `apply_patch` Add File, reads with `cat`. | A patched file no step showed first. |
| Copilot CLI, Droid, OpenCode, Pi, Goose | Write and create inputs, the recorded diff of a new file, reads. | An edit to a file no step showed first. |
| Cursor CLI | Reads, then `afterFileEdit` edits. | An edit to a file no step showed first. |
| Gemini CLI, Amp | Writes and reads. | An edit to a file no step showed first. |
| Antigravity | Transcript edits that carry `TargetContent`. | Hook edits, which record only the new text. |
| Wrapper (any CLI) | Nothing: it records only which files changed. | Every changed file. |

## Host apps (T3 Code)

T3 Code drives other agents: Codex, Claude Code, OpenCode, Cursor, Pi, Grok and ACP agents. coding.sh keeps
one session per provider thread, keyed by the provider's native id. A T3-run Codex rollout or Claude transcript
is therefore the same session the codex and claude-code adapters import, with no duplicates in either import
order.

- **Attribution:** a session is attributed to T3 Code when any of its events has `payload.via = "t3code"`.
  The sources are the T3 adapter's `host-link` notification, the hook's env marker, or a Codex
  `session_meta.originator` of "T3 Code". The session then gets `agent: "t3code"`, and `provider` names the
  agent T3 ran.
- **Content by provider:**
  - Codex and Claude: content comes from their own transcripts.
  - OpenCode, Cursor and Pi: linked only. Their adapters import the content.
  - Other providers: content is built from T3's store, with per-turn usage from `turnTokenUsage`. T3
    counts cache reads and writes inside `inputTokens`, and coding.sh separates them.
- **Session tree:** a thread's first provider thread is the top-level session. A provider switch or a T3
  subagent thread becomes a child session.
- **Cost:** T3's running cost (`contextUsage.cost`) is kept as `reportedUsage` and never summed.
- **When imports run:** the T3 store is re-imported on every lazy ingest (`Adapter.tail`). Threads that
  haven't changed are skipped.

## Known breakage to design around

- **Codex:** new hooks fire only once the user trusts them by hash, and `codex exec` skips untrusted hooks silently. Eval runs pass `--dangerously-bypass-hook-trust`. For user installs, `doctor` reports untrusted hooks and tells the user to run `/hooks`. Never write trust hashes ourselves.
- **Codex:** `-s read-only` fires no hooks. SessionEnd has a 1s default and a 3s hard cap. The sandbox blocks network from hooks (spool-to-file is safe). Tool names `shell_command`/`apply_patch` changed upstream, so normalize defensively.
- **Claude Code:** the model reads as unknown when large tool results fill the transcript tail; scan backwards further. `SubagentStop` lacks `tool_use_id`. Old `Task` matchers never fire; use `Agent`.
- **Claude Code:** files a Bash command edits (`sed -i`, heredoc writes, `tee`) are in the tool result's `toolUseResult.bashEditDiff` (per-file hunks, plus `changedFiles` past the first few), which becomes `file.change`. It is on by default only in auto and bypass-permissions modes; `CLAUDE_CODE_BASH_EDIT_DIFF=true` or the `bashEditDiffEnabled` setting turns it on elsewhere. The diff lists every file that changed while the command ran, including ones it never touched (a `git rebase`, a test run's output, another agent in the same checkout), so `test-tamper` only counts a file the command names.
- **Claude Code:** context loaded mid-session is only in transcript `attachment` lines, never in hooks: `nested_memory` (a subdirectory's CLAUDE.md), `dynamic_skill` (a nested `.claude/skills` became available) and `invoked_skills` (skills restored after a compaction). A Skill call's "Base directory for this skill" line names the skill's folder. Each becomes a `notification` with `payload.kind: "harness.loaded"` and `loadedBy`, paths and skill names (never the text). Live windows read them too; the attachment's uuid keys the event, so backfill and live capture store it once.
- **Claude Code:** a model fallback is only in the transcript, as a `system` line. `model_fallback` (`originalModel`, `fallbackModel`, `trigger` such as `overloaded`, `direction`) is written when the main model kept failing and Claude Code moved to `--fallback-model` for the rest of the turn; `model_refusal_fallback` is written when a refusal was routed to another model. Each becomes a `notification` with `payload.kind: "model.fallback"`, tags the session `model:fallback`, and makes the model change around it a `model:switch`, the switch back on the next turn included. Live windows read them too, keyed by the line's uuid. Verified by `scripts/e2e/claude-fallback-capture.mjs` (Claude Code 2.1.319, a stub model that answers 529 overloaded); the stub cannot make the API route a refusal, so 2.1.319 writes `model_refusal_no_fallback` there and the `model_refusal_fallback` tests build the record by hand in the same shape.
- **Headless or interactive:** Claude Code writes `entrypoint` on every transcript line and sets `CLAUDE_CODE_ENTRYPOINT` in hooks (`sdk-cli` for `claude -p`, `sdk-ts` and `sdk-py` for the Agent SDKs, `cli` in a terminal, `claude-vscode` in the IDE extension); the hook records it on the spool line and both copies of `session.start` carry it. Codex says it only in the rollout's `session_meta` (`originator` `codex_exec` or `codex_cli_rs`, `source` `exec`, `cli`, `vscode`, `mcp`), so a hook SessionStart reads the rollout's first line for it. Either becomes `stats.launch`.
- **Claude Code:** what other hooks add to the context is also only in transcript attachments. `hook_success` holds one hook run (its `command`, `stdout` and `content`); its `content` reached the model when the entry has `rendered` text (plain stdout of a SessionStart or UserPromptSubmit hook). `hook_additional_context` holds the `additionalContext` strings hooks answered, with no command; the `hook_success` whose stdout JSON holds the same string names it. Claude Code 2.1.319 writes no `hook_success` for a UserPromptSubmit hook, so its context has source `unknown`. Each text becomes a `notification` with `payload.kind: "hook.context"` (`hookEvent`, `hookName`, `hookSource`, `command`, `chars`, `tokens`, `text`). The command is recorded unexpanded (`node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`), so the plugin's name comes from the plugins installed in the transcript's config dir (`plugins/installed_plugins.json` and each plugin's `hooks/hooks.json`) when the transcript is parsed: a plugin since uninstalled, or loaded with `--plugin-dir` only, is `plugin`. A Stop window also reads the hook attachments written before its prompt, so a SessionStart's context is captured live.
- **Tool output the harness cut:** a hook sees the output a tool produced; the model gets what the
  harness passes on, which can be shorter. Codex 0.167.0 cuts a long `exec_command` or code-mode
  cell result to its head and tail (`Warning: truncated output (original token count: N)`, then
  `…N chars truncated…` or `…N tokens truncated…` in the middle). Claude Code 2.1.319 saves a large
  result to a file and sends `<persisted-output>Output too large (1.2MB). Full output saved to:
  <path>` with a 2 KB preview. Backfill reads these from the rollout's `function_call_output` and the
  transcript's `tool_result` and puts `payload.cut` on `tool.end`: `by` (`codex-head`, `middle`,
  `persisted`, `lines` or `marker`), `originalTokens` or `originalBytes`, `cutTokens` or
  `cutChars`, `omittedLines`, `deliveredBytes`, `savedTo`, and `jsonBroken: true` when the body was
  JSON and no longer parses. Hook events carry no `cut`, and where a hook already recorded the call,
  ingest keeps the hook's `tool.end`, so today `cut` shows in sessions imported by backfill. Verified by
  `scripts/e2e/codex-cut-capture.mjs` and `scripts/e2e/claude-edge-capture.mjs`.
- **Model API proxy** (`init --proxy`): Claude Code 2.1.319 sends `x-claude-code-session-id` on every
  call (older versions: `metadata.user_id`), and Codex 0.167.0 sends `session-id`/`thread-id` (its
  thread id), so proxy calls join the hook session. Codex 0.167.0 sends its system prompt as leading
  `developer` items in `input`, not `instructions`. Codex signed in with ChatGPT sends
  `chatgpt-account-id`, and the proxy forwards it to the ChatGPT backend. Verified by
  `scripts/e2e/proxy-capture.mjs`.
- **OpenCode 2.0** broke git-ai's and Entire's plugins. Pin the plugin to the V2 API and detect the version.
- **Copilot:** bash-only hooks fail on Windows, so provide `powershell` too. Token totals are written after hooks return, so read them at backfill.
- **Amp:** no session id in tool payloads. Correlate by `thread.id` from `session.start`.
- **Cross-cutting:**
  - Per-agent hook timeouts: never assume 30s, and keep the hook under 50 ms.
  - Windows path quoting.
  - Transcripts are often flushed after Stop, so debounce transcript reads at ingest.
  - Copy SQLite databases before reading (WAL locks).
  - Backfill follows symlinks and Windows junctions in transcript directories (a mirror of another
    machine's `~/.claude/projects`, say) and skips links that point nowhere.

## Hook command

Every adapter installs the same command:

```
node "<~/.coding.sh/bin/hook.mjs>" <agent-id> <EventName>
```

- The command path is quoted.
- Each entry is tagged with a marker (`"_codingsh": true` where JSON allows, or a `# coding.sh` comment
  in TOML) so `uninstall` removes only our entries. Where the format has no room for a marker,
  Cursor entries are recognized by their command, and a Copilot hook file coding.sh created is
  recorded (path and content hash) in `~/.coding.sh/installs.json`.
- Edits preserve comments and formatting where the format allows, and back up the original to
  `~/.coding.sh/backups/<agent>/<ts>-<file>`.
- Cline needs stdout `{"cancel":false}` (`--echo` flag).

## API apps and agents in production

Apps in production don't use an adapter. They send data over the network to `coding.sh serve`
([PRODUCTION.md](PRODUCTION.md)), which writes to the configured store (`sqlite://` or `postgres://`).

| Source | Route | Mapping | `source` on events |
|---|---|---|---|
| `@codingdotsh/sdk` (TS) and `coding-sh` (Python): `observe(client)` for OpenAI and Anthropic, `observeFetch()`, AI SDK tracer | `POST /v1/ingest` (native `AgentEvent` batches) or `POST /v1/traces` | `src/server/native.ts`. The `service` name becomes `agent`, ids are namespaced by project. | `sdk` |
| Any OpenTelemetry SDK: gen_ai semconv, OpenInference, AI SDK `experimental_telemetry` | `POST /v1/traces` | `src/otel/map.ts`, the same mapper as `coding.sh collector` | `otel…` |
| Vercel AI Gateway trace drain | `POST /v1/traces` | `src/otel/map.ts` plus the gateway enricher | `otel…` |
| Claude Code, Codex and Gemini CLI running remotely with OTel logs on | `POST /v1/logs` | `src/otel/map.ts` log events | `otel…` |

- Hooks, transcript backfill and `coding.sh run` stay local. Serve does not take spool lines.
- The ingest key picks the project, and session ids are stored as `<project>/<sessionId>`.
- SDK sessions that never send `session.end` have no `endedAt` yet; see the open item in
  `tasks/research-queue.md` (Production mode).
