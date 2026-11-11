# Self-host for a team

Run one `coding.sh serve` that the whole team sends sessions to and reads from. One port (4318)
takes OpenTelemetry traces and sessions from each developer's agents, and serves the viewer and the
API.

## Quickstart

**1. Run the server** on any machine with Docker that your team can reach:

```sh
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped ghcr.io/jackulau/coding.sh
docker logs coding-sh
```

The first start makes a read key and an ingest key, keeps them in the `coding-sh` volume, and
prints them. Every later start prints the same keys:

```text
http://127.0.0.1:4318
No keys are configured, so serve uses the keys in /data/serve-keys.json (made now):
  read key    csh_rk_…
  ingest key  csh_ik_…
  Open        http://127.0.0.1:4318/?t=csh_rk_…
  Connect     coding.sh init --remote http://127.0.0.1:4318 --key csh_ik_…
```

The URLs are the address inside the container. Use the server's own host name or IP instead.

**2. Connect each developer's machine** with the ingest key:

```sh
coding.sh init --remote http://<server>:4318 --key csh_ik_…
```

New sessions from the coding agents on that machine now go to the server too, as metadata (no
prompts, code or tool output). Install coding.sh first if needed:
`curl -fsSL https://coding.sh/install | sh`.

**3. Open the viewer** at `http://<server>:4318/?t=csh_rk_…`, or open `http://<server>:4318` and
paste the read key into the form.

| Key | Can | Give it to |
| --- | --- | --- |
| ingest (`csh_ik_…`) | only send; sessions land in the `default` project | developers and apps |
| read (`csh_rk_…`) | open the viewer, the API (`Authorization: Bearer csh_rk_…`) and `/metrics` | people who read |

Keys are made only when no key and no viewer login is configured. To make new ones, delete
`serve-keys.json` from the volume and restart; the old keys stop working.

## Run it with Compose

`deploy/compose/` has three stacks. None needs edits; optional settings go in
`deploy/compose/.env` (copy [`.env.example`](../../deploy/compose/.env.example)).

