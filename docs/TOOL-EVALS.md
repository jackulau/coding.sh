# Tool evals: measuring how well agents use a CLI, MCP server or API

Status: design spec, not implemented. It builds on `src/schema` (events, `llm.call`, `durationMs`,
subagent fields, `Session.parent`, `LatencyStats`), `src/core/sessions.ts` (`latencyStats`),
`src/stats` (Wilson, paired bootstrap, McNemar), `src/runner` (bundles, overlay, exec), the
adapters (`src/adapters`), the OTLP receiver (`src/otel`) and the generic evals being built in
`src/datasets`, `src/graders`, `src/judge` and `src/experiments`.

A tool eval runs a set of tasks against one target tool. Each task is attempted by one or more
drivers: a coding agent through its adapter's headless `run`, or a raw model through the built-in
tool-use loop. coding.sh then scores how effectively the agent used the tool. Every metric is
computed from captured traces plus an agent-independent tap on the tool. Nothing is self-reported
by the agent.

The goal is the loop Theo Browne describes: turn "agents misuse my tool" into a program that
outputs a score, then change the tool (help text, flag names, MCP descriptions, `--json`) and keep
the changes that raise the score or hold it at lower cost.

## 1. Concepts

| Term | Meaning |
|---|---|
| Target | The tool under test: a CLI, an MCP server (stdio or HTTP), or an HTTP API with docs. |
| Variant | A named version of the target's surface, for example `base`, `help-v2` or `desc-min`. A/B tests compare variants. |
| Task | One instruction plus sandbox setup, success checks and a budget. It extends the generic `Case`. |
| Suite | The tasks for one target: `evals/toolevals/<target>/`. Each task belongs to the `dev` or the `heldout` split. |
| Driver | What attempts the task: `agent:<adapter>[:model]` or `model:<provider>/<model>`. |
| Trial | One attempt of (task, variant, driver). It produces a session (plus child sessions), tap records and a `TrialResult`. |
| Tap | An agent-independent recorder between the driver and the target: a PATH shim for a CLI, a JSON-RPC proxy for MCP, a reverse proxy for HTTP. |
| Arm | A (variant, driver) pair. Compare reports pair arms by task. |

The tap is what makes the metrics comparable across agents. Agents report tool calls in different
shapes, and some report none (Aider). The tap sees every invocation of the target with its exit
status, latency and bytes. The agent's events add what only the agent knows: model calls, tokens,
help reads outside the tool, subagents.

## 2. Targets

### 2.1 CLI

```toml
[toolevals.targets.codingsh]
kind = "cli"
bin = "coding.sh"                       # the name the agent types
command = ["node", "/abs/path/dist/cli.mjs"]   # the real binary plus prefix args
docs = ["docs/**/*.md", "README.md"]     # sandbox-relative globs that count as doc reads
docsUrls = ["https://coding.sh/docs"]
usageExitCodes = [2]                     # exit codes that mean usage error (Vercel guideline: 2)
usagePatterns = ["unknown (option|flag|command)", "unrecognized", "did you mean", "^usage:"]
helpCrawl = true                         # crawl `--help` of every subcommand for surface size
```

- The sandbox gets `bin/<bin>`, a shim that execs `command` and writes one tap record per call.
  `bin/` is first on `PATH`. The real binary's path does not appear in the agent's environment.
- Surface: `coding.sh toolevals surface <target>` runs `<bin> --help`, parses subcommand names from
  the output, recurses to a depth of 3, and records the bytes of each help page. `helpSurfaceBytes`
  is the sum. If a `--help --json` schema exists (Vercel guideline), it is preferred over parsing
  text.

### 2.2 MCP server

```toml
[toolevals.targets.t3]
kind = "mcp"
transport = "stdio"                      # or "http"
command = ["node", "server.js"]          # stdio
# url = "http://127.0.0.1:3000/mcp"      # http
env = { T3_HOME = "${sandbox}/t3" }
docTools = ["search_docs"]               # tools whose calls count as doc lookups
```

- Agent driver: the server is mounted into the agent through the adapter overlay (§5.2) so the
  user's MCP config is untouched. The mounted entry is the tap proxy, which spawns or forwards to
  the real server.
- Model driver: coding.sh's MCP client (§10) connects through the same proxy and passes the tools
  to the model API directly. This measures the tool surface without any agent harness in between.
- Variant overrides (`descriptions`, `paramDescriptions`, `hideTools`) are applied by the proxy,
  which rewrites `tools/list` results. You can compress descriptions for any server without
  touching its source, then port the winning text back to the server.

### 2.3 HTTP API or SDK

```toml
[toolevals.targets.billing]
kind = "http"
baseUrl = "http://127.0.0.1:8787"
openapi = "openapi.json"                 # optional; counted in surface bytes when given to the agent
docs = ["docs/api/**"]
auth = { header = "Authorization", env = "BILLING_TOKEN" }
```

- The agent receives `BILLING_URL` pointing at a local reverse proxy. Each request becomes a tap
  record with method, path template (matched against the OpenAPI paths when available), status
  and latency.
- For an SDK target, setup installs the SDK into the sandbox. The proxy still records the HTTP
  traffic the SDK makes, provided the SDK base URL is configurable.

## 3. Task format

A task extends the generic `Case` (`id`, `input`, `expected?`, `tags`, `metadata`). Here `input` is
the instruction, and the extra fields below are required. One task per TOML file, or many per JSONL
line with the same keys.

```toml
# evals/toolevals/codingsh/tasks/slowest-tool.toml
id = "slowest-tool"
target = "codingsh"
split = "dev"                            # "dev" | "heldout"
tags = ["query", "latency"]
instruction = """
Find the slowest tool call in yesterday's sessions. Reply with the session id and the tool name.
"""

[setup]
commands = ["node ${fixtures}/make-home.mjs --profile basic --out ${sandbox}/home"]
files = { "notes.md" = "fixtures/notes.md" }      # copied into the sandbox
env = { CODING_SH_HOME = "${sandbox}/home" }

[[check]]
kind = "output"                          # final assistant text
contains = ["${answers.slowest.sessionId}", "${answers.slowest.tool}"]

[[check]]
kind = "state"
assert = [{ command = "coding.sh sessions --json", jsonPath = "$.length", equals = 12 }]

[budget]
turns = 25                               # model calls
tokens = 300000                          # input + output, cache reads included
wallMs = 300000
costUsd = 0.50

[expect]
minTargetCalls = 2                       # reference count, used for the efficiency ratio
```

