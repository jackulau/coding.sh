# Query and export

Two commands read the store directly:

- `coding.sh sql "<query>"` runs one read-only SQL query against the SQLite index.
- `coding.sh export sessions|events|labels` streams rows as JSONL or CSV, with the same filters as
  `coding.sh sessions`.

Both read what is stored, and that text was redacted at ingest.

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

Other tables (`tasks`, `bundles`, `datasets`, `experiments`, `judges`, `kv`, `cursors`) hold eval
and bookkeeping state as JSON in a `doc` column. `events_fts` is the full-text index behind
`coding.sh search`. List every table with:

```sh
coding.sh sql "select name, sql from sqlite_schema where type = 'table'"
```