| File | Store | Use it when |
| --- | --- | --- |
| `compose.yml` | SQLite on the `coding-sh-data` volume | the default; one team, one machine |
| `compose.postgres.yml` | Postgres 17 in the stack | you want Postgres, or the CLI on the team database |
| `compose.clickhouse.yml` | ClickHouse in the stack, blobs on the volume | you keep a lot of sessions or want SQL over them ([ClickHouse](#clickhouse)) |

From a checkout:

```sh
docker compose -f deploy/compose/compose.yml up -d --wait
docker compose -f deploy/compose/compose.yml logs coding-sh     # the keys and the connect command
```

Only port 4318 is published, not the database ports. `docker-compose.yml` at the repo root is a
different stack, used by the store tests ([production/compose.md](../production/compose.md)).

## Connect

`init --remote` checks the key against the server first, and changes nothing if the server is
unreachable or refuses it. Then it installs the capture hooks, as `coding.sh init` does, and adds a
sink named `team` to `~/.coding.sh/config.toml`. Running it again replaces that sink.

| Option | What it does |
| --- | --- |
| `--remote-mode full` | Also sends prompts, code and tool output, redacted on the machine first. Decide as a team. |
| `CODING_SH_INGEST_KEY=csh_ik_… coding.sh init --remote <url>` | Keeps the key out of shell history. |
| `https://` URL | Use it over the internet ([TLS](#tls)). Plain `http://` sends the key in the clear. |

Sessions are sent when the agent's hook runs at the end of each turn, and whenever a `coding.sh`
command runs. Sessions captured before you connected stay on the machine.

### Connect by hand

This is the block `init --remote` writes. It works on any coding.sh version:

```toml
[[sinks]]
name = "team"
kind = "http"
endpoint = "http://<server>:4318/v1/ingest"
mode = "metadata" # "full" also sends prompts, code and tool output
headers = { Authorization = "Bearer csh_ik_…" }
```

Run `coding.sh ingest`, then look for your session in the viewer.

### Apps and SDKs

Set these where the app runs. The TypeScript and Python SDKs read them:

```sh
CODING_SH_URL=http://<server>:4318
CODING_SH_INGEST_KEY=csh_ik_…
```

A plain OpenTelemetry app uses `OTEL_EXPORTER_OTLP_ENDPOINT=http://<server>:4318` and
`OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20csh_ik_…"`. Never ship an ingest key to a
browser. See [Trace your own agent](trace-your-agent.md).

## Your own keys and one project per person

The project comes from the ingest key. With one key per person, sessions show up as
`alice/<id>`, and `GET /api/sessions?project=alice` filters by person:

```sh
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project alice
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project '*' --read
```

Each command prints the key once on stdout, and on stderr the setting that holds only its sha256
hash. Give each key to its owner, and put the hashes in `deploy/compose/.env` (or pass them with
`-e`):

```sh
CODING_SH_INGEST_KEYS=alice:sha256:<hex>,bob:sha256:<hex>,billing-api:sha256:<hex>
CODING_SH_READ_KEYS=*:sha256:<hex>
```

Set both, or serve refuses to start on a public address. Then run
`docker compose -f deploy/compose/compose.yml up -d` again. To revoke a key, remove its hash and
restart. Per-project retention and a shared viewer login are in [guides/team.md](../guides/team.md).

## TLS

serve speaks plain HTTP. On the internet, put a proxy in front and keep 4318 on the loopback
interface. With Caddy, which gets the certificate itself:

```sh
# deploy/compose/.env
CODING_SH_PUBLISH=127.0.0.1:4318
CODING_SH_TRUST_PROXY=1
```

```caddyfile
obs.example.com {
	reverse_proxy 127.0.0.1:4318
}
```

Then connect with `coding.sh init --remote https://obs.example.com --key csh_ik_…`. Fly, Railway
and Render terminate TLS for you ([production/](../production/README.md)).

## Data, backups and upgrades

| Task | How |
| --- | --- |
| Find the data | `index.db`, `blobs/` and `serve-keys.json` in the volume; Postgres in `pgdata`, ClickHouse in `chdata` |
| Back up | Copy the volumes or the database. For SQLite, stop the container first (below) |
| Upgrade | `docker pull ghcr.io/jackulau/coding.sh` and run it again, or Compose `pull` and `up -d`. The schema migrates on start |
| Pin a version | `ghcr.io/jackulau/coding.sh:0.1.2`, or `CODING_SH_IMAGE` in `.env` |
| Check health | `curl -s http://<server>:4318/readyz` answers `{"ok":true,…}` once the store is ready |
| Delete old sessions | `CODING_SH_RETENTION_DAYS=30` deletes sessions older than 30 days, every hour |

```sh
docker stop coding-sh && docker run --rm -v coding-sh:/data -v "$PWD":/backup alpine tar czf /backup/coding-sh.tgz -C /data . && docker start coding-sh
```

## Read from the CLI

People with database access can run the CLI and MCP tools against the team database. This needs
the `coding.sh-store-postgres` package next to coding.sh. With `--store`, local spool files are not
pushed into the shared database:

```sh
coding.sh sessions --store 'postgres://coding:…@db-host:5432/coding' --project alice
```

## ClickHouse

There are two ways to use ClickHouse, and they can run together:

| | Store plugin | Collector route |
| --- | --- | --- |
| What goes to ClickHouse | Everything coding.sh stores: sessions, events, search text, eval assets | Span metadata only, in the collector's `otel_traces` table |
| Who reads it | coding.sh (viewer, CLI, MCP) and your own SQL | Your own SQL or Grafana; `coding.sh collector import` can pull agent traces back |
| What runs | `coding.sh serve` with `--store clickhouse://…` | Your OpenTelemetry Collector with the `clickhouse` exporter |
| Pick it when | ClickHouse is the database you want coding.sh to run on | You already collect traces into ClickHouse |

### Run the server on ClickHouse

Pick ClickHouse when your team already runs it, keeps a lot of sessions, or wants analytical SQL
over the tables coding.sh reads. Pick Postgres for a small team, or for transactional writes.

```sh
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped \
  -e CODING_SH_STORE_URL='clickhouses://coding:pass@ch.example.com:8443/coding' \
  -e CODING_SH_BLOB_URL='file:///data/blobs' \
  ghcr.io/jackulau/coding.sh
```

With Compose: `docker compose -f deploy/compose/compose.clickhouse.yml up -d --wait`.

- The image has the plugin. Outside Docker, install `coding.sh-store-clickhouse` next to coding.sh.
- `clickhouse://…:8123/db` is HTTP and `clickhouses://…:8443/db` is HTTPS. The plugin uses the
  HTTP interface, not port 9000.
- Blobs never go to ClickHouse: keep them on `file://` or on S3 with `coding.sh-store-s3`.
- One serve writes at a time; another takes over within 30 s if it dies.

URL parameters, transactions, replication and search are in the
[store plugin's README](../../packages/store-clickhouse/README.md).

### Export to ClickHouse through an OpenTelemetry Collector

If your traces already go through the Collector's `clickhouse` exporter, send coding.sh sessions
there too. coding.sh keeps its own store, and an otlp sink copies each session's spans to the
collector, which writes them to `otel.otel_traces`. You query that table; coding.sh does not read
it.

`deploy/clickhouse/` has a working pair,
[otel-collector.yaml](../../deploy/clickhouse/otel-collector.yaml) and
[docker-compose.yml](../../deploy/clickhouse/docker-compose.yml), pinned, with ports on 127.0.0.1:

```sh
export CLICKHOUSE_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
docker compose -f deploy/clickhouse/docker-compose.yml up -d --wait
```

The collector part of the config, to merge into your own:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000?dial_timeout=10s
    database: otel
    username: ${env:CLICKHOUSE_USER}
    password: ${env:CLICKHOUSE_PASSWORD}
    ttl: 720h
    create_schema: true
    # json: true          # attributes as the JSON type; needs enable_json_type=1 on the server
    sending_queue:
      batch:
        flush_timeout: 5s
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [clickhouse]
```

Then add a sink on each machine that captures sessions. The Compose file publishes the collector
on 4319, so it can share a host with serve on 4318:

```toml
[[sinks]]
kind = "otlp"
name = "clickhouse"
endpoint = "http://collector:4319"
mode = "metadata"
```

On a team, set `CODING_SH_FORWARD_URL=http://collector:4319` on serve instead, and it forwards
every trace it commits ([Forward and sinks](../PRODUCTION.md#19-forward-and-sinks)).

What lands in `otel_traces`, with `ServiceName = 'coding.sh'`:

| `SpanName` | One per | Attributes (`SpanAttributes['…']`) |
| --- | --- | --- |
| `invoke_agent <agent>` | session (an open one can have several rows) | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.conversation.id` (the session id), `gen_ai.usage.*`, `coding_sh.cost_usd`, `coding_sh.stats.*` (events, turns, tool_calls, tool_errors, files_changed, tests_passed, tests_failed), `coding_sh.session.flags`, `vcs.ref.head.revision` |
| `execute_tool <tool>` | tool call | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.name`; `StatusCode` is `Error` when the call failed |
| `chat <model>` | model call | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.*`, `coding_sh.cost_usd` |

`gen_ai.usage.*` is `input_tokens`, `output_tokens`, `cache_read.input_tokens` and
`cache_write.input_tokens`. `input_tokens` is the whole prompt, cache included; the uncached part
is `coding_sh.usage.uncached_input_tokens`. Through 0.1.5 cache writes are also sent as
`cache_creation.input_tokens`, so query `cache_write.input_tokens`. A call with reasoning tokens
also gets `reasoning.output_tokens`. A session's spans share one `TraceId`, subagents join their
parent's trace, and `Duration` is in nanoseconds.

Cost per agent and model per day:

```sql
SELECT
    toDate(Timestamp) AS day,
    SpanAttributes['gen_ai.agent.name'] AS agent,
    SpanAttributes['gen_ai.request.model'] AS model,
    count() AS sessions,
    round(sum(toFloat64OrZero(SpanAttributes['coding_sh.cost_usd'])), 2) AS cost_usd,
    sum(toUInt64OrZero(SpanAttributes['gen_ai.usage.input_tokens'])) AS input_tokens,
    sum(toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS output_tokens
FROM (
    SELECT Timestamp, SpanId, SpanAttributes
    FROM otel.otel_traces
    WHERE ServiceName = 'coding.sh'
      AND SpanAttributes['gen_ai.operation.name'] = 'invoke_agent'
      AND Timestamp >= now() - INTERVAL 30 DAY
    ORDER BY toUInt64OrZero(SpanAttributes['coding_sh.stats.events']) DESC
    LIMIT 1 BY SpanId
)
GROUP BY day, agent, model
ORDER BY day DESC, cost_usd DESC
```

The inner query keeps one row per session: an open session is sent again as it grows (see "Things
to know"), and the row with the most events (`coding_sh.stats.events`) wins.

Slow and failing tools:

```sql
SELECT
    SpanAttributes['gen_ai.tool.name'] AS tool,
    count() AS calls,
    countIf(StatusCode = 'Error') AS errors,
    round(errors / calls, 3) AS error_rate,
    round(quantile(0.95)(Duration) / 1e6) AS p95_ms,
    round(max(Duration) / 1e6) AS max_ms
FROM otel.otel_traces
WHERE ServiceName = 'coding.sh'
  AND SpanAttributes['gen_ai.operation.name'] = 'execute_tool'
  AND Timestamp >= now() - INTERVAL 7 DAY
GROUP BY tool
ORDER BY p95_ms DESC
LIMIT 20
```

Failed sessions: tests failed, or coding.sh flagged repeated tool failures or a premature finish:

```sql
SELECT
    Timestamp AS started,
    SpanAttributes['gen_ai.conversation.id'] AS session,
    SpanAttributes['gen_ai.agent.name'] AS agent,
    toUInt32OrZero(SpanAttributes['coding_sh.stats.tool_errors']) AS tool_errors,
    toUInt32OrZero(SpanAttributes['coding_sh.stats.tests_failed']) AS tests_failed,
    JSONExtract(SpanAttributes['coding_sh.session.flags'], 'Array(String)') AS flags,
    round(Duration / 1e9) AS duration_s
FROM (
    SELECT Timestamp, SpanId, SpanAttributes, Duration
    FROM otel.otel_traces
    WHERE ServiceName = 'coding.sh'
      AND SpanAttributes['gen_ai.operation.name'] = 'invoke_agent'
      AND Timestamp >= now() - INTERVAL 7 DAY
    ORDER BY toUInt64OrZero(SpanAttributes['coding_sh.stats.events']) DESC
    LIMIT 1 BY SpanId
)
WHERE tests_failed > 0 OR hasAny(flags, ['repeated-tool-failure', 'premature-completion'])
ORDER BY started DESC
LIMIT 50
```

One session's spans, in order (`clickhouse-client --param_session=<session id>`):

```sql
SELECT
    Timestamp,
    SpanName,
    round(Duration / 1e6) AS ms,
    StatusCode,
    SpanAttributes['coding_sh.cost_usd'] AS cost_usd
FROM (
    SELECT Timestamp, SpanId, SpanName, Duration, StatusCode, SpanAttributes
    FROM otel.otel_traces
    WHERE TraceId = (
        SELECT any(TraceId) FROM otel.otel_traces
        WHERE SpanAttributes['gen_ai.conversation.id'] = {session:String}
    )
    ORDER BY toUInt64OrZero(SpanAttributes['coding_sh.stats.events']) DESC
    LIMIT 1 BY SpanId
)
ORDER BY Timestamp
```

Things to know:

- Map columns store every attribute as a string: cast with `toFloat64OrZero` and `toUInt64OrZero`.
  `coding_sh.session.flags` is a JSON array string.
- Cost is on the `invoke_agent` span (the session) and on each `chat` span. Sum one, never both.
- `mode = "full"` adds prompts, code and tool output as span attributes.
- The `invoke_agent` span is sent when the session ends. `coding.sh serve` and `coding.sh collector`
  also send it while a session is open: after 10 quiet seconds, and every 60 seconds while busy.
- Each send is a new row with the same `TraceId` and `SpanId` and newer totals. A session keyed by
  a conversation id never ends, so those are its only rows.
- A laptop sink (`coding.sh ingest`) sends the span at the session's end only.
- `ttl: 720h` drops rows after 30 days. Set it to your retention.

### Pull from ClickHouse

If your agents already send traces to a Collector with the `clickhouse` exporter (your own,
ClickStack or HyperDX), `coding.sh collector import` reads them into your local store:

```sh
CLICKHOUSE_USER=otel CLICKHOUSE_PASSWORD=… \
  coding.sh collector import --clickhouse "http://127.0.0.1:8123/?database=otel"
```

- Each row is mapped as a span posted to `coding.sh collector` would be: the same events,
  redaction and pricing.
- It reads only traces with an agent span unless you pass `--all`, and never stores a span twice.
- It keeps its place per table and row filter (`--all`, each `--where`). The next run starts an
  hour before it.
- `--since` or `--from-start` reads from that time again, for a root span that landed over an hour
  late. Leave both out of a scheduled import.
- It stores 5,000 rows at a time and retries a dropped connection or a 502, 503 or 504 three
  times. A run that still fails prints the command to run again.
- Both the default `Map(String, String)` columns and `json: true` columns work. In Map columns a
  string that looks like a number (an id such as `"42"`) comes back as a number.

`--since`, `--from-start`, `--where`, `--table` and `--dry-run` are on
[coding.sh collector](https://coding.sh/docs/cli/collector).

## Next

- [guides/team.md](../guides/team.md): the complete team setup.
- [PRODUCTION.md](../PRODUCTION.md): every serve setting, auth, projects, retention and metrics.
- [Configuration](../reference/config.md#serve): the `[serve]` keys and their env vars.