| Check kind | Pass condition | Notes |
|---|---|---|
| `command` | `run` exits 0 in the sandbox after the agent stops | `hiddenFiles` are copied in only at check time, as in `VerifierSpec`. |
| `state` | Every assertion holds: file `exists` / `contains` / `regex` / `jsonPath`+`equals`, or a command's stdout matches | Commands run with the shim removed from `PATH`, so checks are not counted as agent calls. |
| `output` | The final assistant message matches `equals`, `contains` (all), `regex` or `jsonPath` after `normalize` (`trim`, `lower`, `collapse-ws`) | `${answers.*}` resolves from a hidden `answers.json` written by setup. |
| `judge` | A judge from `src/judge` returns pass | Results are flagged `uncalibrated` until the judge's κ reaches the threshold. Prefer the other three kinds. |

Every check must pass, and the trial must stay within budget. A trial that exceeds a budget is a
failure with `budgetExceeded` set to the first exceeded key. Budgets are enforced where the driver
can enforce them: `--max-turns` and `--max-budget-usd` for Claude Code, and the timeout for every
driver. They are always re-checked against the trace afterwards.

Task validation runs before a task is used, mirroring `validateTask`:

1. The no-op trial fails: the checks run against the sandbox after setup only.
2. A reference trial passes: a scripted list of shell commands in `reference = [...]`, run through
   the shim.
3. `instruction` does not contain the expected output (`ngramOverlap` from `src/eval/leakage.ts`).

## 4. Drivers

### 4.1 Agent driver

The agent driver uses the adapter's `run(spec)`:

- `cwd` is the sandbox work dir.
- `env` combines the adapter overlay env, `PATH=<sandbox>/bin:$PATH`, `CODING_SH_RUN_ID=<trialId>`
  and the OTel env that points at the local receiver.
- `flags` come from the overlay plus the MCP mount flags (§5.2).
- `timeoutMs` is `budget.wallMs`.

The session is found by `runId`. Child sessions are found through `Session.parent`. A tier C
agent (Aider) runs through `wrapRun` and is measured from the tap alone.

### 4.2 Model driver (agent-free)

A minimal loop with no harness:

1. Build the tool list.
   - MCP target: the proxied `tools/list`, translated to the provider format.
   - CLI target: one `shell` tool `{command: string}`, run with `sh -c` in the sandbox, with
     stdout and stderr truncated at 16 KB.
   - HTTP target: one `http_request` tool `{method, path, query?, headers?, body?}` restricted to
     the base URL, plus a `read_doc` tool `{path}` over the `docs` globs.
2. System prompt: `driver.system`, or the default: "You are working in a sandbox. Use the tools to
   complete the task. When finished, reply with the final answer and no tool call."
3. Stream each model call. Emit one `llm.call` event per call, with `durationMs`, `ttftMs`, usage
   and `stopReason`. Execute the tool calls and append the results.
4. Stop at the first assistant message with no tool calls, or at a budget limit.

Events are written straight to the store as agent `coding.sh-model`, with `sessionId = trialId`.
This is the only driver with exact TTFT for every call. Providers use `fetch` with no SDK:
`anthropic` (Messages), `openai` (Responses) and `openai-chat` (Chat Completions, for local or
OpenAI-compatible servers). See §11.

## 5. Sandbox, taps and mounting

### 5.1 Trial layout

```
~/.coding.sh/toolevals/<experimentId>/<trialId>/
  work/        agent cwd (setup files, fixtures)
  home/        HOME/config dir for the agent when its overlay supports isolation
  bin/<bin>    CLI shim
  tap.jsonl    one TapRecord per target call
  hidden/      answers.json and hidden check files (never under work/)
```

The trial directory is deleted after scoring unless `--keep` is set. `tap.jsonl` is stored as a
blob first. There is no network sandbox: tasks run on the host, so tasks must not need secrets
beyond the ones the target config names.

### 5.2 MCP mount per agent

`src/toolevals/mount.ts` holds the table below, until it moves into the `Adapter` contract as
`mountMcp?()` (a proposed addition; it is not made here). `<proxy>` is
`node ~/.coding.sh/bin/tap.mjs mcp --log <tap.jsonl> --variant <file> -- <server argv>` for stdio,
or `http://127.0.0.1:<port>/mcp` for HTTP.

| Agent | Mount | Tool name seen in events | Certainty |
|---|---|---|---|
| Claude Code | `--strict-mcp-config --mcp-config <file>` with `{"mcpServers":{"<n>":{"command","args"}}}` or `{"type":"http","url"}` | `mcp__<n>__<tool>` | verified (docs) |
| Codex | `-c 'mcp_servers.<n>.command="node"' -c 'mcp_servers.<n>.args=[…]'` or `url=`; `--ignore-user-config` | `mcp__<n>__<tool>`; `codex exec --json` item `type:"mcp_tool_call"` `{server,tool}` | partial (issue + source) |
| OpenCode 2.x | `OPENCODE_CONFIG_CONTENT` with `mcp.servers.<n>` `{type:"local",command:[…]}`, plus `"codemode": false` | `<n>_<tool>` | partial (shape changed in V2) |
| Gemini CLI / agy | `GEMINI_CLI_HOME=<home>`; `.gemini/settings.json` `mcpServers.<n>` (`httpUrl` for HTTP) | `mcp_<n>_<tool>` | partial |
| Cursor CLI | `<work>/.cursor/mcp.json` plus `--approve-mcps` | unknown; record from a real run | unknown |
| Copilot CLI | `--additional-mcp-config @<file>` `{"mcpServers":{"<n>":{"type":"local",…,"tools":["*"]}}}` | unknown | partial |
| Amp | `--mcp-config <json>` | unknown | unknown |
| Goose, Droid, Pi, Crush, Kiro, Qwen | per ADAPTERS.md isolation column; fill in when each adapter lands | unknown | unknown |

When the event-side name is unknown, attribution falls back to the tap. The tap always knows which
target tool was called.

### 5.3 Taps

- **CLI shim** (`tap cli`): records `argv`, `cwd`, `exitCode`, `durationMs` (the real binary only,
  with shim startup excluded), `stdoutBytes`, `stderrBytes` and the first 2 KB of stderr. It passes
  stdin, stdout and stderr through unchanged.
- **MCP proxy** (`tap mcp`): forwards every JSON-RPC message. Per request it records `method`,
  `tool`, request and response bytes, `durationMs`, any JSON-RPC `error.code`, `result.isError`,
  and `schemaViolations`. The proxy validates `tools/call` arguments against the tool's
  `inputSchema` itself, with the subset validator in `jsonschema.ts` (`type`, `required`,
  `properties`, `enum`, `additionalProperties`, `items`, `minimum`/`maximum`). It also applies the
  variant overrides to `tools/list`.
