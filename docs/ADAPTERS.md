# Agent adapters: integration matrix (verified 2026-11-06)

Sources: official docs and agent source, plus a read-only review of git-ai, entireio/cli and
agent-beacon. Items marked **(U)** are unverified and must be checked against source before shipping.

Repository moves: OpenCode → `anomalyco/opencode` (2.x). Pi → `earendil-works/pi`. Goose →
`aaif-goose/goose`. Factory docs → docs.factory.com. Gemini CLI consumer tiers moved to Antigravity CLI
(`agy`) on 2026-06-18, so plan an `agy` adapter. Aider is stale (last release 2025-08), so it is tier C.

## Live capture

| Agent | Hook config | Events | Payload ids |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` / `.claude/settings.json` → `hooks.<Event>[{matcher:"*",hooks:[{type:"command",command,timeout}]}]` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart/Stop, PreCompact, SessionEnd | `session_id`, `transcript_path`, `cwd`. `model` only on SessionStart; otherwise take it from the transcript tail `message.model`. |
| Codex | `$CODEX_HOME/hooks.json` or `.codex/hooks.json` (Claude-shaped). `[features] hooks=true`. Our entries are appended after the user's, because trust is stored per position. | SessionStart/End, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Pre/PostModelRequest, Pre/PostCompact, SubagentStart/Stop, Stop | `session_id`, `turn_id`, `transcript_path` (null with `--ephemeral`), `cwd`, `model`. Subagents are threads: SubagentStart/Stop carry `agent_id` (and `agent_transcript_path`). |
| OpenCode 2.x | TS plugin `~/.config/opencode/plugins/<x>.ts`, `Plugin.define({setup(ctx)})` | `ctx.tool.hook("execute.before"/"execute.after")`; `ctx.event.subscribe`: `session.created/idle`, `session.tool.*`, `session.usage.updated` | `sessionID`, `model{providerID,id}`, `ctx.location.directory`. No transcript path. |
| Amp | TS plugin `~/.config/amp/plugins/x.ts`. The first line must be the `// @i-know-the-amp-plugin-api-is-wip…` marker. | `session.start`, `tool.call`, `tool.result`, `agent.start`, `agent.end`, `changes.prompt` | `thread.id` only. No cwd, no model, and no payload carries a subagent field. |
| Gemini CLI | `~/.gemini/settings.json` `hooks.BeforeTool[{matcher,hooks:[…]}]` (+ `tools.enableHooks`) | Before/AfterTool, Before/AfterAgent, Before/AfterModel, SessionStart/End, PreCompress | `session_id`, `transcript_path`, `cwd`. Model comes from `llm_request.model`. Before/AfterTool and BeforeModel also fire inside subagents, with the main `session_id` and no subagent field. |
| Cursor CLI (`agent`) | `~/.cursor/hooks.json` `{version:1,hooks:{postToolUse:[{command}]}}` | 21 events. We register no permission events (they block on empty output), so subagents come from `subagentStop` only: `subagentStart` is a permission gate and is not registered. **In `-p` mode, `stop` and `beforeSubmitPrompt` do not fire.** | `conversation_id`, `model`, `workspace_roots`. `transcript_path` is null in the CLI. |
| Copilot CLI | `~/.copilot/hooks/<x>.json` or `.github/hooks/*.json` `{version:1,hooks:{preToolUse:[{type:"command",bash,powershell,timeoutSec}]}}`. **The key is `bash`, not `command`.** The file has no ownership marker, so ownership is recorded in `~/.coding.sh/installs.json`. | sessionStart/End, userPromptSubmitted, pre/postToolUse, agentStop, subagentStart/Stop, preCompact | `sessionId`, `cwd`. `transcriptPath` only on agentStop/preCompact. No model. `subagentStart` has `agentName` but no `agentId`; `subagentStop` has `agentId`, `agentType`, `agentName`, `response`, `stopReason`. Hooks fired inside a subagent add `agentId`, `agentType`, `parentAgentId`. |
| Pi | Extension `~/.pi/agent/extensions/x.ts`. Project extensions need trust, or `--approve` headless. | `session_start/shutdown`, `tool_call/result`, `agent_settled` (the true end of a run), `model_select` | `ctx.sessionManager.getSessionFile()/getSessionId()`, `ctx.model`. No subagents. Per-call latency comes from `message.timestamp` to `message_end`. |
| Factory Droid | `~/.factory/hooks.json` (falls back to `settings.json` hooks), Claude-shaped | Claude's events, except there is no SubagentStart | `session_id`, `transcript_path`, `cwd`. Model from the `<id>.settings.json` sidecar. SubagentStop has `task_name`, `task_result`, `task_error`, `stop_hook_active`. |
| Goose | Plugin `~/.agents/plugins/<n>/hooks/hooks.json` | 12 events, including SessionStart/End, Stop, Pre/PostToolUse, AfterFileEdit. No SubagentStart/Stop. | `session_id`, `working_dir` (tool events only). No model. Hooks inside a subagent carry the child `session_id`. (U: payload) |
| Cline CLI | One executable per event in `~/.cline/hooks/<Event>`. **Must print `{"cancel":false}` on stdout.** | TaskStart/Resume/Complete/Error, Pre/PostToolUse, UserPromptSubmit, SessionShutdown | `taskId`, `workspaceRoots`. `model.{slug,provider}` (U) |
| Kiro CLI v3 | `~/.kiro/hooks/*.json` | SessionStart/End, UserPromptSubmit, Pre/PostToolUse, Stop, File* | `session_id`, `cwd`. Workspace trust required. |
| Qwen Code | `~/.qwen/settings.json`, Claude-shaped | Claude events + PostToolBatch, Todo*, FileChanged | `session_id`, `transcript_path`, `cwd`. **Unapproved project hooks are dropped headless.** |
| Crush | `crushrc` or JSON `hooks` key | Pre/PostToolUse, Session*, TurnStart/End | `session_id`, `cwd`. Subagents fire no hooks. |
| Antigravity CLI (`agy`) | `~/.gemini/config/hooks.json` or `.agents/hooks.json` | SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop | Transcript: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`. |
| Aider | None | — | — |
| T3 Code | None of its own. Its Codex and Claude runs fire the codex/claude-code hooks. | Those agents' events | The hook records T3's env marker as `host`: `T3CODE_THREAD_ID` (Claude Agent SDK) or `CODEX_INTERNAL_ORIGINATOR_OVERRIDE="T3 Code"` (`codex app-server`). |

## Transcripts, headless runs, isolation

| Agent | History | Headless | Isolation and overlay | Tier |
|---|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl` + `subagents/agent-*.jsonl` | `claude -p --output-format stream-json --verbose --model M --permission-mode bypassPermissions --max-turns N --max-budget-usd X --session-id U` | `CLAUDE_CONFIG_DIR`, `--settings <json>`, `--setting-sources project`, `--strict-mcp-config --mcp-config`, `--append-system-prompt`, `--plugin-dir`. `--bare` skips user hooks and plugins. | A |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta`, `turn_context`, `response_item`, `event_msg`; schema churns) | `codex exec --json -m M -s workspace-write -C dir --skip-git-repo-check -o last.txt --ignore-user-config --dangerously-bypass-hook-trust` | `CODEX_HOME`, `-c k=v` (`model_instructions_file`, `developer_instructions`, `mcp_servers.*`). AGENTS.md, `.agents/skills`. | A |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` (`session_v2`, `session_message`, `session_part`) | `opencode run "…" -m prov/model --format json --auto --standalone` | `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`. **Use `--standalone`, or the shared server ignores your env.** OpenCode 2.x does not read CLAUDE.md. | A |
| Amp | Threads are server-side; local cache `~/.local/share/amp/threads/<T-id>.json` (U); `amp threads export` | `amp -x "…" --stream-json --mode M` | `--settings-file`, `--mcp-config <json>`. AGENTS.md, `.agents/skills`. | A (plugin) |
| Gemini CLI | `~/.gemini/tmp/<project-slug>/chats/session-*.jsonl` | `gemini -p "…" -o stream-json -m M --approval-mode=yolo --skip-trust` | `GEMINI_CLI_HOME`, `GEMINI_SYSTEM_MD=/path`. Max turns only via `model.maxSessionTurns`. | A |
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

## Subagents

How each agent marks a subagent, and where coding.sh pairs it with its parent:

| Agent | Spawned by | Child id and parent link |
|---|---|---|
| Claude Code | `Agent` tool | SubagentStart/Stop `agent_id`; transcript `subagents/agent-*.jsonl`. `SubagentStop` lacks `tool_use_id`. |
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
- **OpenCode 2.0** broke git-ai's and Entire's plugins. Pin the plugin to the V2 API and detect the version.
- **Copilot:** bash-only hooks fail on Windows, so provide `powershell` too. Token totals are written after hooks return, so read them at backfill.
- **Amp:** no session id in tool payloads. Correlate by `thread.id` from `session.start`.
- **Cross-cutting:**
  - Per-agent hook timeouts: never assume 30s, and keep the hook under 50 ms.
  - Windows path quoting.
  - Transcripts are often flushed after Stop, so debounce transcript reads at ingest.
  - Copy SQLite databases before reading (WAL locks).

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
