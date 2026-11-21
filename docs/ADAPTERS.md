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
| Codex | `$CODEX_HOME/hooks.json` or `.codex/hooks.json` (Claude-shaped). Hooks are on by default; doctor reports a `[features] hooks = false` line. Our entries are appended after the user's, because trust is stored per position. | SessionStart/End, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Pre/PostModelRequest, Pre/PostCompact, SubagentStart/Stop, Stop | `session_id`, `turn_id`, `transcript_path` (null with `--ephemeral`), `cwd`, `model`. Subagents are threads: SubagentStart/Stop carry `agent_id` (and `agent_transcript_path`). |
| OpenCode 2.x | TS plugin `~/.config/opencode/plugins/<x>.ts`, `Plugin.define({setup(ctx)})` | `ctx.tool.hook("execute.before"/"execute.after")`; `ctx.event.subscribe`: `session.created/idle`, `session.tool.*`, `session.usage.updated` | `sessionID`, `model{providerID,id}`, `ctx.location.directory`. No transcript path. |
| Amp | TS plugin `~/.config/amp/plugins/x.ts` (or `.amp/plugins/*.ts` in a project). Files there load with no opt-in marker. | `session.start`, `tool.call`, `tool.result`, `agent.start`, `agent.end`, `changes.prompt` | `thread.id` only. No cwd, no model, and no payload carries a subagent field. |
| Gemini CLI | `~/.gemini/settings.json` `hooks.BeforeTool[{matcher,hooks:[…]}]`. Hooks are on by default, with no setting to turn on. | Before/AfterTool, Before/AfterAgent, Before/AfterModel, SessionStart/End, PreCompress | `session_id`, `transcript_path`, `cwd`. Model comes from `llm_request.model`. Before/AfterTool and BeforeModel also fire inside subagents, with the main `session_id` and no subagent field. |
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
| Devin CLI | `config.json` `hooks` in Devin's config folder (`$DEVIN_CONFIG_HOME/devin`, else `%APPDATA%\devin` on Windows and `~/.config/devin` elsewhere), or `.devin/config.local.json` for one project. Devin also reads `.devin/hooks.v1.json` and `.devin/config.json` from the session's folder up to the project root, and runs Claude Code's hooks (`read_config_from.claude`, on by default). | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, PostCompaction, SessionEnd | `session_id` (a slug such as `brave-otter`), `prompt_id`. No cwd, model, transcript path or tool call id. Every hook gets `DEVIN_PROJECT_DIR`, the project root: the repository root, or the session's folder outside a repository. Seen on 3000.14.30821 without a login. |

## Transcripts, headless runs, isolation