- **HTTP proxy** (`tap http`): records `method`, `pathTemplate`, `status`, `durationMs` and bytes.

Each record gets a `class`, assigned by the tap at write time:

| Class | CLI | MCP | HTTP |
|---|---|---|---|
| `help` | argv contains `-h`/`--help`, first positional is `help`, or `--help --json` | call to a `docTools` tool | GET of a docs/OpenAPI path |
| `invalid` | exit code in `usageExitCodes`, stderr matches `usagePatterns`, or exit 127/126 | JSON-RPC error −32600/−32601/−32602, unknown tool name, or `schemaViolations` non-empty | 400, 404 (on unmatched template), 405, 415, 422 |
| `failed` | other non-zero exit | `isError: true` with valid arguments, or −32603 | 5xx, 401, 403 |
| `meta` | `--version` | `initialize`, `server/discover`, `tools/list`, notifications | `OPTIONS` |
| `ok` | exit 0 | result without `isError` | 2xx/3xx |

### 5.4 Tool-call classification from agent events

The tap misses work the agent does outside the target: reading docs with its own Read tool,
`man`, web fetches. `classify.ts` maps a `tool.start` event to a category:

| Agent | shell (command field) | file read | web | subagent spawn |
|---|---|---|---|---|
| Claude Code | `Bash` `input.command` | `Read` `input.file_path` | `WebFetch` `input.url`, `WebSearch` | `Agent` (legacy `Task`) |
| Codex | `shell` / `shell_command` / `exec_command` `input.command` (string or argv) | via shell (`cat`, `sed -n`) | `web_search` | `spawn_agent` |
| OpenCode | `bash` `input.command` | `read` `input.filePath` | `webfetch` | `task` |
| Gemini CLI | `run_shell_command` `input.command` | `read_file` `input.absolute_path` | `web_fetch`, `google_web_search` | agent name as tool name (U) |
| Copilot / Cursor / Amp / Pi / Droid / Goose | (U), filled from fixtures per adapter | (U) | (U) | (U) |

A shell command counts as a call to a CLI target when its first command word, after `env X=…`,
`cd …&&` and pipes are split off, equals `bin`. `man <bin>`, `tldr <bin>` and `<bin> help …`
count as help lookups. A file read counts as a doc lookup when its path matches `docs`.
`tapCoverage = shim records / shell commands that invoke the target`. A value below 1 means the
agent reached the binary another way, and the report prints a warning.

## 6. Metrics

All metrics are per trial, then aggregated per arm and per task. "Events" means the trial's session
plus all its child sessions (`Session.parent.sessionId = trial session`), unless a row says
otherwise.

| Metric | Definition | Source and detection |
|---|---|---|
| `success` | All checks pass and no budget was exceeded | checks + trace |
| `successRate` | passes / trials, with a Wilson 95% interval | `wilson()` |
| `passAllK` | Fraction of tasks where all k trials pass (tau-bench pass^k) | per task |
| `passAnyK` | Fraction of tasks where at least one trial passes (pass@k) | per task |
| `turns` | Model calls: count of `llm.call` events. Fallbacks: distinct assistant message ids, then the adapter-reported count (Claude `result.num_turns`) | events; `turnsSource` records which was used |
| `toolCalls` | `tool.start` events, all tools, parent and children | events |
| `targetCalls` | Tap records excluding `meta` | tap |
| `invalidCalls`, `invalidRate` | Records of class `invalid`; rate = `invalidCalls / targetCalls` | tap |
| `invalidKinds` | Counts by reason: `unknown-flag`, `unknown-command`, `missing-arg`, `not-found`, `schema`, `unknown-tool`, `http-4xx` | tap; reason from pattern or error code |
| `failedCalls` | Records of class `failed` | tap |
| `helpLookups` | Tap `help` records + `man`/`tldr`/`<bin> help` shell commands + doc-path reads + web fetches to `docsUrls` hosts | tap + `classify.ts` |
| `helpBytesRead` | stdout bytes of `help` tap records + bytes of doc files read | tap + `tool.end` output size |
| `retries` | Target calls that come after an `invalid` or `failed` call by the same agent (same `subagentId` or child session) with the same identity: CLI subcommand path (leading non-flag tokens), MCP tool name, or HTTP method + path template | tap, ordered by ts |
| `selfCorrections` | Retries that end in `ok` | tap |
| `recoveryRate` | Invalid or failed identities later followed by an `ok` call with that identity / all invalid or failed identities | tap |
| `firstCallCorrect` | The first non-help, non-meta target call is `ok` | tap |
| `callsToFirstCorrect` | Index (1-based) of the first `ok` target call | tap |
| `timeToFirstCorrectMs` | ts of the first `ok` target call − ts of the first event | tap + events |
| `efficiency` | `targetCalls / expect.minTargetCalls` (1.0 is optimal) | tap |
| `tokens` | Sums of input, output, cacheRead and cacheWrite over `llm.call` usage, else `Session.stats.usage` | events |
| `costUsd` | Sum of reported `usage.costUsd`. If no cost is reported, tokens × `[prices."<model>"]` from `coding.sh.toml`, marked `estimated` | events + config |
| `wallMs` | Driver start to driver exit (`AgentRunOutput.durationMs`) | driver |
| `llmP50Ms`, `llmP95Ms`, `ttftP50Ms`, `ttftP95Ms` | Nearest-rank percentiles of `llm.call.durationMs` and `payload.ttftMs` | `latencyStats()`; `latencySource` in §6.1 |
| `targetLatencyP50Ms`, `targetLatencyP95Ms` | Percentiles of tap `durationMs` for the target's own calls | tap (exact) |
| `toolLatencyP95Ms` | All tools | `Session.stats.latency.toolP95Ms` |
| `surfaceBytes` | MCP: UTF-8 bytes of `JSON.stringify(tools)` as delivered after overrides. CLI: `helpSurfaceBytes`. HTTP: OpenAPI bytes if given to the agent | surface crawl, per variant |
| `descriptionBytes` | MCP: bytes of every `description` string in tools and their `inputSchema` | surface |
| `surfaceTokens` | `surfaceBytes` tokenized with the provider's count-tokens endpoint when a key is set, else `ceil(bytes / 4)` marked `estimated` | surface |
| `subagents` | `subagent.start` count plus child sessions | events |
| `subagentTargetCalls` | Tap records whose time falls inside a subagent's span, or that are attributed to a child session's tool calls | tap + events |
| `subagentTokenShare` | Child session tokens / all tokens | events |

