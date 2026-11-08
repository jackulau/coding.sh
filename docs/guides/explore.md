# Explore sessions: CLI, viewer and MCP

## CLI

```sh
coding.sh sessions                 # recent sessions (--agent, --repo, --since, --subagents, --empty)
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

## Model calls

Calls logged by [the proxy](../how-to/capture-with-proxy.md) keep their full request and response.

```sh
coding.sh show latest#-1           # the last model call: system prompt, tools, settings, cache, usage, cost
coding.sh show <session>#3 --all   # the third call, with the whole system prompt
coding.sh diff-calls latest#-1     # what changed since the call before, and why the cache missed
coding.sh diff-calls <a> <b>       # any two calls
```

`diff-calls` compares model, settings, tool definitions, the system prompt (line by line) and the
messages, in the order the prompt cache reads them, and names the first change that broke the cache.
In the viewer, a proxy call in the timeline opens to the same view, with "Compare with the previous
call".

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

## Replay

`coding.sh replay` walks a session step by step: each prompt, reply and tool call is one
numbered step, and the files the agent touched are rebuilt as of any step from its own tool
calls.

```sh
coding.sh replay <session>                      # the steps, and the files they touched
coding.sh replay <session> --step 12            # what step 12 did: command, exit code, output, diff
coding.sh replay <session> --step 12 --file src/app.ts   # that file as it was after step 12
coding.sh replay <session> --step 5 --to 12     # what steps 5 to 12 changed, per file
```

A file's content is known from the first step that shows all of it, and stays known through
later edits:

- a full write (Write, `write_file`, an `apply_patch` Add File) sets it, and so does a new file
  whose whole diff the agent recorded;
- a full read (Read, `read_file`, `cat file`) sets it, and when the read shows something other
  than the replay expected, the step reports that change too;
- Claude Code records the file before each Edit and Write, so the file is known from its first edit;
- a session from `coding.sh run` or an eval run starts from its snapshot;
- edits (Edit, MultiEdit, `str_replace`, `apply_patch` hunks, a recorded diff) apply in order.

An edit to a file no step has shown yet, an edit whose old text is not in the file, an edit
whose input does not record its text, or a change with no content (the plain wrapper) leaves
the file unknown from that step on, until a later read or write. The replay says which step and
why, and shows the agent's own diff for that step instead of guessing at line numbers. A shell
command that changes files (`sed -i`, `rm`) changes them in the replay only when the agent
recorded the change. Nothing is re-run.

### Fork from a step

`--fork` re-runs a step with a changed harness. It needs the session captured through
[the proxy](../how-to/capture-with-proxy.md) in capture mode `full`. The fork starts from the
request the proxy stored for the model call that made step N: the call whose reply holds the
step's tool call, or, for a prompt, the call that answered it. It then shows the action the agent
recorded next to the action the forked call took.

```sh
coding.sh replay <session> --step 12 --fork --with CLAUDE.md=fixed.md -k 3
coding.sh replay <session> --step 12 --fork --with AGENTS.md --model claude-haiku-4-5
coding.sh replay <session> --step 12 --fork --harness strict-tests
coding.sh replay <session> --step 12 --fork --with CLAUDE.md --run --verify 'npm test'
coding.sh replay <session> --step 12 --fork --with CLAUDE.md --save-case forks
```

- `--with DEST=SRC` uses SRC's text as DEST. A bare `--with PATH` uses that file as it is now,
  and `DEST=` drops the file. DEST is a CLAUDE.md, an AGENTS.md, a rule, a skill or
  `~/.claude/CLAUDE.md`. coding.sh changes the file where the agent put it in the request:
  Claude Code's `Contents of <path>` sections and Codex's `# AGENTS.md instructions` block. A file
  the request did not carry is added the way Claude Code adds CLAUDE.md. `--harness` takes the
  context files and the model from a stored bundle, `--model` sends the call to another model and
  `--system` replaces the system prompt.
- Without `--run`, the call is sent again `-k` times (default 1), not streamed. Each forked
  action is marked `different` or `same`.
- `--run` runs Claude Code from step N. It copies the session's directory to a temp dir (or
  `--workdir`) and puts back the files the agent changed from step N on, as far as the replay
  knows them. It writes the changed files into the copy and starts Claude Code there with the
  step's prompt. A local splice puts the stored conversation up to step N into each of its
  requests, after the first message. So the model sees the session's history, and the tools act on
  the copy. The output is the recorded steps from N next to the fork's own actions.
  `--verify CMD` then runs CMD in the copy, and the command exits 1 when CMD fails. The fork's
  calls are recorded as a session of their own.