| Agent | History | Headless | Isolation and overlay | Tier |
|---|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl` + `subagents/agent-*.jsonl` | `claude -p --output-format stream-json --verbose --model M --permission-mode bypassPermissions --max-turns N --max-budget-usd X --session-id U` | `CLAUDE_CONFIG_DIR`, `--settings <json>`, `--setting-sources project`, `--strict-mcp-config --mcp-config`, `--append-system-prompt`, `--plugin-dir`. `--bare` skips user hooks and plugins. | A |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta`, `turn_context`, `response_item`, `event_msg`; schema churns). Rollouts older than a week are `rollout-*.jsonl.zst`; backfill streams them through zstd and reads only the plain file when both exist. Line numbers, and so event ids, match the plain file; byte offsets are into the decompressed text | `codex exec --json -m M -s workspace-write -C dir --skip-git-repo-check -o last.txt --ignore-user-config --dangerously-bypass-hook-trust`. In its own `CODEX_HOME`, without `--ignore-user-config`, a run on a Codex whose `exec --help` lists `--trust` (0.169+) also passes `--trust`, so the project `.codex/config.toml` and MCP servers load; it writes no hook trust hash | `CODEX_HOME`, `-c k=v` (`model_instructions_file`, `developer_instructions`, `mcp_servers.*`). AGENTS.md, `.agents/skills`. | A |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` (2.x: `session_v2`, `session_message`, `session_part`; 1.x: `session`, `message`, `part`) | `opencode run "…" -m prov/model --format json --auto --standalone` | `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`. **Use `--standalone`, or the shared server ignores your env.** OpenCode 2.x does not read Claude Code's instructions file. | A |
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
| Aider | `.aider.chat.history.md` (markdown, no session id). Usage from its `Tokens: … sent, … received` and `Cost: $… message, $… session` lines. Live (`coding.sh run -- aider`): one `llm.call` per reply, with exact tokens and cost from Aider's analytics log (a temp file passed as `AIDER_ANALYTICS_LOG`, or the log you named with `--analytics-log`, the env var or `.aider.conf.yml`; a named log that two Aider sessions write at once counts both in each) and the cache split from the chat history's usage lines. `inputTokens` is the uncached part: Aider's "sent" counts cache reads once and cache writes twice. A cost of 0 (no price for the model) is stored as unknown. | `aider -m "…" --yes-always --no-auto-commits --model M --no-stream --no-pretty` | `-c file`, `--read CONVENTIONS.md` | C |
| T3 Code | SQLite `$T3CODE_HOME/userdata/statev2.sqlite` (default `~/.t3`; `orchestration_v2_projection_*`), v1 `state.sqlite`. Read as copies. | None (desktop GUI) | — | B |
| Devin CLI | SQLite `cli/sessions.db` in its sessions folder (`DEVIN_SESSIONS_DIR` moves it). Not read, so there is no backfill. | `devin -p --permission-mode dangerous --respect-workspace-trust false --model M --export f -- "…"`; usage from the `--export` file (ATIF). Without a login it waits at a login picker, so the run stops and says so. (U: not run with a login) | `DEVIN_CONFIG_HOME`, `DEVIN_SESSIONS_DIR`. Eval runs turn every `read_config_from` import off, set `process_model` to `in-process` and copy the login file (`credentials.toml`). | A |

**History on read.** Before `coding.sh init` installs its hooks, a read (`usage`, `sessions`,
`show`, `ui`) imports Claude Code's transcripts already on disk, so `coding.sh usage` works with no
setup and shows all of your history. Once the hooks are installed, live capture and the spool take
over and the transcripts are not re-read on every read (an explicit `ingest --backfill` still does).
Imports key on the session id, so running `init` later never doubles a session. Codex does the same,
but only for the narrow window after `init` while its hooks are untrusted or disabled (see below).

## Test results

A shell call whose output holds a test runner's summary also becomes a `test.result`: the runner,
its passed and failed counts, and skipped when there are any. One parser reads the output for every
agent (`parseTestOutput` in `src/adapters/_shared/heuristics.ts`). It reads cargo test, Jest,
Vitest, pytest (the framed summary, or the bare `2 passed in 0.01s` that `pytest -q` prints),
node:test, Mocha and Go. When an output holds several summaries, such as a rerun or a watch mode,
the last one counts. Cargo adds up its per-target lines, and Go counts its per-test or per-package
lines. Escape codes for colors, titles and links are stripped first, and only the last 200,000
characters of an output are read.

Claude Code, Codex, OpenCode, Cursor and T3 Code read every shell call, and count a Mocha or Go
summary only when the command runs tests. Gemini CLI, Antigravity, Copilot CLI, Amp, Pi, Droid,
Goose and Devin CLI read only a command that verifies work (tests, type checks, linters, builds),
such as `npm test`, `pytest`, `npm run check` or `make verify`.

## Subagents

How each agent marks a subagent, and where coding.sh pairs it with its parent:

| Agent | Spawned by | Child id and parent link |
|---|---|---|
| Claude Code | `Agent` tool | SubagentStart/Stop `agent_id`; transcript `subagents/agent-*.jsonl`, with its `description` in the `.meta.json` sidecar. `SubagentStop` lacks `tool_use_id`. Internal forks (the compaction summarizer, prompt suggestions) fire a `SubagentStop` with an empty `agent_type` and no transcript; coding.sh records no session for them. Some agents (`web-fetch`) fire no SubagentStart or SubagentStop: the parent's `PostToolUse` for the `Agent` call carries `agentId`, `agentType`, `content`, `resolvedModel` and `totalDurationMs`, which link and end the child. A fork (`subagent_type: "fork"`; the sidecar has `isFork: true` and the parent's `toolUseId`) opens its transcript with the parent's context: every parent entry copied with its uuid and `message.id`, or a `fork-context-ref` line and a copy of the parent's Agent call. Its own entries start at the user entry with the `tool_result` for `toolUseId` ("Fork started"). coding.sh skips everything before that entry (backfill and live windows), opens the fork's turn with the Agent call's `prompt`, and records how much context it inherited (`stats.inheritedTokens`). Without that entry the transcript is read whole. A subagent another subagent spawned has `parentAgentId` and `spawnDepth` in its `.meta.json`; its session hangs off that subagent's session, and its `subagent.start` (with `spawnDepth`) sits there under the spawning `Agent` call. Claude Code copies subagent transcripts into other session dirs: a session that resumes another session's workflow run (`Workflow` with `resumeFromRunId`) gets a copy of the run dir, and a fork copies or symlinks them. A copy's first entry keeps the `sessionId` of the session that wrote it. Backfill stores each subagent once, under that session, when its dir still holds the file at the same path; a copy whose owner is gone is stored under the session that holds it. A re-parse deletes the copies an older coding.sh stored, once the owner's session is in the index. |
| Codex | Threads | SubagentStart/Stop `agent_id`. A child thread gets its task as an `agent_message` addressed to its `agent_path` (`Message Type: NEW_TASK`, `Task name`, `Sender`, then the payload, which Codex 0.166 encrypts). That message becomes the child's `user.message`, with `from`, `messageType`, `taskName` and `encrypted`, so the child has a title; with an encrypted payload the text says which agent asked for which task. Mail the thread sends, and answers from its own children, are not prompts. |
| Gemini CLI | `invoke_agent` tool `{agent_name,prompt}` | Child chat `chats/<parentSessionId>/<agentId>.jsonl` with `kind:'subagent'` and `sessionId == agentId`; the parent's `toolCalls[].agentId` names the child file. Hooks inside it carry the main `session_id`. |
| Amp | `Task`, `oracle`, `librarian`, `finder` tools; `create_thread` makes child threads | No payload carries a subagent field. |
| Factory Droid | `Task` tool: `subagent_type`, `description`, `prompt` (optional `image_paths`, `complexity`, `run_in_background`, `resume`) | SubagentStop only. |
| Goose | `delegate` tool (summon extension) | `sessions.db` `session_type='sub_agent'` and `parent_session_id`. Hooks inside carry the child `session_id`. |
| Copilot CLI | Subagent tools | `subagentStart` `agentName`; `subagentStop` `agentId`; hooks inside add `agentId`, `parentAgentId`. `events.jsonl` has `subagent.started/completed/failed` keyed by `toolCallId`. |
| Antigravity | `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents` tools | From the brain transcript. |
| Cursor CLI | Subagent tool | `subagentStop` only (`duration_ms`). |
| Pi | None | — |
| Devin CLI | `run_subagent` (`read_subagent` reads its report) | No payload carries a subagent field (U: not run with a login). |

Harness surfaces:
- `AGENTS.md` is read by nearly every agent.
- Per-agent instruction files: Claude Code's own file, GEMINI.md, QWEN.md, `.cursor/rules/*.mdc`, `.github/instructions/**`, `.clinerules/`, `.kiro/steering/`, `.goosehints`, CRUSH.md.
- `.agents/skills` is close to a universal skills directory. Claude Code uses `.claude/skills` instead.
- A tool call that loads a skill names it on its `tool.start`: `payload.skill` (the first) and
  `payload.skills` (every name, when there are more). It counts a Skill tool (`Skill`, `skill`,
  `activate_skill`) naming one; a file read (`Read`, `read_file`, `view`, `view_file`, …) of a
  file under `.claude`, `.agents`, `.codex`, `.cursor`, `.gemini`, `.github`, `.pi/agent` or
  `.config/opencode` `/skills/<name>/`; a shell `cat`, `head`, `tail`, `sed`, `less`, `more`, `bat`
  or `nl` of such a file by a literal path (no `$`, backticks, globs or `..`); and an MCP read of a
  `skill://<name>/…` resource. Nothing is run. Verified for Codex by
  `scripts/e2e/codex-skill-capture.mjs`.

## Replay

`coding.sh replay` rebuilds the files a session touched from its tool calls (see
[Explore](guides/explore.md#replay-a-session)). What each agent's capture gives it, checked on the fixtures in
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
- **Title:** the `host-link` notification carries T3's thread title, and the session takes that title, not its
  first prompt. T3's placeholder for a thread it has not named yet ("New thread") is skipped, so such a session
  keeps its prompt as the title. In `show`, the notification reads `T3 Code thread: <title>`.
- **Content by provider:**
  - Codex and Claude: content comes from their own transcripts.
  - OpenCode, Cursor and Pi: linked only. Their adapters import the content.
  - Other providers: content is built from T3's store. Each finished provider turn is one `llm.call` on
    the turn's model (the thread's model when the turn names none), timed from the turn's start to its end,
    with usage from `turnTokenUsage` when T3 has it. T3 counts cache reads and writes inside `inputTokens`,
    and coding.sh separates them.
- **Session tree:** a thread's first provider thread is the top-level session. A provider switch or a T3
  subagent thread becomes a child session.
- **Claude subagents:** a subagent thread of a Claude thread is not stored when a Claude transcript of the
  parent thread (any of its provider threads) holds its run, since the claude-code adapter stores that run as
  `<session>:sub:<agentId>`. That covers an `agent-<id>.jsonl` subagent file, a Workflow-tool run thread
  whose `subagents/workflows/<runId>` directory exists (the run id comes from T3's
  `orchestration_v2_projection_subagents` rows), and each agent thread of that run. A re-parse removes the
  t3code copies an older parse stored.
- **Cost:** T3's running cost (`contextUsage.cost`) is kept as `reportedUsage` and never summed.
- **Approvals and questions:** a request T3 puts to the user is a notification with a `requestId` in the
  session of the provider thread it belongs to, whichever provider runs it. The sources are T3's runtime
  requests (`orchestration_v2_projection_runtime_requests`, status `pending` while open) and their
  `approval_request` and `user_input_request` turn items, which carry the prompt and the questions. A
  command, file change, file read or permission request is a `permission_prompt`. A user-input or MCP
  elicitation request is a question. The notification names the request's kind, its tool (`shell` for a
  command, `edit` for a file change) and its prompt or first question. When the runtime request or its
  item ends, a `request_resolved` notification follows. `stats.waiting` reads both, so a thread
  waiting on one is blocked on you in `coding.sh work` until T3 resolves it. T3's secret and link requests
  are not read. The v1 store has no requests.
- **When imports run:** the T3 store is re-imported on every lazy ingest (`Adapter.tail`). Threads that
  haven't changed are skipped.
- **Links lost by an older import:** a session another agent's adapter stored without its T3 link (an older
  `--since` import cut the link off, then skipped the unchanged thread) gets the link back from a re-parse.
  The re-parse reads T3's store and adds the T3 rows such a session lacks. It runs once after the T3
  adapter's parse version changes, once on a store an older coding.sh kept, and on `ingest --rebuild`.
- **Store copies:** the T3 store is read from a copy in the temp directory, which needs room for it; a
  failed copy is a backfill error. The next read removes copies a killed read left. A read that kills its
  import child at its deadline waits up to a second for the child to let go of its copy, then removes it.

## Known breakage to design around

- **Codex:** new hooks fire only once the user trusts them by hash, and `codex exec` skips untrusted hooks silently. Eval runs pass `--dangerously-bypass-hook-trust`. For user installs, `doctor` reports untrusted hooks and tells the user to run `/hooks`. Never write trust hashes ourselves.
- **Codex:** `-s read-only` fires no hooks. SessionEnd has a 1s default and a 3s hard cap. The sandbox blocks network from hooks (spool-to-file is safe). Tool names `shell_command`/`apply_patch` changed upstream, so normalize defensively.
- **Claude Code:** the model reads as unknown when large tool results fill the transcript tail; scan backwards further. `SubagentStop` lacks `tool_use_id`. Old `Task` matchers never fire; use `Agent`.
- **Claude Code:** a `Stop` line's model calls and replies are read from the transcript it names: the turn from the last prompt at or before the Stop to the next prompt, within the last 8 MB of the file. A `claude -p --resume` or a queued prompt can write the next prompt within 2 s of the Stop, so the window ends there. When the transcript is gone (an eval run's temporary home) or the turn is no longer in the last 8 MB, the adapter says so (`NormalizeContext.missing`) and a re-parse keeps the session's stored hook rows.
- **Claude Code:** files a Bash command edits (`sed -i`, heredoc writes, `tee`) are in the tool result's `toolUseResult.bashEditDiff` (per-file hunks, plus `changedFiles` past the first few), which becomes `file.change`. It is on by default only in auto and bypass-permissions modes; `CLAUDE_CODE_BASH_EDIT_DIFF=true` or the `bashEditDiffEnabled` setting turns it on elsewhere. The diff lists every file that changed while the command ran, including ones it never touched (a `git rebase`, a test run's output, another agent in the same checkout), so `test-tamper` only counts a file the command names.
- **Claude Code:** context loaded mid-session is only in transcript `attachment` lines, never in hooks: `nested_memory` (Claude Code's instructions file from a subdirectory), `dynamic_skill` (a nested `.claude/skills` became available) and `invoked_skills` (skills restored after a compaction). A Skill call's "Base directory for this skill" line names the skill's folder. Each becomes a `notification` with `payload.kind: "harness.loaded"` and `loadedBy`, paths and skill names (never the text). Live windows read them too; the attachment's uuid keys the event, so backfill and live capture store it once.
- **Claude Code:** a model fallback is only in the transcript, as a `system` line. `model_fallback` (`originalModel`, `fallbackModel`, `trigger` such as `overloaded`, `direction`) is written when the main model kept failing and Claude Code moved to `--fallback-model` for the rest of the turn; `model_refusal_fallback` is written when a refusal was routed to another model. Each becomes a `notification` with `payload.kind: "model.fallback"`, tags the session `model:fallback`, and makes the model change around it a `model:switch`, the switch back on the next turn included. Live windows read them too, keyed by the line's uuid. Verified by `scripts/e2e/claude-fallback-capture.mjs` (Claude Code 2.1.319, a stub model that answers 529 overloaded); the stub cannot make the API route a refusal, so 2.1.319 writes `model_refusal_no_fallback` there and the `model_refusal_fallback` tests build the record by hand in the same shape.
- **Headless or interactive:** Claude Code writes `entrypoint` on every transcript line and sets `CLAUDE_CODE_ENTRYPOINT` in hooks (`sdk-cli` for `claude -p`, `sdk-ts` and `sdk-py` for the Agent SDKs, `cli` in a terminal, `claude-vscode` in the IDE extension); the hook records it on the spool line and both copies of `session.start` carry it. Codex says it only in the rollout's `session_meta` (`originator` `codex_exec` or `codex_cli_rs`, `source` `exec`, `cli`, `vscode`, `mcp`), so a hook SessionStart reads the rollout's first line for it. Either becomes `stats.launch`.
- **Claude Code:** what other hooks add to the context is also only in transcript attachments. `hook_success` holds one hook run (its `command`, `stdout` and `content`); its `content` reached the model when the entry has `rendered` text (plain stdout of a SessionStart or UserPromptSubmit hook). `hook_additional_context` holds the `additionalContext` strings hooks answered, with no command; the `hook_success` whose stdout JSON holds the same string names it. Claude Code 2.1.319 writes no `hook_success` for a UserPromptSubmit hook, so its context has source `unknown`. Each text becomes a `notification` with `payload.kind: "hook.context"` (`hookEvent`, `hookName`, `hookSource`, `command`, `chars`, `tokens`, `text`). The command is recorded unexpanded (`node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`), so the plugin's name comes from the plugins installed in the transcript's config dir (`plugins/installed_plugins.json` and each plugin's `hooks/hooks.json`) when the transcript is parsed: a plugin since uninstalled, or loaded with `--plugin-dir` only, is `plugin`. A Stop window also reads the hook attachments written before its prompt, so a SessionStart's context is captured live.
- **Pi:** since v1.6.0 Pi writes a failed tool result `Operation aborted` for each call Esc skips; a failed result whose whole text is `Operation aborted` or `Aborted`, or whose `stopReason` is `aborted`, becomes a `tool.end` with `ok: false` and `interrupted: true`, so it counts in `interruptedToolCalls`, not `toolErrors`. Other failed results that mention "aborted" stay tool errors.
- **Gemini CLI:** a chat `toolCalls` entry with status `cancelled` (or `canceled`) becomes a `tool.end` with `ok: false` and `interrupted: true`, counted in `interruptedToolCalls`; status `error` stays a tool error.
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
- **OpenCode:** when it finds a database schema it cannot migrate, OpenCode renames the file to
  `opencode.db.schema-mismatch-<ms>` and starts over. Until it writes a new `opencode.db`, backfill
  reads the newest of those files, and `doctor` says so. A database with no session tables
  coding.sh knows, or one it cannot open, imports nothing, and `doctor` names its tables or the error.
- **Claude Code:** a response with parallel tool calls is written one line per content block, and
  Claude Code runs the first call before the next block arrives, so `tool_result` lines can sit
  between lines of one `message.id`. They are one `llm.call` with the usage counted once, timed from
  the `api-request` line that starts the request (`apiRequestId`; `requestId` is the API's
  `req_…`). Verified by `scripts/e2e/claude-subagent-capture.mjs`.
- **Claude Code:** a model call is timed only when coding.sh read the line that starts it: its
  `api-request` line, or, in transcripts without them (older versions), the prompt or tool results
  just before it. A hook reads the last 8 MB of a transcript, which can start in the middle of a
  response. That call then has no `durationMs`, `ttftMs` or `tokensPerSec`. The same goes for a
  response whose lines are stamped before its `api-request` line. The import reads the whole file
  and fills in the stored call's timing. After an upgrade, the background re-parse does the same for
  calls an older version stored.
- **Codex:** a rollout line is stamped when Codex writes it, and Codex sometimes writes several
  records at once, seconds late. A tool output or agent message whose own `create_time` (or an
  `item_completed`'s `completed_at_ms`) is more than 1 s before its line leaves the model call it
  belongs to without `durationMs`, `ttftMs` or `tokensPerSec`.
- **Copilot CLI:** with OpenTelemetry on (`COPILOT_OTEL_ENABLED`), 1.0.107 adds a W3C
  `traceparent` to every hook payload after `sessionStart`. Hook events keep its trace id and the
  caller's span (`traceId`, `parentSpanId`), and ingest records the trace's session, so an OTLP span
  of that trace that names no `gen_ai.conversation.id` joins the hook session. Copilot's own spans
  name the conversation. Verified by `scripts/e2e/copilot-otel-capture.mjs`.
- **Antigravity:** a tool step's result starts with `Created At:` and `Completed At:` (whole
  seconds), and a command's adds `The command exited with code N.` The call's `tool.end` takes
  `exitCode` from it, fails on a nonzero code, and is timed by the header when it spans a second or
  more.
- **Gemini CLI:** the Notification hook (`notification_type: "ToolPermission"`) fires while a tool
  call waits for the user's approval, stored as a `notification` with `payload.kind` and
  `payload.message`. Since 0.36, BeforeTool fires before the approval, so the call is open when the
  prompt comes. In 0.35 and older, BeforeTool fires once the call runs, after the prompt. The
  `unapproved-action` flag handles both orders. The message names the prompt's title, not the
  tool: `Tool Confirm Shell Command requires execution` (0.20 through 0.70).
- **Copilot:** bash-only hooks fail on Windows, so provide `powershell` too. Token totals are written after hooks return, so read them at backfill.
- **Amp:** no session id in tool payloads. Correlate by `thread.id` from `session.start`.
- **Devin CLI:** payloads carry no cwd. A hook from the user config runs in the session's folder and
  a project's hook in the project root, so a project-scope install records a session started in a
  subfolder with the root as its cwd. Tool events carry no call id: a call's start and end pair by
  tool name, and a `PermissionRequest` waits on the newest open call of its tool when one is open.
- **Devin CLI:** it also runs the hooks coding.sh installed for Claude Code. Each such call carries
  `DEVIN_PROJECT_DIR` and no Claude Code transcript path, so the hook labels it `devin`, or drops it
  when a coding.sh hook for Devin fires for the same event where the session reads hooks
  (`src/spool/devin.ts`). The check reads only Devin's hook files, never git.
- **Cross-cutting:**
  - Per-agent hook timeouts: never assume 30s, and keep the hook under 50 ms.
  - Windows path quoting.
  - Transcripts are often flushed after Stop, so debounce transcript reads at ingest.
  - Copy SQLite databases before reading (WAL locks).
  - Backfill follows symlinks and Windows junctions in transcript directories (a mirror of another
    machine's `~/.claude/projects`, say) and skips links that point nowhere.

## Hook command

Every adapter installs the same command. Outside Windows it runs the POSIX sh hook:

```
/bin/sh "<~/.coding.sh/bin/hook.sh>" <agent-id> <EventName> [--echo-continue | --reply={}]
```

On Windows, and for flags only the node hook handles (any other `--reply`), it runs node:

```
node "<~/.coding.sh/bin/hook.mjs>" <agent-id> <EventName> [flags]
```

- `hook.sh` writes the same spool line as `hook.mjs` without starting node, where a node start
  costs about 30 ms. Under bash 5 it reads the clock from `EPOCHREALTIME` and a payload
  under 256 KB with the `read` builtin, outside POSIX mode so that bash reads a pipe or socket a block
  at a time instead of a byte at a time. Such a call starts no other process and costs about 3 ms
  more than `/bin/true`. Where `/bin/sh` is dash (Debian, Ubuntu) it runs itself again under
  `/bin/bash` when that exists. Older bash and zsh read a pipe with `$(< /dev/stdin)`, and on macOS
  any stdin. Other shells read the payload with `cat` and the clock with `date`. A session end also starts `coding.sh ingest --background`,
  and the agent does not wait for it. A payload that is one line of the form `{"…}` goes inline
  when the spool line fits in 1024 bytes. Shells print through a 1024-byte buffer on macOS, and a
  longer line could be split by another hook's write. Any other payload goes verbatim to a side file
  that the line names in `rawFile`, as `hook.mjs` does for any line over 1024 bytes. Under bash
  and zsh a payload whose braces or brackets do not pair up goes to a side file too.
- `hook.sh` hands the call to `hook.mjs` beside it, with the same arguments and stdin, when it sees
  a `--reply` other than `--reply={}`, `CODING_SH_RUN_ID`, a T3 Code env marker, a model base URL other than a loopback one
  (the `init --proxy` proxy) on a port no gateway uses, a session start while `init --proxy` is
  installed, a relative `CODING_SH_HOME`, a value it cannot copy into JSON as is, or a write that
  fails. It waits for `hook.mjs` and exits 0 whatever node does. When node is not on the agent's
  `PATH` or cannot run `hook.mjs`, that event is not captured, and `--echo-continue` and
  `--reply={}` still get their reply. A reader of the reply that has gone away does not fail the call.
- `hook.mjs` redacts the payload before it writes it, inline or to a side file, with the redaction
  settings in your user `config.toml` ([privacy](guides/privacy.md#the-raw-spool)). The line
  records the counts in `redactions`, and ingest adds them to the event. `hook.sh` writes the payload
  as it came; ingest redacts it.
- `hook.mjs` loads the rules from `hook-redact.mjs` beside it only when the payload's text may hold a
  secret or `config.toml` sets other rules. Other payloads are written as they came, since the rules
  would not change them. If `hook-redact.mjs` is missing, such a payload gets no line and the error
  goes to `spool/errors.log`. `coding.sh doctor` then reports the hook as stale, and
  `coding.sh update --refresh-bin` writes the file again.
- With `CODING_SH_DISABLE=1` both hooks read the payload and write no line. They add the payload's
  session id (`session_id`, `conversation_id`, `sessionId` or `conversationId`) to
  `spool/disabled-sessions`. Ingest and `ingest --backfill` store no event of a session listed there.
- Hooks installed by an older version run `node …/hook.mjs` and keep working. Run `coding.sh init`
  again to switch them to `hook.sh`. Codex asks you to review changed hooks in `/hooks` once.
- Claude Code runs every hook command its settings files register for an event. With coding.sh
  hooks in two files whose commands differ (user settings on `hook.sh`, a project's
  `.claude/settings.local.json` still on `node …/hook.mjs`), each event is spooled twice. The lines
  of one firing (the same payload, at most 2 s apart) get the same event ids, so the event is stored
  once. The same prompt sent again later is a second event. `coding.sh init` reports project hooks
  in the current directory and at the root of its repository, and skips the user install unless
  `--force`.
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
| Claude Code, Codex, Gemini CLI and Devin CLI running remotely with OTel logs on | `POST /v1/logs` | `src/otel/map.ts` log events | `otel…` |

- OTel logs are for an agent whose hooks don't record to this store. Where both do, each prompt is
  stored twice, once from the hook and once from the log, because the two carry different prompt
  ids. Devin CLI's logs (scope `ai.devin.local.events`) add a session's start and end as
  notifications.
- A span or a log record named `weights.edit` with `coding_sh.weights.*` attributes is stored as
  the weight edit event the SDKs send (`notification`, `payload.kind: "weights.edit"`); the
  attributes are listed in [reference/api.md](reference/api.md).
- One named `weights.checkpoint` with `coding_sh.weights.sha256` is stored as the checkpoint event
  (`payload.kind: "weights.checkpoint"`). Without a hash of 64 hex characters it is not read as a
  checkpoint.
- Hooks, transcript backfill and `coding.sh run` stay local. Serve does not take spool lines.
- The ingest key picks the project, and session ids are stored as `<project>/<sessionId>`.
- SDK sessions that never send `session.end` have no `endedAt` yet; see the open item in
  `tasks/research-queue.md` (Production mode).