### 6.1 Model latency sources

| Driver | `llm.call` source | TTFT |
|---|---|---|
| Model driver | Measured in-process around each streamed request | yes, exact |
| Claude Code | OTel traces, when `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp` are set: `claude_code.llm_request` spans `{duration_ms, ttft_ms, first_content_ms, agent_id, parent_agent_id}`. Without traces: the `claude_code.api_request` log event `{duration_ms}` | traces only |
| Codex | `PreModelRequest`/`PostModelRequest` hook pairs; OTel `codex.api_request` duration | no |
| Gemini CLI | OTel `gemini_cli.api_response.duration_ms` | no |
| Others | Transcript timestamp deltas, marked `approx` | no |

The run overlay sets these variables through the overlay's `--settings` file or the env. Project
`.claude/settings.json` cannot set them; see docs/design/dogfood.md §1.2. `latencySource` is reported
per arm, and compare refuses to diff latency between arms whose sources differ.

## 7. Subagents

Subagents matter for two reasons. They hide target calls inside child transcripts, and they shift
tokens out of the parent context. Each adapter maps them onto `subagent.start` / `subagent.end`
events (with `subagentId`), and onto child `Session`s with `parent` set when the subagent has its
own transcript.

| Agent | Subagents | Detection | Tool calls attributable to the subagent | Certainty |
|---|---|---|---|---|
| Claude Code | yes (`Agent` tool) | `SubagentStart {agent_id, agent_type}`, `SubagentStop {agent_id, agent_type, agent_transcript_path, last_assistant_message}`; transcript `<sid>/subagents/agent-<id>.jsonl` (`isSidechain`, `agentId`); sidecar `agent-<id>.meta.json {agentType, description, toolUseId, parentAgentId, spawnDepth}` links to the parent's Agent call and to nested subagents | yes: Pre/PostToolUse carry `agent_id` | verified (docs, local files on v2.1.319) |
| Codex | yes (`spawn_agent`) | `SubagentStart/Stop {agent_id, agent_type, agent_transcript_path}`; child rollout `session_meta.payload.source.subagent.thread_spawn {parent_thread_id, depth, agent_role}` | unknown from hooks; yes from the child rollout | partial |
| OpenCode 2.x | yes (`task` → child session) | `session.created` with `info.parentID`; `parentID` in `opencode.db` | yes: tool events carry the child `sessionID` | partial (inferred) |
| Cursor CLI | yes | `subagentStart {subagent_id, subagent_type, parent_conversation_id, tool_call_id, subagent_model}`, `subagentStop {status, duration_ms, tool_call_count, agent_transcript_path}` | unknown | partial |
| Gemini CLI | yes (built-in and `.gemini/agents/*.md`, no nesting) | no hooks; OTel `gemini_cli.agent.start/finish {agent_id, agent_name, duration_ms}` | via OTel only | partial |
| Copilot CLI | yes (custom agents) | `subagentStart {agentName}` (no id), `subagentStop {agentId, agentType}` | no: tool hooks lack an agent id | partial |
| Amp | yes (Task, oracle) | plugin events carry `thread.id` only | unknown | unknown |
| Pi | not in core; only through extensions | session header `parentSession` for forks | extension-dependent | no (core) |
| Factory Droid | yes (custom droids) | `SubagentStop {task_name, task_result}` only | no | partial |
| Goose | yes (subagents, subrecipes) | `sessions.parent_session_id` in `sessions.db`; OTel | from child sessions (inferred) | partial |
| Aider | no | n/a | n/a | no |
| OTel apps | per framework | nested `invoke_agent` spans; `gen_ai.agent.id/name` | yes, through span parentage | verified (semconv; status Development) |

Two corrections to `docs/ADAPTERS.md` need checking against source. Pi core has no subagents: the
note "All subagents share the session id `session`" describes a third-party extension. Droid has
`SubagentStop` but no `SubagentStart`.

When a subagent has no transcript and its tool calls are not attributed, the tap still counts its
target calls. Attribution falls back to time windows: a tap record between `subagent.start` and
`subagent.end` with no parent tool call in flight is assigned to the subagent, and is marked
`attribution: "window"`.

## 8. Experiments

An experiment is tasks × variants × drivers × k. Jobs are ordered as in `scheduleJobs`: per task,
attempts interleaved across arms, so provider drift hits every arm equally. Concurrency defaults to
`defaultConcurrency()`. The `run` command prints the trial count and estimated cost to stderr
before starting.

### 8.1 Variant types

| Variant | How it is applied |
|---|---|
| Help text rewrite, flag renames, adding `--json` | A different build: `command` override, e.g. `["node", "dist-b/cli.mjs"]`, or an env flag the CLI reads |
| MCP description compression or rewrite | Proxy overrides: `descriptions`, `paramDescriptions` |
| Fewer MCP tools | Proxy `hideTools` |
| Instruction surface (AGENTS.md section on the tool) | Harness bundle `files` on the agent driver |
| Model × agent matrix | Multiple drivers, same variant |

### 8.2 Compare

`compareToolArms(trials, {baseline, candidate})` reuses the shape of `CompareReport` in
`src/runner/experiment.ts`:

- Pairing unit: task. Arms must share the driver, or share the variant for a driver comparison.
  The report rejects pairs that differ on both.
- Success: per-task pass-rate difference → `pairedBootstrap` (task-level resampling), plus
  `mcnemarPaired` over attempt-aligned trials.
- Continuous metrics (`turns`, `tokens`, `costUsd`, `wallMs`, `invalidRate`, `helpLookups`,
  `llmP95Ms`, `targetLatencyP95Ms`): per-task median difference → `pairedBootstrap`.
- Surface metrics are deterministic per variant and are reported as absolute and relative deltas.
- Verdict wording follows `VerdictKind`: `better`, `worse`, `no-difference` or `inconclusive`.
- Regressions list:
  - With k ≥ 2: tasks where the candidate's pass count is lower by ≥ ⌈k/2⌉.
  - With k = 1: pass → fail.
  - Metric regressions: the bootstrap CI excludes 0 in the bad direction.
  - Each entry links to both trials' sessions and to the first divergence (`firstDivergence`).

### 8.3 Description compression mode

Goal: minimize `descriptionBytes` subject to no regression. The search runs on the `dev` split and
is confirmed on `heldout`.