- `--save-case SUITE` saves the step as a case in `evals/SUITE`. The recorded action becomes the
  thing the case must not do. See
  [Fork a failing step into a case](evals.md#fork-a-failing-step-into-a-case).

Forking calls the API with `ANTHROPIC_API_KEY` (or a subscription token in
`CLAUDE_CODE_OAUTH_TOKEN`) or `OPENAI_API_KEY`, never the agent's login. In `coding.sh ui`, the
Replay pane has a "Fork from here" tab. It shows the step's context files as the agent had them,
lets you edit them, and shows the recorded and forked actions side by side. The MCP tool
`session_replay` forks too: pass `step` and `fork` (`{"CLAUDE.md": "…"}`; an empty text drops a
file).

## Memory and instruction files

`coding.sh harness audit` lists each memory and instruction file and counts the sessions that
loaded it, read it with a tool and wrote it: Claude Code's auto-memory
(`~/.claude/projects/*/memory/`), CLAUDE.md, AGENTS.md and GEMINI.md, rules in `.claude/rules/`,
and skills (`SKILL.md`).

```sh
coding.sh harness audit                          # the last 30 days, flagged files first
coding.sh harness audit --agent codex --since 90d
coding.sh harness audit --json                   # every file, with totals
```

The counts come from captured events:

- **loaded**: a `harness.loaded` event (a nested CLAUDE.md, a skill listed or invoked), or a
  file the agent loads at start for the session's directory. For Claude Code that is
  `~/.claude/CLAUDE.md`, CLAUDE.md and `CLAUDE.local.md` up the tree, rules without a `paths`
  or `globs` frontmatter, the project's `MEMORY.md` and the skill list. For Codex it is
  `AGENTS.md` in `CODEX_HOME` and from the repo root down to the directory, and its skills. A
  start-time load counts only for a file that is on disk now.
- **read**: a read tool (Read, `read_file`, …), a shell reader (`cat`, `head`, `tail`, `sed`,
  `less`, `nl`, `bat`) on the path, or invoking the skill.
- **wrote**: a recorded file change, an edit tool, or a shell write (`> file`, `tee`, `sed -i`).

A subagent counts as its root session, and its own directory (a worktree, say) counts for the
start-time loads. Flags:

- `never-read`: on disk, and no session in the window loaded or read it.
- `write-only`: written, and no session other than the ones that wrote it loaded or read it.
- `loaded-not-read`: a skill that was listed but never invoked or read.

SIZE is the file's size. The load cost in the summary is tokens (bytes / 4) times the sessions
that loaded the file; a skill costs its name and description, the part agents list. Files are
matched across machines by their path under the home directory (`~/…`), so the audit reads the
files on this machine and the sessions from any.

## Viewer

`coding.sh ui` serves the viewer on 127.0.0.1 and opens it in your browser. It needs the
per-process token in the URL it prints.

The bar above the session list takes the same query as `--where`, so `tool:Bash ok:false
-flag:compaction` or plain words narrow the list as you type. It completes keys, then their
values with session counts (Tab or a click accepts; Enter runs the query and moves to the list;
Esc closes the suggestions). A bad query keeps the last rows on screen; Enter shows what is wrong
and puts the caret on it. Each clause shows as a chip with × to remove it. The sidebar counts
sessions per agent, model, repository, branch, flag, tool, MCP server and event kind. A click
adds a value to the query (two values of one key mean either), Alt-click or "not" excludes it,
and each group folds shut. On a phone the sidebar is a sheet behind the Filters button. The query
lives in the URL (`#/?where=…`), so a filtered list can be linked and survives a reload; `/`
focuses the bar.

The Events tab (`#/events?where=…`, or `e` from the list and `s` back) runs the same query as
event rows, newest first: event keys such as `tool:Bash ok:false` test each event, session keys
test its session, and text marks the words it matched. Subagents' events show when the sidebar
includes subagents. Enter opens the event's step in its session, where `n` and `N` move through
the other events in that session that match the query. Event rows need the SQLite store; on a
store plugin the tab says so.

The session page shows the first 5,000 events right away and loads the rest in the background.
The timeline only draws the rows on screen, so a 40,000-event session scrolls smoothly. Each
derail gets a ⚑ badge on the step where it started and a mark on the scroll map; the ‹ › buttons
step through them. The first step of each phase and each new day gets a label. For a running
session, the page adds new events every 4 seconds.

**Replay** (or <kbd>R</kbd>) on the session page plays the session back one step at a time.
<kbd>Space</kbd> plays and pauses, <kbd>←</kbd> <kbd>→</kbd> or <kbd>j</kbd> <kbd>k</kbd> step,
<kbd>s</kbd> changes the speed and <kbd>Esc</kbd> leaves. At 1× each step waits for the real time
to the next one, from 0.4 to 3 seconds, so long pauses are cut short; 4× and 16× divide that. The
scrubber jumps anywhere, with marks on edits and failures. The pane shows the step (the shell
command with its exit code and output, or the prompt or reply), the files touched so far, and
three tabs: the diff this step made, a file as of this step, and what changed since an earlier
step. The address ends in `?step=N`, so a copied link opens the replay at that step.

## MCP

`coding.sh mcp` serves your captured data to agents over stdio, with the tools `improve`,
`harness_changes`, `sessions_list`, `session_get`, `session_current`, `session_replay`, `search`,
`failures`, `latency`, `usage`, `subagents`, `eval_from_session`, `eval_init`, `experiments_list`,
`experiment_compare`, `exp_session_summary`, `exp_session_note`, `harness_compare`, `benchmarks` and
`status`. `improve` and `harness_changes` return what `coding.sh improve` and `coding.sh improve
check` print, for the repo the server runs in or the one named by `repo`. The server also has two
prompts, `improve` and `did-it-help`, which run that loop; see
[Improve your agent every week](improve.md). `sessions_list` and `session_get`
include each session's derails, and `sessions_list` takes `flag: "looping"` (or any other flag).
`sessions_list`, `search` and `usage` take `where`, the same filter as `--where`, and
`sessions_list` takes `facets: ["model", "tool"]` for counts per value.
`exp_session_note` adds a note to the experiment session of the project folder (the hypothesis
before a run, the reading after it), and `exp_session_summary` returns its timeline with the same
blocks as `coding.sh exp session summary --json`, which is how an agent picks the thread back up
after a context reset. Without a session they return a `not_found` error with the command that
starts one.
`session_replay` gives the same as `coding.sh replay`: the steps, one step with `step` (and a
file with `file`), or a range with `from` and `to`. With `step` and `fork` it forks that step
(see [Fork from a step](#fork-from-a-step)); this one calls the model.

`coding.sh init` registers it with Claude Code, Codex, Cursor and OpenCode (`--no-mcp` skips
this). `coding.sh mcp config` prints the snippet for any other client.
