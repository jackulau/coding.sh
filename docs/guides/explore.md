# Explore sessions: CLI, viewer and MCP

## CLI

```sh
coding.sh sessions                 # recent sessions (--agent, --repo, --since, --subagents)
coding.sh show latest              # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"      # full-text search over prompts, replies and tool calls
coding.sh usage --by model         # tokens, cost, turns and cache hits by agent, model, day or repo
coding.sh ui                       # local viewer on 127.0.0.1 (token-protected URL)
```

Every command takes `--json` and `--help`. `coding.sh` with no command runs `init` until capture
is set up, then opens the viewer.

## Long sessions

A session can run for hours or days, with many compactions and resumes. coding.sh keeps it as
one timeline and splits it into phases:

- **start**: the first run.
- **resumed after 47 min**: `claude --resume` (the hook's SessionStart says so), or new events
  after the session had ended.
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
`eval_from_session`, `experiments_list`, `experiment_compare`, `harness_compare`, `benchmarks` and
`status`. `sessions_list` and `session_get` include each session's derails, and `sessions_list`
takes `flag: "looping"` (or any other flag).

`coding.sh init` registers it with Claude Code, Codex, Cursor and OpenCode (`--no-mcp` skips
this). `coding.sh mcp config` prints the snippet for any other client.