1. Baseline: run `base` on dev with k (default 3).
2. Order tools by description bytes, descending. For each tool, generate candidates at 75%, 50%
   and 25% of the current length:
   - rule-based: drop examples, drop parameter descriptions that repeat the parameter name,
     collapse whitespace;
   - model-rewritten by the configured rewriter model, prompted with the tool schema and the
     target length. The prompt does not include the eval tasks.
3. Try candidates shortest first. Accept the first one that is non-inferior to the current
   accepted state, which means all three of these hold:
   - no task loses ≥ ⌈k/2⌉ passes;
   - the lower bound of the paired bootstrap 95% CI on the success difference is ≥ −δ
     (default δ = 0.03);
   - the upper bound of the `invalidRate` difference is ≤ +0.02.
4. Stop at `--max-evals`, or when no tool has an untried candidate.
5. Confirm the final override set against `base` on `heldout` with k ≥ 5. If non-inferiority fails
   there, report the result as overfit and keep the last state that passed.
6. Output `evals/toolevals/<target>/variants/desc-min/descriptions.json` plus a report: bytes before
   and after, the percentage cut, `surfaceTokens` before and after, and per-task outcomes.

Evaluating one tool at a time costs more trials, but each accepted change has its own evidence. A
`--batch` flag compresses every tool at one level per step, for large servers.

## 9. Prior art

- **Theo Browne, T3 Code MCP eval.** About 85–88 cases built from real agent failures with his MCP
  tools, each scored by a program. He hill-climbed the descriptions, then cut tool context while
  holding the score. Coverage reports 52% less context, or 78–79% with tool search; the figures
  conflict across sources. His UI "council" has rival models score screenshots 1–10 and iterate,
  and he warns that judged scores inflate. We take the program-scored hill-climb, the
  compression-under-constraint objective, and programmatic checks over vibes. What we add is the
  tap and trace metrics for any agent, paired statistics, and a held-out split.
- **MCPMark** (arXiv 2509.24002). 127 CRUD-heavy tasks across five MCP servers, each with a `verify.py`
  over the final state. Reports pass@1, pass@k and pass^k, with averages of 16 turns and 17 calls.
  It uses a minimal LiteLLM loop. We take state verification and pass^k. Unlike MCPMark, we drive
  real agents and keep per-call error classes.
- **MCP-Universe** (Salesforce, 2508.14704). Six domains on 11 real servers, with execution-based
  format, static and dynamic evaluators instead of a judge. We take the dynamic evaluator idea:
  `state` checks may run commands.
- **MCP-Bench** (Accenture, 2508.20453). 28 servers and 250 tools, with fuzzy instructions that don't
  name tools. It has rule checks (tool validity, schema compliance) plus an LLM judge for planning.
  It found schema compliance largely solved and planning weak. We take the rule-based schema check
  in the proxy and leave planning to outcome checks.
- **mcp-evals** (npm). A TypeScript/YAML eval runner and GitHub Action that grades with an LLM judge
  on 1–5 scales, plus an alpha OTel stack for tool call counts and latency. We differ in preferring
  deterministic checks and calibrating any judge.
- **Terminal-Bench 2.0 / Harbor** (2601.11868). 89 containerized tasks with human solutions and
  state-checking tests, reported as mean ± 95% CI over trials. The Harbor harness plugs in Claude
  Code, Codex and others. Scaffold choice moves scores by up to 17 points. We stay Harbor-compatible
  on export, and treat the scaffold as a driver to compare.
- **tau-bench / tau2-bench** (Sierra). A simulated user plus domain tools, scored by comparing
  database state with a goal state, and the pass^k metric. We take pass^k. Simulated users are out
  of scope for v0.
- **LiveMCPBench** (2508.01780). 95 tasks over 527 tools with retrieval, judged by LiveMCPEval at 81%
  human agreement. It is evidence that a judge needs agreement numbers, which `src/judge` already
  requires.
- **Vercel CLI guidelines** (vercel.com/design/cli). Rules for stdout/stderr separation, one JSON
  document per `--json` call, exit codes 0/1/2/130, fast offline `--help` with `--help --json`
  schemas, `action_required` errors in non-interactive mode, one "did you mean" suggestion, and a
  rule that agents never add `--yes` on their own. These are static rules. Tool evals measure
  whether they help in practice, through `invalidRate`, `helpLookups` and `recoveryRate`. Vercel's
  AGENTS.md study (an 8 KB docs index scored 100% against 79% for skills) is the kind of
  instruction-surface A/B in §8.1.
- **Agent experience (AX).** Biilmann/Netlify coined the term. Netlify's AXIS scores scenarios with
  a weighted rubric (40% goal judged by LLM, 20% each for environment, service and behavior)
  across 23 agents and fails CI on regressions. AgentProbe grades a CLI A–F from turns and success
  with Claude Code. Informal reports cite a 15.9% error rate over 1,324 CLI calls and agents
  ignoring `--help`. Anthropic's "Writing effective tools for agents" recommends accuracy,
  runtime per call and per task, total calls, tokens, and tool errors, measured on a held-out set.
  Our metric table covers that list. We add classification by the tap and paired comparison.

Our position: the target runs locally; every number comes from captured traces plus a tap rather
than from agent self-reports; the same suite runs under any adapter or a bare model; comparisons
are paired by task with intervals; and description compression is a constrained search with a
held-out confirmation.

## 10. MCP client: minimal protocol subset

Target spec: MCP 2026-07-28, which is stateless, plus legacy 2025-11-25, 2025-06-18 and 2025-03-26.
The client is dual-era, and it caches the detected era per server.

**JSON-RPC.** Messages are `{"jsonrpc":"2.0","id":<string|int>,"method","params"}`. Notifications
have no `id`. Errors are `{code, message, data?}`. Error codes the client handles:

| Code | Meaning |
|---|---|
| −32700 | parse error |
| −32600 | invalid request |
| −32601 | method not found |
| −32602 | invalid params, including unknown tool |
| −32603 | internal error |
| −32020 | header mismatch |
| −32021 | missing client capability |
| −32022 | unsupported version; `data.supported` lists the versions |

**Modern handshake (2026-07-28).** Every request carries
`params._meta["io.modelcontextprotocol/protocolVersion"]`, `…/clientCapabilities` (`{}`) and
`…/clientInfo`. Discovery:
`server/discover` → `{resultType:"complete", supportedVersions, capabilities, instructions?}`. A
missing `resultType` is treated as `"complete"`.

