# Self-host for a team

Run one `coding.sh serve` that the whole team sends sessions to and reads from. The full guide,
with roles, keys per person and day-two operations, is [guides/team.md](../guides/team.md). This page
is the short path.

## 1. Make keys

```sh
coding.sh serve keygen --project team          # csh_ik_... ingest key, for agents and apps
coding.sh serve keygen --project team --read   # csh_rk_... read key, for people
```

Each command prints the key once on stdout. On stderr it prints the server setting that holds
only the key's sha256 hash, such as `CODING_SH_INGEST_KEYS=team:sha256:<hex>`, so the server never
stores the key itself.

## 2. Run the server on Postgres

```sh
CODING_SH_STORE_URL='postgres://user:pass@db.example.com:5432/coding?sslmode=require' \
CODING_SH_INGEST_KEYS='team:sha256:<hex>' \
CODING_SH_READ_KEYS='team:sha256:<hex>' \
coding.sh serve --host 0.0.0.0
```

Postgres needs the `coding.sh-store-postgres` package installed next to coding.sh; the Docker image
already has it. `serve` refuses a non-loopback address without an ingest key and a read key (or basic auth).
Check it with `curl -s http://<host>:4318/readyz`, or `coding.sh serve healthcheck --url http://<host>:4318/readyz`.
Docker, Fly, Railway, Render and Compose recipes are in [production/](../production/README.md).

## 3. Send each person's sessions to it

Each teammate keeps capturing locally and adds a sink to `~/.coding.sh/config.toml`:

```toml
[[sinks]]
kind = "otlp"
endpoint = "https://obs.example.com"
mode = "metadata"                     # the default; "full" also sends prompts, code and tool output
headers = { Authorization = "Bearer ${CODING_SH_INGEST_KEY}" }
```

`${CODING_SH_INGEST_KEY}` is read from the environment, so the key stays out of the file. Decide as
a team whether `mode = "full"` is acceptable before anyone turns it on.

Apps and agents you built send to the same server: set `CODING_SH_URL` and `CODING_SH_INGEST_KEY`
for the SDKs, or point an OpenTelemetry exporter at `https://obs.example.com/v1/traces` with the
same key as a Bearer header. See [Trace your own agent](trace-your-agent.md).

## 4. Read it

- Viewer: open `https://obs.example.com/?t=csh_rk_...` once; the link sets a cookie.
- CLI and MCP against the shared store: `coding.sh sessions --store 'postgres://...' --project team`.
  With `--store`, local spool files are not pushed into the shared database.

## ClickHouse

There are two ways to use ClickHouse. They answer different questions:

| | Store plugin | Collector route |
| --- | --- | --- |
| What goes to ClickHouse | Everything coding.sh stores: sessions, events, search text, eval assets | Span metadata only, in the collector's `otel_traces` table |
| Who reads it | coding.sh (viewer, CLI, MCP) and your own SQL | Your own SQL, Grafana or other tools; coding.sh does not read it back |
| What runs | `coding.sh serve` with `--store clickhouse://…` | Your OpenTelemetry Collector with the `clickhouse` exporter |
| Pick it when | ClickHouse is the database you want coding.sh to run on | You already collect traces into ClickHouse and want coding.sh sessions next to them |

The two can run together: a teammate's config can hold one sink to serve and a second otlp sink to
the collector.

### Run the server on ClickHouse

Pick ClickHouse over Postgres when your team already operates ClickHouse, when you keep a lot of
sessions, or when you want to run analytical SQL over the same tables coding.sh reads. Pick Postgres for a small team, or when you want coding.sh's writes to be
transactional (see the caveats).

```sh
npm i -g coding.sh coding.sh-store-clickhouse      # the plugin goes next to coding.sh; the Docker image has it

CODING_SH_STORE_URL='clickhouses://coding:pass@ch.example.com:8443/coding' \
CODING_SH_BLOB_URL='s3://my-bucket/coding-sh' \
CODING_SH_INGEST_KEYS='team:sha256:<hex>' \
CODING_SH_READ_KEYS='team:sha256:<hex>' \
coding.sh serve --host 0.0.0.0
```

The URL is `clickhouse://user:pass@host:8123/database` for HTTP and `clickhouses://…:8443/…` for
HTTPS (`?secure=1` does the same). The plugin talks to ClickHouse's HTTP interface, not the native
port 9000. The default port is 8123, or 8443 with TLS. A missing database is created, and the
tables are migrated when the store opens. Any other query parameter is passed to ClickHouse as a
setting, for example `?select_sequential_consistency=1`. The same URL works for the CLI and MCP:
`coding.sh sessions --store 'clickhouse://…'`.

Blobs (transcripts, snapshots, large payloads) do not go to ClickHouse. Keep them on `file://`
(one host with a volume) or on S3 with `coding.sh-store-s3` (`CODING_SH_BLOB_URL=s3://…`).

For Compose, `deploy/compose/clickhouse.yml` swaps Postgres for ClickHouse in the stack from
[production/compose.md](../production/compose.md):

```sh
deploy/compose/gen-env.sh        # an older .env needs a CLICKHOUSE_PASSWORD=<hex> line added
docker compose -f docker-compose.yml -f deploy/compose/clickhouse.yml up -d --build --wait
```

