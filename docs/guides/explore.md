# Explore sessions: CLI, viewer and MCP

## CLI

```sh
coding.sh sessions                 # recent sessions (--agent, --repo, --since, --subagents)
coding.sh show latest              # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"      # full-text search over prompts, replies and tool calls
coding.sh usage --by model         # tokens, cost, turns and cache hits by agent, model, day or repo
coding.sh sql "select …"           # one read-only SQL query against the SQLite index
coding.sh export events --since 7d # stream sessions, events or labels as JSONL or CSV
coding.sh ui                       # local viewer on 127.0.0.1 (token-protected URL)
```

`sql` and `export` are described, with the index's tables and columns, in
[Query and export](../reference/query.md).

### Filter with `--where`

`sessions`, `search`, `usage` and `export` take one filter language. Clauses are and-ed; `OR`,
`( )` and a leading `-` combine them; bare words search the text.

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'   # a failed Bash call, never compacted
coding.sh sessions --where 'model:claude-* has:tests sort:-cost limit:5'
coding.sh sessions --facets model,tool --where 'repo:coding-sh'    # counts per value
```

```text
$ coding.sh sessions --facets agent,tool --where -flag:compaction
AGENT	SESSIONS
claude-code	1
codex	1
gemini	1

TOOL	SESSIONS
Bash	2
Edit	1
```

Event keys (`tool`, `kind`, `ok`, `mcp`, `error`, `event.duration`) in one group must match the
same event. Every key, with an example, is in
[Query and export](../reference/query.md#filter-with---where). A typo points at the character:

```text
$ coding.sh sessions --where 'agent:codex modle:x'
✗ --where: unknown key "modle" at character 13
  Query           agent:codex modle:x
                              ^
    did you mean model:?
