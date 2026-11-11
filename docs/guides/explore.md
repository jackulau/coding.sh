# Find and read runs

List, filter and search sessions, read one step by step in the terminal or the viewer, and follow a
run while it works.

Every run of your agent is a session: from your own agent through the SDK or OpenTelemetry, or
from a coding agent through its hooks. They all land in one list. A session has turns, a turn has
events (prompts, model calls, tool calls, file changes), and a subagent's work is a child session.
See [Concepts](https://coding.sh/docs/concepts).

## List your sessions

```sh
coding.sh sessions
```

```text
ID                                    AGENT             STARTED  DURATION  TURNS  TOOLS         TITLE
2654169858002f6f1a7672c13faefc0f      coding-sh-triage  24m ago  1.3s      1      0             Support Postgres 17
ea262f5812388d91cd12a86db4ea7514      coding-sh-triage  31m ago  300ms     1      0             Hook exits 1 on Windows
9887c95d-2739-4dae-8222-4471386def67  claude-code       42m ago  5m18s     1      9 (1 failed)  Apply each SQLite migration once when two processes open the index
265c3e44-2272-40f9-8ff8-fa789773b687  codex             47m ago  1m24s     1      3             Add --since to coding.sh usage
ses_b32e798f30f8bed3a17e              opencode          1h ago   1m32s     1      3             Fix the Antigravity adapter's session title
```

The newest 20 come first. `coding-sh-triage` is an app traced with the SDK; the others are coding
agents. Subagent sessions and sessions with nothing in them are hidden.

| Flag | What it does |
|---|---|
| `--agent codex` | Only this agent. Repeat it or pass `a,b` for several. |
| `--since 7d` | Only sessions that started after this: `12h`, `today`, `yesterday` or a date. |
| `--repo <path>` | Only sessions in this repo root. |
| `--flag no-verification` | Only sessions with this flag or tag. |
| `--where <query>` | Any filter the [query language](https://coding.sh/docs/query) takes. |
| `-n, --limit 50` | More rows (default 20). |
| `--subagents` | Include subagent sessions. |

## Filter by what happened

`--where` takes `key:value` terms. Every term must match, and a leading `-` negates one. Event keys
such as `tool` and `ok` must match the same event, so this finds a session with a failed Bash call:

```sh
coding.sh sessions --where 'tool:Bash ok:false'
```

```text
ID                                    AGENT        STARTED  DURATION  TURNS  TOOLS         TITLE
9887c95d-2739-4dae-8222-4471386def67  claude-code  42m ago  5m18s     1      9 (1 failed)  Apply each SQLite migration once when two processes open the index
```

More queries:

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'model:claude-* -flag:compaction sort:-cost limit:5'
coding.sh sessions --facets agent,flag     # count sessions per value instead of listing them
```

The same query works in `search`, `usage`, `stats`, `export`, the viewer's filter bar and the MCP
tools. Every key, operator and flag is in the [query reference](https://coding.sh/docs/query). A
typo points at the character:

```text
$ coding.sh sessions --where 'agent:codex modle:x'
✗ --where: unknown key "modle" at character 13
  Query           agent:codex modle:x
                              ^
    did you mean model:?
```

## Read one session

```sh
coding.sh show latest
```

```text
Apply each SQLite migration once when two processes open the index
  Session       9887c95d-2739-4dae-8222-4471386def67
  Agent         claude-code  2.1.300  claude-opus-4-8
  Repo          /home/user/coding.sh (main)
  Started       Nov 11 03:51 (18m ago)
  Duration      5m18s
  Turns         1, 9 tool calls (1 failed), 2 files changed
  Tokens        in 34  out 2.5k  cache 324k  $0.3387 (estimated)
  Latency       10 llm calls, p50 6.6s, p95 1m48s; ttft p50 6.6s; tools 2m13s (p95 52s)

    +0ms  session.start
    +0ms  user        Apply each SQLite migration once when two processes open the index
    +0ms  llm         claude-opus-4-8 4.0s in 3 out 310 $0.0756 est
   +4.0s  assistant   I'll start with how the store opens the index and runs migrations.
    +12s  subagent    start Explore Find user_version reads
  +1m01s  subagent    end 50s
    …
  +1m43s  tool        Bash npm test -- test/store/sqlite.test.ts  failed 21s
  +1m43s  tests       41 passed, 1 failed
    …
  +5m18s  turn.end

Subagents
  └ 9887c95d-2739-4dae-8222-4471386def67:sub:a8f20c41e7  Explore  50s  2 tools  Find user_version reads
```

The header sums up the run. Below it, each event in order, with the time since the start. Pass a
session id, a unique prefix of 4 or more characters, or `latest`.

## Search every session

```sh
coding.sh search migration --where 'kind:tool.end' --limit 3
```

```text
SESSION                                              KIND      WHEN     MATCH
9887c95d-2739-4dae-8222-4471386def67                 tool.end  42m ago  …SqliteIndexStore.migrate reads MAX(version) from «migrations» before BEGIN IMMEDIATE…
9887c95d-2739-4dae-8222-4471386def67:sub:a8f20c41e7  tool.end  43m ago  …431: this.db.prepare("INSERT INTO «migrations» (version, applied_at) VALUES (?, ?)")
9887c95d-2739-4dae-8222-4471386def67                 tool.end  40m ago  …re-ingested (5.3ms) ✔ applies each «migration» once (41.2ms) ▶ SqliteIndexStore…
```

Search covers prompts, replies, tool input and tool output. Every word must match within one
event. Open a hit with `coding.sh show <session>`.

## Open the viewer

```sh
coding.sh ui
```

It serves the viewer on `127.0.0.1:4319` and opens it in your browser. The URL it prints holds a
token for this run of `ui`; the viewer needs it.

![The coding.sh viewer's session list: Claude Code, Codex and OpenCode sessions on the coding.sh repo, each with its agent, title, cost and flags.](shot:docs/sessions-list "The session list in coding.sh ui.")

- **The list.** The bar above it takes the same query as `--where`, and it lives in the URL, so a
  filtered list can be shared.
- **The sidebar.** Counts per agent, model, repo, flag and tool. Click a value to add it to the
  query, Alt-click to exclude it.
- **A session.** The timeline shows every event, with a ⚑ on each step where the run went off the
  rails. A running session gets new events every 4 seconds.
- **Explore** (<kbd>g</kbd> <kbd>x</kbd>). Six charts per day or week: sessions, failure rate,
  cost, tokens, tool error rate and p95 model-call time, split by agent, model, repo or flag.
- **Events** (<kbd>e</kbd>). The same query as event rows, newest first. Enter opens the event's
  step in its session.
- **Replay** (<kbd>R</kbd> on a session). Plays the session back one step at a time. See
  [Replay a session](https://coding.sh/docs/use-cases/replay-agent-session).

## Follow a running session

```sh
coding.sh show latest --follow
```

It prints the last 20 events, then each new event and derail as the agent works. It stops by
itself a moment after the session ends, or on Ctrl-C.

## Long sessions

A session can run for hours or days, with compactions and resumes. coding.sh keeps it as one
timeline and splits it into phases:

| Phase | Starts when |
|---|---|
| start | The first run. |
| resumed after 47 min | The agent resumed the session, or new events came more than 5 seconds after it ended. |
| compacted (auto) or compacted (manual) | The context was compacted. |
| back after 35 min idle | The main agent was quiet for 30 minutes or more. |

A session with more than 200 events shows one line per phase in `show`. `--all` lists every event,
and `--limit 500` the first 500.

### Derails

A derail is a point where a long run went off the rails: `looping`, `failure-streak`, `churn`,
`no-progress`, `stalled` or `context-thrash`. Each one marks the event where it started, in `show`
and on the viewer's timeline. What sets each one is in [Flags and derails](https://coding.sh/docs/query#flags-and-derails).

```sh
coding.sh sessions --flag looping
```

## Subagents and the run tree

A subagent's work is its own session, linked to its parent. `show` lists a session's subagents at
the end, and `sessions --subagents` or `--where is:child` lists them. `tree` shows a whole
multi-agent run with what each part cost:

```sh
coding.sh tree 9887c95d-2739-4dae-8222-4471386def67
```

```text
Apply each SQLite migration once when two processes open the index
  1 subagent  ·  5m18s  ·  11 tool calls (1 failed)  ·  2 files changed  ·  $0.3531
  in 13k  out 2.8k  cache 324k

9887c95d-2739-4dae-8222-4471386def67  claude-code  claude-opus-4-8  5m18s  9 tools (1 failed)  $0.3387  Apply each SQLite migration once when two proce…
  └ 9887c95d-2739-4dae-8222-4471386def67:sub:a8f20c41e7  Explore  claude-haiku-4-5  50s  2 tools  $0.0145  Find user_version reads
```

`--run` reads the argument as a run id, so agents of one fan-out that share a run id show as one
tree.

## Replay a session

`coding.sh replay` lists a session as numbered steps and rebuilds the files the agent touched as of
any step, from the agent's own tool calls. Nothing is run again. See
[Replay a session step by step](https://coding.sh/docs/use-cases/replay-agent-session).

![Replay of the OpenCode session "Fix the Antigravity adapter's session title", with the edit step selected and its diff shown.](shot:docs/replay-diff "Replay in coding.sh ui, on the step that edited the file.")

### Fork from a step

`--fork` sends the model call behind step N again with a changed instructions file, model or system
prompt, and shows the recorded action next to the new one. It needs the session recorded through
the [model call proxy](https://coding.sh/docs/how-to/capture-with-proxy) with capture mode `full`.

```sh
coding.sh replay <session> --step 12 --fork --with AGENTS.md=fixed.md -k 3
```

| Flag | What it does |
|---|---|
| `--with DEST=SRC` | Use SRC's text as DEST (AGENTS.md, a rule or a skill). `DEST=` drops the file. |
| `--model <model>` | Send the call to another model. |
| `--system <text>` | Replace the system prompt. |
| `-k 3` | Send the call 3 times (default 1). Each forked action is marked `same` or `different`. |
| `--run` | Run Claude Code from step N in a copy of the session's folder. `--verify 'npm test'` checks the result. |
| `--save-case <suite>` | Keep the step as an eval case: the recorded action is what the case must not do. |

Forking calls the model API with `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) or
`OPENAI_API_KEY`, never the agent's own login.

## Model calls

The [model call proxy](https://coding.sh/docs/how-to/capture-with-proxy) keeps each call's full
request and response.

```sh
coding.sh show latest#-1           # the last model call: system prompt, tools, settings, cache, cost
coding.sh diff-calls latest#-1     # what changed since the call before, and why the cache missed
```

In the viewer, a model call has "Open in playground": edit the prompt, messages or tools, send it
again, and see the answer next to the recorded one. A provider is ready when `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` is set where `coding.sh ui` runs.

## Executability

Executability asks how far the agent got before it made a tool call the harness refused to run.
Each main tool call is a step, and each step is `ok`, `failed` (it ran and did not succeed) or
`invalid` (refused before it ran). A test run that exits 1 is failed, not invalid.

An `{"kind": "executability"}` grader in `exp run` scores a run as the share of steps before the
first invalid call, or 1 when there was none. It passes with at most `maxInvalid` invalid calls
(default 0). `kinds` limits which kinds count.

:::more The kinds of invalid call
| Kind | Matches |
| --- | --- |
| `schema` | Bad or missing arguments: `InputValidationError`, `must have required property` |
| `unknown-tool` | `No such tool available`, `unknown tool` |
| `precondition` | Claude Code's `has not been read yet` and `modified since read` |
| `state` | `String to replace not found`, `apply_patch verification failed` |
| `missing` | `File does not exist`, exit 127, `command not found` |
| `denied` | `Permission to use … denied`, a PreToolUse hook block |
| `other` | Any other Claude Code `<tool_use_error>` |

Hook-only captures often carry no tool output, so their invalid counts are a lower bound.
:::

## Memory and instruction files

`coding.sh harness audit` counts the sessions that loaded, read and wrote each AGENTS.md, rule,
skill and memory file over the last 30 days, flagged files first.

```sh
coding.sh harness audit
coding.sh harness audit --agent codex --since 90d
```

| Flag | The file |
|---|---|
| `never-read` | Is on disk, and no session in the window loaded or read it. |
| `write-only` | Was written, and no other session loaded or read it. |
| `loaded-not-read` | Is a skill that was listed but never invoked or read. |

The load cost is the file's tokens (bytes / 4) times the sessions that loaded it. The audit also
warns about a Claude Code subagent file whose `tools:` is a map, which leaves that subagent with no
tools.

## See trends

```sh
coding.sh stats --since 7d --by agent --measure cost
```

```text
AGENT             SESSIONS  FAIL%  COST     TOKENS  TOOLS  TOOL ERR%  P95 LLM  TTFT  COST PER DAY
claude-code       28        7.1%   ~$6.91    9.8M    201    0.5%       34s      13s   ▄▅▇█▃▇▃▃
codex             14        7.1%   ~$2.08    4.0M    96     0%         0ms      -     ██▂█▅▂▆▂
coding-sh-triage  8         0%     ~$0.0095  13k     0      -          2.6s     -     ▁▁▁▁▁▁▁█
opencode          5         60%    ~$0.7937  1.1M    30     6.7%       9.0s     -     ▁▁▅█▁▅▁▆
total             55        11%    ~$9.78    14.9M   327    0.9%       33s      13s   ▅▅▆█▃▆▃▃
  COST covers the 54 of 55 sessions with a price.
```

Without `--by` it prints one row per day (`--per week` for weeks). A failure is a session with a
flag that has no colon. Cost and tokens per agent, model and repo are on [Track cost](https://coding.sh/docs/cost).

## Get JSON

Every command takes `--json` and prints one document. `--fields` keeps only the paths you name:

```sh
coding.sh sessions --where 'tool:Bash ok:false' --json --fields id,title,stats.toolErrors
```

```json
{"sessions":[{"id":"9887c95d-2739-4dae-8222-4471386def67","title":"Apply each SQLite migration once when two processes open the index","stats":{"toolErrors":1}}]}
```

`show --json` adds `phases` and `days`. For a session over 200 events it prints `events: []` next
to `eventCount`; `--limit N` or `--all` lists them.

## Ask your agent

`coding.sh init` registers an MCP server with your agents, so an agent can read its own past
sessions. See [Let your agent read its own runs](https://coding.sh/docs/mcp).

:::more Every MCP tool
`sessions_list`, `session_get`, `session_current`, `session_replay`, `search`, `improve`,
`harness_changes`, `harness_audit`, `failures`, `latency`, `usage`, `subagents`, `session_tree`,
`eval_from_session`, `eval_init`, `eval_candidates`, `experiments_list`, `experiment_compare`,
`exp_session_summary`, `exp_session_note`, `harness_compare`, `benchmarks`, `status`, `score_list`
and `score_add`.
:::

## Next steps

- [Track cost and tokens](https://coding.sh/docs/cost)
- [Replay a session step by step](https://coding.sh/docs/use-cases/replay-agent-session)
- [Turn failed runs into evals](https://coding.sh/docs/how-to/session-to-eval)
- [Query language](https://coding.sh/docs/query)