Caveats:

- ClickHouse has no multi-statement transactions. Ingest writes events before it advances its
  cursors, so a crash means a replay, not a loss. Re-parsing a session (`ingest --rebuild`)
  inserts the new rows before it deletes the old ones, so a reader can briefly see both.
- Rows are versioned with ReplacingMergeTree, and reads use `FINAL`, so an update is visible at
  once. Old versions take disk space until ClickHouse merges them; `coding.sh gc --compact` runs
  `OPTIMIZE … FINAL`.
- One writer per database. `serve` holds a lease in the `locks` table that it renews every 10 s;
  if the writer dies, another serve takes over within 30 s. Two writers at once can over-count
  session stats.
- Retention deletes use lightweight `DELETE`.
- The tables use plain MergeTree engines. On a self-managed cluster, create the database with the
  `Replicated` engine before the first start. ClickHouse Cloud converts the tables to
  SharedMergeTree itself; add `?select_sequential_consistency=1` so a read sees the write before it.
- Search matches word prefixes, like the other stores, on a column with an ngram bloom filter index.

### Export to ClickHouse through an OpenTelemetry Collector

If your traces already go through the OpenTelemetry Collector's `clickhouse` exporter, send
coding.sh sessions there too. coding.sh keeps its own store (SQLite on each laptop, or a shared
serve) and an otlp sink copies each session's spans to the collector, which writes them to
`otel.otel_traces`. You query that table yourself; coding.sh does not read it.

`deploy/clickhouse/` has a working pair, [otel-collector.yaml](../../deploy/clickhouse/otel-collector.yaml)
and [docker-compose.yml](../../deploy/clickhouse/docker-compose.yml) (ClickHouse and
`otel/opentelemetry-collector-contrib`, pinned, ports on 127.0.0.1):

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

Then add a sink on each machine that captures sessions. Sinks run where sessions are ingested, not
in `coding.sh serve`:

```toml
[[sinks]]
kind = "otlp"
name = "clickhouse"
endpoint = "http://collector:4319"
mode = "metadata"
```

The Compose file publishes the collector on 4319 so it can share a host with `coding.sh serve` on
4318. Use whatever host and port your collector listens on.

What lands in `otel_traces`, with `ServiceName = 'coding.sh'`:

| `SpanName` | One per | Attributes (`SpanAttributes['…']`) |
| --- | --- | --- |
| `invoke_agent <agent>` | session | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.conversation.id` (the session id), `gen_ai.usage.*`, `coding_sh.cost_usd`, `coding_sh.stats.*` (turns, tool_calls, tool_errors, files_changed, tests_passed, tests_failed), `coding_sh.session.flags`, `vcs.ref.head.revision` |
| `execute_tool <tool>` | tool call | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.name`; `StatusCode` is `Error` when the call failed |
| `chat <model>` | model call | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.*`, `coding_sh.cost_usd` |

`gen_ai.usage.*` is `input_tokens`, `output_tokens`, `cache_read.input_tokens` and
`cache_creation.input_tokens`. A session's spans share one `TraceId`, and subagent sessions join
their parent's trace. `Duration` is in nanoseconds.

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
FROM otel.otel_traces
WHERE ServiceName = 'coding.sh'
  AND SpanAttributes['gen_ai.operation.name'] = 'invoke_agent'
  AND Timestamp >= now() - INTERVAL 30 DAY
GROUP BY day, agent, model
ORDER BY day DESC, cost_usd DESC
```

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
FROM otel.otel_traces
WHERE ServiceName = 'coding.sh'
  AND SpanAttributes['gen_ai.operation.name'] = 'invoke_agent'
  AND Timestamp >= now() - INTERVAL 7 DAY
  AND (tests_failed > 0 OR hasAny(flags, ['repeated-tool-failure', 'premature-completion']))
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
FROM otel.otel_traces
WHERE TraceId = (
    SELECT any(TraceId) FROM otel.otel_traces
    WHERE SpanAttributes['gen_ai.conversation.id'] = {session:String}
)
ORDER BY Timestamp
```

Things to know:

- The exporter's default Map columns store every attribute as a string, so cast with
  `toFloat64OrZero` and `toUInt64OrZero`. A list attribute such as `coding_sh.session.flags` is a
  JSON array string.
- Cost sits on both the `invoke_agent` span (the session total) and each `chat` span (one model
  call). Sum one operation, never both, or the cost doubles.
- `mode = "metadata"` sends no prompts, code or tool output. `mode = "full"` adds them as span
  attributes, so the table then holds what your agents read and wrote.
- The `invoke_agent` span is sent when the session ends, so a session that is still running has
  tool and chat rows but no session row yet. Its `Timestamp` is the session's start.
- `ttl: 720h` drops rows after 30 days. Set it to your retention.

## Next

- [guides/team.md](../guides/team.md): the complete team setup.
- [PRODUCTION.md](../PRODUCTION.md): every serve setting, auth, projects, retention and metrics.
- [Configuration](../reference/config.md#serve): the `[serve]` keys and their env vars.