**Legacy handshake.**
1. Send `initialize {protocolVersion, capabilities:{}, clientInfo}`.
2. Receive `{protocolVersion, capabilities.tools, serverInfo, instructions?}`.
3. Send the `notifications/initialized` notification.
4. If the server returns a version the client does not support, close the connection.

**Era detection.**
- stdio: send `server/discover`. A result or −32022 means modern. Any other error, or no reply
  within 5 s, means legacy: send `initialize`.
- HTTP: POST `server/discover`.
  - 400 with a −3202x body means modern.
  - Another 4xx means legacy: POST `initialize`.
  - If that returns 400/404/405, GET the URL. An `endpoint` SSE event means the 2024-11-05
    HTTP+SSE transport. That transport is out of scope for v0: report `unsupported-transport`.

**`tools/list {cursor?}`.** Returns `{tools:[{name, title?, description?, inputSchema, outputSchema?,
annotations?}], nextCursor?}`. Repeat until `nextCursor` is absent. 2026-07-28 adds `ttlMs` and
`cacheScope`, which are ignored.

**`tools/call {name, arguments}`.** Returns `{content:[{type:"text",text}|{type:"image",data,mimeType}|
{type:"resource_link",uri}|{type:"resource",resource}], structuredContent?, isError?}`. A protocol
error (a JSON-RPC `error`) is class `invalid`. `isError: true` is class `failed`, unless the proxy's
own schema check failed or the error text matches the configured validation patterns: many SDKs
report schema failures as `isError`. Results go to the model as text: `structuredContent` JSON when
present, else the concatenated text blocks, with images replaced by `[image <mimeType>]`.

**stdio transport.**
- One JSON message per line, UTF-8, with no embedded newlines.
- stdout carries protocol only; stderr is logged to the tap as `serverStderr` (first 8 KB).
- Shutdown: close stdin, wait 2 s, send SIGTERM, wait 2 s, send SIGKILL.
- Cancel a request with `notifications/cancelled {requestId}`.

**Streamable HTTP.**
- POST every message with `Content-Type: application/json` and
  `Accept: application/json, text/event-stream`.
- The response is either JSON or an SSE stream. In an SSE stream, the event whose `id` matches is
  the response, and earlier events are notifications, which are logged.
- A notification is answered with 202.
- Legacy mode:
  - store `Mcp-Session-Id` from the `initialize` response and echo it;
  - send `MCP-Protocol-Version: <negotiated>` after `initialize`;
  - a 404 with a session id means the session expired: re-initialize once;
  - send DELETE on close, and ignore a 405.
- Modern mode: also send the `Mcp-Method` header, and `Mcp-Name` on `tools/call`. There are no
  sessions and no GET.

Not implemented: resources, prompts, sampling, elicitation, roots, progress, tasks and OAuth. HTTP
auth is limited to static headers from env.

## 11. Model APIs (model driver)

| Provider | Tools | Tool result | Usage | TTFT |
|---|---|---|---|---|
| `anthropic` | `tools:[{name, description, input_schema}]`; response blocks `tool_use {id,name,input}`, `stop_reason:"tool_use"` | user message `tool_result {tool_use_id, content, is_error}` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (from `message_start` and `message_delta`) | first `content_block_delta` (text or thinking, recorded separately as `ttftMs` and `ttfThinkingMs`) |
| `openai` (Responses) | `tools:[{type:"function", name, description, parameters, strict:false}]`; output `function_call {call_id, name, arguments}` | input item `function_call_output {call_id, output}` | `response.completed.usage` incl. cached and reasoning tokens | first `*.delta` event |
| `openai-chat` | `tools:[{type:"function", function:{name, description, parameters}}]`; `message.tool_calls` | `{role:"tool", tool_call_id, content}` | last chunk with `stream_options.include_usage` | first chunk with content or tool_calls |

MCP `inputSchema` passes through as `input_schema` / `parameters`. A provider that rejects a schema
fails the trial with `error: "schema-rejected-by-provider"`, which is counted separately from agent
failures. Retries: up to 3 on 429/5xx with `retry-after`, recorded as `llm.call` events with
`ok:false`.

## 12. CLI surface

The `toolevals` group follows the Vercel grammar `coding.sh <group> <action> [resource] [options]`.
The result goes to stdout; progress and plans go to stderr. `--json` prints one document. Exit
codes are 0, 1, 2 and 130.

| Command | Does |
|---|---|
| `coding.sh toolevals init --cli <bin> \| --mcp "<cmd>" \| --mcp-url <url> \| --http <url> [--name n] [--dry-run]` | Adds `[toolevals.targets.<n>]` to `coding.sh.toml`, crawls the surface, and writes `evals/toolevals/<n>/` with 3 starter tasks marked `draft` |
| `coding.sh toolevals surface <target> [--variant v] [--json]` | Surface bytes, description bytes and estimated tokens per tool or subcommand |
| `coding.sh toolevals validate [<target>] [--json]` | Runs task validation (§3) |
| `coding.sh toolevals run <target> --driver <d>… [--variant <v>…] [-k 3] [--split dev\|heldout\|all] [--task id…] [--concurrency n] [--keep] [--yes] [--json]` | Runs an experiment and prints its id plus a per-arm summary |
| `coding.sh toolevals compare <experimentId> --baseline <arm> --candidate <arm> [--json]` | §8.2 report |
| `coding.sh toolevals compress <target> --driver <d> [-k 3] [--margin 0.03] [--max-evals 40] [--batch] [--yes] [--json]` | §8.3 |
| `coding.sh toolevals show <trialId> [--json]` | Trial metrics, tap records, and the session tree with subagents |

- Driver syntax: `agent:claude-code`, `agent:codex:gpt-5.5`, `model:anthropic/claude-sonnet-5`.
  Arms are named `<variant>@<driver>`.
- Cost gate: if the estimated cost exceeds `[toolevals] confirmAboveUsd` (default 5), a TTY gets a
  y/N prompt. In non-interactive mode the command fails with
  `{status:"action_required", reason:"cost_confirmation_required", next:"rerun with --yes"}`.
- `tap cli|mcp|http` are internal subcommands, hidden from help. `dist/tap.mjs` is a separate
  bundle so that shim startup stays small.

## 13. File layout