```

Every command takes `--json` and `--help`. `coding.sh` with no command runs `init` until capture
is set up, then opens the viewer.

## Long sessions

A session can run for hours or days, with many compactions and resumes. coding.sh keeps it as
one timeline and splits it into phases:

- **start**: the first run.
- **resumed after 47 min**: `claude --resume` (the hook's SessionStart says so), or new events
  more than 5 seconds after the session ended.
- **compacted (auto)** or **compacted (manual)**: the context was compacted.
- **back after 35 min idle**: no events from the main agent for 30 minutes or more.

A subagent's work stays inside its parent's phase. Transcripts and Codex rollout files have no
resume marker, so a resume with no hook capture shows as an idle gap.

```sh
coding.sh show <session>           # over 200 events: one line per phase, with day lines and derails
coding.sh show <session> --all     # every event, with phase and day lines and derail markers
coding.sh show <session> --limit 500
coding.sh show latest --follow     # keep printing new events while it runs; Ctrl-C stops
coding.sh sessions --flag looping  # sessions with one derail (or any other flag)
```

`show --json` adds `phases` and `days`. `--follow` prints the last 20 events, then every new
event and derail as hooks write them. It stops on its own after the session ends.

### Derails

A derail is a point where a long run went off the rails. Each one records the event and time it
started, and shows in `show`, on the viewer timeline, in `sessions --flag <name>` and in the MCP
`sessions_list` and `session_get` tools. A session gets at most 25.

| Flag | Fires when | Threshold |
| --- | --- | --- |
| `looping` | The same tool call returns the same result again and again with no edit in between. | 5 times within 10 calls |
| `failure-streak` | Tool calls fail one after another. Calls the user interrupted don't count. | 5 in a row |
| `churn` | An edit to a file is undone, then undone again (Edit, MultiEdit, Write, apply_patch). | 2 reverts within 60 min |
| `no-progress` | A long stretch of calls with no edit, no file-writing shell command, no subagent and no better test result, while the context grows. Only in sessions that edit. | 80 calls, 40% of them repeats, context up 1.5x (or compacted) |
| `stalled` | A tool call sat with nothing else happening, then failed or never finished. | 15 min |
| `context-thrash` | Automatic compactions come back to back. Manual ones don't count. | under 3 min or under 15 tool calls apart |

What is never flagged: polling a background job (BashOutput, TaskOutput, `sleep`, `wait`),
driving a browser or desktop through MCP (clicks, key presses, screenshots), waiting on a
subagent or on the user, and long tool calls that succeed.

Ingest finds derails, flags and stats as events arrive and saves where each detector was, so a
live update reads the new events, not the whole session. For `looping`, `failure-streak`, `churn`,
`no-progress` and `duplicate-fetch`, a call whose end arrives after 64 more calls of the same agent
(or 1,024 in all) counts as unfinished. `stalled` still sees its late end.

To keep false positives low, the thresholds were checked on three sets of sessions:

| Set | Sessions | Flagged |
| --- | --- | --- |
| Real-agent captures and goldens in the test fixtures | 35 | 0 |
| A synthetic 12-hour session with one planted derail of each kind | 1 | the 6 planted, each within 5 s of its start, and nothing else |
| 60 days of real local sessions (708k events) | 1,500 | 10 (0.7%) |

The real-session hits were one session with about 50 automatic compactions, commands that sat for
1 to 4 hours and then failed or never finished, runs of failing calls and one loop.

`progress` compares how long runs stayed on track:

- `coding.sh compare` reports `derails / run` and `time to first derail` for each arm.
- A `{"kind": "progress"}` grader scores a run from its trace for `exp run` and `exp compare`.
  The score is the time to the first derail divided by the wall time, or 1 when the run never
  derailed. It passes with at most `maxDerails` derails (default 0). `flags` counts only the
  listed derail kinds.

### Executability

`executability` asks a different question: how far did the agent get before it made a tool call
the harness refused to run? It follows Prefix Executability
([arXiv 2610.40444](https://arxiv.org/abs/2610.40444)). Each main-stream tool call is a step.
Subagent calls, wrapper calls (a Codex code-mode cell) and interrupted calls are not steps. Each
step is one of:

- **ok**: the call succeeded.
- **failed**: the call ran and did not succeed. A test run that exits 1 is failed, not invalid.
- **invalid**: the harness refused the call before it ran.

An invalid call gets a kind from the first 2 KB of its output, checked in this order:

| Kind | Matches |
| --- | --- |
| `schema` | `InputValidationError`, a required or unexpected parameter, invalid or unparseable arguments, `must have required property`, `validation error` |
| `unknown-tool` | `No such tool available`, `unknown tool`, `tool … not found`, `not found in registry` |
| `precondition` | Claude Code's `has not been read yet` and `modified since read` |
| `state` | `String to replace not found`, `Found N matches`, `apply_patch verification failed` |
| `missing` | `File does not exist`; a shell exit 127 or `command not found`; `No such file or directory` on a read or edit call |
| `denied` | `Permission to use … denied`, a PreToolUse hook block |
| `other` | any other Claude Code `<tool_use_error>` |

A shell call with any other non-zero exit is failed, whatever its output says. A call with
`ok: false` and no output is failed too. Hook-only captures often carry no output, so their invalid
counts are a lower bound.

The First-Error Depth (FED) is the 1-based step of the first invalid call, or the number of steps
plus 1 when no call was invalid. A `{"kind": "executability"}` grader scores a run from its trace
for `exp run` and `exp compare`:

- The score is (FED-1) / steps: the share of steps before the first invalid call. It is 1 when no
  call was invalid or the run made no tool calls. The mean score over runs is AUC-PEC.
- It passes with at most `maxInvalid` invalid calls (default 0). With the default, the pass rate is
  TER, the share of runs with no invalid call.
- `kinds` counts only the listed kinds, for example `{"kind": "executability", "kinds": ["schema",
  "unknown-tool"]}`.
- A run with no timed trace scores 0 and fails.

The detail names the first invalid call, for example `first invalid call at step 4 of 37: Edit
(state): String to replace not found in file.`, or says `all 37 tool calls executable`. Read FED
next to the number of steps: an invalid call at step 4 of 37 and one at step 4 of 5 score very
differently. Two arms can share a pass rate on the task and still differ here.

## Viewer

`coding.sh ui` serves the viewer on 127.0.0.1 and opens it in your browser. It needs the
per-process token in the URL it prints.

The session page shows the first 5,000 events right away and loads the rest in the background.
The timeline only draws the rows on screen, so a 40,000-event session scrolls smoothly. Each
derail gets a ⚑ badge on the step where it started and a mark on the scroll map; the ‹ › buttons
step through them. The first step of each phase and each new day gets a label. For a running
session, the page adds new events every 4 seconds.

## MCP

`coding.sh mcp` serves your captured data to agents over stdio, with the tools `sessions_list`,
`session_get`, `session_current`, `search`, `failures`, `latency`, `usage`, `subagents`,
`eval_from_session`, `experiments_list`, `experiment_compare`, `exp_session_summary`,
`exp_session_note`, `harness_compare`, `benchmarks` and `status`. `sessions_list` and `session_get`
include each session's derails, and `sessions_list` takes `flag: "looping"` (or any other flag).
`sessions_list`, `search` and `usage` take `where`, the same filter as `--where`, and
`sessions_list` takes `facets: ["model", "tool"]` for counts per value.
`exp_session_note` adds a note to the experiment session of the project folder (the hypothesis
before a run, the reading after it), and `exp_session_summary` returns its timeline with the same
blocks as `coding.sh exp session summary --json`, which is how an agent picks the thread back up
after a context reset. Without a session they return a `not_found` error with the command that
starts one.

`coding.sh init` registers it with Claude Code, Codex, Cursor and OpenCode (`--no-mcp` skips
this). `coding.sh mcp config` prints the snippet for any other client.
