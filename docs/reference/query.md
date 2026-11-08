# Query and export

Two commands read the store directly:

- `coding.sh sql "<query>"` runs one read-only SQL query against the SQLite index.
- `coding.sh export sessions|events|labels` streams rows as JSONL or CSV, with the same filters as
  `coding.sh sessions`.

Both read what is stored, and that text was redacted at ingest. To pick sessions without SQL, use
the [`--where` filter](#filter-with---where), which `sessions`, `search`, `usage`, `export`, the
viewer API and the MCP tools share.

## Filter with `--where`

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'
coding.sh sessions --where '(model:claude-* OR provider:openai) has:tests sort:-cost limit:5'
coding.sh sessions --facets model,tool --where 'repo:coding-sh'
coding.sh search migration --where 'agent:codex kind:tool.end'
coding.sh usage --by model --where 'repo:coding-sh tool:Bash'
coding.sh export events --where 'agent:codex tool.errors>0' > events.jsonl
```

A query is a list of clauses. Clauses are and-ed. Between clauses:

- `OR` (upper case) means either side; `( )` groups.
- `-` before a clause negates it: `-flag:compaction`, `-(agent:codex tool:Bash)`.
- `a,b` matches either value: `agent:codex,gemini`.
- `*` is a wildcard in text values: `model:claude-*`. Text matches ignore ASCII case.
- Numbers take `>`, `>=`, `<`, `<=`, `:` (equal) and ranges `a..b`. `k`, `M` and `B` scale
  counts (`tokens>1M`); durations need a unit (`duration>10m`, `event.duration>=30s`); `cost` may
  start with `$`.
- Values with spaces go in double quotes: `title:"fix the build"`.
- Bare words search prompts, replies and tool calls, like `coding.sh search`. Every word must
  match within one event.
- `sort:` and `limit:` set the order and the row count. They go at the top level only.

Session keys test the session. Event keys test its events: a session matches when it has a
matching event, and event keys in the same and-group must match the same event. So
`tool:Bash ok:false` means a failed Bash call, not a Bash call and some other failure.
`-tool:Bash` means no Bash call at all. In `coding.sh search`, event keys test the hit itself.

| Key | Level | Matches | Example |
|---|---|---|---|
| `agent` | session | Agent id | `agent:codex` |
| `model` | session | Main model | `model:claude-sonnet-*` |
| `provider` | session | Model provider | `provider:anthropic` |
| `repo` | session | Repo root path, or its name (else the working directory's name) | `repo:coding-sh` |
| `branch` | session | Git branch | `branch:main` |
| `dir` | session | Working directory | `dir:/work/*` |
| `title` | session | Title contains (case-insensitive) | `title:deploy` |
| `id` | session | Session id | `id:01H*` |
| `run` | session | Eval run id | `run:run_*` |
| `parent` | session | Parent session id (subagent sessions) | `parent:abc123` |
| `flag` | session | Any flag or tag | `flag:no-verification` |
| `skill` | session | Skill tag (flag skill:<name>) | `skill:pdf` |
| `since` | session | Started at or after: 7d, 12h or a date | `since:7d` |
| `until` | session | Started before: 7d, 12h or a date | `until:2026-11-01` |
| `duration` | session | Wall time of an ended session (30s, 10m, 2h) | `duration>10m` |
| `turns` | session | User turns | `turns>=20` |
| `tools` | session | Tool calls | `tools>100` |
| `tool.errors` | session | Failed tool calls | `tool.errors>0` |
| `llm.errors` | session | Failed model calls | `llm.errors>0` |
| `files` | session | Files changed | `files>=1` |
| `events` | session | Events captured | `events<10` |
| `tests.passed` | session | Passing tests seen | `tests.passed>0` |
| `tests.failed` | session | Failing tests seen | `tests.failed>0` |
| `tokens` | session | All tokens: input, output, cache read and write (k, M suffixes) | `tokens>1M` |
| `tokens.in` | session | Input tokens | `tokens.in>100k` |
| `tokens.out` | session | Output tokens | `tokens.out>10k` |
| `cost` | session | Cost in USD, reported or estimated | `cost>0.5` |
| `kind` | event | Event kind | `kind:tool.end` |
| `tool` | event | Tool name | `tool:Bash` |
| `ok` | event | Tool call or model call succeeded | `ok:false` |
| `mcp` | event | MCP server of a tool call | `mcp:github` |
| `error` | event | Error message contains (case-insensitive) | `error:ENOENT` |
| `event.duration` | event | Event duration (30s, 2m) | `event.duration>30s` |
| `has` | session | Has tests (test results seen), cost (a cost), repo (a git repo), error (a failed tool or model call), title (a title) | `has:tests` |
| `is` | session | Is root (a top-level session), child (a subagent session), flagged (has a failure flag, one with no colon), run (from an eval run), ended (has an end) | `is:root` |
| `sort` | query | Order by started, duration, turns, tools, tool.errors, llm.errors, files, events, tests.passed, tests.failed, tokens, tokens.in, tokens.out, cost; - for descending | `sort:-cost` |
| `limit` | query | Maximum rows | `limit:50` |

A key that does not exist, a bad value, an unclosed quote or parenthesis, or an `OR` with nothing
after it is a usage error (exit 2, reasons `unknown_key`, `bad_value`, `unterminated_quote`,
`unbalanced_parens`, `dangling_or`, `dangling_not`, `bad_directive`, `empty_group`, `too_long`).
The message points at the character:

```text
✗ --where: unknown key "modle" at character 13
  Query           agent:codex modle:x
                              ^
    did you mean model:?
```

With `--json` the error carries `reason`, `next` and `data.offset` (0-based). The viewer API
answers 400 with `reason`, `offset` and `next`; the MCP tools return a tool error that names the
character.

`--facets` counts sessions per value of each key instead of listing them: `agent`, `model`,
`provider`, `repo`, `branch`, `flag`, `skill`, `kind`, `tool` and `mcp`. Each key is counted over
the query without that key's own top-level clauses, so `--facets agent --where agent:codex` still
shows every agent. `--limit` sets the values per key (default 10). A count is the number of
sessions, not events.

On the SQLite index a query becomes one SQL statement, with every value bound as a parameter.
The event keys `kind`, `tool`, `ok` and `mcp` read indexes, not the events: a session-level
clause such as `tool:Bash ok:false` looks up the matching events once and keeps their sessions,
and facets on `kind`, `tool` and `mcp` read a small table of each session's distinct values.
`error`, `event.duration` and bare words read the payload of every candidate event, so pair them
with an indexed key (`kind:tool.end error:timeout`) on a large store. A store written by an
older version is migrated on first open; on a 3.3 GB store that takes about a minute.

The Postgres and ClickHouse store plugins also run queries in their own database: every key, `has:`,
`is:`, bare words (word prefixes, as their `search` matches), `sort:`, `limit:` and `--facets`.
A plugin older than coding.sh fails on a key it doesn't know, with reason `unsupported_store`.
Event results (`GET /api/events`) need the SQLite or memory store; on a plugin they fail with
reason `unsupported_store`.
Any other store plugin answers session keys by reading sessions a page at a time, the newest
20,000 at most (`coding.sh sessions` says so on stderr when it stops there); event keys and bare
words there fail with reason `unsupported_store`.

## `coding.sh sql`

```sh
coding.sh sql "select agent, count(*) as n from sessions group by agent"
coding.sh sql "select tool, count(*) from events where kind = 'tool.end' and ok = 0 group by tool order by 2 desc" --csv
coding.sh sql "select id, json_extract(stats, '$.usage.costUsd') as cost from sessions order by cost desc limit 10" --json
```

The output is a table, CSV with `--csv`, or one JSON document with `--json`
(`{columns, rows, rowCount, truncated}`, each row an object keyed by column name).

The query is read-only in three ways:

- Only one statement is accepted, and it must start with `SELECT` or `WITH`. `INSERT`, `UPDATE`,
  `DELETE`, `REPLACE INTO`, `DROP`, `CREATE`, `ALTER`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM` and
  `REINDEX` outside quotes and comments are rejected. These exit 2. `replace()` the function and
  table-valued pragmas such as `pragma_table_info('sessions')` are allowed.
- The index is opened read-only (`SQLITE_OPEN_READONLY`).
- `PRAGMA query_only` is on, so even a temporary table cannot be created.

The query runs in a child process. It is killed after `--timeout` seconds (default 10), and at most
`--limit` rows are returned (default 1000; a note on stderr says when rows were cut).

`sql` reads only the SQLite index. With a Postgres or ClickHouse store it exits 1 and points to
`coding.sh export`, which works on every store, or to the database's own client.

## `coding.sh export`

```sh
coding.sh export sessions --since 30d --format csv > sessions.csv
coding.sh export events --agent codex --since 7d > events.jsonl
coding.sh export labels --format csv
```

Filters: `--agent`, `--repo`, `--since`, `--flag`, `--project`, `--subagents` and `--limit` (the N
newest matching sessions). They pick sessions; `events` and `labels` export the rows of those
sessions. Subagent sessions are left out unless you pass `--subagents`. With no filter at all,
`export labels` exports every label, including labels on eval cases.

JSONL rows are the stored objects (`Session`, `AgentEvent`, `Label` in the
[trace format](https://coding.sh/docs/trace-format)), one per line. CSV has the fixed columns below.
Text cells that start with `=`, `+`, `-` or `@` get a leading `'`, so a spreadsheet shows them
instead of running them as formulas.

| Export | CSV columns |
|---|---|
| `sessions` | id, agent, model, title, started_at, ended_at, duration_ms, repo_root, branch, parent_session_id, project, events, turns, tool_calls, tool_errors, files_changed, input_tokens, output_tokens, cost_usd, flags (space-separated) |
| `events` | id, session_id, ts, kind, agent, model, tool, ok, duration_ms, turn_id, subagent_id, input_tokens, output_tokens, cost_usd, payload (JSON) |
| `labels` | id, session_id, case_id, criterion, value, note, by, ts |

Rows are read a page at a time and written as they come, so memory stays flat on a large store.

## Tables

The SQLite index keeps these tables. Times are milliseconds since the epoch. Columns holding JSON
are text: read them with `json_extract(col, '$.path')` or `json_each(col)`.

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

### `labels`

| Column | Meaning |
|---|---|
| `id` | Label id |
| `session_id` | Labelled session |
| `criterion` | What was labelled, such as `outcome` |
| `value` | `pass`, `fail` or `skip` |
| `note` | Free-text note |
| `by` | Who labelled it |
| `ts` | Time |

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

`session_facets` holds each session's distinct `kind`, `tool` and `mcp` values (`key`, `value`,
`session_id`), kept in step with `events`. Other tables (`tasks`, `bundles`, `datasets`,
`experiments`, `judges`, `kv`, `cursors`) hold eval and bookkeeping state as JSON in a `doc`
column. `events_fts` is the full-text index behind
`coding.sh search`. List every table with:

```sh
coding.sh sql "select name, sql from sqlite_schema where type = 'table'"
```
