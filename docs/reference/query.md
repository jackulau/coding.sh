# Query language

Every `--where` key, operator and facet that sessions, usage, stats and the viewer's filter bar
accept, with examples.

`--where` takes space-separated terms. Every term must match, and a leading `-` negates one. The
same query works in `coding.sh sessions`, `search`, `usage`, `stats`, `export`, the viewer's filter
bar, the viewer API and the MCP tools. For SQL over the index, see [`coding.sh sql`](#codingsh-sql).

## Filter with `--where`

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'
coding.sh sessions --where '(model:claude-* OR provider:openai) has:tests sort:-cost limit:5'
coding.sh search migration --where 'agent:codex kind:tool.end'
coding.sh usage --by model --where 'repo:coding-sh tool:Bash'
coding.sh export events --where 'agent:codex tool.errors>0' > events.jsonl
```

### Operators

| Form | Means | Example |
|---|---|---|
| `key:value` | The key has this value. Text matches ignore ASCII case. | `agent:codex` |
| a space | Both terms match. | `agent:codex tool:Bash` |
| `OR` | Either side matches. Upper case only. | `agent:codex OR agent:gemini` |
| `( )` | Groups terms. | `(model:claude-* OR provider:openai) has:tests` |
| `-` | Negates a term or a group. | `-flag:compaction`, `-(agent:codex tool:Bash)` |
| `a,b` | Either value. | `agent:codex,gemini` |
| `*` | A wildcard in a text value. | `model:claude-*` |
| `>` `>=` `<` `<=` | Compares a number. `:` means equal. | `turns>=20` |
| `a..b` | A range, both ends included. | `turns:3..5` |
| `k` `M` `B` | Scale a count. | `tokens>1M` |
| `30s` `10m` `2h` | A duration needs a unit. | `duration>10m` |
| `$` | A cost may start with `$`. | `cost>$0.5` |
| `"…"` | A value with spaces. | `title:"fix the build"` |
| a bare word | Searches prompts, replies and tool calls. Every word must match within one event. | `timeout` |

`sort:` and `limit:` set the order and the row count, and go at the top level only. A query is at
most 2,000 characters.

Session keys test the session. Event keys test its events: a session matches when one of its
events matches, and event keys in one group must match the same event. So `tool:Bash ok:false` is
a failed Bash call, and `-tool:Bash` means no Bash call at all. In `coding.sh search`, event keys
test each hit.

### Session keys

| Key | Level | Matches | Example |
|---|---|---|---|
| `agent` | session | Agent id, or the service name of an SDK or OpenTelemetry app | `agent:codex` |
| `model` | session | Main model | `model:claude-sonnet-*` |
| `provider` | session | Model provider | `provider:anthropic` |
| `repo` | session | Repo root path, or its name (else the working directory's name) | `repo:coding-sh` |
| `launch` | session | `headless` (`claude -p`, an SDK, `codex exec`) or `interactive` | `launch:headless` |
| `branch` | session | Git branch | `branch:main` |
| `dir` | session | Working directory | `dir:/work/*` |
| `title` | session | Title contains (case-insensitive) | `title:deploy` |
| `id` | session | Session id | `id:01H*` |
| `run` | session | Eval run id | `run:run_*` |
| `parent` | session | Parent session id, for subagent sessions | `parent:abc123` |
| `flag` | session | Any [flag or tag](#flags-and-derails) | `flag:no-verification` |
| `skill` | session | Skill tag (`skill:<name>`) | `skill:pdf` |
| `hook` | session | Whose hooks added text to the context: `plugin:<name>`, `plugin`, `settings` or `unknown` | `hook:plugin:terse` |
| `hook.tokens` | session | Tokens hooks added to the context (characters / 4) | `hook.tokens>500` |
| `since` | session | Started at or after: `7d`, `12h`, `today`, `yesterday` or a date | `since:7d` |
| `until` | session | Started before (exclusive): `7d`, `12h`, `today` or a date | `until:2026-11-01` |
| `duration` | session | Wall time of an ended session | `duration>10m` |
| `turns` | session | User turns | `turns>=20` |
| `tools` | session | Tool calls | `tools>100` |
| `tool.errors` | session | Failed tool calls | `tool.errors>0` |
| `llm.errors` | session | Failed model calls | `llm.errors>0` |
| `files` | session | Files changed | `files>=1` |
| `events` | session | Events captured | `events<10` |
| `tests.passed` | session | Passing tests seen | `tests.passed>0` |
| `tests.failed` | session | Failing tests seen | `tests.failed>0` |

### Cost and token keys

| Key | Level | Matches | Example |
|---|---|---|---|
| `tokens` | session | All tokens: input, output, cache read and cache write | `tokens>1M` |
| `tokens.in` | session | Input tokens | `tokens.in>100k` |
| `tokens.out` | session | Output tokens | `tokens.out>10k` |
| `cost` | session | Cost in USD, reported or estimated ([where it comes from](https://coding.sh/docs/cost#where-cost-comes-from)) | `cost>0.5` |
| `cache.breaks` | session | Model calls whose cached prompt prefix was gone, so the prompt was billed again | `cache.breaks>0` |
| `cache.lost` | session | Prompt tokens billed again after a cache break | `cache.lost>10k` |
| `cache.cost` | session | Extra USD the cache breaks cost over cache-read prices | `cache.cost>0.1` |

### Tool and event keys

| Key | Level | Matches | Example |
|---|---|---|---|
| `unapproved` | session | Destructive or paid commands the agent ran without the user approving them | `unapproved>0` |
| `kind` | event | Event kind (`tool.end`, `llm.call`, `user.message`, …; see [Trace format](https://coding.sh/docs/trace-format#kinds)) | `kind:tool.end` |
| `tool` | event | Tool name | `tool:Bash` |
| `ok` | event | The tool call or model call succeeded | `ok:false` |
| `mcp` | event | MCP server of a tool call | `mcp:github` |
| `error` | event | Error message contains (case-insensitive) | `error:ENOENT` |
| `event.duration` | event | Event duration | `event.duration>30s` |

### has, is, sort and limit

| Key | Level | Matches | Example |
|---|---|---|---|
| `has` | session | Has `tests` (test results seen), `cost`, `repo` (a git repo), `error` (a failed tool or model call) or `title` | `has:tests` |
| `is` | session | Is `root` (top level), `child` (a subagent), `flagged` (a flag with no colon), `run` (from an eval run) or `ended` | `is:root` |
| `sort` | query | Order by `started` or any number key above; `-` for descending | `sort:-cost` |
| `limit` | query | Maximum rows | `limit:50` |

`sessions` and `export` leave out subagent sessions unless you pass `--subagents`. A query with
`id:`, `parent:`, `is:root` or `is:child` decides that itself, so `--where is:child` lists
subagents.

### Dates and times

A date without a zone is local time: `since:2026-11-09` starts at local midnight. A date with `Z`
or an offset (`2026-11-09T00:00:00Z`) is that instant. `today` and `yesterday` are local midnights,
and `until` leaves its own day out. `--since` and `--until` on every command read values the same
way.

When you give a date or a day word, `sessions`, `usage` and `stats` print the window they used on
stderr, such as `Window: 2026-11-09 00:00 (UTC-06:00) to now, local time`, and put it in `--json` as
`window`.

### Errors

A bad query exits 2 and points at the character:

```text
$ coding.sh sessions --where 'agent:codex modle:x'
✗ --where: unknown key "modle" at character 13
  Query           agent:codex modle:x
                              ^
    did you mean model:?
```

| Reason | Means |
|---|---|
| `unknown_key` | No such key. To search for the word itself, quote it. |
| `bad_value` | The key does not take this value. The message gives one it takes. |
| `unterminated_quote`, `unbalanced_parens` | A quote or parenthesis is not closed. |
| `dangling_or`, `dangling_not`, `empty_group` | `OR`, `-` or `( )` has nothing to work on. |
| `bad_directive` | `sort:` or `limit:` is inside a group, an `OR` or a `-`. |
| `too_long` | The query is over 2,000 characters. |

With `--json` the error carries `reason`, `next` and `data.offset` (0-based). The viewer API
answers 400 with `reason`, `offset` and `next`, and the viewer shows the error under its filter bar.

:::more Queries on Postgres, ClickHouse and other stores
On the SQLite index a query becomes one SQL statement, with every value bound as a parameter.
`kind`, `tool`, `ok`, `mcp`, `event.duration` and `error` read indexes. Bare words read every
candidate event, so pair them with an indexed key (`kind:tool.end timeout`) on a large store.

The Postgres and ClickHouse store plugins run every key, `has:`, `is:`, bare words, `sort:`,
`limit:` and `--facets` in their own database. A plugin older than coding.sh fails on a key it
does not know, with reason `unsupported_store`. Event rows (`GET /api/events`) need the SQLite
store.

Any other store plugin answers session keys by reading at most the newest 20,000 sessions; event
keys and bare words fail there with `unsupported_store`.
:::

## Flags and derails

coding.sh checks each session for failure patterns at every ingest and keeps them as flags.
`coding.sh sessions --flag <name>` or `--where flag:<name>` lists the sessions that have one.

```sh
coding.sh sessions --flag no-verification
coding.sh sessions --where 'is:flagged since:7d'
```

| Flag | Set when the session |
|---|---|
| `premature-completion` | Stopped while the last test run was failing, and the agent's last words did not say so. |
| `repeated-tool-failure` | Had the same tool fail three times in a row with similar input. A search that found nothing is not a failure. |
| `no-verification` | Changed files, but no test, type check, lint or build ran. |
| `compaction` | Had its context compacted. |
| `test-tamper` | Edited a test or test config to hide failures: a skip marker, a deleted test file, or an assertion change that alone turned a run green. |
| `duplicate-fetch` | Repeated three or more read-only calls in one context with the same result and no edit in between. |
| `skill-copy-conflict` | Used two copies of one skill, such as the project's and a personal one. |
| `refusal` | Had a model call stop on a refusal (`refusal`, `content_filter` or `safety`). |
| `text-tool-call` | Had the model write a tool call out as text, so it never ran. |
| `unapproved-action` | Ran a destructive or paid command that the user's turn did not approve, such as `git reset --hard` or `git push --force`. |
| `step-retried`, `resumed` | Is a durable workflow run that retried a step, or continued after a crash. Notes, not failures. |

For `unapproved-action`, a turn approves a command when it asks for it, says yes to the agent, or
gives leave in advance. A Claude Code permission prompt counts too. Dry runs, read-only commands
and a package manager's own `-y` are never flagged.

### Derails

A derail is a point where a long run went off the rails. Each one records the event and time it
started, and shows in `show` and on the viewer's timeline. A session gets at most 25.

| Derail | Set when | Threshold |
|---|---|---|
| `looping` | The same tool call returns the same result again and again, with no edit in between. | 5 times within 10 calls |
| `failure-streak` | Tool calls fail one after another. Interrupted calls and exits that are an answer (a search that found nothing) don't count. | 5 in a row |
| `churn` | An edit to a file is undone, then undone again. | 2 reverts within 60 min |
| `no-progress` | A long stretch of calls with no edit, no file-writing command, no subagent and no better test result, while the context grows. | 80 calls, 40% repeats, context up 1.5x |
| `stalled` | A tool call sat with nothing else happening, then failed or never finished. | 15 min |
| `context-thrash` | Automatic compactions come back to back. Manual ones don't count. | Under 3 min or 15 tool calls apart |

Never flagged: polling a background job (`sleep`, `wait`, BashOutput), driving a browser or desktop
through MCP, waiting on a subagent or on the user, and long tool calls that succeed.

### Tags

A flag with a colon is a tag, not a failure. `is:flagged` and the failure rate in `stats` leave
tags out.

| Tag | Added when the session |
|---|---|
| `skill:<name>` | Used a skill, through the Skill tool or a file in the skill's folder. |
| `hook:<source>` | Got text in its context from another hook, such as `hook:plugin:terse`. |
| `gateway:<id>` | Sent model calls through an LLM gateway, such as `gateway:vercel`. |
| `secret:exposed` | Had a vendor token replaced by redaction. The agent and its provider saw it, so rotate it. |
| `model:switch` | Changed model mid-session. |
| `model:fallback` | Recorded a fallback to another model, such as Claude Code's `--fallback-model`. |
| `cache:low` | Wrote a prompt cache of at least 4,096 tokens over three or more turns, and read back less than it wrote. |
| `fold:error` | Could not be folded into stats. `coding.sh ingest` tries again. |

## Facets

`--facets` counts sessions per value of each key instead of listing them.

```sh
coding.sh sessions --facets agent,flag
```

```text
AGENT             SESSIONS
claude-code       28
codex             14
coding-sh-triage  8
opencode          5

FLAG             SESSIONS
no-verification  6
```

| Option | Default |
|---|---|
| Keys | `agent`, `model`, `provider`, `repo`, `launch`, `branch`, `flag`, `skill`, `hook`, `kind`, `tool`, `mcp` |
| With no keys | `agent`, `model`, `repo`, `flag`, `skill`, `tool` |
| `--limit` | 10 values per key |

Each key is counted over the query without that key's own top-level terms, so
`--facets agent --where agent:codex` still shows every agent. A count is a number of sessions, not
events. The MCP tool `sessions_list` takes `facets` too.

## `coding.sh sql`

One read-only SQL query against the SQLite index.

```sh
coding.sh sql "select agent, count(*) as n from sessions group by agent"
coding.sh sql "select tool, count(*) from events where kind = 'tool.end' and ok = 0 group by tool order by 2 desc" --csv
coding.sh sql "select id, json_extract(stats, '$.usage.costUsd') as cost from sessions order by cost desc limit 10" --json
```

| Flag | Default | What it does |
|---|---|---|
| `--csv` | | Print CSV instead of a table. |
| `--json` | | One document: `{columns, rows, rowCount, truncated}`. |
| `--limit` | 1000 | Rows returned. A note on stderr says when rows were cut. |
| `--timeout` | 10 | Seconds before the query is stopped. |

Only one statement that starts with `SELECT` or `WITH` is accepted; anything that writes exits 2.
The index is opened read-only, with `PRAGMA query_only` on. `sql` reads only the SQLite index:
with a Postgres or ClickHouse store, use `coding.sh export` or the database's own client.

## `coding.sh export`

Streams sessions, events or labels as JSONL (the default) or CSV.

```sh
coding.sh export sessions --since 30d --format csv > sessions.csv
coding.sh export events --agent codex --since 7d > events.jsonl
coding.sh export labels --format csv
```

The filters `--agent`, `--repo`, `--since`, `--flag`, `--project`, `--where`, `--subagents` and
`--limit` (the N newest sessions) pick sessions; `events` and `labels` export the rows of those
sessions. With no filter, `export labels` exports every label, including labels on eval cases.

JSONL rows are the stored objects (`Session`, `AgentEvent`, `Label` in the
[trace format](https://coding.sh/docs/trace-format)). CSV has these columns. A text cell that starts
with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet shows it instead of running it.

| Export | CSV columns |
|---|---|
| `sessions` | id, agent, model, title, started_at, ended_at, duration_ms, repo_root, branch, parent_session_id, project, events, turns, tool_calls, tool_errors, files_changed, input_tokens, output_tokens, cost_usd, flags (space-separated) |
| `events` | id, session_id, ts, kind, agent, model, tool, ok, duration_ms, turn_id, subagent_id, input_tokens, output_tokens, cost_usd, payload (JSON) |
| `labels` | id, session_id, case_id, criterion, value, note, by, ts |

### Evidence folders

`export --evidence <dir>` writes each matching session's raw trace to a folder, for a person or a
model to read as files:

```sh
coding.sh export --evidence traces/ --where 'flag:repeated-tool-failure' --limit 20
```

`<dir>/index.md` lists the sessions. Each session gets a folder with `session.json`,
`events.jsonl`, one `tools/NNNN-<tool>.txt` per tool call with its full output, and an `index.md`
with stats, flags and a timeline. Everything is redacted again first. A tool file is cut at 200 KB
and `events.jsonl` at 5 MB. A folder that is not empty stops it with `target_exists`, unless you
pass `--force`.

## Tables

The SQLite index keeps these tables. Times are milliseconds since the epoch. Columns that hold
JSON are text: read them with `json_extract(col, '$.path')` or `json_each(col)`.

### `sessions`

| Column | Meaning |
|---|---|
| `id` | Session id |
| `agent` | Agent id: `claude-code`, `codex`, … |
| `agent_version` | Agent version, when known |
| `model` | Main model |
| `cwd` | Working directory |
| `repo` | Repo JSON: `root`, `branch`, `commit`, `remote` |
| `repo_root` | The repo root, for filtering |
| `title` | First prompt or the agent's title |
| `started_at` | Start time |
| `ended_at` | End time (NULL while running or unknown) |
| `stats` | Stats JSON: `events`, `turns`, `toolCalls`, `toolErrors`, `usage`, `latency`, … |
| `flags` | JSON array of flags and tags (`looping`, `skill:pdf`, …) |
| `run_id` | Eval run id, for sessions an eval started |
| `parent_session_id` | Parent session, for a subagent session |
| `project_id` | Serve project (`default` when none) |

### `events`

| Column | Meaning |
|---|---|
| `id` | Event id |
| `session_id` | Session it belongs to |
| `turn_id` | Turn id |
| `ts` | Time |
| `duration_ms` | Duration, for events that have one |
| `subagent_id` | Subagent that produced it |
| `agent` | Agent id |
| `model` | Model, for model calls |
| `kind` | `user.message`, `assistant.message`, `tool.start`, `tool.end`, `llm.call`, … |
| `tool` | Tool name, for tool events |
| `ok` | 1 or 0 when the event says whether it succeeded |
| `mcp` | MCP server, for a tool call to an MCP tool |
| `payload` | Payload JSON (`text`, `command`, `input`, `output`, …) |
| `blobs` | JSON array of blob hashes the payload points at |
| `usage` | Usage JSON: `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd` |
| `project_id` | Serve project |

### `scores`

Typed scores on sessions, events, dataset cases and eval runs, from people, judges, code or the API
(`coding.sh score`, `POST /api/scores`).

| Column | Meaning |
|---|---|
| `id` | Score id |
| `target` | `session`, `event`, `case` or `run` |
| `target_id` | Id of what was scored |
| `session_id` | Session the target belongs to, when known |
| `name` | What was scored, such as `helpfulness` |
| `data_type` | `numeric`, `boolean`, `categorical` or `text` |
| `value` | The number, or 1 and 0 for a boolean (NULL otherwise) |
| `string_value` | The value of a categorical or text score |
| `source` | `human`, `judge`, `code`, `api` or `monitor` |
| `config_id` | Score config the value was checked against |
| `judge_version` | Judge version, for a judge's score |
| `calibrated` | 1 when the judge passed calibration |
| `comment` | Free-text comment |
| `by` | Who scored it |
| `ts` | Time |

### `score_configs`

| Column | Meaning |
|---|---|
| `id` | Config id |
| `name` | Score name it applies to |
| `data_type` | `numeric`, `boolean`, `categorical` or `text` |
| `doc` | The config as JSON: `min`, `max`, `categories`, `description` |

### `labels`

A view over `scores`: a person's boolean scores (`pass` or `fail`) and categorical `pass`, `fail` or
`skip` scores on sessions and dataset cases.

| Column | Meaning |
|---|---|
| `id` | Label id |
| `session_id` | Labelled session |
| `criterion` | What was labelled, such as `outcome` |
| `value` | `pass`, `fail` or `skip` |
| `note` | Free-text note |
| `by` | Who labelled it |
| `ts` | Time |
| `case_id` | Dataset case, for a label on an eval case |

### `runs`

| Column | Meaning |
|---|---|
| `id` | Run id |
| `experiment_id` | Experiment it belongs to |
| `task_id` | Eval task |
| `bundle_id` | Harness bundle |
| `session_id` | Captured session of the run |
| `pass` | 1 when it passed |
| `started_at` | Start time |
| `doc` | The full run as JSON |

`session_facets` holds each session's distinct `kind`, `tool` and `mcp` values. Other tables
(`tasks`, `bundles`, `datasets`, `experiments`, `judges`, `kv`, `cursors`) hold eval and bookkeeping
state as JSON in a `doc` column. `events_fts` is the full-text index behind `coding.sh search`.
List every table with:

```sh
coding.sh sql "select name, sql from sqlite_schema where type = 'table'"
```
