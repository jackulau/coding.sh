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
  `{"status":"error","reason":"<reason>","message":"<text>","next":["<what to do>:","<command>"]}`.
  `next` holds up to two lines: the step, then the command to run. The reasons are listed in [Troubleshooting](../troubleshooting.md).
  When that step deletes or overwrites data, cannot be undone, or spends money, the error also has `askUser: true`
  and the text says the user must approve it first. An agent that reads such an error asks the user instead of running the step.
- Exit codes: `0` success, `1` error, `2` usage error (unknown option, bad value, missing `--yes`), `130` canceled.
- Commands that change agent config or start paid runs ask first. In scripts and CI, pass `--yes`; an agent passes it only once the user approves.

## Commands

| Command | Group | What it does |
|---|---|---|
| [`init`](#codingsh-init) | Capture | Set up capture hooks and the MCP server for every detected agent |
| [`doctor`](#codingsh-doctor) | Capture | Check agents, hooks, spool, store and the OTLP port |
| [`status`](#codingsh-status) | Capture | Show capture totals and the latest session |
| [`statusline`](#codingsh-statusline) | Capture | Print a Claude Code status line (model, cost, worst flag), or install it |
| [`ingest`](#codingsh-ingest) | Capture | Move captured hook events from the spool into the index |
| [`run`](#codingsh-run) | Capture | Run any agent command and capture the session |
| [`collector`](#codingsh-collector) | Capture | Start a local OTLP/HTTP receiver for agents that export traces |
| [`proxy`](#codingsh-proxy) | Capture | Run a local Anthropic/OpenAI API proxy that logs every model call |
| [`serve`](#codingsh-serve) | Capture | Production server: OTLP + native ingest, viewer, health and metrics on one port |
| [`uninstall`](#codingsh-uninstall) | Capture | Remove coding.sh hooks and MCP entries from every agent |
| [`sessions`](#codingsh-sessions) | Explore | List captured sessions |
| [`show`](#codingsh-show) | Explore | Show a session timeline with subagents and latency |
| [`tree`](#codingsh-tree) | Explore | Show a whole multi-agent run as one tree, with rolled-up totals |
| [`replay`](#codingsh-replay) | Explore | Step through a session and see what it did to each file it touched |
| [`attribution`](#codingsh-attribution) | Explore | Which agent session wrote the lines each commit added; export them as Agent Trace |
| [`blame`](#codingsh-blame) | Explore | git blame with the agent session that wrote each line |
| [`diff-calls`](#codingsh-diff-calls) | Explore | Show what changed between two model calls, and why the second missed the prompt cache |
| [`search`](#codingsh-search) | Explore | Full-text search over prompts, replies and tool calls |
| [`usage`](#codingsh-usage) | Explore | Tokens, cost, turns and cache hits by agent, model or day |
| [`cache`](#codingsh-cache) | Explore | Score prompt-cache health and name what breaks the cached prefix |
| [`stats`](#codingsh-stats) | Explore | Sessions, failures, cost, tokens and latency per day or week, split by agent, model, repo or flag |
| [`sql`](#codingsh-sql) | Explore | Run one read-only SQL query against the SQLite index |
| [`export`](#codingsh-export) | Explore | Stream sessions, events or labels as JSONL or CSV, or write raw traces to a directory |
| [`ui`](#codingsh-ui) | Explore | Open the local session viewer |
| [`mcp`](#codingsh-mcp) | Explore | Serve captured sessions to agents over MCP (stdio) |
| [`eval`](#codingsh-eval) | Evaluate | Build eval suites from sessions, skills or cases, and run them |
| [`dataset`](#codingsh-dataset) | Evaluate | Manage versioned datasets of cases |
| [`exp`](#codingsh-exp) | Evaluate | Run a task over a dataset, compare experiments and sweep configs |
| [`score`](#codingsh-score) | Evaluate | Add and list typed scores on sessions, events, cases and runs |
| [`judge`](#codingsh-judge) | Evaluate | Grade one output or the slop in captured diffs, or check an LLM judge or a test verifier against human labels |
| [`toolevals`](#codingsh-toolevals) | Evaluate | Measure how well agents use a CLI, MCP server or API |
| [`workflows`](#codingsh-workflows) | Evaluate | Capture, measure and A/B-test multi-agent workflow runs |
| [`bench`](#codingsh-bench) | Evaluate | Dynamic benchmarks: fresh cases every run, same set for every contender |
| [`improve`](#codingsh-improve) | Harness | What to fix first in your sessions, the line that fixes it, and whether your last AGENTS.md changes helped |
| [`harness`](#codingsh-harness) | Harness | Snapshot and list agent harness bundles; audit which memory and instruction files agents use |
| [`compare`](#codingsh-compare) | Harness | A/B two harness bundles on eval tasks |
| [`refine`](#codingsh-refine) | Harness | Improve AGENTS.md and skills in tested rounds, and protect their safety rules |
| [`gateway`](#codingsh-gateway) | Maintain | LLM gateways: detect routing, enrich sessions with billed cost |
| [`gc`](#codingsh-gc) | Maintain | Delete expired spool files, blobs and judge cache |
| [`purge`](#codingsh-purge) | Maintain | Remove a leaked secret from the store: events, search, blobs, spool, eval runs |
| [`config`](#codingsh-config) | Maintain | Read and write ~/.coding.sh/config.toml |
| [`update`](#codingsh-update) | Maintain | Install the latest coding.sh release |
| [`upgrade-store`](#codingsh-upgrade-store) | Maintain | Migrate the store for this install, or put back the index from before a migration |
| [`version`](#codingsh-version) | Maintain | Print the version |

## `coding.sh init`

Set up capture hooks and the MCP server for every detected agent.

```text
coding.sh init [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--scope <SCOPE>` | `user` | Install into user or project config. One of: `user`, `project`. |
| `--mcp` | `true` | Register the coding.sh MCP server too (--no-mcp to skip) |
| `--import` | `true` | Import each agent's past sessions so the viewer opens on your history (--no-import to skip) |
| `--proxy` |  | Also route Claude Code and Codex model calls through the local proxy, and start it. |
| `--force` |  | Install hooks even when the agent already has coding.sh hooks in the other scope; with --proxy, replace a base URL or provider you set instead of chaining through it. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |
| `--dry-run` |  | Print the plan (agents, files, blockers) without writing anything. |
| `--diff` |  | With --dry-run, also print the full diff of every planned edit. |
| `--remote <URL>` |  | Also send new sessions to a team's coding.sh serve at this URL (an http sink named team) |
| `--key <KEY>` |  | With --remote, the server's ingest key, csh_ik_… (also CODING_SH_INGEST_KEY) |
| `--remote-mode <MODE>` | `metadata` | With --remote: metadata sends no prompts, code or tool output; full sends them. |

```sh
coding.sh init
coding.sh init --agent claude-code --yes
coding.sh init --no-import
coding.sh init --proxy
coding.sh init --dry-run
coding.sh init --remote https://obs.example.com --key csh_ik_…
```

- Copies the hook to ~/.coding.sh/bin (hook.sh, and hook.mjs for what it hands on) and points each agent at it: /bin/sh hook.sh outside Windows, node hook.mjs on Windows. Run init again to move hooks from an older version to hook.sh.
- Then imports the sessions each agent already keeps on this machine, for up to 8 seconds (CODING_SH_INIT_IMPORT_BUDGET_MS changes it). The rest imports in the background and shows up in the viewer as it lands. Running init again reads only new or changed transcripts.
- --remote checks that the server takes the key before writing anything, then adds the sink to ~/.coding.sh/config.toml (mode 600). Run it again to change the URL, key or mode.
- Registers the MCP server with Claude Code, Codex, Cursor, OpenCode and Gemini CLI (user scope only).
- --proxy sets ANTHROPIC_BASE_URL in Claude Code's settings.json and a coding-sh model provider in Codex's config.toml. A base URL the agent already used (a gateway, CLIProxyAPI, your own Codex provider) becomes the proxy's upstream instead of being replaced. The hook restarts a stopped proxy when a session starts.
- Every edited file is backed up to ~/.coding.sh/backups first; uninstall reverts it.

## `coding.sh doctor`

Check agents, hooks, spool, store and the OTLP port.

```text
coding.sh doctor [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--port <PORT>` | `4318` | OTLP receiver port to check. |
| `--conformance` |  | Instead: read each agent's transcripts and check the events against coding.sh's invariants (read-only) |
| `--since <WHEN>` | `7d` | With --conformance, only transcripts after this time: 7d, 12h, 30m or a date (local time) |
| `--max-events <N>` | `200000` | With --conformance, stop each agent after this many events. |

```sh
coding.sh doctor
coding.sh doctor --json
coding.sh doctor --conformance
coding.sh doctor --conformance --agent codex --since 30d --json
```

- A row marked ! is a warning, and --json lists each one under warnings with the command that fixes it. An agent is one when no hook for this coding.sh home is in its config or something blocks the hook; the last line then reads N agents not capturing. The exit code and ok in --json are 1 and false only when the spool or the store fails.
- --conformance runs each agent's backfill over the transcripts on this machine and checks the events: ids, timestamps, tool and subagent pairing, parent links, usage and prompts. It only reads: blobs are hashed and dropped, SQLite sources are read from a copy, and the coding.sh store is not opened. Exits 1 when any agent has a violation.

## `coding.sh status`

Show capture totals and the latest session.

```text
coding.sh status [options]
```

| Option | Default | Description |
|---|---|---|
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

## `coding.sh statusline`

Print a Claude Code status line (model, cost, worst flag), or install it.

```text
coding.sh statusline [action]
```

| Action | What it does |
|---|---|
| [`install`](#codingsh-statusline-install) | Set coding.sh as Claude Code's status line in the user settings.json |
| [`uninstall`](#codingsh-statusline-uninstall) | Remove the coding.sh status line, restoring the previous one |

```sh
coding.sh statusline install
coding.sh statusline uninstall
```

- With no subcommand it reads the status-line JSON Claude Code sends on stdin and prints one line: model, this session's cost, today's cost, and the single worst flag. It exits 0 even on error, so it never disrupts the agent.
- install writes settings.statusLine and backs the file up; uninstall restores it byte-for-byte (the previous status line, if any, comes back).

### `coding.sh statusline install`

Set coding.sh as Claude Code's status line in the user settings.json.

```text
coding.sh statusline install [options]
```

| Option | Default | Description |
|---|---|---|
| `--force` |  | Replace an existing status line (restored on uninstall) |
| `--dry-run` |  | Show what would change, write nothing. |

```sh
coding.sh statusline install
coding.sh statusline install --force
```

### `coding.sh statusline uninstall`

Remove the coding.sh status line, restoring the previous one.

```text
coding.sh statusline uninstall [options]
```

| Option | Default | Description |
|---|---|---|
| `--dry-run` |  | Show what would change, write nothing. |

```sh
coding.sh statusline uninstall
```

## `coding.sh ingest`

Move captured hook events from the spool into the index.

```text
coding.sh ingest [options]
```

| Option | Default | Description |
|---|---|---|
| `--backfill` |  | Also import agents' local transcript history. |
| `--rebuild` |  | Re-parse every stored session (of --agent) from its transcript and spool with the current adapters. |
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--since <WHEN>` |  | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `--background` |  | Don't wait for another ingest; exit quietly if one is running. With --backfill, imports history unless another import is running. |

```sh
coding.sh ingest
coding.sh ingest --backfill --since 30d
coding.sh ingest --rebuild --agent pi
```

- Rarely needed: read commands, the viewer and the MCP server ingest first, and the hook starts one when a session ends.
- After an upgrade, sessions stored by an older adapter parse are re-parsed in the background. --rebuild does it for every session now; a session whose transcript and spool lines are gone keeps its rows, minus duplicates, and one the adapter now reads as a copy of another stored session is removed.
- Run in the foreground, it also folds sessions that have events but no session row, and sessions tagged fold:error; doctor counts both.

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
coding.sh collector [action] [options]
```

| Action | What it does |
|---|---|
| [`import`](#codingsh-collector-import) | Import agent traces from a ClickHouse otel_traces table (OpenTelemetry Collector clickhouseexporter) |

| Option | Default | Description |
|---|---|---|
| `-p, --port <PORT>` | `4318` | Port to listen on (0 = any free port) |
| `--host <HOST>` | `127.0.0.1` | Interface to bind. |
| `--keep-raw` |  | Also keep each source span and log record as a blob on its event (off by default: one blob write per span) |

```sh
coding.sh collector
coding.sh otel --port 0
coding.sh collector import --clickhouse http://127.0.0.1:8123/?database=otel
```

- Prints the OTEL_\* environment to stdout; status goes to stderr.
- import keeps its place per table and row filter (--all, each --where) and starts the next run an hour before it (a root span lands after its children); --from-start or a --since on the command line reads from --since again. A span stored once is never stored again.
- import tries a dropped connection or a 502, 503 or 504 three more times. A run that still fails keeps the pages it read, with their sessions, and prints the command that reads the rest.

### `coding.sh collector import`

Import agent traces from a ClickHouse otel_traces table (OpenTelemetry Collector clickhouseexporter).

```text
coding.sh collector import [options]
```

| Option | Default | Description |
|---|---|---|
| `--clickhouse <URL>` |  | ClickHouse HTTP URL, e.g. http://127.0.0.1:8123/?database=otel (user and password from the URL or CLICKHOUSE_USER / CLICKHOUSE_PASSWORD) |
| `--table <TABLE>` | `otel_traces` | Table to read (db.table also names the database) |
| `--since <WHEN>` | `7d` | Only spans that started after this: a duration (7d, 12h) or a date. When given, the run reads from there again instead of resuming. |
| `--from-start` |  | Read from --since again instead of resuming after the last span imported (nothing is stored twice) |
| `--where <SQL>` |  | Extra ClickHouse condition on the rows, e.g. "ServiceName = 'claude-code'". |
| `--all` |  | Read every span, not only traces with an agent span (gen_ai.\*, OpenInference, Vercel AI SDK, Claude Code, eve) |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh collector import --clickhouse http://127.0.0.1:8123/?database=otel
coding.sh collector import --clickhouse https://ch.example.com:8443/ --table otel.otel_traces --since 30d --dry-run
coding.sh collector import --clickhouse http://127.0.0.1:8123/?database=otel --from-start
```

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
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--scope <SCOPE>` | `user` | Install into user or project config. One of: `user`, `project`. |
| `--proxy` |  | Only stop routing agents through the proxy (undo init --proxy) |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh uninstall --dry-run
coding.sh uninstall --yes
coding.sh uninstall --proxy
```

- Captured data in ~/.coding.sh is kept.
- Also undoes init --proxy. The proxy itself keeps running until coding.sh proxy stop.

## `coding.sh sessions`

List captured sessions.

```text
coding.sh sessions [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only sessions from this agent (repeatable, or a comma list: a,b) |
| `-r, --repo <PATH>` |  | Only sessions in this repo root. |
| `--since <WHEN>` |  | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--subagents` |  | Include subagent sessions (a --where with id:, parent:, is:root or is:child picks them itself) |
| `--empty` |  | Include sessions with no turn, tool call or model call (hidden by default) |
| `--project <ID>` |  | Only sessions in this serve project (default: all) |
| `--flag <NAME>` |  | Only sessions with this flag: looping, failure-streak, churn, no-progress, stalled, context-thrash, premature-completion, duplicate-fetch, …, or a tag such as skill:&lt;name&gt;. |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fields <PATHS>` |  | With --json: print only these fields, as a comma list of dotted paths (id,title,stats.usage.costUsd). A path through a list picks from each item. Repeatable. |
| `--facets [<KEYS>]` |  | Count sessions per value instead of listing them: agent, model, provider, repo, launch, branch, flag, skill, hook, kind, tool, mcp (default: agent, model, repo, flag, skill, tool) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh sessions --where 'agent:codex cost>0.5 since:7d'
coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'
coding.sh sessions --facets model,tool --where 'repo:coding-sh'
coding.sh sessions --agent codex --since 7d
```

- --where: key:value clauses, AND by default; OR between clauses; ( ) to group; - to negate; a,b for either value; \* as a wildcard in text; &gt; &gt;= &lt; &lt;= and a..b on numbers. Bare words search prompts, replies and tool calls (every word in one event).
- Session keys: agent, model, provider, repo, launch, branch, dir, title, id, run, parent, flag, skill, hook, hook.tokens, since, until, duration, turns, tools, tool.errors, llm.errors, files, events, tests.passed, tests.failed, tokens, tokens.in, tokens.out, cost, cache.breaks, cache.lost, cache.cost, unapproved, has, is. Event keys (the session has a matching event; event keys in one group match the same event): kind, tool, ok, mcp, error, event.duration. Also sort:-cost and limit:N. Full list with examples: https://coding.sh/docs/query.
- --facets counts each key over the query without that key's own clauses, so every value of a picked key still shows. --limit sets the values per key (default 10).
- With --json each session is a digest: its stats without stats.phases, and each derail without the event it started at (eventId, index). show &lt;id&gt; --json has both, and --fields stats.phases or --fields stats.derails prints them here.
- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

## `coding.sh show`

Show a session timeline with subagents and latency.

```text
coding.sh show <SESSION> [options]
```

| Argument | Required | Description |
|---|---|---|
| `session` | yes | Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'; or a model call (its id, or &lt;session&gt;#&lt;n&gt;) |

| Option | Default | Description |
|---|---|---|
| `-n, --limit <N>` |  | List the first N events (default 200; a longer session shows as phases) |
| `--all` |  | List every event, with phase and day lines and derail markers. |
| `-f, --follow` |  | Keep printing new events as a running session goes on (Ctrl-C to stop) |
| `--fields <PATHS>` |  | With --json: print only these fields, as a comma list of dotted paths (session.id,session.stats.usage,phases). A path through a list picks from each item. Repeatable. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh show latest
coding.sh show 9f1c2e
coding.sh show 9f1c2e --all
coding.sh show latest --follow
coding.sh show 'latest#-1'
```

- A session with more than 200 events shows one line per phase: the start, each resume, compaction and long idle gap, with where it derailed.
- With --json a session with more than 200 events prints events: [] next to eventCount and phases; --limit N or --all lists the events. An event leaves out sessionId, agent and cwd when they equal the session's. subagents lists the first 50 subagent sessions and subagentCount is how many there are; when more are left, subagentsRest is the command that pages them all (tree --json).
- A model call logged by coding.sh proxy shows its system prompt, tools, settings, cache use, usage and cost (--all: the whole system prompt).

## `coding.sh tree`

Show a whole multi-agent run as one tree, with rolled-up totals.

```text
coding.sh tree <SESSION|RUN> [options]
```

| Argument | Required | Description |
|---|---|---|
| `session|run` | yes | A session id or prefix (its whole tree, from the top-level agent down), or a run id (every agent of the fan-out) |

| Option | Default | Description |
|---|---|---|
| `--run` |  | Read the argument as a run id (CODING_SH_RUN_ID), not a session. |
| `-n, --limit <N>` | `50` | With --json: most nodes in one page. |
| `--cursor <CURSOR>` |  | With --json: the nextCursor of the last page. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh tree latest
coding.sh tree 9f1c2e
coding.sh tree my-fanout-123 --run
coding.sh tree latest --json --limit 100
```

- From any session, the tree is its top-level agent and every subagent under it, with per-node model, cost, tokens, duration and tool calls, and the run's totals and worst flag.
- With --json the tree comes a page at a time: 50 nodes, depth-first, with nextCursor and truncated: true when more are left. totals and worst cover the whole tree on every page. A node whose parent was on an earlier page is at the top level of its page; depth and parentSessionId say where it hangs. Nodes are session digests, as in sessions --json.
- Separate agent processes group into one run when they share a run id: set CODING_SH_RUN_ID on the orchestrator that launches your fan-out, then pass that id.

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
| `--fork` |  | With --step: send the model call that made step N again, with the harness changed, and show the recorded and forked next action side by side. |
| `--with <DEST=SRC>` |  | With --fork: the fork's DEST (AGENTS.md or another instructions file, a rule or skill, or Claude Code's user-level instructions file in ~/.claude) has SRC's text; a bare PATH uses that file as it is now; DEST= drops it (repeatable) |
| `--harness <BUNDLE>` |  | With --fork: take the context files and model from this stored harness bundle. |
| `--model <MODEL>` |  | With --fork: send the call to this model. |
| `--system <TEXT|@FILE>` |  | With --fork: replace the system prompt. |
| `-k, --trials <N>` | `1` | With --fork: forked calls to send. |
| `--run` |  | With --fork: run Claude Code from step N in a copy of the session's directory, the stored history spliced into its requests, and show the recorded and forked steps. |
| `--verify <CMD>` |  | With --run: run this command in the fork's directory afterwards; exit 1 when it fails. |
| `--workdir <DIR>` |  | With --run: put the fork's copy here (default: a new temp dir), kept afterwards. |
| `--save-case <SUITE>` |  | With --fork: save step N as a case in evals/&lt;SUITE&gt; (eval run sends its stored request with the project's context files and fails it when it repeats the recorded action) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh replay latest
coding.sh replay 9f1c2e --step 12
coding.sh replay 9f1c2e --step 5 --to 20
coding.sh replay 9f1c2e --step 12 --file src/app.ts
coding.sh replay 9f1c2e --step 12 --fork --with AGENTS.md=fixed.md -k 3
coding.sh replay 9f1c2e --step 12 --fork --with AGENTS.md --run --verify 'npm test'
coding.sh replay 9f1c2e --step 12 --fork --with AGENTS.md --save-case forks
```

- File content is rebuilt from the agent's own tool calls: full writes, full reads and the edits applied to them. A file edited before any step showed it reads as unknown, with the reason, until a later read or write. A session run with `coding.sh run` also starts from its snapshot.
- The viewer has the same replay: the Replay button on a session page, or a link ending in ?step=N.
- --fork needs the session captured through coding.sh proxy (capture mode full): the stored request of the call that made step N is the fork's starting context. It calls the model with $ANTHROPIC_API_KEY (or $CLAUDE_CODE_OAUTH_TOKEN) or $OPENAI_API_KEY, at your cost. A context file is changed where the agent put it in the request; one it did not have is added as a "Contents of" section, the way Claude Code adds project instructions.

## `coding.sh attribution`

Which agent session wrote the lines each commit added; export them as Agent Trace.

```text
coding.sh attribution [action] [options]
```

| Action | What it does |
|---|---|
| [`export`](#codingsh-attribution-export) | Print one Agent Trace record (agent-trace.dev, RFC 0.1.0) per commit with agent lines, as JSONL |

| Option | Default | Description |
|---|---|---|
| `--repo <DIR>` |  | A directory in the git repository (default: the current one) |
| `--rev <REV>` | `HEAD` | Branch or commit to walk back from. |
| `--since <WHEN>` |  | Only commits after this time: 30d, 12h or a date in local time (default: the first captured session in the repo) |
| `--all` |  | Also list commits with no agent lines. |
| `-n, --limit <N>` | `50` | Maximum rows. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh attribution
coding.sh attribution --since 7d --rev main
coding.sh attribution --json
```

- Matches the lines each commit added to the lines each captured session added: the diff from its start state to its end snapshot, kept only for files its tools named or when it ran a shell or subagent call, and its own edit tool calls for the files that diff does not hold. A whole-file match (patch id) or a same-file line match counts; moved long lines count at lower confidence; braces and blank lines only follow a matched neighbor. A rebased commit still matches.
- A session gets credit for commits authored or committed from its start to 21 days later; of two sessions that wrote a line, the later one. Lines no session wrote belong to no session: a person wrote them, or an agent coding.sh did not capture. A session that ran a shell or subagent call can still be credited a file a person wrote in the same window, at lower confidence.
- Reads git only (log, diff, blame, notes). git-ai notes (refs/notes/ai), when present, credit lines no captured session matched. Each commit's result is kept in the store's key/value table.
- --json: one document with totals, the sessions credited and per commit its attributions (path, line ranges, session, agent, model, confidence, method). export --json: {version, records}.

### `coding.sh attribution export`

Print one Agent Trace record (agent-trace.dev, RFC 0.1.0) per commit with agent lines, as JSONL.

```text
coding.sh attribution export [options]
```

| Option | Default | Description |
|---|---|---|
| `--format <FORMAT>` | `agent-trace` | Output format. One of: `agent-trace`. |
| `-o, --out <FILE>` |  | Write the records to FILE instead of stdout and print its path. |
| `--viewer-url <URL>` | `http://127.0.0.1:4319` | Viewer base URL for each session link. |
| `--repo <DIR>` |  | A directory in the git repository (default: the current one) |
| `--rev <REV>` | `HEAD` | Branch or commit to walk back from. |
| `--since <WHEN>` |  | Only commits after this time: 30d, 12h or a date in local time (default: the first captured session in the repo) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh attribution export > agent-trace.jsonl
coding.sh attribution export --since 30d --out trace.jsonl
coding.sh attribution export --json
```

## `coding.sh blame`

git blame with the agent session that wrote each line.

```text
coding.sh blame <PATH[:LINE[-END]]> [options]
```

| Argument | Required | Description |
|---|---|---|
| `path[:line[-end]]` | yes | A file in the repo, optionally one line or a range (src/app.ts:40-60) |

| Option | Default | Description |
|---|---|---|
| `--rev <REV>` | `HEAD` | Blame the file as of this commit. |
| `--repo <DIR>` |  | A directory in the git repository (default: the current one) |
| `--since <WHEN>` |  | Match only commits after this time (default: the first captured session in the repo) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh blame src/app.ts
coding.sh blame src/app.ts:40-60
coding.sh blame src/app.ts --json
```

- Each line shows the commit that last changed it and, when a captured session wrote that line, the session and agent; '-' means no session did. Matching works as in coding.sh attribution.
- --json: {root, rev, path, unattributed, sessions, lines: [{line, commit, text, sessionId?, agent?, model?, confidence?, method?}]}.

## `coding.sh diff-calls`

Show what changed between two model calls, and why the second missed the prompt cache.

```text
coding.sh diff-calls <A> [b]
```

| Argument | Required | Description |
|---|---|---|
| `a` | yes | A model call: its id, a unique prefix of one (6+ characters), or &lt;session&gt;#&lt;n&gt; (#-1 is the last) |
| `b` | no | The call to compare it with (default: compare a with the call before it in its session) |

```sh
coding.sh diff-calls 9f1c2e4a7b3d
coding.sh diff-calls 'latest#3' 'latest#4'
coding.sh diff-calls 9f1c2e 4b7d1a --json
```

- Compares model, settings, tool definitions, the system prompt (line by line) and the message history, in the order the prompt cache reads them. Needs calls logged by coding.sh proxy; in capture mode metadata it compares hashes only.

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
| `-a, --agent <AGENT>` |  | Only sessions from this agent (repeatable, or a comma list: a,b) |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--project <ID>` |  | Only matches in this serve project (default: all) |
| `--where <QUERY>` |  | Only matches matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh search 'flaky test'
coding.sh search migration --where 'agent:codex kind:tool.start'
```

- Every word must appear in a match as a whole word, and the last word may also start a longer one: 'refactor tokeni' finds 'refactor the tokenizer'.
- Matches are listed best first. When a search matches more than 20,000 events (a word as common as 'the'), the local store lists them newest first instead.
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
| `--cache` |  | Prompt-cache economics instead: hit rate, read vs write tokens, read:write ratio, breaks and their cost, with what to change. |
| `-a, --agent <AGENT>` |  | Only sessions from this agent (repeatable, or a comma list: a,b) |
| `--since <WHEN>` | `30d` | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `-n, --limit <N>` | `20` | Maximum rows. |
| `--reprice` |  | Recompute estimated costs from the current price table first. |
| `--baseline` |  | With --by agent or agent-model: a VS PUBLISHED column, each agent's published prompt-cache hit rate (Requesty, Apr 2026) and the points yours is above or below it; - for an agent the dataset does not list. |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh usage
coding.sh usage --baseline
coding.sh usage --cache --by model
coding.sh usage --by agent-model --since 90d
coding.sh usage --by model --where 'repo:coding-sh tool:Bash'
```

- Totals cover every session in the window. A scan that stops at 100,000 sessions says so under the table (Stopped after 100,000 sessions) and sets window.truncated in --json; cache doctor does the same.

## `coding.sh cache`

Score prompt-cache health and name what breaks the cached prefix.

```text
coding.sh cache <action>
```

| Action | What it does |
|---|---|
| [`doctor`](#codingsh-cache-doctor) | Hit rate, a grade, and the cache breaks ranked by cost: cause, sessions, tokens re-billed, extra USD, the fix, and two calls to diff |

- Hit rate is cache reads / all prompt tokens, the CACHE READ column of coding.sh usage, over the same sessions. The breaks are the ones coding.sh show and usage count, so tokens and USD match theirs.
- Each break gets the first change between its two calls, in the order the cache reads a request: model-switch; tools-added, tools-removed, tools-reordered, tools-changed; system-volatile-line (a line that differs only in its numbers, such as a timestamp), system-changed; history-rewritten (compaction); then idle (a wait past the cache lifetime) or other. Idle and other are not counted as avoidable.
- Grade: 60% the hit rate against 90%, 40% the share of prompt tokens re-billed for avoidable causes (a quarter or more scores 0). A 90+, B 80+, C 70+, D 60+, else F.
- Tool and system prompt causes need the requests: calls logged by coding.sh proxy in capture mode full. Without them a break is classified from hashes, message counts, the model and timing, and the report says how many were.
- --limit bounds only the sessions whose stored requests are read. The hit rate, breaks, tokens, USD and grade cover every session in the window, and the grade is the same at any --limit wherever the hashes and counts show the change. A session with stored requests past the limit is classified as one without them is, from hashes, message counts, the model and timing: a tools or system prompt change is named without its detail (tools-changed, system-changed), and a history edit that keeps the message count reads as other. --json has sessionsNotRead and breaksNotRead. A session with no stored requests reads the same at any --limit.
- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

### `coding.sh cache doctor`

Hit rate, a grade, and the cache breaks ranked by cost: cause, sessions, tokens re-billed, extra USD, the fix, and two calls to diff.

```text
coding.sh cache doctor [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only sessions from this agent (repeatable, or a comma list: a,b) |
| `--since <WHEN>` | `30d` | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `-n, --limit <N>` | `200` | Read the stored requests of at most this many sessions with breaks, costliest first; the totals, the causes and the grade cover every session. |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh cache doctor
coding.sh cache doctor --agent claude-code --since 7d
coding.sh cache doctor --json
```

## `coding.sh stats`

Sessions, failures, cost, tokens and latency per day or week, split by agent, model, repo or flag.

```text
coding.sh stats [options]
```

| Option | Default | Description |
|---|---|---|
| `-m, --measure <MEASURE>` | `sessions` | What the trend shows. One of: `sessions`, `failures`, `failure-rate`, `cost`, `tokens`, `tool-calls`, `tool-errors`, `tool-error-rate`, `llm-calls`, `llm-p95`, `ttft-p50`. |
| `--by <GROUP>` |  | One row per group, with its trend (default: one row per day or week) One of: `agent`, `model`, `repo`, `flag`. |
| `--per <BUCKET>` | `day` | Bucket size. One of: `day`, `week`. |
| `--since <WHEN>` | `30d` | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `--until <WHEN>` |  | Only before this time (exclusive): 7d, 12h, today or a date in local time; --until 2026-11-09 leaves that day out (default: now) |
| `--all` |  | Count subagent sessions as their own rows (default: top-level sessions only, with each subagent's cost, tokens and tool calls added to its top-level session) |
| `--where <QUERY>` |  | Only sessions matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh stats
coding.sh stats --measure cost --by model --since 30d
coding.sh stats --measure failure-rate --by agent --per week --since 90d
coding.sh stats --by flag --where 'agent:codex' --json
```

- Days and weeks start at local midnight (weeks on Monday). FAIL% = sessions with a failure flag (a flag with no colon). TOOL ERR% = failed tool calls / tool calls. P95 LLM = the 95th percentile of the sessions' own p95 model-call latency; TTFT = the median of their median time to first token.
- With --by flag a session with several flags counts once in each; past the 6 largest groups the rest add up in "other". The same numbers: GET /api/metrics in coding.sh ui and coding.sh serve.
- With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true\|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.

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

Stream sessions, events or labels as JSONL or CSV, or write raw traces to a directory.

```text
coding.sh export [what] [options]
```

| Argument | Required | Description |
|---|---|---|
| `what` | no | sessions, events or labels (not needed with --evidence) |

| Option | Default | Description |
|---|---|---|
| `--format <FORMAT>` | `jsonl` | Output format. One of: `jsonl`, `csv`. |
| `--evidence <DIR>` |  | Instead: write each matching session's events, tool inputs and full outputs, redacted, as files under DIR. |
| `--force` |  | With --evidence, write into a directory that is not empty. |
| `-a, --agent <AGENT>` |  | Only sessions from this agent (repeatable, or a comma list: a,b) |
| `-r, --repo <PATH>` |  | Only sessions in this repo root. |
| `--since <WHEN>` |  | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `--flag <NAME>` |  | Only sessions with this flag or tag, as in coding.sh sessions --flag. |
| `--subagents` |  | Include subagent sessions (and their events and labels). A --where with id:, parent:, is:root or is:child picks them itself. |
| `--project <ID>` |  | Only sessions in this serve project (default: all) |
| `-n, --limit <N>` |  | Only the N newest matching sessions (default: all) |
| `--where <QUERY>` |  | Only sessions (and their events and labels) matching a query, e.g. 'agent:codex cost&gt;0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh export sessions --since 30d --format csv > sessions.csv
coding.sh export events --where 'agent:codex tool.errors>0' > events.jsonl
coding.sh export labels --format csv
coding.sh export --evidence traces/ --where 'flag:repeated-tool-failure' --limit 20
```

- --evidence writes DIR/index.md and, per session, index.md (stats and a timeline), session.json, events.jsonl and tools/NNNN-&lt;tool&gt;.txt (one tool call: input and whole output, read back from the blob store). Everything is redacted first; a tool file stops at 200 KB and events.jsonl at 5 MB. The same index gives the same bytes. Prints DIR.
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
| [`candidates`](#codingsh-eval-candidates) | Rank captured sessions in this repo by how good an eval task each would make |
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
| `--session <ID>` |  | Tasks from these sessions instead: an id, a prefix or latest (repeatable) Takes a comma list too (a,b). |
| `--since <AGE>` | `14d` | With --sessions: how far back to look (30m, 12h, 7d, 2w) |
| `--limit <N>` | `10` | With --sessions: at most N tasks. |
| `--repo <DIR|all>` |  | With --sessions: sessions under this directory, or all, for another checkout or worktree of the project (default: this git repo) |
| `--verifier <CMD>` |  | With --sessions: command that passes only when a task is solved (default: guessed per session) |
| `--hidden-test <GLOB>` |  | With --sessions: test files to hide from the agent (repeatable) |
| `--where <QUERY>` |  | Tasks from the sessions this query matches (sessions --where syntax), instead of every failed or flagged one. |
| `--validate` |  | With --sessions or --where: validate each task before it goes into the suite. A session diff that passes the verifier becomes the reference and the task is marked validated; one that fails it, or that changes the tests the verifier runs, is kept as a near miss. |
| `--validate-k <N>` | `1` | With --validate: the session's end state must pass N of N verifier runs. |
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
| `--summary <FILE>` |  | Also append the report to FILE as Markdown, e.g. "$GITHUB_STEP_SUMMARY" in GitHub Actions. |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh eval run
coding.sh eval run failures --trials 5 --yes
coding.sh eval run triage --json
coding.sh eval run triage --summary "$GITHUB_STEP_SUMMARY"
```

### `coding.sh eval candidates`

Rank captured sessions in this repo by how good an eval task each would make.

```text
coding.sh eval candidates [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <AGE>` | `14d` | How far back to look (30m, 12h, 7d, 2w) |
| `--limit <N>` | `10` | Show the best N. |
| `--repo <DIR|all>` |  | Sessions under this directory, or all (default: this git repo) |
| `--flagged` |  | Only failed or flagged sessions, the ones eval init --sessions drafts from. |
| `--all` |  | Also list the sessions that can't become a task, with the reason. |

```sh
coding.sh eval candidates
coding.sh eval candidates --since 30d --all
coding.sh eval candidates --repo all --json
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
| `--statement <MODE>` | `first-prompt` | How to write the instruction when --instruction is not given. first-prompt: the session's first prompt. ledger: every user turn and approved proposal as a list of obligations, with the ones a later turn replaced left out. One of: `first-prompt`, `ledger`. |
| `--judge <JSON|FILE>` |  | With --statement ledger: the model that merges turns into obligations, e.g. {"provider":"anthropic"} (default: one obligation per turn, no model) |
| `--verifier <CMD>` |  | Command that passes only when the task is solved. |
| `--setup <CMD>` |  | Setup command (repeatable) |
| `--hidden-test <GLOB>` |  | Test files to hide from the agent (repeatable) |
| `--tag <TAG>` |  | Tag (repeatable) Takes a comma list too (a,b). |

```sh
coding.sh eval new latest --verifier 'npm test'
coding.sh eval new latest --instruction @prompt.md --verifier 'npm test'
coding.sh eval new latest --statement ledger --judge '{"provider":"anthropic"}' --verifier 'npm test'
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
coding.sh eval validate [task]... [options]
```

| Argument | Required | Description |
|---|---|---|
| `task` | no | Task id or name (repeatable; or use --tag) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--tag <TAG>` |  | Validate every task with this tag, e.g. suite:&lt;name&gt; after eval import or eval run. |
| `--k <N>` | `5` | Reference must pass N of N runs. |
| `--keep` |  | Keep work directories. |
| `--strict-coupling` |  | Fail validation when a hidden test names an identifier or file only the reference introduces. |

```sh
coding.sh eval validate my-task
coding.sh eval validate --tag suite:failures --k 1
```

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
| `--judge <JSON|FILE>` | `{"provider":"anthropic"}` | Reviewer model: {"provider":"anthropic"\|"openai"\|"gateway"\|"claude-code"\|"codex"\|"mock","model":…}. |
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
| `--fail-on <WHAT>` |  | Exit 1 when B answers fewer prompts right than A: the 95% CI below 0 and an exact sign-flip p below 0.05. One of: `regression`. |
| `--draft [<PROVIDER|JSON>]` |  | Write triggers.toml instead of running it: prompts of captured sessions that loaded the skill (should) or a sibling (should_not), then a model fills each side (default provider: anthropic) |
| `--draft-model <MODEL>` |  | With --draft: the model. |
| `--n <N>` | `8` | With --draft: prompts per side. |
| `--since <AGE>` | `90d` | With --draft: how far back to look for sessions. |
| `--repo <DIR|all>` |  | With --draft: sessions under this directory, or all (default: this git repo) |
| `--no-traces` |  | With --draft: draft from SKILL.md only, without reading captured sessions. |
| `--force` |  | With --draft: replace an existing triggers.toml. An agent passes it only once the user approves. |
| `--dry-run` |  | With --draft: print the draft without writing it. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh eval trigger .claude/skills/pdf --draft --dry-run
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
| `--format <FORMAT>` | `coding.sh` | coding.sh: task dir. harbor: a Harbor task (task.toml schema 1.4, the source session in solution/trajectory.json). atif: the source session as an ATIF-v1.8 trajectory.json. One of: `coding.sh`, `harbor`, `atif`. |
| `--force` |  | Replace the named target when it already exists. An agent passes it only once the user approves. |

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
| `--session <ID>` |  | Case from a captured session (repeatable) Takes a comma list too (a,b). |
| `--split <SPLIT>` |  | Split for the added cases (default: stable hash of the case id, 60/20/20) One of: `train`, `dev`, `test`. |
| `--kind <KIND>` |  | Kind for the added cases: bad fails before the fix, guard and control pass before and after. One of: `bad`, `guard`, `control`. |
| `--note <TEXT>` |  | Version note. |

```sh
coding.sh dataset add smoke --case '{"input":"2+2","expected":"4"}'
coding.sh dataset add labelled --session <ID> --split test
coding.sh dataset add prompt-fix --kind control --case '{"input":"What is 2+2?","expected":"4"}'
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
| [`ab`](#codingsh-exp-ab) | A/B an AGENTS.md, rule or skill edit on the decision points your agent recently got wrong |
| [`replay`](#codingsh-exp-replay) | Replay logged model calls against the real API, with your own key, varying the model, system prompt or a field |
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

- exp ab and refine call a model API with ANTHROPIC_API_KEY or OPENAI_API_KEY. With neither set they use a logged-in Claude Code (`claude -p`) or Codex (`codex exec`) instead and say so in one line; --provider claude-code or codex asks for one. Each call runs with no hooks, plugins, MCP servers or settings of yours, in an empty directory, with a throwaway CLAUDE_CONFIG_DIR or CODEX_HOME holding only a copy of the login. claude -p gets the session's own Claude Code tools and refuses every call, so none runs.
- On a subscription, costs are API-equivalent (what the same tokens would cost on the API), there is no spending cap unless you pass --max-cost, calls run 2 at a time, rate limits back off and retry, and a spent usage limit stops the run and keeps the finished trials.
- With no uncommitted harness edits, exp ab tests your last commit that changed AGENTS.md (or another instructions file), a rule or a skill (B) against the version before it (A).

### `coding.sh exp ab`

A/B an AGENTS.md, rule or skill edit on the decision points your agent recently got wrong.

```text
coding.sh exp ab [spec] [options]
```

| Argument | Required | Description |
|---|---|---|
| `spec` | no | JSON file with the same fields as the options (behavior, since, a, b, model, …); options override it. |

| Option | Default | Description |
|---|---|---|
| `--a <FILE|DIR|git:REV|BUNDLE|none>` |  | Baseline harness (default: git HEAD when B is omitted, else the repo's current files; with no uncommitted edits, the version before your last harness commit) |
| `--b <FILE|DIR|git:REV|BUNDLE|none>` |  | Candidate harness; a file replaces the file of the same path in A (default: your uncommitted edits, else your last harness commit) |
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. Takes a comma list too (a,b). |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `-n, --limit <N>` | `40` | Maximum decision points. |
| `--provider <NAME>` |  | Who answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex) One of: `anthropic`, `openai`, `openai-compatible`, `claude-code`, `codex`. |
| `--model <MODEL>` |  | Model for the next turn (default: the one the decision points were recorded with, else claude-sonnet-5-5 or gpt-6-sol) |
| `--judge-model <MODEL>` |  | Model for the judge (default: --model) |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--trials <N>` | `1` | Next turns per case and arm. |
| `-c, --concurrency <N>` | `4` | Parallel model calls. |
| `--max-cost <USD>` |  | Refuse to start when the estimate is over this, and stop once the spend passes it (API-equivalent dollars with claude-code or codex) |
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
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp ab
coding.sh exp ab --b ./drafts/AGENTS.md --behavior unverified-claim
coding.sh exp ab --a git:main --b . --since 30d --dry-run
coding.sh exp ab --provider claude-code
coding.sh exp ab --watch
```

### `coding.sh exp replay`

Replay logged model calls against the real API, with your own key, varying the model, system prompt or a field.

```text
coding.sh exp replay [call]... [options]
```

| Argument | Required | Description |
|---|---|---|
| `call` | no | Calls logged by coding.sh proxy: an id, a 6+ character prefix, or &lt;session&gt;#&lt;n&gt; (latest#-1 is the last call) Takes the rest of the arguments. |

| Option | Default | Description |
|---|---|---|
| `--vary <KEY=B|KEY=A,B>` |  | A request field to vary: model, system, tools or any body field (dots for nested, @file reads a file). One value: A sends the recorded request, B this. Two: A and B. Repeatable. |
| `--session <SESSION>` |  | Also replay this session's proxy calls (the last --limit) |
| `--limit <N>` | `20` | With --session: the last N calls. |
| `--n <N>` | `5` | Replays per call and arm. |
| `-g, --grader <JSON|FILE>` |  | More grader specs (same-action always runs: does the reply take the first action the agent took?) Repeatable. |
| `--criterion <TEXT>` |  | Also grade each reply with an LLM judge on this criterion. |
| `--judge-model <MODEL>` |  | Model for --criterion. |
| `--upstream <URL>` |  | API base URL (default: the proxy's upstream for the call's provider) |
| `-c, --concurrency <N>` | `4` | Parallel model calls. |
| `--max-cost <USD>` |  | Refuse to start when the estimate is over this. |
| `--dry-run` |  | Show the calls, the arms and a cost estimate; make no model calls and need no key. |
| `--name <NAME>` |  | Experiment name (default: replay-&lt;first call id&gt;) |
| `--resume [<ID>]` |  | Continue an interrupted replay: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp replay latest#-1 --vary model=claude-haiku-4-5 --dry-run
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5
coding.sh exp replay --session latest --vary system=@prompt.md --n 3
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
| `--samples <MODE>` | `fixed` | adaptive: 2 trials each, a 3rd when they disagree; it fails at half or more failing. Reports no CI. One of: `fixed`, `adaptive`. |
| `--stop-on-regression` |  | Stop and exit 1 once a case that passed every trial of --baseline fails. |
| `--baseline <EXPERIMENT>` |  | With --stop-on-regression: the stored experiment to hold the run to. |
| `--arm <NAME=JSON|FILE>` |  | One arm's task spec; give two (A then B) to interleave them case by case in one run. Repeatable. |
| `--stop-early` |  | With --arm: stop once a group sequential test (O'Brien-Fleming) is decisive. |
| `--looks <N>` | `4` | With --stop-early: planned looks over the case budget. |
| `--max-cases <N>` |  | With --arm: run at most N cases (a random subset) |
| `--seed <N>` |  | With --arm or a matrix spec: seed for the case and arm order (default random, recorded). With --sample: seed for the draw (default 0) |
| `--failing <EXPERIMENT>` |  | Only the cases this experiment failed (compare warns and holds when the other side is that experiment: regression to the mean) |
| `--errors-from <EXPERIMENT>` |  | Only the cases with a task or infrastructure error in this experiment. |
| `--case <PATTERN>` |  | Only cases whose id matches (\* and ? wildcards; repeatable) Takes a comma list too (a,b). |
| `--sample <N|SHARE>` |  | A seeded random sample of the cases: a count (10) or a share (0.2); the same seed picks the same cases. |
| `--first-n <N>` |  | Only the first N cases, in dataset order (after the other selections) |
| `--retry-errors` |  | With --resume &lt;EXPERIMENT&gt;: also run its task-errored case-trials again (a finished experiment too); the rest are kept. |
| `--seq <K>` |  | Sequential attempts: a case-trial that fails is tried again with feedback, up to K attempts (2-10); the pass rate stays the first attempt's (Seq@1) and the run reports Seq@1..K. Command and http tasks need "envelope": true. |
| `--feedback <MODE>` | `reasons` | With --seq: bit (one fixed sentence), reasons (the failed graders' reasons, at most 3, 300 characters each) or critic=&lt;GRADER JSON\|FILE&gt; (a grader's reason on the failed output; it never gates). The expected answer is never shown. |
| `--seq-history <MODE>` | `full` | With --seq: show each new attempt every earlier attempt, or only the last. One of: `full`, `last`. |
| `--plan` |  | With a matrix spec: print the cells and what each changes, check them, and run nothing. |
| `--cell <NAME>` |  | With a matrix spec: run only this cell (repeatable); the baseline cell always runs. |
| `--reuse <CELLS>` | `none` | With a matrix spec: copy finished case-trials of the same case, task, graders, trial and timeout from earlier experiments instead of running them again. One of: `baseline`, `all`, `none`. |
| `--reuse-max-age <AGE>` | `7d` | With --reuse: only case-trials that started this recently (30m, 12h, 7d, 2w) |
| `--control` | `true` | A continuation task or a --replay needs a control arm (A, the recorded config) to measure replay noise; --no-control runs one task alone and marks the result. |
| `--record` |  | Record the task's model calls (Anthropic and OpenAI, through a local proxy the task's ANTHROPIC_BASE_URL/OPENAI_BASE_URL point at), so a later run can --replay them. |
| `--replay <EXPERIMENT>` |  | Serve this recorded experiment's model calls again, up to each case-trial's first changed call; later calls run live. Adds the recorded config as a control arm (A) unless --no-control. |
| `--replay-until <N>` |  | With --replay: serve only calls 1..N from the recording; call N+1 onward runs live. |
| `--series <NAME>` |  | Tag the experiment as the next round of an iteration loop and print whether the loop should stop (see exp plateau) |
| `--watch` |  | Rerun on every change to the spec, the task's script, grader files or --watch-path; a grader-only change regrades the stored outputs. Enter reruns, q quits. |
| `--watch-path <GLOB>` |  | With --watch: more files whose change reruns the task (repeatable; also the spec's "watch" field) |
| `--session` | `true` | In an experiment session (exp session new), add the run to its timeline and print the delta against the previous run; --no-session skips it. |
| `--resume [<ID>]` |  | Continue an interrupted experiment: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp run spec.json --watch
coding.sh exp run -d smoke -g '{"kind":"exact"}' --arm base=base.json --arm cand=cand.json --stop-early --max-cases 400
coding.sh exp run spec.json --resume
coding.sh exp run spec.json --resume exp_01J… --retry-errors
coding.sh exp run cand.json --failing base
coding.sh exp run spec.json --sample 20 --seed 7
coding.sh exp run spec.json --seq 3 --feedback reasons
coding.sh exp run spec.json --samples adaptive --stop-on-regression --baseline last-release
coding.sh exp run matrix.json --plan
coding.sh exp run matrix.json --cell model=opus,prompt=short
coding.sh exp run matrix.json --reuse baseline --plan
coding.sh exp run spec.json --record
coding.sh exp run cand.json --replay exp_01J… --replay-until 3
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
| `--pairwise <JSON|FILE>` |  | Pairwise judge spec, {"kind":"pairwise","name":…,"rubric":…}: judges A and B's outputs side by side, in both orders. Repeat it for more judges: compare then reports how far they agree, and --gate holds unless every judge finds B better. Repeatable. |
| `--labels <FILE>` |  | With --pairwise: human labels (JSON array or JSONL of {"caseId","winner":"a"\|"b"\|"tie"}) to calibrate each judge on the test split. |
| `--matrix` |  | Also print the success-count matrix: cases by passes out of k in A (rows) and B (columns) |
| `--margin <D>` |  | Non-inferiority: exit 1 unless the 95% CI lower bound of B − A is above −D (0.05 = 5pp) |
| `--labels-a <FILE>` |  | Human labels of A's outputs (JSON array or JSONL of {"caseId","value":"pass"\|"fail"\|"skip","criterion"?}): LLM judge graders get a PPI++ corrected B − A. |
| `--labels-b <FILE>` |  | Human labels of B's outputs (required with --labels-a; labels are never shared across arms) |
| `--min-labels <N>` | `20` | With --labels-a/-b: fewest usable labels per arm for a corrected delta. |
| `--verdict <ON>` | `pass` | What the verdict reads: the first-attempt pass rate, or Seq@K when both runs used the same --seq and --feedback. One of: `pass`, `seq`. |
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
coding.sh exp compare base cand --pairwise openai-judge.json --pairwise anthropic-judge.json --gate
coding.sh exp compare base cand --labels-a base-labels.jsonl --labels-b cand-labels.jsonl
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
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
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
| `--guard <DATASET[@VER]|prior>` |  | An earlier suite the winner must not forget: start and winner run on it (its test split, else every case), and a dont-ship gate blocks adoption and exits 1. prior: every dataset a sweep adopted a config on (repeatable) Takes a comma list too (a,b). |
| `--guard-tau <T>` | `0.10` | With --guard: largest share of the start's solved guard cases the winner may break. |
| `--guard-lambda <L>` | `2` | With --guard: loss weight of the guard gate. |
| `--resume [<ID>]` |  | Continue an interrupted sweep: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |

```sh
coding.sh exp sweep base=base.json t2=temp2.json t5=temp5.json -d smoke -g '{"kind":"exact"}' --budget 300
coding.sh exp sweep base=base.json cand=cand.json -d swe -g '{"kind":"exact"}' --guard prior
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
| `--higher <METRIC>` |  | Metric where higher is better (repeatable, \* wildcard); lower is better otherwise. Takes a comma list too (a,b). |
| `--metric <METRIC>` |  | Only report these metrics (repeatable, \* wildcard) Takes a comma list too (a,b). |
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
| `experiment` | yes | Experiment id or name (newest, cancelled ones included), or latest. |

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

## `coding.sh score`

Add and list typed scores on sessions, events, cases and runs.

```text
coding.sh score <action>
```

| Action | What it does |
|---|---|
| [`add`](#codingsh-score-add) | Score a session, event, case or run (prints the score id) |
| [`list`](#codingsh-score-list) | List scores, newest first |
| [`config`](#codingsh-score-config) | Fix a score name's type and allowed values (prints the config id) |
| [`configs`](#codingsh-score-configs) | List score configs |

- Labels are human scores: a pass or fail label is a boolean score, and judge calibrate reads human boolean scores as labels.
- A value outside its config's range or categories is refused (exit 2). The viewer and serve take the same scores at /api/scores.
- A stored score keeps its type: a value that reads as another type is refused (exit 2) unless --type is given or the name has a config.
- An event must be in the store to be scored. Its session is its own: --session with another session is refused (exit 2).

### `coding.sh score add`

Score a session, event, case or run (prints the score id).

```text
coding.sh score add <TARGET> <NAME> <VALUE> [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | yes | A session id (a prefix or latest works), or event:&lt;id&gt;, case:&lt;id&gt;, run:&lt;id&gt;. |
| `name` | yes | Score name, e.g. outcome or helpfulness. |
| `value` | yes | A number, true or false, or a category. |

| Option | Default | Description |
|---|---|---|
| `--type <TYPE>` |  | Data type (default: the name's config, else what the value looks like) One of: `numeric`, `boolean`, `categorical`, `text`. |
| `--comment <TEXT>` |  | Why this score. |
| `--source <SOURCE>` | `human` | Who gave it. One of: `human`, `judge`, `code`, `api`, `monitor`. |
| `--config <ID>` |  | Check the value against this config (default: the config with the score's name) |
| `--session <ID>` |  | The session a case or run belongs to (an event's own session is looked up) |
| `--judge-version <VERSION>` |  | Judge version that produced the score. |
| `--id <ID>` |  | Score id; adding the same id again replaces it (default: one per target, name, source and person) |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh score add latest outcome true
coding.sh score add 4f2a helpfulness 4 --comment 'fixed it first try'
coding.sh score add event:evt_123 correct false --source code
```

### `coding.sh score list`

List scores, newest first.

```text
coding.sh score list [options]
```

| Option | Default | Description |
|---|---|---|
| `--target <TARGET>` |  | Only scores on this target (as in score add) |
| `--name <NAME>` |  | Only this score name. |
| `--source <SOURCE>` |  | Only this source. One of: `human`, `judge`, `code`, `api`, `monitor`. |
| `--session <ID>` |  | Only scores on this session or its events. |
| `--since <WHEN>` |  | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `-n, --limit <N>` | `50` | Maximum rows. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh score list --name helpfulness
coding.sh score list --session latest --json
```

### `coding.sh score config`

Fix a score name's type and allowed values (prints the config id).

```text
coding.sh score config <NAME> [options]
```

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Score name. |

| Option | Default | Description |
|---|---|---|
| `--type <TYPE>` |  | Data type (required) One of: `numeric`, `boolean`, `categorical`, `text`. |
| `--min <N>` |  | numeric: smallest allowed value. |
| `--max <N>` |  | numeric: largest allowed value. |
| `--categories <A,B,...>` |  | categorical: the allowed values (comma-separated or repeated) Repeatable. |
| `--description <TEXT>` |  | What the score means. |
| `--id <ID>` |  | Config id (default: the name) |

```sh
coding.sh score config helpfulness --type numeric --min 0 --max 5
coding.sh score config tone --type categorical --categories positive,neutral,negative
```

### `coding.sh score configs`

List score configs.

```text
coding.sh score configs
```

## `coding.sh judge`

Grade one output or the slop in captured diffs, or check an LLM judge or a test verifier against human labels.

```text
coding.sh judge <action>
```

| Action | What it does |
|---|---|
| [`grade`](#codingsh-judge-grade) | Run one grader on one output and trace (exit 0 on pass, 1 on a fail verdict, 2 when the grader could not grade); inside a verifier both default to the agent's |
| [`slop`](#codingsh-judge-slop) | Flag agent-slop patterns (placeholder code, type escapes, swallowed errors, debug prints, focused tests) in the lines captured work added |
| [`calibrate`](#codingsh-judge-calibrate) | Measure judge-human agreement (Cohen's kappa) on a held-out split, or a verifier's precision |
| [`sample`](#codingsh-judge-sample) | Plan which cases to label next: a seeded random sample stratified by judge verdict and confidence |

- judge grade appends each model call's tokens and price to $CODING_SH_GRADER_USAGE when it is set. coding.sh compare sets it for every verifier, so judge spend counts toward --max-cost.

### `coding.sh judge grade`

Run one grader on one output and trace (exit 0 on pass, 1 on a fail verdict, 2 when the grader could not grade); inside a verifier both default to the agent's.

```text
coding.sh judge grade [options]
```

| Option | Default | Description |
|---|---|---|
| `-g, --grader <JSON|FILE>` |  | Grader spec, the same JSON as `exp run --grader` (llm, llm-checklist with trace checks, contains, regex, …) |
| `--output <FILE|->` |  | The output to grade (default: $CODING_SH_AGENT_OUTPUT, the agent's final answer in a verifier) |
| `--trace <FILE>` |  | Claude stream-json or transcript, codex exec --json, Cursor stream-json, OpenAI chat messages or Responses items, or coding.sh events as JSONL (default: $CODING_SH_AGENT_STDOUT) |
| `--allow-partial-trace` |  | Grade even when --trace has cut lines, records the judge does not read, or tool calls that did not reach it (otherwise exit 2, trace_incomplete) |
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
| `--rules <ID>` |  | Rules to run instead of the defaults; 'default' and 'all' name those sets (repeatable) Takes a comma list too (a,b). |
| `--exclude <ID>` |  | Rule to leave out (repeatable) Takes a comma list too (a,b). |
| `--max-errors <N>` | `0` | Pass with at most N error findings. |
| `--max-warnings <N>` |  | Pass with at most N warnings (default: no limit) |
| `--list-rules` |  | Print the rule catalog and exit. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

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
| `--tuned-on <SPLIT>` |  | Splits the prompt was tuned on, when the judge is not stored (repeatable) Takes a comma list too (a,b). |
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
| [`traces`](#codingsh-toolevals-traces) | Export an MCP server's traces and per-tool health |

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
coding.sh toolevals validate [target] [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | no | Target name (default: all; one target with --against) |

| Option | Default | Description |
|---|---|---|
| `--against <VARIANT>` |  | Check kinded tasks on the old variant instead: bad tasks must fail there, guard and control tasks must pass. |
| `-d, --driver <DRIVER>` |  | With --against: run agent trials with this driver instead of the reference commands (needed when the variant changes only what the agent reads) Repeatable. |
| `-k, --k <N>` | `1` | With --against --driver: trials per task. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh toolevals validate gh
coding.sh toolevals validate gh --against old-build
coding.sh toolevals validate everything --against old-descriptions --driver model:anthropic/claude-sonnet-5-5 -k 3
```

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
| `-d, --driver <DRIVER>` |  | agent:&lt;id&gt;[:model] or model:&lt;provider&gt;/&lt;model&gt; (repeatable) Takes a comma list too (a,b). |
| `--variant <VARIANT>` |  | Variant (repeatable; default: base) Takes a comma list too (a,b). |
| `-k, --k <N>` | `3` | Trials per task and arm. |
| `--samples <MODE>` | `fixed` | adaptive: 2 trials each, a 3rd when they disagree; it fails at half or more failing. Reports no CI. One of: `fixed`, `adaptive`. |
| `--stop-on-regression` |  | Stop and exit 1 once a task that passed every trial of --baseline fails. |
| `--baseline <EXPERIMENT>` |  | With --stop-on-regression: the stored experiment to hold the run to. |
| `--split <SPLIT>` | `dev` | Task split. One of: `dev`, `heldout`, `all`. |
| `-t, --task <ID>` |  | Only this task (repeatable) Takes a comma list too (a,b). |
| `-c, --concurrency <N>` |  | Parallel trials. |
| `--keep` |  | Keep trial sandboxes. |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--shell-model <PROVIDER/MODEL>` |  | Model drivers on a CLI target: a model plays the shell (fixed date); it becomes part of the arm name. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh toolevals run gh --driver agent:claude-code -k 3
coding.sh toolevals run everything --driver model:anthropic/claude-sonnet-5-5 --variant base --variant terse
coding.sh toolevals run gh --driver agent:claude-code --samples adaptive --stop-on-regression --baseline texp_01J…
coding.sh toolevals run gh --driver model:openai/gpt-6-sol --shell-model anthropic/claude-haiku-4-5
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
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

### `coding.sh toolevals show`

Show a trial's metrics, tap records and session tree.

```text
coding.sh toolevals show <TRIAL>
```

| Argument | Required | Description |
|---|---|---|
| `trial` | yes | Trial id. |

### `coding.sh toolevals traces`

Export an MCP server's traces and per-tool health.

```text
coding.sh toolevals traces <TARGET> [options]
```

| Argument | Required | Description |
|---|---|---|
| `target` | yes | Target or MCP server name. |

| Option | Default | Description |
|---|---|---|
| `--from <EXPERIMENT>` |  | Trials of this tool-eval experiment (dev tasks only) |
| `--arm <ARM>` |  | Only this arm of --from, &lt;variant&gt;@&lt;driver&gt;. |
| `--sessions <FILTER>` |  | Captured sessions matching this query, e.g. 'since:30d'. |
| `--server <NAME>` |  | Server name in mcp__&lt;server&gt;__&lt;tool&gt; (default: the target name) |
| `-o, --out <DIR>` |  | Write traces/, index.jsonl, tool-health.json and tools.json here. |
| `--max <N>` | `200` | Most traces to keep. |
| `--no-tools` |  | Don't connect to the server to list its tools. |

```sh
coding.sh toolevals traces coding-sh --sessions 'since:30d' --out traces-coding-sh
coding.sh toolevals traces coding-sh --from texp_01J… --arm base@agent:claude-code --out traces-coding-sh
```

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
| `-v, --variant <NAME=SCRIPT|JSON>` |  | Variant: name=script path (claude), name=command (command), or JSON (repeatable) |
| `--cases <DIR>` |  | Cases directory (default: evals/workflows/&lt;workflow&gt;/cases) |
| `-k, --k <N>` | `3` | Attempts per case and variant. |
| `--split <SPLIT>` |  | Only cases in this split. One of: `dev`, `heldout`. |
| `--driver <DRIVER>` | `claude` | How a variant runs. One of: `claude`, `command`. |
| `-j, --concurrency <N>` | `1` | Jobs at once (a workflow already fans out) |
| `--validate` | `true` | Check seeded bugs on each case's snapshot first: each bug's test fails, and passes with the bug reverted (--no-validate to skip) |
| `--resume [<ID>]` |  | Continue an interrupted workflow experiment: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
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
| `--fresh` |  | Sessions benchmarks: wait for every pending capture to be ingested (default: answer after 1.5 s) |

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

## `coding.sh improve`

What to fix first in your sessions, the line that fixes it, and whether your last AGENTS.md changes helped.

```text
coding.sh improve [action] [options]
```

| Action | What it does |
|---|---|
| [`fix`](#codingsh-improve-fix) | Add an issue's line to AGENTS.md or the agent's instructions file (uncommitted), then print the command that tests it |
| [`check`](#codingsh-improve-check) | Did each committed AGENTS.md, rule or skill change help? Sessions before vs after it; exit 1 when one made things worse |

| Option | Default | Description |
|---|---|---|
| `--since <WHEN>` | `14d` | Only sessions (check: changes) after this time: 7d, 12h, today or a date (local time) |
| `--repo <DIR|all>` |  | Only sessions under this directory, or all (default: this git repo) |
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--headless` |  | Include headless sessions (claude -p, an Agent SDK, codex exec), left out by default. |
| `-n, --limit <N>` | `5` | Maximum rows. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh improve
coding.sh improve --since 30d --repo all
coding.sh improve fix 1
coding.sh improve check
```

- improve lists the failure flags in this repo's sessions and any command or tool that fails the same way in two or more sessions. Issues seen in two or more sessions come first, then by the severity score refine uses. Each issue has an example session, a fix, and the commands that take it through the loop: show, improve fix, exp ab, improve check.
- A failing test command that already failed before the agent changed any file is reported as a broken setup: fix the command first, or the agent can't check its work.
- Prompt cache paid for again (stored cache breaks) is an issue from $1 in two or more sessions: its dollars and share of the spend set its severity, with a fix per cause, costliest first.
- Headless sessions (claude -p, an Agent SDK, codex exec: scripts, judges and evals) are left out, and the first line says how many; --headless counts them. Eval and benchmark runs and subagents are always left out.
- A failed compound line (&&, ;, \|, a loop) counts against the part that failed: the one its error names, the tool whose error it is, the part timeout stopped, or the last part of a pipeline. When nothing singles one out, the issue says compound command.
- When sessions ran on the repo's current harness version (the newest commit that changed AGENTS.md or another instructions file, a rule or a skill) and none of them had an issue, the issue is marked 'Not seen since &lt;commit&gt;', goes last, and points at improve check instead of a new line.
- check reads the git history of AGENTS.md, the Claude Code and Gemini instructions files, .claude/rules, .cursor/rules and skills. A session counts for the newest such commit its starting HEAD contains, so uncommitted edits count from the commit that keeps them. Sessions with no recorded HEAD, and sessions with no tool call outside MCP servers (a chat, or asking coding.sh about a change), are left out.
- check compares sessions with a failure flag before and after each change (overall and per flag), and, for each added line that names a command, flag, path or identifier, the share of sessions that acted on it. Two-sided Fisher exact tests at p ≤ 0.1: more flagged sessions is Regressed (exit 1); fewer flagged sessions, or one flag falling (Holm-adjusted) with no other rising significantly, is Helped, and its line names any flag that rose. A new line the agent follows while flagged sessions stay put is Followed, no effect yet. More tool calls or wall time per session (median 1.25x, permutation p ≤ 0.1) with no fall is Costlier; both suggest refine test git:&lt;previous&gt; to test the harness without the change. Under 5 sessions after a change without a clear result is Too early to tell.
- Under each change, check lists the sessions after it that still have a failure flag, newest first, with their flags (5, or all with --sessions; --json has every flagged session before and after).
- exp ab (the replay A/B that improve suggests) needs ANTHROPIC_API_KEY, OPENAI_API_KEY, or Claude Code or Codex logged in (it runs on your subscription then). Without any of them, commit the change and let improve check judge it on new sessions.

### `coding.sh improve fix`

Add an issue's line to AGENTS.md or the agent's instructions file (uncommitted), then print the command that tests it.

```text
coding.sh improve fix <ISSUE> [options]
```

| Argument | Required | Description |
|---|---|---|
| `issue` | yes | Its number in coding.sh improve, or its id (flag:no-verification) |

| Option | Default | Description |
|---|---|---|
| `--since <WHEN>` | `14d` | Only sessions (check: changes) after this time: 7d, 12h, today or a date (local time) |
| `--repo <DIR|all>` |  | Only sessions under this directory, or all (default: this git repo) |
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--headless` |  | Include headless sessions (claude -p, an Agent SDK, codex exec), left out by default. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |
| `--target <FILE>` |  | Repo file to add the line to (default: the repo's instructions file that the issue's agents read, such as AGENTS.md) |
| `--dry-run` |  | Show the exact changes without writing anything. |

```sh
coding.sh improve fix 1
coding.sh improve fix flag:no-verification --target AGENTS.md --dry-run
```

### `coding.sh improve check`

Did each committed AGENTS.md, rule or skill change help? Sessions before vs after it; exit 1 when one made things worse.

```text
coding.sh improve check [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <WHEN>` | `30d` | Only sessions (check: changes) after this time: 7d, 12h, today or a date (local time) |
| `--repo <DIR|all>` |  | Only sessions under this directory, or all (default: this git repo) |
| `-a, --agent <AGENT>` |  | Only this agent (repeatable, or a comma list: a,b) |
| `--headless` |  | Include headless sessions (claude -p, an Agent SDK, codex exec), left out by default. |
| `-n, --limit <N>` | `5` | Maximum rows. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |
| `--watch` |  | Keep running and print a line when a change's verdict moves as new sessions arrive. |
| `--interval <SECONDS>` | `60` | With --watch: how often to re-check. |
| `--sessions` |  | List every session still flagged after each change, not just the newest 5. |

```sh
coding.sh improve check
coding.sh improve check --since 7d --json
coding.sh improve check --sessions
coding.sh improve check --watch
```

## `coding.sh harness`

Snapshot and list agent harness bundles; audit which memory and instruction files agents use.

```text
coding.sh harness <action>
```

| Action | What it does |
|---|---|
| [`snapshot`](#codingsh-harness-snapshot) | Snapshot an agent's harness files into a bundle |
| [`list`](#codingsh-harness-list) | List harness bundles |
| [`audit`](#codingsh-harness-audit) | Count the sessions that loaded, read and wrote each memory, AGENTS.md, rule and skill file; warn about subagent files Claude Code misreads |

- A harness TOML can carry Claude Code plugins too: plugins = ["terse", "./plugins/mine"], with a directory relative to the TOML file.
- A plugin is looked up read-only in plugins/installed_plugins.json under $CLAUDE_CONFIG_DIR (default ~/.claude), or read from a directory with .claude-plugin/plugin.json. Its whole directory is stored in the bundle. A run writes it under the run's own home and starts Claude Code with --plugin-dir; your Claude config is not touched.

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
| `--plugin <PLUGIN>` |  | claude-code: carry this Claude Code plugin, an installed one (name or name@marketplace) or a plugin directory (repeatable). Only the plugins named here are carried. |

```sh
coding.sh harness snapshot --agent claude-code --name base
coding.sh harness snapshot --agent claude-code --name with-terse --plugin terse
coding.sh harness snapshot --agent claude-code --plugin ./my-plugin
coding.sh harness snapshot --file harness.toml
```

### `coding.sh harness list`

List harness bundles.

```text
coding.sh harness list
```

### `coding.sh harness audit`

Count the sessions that loaded, read and wrote each memory, AGENTS.md, rule and skill file; warn about subagent files Claude Code misreads.

```text
coding.sh harness audit [options]
```

| Option | Default | Description |
|---|---|---|
| `-a, --agent <AGENT>` |  | Only this agent's sessions and files. |
| `--since <WHEN>` | `30d` | Only at or after this time: 7d, 12h, 30m, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight. |
| `--limit <N>` | `40` | Files to list, flagged first. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

```sh
coding.sh harness audit
coding.sh harness audit --agent claude-code --since 90d
coding.sh harness audit --json
```

## `coding.sh compare`

A/B two harness bundles on eval tasks.

```text
coding.sh compare <A> [b] [options]
```

| Argument | Required | Description |
|---|---|---|
| `a` | yes | Baseline bundle id or name (with --parity: a URL, or a command that prints the page) |
| `b` | no | Candidate bundle id or name (omit with --without or --with; with --parity: the other URL or command) |

| Option | Default | Description |
|---|---|---|
| `--parity` |  | Instead: diff what a crawler reads from two pages (status, redirects, title, description, canonical, robots, Open Graph and Twitter tags, hreflang count, JSON-LD types, lang; status is left out when a side is a command). Exits 1 when they differ, 2 when a page could not be read. |
| `--user-agent <UA>` |  | With --parity: the User-Agent to fetch as (default: a coding.sh crawler agent) |
| `-t, --task <ID>` |  | Task id (repeatable; default: all validated tasks) Takes a comma list too (a,b). |
| `--tag <TAG>` |  | Run every non-archived task with this tag, drafts included (e.g. the tag given to eval import) |
| `--k <N>` | `1` | Attempts per task and arm. |
| `-c, --concurrency <N>` |  | Parallel runs. |
| `--max-cost <USD>` |  | Spend cap: once finished runs (agent plus judge grade calls) reach it, no new run starts. |
| `--pick <N>` |  | Run the N tasks that best tell harnesses apart in stored runs; tasks every run passed go last. |
| `--pick-by <HOW>` | `separation` | With --pick or --budget: rank by outcome-suite correlation, or by item information from an IRT fit of stored runs (mid difficulty for A, high discrimination first; needs 3+ configs) One of: `separation`, `irt`. |
| `--budget <USD>` |  | Run the most informative tasks whose estimated cost (2 arms x k runs each) fits; also the spend cap unless --max-cost is set. |
| `--cost-per-run <USD>` |  | With --budget: the cost of one run when no stored run, source session or other task gives one. |
| `--sequential` |  | Run each arm's tasks in order, one stream per attempt, carrying the agent's HOME state from task to task; the report adds a learning curve. |
| `--carry <PATH>` |  | With --sequential: what to carry, a path in the run's HOME such as ~/.claude/projects (repeatable; default: the whole HOME) |
| `--otel` |  | Give each agent an OTLP endpoint, a TRACEPARENT and coding_sh.run_id, so its spans join the run's session. |
| `--isolation` |  | Grade each run in a fresh copy of the start tree plus the agent's source changes (default on); --no-isolation grades the agent's own tree. |
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
| `--reuse <ARMS>` | `none` | Copy finished runs of the same task, bundle, agent version, attempt and timeout from earlier comparisons and eval runs instead of running them again. One of: `baseline`, `both`, `none`. |
| `--reuse-max-age <AGE>` | `7d` | With --reuse: only runs that finished this recently (30m, 12h, 7d, 2w) |
| `--dry-run` |  | Print how many runs each arm would reuse and run, and run nothing. |
| `--without <PATH>` |  | Ablation: B is A without this file, dir or glob, or without plugin:&lt;NAME&gt; (repeatable) |
| `--with plugin:<PLUGIN>` |  | B is A plus this Claude Code plugin, an installed one (name or name@marketplace) or a plugin directory (repeatable; claude-code bundles) |
| `--gateway [<NAME>]` |  | Route both arms through a gateway. Without a name: [gateway] default, else the one with a key, else vercel. One of: `vercel`, `openrouter`, `litellm`, `ramp`. |
| `--gate` |  | Ship-or-hold decision: exit 0 when B wins enough without breaking what A solved, 1 otherwise. |
| `--lambda <N>` | `2` | With --gate: what breaking one solved item costs, in fixed items. |
| `--gate-alpha <A>` | `0.05` | With --gate: one-sided significance level. |
| `--tau <T>` | `0.10` | With --gate: largest share of solved items B may break. |
| `--by <PREFIX>` |  | With --gate: also gate each task group (first tag with this prefix, e.g. suite:); any group's don't-ship blocks. |
| `--promote` |  | Pareto promotion gate: exit 0 when B is credibly better on quality or cheaper (cost, else tokens), 1 otherwise. |
| `--gamma <G>` | `0.7` | With --promote: support needed to promote; the exact sign-flip test over tasks must also have p at most 1 − G. |
| `--eps-q <Q>` | `0.1` | With --promote: pass rate a cheaper B may give up. |
| `--eps-c <C|inf>` | `inf` | With --promote: relative cost rise a better B may take (0.2 = +20%) |
| `--draws <N>` | `10000` | With --promote: bootstrap draws. |
| `--item-gate` |  | One-item gate (shown automatically when B adds or removes one rule, skill or context file): exit 0 on KEEP or ACCEPT, 1 otherwise; --no-item-gate hides it. |
| `--audited` |  | Count passes a witness refuted (eval audit) as fails in the verdict; needs every pass in both arms audited. |
| `--signals` |  | Check each failure flag and tool errors against the outcome: pooled, within-task and within-task-and-arm AUROC beside difficulty and length references (needs k &gt;= 2) |
| `--resume [<ID>]` |  | Continue an interrupted comparison: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh compare base candidate --k 3
coding.sh compare base candidate --k 3 --resume
coding.sh compare base candidate2 --k 3 --reuse baseline --dry-run
coding.sh compare base candidate --experiment exp_01
coding.sh compare base candidate --experiment exp_01 --audited
coding.sh compare base candidate --experiment exp_01 --signals
coding.sh compare base candidate --experiment exp_01 --retry-errors
coding.sh compare base candidate2 --failing exp_01 --k 3
coding.sh compare base candidate --sample 20 --seed 7
coding.sh compare base candidate --budget 20 --dry-run
coding.sh compare base memory-on --sequential --carry ~/.claude/projects
coding.sh compare base candidate --k 3 --repair 2 --repair-signal names
coding.sh compare base candidate --k 3 --gate
coding.sh compare base candidate --k 3 --gate --by suite:
coding.sh compare no-skill with-skill --tag skill-eval --gate --by suite: --max-cost 15
coding.sh compare base candidate --k 3 --promote
coding.sh compare base --without .claude/rules/clock.md --k 3 --item-gate
coding.sh compare base --with plugin:terse --k 3 --gate
coding.sh compare with-terse --without plugin:terse --k 3
coding.sh compare sonnet gpt5 --gateway
coding.sh compare sonnet gpt5 --gateway openrouter
coding.sh compare --parity https://staging.example.com/docs https://example.com/docs
coding.sh compare --parity 'cat dist/index.html' https://example.com/
```

## `coding.sh refine`

Improve AGENTS.md and skills in tested rounds, and protect their safety rules.

```text
coding.sh refine <action>
```

| Action | What it does |
|---|---|
| [`propose`](#codingsh-refine-propose) | Ask a model for lines that address your sessions' most severe flags; stores them as a candidate |
| [`test`](#codingsh-refine-test) | Test candidate edits against your current files; keep, reject or inconclusive per candidate, exit 0 when one is kept |
| [`apply`](#codingsh-refine-apply) | Write a kept candidate to your files, backing up what it replaces (never commits) |
| [`rollback`](#codingsh-refine-rollback) | Put back what an apply replaced, from its backup |
| [`log`](#codingsh-refine-log) | Every round in this repo: verdict, effect CI, guard result, cost and reason, and whether the loop plateaued; --suite climbs show pass rate, cost, time and size per round and the Pareto front |
| [`run`](#codingsh-refine-run) | Loop: propose (or take --candidate), test, apply when kept; stop at --rounds, --max-cost or a plateau |
| [`protected`](#codingsh-refine-protected) | List the harness lines an edit may not delete, reword or relax |
| [`check`](#codingsh-refine-check) | Check a harness edit for deleted, reworded or relaxed protected lines; exit 1 when it has any |
| [`mine`](#codingsh-refine-mine) | Rank failure patterns across sessions: repeated error lines, repeated instructions you typed, flags and failed eval runs, with counts and example sessions ($0) |
| [`recheck`](#codingsh-refine-recheck) | Re-run a suite round's base and candidate under another model (a canary) and record the verdict; suggests a rollback when the edit regresses there |
| [`distill`](#codingsh-refine-distill) | Hand a coding agent the raw runs of an experiment (or this repo's recent sessions) to analyze with its own code and write one skill; the skill is checked by the critics and ledgered as a candidate for refine test |
| [`diagnose`](#codingsh-refine-diagnose) | Diagnose recent sessions with a model into Signals: cited problems grouped into issues, severity scored by code. Without an API key it prints a $0 plan |
| [`signals`](#codingsh-refine-signals) | List the Signals refine diagnose wrote, or show one with its cited evidence and fix |
| [`score`](#codingsh-refine-score) | Score diagnoses against human labels: occurrence, Signal and session precision and recall, coverage, repeat agreement |

- A protected line is inside a &lt;!-- coding.sh:protect --&gt; … &lt;!-- coding.sh:protect end --&gt; block, matches a [refine] protect regex, or pairs a gate word (never, don't, must not, only, before, ask, confirm, verify, check, require) with a safety topic (credentials, secrets, access tokens, private keys, .env, prod, deploy, push, --force, force-push, destructive, --no-verify, rm -rf, delete, drop table, reset --hard, migrations, permissions, sudo, chmod, payments, PII, another user, owner, dry-run, backups). Set [refine] autoProtect = false in your user config to keep only markers and patterns.
- check rejects an edit that deletes or rewords a protected line (protected-line), or adds a line that waives one (skip, no need, only … when, unless, without asking, already verified …) and shares a backticked token, a word or a safety topic with it (relaxes-protected).
- exp ab runs the same check on its arms and warns; with --gate a protected-line problem fails the run.
- test decides each candidate in stages: the protected-line check, the harmless and duplicate critics on the added lines, an A/B against your current files on the decision points exp ab mines (the acceptance gate: ship goes on, hold is inconclusive, don't ship rejects), then the guard set: the decision points earlier kept edits won must not go from solved to unsolved. A run stopped at --max-cost is inconclusive.
- The ledger and every tested candidate's files live under the data dir (refine/&lt;repo&gt;-&lt;hash&gt;/). Rejected candidates and their reasons go into the next proposal prompt; protected lines go in as READ-ONLY.
- With --suite, each round runs the suite's repo tasks --trials times (default: the suite's trials, else 3) with the current files and with the candidate, interleaved, as one durable job; --model is the agent's model, --concurrency the parallel sessions, --max-cost caps agent and proposer spend. The candidate is kept when the pass rate is significantly better (one-sided paired permutation test over tasks, or the acceptance gate says ship), or when it holds within --margin (one-sided bootstrap lower bound) and a listed objective is significantly better by --min-gain (per-task log ratios, one-sided permutation test); a hard regression or a don't-ship gate rejects it, and so does a listed objective significantly worse, unless the pass rate is significantly better and the rise is within --max-cost-rise (default 50%; the verdict prints the trade). Below 5 tasks no test can reach significance.
- With --suite and a primary objective other than pass, the proposer cuts instead of adding: it sees the target file, its largest sections and what made the last runs slow or expensive (tokens, turns, repeated tool calls, long outputs), and replies with edits: find and replace an exact string, or replace a whole section by its heading. The protected-line check and the critics still run on the result.
- With --suite and --canary-model, a kept candidate that deletes or rewords existing lines (every kept candidate with --canary all) runs again with both arms under the canary model. It is rejected (canary-regression) when a task the base passed in every attempt passes in at most a third of the candidate's, when more of its passing runs tamper with tests, or when the paired bootstrap lower bound of the pass-rate change is at or below -10pp (--canary-delta). With fewer than 3 tasks differing on each side the decision stands, marked canary-uninformative. A subtractive candidate kept without a canary model gets a note that a success-only gate cannot see a lost safeguard the loop's model did not need. recheck runs the same check later for any suite round.
- distill writes the corpus as episodes.jsonl (one row per run or session: pass, verifier exit, tamper, turns, tool calls and errors, tokens, cost, flags), tool_calls.jsonl (one row per call with 500-character previews and an input hash), a redacted transcript per episode and a copy of the current harness files under prompt/. Cancelled, superseded and infrastructure-error runs, and runs of tasks tagged split:dev, split:test, split:heldout or refine:heldout, are left out. The distiller works in a temp directory and must write out/SKILL.md with name and description frontmatter, at most 160 lines and 10 KB; the harmless and duplicate critics then check it. Each skill is ledgered (op propose) as proposed or rejected; none is applied.
- diagnose sends each session (cut to the first prompt, the last 40 events and the events around failures when longer than 120) inside an untrusted &lt;trace&gt; block with the session's flags as rule candidates. An occurrence survives only when a quote it cites is in the cited event; ins.\* types, tool.invalid-args, out.false-success and out.check-subverted also need the broken requirement cited. A second call groups new occurrences into Signals (existing occurrences never move) and a third writes one fix per changed Signal. Severity is computed from the cited factors and how many analyzed sessions show the issue. Replies are cached by model, prompt and catalog, so a rerun on unchanged sessions makes no call and writes the same signals.json. A Signal with no new occurrence in the next 20 analyzed sessions of the same agent and repo is quiet, which is not evidence a fix worked.
- score matches by code, never a model: a prediction matches a label in the same session with the same component (type, and name compared after Unicode, case, camelCase and separator normalization) whose top-3 type ids share one id, under a maximum one-to-one matching. Unmatched items count against precision or recall; a rate with nothing to divide by prints —. Without --pred, each diagnosed session flag is a prediction with no component, so it matches on session and type ids alone, and per-flag precision is reported. score writes nothing.

### `coding.sh refine propose`

Ask a model for lines that address your sessions' most severe flags; stores them as a candidate.

```text
coding.sh refine propose [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` |  | Who proposes, answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex) One of: `anthropic`, `openai`, `openai-compatible`, `claude-code`, `codex`. |
| `--base-url <URL>` |  | API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's) |
| `--proposer-model <MODEL>` |  | Model that writes the edit (default: --judge-model, else --model, else claude-sonnet-5-5 or gpt-6-sol) |
| `--proposer-command <CMD>` |  | Shell command that writes the edit instead of the proposer model: the prompt on stdin, the JSON reply on stdout (e.g. 'claude -p') |
| `--target <PATH>` |  | Harness file the proposal edits, or a skill directory for its SKILL.md (default: AGENTS.md, else the repo's Claude Code or Gemini instructions file) |
| `--mined <FILE>` |  | Also show the proposer the patterns in this file (the output of refine mine --json) |
| `--dry-run` |  | Print the findings and the prompt; make no model call. |

```sh
coding.sh refine propose
coding.sh refine propose --target AGENTS.md --dry-run
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
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. Takes a comma list too (a,b). |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` |  | Who proposes, answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex) One of: `anthropic`, `openai`, `openai-compatible`, `claude-code`, `codex`. |
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
| `--suite <NAME>` |  | Judge candidates on this eval suite of repo tasks (evals/&lt;NAME&gt;) instead of mined decision points; a skill --target uses evals/&lt;skill&gt; when it exists. |
| `--objective <OBJ[,OBJ]>` |  | With --suite: what to improve, primary first: pass, cost, tokens, wall, llm, turns, size (default: pass). The pass rate must hold within --margin whatever the list. Repeatable. Takes a comma list too (a,b). |
| `--margin <SHARE>` | `2pp` | With --suite: how far the pass rate may drop for a cheaper or faster candidate to be kept, e.g. 5pp. |
| `--min-gain <SHARE>` | `10%` | With --suite: smallest relative gain in cost, tokens, time, turns or size that counts, e.g. 20%. |
| `--max-cost-rise <RISE>` | `50%` | With --suite: how far a listed cost, tokens, time, turns or size objective may rise for a significant pass-rate gain, e.g. 100%, or none (default: refine.maxCostRise, else 50%) |
| `--harness <BUNDLE>` |  | With --suite: stored harness bundle the suite runs, the repo's harness files laid over it (default: the suite's, else a snapshot of the repo) |
| `--reuse <WHAT>` | `none` | With --suite: copy earlier rounds' finished runs of the unchanged base arm (baseline) or both arms (both) instead of running them again; the pair then did not run interleaved, so the round warns about drift (default: none) One of: `baseline`, `both`, `none`. |
| `--reuse-max-age <AGE>` |  | With --reuse: only copy runs that finished this recently, e.g. 3d or 12h (default: 7d) |
| `--canary-model <MODEL>` |  | With --suite: re-run a kept candidate's two arms under this cheaper model and reject it on a regression there (default: [refine] canary_model) |
| `--canary <WHEN>` | `subtractive` | With --suite: which kept candidates the canary re-tests: the ones that delete or reword existing lines (subtractive), every one (all), or none (off) One of: `subtractive`, `all`, `off`. |
| `--canary-delta <SHARE>` | `10pp` | With --canary-model: how far the canary pass rate's lower bound may fall before the candidate is rejected, e.g. 10pp. |
| `--resume [<ID>]` |  | Continue an interrupted round: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |
| `--dry-run` |  | Show the checks, decision points, guard set size and cost estimate; make no model calls. |

```sh
coding.sh refine test ./drafts/AGENTS.md
coding.sh refine test r_3f9a1c02e1 --behavior unverified-claim --max-cost 2
coding.sh refine test ./a/AGENTS.md ./b/AGENTS.md --dry-run --json
coding.sh refine test ./drafts/AGENTS.md --suite fixes --objective cost,wall --margin 2pp --yes
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

Every round in this repo: verdict, effect CI, guard result, cost and reason, and whether the loop plateaued; --suite climbs show pass rate, cost, time and size per round and the Pareto front.

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
| `--rounds <N>` |  | Most rounds (default: 3, none with --until-plateau) |
| `--candidate <FILE|r_…>` |  | Test these in order instead of asking the proposer (repeatable) |
| `--until-plateau` |  | With --suite: keep climbing until the e-detector says the climb stopped gaining; --resume continues an interrupted round. |
| `--proposer-model <MODEL>` |  | Model that writes the edit (default: --judge-model, else --model, else claude-sonnet-5-5 or gpt-6-sol) |
| `--mined <FILE>` |  | Also show the proposer the patterns in this file (the output of refine mine --json) |
| `--proposer-command <CMD>` |  | Shell command that writes the edit instead of the proposer model: the prompt on stdin, the JSON reply on stdout (e.g. 'claude -p') |
| `--target <PATH>` |  | Harness file the proposal edits, or a skill directory for its SKILL.md (default: AGENTS.md, else the repo's Claude Code or Gemini instructions file) |
| `--behavior <ID[,ID]>` |  | Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all) Repeatable. Takes a comma list too (a,b). |
| `--anchor <FILE>` |  | Module exporting your own anchor(s) (see the evals guide) Repeatable. |
| `--since <DURATION|DATE>` | `14d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--provider <NAME>` |  | Who proposes, answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex) One of: `anthropic`, `openai`, `openai-compatible`, `claude-code`, `codex`. |
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
| `--suite <NAME>` |  | Judge candidates on this eval suite of repo tasks (evals/&lt;NAME&gt;) instead of mined decision points; a skill --target uses evals/&lt;skill&gt; when it exists. |
| `--objective <OBJ[,OBJ]>` |  | With --suite: what to improve, primary first: pass, cost, tokens, wall, llm, turns, size (default: pass). The pass rate must hold within --margin whatever the list. Repeatable. Takes a comma list too (a,b). |
| `--margin <SHARE>` | `2pp` | With --suite: how far the pass rate may drop for a cheaper or faster candidate to be kept, e.g. 5pp. |
| `--min-gain <SHARE>` | `10%` | With --suite: smallest relative gain in cost, tokens, time, turns or size that counts, e.g. 20%. |
| `--max-cost-rise <RISE>` | `50%` | With --suite: how far a listed cost, tokens, time, turns or size objective may rise for a significant pass-rate gain, e.g. 100%, or none (default: refine.maxCostRise, else 50%) |
| `--harness <BUNDLE>` |  | With --suite: stored harness bundle the suite runs, the repo's harness files laid over it (default: the suite's, else a snapshot of the repo) |
| `--reuse <WHAT>` | `none` | With --suite: copy earlier rounds' finished runs of the unchanged base arm (baseline) or both arms (both) instead of running them again; the pair then did not run interleaved, so the round warns about drift (default: none) One of: `baseline`, `both`, `none`. |
| `--reuse-max-age <AGE>` |  | With --reuse: only copy runs that finished this recently, e.g. 3d or 12h (default: 7d) |
| `--canary-model <MODEL>` |  | With --suite: re-run a kept candidate's two arms under this cheaper model and reject it on a regression there (default: [refine] canary_model) |
| `--canary <WHEN>` | `subtractive` | With --suite: which kept candidates the canary re-tests: the ones that delete or reword existing lines (subtractive), every one (all), or none (off) One of: `subtractive`, `all`, `off`. |
| `--canary-delta <SHARE>` | `10pp` | With --canary-model: how far the canary pass rate's lower bound may fall before the candidate is rejected, e.g. 10pp. |
| `--resume [<ID>]` |  | Continue an interrupted round: finished trials are kept, only the rest run (no ID: the newest unfinished one with the same config) |
| `--retries <N>` | `3` | Retries per trial after a rate limit, 5xx or network error, with backoff; a failed setup step is retried once and a refused login never (failures are never retried) |
| `--stop-after-infra <N>` | `5` | Stop once N trials in a row fail on infrastructure after their retries (a refused login, a failed setup, rate limits, 5xx, network): no new trial starts and the run is no quality verdict; 0 never stops. |
| `--trial-timeout <SEC>` |  | Time limit per trial, retries included; a trial over it fails. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |
| `--dry-run` |  | Show the findings, decision points, guard set size and per-round estimate; make no model calls. |

```sh
coding.sh refine run --rounds 5 --max-cost 10
coding.sh refine run --candidate ./v1/AGENTS.md --candidate ./v2/AGENTS.md
coding.sh refine run --dry-run
coding.sh refine run --suite fixes --objective cost --margin 2pp --until-plateau --yes
coding.sh refine run --target .claude/skills/pdf --objective wall,cost --proposer-command 'claude -p' --yes
coding.sh refine run --suite fixes --objective cost --until-plateau --resume --yes
```

### `coding.sh refine protected`

List the harness lines an edit may not delete, reword or relax.

```text
coding.sh refine protected [options]
```

| Option | Default | Description |
|---|---|---|
| `--a <FILE|DIR|git:REV|BUNDLE>` |  | Harness to read (default: the repo's current AGENTS.md and other instructions files, rules and skills) |

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

### `coding.sh refine mine`

Rank failure patterns across sessions: repeated error lines, repeated instructions you typed, flags and failed eval runs, with counts and example sessions ($0).

```text
coding.sh refine mine [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <DURATION|DATE>` | `30d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory, and eval runs of tasks that start from it or of the suites under its evals/ (default: this git repo) |
| `--min-support <SESSIONS[,DAYS]>` | `3,2` | Keep a pattern seen in at least this many sessions over this many days. |
| `-n, --limit <N>` | `20` | Most patterns shown. |

```sh
coding.sh refine mine
coding.sh refine mine --since 90d --repo all --json
coding.sh refine mine --min-support 2,1 --agent codex
```

### `coding.sh refine recheck`

Re-run a suite round's base and candidate under another model (a canary) and record the verdict; suggests a rollback when the edit regresses there.

```text
coding.sh refine recheck <CANDIDATE> [options]
```

| Argument | Required | Description |
|---|---|---|
| `candidate` | yes | The round's r_… id. |

| Option | Default | Description |
|---|---|---|
| `--model <MODEL>` |  | The model to re-run under (default: [refine] canary_model) |
| `--trials <N>` |  | Runs per task and arm (default: the suite's trials, else 3) |
| `--canary-delta <SHARE>` | `10pp` | How far the pass rate's lower bound may fall before it counts as a regression. |
| `--max-cost <USD>` |  | Stop starting runs once agent spend reaches this; the recheck is then inconclusive. |
| `--concurrency <N>` | `4` | Agent sessions at once. |
| `--dry-run` |  | Print what would run; start no agent. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh refine recheck r_3f9a1c02e1 --model claude-haiku-4-5
coding.sh refine recheck r_3f9a1c02e1 --model gpt-5-mini --max-cost 3 --yes --json
```

### `coding.sh refine distill`

Hand a coding agent the raw runs of an experiment (or this repo's recent sessions) to analyze with its own code and write one skill; the skill is checked by the critics and ledgered as a candidate for refine test.

```text
coding.sh refine distill [options]
```

| Option | Default | Description |
|---|---|---|
| `--experiment <ID>` |  | Distill from this experiment's runs (default: captured sessions) |
| `--since <DURATION|DATE>` | `30d` | Without --experiment: sessions started since. |
| `--agent <AGENT>` |  | Without --experiment: only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Without --experiment: only sessions under this directory (default: this git repo) |
| `--distiller <AGENT>` | `claude-code` | The coding agent that analyzes the corpus. One of: `claude-code`, `codex`. |
| `--model <MODEL>` |  | The distiller's model (default: the agent's own) |
| `--n <N>` | `1` | Independent skills to draw, each in its own directory. |
| `--max-cost <USD>` | `5` | Start no new draw once distiller spend reaches this. |
| `--min-episodes <N>` | `20` | Refuse a corpus with fewer episodes. |
| `--min-failures <N>` | `5` | Refuse a corpus with fewer failing or flagged episodes. |
| `--keep-corpus <DIR>` |  | Write the corpus here and keep it: an empty or new directory, or one that holds only an earlier corpus, which is replaced. Nothing is written there with --dry-run. |
| `--dry-run` |  | Write the corpus to a temp dir, print its counts and the plan; start no agent. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh refine distill --experiment exp_01J9Z --dry-run
coding.sh refine distill --experiment exp_01J9Z --n 3 --yes
coding.sh refine distill --since 60d --agent codex --distiller codex --keep-corpus ./corpus --yes --json
```

### `coding.sh refine diagnose`

Diagnose recent sessions with a model into Signals: cited problems grouped into issues, severity scored by code. Without an API key it prints a $0 plan.

```text
coding.sh refine diagnose [options]
```

| Option | Default | Description |
|---|---|---|
| `--since <DURATION|DATE>` | `7d` | Sessions started since. |
| `--agent <AGENT>` |  | Only sessions of this agent (repeatable, or a comma list) |
| `--repo <DIR|all>` |  | Only sessions under this directory (default: this git repo) |
| `--session <ID>` |  | Exactly these sessions: an id, a prefix or latest (repeatable; ignores --since, --repo and --agent) Takes a comma list too (a,b). |
| `--max-sessions <N>` | `50` | Most sessions diagnosed, newest first. |
| `--budget-tokens <N>` |  | Stop starting uncached sessions past this many estimated input tokens; the next run picks up the rest. |
| `--provider <PROVIDER>` |  | anthropic, openai, claude-code or codex (default: the API whose key is set; with none, a $0 plan) |
| `--model <MODEL>` |  | The diagnosing model (default: the provider's current one) |
| `--concurrency <N>` | `4` | Sessions diagnosed at once. |
| `--no-split` |  | One Signal per component and type, with no grouping call. |
| `--include-runs` |  | Also diagnose eval-run sessions. |
| `--dry-run` |  | Print the plan and make no call. |

```sh
coding.sh refine diagnose
coding.sh refine diagnose --since 30d --budget-tokens 400000
coding.sh refine diagnose --session 7f3a9c --provider claude-code --json
```

### `coding.sh refine signals`

List the Signals refine diagnose wrote, or show one with its cited evidence and fix.

```text
coding.sh refine signals [show] [id]
```

| Argument | Required | Description |
|---|---|---|
| `show` | no | show &lt;id&gt;: one Signal's occurrences, citations and fix. |
| `id` | no | With show: the Signal id, or a prefix of it. |

```sh
coding.sh refine signals
coding.sh refine signals show 3fa1c2
coding.sh refine signals --json
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
- enrich --gateway cliproxyapi reads CLIProxyAPI's usage queue with its management key (CLIPROXYAPI_MANAGEMENT_KEY). The read removes the records for every other reader, so it runs only when named, never with --dry-run or --offline; coding.sh keeps each record it read until it joins a call.

### `coding.sh gateway status`

Show which agents route through a gateway, key sources and tagged sessions.

```text
coding.sh gateway status [options]
```

| Option | Default | Description |
|---|---|---|
| `--gateway <NAME>` |  | Only this gateway. One of: `vercel`, `openrouter`, `litellm`, `cloudflare`, `portkey`, `helicone`, `requesty`, `ramp`, `truefoundry`, `kong`, `bifrost`, `martian`, `cliproxyapi`. |
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
| `--gateway <NAME>` |  | Only this gateway. One of: `vercel`, `openrouter`, `litellm`, `cloudflare`, `portkey`, `helicone`, `requesty`, `ramp`, `truefoundry`, `kong`, `bifrost`, `martian`, `cliproxyapi`. |
| `-s, --session <ID>` |  | Only this session (repeatable; or latest) Takes a comma list too (a,b). |
| `--since <WHEN>` | `30d` | Sessions after this time: 7d, 12h, 30m, today or a date (local time) |
| `-n, --limit <N>` | `500` | Maximum rows. |
| `--offline` |  | Use only the cache and drained traces; no API calls. |
| `--dry-run` |  | Show the exact changes without writing anything. |
| `--fresh` |  | Wait for every pending capture to be ingested (default: answer after 1.5 s) |

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
| `--compact` |  | Also compact the index and the blob pack (VACUUM), move small blob files into the pack and remove the blob folders that leaves empty. |
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
- Then the search index is merged, and the index and the blob pack (blobs/pack.db) are VACUUMed, so the old bytes leave the files. If another process is reading one of them (the viewer, serve, a sqlite3 shell), its old bytes stay until that process closes: purge says which file and exits 1, and the same purge run again finishes the job. Values shorter than 8 characters are refused. Only the SQLite store is supported.
- A copy of the index kept next to it by an upgrade (index.db.v&lt;N&gt;.bak) or by upgrade-store --restore (index.db.v&lt;N&gt;.undone) holds the value too. Purge deletes these copies instead of rewriting them, so upgrade-store --restore can no longer put one back; --dry-run names them. If one can't be deleted, purge names it and exits 1.
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

## `coding.sh upgrade-store`

Migrate the store for this install, or put back the index from before a migration.

```text
coding.sh upgrade-store [options]
```

| Option | Default | Description |
|---|---|---|
| `--restore` |  | Put back the index kept from before the last migration (index.db.v&lt;N&gt;.bak); the index it replaces is kept too. |
| `-y, --yes` |  | Answer yes to confirmation prompts. An agent passes it only once the user approves. |

```sh
coding.sh upgrade-store
coding.sh upgrade-store --restore
```

- The store's owner is the coding.sh that ~/.coding.sh/bin/cli-path names: init and update write it, and hooks start it. The index migrates on its own only for the owner, and only for a release newer than the coding.sh that last wrote it.
- Migrations are one-way, so an older coding.sh may not open the store after. Every migration first keeps a copy of the index next to it (index.db.v&lt;N&gt;.bak), and this command also makes bin/cli-path name the running coding.sh.
- --restore puts that copy back and keeps the index it replaces (index.db.v&lt;N&gt;.undone). Any coding.sh that knows the copy's schema can run it, including one the migration left unable to open the store.

## `coding.sh version`

Print the version.

```text
coding.sh version
```