```
coding.sh.toml                         # committed: [toolevals] defaults, targets, prices, drivers
evals/toolevals/<target>/
  tasks/*.toml | tasks.jsonl           # dev tasks (and heldout, unless kept outside the repo)
  fixtures/                            # setup inputs; generators write answers.json to hidden/
  variants/<name>.toml                 # command/env overrides
  variants/<name>/descriptions.json    # MCP overrides {"<tool>": "desc"}, plus params
~/.coding.sh/toolevals/<experimentId>/
  experiment.json                      # spec, arms, git commit, agent versions
  trials.jsonl                         # TrialResult per line
  <trialId>/                           # deleted unless --keep
```

`coding.sh.toml` holds eval definitions and is committed. `.coding.sh/config.toml` remains the
local capture and store override. A `heldout` path may point outside the repo (`heldoutDir`), so
agents improving the target cannot read those tasks (see docs/design/dogfood.md §3).

Each trial is also written as a `RunResult` through `IndexStore.putRun`, with `taskId`,
`bundleId = sha256(arm)`, `experimentId`, `pass` and `agent`. Existing run listings show it, and
no contract change is needed. Full metrics live in `trials.jsonl`. A proposed later change adds
`RunResult.metrics?: Record<string, number>`.

## 14. Module plan and interfaces

```
src/toolevals/
  types.ts        config.ts      surface.ts     sandbox.ts     mount.ts
  classify.ts     metrics.ts     checks.ts      experiment.ts  compare.ts
  compress.ts     report.ts      jsonschema.ts  index.ts
  drivers/agent.ts     drivers/model.ts
  model/loop.ts        model/anthropic.ts   model/openai.ts   model/sse.ts   model/tools.ts
  mcp/jsonrpc.ts       mcp/stdio.ts         mcp/http.ts       mcp/client.ts
  tap/cli.ts           tap/mcp-proxy.ts     tap/http-proxy.ts tap/main.ts (→ dist/tap.mjs)
src/cli/commands/toolevals.ts
test/toolevals/**  fixtures: fake-cli.mjs (exit 2 on unknown flags), fake-mcp-legacy.mjs,
                   fake-mcp-modern.mjs (stdio + http), fake-provider.mjs (SSE for both APIs)
```

```ts
// src/toolevals/types.ts
import type { AgentId, BlobRef, Usage } from "../schema/index.ts";

export interface TargetBase { name: string; docs?: string[]; docsUrls?: string[]; env?: Record<string, string> }
export interface CliTarget extends TargetBase {
  kind: "cli"; bin: string; command: string[];
  usageExitCodes: number[]; usagePatterns: string[]; helpCrawl: boolean;
}
export type McpTarget = TargetBase & { kind: "mcp"; docTools?: string[] } &
  ({ transport: "stdio"; command: string[] } | { transport: "http"; url: string; headers?: Record<string, string> });
export interface HttpTarget extends TargetBase {
  kind: "http"; baseUrl: string; openapi?: string; auth?: { header: string; env: string };
}
export type Target = CliTarget | McpTarget | HttpTarget;

export interface Variant {
  name: string;
  command?: string[]; env?: Record<string, string>; url?: string;       // CLI / HTTP / MCP-http overrides
  descriptions?: Record<string, string>;                                   // MCP tool → description
  paramDescriptions?: Record<string, Record<string, string>>;              // MCP tool → param → description
  hideTools?: string[];
  bundle?: string;                                                         // harness bundle for agent drivers
}

export type Driver =
  | { kind: "agent"; agent: AgentId; model?: string; flags?: string[] }
  | { kind: "model"; provider: "anthropic" | "openai" | "openai-chat"; model: string;
      baseUrl?: string; apiKeyEnv: string; system?: string; maxOutputTokens?: number; temperature?: number };
export const driverKey = (d: Driver): string =>
  d.kind === "agent" ? `agent:${d.agent}${d.model ? ":" + d.model : ""}` : `model:${d.provider}/${d.model}`;

export interface Budget { turns?: number; tokens?: number; wallMs?: number; costUsd?: number }

export type StateAssertion =
  | { file: string; exists?: boolean; contains?: string; regex?: string; jsonPath?: string; equals?: unknown }
  | { command: string; stdoutContains?: string; jsonPath?: string; equals?: unknown };
export type Check =
  | { kind: "command"; run: string; timeoutMs?: number; hiddenFiles?: Record<string, string> }
  | { kind: "state"; assert: StateAssertion[] }
  | { kind: "output"; equals?: string; contains?: string[]; regex?: string; jsonPath?: string;
      jsonEquals?: unknown; normalize?: ("trim" | "lower" | "collapse-ws")[] }
  | { kind: "judge"; judge: string; rubric: string };

export interface ToolTask {                 // structurally a Case: id, input (= instruction), tags, metadata
  id: string; target: string; split: "dev" | "heldout"; tags: string[];
  instruction: string;
  setup: { commands: string[]; files: Record<string, string>; env: Record<string, string> };
  checks: Check[]; budget: Budget; reference?: string[];
  expect?: { minTargetCalls?: number };
  status: "draft" | "validated";
  source: string;                           // file path (and line for JSONL), for error messages
}

export type TapClass = "ok" | "invalid" | "failed" | "help" | "meta";
export interface TapRecord {
  ts: number; durationMs: number; target: "cli" | "mcp" | "http"; class: TapClass; reason?: string;
  argv?: string[]; exitCode?: number | null; stderrHead?: string;                   // cli
  method?: string; tool?: string; rpcErrorCode?: number; isError?: boolean;         // mcp
  schemaViolations?: string[];
  httpMethod?: string; pathTemplate?: string; status?: number;                      // http
  requestBytes?: number; responseBytes?: number;
}

export interface ToolMetrics {
  success: boolean; budgetExceeded?: keyof Budget;
  turns: number; turnsSource: "llm.call" | "messages" | "adapter";
  toolCalls: number; targetCalls: number; invalidCalls: number; invalidRate: number;
  invalidKinds: Record<string, number>; failedCalls: number;
  helpLookups: number; helpBytesRead: number;
  retries: number; selfCorrections: number; recoveryRate: number | null;
  firstCallCorrect: boolean | null; callsToFirstCorrect: number | null; timeToFirstCorrectMs: number | null;
  efficiency: number | null;
  usage: Usage; costUsd: number | null; costSource: "reported" | "estimated" | "none";
  wallMs: number;
  llmP50Ms?: number; llmP95Ms?: number; ttftP50Ms?: number; ttftP95Ms?: number;
  latencySource: "model-driver" | "otel-trace" | "otel-log" | "hooks" | "approx" | "none";
  targetLatencyP50Ms?: number; targetLatencyP95Ms?: number; toolLatencyP95Ms?: number;
  subagents: number; subagentTargetCalls: number; subagentTokenShare: number | null;
  tapCoverage: number | null;
}

export interface SurfaceReport {
  target: string; variant: string; surfaceBytes: number; descriptionBytes: number;
  surfaceTokens: number; tokensEstimated: boolean;
  items: { name: string; bytes: number; descriptionBytes: number }[];   // per tool or subcommand
}

export interface TrialResult {
  id: string; experimentId: string; taskId: string; variant: string; driver: string; attempt: number;
  sessionId?: string; childSessionIds: string[];
  pass: boolean; checks: { kind: Check["kind"]; pass: boolean; detail?: string }[];
  metrics: ToolMetrics; tapBlob?: BlobRef; error?: string;
  startedAt: number; endedAt: number;
}
```

