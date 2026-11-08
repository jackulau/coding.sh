<!-- Generated from packages/coding.sh/src/cli/registry.ts by packages/coding.sh/scripts/cli-reference.ts. Do not edit by hand. -->

# CLI reference

Every `coding.sh` command, argument and option, generated from the CLI's command registry. Run
`coding.sh <command> --help` for the same information in a terminal, or add `--json` to get it as JSON.

## Global options

Every command accepts these.

| Option | Default | Description |
|---|---|---|
| `--json` |  | Print one JSON document on stdout. |
| `--no-color` |  | Disable color (also NO_COLOR=1) |
| `--debug` |  | Show stack traces on errors. |
| `-h, --help` |  | Show help. |
| `--store <URL>` |  | Read and write this index store instead of the configured one (also CODING_SH_STORE_URL); skips auto-ingest. |
| `--blobs <URL>` |  | Blob store to use with --store (also CODING_SH_BLOB_URL; a postgres:// index keeps blobs in the same DB) |
| `-v, --version` |  | Print the version. |

## Output and exit codes

- stdout carries the answer only. Progress, warnings and errors go to stderr.
- With `--json`, a command prints one JSON document on stdout. An error is one JSON line on stderr:
  `{"status":"error","reason":"<reason>","message":"<text>","next":["<suggested command>"]}`.
  The reasons are listed in [Troubleshooting](../troubleshooting.md).
- Exit codes: `0` success, `1` error, `2` usage error (unknown option, bad value, missing `--yes`), `130` canceled.
- Commands that change agent config ask first. In scripts and CI, pass `--yes`.

## Commands

| Command | Group | What it does |
|---|---|---|
| [`init`](#codingsh-init) | Capture | Set up capture hooks and the MCP server for every detected agent |
| [`doctor`](#codingsh-doctor) | Capture | Check agents, hooks, spool, store and the OTLP port |
| [`status`](#codingsh-status) | Capture | Show capture totals and the latest session |
| [`ingest`](#codingsh-ingest) | Capture | Move captured hook events from the spool into the index |
| [`run`](#codingsh-run) | Capture | Run any agent command and capture the session |
| [`collector`](#codingsh-collector) | Capture | Start a local OTLP/HTTP receiver for agents that export traces |
| [`proxy`](#codingsh-proxy) | Capture | Run a local Anthropic/OpenAI API proxy that logs every model call |
| [`serve`](#codingsh-serve) | Capture | Production server: OTLP + native ingest, viewer, health and metrics on one port |
| [`uninstall`](#codingsh-uninstall) | Capture | Remove coding.sh hooks and MCP entries from every agent |
| [`sessions`](#codingsh-sessions) | Explore | List captured sessions |
| [`show`](#codingsh-show) | Explore | Show a session timeline with subagents and latency |
| [`replay`](#codingsh-replay) | Explore | Step through a session and see what it did to each file it touched |
| [`search`](#codingsh-search) | Explore | Full-text search over prompts, replies and tool calls |
| [`usage`](#codingsh-usage) | Explore | Tokens, cost, turns and cache hits by agent, model or day |
| [`sql`](#codingsh-sql) | Explore | Run one read-only SQL query against the SQLite index |
| [`export`](#codingsh-export) | Explore | Stream sessions, events or labels as JSONL or CSV |
| [`ui`](#codingsh-ui) | Explore | Open the local session viewer |
| [`mcp`](#codingsh-mcp) | Explore | Serve captured sessions to agents over MCP (stdio) |
| [`eval`](#codingsh-eval) | Evaluate | Build eval suites from sessions, skills or cases, and run them |
| [`dataset`](#codingsh-dataset) | Evaluate | Manage versioned datasets of cases |
| [`exp`](#codingsh-exp) | Evaluate | Run a task over a dataset, compare experiments and sweep configs |
| [`judge`](#codingsh-judge) | Evaluate | Grade one output or the slop in captured diffs, or check an LLM judge or a test verifier against human labels |
| [`toolevals`](#codingsh-toolevals) | Evaluate | Measure how well agents use a CLI, MCP server or API |
| [`workflows`](#codingsh-workflows) | Evaluate | Capture, measure and A/B-test multi-agent workflow runs |
| [`bench`](#codingsh-bench) | Evaluate | Dynamic benchmarks: fresh cases every run, same set for every contender |
| [`harness`](#codingsh-harness) | Harness | Snapshot and list agent harness bundles |
| [`compare`](#codingsh-compare) | Harness | A/B two harness bundles on eval tasks |
| [`refine`](#codingsh-refine) | Harness | Improve CLAUDE.md, AGENTS.md and skills in tested rounds, and protect their safety rules |
| [`gateway`](#codingsh-gateway) | Maintain | LLM gateways: detect routing, enrich sessions with billed cost |
| [`gc`](#codingsh-gc) | Maintain | Delete expired spool files, blobs and judge cache |
| [`purge`](#codingsh-purge) | Maintain | Remove a leaked secret from the store: events, search, blobs, spool, eval runs |
| [`config`](#codingsh-config) | Maintain | Read and write ~/.coding.sh/config.toml |
| [`update`](#codingsh-update) | Maintain | Install the latest coding.sh release |
| [`version`](#codingsh-version) | Maintain | Print the version |

## `coding.sh init`

Set up capture hooks and the MCP server for every detected agent.

```text
coding.sh init [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent (repeatable) |
| `--scope <SCOPE>` | `user` | Install into user or project config. One of: `user`, `project`. |
| `--mcp` | `true` | Register the coding.sh MCP server too (--no-mcp to skip) |
| `--force` |  | Install hooks even when the agent already has coding.sh hooks in the other scope. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |
| `--dry-run` |  | Print the plan (agents, files, blockers) without writing anything. |
| `--diff` |  | With --dry-run, also print the full diff of every planned edit. |
| `--remote <URL>` |  | Also send new sessions to a team's coding.sh serve at this URL (an http sink named team) |
| `--key <KEY>` |  | With --remote, the server's ingest key, csh_ik_… (also CODING_SH_INGEST_KEY) |
| `--remote-mode <MODE>` | `metadata` | With --remote: metadata sends no prompts, code or tool output; full sends them. |

```sh
coding.sh init
coding.sh init --agent claude-code --yes
coding.sh init --dry-run
coding.sh init --remote https://obs.example.com --key csh_ik_…
```

- Copies the hook to ~/.coding.sh/bin/hook.mjs and points each agent at it.
- --remote checks that the server takes the key before writing anything, then adds the sink to ~/.coding.sh/config.toml (mode 600). Run it again to change the URL, key or mode.
- Registers the MCP server with Claude Code, Codex, Cursor, OpenCode and Gemini CLI (user scope only).
- Every edited file is backed up to ~/.coding.sh/backups first; uninstall reverts it.

## `coding.sh doctor`

Check agents, hooks, spool, store and the OTLP port.

```text
coding.sh doctor [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent (repeatable) |
| `--port <PORT>` | `4318` | OTLP receiver port to check. |

```sh
coding.sh doctor
coding.sh doctor --json
```

## `coding.sh status`

Show capture totals and the latest session.

```text
coding.sh status [options]
```

| Option | Default | Description |
|---|---|---|
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

## `coding.sh ingest`

Move captured hook events from the spool into the index.

```text
coding.sh ingest [options]
```

| Option | Default | Description |
|---|---|---|
| `--backfill` |  | Also import agents' local transcript history. |
| `--rebuild` |  | Re-parse every stored session (of --agent) from its transcript and spool with the current adapters. |
| `-a, --agent <AGENT>` |  | Only this agent (repeatable) |
| `--since <WHEN>` |  | Only after this time: 7d, 12h, 30m or a date. |
| `--background` |  | Don't wait for another ingest; exit quietly if one is running. |

```sh
coding.sh ingest
coding.sh ingest --backfill --since 30d
coding.sh ingest --rebuild --agent pi
```

- Rarely needed: read commands, the viewer and the MCP server ingest first, and the hook starts one when a session ends.
- After an upgrade, sessions stored by an older adapter parse are re-parsed in the background. --rebuild does it for every session now; a session whose transcript and spool lines are gone keeps its rows, minus duplicates.

## `coding.sh run`

Run any agent command and capture the session.

```text
coding.sh run [options] -- <CMD>...
```

| Argument | Required | Description |
|---|---|---|
| `cmd` | yes | Command and arguments after --. Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` | `wrapper` | Agent id to record. |

```sh
coding.sh run -- aider --message 'fix the tests'
```

- Exits with the command's exit code.

## `coding.sh collector`

Start a local OTLP/HTTP receiver for agents that export traces. Aliases: `otel`.

```text
coding.sh collector [options]
```

| Option | Default | Description |
|---|---|---|
| `-p, --port <PORT>` | `4318` | Port to listen on (0 = any free port) |
| `--host <HOST>` | `127.0.0.1` | Interface to bind. |

```sh
coding.sh collector
coding.sh otel --port 0
```

- Prints the OTEL_\* environment to stdout; status goes to stderr.

## `coding.sh proxy`

Run a local Anthropic/OpenAI API proxy that logs every model call.

```text
coding.sh proxy [action] [options]
```

| Action | What it does |
|---|---|
| [`status`](#codingsh-proxy-status) | Show whether a proxy is running, and where (exit 1 when not) |
| [`stop`](#codingsh-proxy-stop) | Stop the background proxy |
| [`env`](#codingsh-proxy-env) | Print the ANTHROPIC_BASE_URL / OPENAI_BASE_URL exports for the proxy |

| Option | Default | Description |
|---|---|---|
| `-p, --port <PORT>` | `4320` | Port to listen on, 0 = any free port ([proxy] port) |
| `--host <HOST>` | `127.0.0.1` | Interface to bind ([proxy] host) |
| `--anthropic-upstream <URL>` | `https://api.anthropic.com` | Where Anthropic calls go, e.g. a gateway ([proxy] anthropic_upstream) |
| `--openai-upstream <URL>` | `https://api.openai.com` | Where OpenAI calls go ([proxy] openai_upstream) |
| `--background` |  | Start detached, print the URL once it answers (log: ~/.coding.sh/proxy.log) |
| `-q, --quiet` |  | No line per call on stderr. |

```sh
coding.sh proxy
coding.sh proxy --background
coding.sh init --proxy
coding.sh proxy --anthropic-upstream https://gateway.example.com/anthropic
```

- Forwards /v1/messages (and count_tokens), /v1/chat/completions, /v1/responses and every other path to the real API with the client's own auth headers. Auth headers are never stored.
- Streams pass through as they arrive. A failed store write never fails the request.
- Calls from Claude Code and Codex land in the session their hooks capture; other clients get a proxy-&lt;hash&gt; session per conversation (or send x-coding-sh-session: &lt;id&gt;).
- Prints the environment to stdout; one line per call goes to stderr.

### `coding.sh proxy status`

Show whether a proxy is running, and where (exit 1 when not).

```text
coding.sh proxy status
```

```sh
coding.sh proxy status
```

### `coding.sh proxy stop`

Stop the background proxy.

```text
coding.sh proxy stop
```

```sh
coding.sh proxy stop
```

### `coding.sh proxy env`

Print the ANTHROPIC_BASE_URL / OPENAI_BASE_URL exports for the proxy.

```text
coding.sh proxy env
```

```sh
eval "$(coding.sh proxy env)"
```

## `coding.sh serve`

Production server: OTLP + native ingest, viewer, health and metrics on one port.

```text
coding.sh serve [action] [options]
```

| Action | What it does |
|---|---|
| [`keygen`](#codingsh-serve-keygen) | Print a new ingest (or read) key once, plus the sha256 line for a config file |
| [`healthcheck`](#codingsh-serve-healthcheck) | Exit 0 when the server answers 200, 1 otherwise (Docker HEALTHCHECK) |

| Option | Default | Description |
|---|---|---|
| `--host <HOST>` | `127.0.0.1` | Interface to bind (also CODING_SH_HOST) |
| `-p, --port <PORT>` | `4318` | Port to listen on, 0 = any free port (also CODING_SH_PORT, PORT) |
| `--config <FILE>` |  | Config file instead of ~/.coding.sh/config.toml. |
| `--role <ROLE>` | `all` | viewer: a read replica with no ingest and no writer lock. One of: `all`, `viewer`. |
| `--insecure` |  | Allow a non-loopback bind with no keys (also CODING_SH_INSECURE=1) |

```sh
coding.sh serve
CODING_SH_STORE_URL=postgres://… CODING_SH_INGEST_KEYS=demo:$KEY CODING_SH_READ_KEYS='*:'$READ coding.sh serve --host 0.0.0.0
coding.sh serve --role viewer --host 0.0.0.0
```

- Routes: POST /v1/traces, /v1/logs, /v1/metrics (OTLP/HTTP), POST /v1/ingest (native), GET / and /api/\* (viewer), /healthz, /readyz, /metrics.
- Precedence: flags &gt; env &gt; --config file &gt; defaults. See docs/PRODUCTION.md for every setting.
- A non-loopback bind needs an ingest key and a read key (or basic auth), or --insecure; on loopback with no keys, ingest is open to project default.
- Prints the URL (or one JSON document with --json) on stdout once ready; logs go to stderr. SIGTERM/SIGINT drain the queue (25s) and exit 0.

### `coding.sh serve keygen`

Print a new ingest (or read) key once, plus the sha256 line for a config file.

```text
coding.sh serve keygen [options]
```

| Option | Default | Description |
|---|---|---|
| `--project <ID>` | `default` | Project the key belongs to (read keys: \* for all) |
| `--read` |  | A read key (viewer, /api, /metrics) instead of an ingest key. |

```sh
coding.sh serve keygen --project demo
coding.sh serve keygen --read --project '*'
```

### `coding.sh serve healthcheck`

Exit 0 when the server answers 200, 1 otherwise (Docker HEALTHCHECK).

```text
coding.sh serve healthcheck [options]
```

| Option | Default | Description |
|---|---|---|
| `--url <URL>` |  | URL to probe (default http://127.0.0.1:&lt;port&gt;/healthz) |
| `--timeout <MS>` | `3000` | Give up after this many milliseconds. |

```sh
coding.sh serve healthcheck
coding.sh serve healthcheck --url http://127.0.0.1:4318/readyz
```

## `coding.sh uninstall`

Remove coding.sh hooks and MCP entries from every agent.

```text
coding.sh uninstall [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent (repeatable) |
| `--scope <SCOPE>` | `user` | Install into user or project config. One of: `user`, `project`. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh uninstall --dry-run
coding.sh uninstall --yes
```

- Captured data in ~/.coding.sh is kept.

## `coding.sh sessions`

List captured sessions.

```text
coding.sh sessions [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only sessions from this agent. |
| `-r, --repo <PATH>` |  | Only sessions in this repo root. |
| `--since <WHEN>` |  | Only after this time: 7d, 12h, 30m or a date. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--subagents` |  | Include subagent sessions. |
| `--empty` |  | Include sessions with no turn, tool call or model call (hidden by default) |
| `--project <ID>` |  | Only sessions in this serve project (default: all) |
| `--flag <NAME>` |  | Only sessions with this flag: looping, failure-streak, churn, no-progress, stalled, context-thrash, premature-completion, duplicate-fetch, …, or a tag such as skill:&lt;name&gt;. |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--facets [<KEYS>]` |  | Count sessions per value instead of listing them: agent, model, provider, repo, branch, flag, skill, kind, tool, mcp (default: agent, model, repo, flag, skill, tool) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'
coding.sh sessions --facets model,tool --where 'repo:coding-sh'
coding.sh sessions --agent codex --since 7d
```

- --where: key:value clauses, AND by default; OR between clauses; ( ) to group; - to negate; a,b for either value; \* as a wildcard in text; &gt; &gt;= &lt; &lt;= and a..b on numbers. Bare words search prompts, replies and tool calls (every word in one event).
- Session keys: agent, model, provider, repo, branch, dir, title, id, run, parent, flag, skill, since, until, duration, turns, tools, tool.errors, llm.errors, files, events, tests.passed, tests.failed, tokens, tokens.in, tokens.out, cost, has, is. Event keys (the session has a matching event; event keys in one group match the same event): kind, tool, ok, mcp, error, event.duration. Also sort:-cost and limit:N. Full list with examples: docs/reference/query.md.
- --facets counts each key over the query without that key's own clauses, so every value of a picked key still shows. --limit sets the values per key (default 10).
- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

## `coding.sh show`

Show a session timeline with subagents and latency.

```text
coding.sh show <SESSION> [options]
```

| Argument | Required | Description |
|---|---|---|
| `session` | yes | Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'. |

| Option | Default | Description |
|---|---|---|
| `-n, --limit <N>` |  | List the first N events (default 200; a longer session shows as phases) |
| `--all` |  | List every event, with phase and day lines and derail markers. |
| `-f, --follow` |  | Keep printing new events as a running session goes on (Ctrl-C to stop) |

```sh
coding.sh show latest
coding.sh show 9f1c2e
coding.sh show 9f1c2e --all
coding.sh show latest --follow
```

- A session with more than 200 events shows one line per phase: the start, each resume, compaction and long idle gap, with where it derailed.

## `coding.sh replay`

Step through a session and see what it did to each file it touched.

```text
coding.sh replay <SESSION> [options]
```

| Argument | Required | Description |
|---|---|---|
| `session` | yes | Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'. |

| Option | Default | Description |
|---|---|---|
| `--step <N>` |  | Show step N: its command and output, the diff it made, and the files touched so far. |
| `--to <M>` |  | Show what steps --step (default 1) through M changed together. |
| `--file <PATH>` |  | Print this file as of --step (default: the last step) |

```sh
coding.sh replay latest
coding.sh replay 9f1c2e --step 12
coding.sh replay 9f1c2e --step 5 --to 20
coding.sh replay 9f1c2e --step 12 --file src/app.ts
```

- File content is rebuilt from the agent's own tool calls: full writes, full reads and the edits applied to them. A file edited before any step showed it reads as unknown, with the reason, until a later read or write. A session run with `coding.sh run` also starts from its snapshot.
- The viewer has the same replay: the Replay button on a session page, or a link ending in ?step=N.

## `coding.sh search`

Full-text search over prompts, replies and tool calls.

```text
coding.sh search <TEXT>... [options]
```

| Argument | Required | Description |
|---|---|---|
| `text` | yes | Search text. Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only sessions from this agent. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--project <ID>` |  | Only matches in this serve project (default: all) |
| `--where <QUERY>` |  | Only matches matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh search 'flaky test'
coding.sh search migration --where 'agent:codex kind:tool.start'
```

- --where applies to each match: event keys (kind, tool, ok, …) to the matching event, session keys (agent, repo, cost, …) to its session. Keys: coding.sh sessions --help.
- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

## `coding.sh usage`

Tokens, cost, turns and cache hits by agent, model or day.

```text
coding.sh usage [options]
```

| Option | Default | Description |
|---|---|---|
| `--by <GROUP>` | `agent` | Group rows by. One of: `agent`, `model`, `agent-model`, `day`, `repo`. |
| `-a, --agent <AGENT>` |  | Only sessions from this agent. |
| `--since <WHEN>` | `30d` | Only after this time: 7d, 12h, 30m or a date. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--reprice` |  | Recompute estimated costs from the current price table first. |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |

```sh
coding.sh usage
coding.sh usage --by agent-model --since 90d
coding.sh usage --by model --where 'repo:coding-sh tool:Bash'
```

## `coding.sh sql`

Run one read-only SQL query against the SQLite index.

```text
coding.sh sql <QUERY>... [options]
```

| Argument | Required | Description |
|---|---|---|
| `query` | yes | One SELECT or WITH statement. Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--csv` |  | Print CSV instead of a table. |
| `-n, --limit <N>` | `1000` | Most rows to return. |
| `--timeout <SECONDS>` | `10` | Stop the query after this long. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh sql "select agent, count(*) as n from sessions group by agent"
coding.sh sql "select tool, count(*) from events where kind = 'tool.end' and ok = 0 group by tool order by 2 desc" --csv
coding.sh sql "select name, sql from sqlite_schema where type = 'table'"
```

- Read-only: the index is opened read-only with query_only on, and only one SELECT or WITH statement is accepted. INSERT, UPDATE, DELETE, ATTACH, PRAGMA statements and a second statement exit 2.
- Postgres and ClickHouse stores are not supported here: use coding.sh export, or the database's own client.
- Tables and columns: docs/reference/query.md. Events keep their payload as JSON text: json_extract(payload, '$.command').

## `coding.sh export`

Stream sessions, events or labels as JSONL or CSV.

```text
coding.sh export <WHAT> [options]
```

| Argument | Required | Description |
|---|---|---|
| `what` | yes | sessions, events or labels. |

| Option | Default | Description |
|---|---|---|
| `--format <FORMAT>` | `jsonl` | Output format. One of: `jsonl`, `csv`. |
| `-a, --agent <AGENT>` |  | Only sessions from this agent. |
| `-r, --repo <PATH>` |  | Only sessions in this repo root. |
| `--since <WHEN>` |  | Only after this time: 7d, 12h, 30m or a date. |
| `--flag <NAME>` |  | Only sessions with this flag or tag, as in coding.sh sessions --flag. |
| `--subagents` |  | Include subagent sessions (and their events and labels) |
| `--project <ID>` |  | Only sessions in this serve project (default: all) |
| `-n, --limit <N>` |  | Only the N newest matching sessions (default: all) |
| `--where <QUERY>` |  | Only sessions (and their events and labels) matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh export sessions --since 30d --format csv > sessions.csv
coding.sh export events --where 'agent:codex tool.errors>0' > events.jsonl
coding.sh export labels --format csv
```

- JSONL rows are the stored objects, one per line. CSV has fixed columns (docs/reference/query.md); event payloads are a JSON column.
- Text cells that start with = + - or @ get a leading ' in CSV so a spreadsheet does not run them as formulas.
- Works on every store, Postgres and ClickHouse included. Rows are streamed, so memory stays flat.

## `coding.sh ui`

Open the local session viewer.

```text
coding.sh ui [options]
```

| Option | Default | Description |
|---|---|---|
| `-p, --port <PORT>` | `4319` | First port to try (0 = any free port) |
| `--host <HOST>` | `127.0.0.1` | Interface to bind. |
| `--open` | `true` | Open the browser (--no-open to skip) |

```sh
coding.sh ui
coding.sh ui --no-open --port 0
```

- Running coding.sh with no command opens the viewer (or sets up capture first).

## `coding.sh mcp`

Serve captured sessions to agents over MCP (stdio).

```text
coding.sh mcp [action]
```

| Argument | Required | Description |
|---|---|---|
| `action` | no | serve (default): run the server; config: print how to register it. |

```sh
coding.sh mcp config
coding.sh mcp
```

- Agents start this themselves once coding.sh init has registered it.
- stdout carries MCP frames only.
- Tool calls ingest pending captures for up to 1.5 s (CODING_SH_READ_BUDGET_MS), then answer from what is indexed with a pending: {files, indexing} field.

## `coding.sh eval`

Build eval suites from sessions, skills or cases, and run them.

```text
coding.sh eval <action>
```

| Action | What it does |
|---|---|
| [`init`](#codingsh-eval-init) | Scaffold an eval suite in evals/&lt;name&gt;/: from failed sessions, a skill, or an app's cases |
| [`run`](#codingsh-eval-run) | Run eval suites and report pass@1, pass@k, pass^k, flaky tasks and saturation |
| [`new`](#codingsh-eval-new) | Draft a task from a captured session |
| [`import`](#codingsh-eval-import) | Add tasks from task directories (hand-written, or from eval export) |
| [`validate`](#codingsh-eval-validate) | Check the reference passes, near-misses fail and nothing leaks |
| [`crosscheck`](#codingsh-eval-crosscheck) | Ask a model whether stored solutions are valid and count where the verifier disagrees |
| [`audit`](#codingsh-eval-audit) | Replay a witness test on an experiment's passing runs and count the passes it refutes |
| [`trigger`](#codingsh-eval-trigger) | Check that the agent loads a skill when it should and not when it shouldn't |
| [`list`](#codingsh-eval-list) | List eval tasks |
| [`export`](#codingsh-eval-export) | Write a task to a directory |

- eval run exits 1 when a regression suite has a task that fails most of its trials. A capability suite reports its score and exits 0.
- pass@k is the chance at least one of k trials passes; pass^k is the chance all k pass. Both are estimated from every trial run.

### `coding.sh eval init`

Scaffold an eval suite in evals/<name>/: from failed sessions, a skill, or an app's cases.

```text
coding.sh eval init [name] [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | no | Suite name (default: the skill's or cases file's name, else failures or app) |

| Option | Default | Description |
|---|---|---|
| `--sessions` |  | Tasks from failed or flagged sessions in this repo (newest first) |
| `--session <ID>` |  | Tasks from these sessions instead: an id, a prefix or latest (repeatable) |
| `--since <AGE>` | `14d` | With --sessions: how far back to look (30m, 12h, 7d, 2w) |
| `--limit <N>` | `10` | With --sessions: at most N tasks. |
| `--verifier <CMD>` |  | With --sessions: command that passes only when a task is solved (default: guessed per session) |
| `--hidden-test <GLOB>` |  | With --sessions: test files to hide from the agent (repeatable) |
| `--skill <DIR>` |  | Should / should-not trigger prompts for this skill. |
| `--should <PROMPT>` |  | With --skill: a prompt that should load it (repeatable) |
| `--should-not <PROMPT>` |  | With --skill: a prompt that should not (repeatable) |
| `--cases <FILE>` |  | Cases for an app or prompt: JSONL, JSON or CSV of {"input", "expected"}. |
| `--describe <TEXT|@FILE>` |  | What the app or skill should do: the judge's rubric when cases have no expected answer, and the brief for --draft. |
| `--command <CMD>` |  | Command that answers one case: the input arrives as JSON on stdin, the answer is what it prints. |
| `--url <URL>` |  | Or an HTTP endpoint that answers one case (POST) |
| `--draft [<PROVIDER|JSON>]` |  | Have a model write the prompts or cases you didn't give, marked draft (default provider: anthropic) |
| `--draft-model <MODEL>` |  | With --draft: the model. |
| `--purpose <PURPOSE>` |  | capability: a hill to climb (sessions default). regression: should pass nearly always, eval run exits 1 when it doesn't (skill and cases default) One of: `capability`, `regression`. |
| `-k, --trials <N>` | `3` | Trials per task, case or prompt. |
| `-a, --agent <AGENT>` |  | Agent that runs the suite (default: the sessions' agent, else claude-code) |
| `--force` |  | Replace an existing suite; refused when it holds files eval init did not write, or that you changed. |
| `--force-all` |  | Replace an existing suite and delete those files too. |

```sh
coding.sh eval init
coding.sh eval init --sessions --verifier 'npm test'
coding.sh eval init --skill .claude/skills/pdf --draft
coding.sh eval init support --cases cases.jsonl --command 'node app.mjs'
coding.sh eval init triage --describe 'Labels a support ticket bug, billing or other' --command 'node triage.mjs' --draft
```

### `coding.sh eval run`

Run eval suites and report pass@1, pass@k, pass^k, flaky tasks and saturation.

```text
coding.sh eval run [suite]... [options]
```

| Argument | Required | Description |
|---|---|---|
| `suite` | no | Suite name under evals/, or its dir (default: every suite in evals/) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `-k, --trials <N>` |  | Trials per task, case or prompt (default: the suite's trials, else 3) |
| `-c, --concurrency <N>` |  | Parallel runs. |
| `-a, --agent <AGENT>` |  | Agent for task and skill suites (default: the suite's, else claude-code) |
| `--model <MODEL>` |  | Model for the agent. |
| `--harness <BUNDLE>` |  | Task suites: run this stored harness bundle (default: a snapshot of the project's current setup) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |

```sh
coding.sh eval run
coding.sh eval run failures --trials 5 --yes
coding.sh eval run triage --json
```

### `coding.sh eval new`

Draft a task from a captured session.

```text
coding.sh eval new <SESSION> [options]
```

| Argument | Required | Description |
|---|---|---|
| `session` | yes | Session id, or 'latest'. |

| Option | Default | Description |
|---|---|---|
| `--name <NAME>` |  | Task name. |
| `--instruction <TEXT|@FILE>` |  | What the agent is asked to do (default: the session's first prompt) |
| `--verifier <CMD>` |  | Command that passes only when the task is solved. |
| `--setup <CMD>` |  | Setup command (repeatable) |
| `--hidden-test <GLOB>` |  | Test files to hide from the agent (repeatable) |
| `--tag <TAG>` |  | Tag (repeatable) |

```sh
coding.sh eval new latest --verifier 'npm test'
coding.sh eval new latest --instruction @prompt.md --verifier 'npm test'
```

### `coding.sh eval import`

Add tasks from task directories (hand-written, or from eval export).

```text
coding.sh eval import <DIR>...
```

| Argument | Required | Description |
|---|---|---|
| `dir` | yes | Task directory: task.json, instruction.md, optional repo/ (the start tree) and tests/ (hidden verifier files) Takes the rest of the arguments. |

```sh
coding.sh eval import tasks/*/
```

### `coding.sh eval validate`

Check the reference passes, near-misses fail and nothing leaks.

```text
coding.sh eval validate <TASK> [options]
```

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Task id or name. |

| Option | Default | Description |
|---|---|---|
| `--k <N>` | `5` | Reference must pass N of N runs. |
| `--keep` |  | Keep work directories. |
| `--strict-coupling` |  | Fail validation when a hidden test names an identifier or file only the reference introduces. |

### `coding.sh eval crosscheck`

Ask a model whether stored solutions are valid and count where the verifier disagrees.

```text
coding.sh eval crosscheck <TASK> [options]
```

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Task id or name. |

| Option | Default | Description |
|---|---|---|
| `--experiment <ID>` |  | Only runs from this experiment (default: every stored run of the task) |
| `--max <N>` | `5` | Runs to review (one model call each) |
| `--judge <JSON|FILE>` | `{"provider":"anthropic"}` | Reviewer model: {"provider":"anthropic"\|"openai"\|"gateway"\|"mock","model":…}. |
| `--solver <BUNDLE>` |  | First solve the task once with this harness bundle and review that attempt too. |

```sh
coding.sh eval crosscheck my-task --experiment exp_01J…
coding.sh eval crosscheck my-task --solver claude-default --max 3
```

### `coding.sh eval audit`

Replay a witness test on an experiment's passing runs and count the passes it refutes.

```text
coding.sh eval audit <TASK> [options]
```

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Task id or name. |

| Option | Default | Description |
|---|---|---|
| `--experiment <ID>` |  | Experiment whose passing runs to replay (required) |
| `--witness <FILE|PATH=FILE>` |  | Test for a requirement the verifier misses; written at its path relative to here, or at PATH. |
| `--witness-cmd <CMD>` |  | Command that runs the witness from the repo root. |
| `--requirement <TEXT>` |  | The requirement it checks, in the instruction's words. |
| `--promote` |  | Add the witnesses to the verifier afterwards (the task needs validating again) |
| `--count-ambiguous` |  | Also count refutations by a witness that refutes over half the passing runs. |

```sh
coding.sh eval audit add-neg --experiment exp_01J… --witness test/neg.test.js --witness-cmd 'node test/neg.test.js' --requirement 'handle negative numbers'
coding.sh eval audit add-neg --experiment exp_01J…
```

### `coding.sh eval trigger`

Check that the agent loads a skill when it should and not when it shouldn't.

```text
coding.sh eval trigger <SKILL> [options]
```

| Argument | Required | Description |
|---|---|---|
| `skill` | yes | Skill directory, or its SKILL.md; prompts come from triggers.toml next to it. |

| Option | Default | Description |
|---|---|---|
| `--spec <FILE>` |  | Trigger spec: [[should]] and [[should_not]] prompts (default: triggers.toml in the skill dir) |
| `--candidate <DIR>` |  | A/B: another version of the skill, installed under the same name. |
| `--description <TEXT|@FILE>` |  | A/B: the same skill with only its frontmatter description replaced. |
| `-a, --agent <AGENT>` |  | Agent to probe (default: the --harness bundle's, else claude-code) |
| `--model <MODEL>` |  | Model for the agent. |
| `--harness <BUNDLE>` |  | Start each arm from this harness bundle (its files, flags, env and model) |
| `-k, --k <N>` |  | Runs per prompt and arm (default: the spec's k, else 3) |
| `-c, --concurrency <N>` | `4` | Parallel runs. |
| `--seed <N>` | `1` | Seed for the run order and the bootstrap. |
| `--timeout <SEC>` |  | Seconds per run (default: the spec's timeout_s, else 120) |
| `--siblings <DIR>` |  | Install the skills in this dir in every arm (default: the skills next to &lt;SKILL&gt;) |
| `--no-siblings` |  | Install only the skill under test. |
| `--min-f1 <X>` |  | Exit 1 when the tested arm's F1 is under X (0 to 1) |
| `--fail-on <WHAT>` |  | Exit 1 when B answers fewer prompts right than A, with the 95% CI below 0. One of: `regression`. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |

```sh
coding.sh eval trigger .claude/skills/pdf -k 3 --yes
coding.sh eval trigger .claude/skills/pdf --description @new-description.txt --fail-on regression --yes
coding.sh eval trigger skills/pdf --candidate skills-next/pdf --min-f1 0.8 --yes
coding.sh eval trigger .agents/skills/pdf -a codex --harness codex-base --yes
```

### `coding.sh eval list`

List eval tasks.

```text
coding.sh eval list [options]
```

| Option | Default | Description |
|---|---|---|
| `--status <STATUS>` |  | Only tasks with this status. One of: `draft`, `validated`, `rejected`. |
| `--tag <TAG>` |  | Only tasks with this tag. |

### `coding.sh eval export`

Write a task to a directory.

```text
coding.sh eval export <TASK> [options]
```

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Task id or name. |

| Option | Default | Description |
|---|---|---|
| `-o, --out <DIR>` |  | Output directory (required) |
| `--format <FORMAT>` | `coding.sh` | Directory layout. One of: `coding.sh`, `harbor`. |
| `--force` |  | Replace the named target when it already exists. |

## `coding.sh dataset`

Manage versioned datasets of cases.

```text
coding.sh dataset <action>
```

| Action | What it does |
|---|---|
| [`add`](#codingsh-dataset-add) | Add cases to a dataset (creates it when missing) |
| [`import`](#codingsh-dataset-import) | Import cases from a JSONL, JSON or CSV file |
| [`list`](#codingsh-dataset-list) | List datasets |

### `coding.sh dataset add`

Add cases to a dataset (creates it when missing).

```text
coding.sh dataset add <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Dataset name. |

| Option | Default | Description |
|---|---|---|
| `--case <JSON>` |  | Case as JSON: {"input":…,"expected":…} (repeatable) |
| `--session <ID>` |  | Case from a captured session (repeatable) |
| `--split <SPLIT>` |  | Split for the added cases (default: stable hash of the case id, 60/20/20) One of: `train`, `dev`, `test`. |
| `--note <TEXT>` |  | Version note. |

```sh
coding.sh dataset add smoke --case '{"input":"2+2","expected":"4"}'
coding.sh dataset add labelled --session <ID> --split test
```

### `coding.sh dataset import`

Import cases from a JSONL, JSON or CSV file.

```text
coding.sh dataset import <FILE> [options]
```

| Argument | Required | Description |
|---|---|---|
| `file` | yes | Path to the file. |

| Option | Default | Description |
|---|---|---|
| `--name <NAME>` |  | Dataset name (default: file name) |
| `--note <TEXT>` |  | Version note. |

### `coding.sh dataset list`

List datasets.

```text
coding.sh dataset list
```

## `coding.sh exp`

Run a task over a dataset, compare experiments and sweep configs.

```text
coding.sh exp <action>
```

| Action | What it does |
|---|---|
| [`ab`](#codingsh-exp-ab) | A/B a CLAUDE.md, AGENTS.md, rule or skill edit on the decision points your agent recently got wrong |
| [`run`](#codingsh-exp-run) | Run an experiment, two tasks as one interleaved A/B, or a matrix of cells against a baseline cell |
| [`session`](#codingsh-exp-session) | Group runs into a session: new, note &lt;text&gt;, summary. exp run in it prints the delta against the previous run |
| [`compare`](#codingsh-exp-compare) | Compare two experiments case by case |
| [`regrade`](#codingsh-exp-regrade) | Grade a stored experiment's outputs again with new graders, without calling the task, and show what flipped |
| [`aa`](#codingsh-exp-aa) | Run one config twice (A/A) and store its run-to-run noise |
| [`sweep`](#codingsh-exp-sweep) | Race task configs with sequential halving, then re-score the winner on held-out cases |
| [`metrics`](#codingsh-exp-metrics) | A/B two metric commands (ms, bytes) in interleaved pairs |
| [`plateau`](#codingsh-exp-plateau) | Should an iteration loop stop? A restart e-detector over its experiments, and the version to ship (exit 3 stop, 2 too few, 0 continue) |
| [`show`](#codingsh-exp-show) | Show a stored experiment: pass rate, graders and failures |
| [`list`](#codingsh-exp-list) | List experiments |
| [`status`](#codingsh-exp-status) | Progress, ETA and cost so far of long runs (exp, compare, bench, workflows), and how to resume them |

### `coding.sh exp ab`

A/B a CLAUDE.md, AGENTS.md, rule or skill edit on the decision points your agent recently got wrong.

```text
coding.sh exp ab [spec] [options]
```

| Argument | Required | Description |
|---|---|---|
| `spec` | no | JSON file with the same fields as the options (behavior, since, a, b, model, …); options override it. |

| Option | Default | Description |
|---|---|---|
| `--a <FILE|DIR|git:REV|BUNDLE|none>` |  | Baseline harness (default: git HEAD when B is omitted, else the repo's current files) |
| `--b <FILE|DIR|git:REV|BUNDLE|none>` |  | Candidate harness; a file replaces the file of the same path in A (default: your uncommitted edits) |
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent. Repeatable. |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `-n, --limit <N>` | `40` | Maximum decision points. |
| `--provider <NAME>` | `anthropic` | API that answers the next turn and judges it. One of: `anthropic`, `openai`, `openai-compatible`. |
| `--model <MODEL>` |  | Model for the next turn (default: the one the decision points were recorded with, else claude-sonnet-5-5 or gpt-6-sol) |
| `--judge-model <MODEL>` |  | Model for the judge (default: --model) |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--trials <N>` | `1` | Next turns per case and arm. |
| `-c, --concurrency <N>` | `4` | Parallel model calls. |
| `--max-cost <USD>` |  | Refuse to start when the estimate is over this, and stop once the spend passes it. |
| `--dry-run` |  | Show the decision points and the cost estimate; make no model calls. |
| `--watch` |  | Rerun when B's files change, one line per run; Ctrl-C to stop. |
| `--cache` | `true` | Reuse stored model responses (--no-cache to ask the model again) |
| `--name <NAME>` |  | Experiment name (default: the dataset's) |
| `--gate` |  | Ship-or-hold decision: exit 0 when B wins enough without breaking what A solved, 1 otherwise. |
| `--lambda <N>` | `2` | With --gate: what breaking one solved item costs, in fixed items. |
| `--gate-alpha <A>` | `0.05` | With --gate: one-sided significance level. |
| `--tau <T>` | `0.10` | With --gate: largest share of solved items B may break. |
| `--allow-protected-edit <PATH:LINE>` |  | Allow the edit to delete, reword or relax this protected line (repeatable; never implied by --force) |
| `--resume [<ID>]` |  | Continue an interrupted A/B: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp ab
coding.sh exp ab --b ./drafts/CLAUDE.md --behavior unverified-claim
coding.sh exp ab --a git:main --b . --since 30d --dry-run
coding.sh exp ab --watch
```

### `coding.sh exp run`

Run an experiment, two tasks as one interleaved A/B, or a matrix of cells against a baseline cell.

```text
coding.sh exp run [spec] [options]
```

| Argument | Required | Description |
|---|---|---|
| `spec` | no | Experiment spec JSON file (options override its fields; --grader adds graders); with "matrix" or "variants" it runs every cell. |

| Option | Default | Description |
|---|---|---|
| `-d, --dataset <ID>` |  | Dataset id. |
| `--task <JSON|FILE>` |  | Task spec: {"kind":"command","command":"…"} (gets each case input as JSON on stdin) or {"kind":"http","url":"…"}. |
| `-g, --grader <JSON|FILE>` |  | Grader spec, e.g. {"kind":"exact"} (repeatable); added to the spec file's graders. |
| `--replace-graders` |  | Use only the --grader graders, not the spec file's. |
| `--name <NAME>` |  | Experiment name. |
| `--trials <N>` | `1` | Attempts per case. |
| `-c, --concurrency <N>` | `4` | Parallel case runs. |
| `--split <SPLIT>` |  | Only cases in this split. One of: `train`, `dev`, `test`. |
| `--arm <NAME=JSON|FILE>` |  | One arm's task spec; give two (A then B) to interleave them case by case in one run. Repeatable. |
| `--stop-early` |  | With --arm: stop once a group sequential test (O'Brien-Fleming) is decisive. |
| `--looks <N>` | `4` | With --stop-early: planned looks over the case budget. |
| `--max-cases <N>` |  | With --arm: run at most N cases (a random subset) |
| `--seed <N>` |  | With --arm or a matrix spec: seed for the case and arm order (default random, recorded) |
| `--plan` |  | With a matrix spec: print the cells and what each changes, check them, and run nothing. |
| `--cell <NAME>` |  | With a matrix spec: run only this cell (repeatable); the baseline cell always runs. |
| `--reuse <CELLS>` | `none` | With a matrix spec: copy finished case-trials of the same case, task, graders, trial and timeout from earlier experiments instead of running them again. One of: `baseline`, `all`, `none`. |
| `--reuse-max-age <AGE>` | `7d` | With --reuse: only case-trials that started this recently (30m, 12h, 7d, 2w) |
| `--control` | `true` | A continuation task needs a control arm (A, the recorded config) to measure replay noise; --no-control runs one task alone and marks the result. |
| `--series <NAME>` |  | Tag the experiment as the next round of an iteration loop and print whether the loop should stop (see exp plateau) |
| `--watch` |  | Rerun on every change to the spec, the task's script, grader files or --watch-path; a grader-only change regrades the stored outputs. Enter reruns, q quits. |
| `--watch-path <GLOB>` |  | With --watch: more files whose change reruns the task (repeatable; also the spec's "watch" field) |
| `--session` | `true` | In an experiment session (exp session new), add the run to its timeline and print the delta against the previous run; --no-session skips it. |
| `--resume [<ID>]` |  | Continue an interrupted experiment: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp run spec.json --watch
coding.sh exp run -d smoke -g '{"kind":"exact"}' --arm base=base.json --arm cand=cand.json --stop-early --max-cases 400
coding.sh exp run spec.json --resume
coding.sh exp run matrix.json --plan
coding.sh exp run matrix.json --cell model=opus,prompt=short
coding.sh exp run matrix.json --reuse baseline --plan
```

### `coding.sh exp session`

Group runs into a session: new, note <text>, summary. exp run in it prints the delta against the previous run.

```text
coding.sh exp session <COMMAND> [text]... [options]
```

| Argument | Required | Description |
|---|---|---|
| `command` | yes | new, note or summary. |
| `text` | no | With note: the note (hypothesis before a run, what you saw after it) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--name <TOPIC>` |  | With new: the session's name. |

```sh
coding.sh exp session new --name shorter-prompt
coding.sh exp session note "hypothesis: the shorter prompt fixes c3"
coding.sh exp session summary --json
```

### `coding.sh exp compare`

Compare two experiments case by case.

```text
coding.sh exp compare <A> <B> [options]
```

| Argument | Required | Description |
|---|---|---|
| `a` | yes | Baseline experiment id or name (newest) |
| `b` | yes | Candidate experiment id or name (newest) |

| Option | Default | Description |
|---|---|---|
| `--force` |  | Compare a cancelled (partial) experiment too. |
| `--cluster <KEY>` |  | Case metadata field (e.g. repo, session) whose clusters the bootstrap resamples instead of single cases. |
| `--pairwise <JSON|FILE>` |  | Pairwise judge spec, {"kind":"pairwise","name":…,"rubric":…}: judges A and B's outputs side by side, in both orders. |
| `--labels <FILE>` |  | With --pairwise: human labels (JSON array or JSONL of {"caseId","winner":"a"\|"b"\|"tie"}) to calibrate the judge on the test split. |
| `--matrix` |  | Also print the success-count matrix: cases by passes out of k in A (rows) and B (columns) |
| `--margin <D>` |  | Non-inferiority: exit 1 unless the 95% CI lower bound of B − A is above −D (0.05 = 5pp) |
| `--gate` |  | Ship-or-hold decision: exit 0 when B wins enough without breaking what A solved, 1 otherwise. |
| `--lambda <N>` | `2` | With --gate: what breaking one solved item costs, in fixed items. |
| `--gate-alpha <A>` | `0.05` | With --gate: one-sided significance level. |
| `--tau <T>` | `0.10` | With --gate: largest share of solved items B may break. |

```sh
coding.sh exp compare base cand
coding.sh exp compare base cheaper --margin 0.03
coding.sh exp compare base cand --cluster repo
coding.sh exp compare base cand --gate
coding.sh exp compare base cand --matrix
coding.sh exp compare base cand --pairwise judge.json
```

### `coding.sh exp regrade`

Grade a stored experiment's outputs again with new graders, without calling the task, and show what flipped.

```text
coding.sh exp regrade <EXPERIMENT> [spec] [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id or name (newest) |
| `spec` | no | Experiment spec JSON file whose graders to use (--grader adds to them) |

| Option | Default | Description |
|---|---|---|
| `-g, --grader <JSON|FILE>` |  | Grader spec (repeatable); added to the spec file's graders. |
| `--replace-graders` |  | Use only the --grader graders, not the spec file's. |
| `--name <NAME>` |  | Name of the regraded experiment (default: the original's) |
| `-c, --concurrency <N>` | `4` | Parallel grader runs. |

```sh
coding.sh exp regrade base spec.json
coding.sh exp regrade base -g strict.json --json
```

### `coding.sh exp aa`

Run one config twice (A/A) and store its run-to-run noise.

```text
coding.sh exp aa [a] [b] [options]
```

| Argument | Required | Description |
|---|---|---|
| `a` | no | Spec JSON file to run twice, or the first of two stored runs of one config. |
| `b` | no | The second stored run (compares the two instead of running) |

| Option | Default | Description |
|---|---|---|
| `-d, --dataset <ID>` |  | Dataset id. |
| `--task <JSON|FILE>` |  | Task spec: {"kind":"command","command":"…"} (gets each case input as JSON on stdin) or {"kind":"http","url":"…"}. |
| `-g, --grader <JSON|FILE>` |  | Grader spec, e.g. {"kind":"exact"} (repeatable); added to the spec file's graders. |
| `--replace-graders` |  | Use only the --grader graders, not the spec file's. |
| `--name <NAME>` |  | Experiment name. |
| `--trials <N>` | `1` | Attempts per case. |
| `-c, --concurrency <N>` | `4` | Parallel case runs. |
| `--split <SPLIT>` |  | Only cases in this split. One of: `train`, `dev`, `test`. |
| `--resume [<ID>]` |  | Continue an interrupted A/A run: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp aa --dataset smoke --task '{"kind":"command","command":"node agent.mjs"}' --grader '{"kind":"exact"}'
coding.sh exp aa smoke-aa1 smoke-aa2
```

### `coding.sh exp sweep`

Race task configs with sequential halving, then re-score the winner on held-out cases.

```text
coding.sh exp sweep <CONFIGS>... [options]
```

| Argument | Required | Description |
|---|---|---|
| `configs` | yes | Task configs, [NAME=]&lt;JSON\|FILE&gt;; the first is the start config. Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `-d, --dataset <ID>` |  | Dataset id. |
| `-g, --grader <JSON|FILE>` |  | Grader spec, e.g. {"kind":"exact"} (repeatable); added to the spec file's graders. |
| `--name <NAME>` |  | Experiment name. |
| `-c, --concurrency <N>` | `4` | Parallel case runs. |
| `--budget <N>` |  | Case runs for the race, over all configs (default: each race case used once by the last round) |
| `--split <SPLIT>` | `train` | Split the race runs on. One of: `train`, `dev`, `test`. |
| `--held-out <SPLIT>` | `test` | Split the winner is re-scored on (a seeded 30% when the dataset has no splits) One of: `train`, `dev`, `test`. |
| `--seed <N>` |  | Seed for the case and job order (default random, recorded) |
| `--resume [<ID>]` |  | Continue an interrupted sweep: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp sweep base=base.json t2=temp2.json t5=temp5.json -d smoke -g '{"kind":"exact"}' --budget 300
```

### `coding.sh exp metrics`

A/B two metric commands (ms, bytes) in interleaved pairs.

```text
coding.sh exp metrics [options]
```

| Option | Default | Description |
|---|---|---|
| `--arm <NAME=CMD|JSON|FILE>` |  | One arm: a command line, a task spec or a spec file; give two (A then B). The command prints a JSON object of numbers. Repeatable. |
| `--pairs <N>` | `11` | Interleaved pairs (each runs A and B once, in balanced random order) |
| `--warmup <N>` | `0` | Runs of each arm before the pairs, not counted. |
| `--higher <METRIC>` |  | Metric where higher is better (repeatable, \* wildcard); lower is better otherwise. |
| `--metric <METRIC>` |  | Only report these metrics (repeatable, \* wildcard) |
| `--correction <METHOD>` | `holm` | Multiple-comparison correction across metrics. One of: `holm`, `none`. |
| `--timeout <SEC>` | `600` | Per-run timeout for arms that don't set timeoutMs. |
| `--seed <N>` |  | Seed for the arm order (default random, recorded) |
| `--name <NAME>` |  | Experiment name. |
| `--fail-on-worse` |  | Exit 1 when any metric is worse in B. |

```sh
coding.sh exp metrics --arm base='node bench.mjs --dir a' --arm cand='node bench.mjs --dir b'
coding.sh exp metrics --arm base=base.json --arm cand=cand.json --pairs 21 --higher score --json
```

### `coding.sh exp plateau`

Should an iteration loop stop? A restart e-detector over its experiments, and the version to ship (exit 3 stop, 2 too few, 0 continue).

```text
coding.sh exp plateau [experiments]... [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiments` | no | Experiment ids or names in loop order, baseline first (default: --series or --dataset, oldest first) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--series <NAME>` |  | The experiments tagged by exp run --series NAME. |
| `-d, --dataset <ID>` |  | The completed experiments on this dataset. |
| `--baseline <ID>` |  | Version 0 of the loop; earlier experiments are left out. |
| `--eps <GAIN>` | `0.05` | Smallest gain per round worth another round (0.05 = 5pp) |
| `--delta <P>` | `0.05` | Stop once the evidence reaches 1/δ (false alarms average no sooner than every 1/δ rounds) |
| `--gate <GATE>` | `greedy` | greedy keeps a candidate only when it beats the incumbent; chain keeps every candidate (metadata.accepted overrides both) One of: `greedy`, `chain`. |
| `--bet <BET>` | `agrapa` | Betting strategy of the detector. One of: `agrapa`, `mixture`. |

```sh
coding.sh exp plateau --series prompt-loop
coding.sh exp plateau v0 v1 v2 v3 v4 --gate chain --json
coding.sh exp run spec.json --name v5 --series prompt-loop
```

### `coding.sh exp show`

Show a stored experiment: pass rate, graders and failures.

```text
coding.sh exp show <EXPERIMENT>
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id or name (newest, cancelled ones included) |

### `coding.sh exp list`

List experiments.

```text
coding.sh exp list [options]
```

| Option | Default | Description |
|---|---|---|
| `-n, --limit <N>` | `20` | Maximum rows. |

### `coding.sh exp status`

Progress, ETA and cost so far of long runs (exp, compare, bench, workflows), and how to resume them.

```text
coding.sh exp status [run] [options]
```

| Argument | Required | Description |
|---|---|---|
| `run` | no | One run: its id, or the id of an experiment it produced. |

| Option | Default | Description |
|---|---|---|
| `-n, --limit <N>` | `20` | Maximum rows. |

```sh
coding.sh exp status
coding.sh exp status exp_01JC3T6Z2Q8W1S5V0R7N4K9M2D --json
```

## `coding.sh judge`

Grade one output or the slop in captured diffs, or check an LLM judge or a test verifier against human labels.

```text
coding.sh judge <action>
```

| Action | What it does |
|---|---|
| [`grade`](#codingsh-judge-grade) | Run one grader on one output and trace (exit 0 on pass); inside a verifier both default to the agent's |
| [`slop`](#codingsh-judge-slop) | Flag agent-slop patterns (placeholder code, type escapes, swallowed errors, debug prints, focused tests) in the lines captured work added |
| [`calibrate`](#codingsh-judge-calibrate) | Measure judge-human agreement (Cohen's kappa) on a held-out split, or a verifier's precision |
| [`sample`](#codingsh-judge-sample) | Plan which cases to label next: a seeded random sample stratified by judge verdict and confidence |

- judge grade appends each model call's tokens and price to $CODING_SH_GRADER_USAGE when it is set. coding.sh compare sets it for every verifier, so judge spend counts toward --max-cost.

### `coding.sh judge grade`

Run one grader on one output and trace (exit 0 on pass); inside a verifier both default to the agent's.

```text
coding.sh judge grade [options]
```

| Option | Default | Description |
|---|---|---|
| `-g, --grader <JSON|FILE>` |  | Grader spec, the same JSON as `exp run --grader` (llm, llm-checklist with trace checks, contains, regex, …) |
| `--output <FILE|->` |  | The output to grade (default: $CODING_SH_AGENT_OUTPUT, the agent's final answer in a verifier) |
| `--trace <FILE>` |  | Claude stream-json or transcript, or coding.sh events as JSONL (default: $CODING_SH_AGENT_STDOUT) |
| `--input <TEXT|@FILE>` |  | The task input shown to a judge. |
| `--metadata <JSON|FILE>` |  | Case metadata, e.g. {"instructions": "…"} for follows-rules. |
| `--diff <FILE|->` |  | The agent's work as a unified diff, for agent-slop (default: $CODING_SH_AGENT_DIFF in a verifier) |

```sh
coding.sh judge grade --grader checklist.json
coding.sh judge grade --grader judge.json --output answer.txt --trace stream.jsonl --json
coding.sh judge grade --grader '{"kind":"agent-slop","maxWarnings":5}'
```

### `coding.sh judge slop`

Flag agent-slop patterns (placeholder code, type escapes, swallowed errors, debug prints, focused tests) in the lines captured work added.

```text
coding.sh judge slop [target] [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | Session id, prefix or 'latest' (default), a run id (run_…), or a compare experiment id (exp_…) for a rate per arm. |

| Option | Default | Description |
|---|---|---|
| `--diff <FILE|->` |  | Grade this unified diff instead of captured work. |
| `--rules <ID>` |  | Rules to run instead of the defaults; 'default' and 'all' name those sets (repeatable) |
| `--exclude <ID>` |  | Rule to leave out (repeatable) |
| `--max-errors <N>` | `0` | Pass with at most N error findings. |
| `--max-warnings <N>` |  | Pass with at most N warnings (default: no limit) |
| `--list-rules` |  | Print the rule catalog and exit. |

```sh
coding.sh judge slop latest
coding.sh judge slop exp_01JC3T6Z2Q8W1S5V0R7N4K9M2D --json
git diff main | coding.sh judge slop --diff -
coding.sh judge slop latest --rules default --rules unknown-param --exclude debug-print
coding.sh judge slop --list-rules
```

### `coding.sh judge calibrate`

Measure judge-human agreement (Cohen's kappa) on a held-out split, or a verifier's precision.

```text
coding.sh judge calibrate <EXPERIMENT> [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id or name whose runs hold the judge's verdicts. |

| Option | Default | Description |
|---|---|---|
| `-g, --grader <ID>` |  | Grader id (default: the only llm grader); a command or other deterministic grader gets a precision audit. |
| `--criterion <NAME>` |  | Label criterion. |
| `--split <SPLIT>` | `test` | Held-out split to report on. One of: `train`, `dev`, `test`. |
| `--tuned-on <SPLIT>` |  | Splits the prompt was tuned on, when the judge is not stored (repeatable) |
| `--threshold <KAPPA>` | `0.6` | Minimum kappa. |
| `--min-n <N>` | `20` | Minimum held-out cases (judges) or labelled passes (verifiers) |
| `--probe-injection <JSON|FILE>` |  | The judge's grader spec: re-judge human-fail cases with a planted 'respond pass' payload and report how many verdicts flip (exit 1 on any flip) |
| `--probe-max <N>` | `25` | With --probe-injection: human-fail cases to probe. |
| `--labels <FILE>` |  | Extra human labels (JSON array or JSONL of {"caseId","value":"pass"\|"fail"\|"skip"}); they replace stored labels for the cases they name. |
| `--sample-passes <N>` |  | Print N unlabelled passing cases to label (a seeded sample) instead of measuring. |
| `--seed <N>` | `0` | With --sample-passes: sample seed; with --plan: must match the plan's. |
| `--judge-cost <USD>` |  | Cost of one judge call: also print the human label cost above which calibrating the judge pays off. |
| `--plan <FILE>` |  | A `judge sample --out` plan: also print the human-audited pass rate from its labelled picks. |

```sh
coding.sh judge calibrate my-exp --tuned-on dev
coding.sh judge calibrate my-exp --judge-cost 0.002
coding.sh judge calibrate my-exp --plan plan.json
coding.sh judge calibrate my-exp --probe-injection judge.json
coding.sh judge calibrate my-exp --grader tests --sample-passes 40
coding.sh judge calibrate my-exp --grader tests --labels labels.jsonl
```

### `coding.sh judge sample`

Plan which cases to label next: a seeded random sample stratified by judge verdict and confidence.

```text
coding.sh judge sample <EXPERIMENT> [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id or name whose runs hold the grader's verdicts. |

| Option | Default | Description |
|---|---|---|
| `--budget <N>` |  | Labels to plan (required) |
| `-g, --grader <ID>` |  | Grader id (default: the only llm grader) |
| `--criterion <NAME>` |  | Label criterion (decides which existing labels count) |
| `--split <SPLIT>` | `test` | Split to sample from. One of: `train`, `dev`, `test`. |
| `--seed <N>` | `0` | Sample seed. |
| `--min-stratum <N>` | `25` | Smallest confidence bin before it merges into a neighbour. |
| `-o, --out <FILE>` |  | Write the plan for `judge calibrate --plan`. |

```sh
coding.sh judge sample my-exp --budget 60 --out plan.json
coding.sh judge sample my-exp --budget 60 --json
```

## `coding.sh toolevals`

Measure how well agents use a CLI, MCP server or API.

```text
coding.sh toolevals <action>
```

| Action | What it does |
|---|---|
| [`init`](#codingsh-toolevals-init) | Add a target to coding.sh.toml and write starter tasks |
| [`surface`](#codingsh-toolevals-surface) | Surface bytes, description bytes and tokens per tool or subcommand |
| [`validate`](#codingsh-toolevals-validate) | Check no-op trials fail, references pass and nothing leaks |
| [`run`](#codingsh-toolevals-run) | Run tasks x variants x drivers x k and summarize each arm |
| [`compare`](#codingsh-toolevals-compare) | Compare two arms of an experiment (paired by task) |
| [`compress`](#codingsh-toolevals-compress) | Shorten MCP tool descriptions without losing success |
| [`show`](#codingsh-toolevals-show) | Show a trial's metrics, tap records and session tree |

- Arms are named &lt;variant&gt;@&lt;driver&gt;.
- Runs above [toolevals] confirmAboveUsd (default $5) need --yes when not on a TTY.

### `coding.sh toolevals init`

Add a target to coding.sh.toml and write starter tasks.

```text
coding.sh toolevals init [options]
```

| Option | Default | Description |
|---|---|---|
| `--cli <BIN>` |  | CLI binary to evaluate. |
| `--mcp <CMD>` |  | MCP server command (stdio) |
| `--mcp-url <URL>` |  | MCP server URL (Streamable HTTP) |
| `--http <URL>` |  | HTTP API base URL. |
| `--name <NAME>` |  | Target name (default: from the binary or host) |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh toolevals init --cli gh
coding.sh toolevals init --mcp "npx -y @modelcontextprotocol/server-everything" --name everything
```

### `coding.sh toolevals surface`

Surface bytes, description bytes and tokens per tool or subcommand.

```text
coding.sh toolevals surface [target] [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | Target name (default: the only one) |

| Option | Default | Description |
|---|---|---|
| `--variant <VARIANT>` | `base` | Variant to measure. |

### `coding.sh toolevals validate`

Check no-op trials fail, references pass and nothing leaks.

```text
coding.sh toolevals validate [target]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | Target name (default: all) |

### `coding.sh toolevals run`

Run tasks x variants x drivers x k and summarize each arm.

```text
coding.sh toolevals run [target] [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | Target name (default: the only one) |

| Option | Default | Description |
|---|---|---|
| `-d, --driver <DRIVER>` |  | agent:&lt;id&gt;[:model] or model:&lt;provider&gt;/&lt;model&gt; (repeatable) |
| `--variant <VARIANT>` |  | Variant (repeatable; default: base) |
| `-k, --k <N>` | `3` | Trials per task and arm. |
| `--split <SPLIT>` | `dev` | Task split. One of: `dev`, `heldout`, `all`. |
| `-t, --task <ID>` |  | Only this task (repeatable) |
| `-c, --concurrency <N>` |  | Parallel trials. |
| `--keep` |  | Keep trial sandboxes. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |

```sh
coding.sh toolevals run gh --driver agent:claude-code -k 3
coding.sh toolevals run everything --driver model:anthropic/claude-sonnet-5-5 --variant base --variant terse
```

### `coding.sh toolevals compare`

Compare two arms of an experiment (paired by task).

```text
coding.sh toolevals compare <EXPERIMENT> [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id. |

| Option | Default | Description |
|---|---|---|
| `--baseline <ARM>` |  | Baseline arm, &lt;variant&gt;@&lt;driver&gt;. |
| `--candidate <ARM>` |  | Candidate arm, &lt;variant&gt;@&lt;driver&gt;. |

### `coding.sh toolevals compress`

Shorten MCP tool descriptions without losing success.

```text
coding.sh toolevals compress [target] [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | MCP target name (default: the only one) |

| Option | Default | Description |
|---|---|---|
| `-d, --driver <DRIVER>` |  | Driver to evaluate with. |
| `-k, --k <N>` | `3` | Trials per task. |
| `--margin <DELTA>` | `0.03` | Allowed success drop (CI lower bound) |
| `--max-evals <N>` | `40` | Maximum candidate evaluations. |
| `--batch` |  | Compress every tool at one level per step. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |

### `coding.sh toolevals show`

Show a trial's metrics, tap records and session tree.

```text
coding.sh toolevals show <TRIAL>
```

| Argument | Required | Description |
|---|---|---|
| `trial` | yes | Trial id. |

## `coding.sh workflows`

Capture, measure and A/B-test multi-agent workflow runs. Aliases: `workflow`, `wf`.

```text
coding.sh workflows <action>
```

| Action | What it does |
|---|---|
| [`list`](#codingsh-workflows-list) | Runs with status, wall time, cost and agent count |
| [`import`](#codingsh-workflows-import) | Import Claude Code workflow runs from disk |
| [`show`](#codingsh-workflows-show) | Run tree with per-node time, cost and status |
| [`stats`](#codingsh-workflows-stats) | Critical path, concurrency, barrier idle, failures, cache hits, cost |
| [`score`](#codingsh-workflows-score) | Grade a run's output against a case's truth |
| [`run`](#codingsh-workflows-run) | A/B workflow variants over cases; prints the experiment id |
| [`compare`](#codingsh-workflows-compare) | Paired comparison of two variants of an experiment |
| [`replay`](#codingsh-workflows-replay) | Re-run an edited script from a run's journal (cached prefix) |

- Workflow runs are stored under ~/.coding.sh/workflows/ until the index stores them.

### `coding.sh workflows list`

Runs with status, wall time, cost and agent count.

```text
coding.sh workflows list [options]
```

| Option | Default | Description |
|---|---|---|
| `--framework <FRAMEWORK>` |  | Only runs from this framework. |
| `--name <NAME>` |  | Only runs of this workflow. |
| `--since <WHEN>` |  | Only after this time: 7d, 12h, 30m or a date. |
| `--experiment <ID>` |  | Only runs of this experiment. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--import` | `true` | Import new or changed Claude Code workflow runs first (--no-import to skip) |

```sh
coding.sh workflows list --since 7d
coding.sh workflows list --framework langgraph --json
```

### `coding.sh workflows import`

Import Claude Code workflow runs from disk.

```text
coding.sh workflows import [path] [options]
```

| Argument | Required | Description |
|---|---|---|
| `path` | no | Projects, project, session or run directory (default: Claude Code's projects dir) |

| Option | Default | Description |
|---|---|---|
| `--force` |  | Re-import run directories that did not change. |

### `coding.sh workflows show`

Run tree with per-node time, cost and status.

```text
coding.sh workflows show <RUN> [options]
```

| Argument | Required | Description |
|---|---|---|
| `run` | yes | Workflow run id. |

| Option | Default | Description |
|---|---|---|
| `--tree` |  | Include subagent, tool and model-call nodes. |
| `--gantt` |  | Print the timeline as TSV instead. |

### `coding.sh workflows stats`

Critical path, concurrency, barrier idle, failures, cache hits, cost.

```text
coding.sh workflows stats <RUN>
```

| Argument | Required | Description |
|---|---|---|
| `run` | yes | Workflow run id. |

### `coding.sh workflows score`

Grade a run's output against a case's truth.

```text
coding.sh workflows score <RUN> [options]
```

| Argument | Required | Description |
|---|---|---|
| `run` | yes | Workflow run id. |

| Option | Default | Description |
|---|---|---|
| `--case <ID>` |  | Case id (default: the run's case) |
| `--cases <DIR>` |  | Cases directory (default: evals/workflows/&lt;workflow&gt;/cases) |
| `--slack <LINES>` | `5` | Line distance that still matches a seeded bug. |

### `coding.sh workflows run`

A/B workflow variants over cases; prints the experiment id.

```text
coding.sh workflows run <WORKFLOW> [options]
```

| Argument | Required | Description |
|---|---|---|
| `workflow` | yes | Workflow name (cases live under evals/workflows/&lt;workflow&gt;/cases) |

| Option | Default | Description |
|---|---|---|
| `--variant <NAME=SCRIPT|JSON>` |  | Variant: name=script path (claude), name=command (command), or JSON (repeatable) |
| `--cases <DIR>` |  | Cases directory (default: evals/workflows/&lt;workflow&gt;/cases) |
| `-k, --k <N>` | `3` | Attempts per case and variant. |
| `--split <SPLIT>` |  | Only cases in this split. One of: `dev`, `heldout`. |
| `--driver <DRIVER>` | `claude` | How a variant runs. One of: `claude`, `command`. |
| `-j, --concurrency <N>` | `1` | Jobs at once (a workflow already fans out) |
| `--resume [<ID>]` |  | Continue an interrupted workflow experiment: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `--bin <PATH>` |  | claude binary for the claude-code-workflow driver (default: claude on PATH) |
| `-y, --yes` |  | Run without asking when the estimated cost is above the confirm threshold. |

```sh
coding.sh workflows run coding-sh-improve -v base=wf/improve.js -v cand=wf/improve-v2.js -k 3 --split dev
coding.sh workflows run coding-sh-improve -v base=wf/improve.js -v cand=wf/improve-v2.js -k 3 --resume
```

### `coding.sh workflows compare`

Paired comparison of two variants of an experiment.

```text
coding.sh workflows compare <EXPERIMENT> [options]
```

| Argument | Required | Description |
|---|---|---|
| `experiment` | yes | Experiment id. |

| Option | Default | Description |
|---|---|---|
| `--baseline <VARIANT>` |  | Baseline variant (required) |
| `--candidate <VARIANT>` |  | Candidate variant (required) |
| `--threshold <SCORE>` |  | Score that counts as a pass (default: the case's, else 0.5) |
| `--seed <N>` |  | Bootstrap seed for the intervals and P(front) |
| `--select <RULE>` |  | Pick a variant to deploy: cheapest above a quality floor, best quality − λ·cost, or the front's extremes. One of: `min-cost`, `weighted`, `pareto`. |
| `--q-min <SCORE>` |  | min-cost: quality lower bound to reach. |
| `--q-drop <PP>` |  | min-cost: quality points below the baseline's mean allowed (default 10) |
| `--lambda <λ>` |  | weighted: quality given up per USD (per second when no run records cost) |

```sh
coding.sh workflows compare wfx_01 --baseline base --candidate cand --select min-cost --q-drop 10
coding.sh workflows compare wfx_01 --baseline base --candidate cand --select pareto --json
```

### `coding.sh workflows replay`

Re-run an edited script from a run's journal (cached prefix).

```text
coding.sh workflows replay <RUN> [options]
```

| Argument | Required | Description |
|---|---|---|
| `run` | yes | Base workflow run id. |

| Option | Default | Description |
|---|---|---|
| `--script <PATH>` |  | Edited workflow script (required) |
| `--base-script <PATH>` |  | Script the base run used, when it was not captured. |
| `--args <JSON>` |  | Workflow args (JSON or a .json path) |
| `--dry-run` |  | Print the predicted cache hits without running. |
| `--bin <PATH>` |  | claude binary for the claude-code-workflow driver (default: claude on PATH) |
| `-y, --yes` |  | Run without asking when the estimated cost is above the confirm threshold. |

## `coding.sh bench`

Dynamic benchmarks: fresh cases every run, same set for every contender. Aliases: `benchmark`.

```text
coding.sh bench <action>
```

| Action | What it does |
|---|---|
| [`new`](#codingsh-bench-new) | Write a benchmark definition (bench/&lt;name&gt;.toml) |
| [`run`](#codingsh-bench-run) | Sample fresh cases, freeze them, run every contender and grade |
| [`regrade`](#codingsh-bench-regrade) | Re-score stored outputs with the current graders (no contender calls) |
| [`list`](#codingsh-bench-list) | Benchmarks with their last run and leader |
| [`show`](#codingsh-bench-show) | Leaderboard, head-to-head and failures for one run (checks a secret seed's commitment) |
| [`history`](#codingsh-bench-history) | One metric per contender over time |
| [`report`](#codingsh-bench-report) | Write a self-contained HTML report plus report.json |
| [`schedule`](#codingsh-bench-schedule) | Print a daily cron line and a GitHub Actions workflow (installing needs budget_usd) |

- Definitions live in ./bench/&lt;name&gt;.toml (searched upward from the current directory) or ~/.coding.sh/benchmarks/&lt;name&gt;.toml.
- Each run is stored in ~/.coding.sh/benchmarks/&lt;name&gt;/runs/, its sample as dataset bench-&lt;name&gt;, and one experiment per contender.
- History counts the first complete plain `bench run` per date. --seed, --cases, --date and same-day reruns are adhoc.
- Guide: docs/guides/benchmarks.md

### `coding.sh bench new`

Write a benchmark definition (bench/<name>.toml).

```text
coding.sh bench new <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name (lowercase, digits, . _ -) |

| Option | Default | Description |
|---|---|---|
| `--source <KIND>` | `command` | Where fresh cases come from. One of: `command`, `sessions`, `github`, `urls`, `dataset`. |
| `--command <CMD>` |  | command source: prints JSONL cases (gets CODING_SH_BENCH_SEED and _DATE) |
| `--repo <OWNER/NAME>` |  | github source: repository. |
| `--sitemap <URL>` |  | urls source: sitemap URL (repeatable) |
| `--dataset <NAME>` |  | dataset source: dataset to sample from. |
| `-c, --contender <NAME=CMD|URL|agent:ID[:MODEL]>` |  | A contender (repeatable, at least two) |
| `-g, --grader <JSON>` |  | Grader spec, e.g. {"kind":"exact"} (repeatable) |
| `-n, --cases <N>` | `50` | Cases per run. |
| `--global` |  | Write to ~/.coding.sh/benchmarks instead of ./bench. |
| `--force` |  | Overwrite an existing definition. |

```sh
coding.sh bench new answers --command 'node gen.mjs' -c fast='node fast.mjs' -c big='node big.mjs' -g '{"kind":"exact"}'
coding.sh bench new triage --source github --repo owner/name -c claude=agent:claude-code -c codex=agent:codex
coding.sh bench new fetchers --source urls --sitemap https://example.com/sitemap.xml -c a=https://a.example/v1 -c b=https://b.example/v1
```

### `coding.sh bench run`

Sample fresh cases, freeze them, run every contender and grade.

```text
coding.sh bench run <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `--date <YYYY-MM-DD>` |  | Sample as if on this UTC date (adhoc: kept out of history) |
| `--seed <SEED>` |  | Fixed seed instead of the definition's (adhoc) |
| `-n, --cases <N>` |  | Cases this run (adhoc; default: the definition's) |
| `--adhoc` |  | Keep this run out of history and the freshness ledger. |
| `--concurrency <N>` |  | Parallel calls (default: the definition's) |
| `--dry-run` |  | Sample and print the cases, the detectable gap and the cost estimate; run nothing. |
| `--resume [<RUN>]` |  | Continue an incomplete run (budget stop, Ctrl-C, crash): same seed and cases, finished calls kept. RUN: id or YYYY-MM-DD (default: the latest) |
| `--run <RUN>` |  | With --resume: which incomplete run, by id or YYYY-MM-DD (default: the latest) |

```sh
coding.sh bench run answers
coding.sh bench run answers --dry-run
coding.sh bench run answers --seed try-1 --cases 10
coding.sh bench run answers --resume
```

### `coding.sh bench regrade`

Re-score stored outputs with the current graders (no contender calls).

```text
coding.sh bench regrade <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `--run <RUN>` |  | A specific run: id or YYYY-MM-DD (default: latest) |
| `--all` |  | Regrade every counted run. |

```sh
coding.sh bench regrade answers
coding.sh bench regrade answers --all
```

### `coding.sh bench list`

Benchmarks with their last run and leader.

```text
coding.sh bench list
```

### `coding.sh bench show`

Leaderboard, head-to-head and failures for one run (checks a secret seed's commitment).

```text
coding.sh bench show <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `--run <RUN>` |  | A specific run: id or YYYY-MM-DD (default: latest) |
| `--cases` |  | Also list the frozen cases. |

### `coding.sh bench history`

One metric per contender over time.

```text
coding.sh bench history <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `-m, --metric <METRIC>` | `pass` | Metric. One of: `pass`, `score`, `latency`, `p95`, `cost`, `tokens`, `tokens-in`, `tokens-out`, `errors`. |
| `-n, --limit <N>` | `30` | Most recent runs. |
| `--vs <CONTENDER>` |  | Show each contender's paired pass-rate gap to this one, plus the gap pooled over the window. |
| `--anchor` |  | Numbers from the anchor set only (the same cases every day) |

```sh
coding.sh bench history answers
coding.sh bench history answers --metric latency --json
coding.sh bench history answers --vs baseline
coding.sh bench history answers --anchor
```

### `coding.sh bench report`

Write a self-contained HTML report plus report.json.

```text
coding.sh bench report <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `-o, --out <DIR>` |  | Output directory (default: ~/.coding.sh/benchmarks/&lt;name&gt;/report) |
| `--days <N>` | `90` | Days of history to include. |
| `--viewer-url <URL>` | `http://127.0.0.1:4319` | Viewer base URL for session links. |
| `--reference <CONTENDER>` |  | Contender for the gap chart (default: the definition's reference) |
| `--include-private` |  | Show case contents, outputs and session links of a private benchmark (local copies only) |

```sh
coding.sh bench report answers --out ./public/bench
```

### `coding.sh bench schedule`

Print a daily cron line and a GitHub Actions workflow (installing needs budget_usd).

```text
coding.sh bench schedule <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Benchmark name, or a path to its .toml. |

| Option | Default | Description |
|---|---|---|
| `--at <HH:MM>` | `06:15` | Time of day (cron: local; Actions: UTC) |
| `--runner <LABELS>` | `self-hosted` | Actions runs-on label(s), comma-separated. |
| `--report-dir <DIR>` |  | Also write the report here after each run. |
| `--install-cron` |  | Add the line to your crontab (replaces this benchmark's earlier line only) |
| `--workflow-out <FILE>` |  | Write the workflow to this file, e.g. .github/workflows/bench-&lt;name&gt;.yml. |
| `-y, --yes` |  | Don't ask before editing the crontab. |

```sh
coding.sh bench schedule answers
coding.sh bench schedule answers --install-cron --yes
coding.sh bench schedule answers --workflow-out .github/workflows/bench-answers.yml
```

## `coding.sh harness`

Snapshot and list agent harness bundles.

```text
coding.sh harness <action>
```

| Action | What it does |
|---|---|
| [`snapshot`](#codingsh-harness-snapshot) | Snapshot an agent's harness files into a bundle |
| [`list`](#codingsh-harness-list) | List harness bundles |

### `coding.sh harness snapshot`

Snapshot an agent's harness files into a bundle.

```text
coding.sh harness snapshot [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Agent id (required) |
| `--name <NAME>` |  | Bundle name (default: agent and date) |
| `--dir <DIR>` |  | Project directory (default: current directory) |
| `--file <TOML>` |  | Build the bundle from a harness TOML instead. |
| `--model <MODEL>` |  | Model to record. |

### `coding.sh harness list`

List harness bundles.

```text
coding.sh harness list
```

## `coding.sh compare`

A/B two harness bundles on eval tasks.

```text
coding.sh compare <A> [b] [options]
```

| Argument | Required | Description |
|---|---|---|
| `a` | yes | Baseline bundle id or name. |
| `b` | no | Candidate bundle id or name (omit with --without) |

| Option | Default | Description |
|---|---|---|
| `-t, --task <ID>` |  | Task id (repeatable; default: all validated tasks) |
| `--tag <TAG>` |  | Run every non-archived task with this tag, drafts included (e.g. the tag given to eval import) |
| `--k <N>` | `1` | Attempts per task and arm. |
| `-c, --concurrency <N>` |  | Parallel runs. |
| `--max-cost <USD>` |  | Spend cap: once finished runs (agent plus judge grade calls) reach it, no new run starts. |
| `--experiment <ID>` |  | Compare the stored runs of this experiment instead of running. |
| `--retry-errors` |  | With --experiment: run again the runs that errored or hit infrastructure errors, in place; the old runs are kept, marked superseded. |
| `--failing <EXP>[@BUNDLE]` |  | Run only the tasks A (or BUNDLE) failed in that stored comparison. |
| `--failing-mode <MODE>` | `any` | With --failing: a task counts as failed in any attempt, or in more than half. One of: `any`, `majority`. |
| `--sample <N>` |  | Run a random sample of N of the selected tasks. |
| `--seed <N>` |  | With --sample: seed for the draw (default random, printed in the report). With --false-alarm: seed for which runs get it (default 0) |
| `--repair <N>` |  | After a failed verifier, tell the agent and let it try again in its own session, up to N rounds (1-8); hidden tests stay out of its tree. |
| `--repair-signal <SIGNAL>` | `bit` | With --repair: say only that verification failed, or also name the failing tests (parsed from the verifier output). One of: `bit`, `names`. |
| `--false-alarm <P>` |  | With --repair: tell this share (0-1) of passing runs they failed, to measure what a wrong signal breaks. |
| `--repair-verdict` |  | Verdict, gates and pass rates on the pass after repair rounds instead of the first attempt. |
| `--reuse <ARMS>` | `none` | Copy finished runs of the same task, bundle, agent version, attempt and timeout from earlier comparisons instead of running them again. One of: `baseline`, `both`, `none`. |
| `--reuse-max-age <AGE>` | `7d` | With --reuse: only runs that finished this recently (30m, 12h, 7d, 2w) |
| `--dry-run` |  | Print how many runs each arm would reuse and run, and run nothing. |
| `--without <PATH>` |  | Ablation: B is A without this file, dir or glob (repeatable) |
| `--gateway [<NAME>]` |  | Route both arms through a gateway. Without a name: [gateway] default, else the one with a key, else vercel. One of: `vercel`, `openrouter`, `litellm`, `ramp`. |
| `--gate` |  | Ship-or-hold decision: exit 0 when B wins enough without breaking what A solved, 1 otherwise. |
| `--lambda <N>` | `2` | With --gate: what breaking one solved item costs, in fixed items. |
| `--gate-alpha <A>` | `0.05` | With --gate: one-sided significance level. |
| `--tau <T>` | `0.10` | With --gate: largest share of solved items B may break. |
| `--by <PREFIX>` |  | With --gate: also gate each task group (first tag with this prefix, e.g. suite:); any group's don't-ship blocks. |
| `--promote` |  | Pareto promotion gate: exit 0 when B is credibly better on quality or cheaper (cost, else tokens), 1 otherwise. |
| `--gamma <G>` | `0.7` | With --promote: support needed to promote. |
| `--eps-q <Q>` | `0.1` | With --promote: pass rate a cheaper B may give up. |
| `--eps-c <C|inf>` | `inf` | With --promote: relative cost rise a better B may take (0.2 = +20%) |
| `--draws <N>` | `10000` | With --promote: bootstrap draws. |
| `--item-gate` |  | One-item gate (shown automatically when B adds or removes one rule, skill or context file): exit 0 on KEEP or ACCEPT, 1 otherwise; --no-item-gate hides it. |
| `--audited` |  | Count passes a witness refuted (eval audit) as fails in the verdict; needs every pass in both arms audited. |
| `--resume [<ID>]` |  | Continue an interrupted comparison: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff (failures are never retried) |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. |

```sh
coding.sh compare base candidate --k 3
coding.sh compare base candidate --k 3 --resume
coding.sh compare base candidate2 --k 3 --reuse baseline --dry-run
coding.sh compare base candidate --experiment exp_01
coding.sh compare base candidate --experiment exp_01 --audited
coding.sh compare base candidate --experiment exp_01 --retry-errors
coding.sh compare base candidate2 --failing exp_01 --k 3
coding.sh compare base candidate --sample 20 --seed 7
coding.sh compare base candidate --k 3 --repair 2 --repair-signal names
coding.sh compare base candidate --k 3 --gate
coding.sh compare base candidate --k 3 --gate --by suite:
coding.sh compare no-skill with-skill --tag skill-eval --gate --by suite: --max-cost 15
coding.sh compare base candidate --k 3 --promote
coding.sh compare base --without .claude/rules/clock.md --k 3 --item-gate
coding.sh compare sonnet gpt5 --gateway
coding.sh compare sonnet gpt5 --gateway openrouter
```

## `coding.sh refine`

Improve CLAUDE.md, AGENTS.md and skills in tested rounds, and protect their safety rules.

```text
coding.sh refine <action>
```

| Action | What it does |
|---|---|
| [`propose`](#codingsh-refine-propose) | Ask a model for lines that address your sessions' most severe flags; stores them as a candidate |
| [`test`](#codingsh-refine-test) | Test candidate edits against your current files; keep, reject or inconclusive per candidate, exit 0 when one is kept |
| [`apply`](#codingsh-refine-apply) | Write a kept candidate to your files, backing up what it replaces (never commits) |
| [`rollback`](#codingsh-refine-rollback) | Put back what an apply replaced, from its backup |
| [`log`](#codingsh-refine-log) | Every round in this repo: verdict, effect CI, guard result, cost and reason, and whether the loop plateaued |
| [`run`](#codingsh-refine-run) | Loop: propose (or take --candidate), test, apply when kept; stop at --rounds, --max-cost or a plateau |
| [`protected`](#codingsh-refine-protected) | List the harness lines an edit may not delete, reword or relax |
| [`check`](#codingsh-refine-check) | Check a harness edit for deleted, reworded or relaxed protected lines; exit 1 when it has any |
| [`score`](#codingsh-refine-score) | Score diagnoses against human labels: occurrence, Signal and session precision and recall, coverage, repeat agreement |

- A protected line is inside a &lt;!-- coding.sh:protect --&gt; … &lt;!-- coding.sh:protect end --&gt; block, matches a [refine] protect regex, or pairs a gate word (never, don't, must not, only, before, ask, confirm, verify, check, require) with a safety topic (credentials, secrets, access tokens, private keys, .env, prod, deploy, push, --force, force-push, destructive, --no-verify, rm -rf, delete, drop table, reset --hard, migrations, permissions, sudo, chmod, payments, PII, another user, owner, dry-run, backups). Set [refine] autoProtect = false in your user config to keep only markers and patterns.
- check rejects an edit that deletes or rewords a protected line (protected-line), or adds a line that waives one (skip, no need, only … when, unless, without asking, already verified …) and shares a backticked token, a word or a safety topic with it (relaxes-protected).
- exp ab runs the same check on its arms and warns; with --gate a protected-line problem fails the run.
- test decides each candidate in stages: the protected-line check, the harmless and duplicate critics on the added lines, an A/B against your current files on the decision points exp ab mines (the acceptance gate: ship goes on, hold is inconclusive, don't ship rejects), then the guard set: the decision points earlier kept edits won must not go from solved to unsolved. A run stopped at --max-cost is inconclusive.
- The ledger and every tested candidate's files live under the data dir (refine/&lt;repo&gt;-&lt;hash&gt;/). Rejected candidates and their reasons go into the next proposal prompt; protected lines go in as READ-ONLY.
- score matches by code, never a model: a prediction matches a label in the same session with the same component (type, and name compared after Unicode, case, camelCase and separator normalization) whose top-3 type ids share one id, under a maximum one-to-one matching. Unmatched items count against precision or recall; a rate with nothing to divide by prints —. Without --pred, each diagnosed session flag is a prediction with no component, so it matches on session and type ids alone, and per-flag precision is reported. score writes nothing.

### `coding.sh refine propose`

Ask a model for lines that address your sessions' most severe flags; stores them as a candidate.

```text
coding.sh refine propose [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent. Repeatable. |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` | `anthropic` | API that proposes, answers the next turn and judges it. One of: `anthropic`, `openai`, `openai-compatible`. |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--proposer-model <MODEL>` |  | Model that writes the edit (default: --judge-model, else --model, else claude-sonnet-5-5 or gpt-6-sol) |
| `--target <PATH>` |  | Harness file the proposal extends (default: AGENTS.md, else CLAUDE.md, else GEMINI.md) |
| `--dry-run` |  | Print the findings and the prompt; make no model call. |

```sh
coding.sh refine propose
coding.sh refine propose --target CLAUDE.md --dry-run
```

### `coding.sh refine test`

Test candidate edits against your current files; keep, reject or inconclusive per candidate, exit 0 when one is kept.

```text
coding.sh refine test <CANDIDATE>... [options]
```

| Argument | Required | Description |
|---|---|---|
| `candidate` | yes | Edited file, directory, git:REV, harness bundle or stored r_… id; a file replaces the harness file at its repo path, else the one with its name (./drafts/AGENTS.md replaces AGENTS.md) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent. Repeatable. |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` | `anthropic` | API that proposes, answers the next turn and judges it. One of: `anthropic`, `openai`, `openai-compatible`. |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--judge-model <MODEL>` |  | Model for the judge (default: --model) |
| `-n, --limit <N>` | `40` | Maximum decision points. |
| `--model <MODEL>` |  | Model for the next turn (default: the one the decision points were recorded with, else claude-sonnet-5-5 or gpt-6-sol) |
| `--trials <N>` | `1` | Next turns per case and arm. |
| `-c, --concurrency <N>` | `4` | Parallel model calls. |
| `--max-cost <USD>` |  | Refuse to start when the estimate is over this, and stop once the spend passes it. |
| `--max-guard <N>` | `24` | Most tasks in the guard set (the tasks earlier kept edits won), newest kept edits first. |
| `--cache` | `true` | Reuse stored model responses (--no-cache to ask the model again) |
| `--lambda <N>` | `2` | Acceptance gate: what breaking one solved decision point costs, in fixed ones. |
| `--gate-alpha <A>` | `0.05` | Acceptance gate: one-sided significance level. |
| `--tau <T>` | `0.10` | Acceptance gate: largest share of solved decision points B may break. |
| `--allow-protected-edit <PATH:LINE>` |  | Allow the edit to delete, reword or relax this protected line (repeatable; never implied by --force) |
| `--dry-run` |  | Show the checks, decision points, guard set size and cost estimate; make no model calls. |

```sh
coding.sh refine test ./drafts/AGENTS.md
coding.sh refine test r_3f9a1c02e1 --behavior unverified-claim --max-cost 2
coding.sh refine test ./a/CLAUDE.md ./b/CLAUDE.md --dry-run --json
```

### `coding.sh refine apply`

Write a kept candidate to your files, backing up what it replaces (never commits).

```text
coding.sh refine apply [candidate] [options]
```

| Argument | Required | Description |
|---|---|---|
| `candidate` | no | Candidate id (default: the latest kept candidate not yet applied) |

| Option | Default | Description |
|---|---|---|
| `--force` |  | Apply a candidate that was not kept, or whose files changed since its test (recorded in the ledger) |

```sh
coding.sh refine apply
coding.sh refine apply r_3f9a1c02e1
```

### `coding.sh refine rollback`

Put back what an apply replaced, from its backup.

```text
coding.sh refine rollback [candidate] [options]
```

| Argument | Required | Description |
|---|---|---|
| `candidate` | no | Candidate or apply id (default: the latest apply) |

| Option | Default | Description |
|---|---|---|
| `--force` |  | Roll back though the file changed since the apply (those changes are lost) |

```sh
coding.sh refine rollback
coding.sh refine rollback r_3f9a1c02e1
```

### `coding.sh refine log`

Every round in this repo: verdict, effect CI, guard result, cost and reason, and whether the loop plateaued.

```text
coding.sh refine log
```

```sh
coding.sh refine log
coding.sh refine log --json
```

### `coding.sh refine run`

Loop: propose (or take --candidate), test, apply when kept; stop at --rounds, --max-cost or a plateau.

```text
coding.sh refine run [options]
```

| Option | Default | Description |
|---|---|---|
| `--rounds <N>` | `3` | Most rounds. |
| `--candidate <FILE|r_…>` |  | Test these in order instead of asking the proposer (repeatable) |
| `--proposer-model <MODEL>` |  | Model that writes the edit (default: --judge-model, else --model, else claude-sonnet-5-5 or gpt-6-sol) |
| `--target <PATH>` |  | Harness file the proposal extends (default: AGENTS.md, else CLAUDE.md, else GEMINI.md) |
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent. Repeatable. |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` | `anthropic` | API that proposes, answers the next turn and judges it. One of: `anthropic`, `openai`, `openai-compatible`. |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--judge-model <MODEL>` |  | Model for the judge (default: --model) |
| `-n, --limit <N>` | `40` | Maximum decision points. |
| `--model <MODEL>` |  | Model for the next turn (default: the one the decision points were recorded with, else claude-sonnet-5-5 or gpt-6-sol) |
| `--trials <N>` | `1` | Next turns per case and arm. |
| `-c, --concurrency <N>` | `4` | Parallel model calls. |
| `--max-cost <USD>` |  | Refuse to start when the estimate is over this, and stop once the spend passes it. |
| `--max-guard <N>` | `24` | Most tasks in the guard set (the tasks earlier kept edits won), newest kept edits first. |
| `--cache` | `true` | Reuse stored model responses (--no-cache to ask the model again) |
| `--lambda <N>` | `2` | Acceptance gate: what breaking one solved decision point costs, in fixed ones. |
| `--gate-alpha <A>` | `0.05` | Acceptance gate: one-sided significance level. |
| `--tau <T>` | `0.10` | Acceptance gate: largest share of solved decision points B may break. |
| `--allow-protected-edit <PATH:LINE>` |  | Allow the edit to delete, reword or relax this protected line (repeatable; never implied by --force) |
| `--dry-run` |  | Show the findings, decision points, guard set size and per-round estimate; make no model calls. |

```sh
coding.sh refine run --rounds 5 --max-cost 10
coding.sh refine run --candidate ./v1/AGENTS.md --candidate ./v2/AGENTS.md
coding.sh refine run --dry-run
```

### `coding.sh refine protected`

List the harness lines an edit may not delete, reword or relax.

```text
coding.sh refine protected [options]
```

| Option | Default | Description |
|---|---|---|
| `--a <FILE|DIR|git:REV|BUNDLE>` |  | Harness to read (default: the repo's current CLAUDE.md, AGENTS.md, GEMINI.md, rules and skills) |

```sh
coding.sh refine protected
coding.sh refine protected --a git:main --json
```

### `coding.sh refine check`

Check a harness edit for deleted, reworded or relaxed protected lines; exit 1 when it has any.

```text
coding.sh refine check [options]
```

| Option | Default | Description |
|---|---|---|
| `--a <FILE|DIR|git:REV|BUNDLE|none>` |  | Before (default: git HEAD when B is omitted, else the repo's current files) |
| `--b <FILE|DIR|git:REV|BUNDLE|none>` |  | After; a file replaces the file of the same path in A (default: your uncommitted edits) |
| `--allow-protected-edit <PATH:LINE>` |  | Allow the edit to delete, reword or relax this protected line (repeatable; never implied by --force) |

```sh
coding.sh refine check
coding.sh refine check --b ./drafts/AGENTS.md
coding.sh refine check --a git:main --b . --json
coding.sh refine check --allow-protected-edit AGENTS.md:12
```

### `coding.sh refine score`

Score diagnoses against human labels: occurrence, Signal and session precision and recall, coverage, repeat agreement.

```text
coding.sh refine score <LABELS> [options]
```

| Argument | Required | Description |
|---|---|---|
| `labels` | yes | Labels JSONL: one occurrence per line, {sessionId, signalId, component: {type, name}, typeIds: [1-3 ids], nature?}; a line with only sessionId marks a session with nothing found. |

| Option | Default | Description |
|---|---|---|
| `--pred <FILE>` |  | Predictions in the labels format (repeatable; 2 or more adds repeat agreement). Default: the labelled sessions' flags from the store. |

```sh
coding.sh refine score labels.jsonl --pred diagnoses.jsonl
coding.sh refine score labels.jsonl --pred run1.jsonl --pred run2.jsonl --pred run3.jsonl --json
coding.sh refine score labels.jsonl
```

## `coding.sh gateway`

LLM gateways: detect routing, enrich sessions with billed cost.

```text
coding.sh gateway <action>
```

| Action | What it does |
|---|---|
| [`status`](#codingsh-gateway-status) | Show which agents route through a gateway, key sources and tagged sessions |
| [`enrich`](#codingsh-gateway-enrich) | Attach billed cost and serving provider to llm calls with a gateway request id |

- Keys come from each gateway's standard env var (AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, LITELLM_PROXY_API_KEY, CLOUDFLARE_API_TOKEN, PORTKEY_API_KEY, HELICONE_API_KEY) or [gateway] / [gateway.&lt;name&gt;] apiKeyEnv / apiKey in config.toml, and are never printed or stored.
- Lookups use each gateway's per-request API (Vercel and OpenRouter /generation, LiteLLM /spend/logs, Cloudflare logs, Portkey logs, Helicone /v1/request); results are cached in the index, so re-runs make no calls.

### `coding.sh gateway status`

Show which agents route through a gateway, key sources and tagged sessions.

```text
coding.sh gateway status [options]
```

| Option | Default | Description |
|---|---|---|
| `--gateway <NAME>` |  | Only this gateway. One of: `vercel`, `openrouter`, `litellm`, `cloudflare`, `portkey`, `helicone`, `requesty`, `ramp`, `truefoundry`, `kong`, `bifrost`, `martian`. |
| `--credits` |  | Also fetch the credit balance (Vercel, OpenRouter; needs the key) |

```sh
coding.sh gateway status
coding.sh gateway status --gateway openrouter --credits
```

### `coding.sh gateway enrich`

Attach billed cost and serving provider to llm calls with a gateway request id.

```text
coding.sh gateway enrich [options]
```

| Option | Default | Description |
|---|---|---|
| `--gateway <NAME>` |  | Only this gateway. One of: `vercel`, `openrouter`, `litellm`, `cloudflare`, `portkey`, `helicone`, `requesty`, `ramp`, `truefoundry`, `kong`, `bifrost`, `martian`. |
| `-s, --session <ID>` |  | Only this session (repeatable; or latest) |
| `--since <WHEN>` | `30d` | Sessions after this time: 7d, 12h, 30m or a date. |
| `-n, --limit <N>` | `500` | Maximum rows. |
| `--offline` |  | Use only the cache and drained traces; no API calls. |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh gateway enrich
coding.sh gateway enrich --session latest --dry-run
coding.sh gateway enrich --gateway openrouter
```

## `coding.sh gc`

Delete expired spool files, blobs and judge cache.

```text
coding.sh gc [options]
```

| Option | Default | Description |
|---|---|---|
| `--compact` |  | Also compact the index (VACUUM) |
| `--dry-run` |  | Show the exact changes without writing anything. |

## `coding.sh purge`

Remove a leaked secret from the store: events, search, blobs, spool, eval runs.

```text
coding.sh purge [options]
```

| Option | Default | Description |
|---|---|---|
| `--literal <FILE|->` |  | File with the values to remove, one per line (- reads stdin); never pass them as arguments. |
| `--rule <REGEX>` |  | Also remove every match of this regular expression (repeatable); describe the secret's shape, not the secret. |
| `--dry-run` |  | Count the copies without changing anything. |

```sh
coding.sh purge --literal leaked.txt --dry-run
pbpaste | coding.sh purge --literal -
coding.sh purge --rule 'sk-ant-api03-[A-Za-z0-9_-]{80,}' --dry-run
```

- Every copy becomes [redacted:purged]: event payloads (the full-text index is updated), session titles and stats, labels, eval docs and settings. Blobs holding a value are rewritten under their new hash and every reference follows. Spool, judge-cache and eval run files (~/.coding.sh/runs) keep their length (the value becomes asterisks) so ingest offsets stay valid. A run's .git directory and files over 64 MB are left alone.
- --rule takes a JavaScript regular expression. Each distinct match of 8 or more characters is purged like a --literal value; shorter matches are left alone, and a rule that matches over 10,000 distinct values is refused.
- Then the search index is merged and the database VACUUMed, so the old bytes leave the file. Values shorter than 8 characters are refused. Only the SQLite store is supported.
- Rotate the secret as well: copies in the agent's own transcripts, shell history or git are not touched.

## `coding.sh config`

Read and write ~/.coding.sh/config.toml.

```text
coding.sh config <action>
```

| Action | What it does |
|---|---|
| [`get`](#codingsh-config-get) | Print the effective config or one key |
| [`set`](#codingsh-config-set) | Set one key |
| [`path`](#codingsh-config-path) | Print the config file path |

### `coding.sh config get`

Print the effective config or one key.

```text
coding.sh config get [key]
```

| Argument | Required | Description |
|---|---|---|
| `key` | no | Dotted key, e.g. capture.mode. |

### `coding.sh config set`

Set one key.

```text
coding.sh config set <KEY> <VALUE> [options]
```

| Argument | Required | Description |
|---|---|---|
| `key` | yes | Dotted key, e.g. capture.mode. |
| `value` | yes | Value (numbers, true/false and JSON arrays are parsed) |

| Option | Default | Description |
|---|---|---|
| `--dry-run` |  | Show the exact changes without writing anything. |

### `coding.sh config path`

Print the config file path.

```text
coding.sh config path
```

## `coding.sh update`

Install the latest coding.sh release.

```text
coding.sh update [options]
```

| Option | Default | Description |
|---|---|---|
| `--check` |  | Only report whether an update is available. |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh update
coding.sh update --check
```

- Other commands print one line when a newer release is out (checked at most daily, in the background).
- Turn that off with NO_UPDATE_NOTIFIER=1, CODING_SH_NO_UPDATE_CHECK=1 or `[update] check = false` in ~/.coding.sh/config.toml.

## `coding.sh version`

Print the version.

```text
coding.sh version
```