```ts
// signatures (each module exports these)
// config.ts
export function loadToolEvals(repoRoot: string): Promise<{ targets: Map<string, Target>;
  variants: Map<string, Map<string, Variant>>; tasks: ToolTask[]; heldoutDir?: string }>;
// surface.ts
export function measureSurface(t: Target, v: Variant, opts?: { countTokens?: (s: string) => Promise<number> }): Promise<SurfaceReport>;
// sandbox.ts
export interface Sandbox { root: string; work: string; home: string; bin: string; hidden: string; tapLog: string; env: Record<string, string> }
export function prepareSandbox(task: ToolTask, target: Target, variant: Variant, trialId: string, root: string): Promise<Sandbox>;
// mount.ts
export function mountMcp(agent: AgentId, server: { name: string; stdio?: string[]; url?: string }, sb: Sandbox):
  Promise<{ env: Record<string, string>; flags: string[]; files: Record<string, string> }>;
// drivers
export function runAgentTrial(o: { adapter: Adapter; driver: Extract<Driver, { kind: "agent" }>; task: ToolTask;
  sandbox: Sandbox; bundle?: HarnessBundle; blobs: BlobStore; trialId: string }): Promise<AgentRunOutput>;
export function runModelTrial(o: { driver: Extract<Driver, { kind: "model" }>; task: ToolTask; target: Target;
  sandbox: Sandbox; index: IndexStore; trialId: string; fetch?: typeof fetch }): Promise<AgentRunOutput & { finalText: string }>;
// checks.ts
export function runChecks(task: ToolTask, sb: Sandbox, finalText: string, judge?: JudgeFn): Promise<TrialResult["checks"]>;
// classify.ts
export type CallCategory = "shell" | "read" | "web" | "mcp" | "edit" | "subagent" | "other";
export function classifyToolStart(e: AgentEvent): { category: CallCategory; command?: string; path?: string; url?: string; mcp?: { server: string; tool: string } };
// metrics.ts (pure)
export function computeMetrics(i: { task: ToolTask; target: Target; tap: TapRecord[]; events: AgentEvent[];
  sessions: Session[]; run: AgentRunOutput; checksPass: boolean; prices?: Record<string, { input: number; output: number; cacheRead?: number }> }): ToolMetrics;
// experiment.ts
export function runToolExperiment(o: { tasks: ToolTask[]; target: Target; variants: Variant[]; drivers: Driver[];
  k: number; concurrency?: number; adapterFor: (a: AgentId) => Adapter; index: IndexStore; blobs: BlobStore;
  keep?: boolean; onProgress?: (done: number, total: number, t: TrialResult) => void }): Promise<{ experimentId: string; trials: TrialResult[] }>;
// compare.ts
export function compareToolArms(trials: TrialResult[], o: { baseline: string; candidate: string; alpha?: number; seed?: number }): ToolCompareReport;
// compress.ts
export function compressDescriptions(o: { target: McpTarget; tasks: ToolTask[]; driver: Driver; k: number; margin: number;
  maxEvals: number; batch?: boolean; rewrite: (tool: McpTool, targetBytes: number) => Promise<string> } & ExperimentDeps): Promise<CompressReport>;
// mcp/client.ts
export interface McpTool { name: string; title?: string; description?: string; inputSchema: object; outputSchema?: object; annotations?: object }
export interface McpClient { era: "2026-07-28" | "legacy"; protocolVersion: string; serverInfo?: { name: string; version: string };
  instructions?: string; listTools(): Promise<McpTool[]>; callTool(name: string, args: object, o?: { timeoutMs?: number }): Promise<CallToolResult>; close(): Promise<void> }
export function connectMcp(spec: { stdio?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): Promise<McpClient>;
```

`ToolCompareReport` is `CompareReport` with `metrics` keyed by `ToolMetrics` field names, plus
`surface: {baseline: SurfaceReport, candidate: SurfaceReport}` and `regressions[]`.
`CompressReport` holds `{steps: {tool, fromBytes, toBytes, accepted, evidence}[], final:
Record<string,string>, bytesBefore, bytesAfter, heldout: ToolCompareReport, overfit: boolean}`.

## 15. Acceptance tests (builder checklist)

1. **Shim.** A fake CLI returns exit 2 on an unknown flag and exit 0 on `--help`. A scripted
   agent calls it 4 times. The tap has 4 records with the right classes, and `durationMs`
   excludes shim startup: within 5 ms of a direct spawn, median of 20 runs.
2. **MCP proxy, stdio and HTTP, against legacy and modern fakes.** `tools/list` overrides are
   applied. Bad arguments produce `schemaViolations`. A −32602 error is classified `invalid`.
   `isError` is classified `failed`. Byte counts match.
3. **MCP client** against both fakes, both transports: era detection, `tools/list` paging
   (3 pages), `tools/call`, shutdown sequence (the process is gone within 5 s).
4. **Model driver** against the fake SSE provider: `llm.call` events with `ttftMs` and usage; a
   tool round trip; the turn budget stops the loop.
5. **`computeMetrics`** on hand-built event and tap fixtures: retries, self-corrections, recovery
   rate, time to first correct call, subagent window attribution, `tapCoverage` below 1 when a
   Bash command calls the binary by absolute path.
6. **`compareToolArms`**: identical arms → `no-difference`; a seeded 30-point success gap over
   20 tasks with k=3 → `better`, with the CI excluding 0; a regressions list on a constructed
   pass → fail.
7. **`compressDescriptions`** with a deterministic fake driver whose success depends on the presence
   of one keyword: the keyword survives, the other text is removed, and the held-out confirmation
   passes.
8. **CLI**: `--json` emits one document per command; exit code 2 on an unknown flag; the cost gate
   in non-interactive mode returns `action_required`; `--help` takes under 200 ms.
