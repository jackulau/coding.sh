# Postgres and ClickHouse stores

`coding.sh serve` keeps sessions in SQLite by default. For more traffic, or to query the data with
your own SQL, point it at Postgres or ClickHouse. Large payloads can go to S3.

## Pick a store

| Store | `CODING_SH_STORE_URL` | Blobs | Pick it when |
| --- | --- | --- | --- |
| SQLite | `sqlite:///data/index.db` (the default) | `file:///data/blobs` | one machine, one team |
| Postgres | `postgres://…` | the same database, or S3 | real traffic, several viewer replicas, the CLI on the team database |
| ClickHouse | `clickhouse://…` or `clickhouses://…` | `file://` or S3, never ClickHouse | many sessions, or analytical SQL over the tables |

Each store other than SQLite is a plugin package, loaded by its name (`coding.sh-store-<scheme>`).
There is nothing to register. The Docker image `ghcr.io/jackulau/coding.sh` includes all three
plugins. Outside Docker, install the one you need next to coding.sh:

| Package | URL scheme |
| --- | --- |
| `coding.sh-store-postgres` | `postgres://`, `postgresql://` |
| `coding.sh-store-clickhouse` | `clickhouse://`, `clickhouses://` |
| `coding.sh-store-s3` | `s3://` (blobs only) |

The viewer, CLI, MCP tools, datasets and experiments all work on the same store URL. Tables are
created and migrated on first start. One serve process writes at a time; the others wait to take
over.

## Postgres

```sh
npm i -g coding.sh coding.sh-store-postgres
export CODING_SH_STORE_URL='postgres://coding:secret@db.internal:5432/coding?sslmode=require'
coding.sh serve
```

With Compose, `deploy/compose/compose.postgres.yml` runs serve and Postgres 17 together. Postgres
is reachable only from serve, on the stack's own network. Set `POSTGRES_PASSWORD` in `.env` before
the first start; Postgres keeps the password it started with.

| URL parameter | Default | Meaning |
| --- | --- | --- |
| `schema` | `public` | Created if missing. Separate deployments can share a database with separate schemas. |
| `pool_max` | `10` | Connections in the pool. The writer lock uses one more. |
| anything else | | Passed to the `pg` driver as is: `sslmode`, `host=/socket/dir`, and so on. |

- Blobs are stored in the same database, as zstd-compressed rows. Set `CODING_SH_BLOB_URL` to an
  `s3://` URL to keep them in object storage instead.
- The writer lock is a session advisory lock. serve needs a direct connection or a session-mode
  pooler; a transaction-mode pooler drops it.
- Search uses a GIN-indexed `tsvector` and needs no extensions. `--where` filters run in the
  database.
- Statements time out after 30 s.

People with database access can run the CLI against the team database. With `--store`, local
spool files are not pushed into it:

```sh
coding.sh sessions --store 'postgres://coding:…@db-host:5432/coding' --project alice
```

The Postgres password grants full access to the data, so most of the team should use the viewer.

:::more The tables
`events`, `sessions`, `cursors`, `tasks`, `bundles`, `runs`, `labels`, `kv`, `datasets`,
`dataset_latest`, `experiments`, `judges` and `blobs`, plus `coding_sh_migrations`. `events` and
`sessions` carry `project_id` (`default` when unset). JSON fields are `text` holding JSON, so
`stats::jsonb->>'events'` works in your own SQL. Retries and replays never write an event twice.
:::

## ClickHouse

There are two ways to use ClickHouse, and they can run together:

| | Store plugin | Collector route |
| --- | --- | --- |
| What goes to ClickHouse | Everything coding.sh stores: sessions, events, search text, eval assets | Span metadata only, in the collector's `otel_traces` table |
| Who reads it | coding.sh (viewer, CLI, MCP) and your own SQL | Your own SQL or Grafana; `coding.sh collector import` can pull agent traces back |
| What runs | `coding.sh serve` with a `clickhouse://` store URL | Your OpenTelemetry Collector with the `clickhouse` exporter |
| Pick it when | ClickHouse is the database you want coding.sh to run on | You already collect traces into ClickHouse |

### Run the server on ClickHouse

```sh
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped \
  -e CODING_SH_STORE_URL='clickhouses://coding:pass@ch.example.com:8443/coding' \
  -e CODING_SH_BLOB_URL='file:///data/blobs' \
  ghcr.io/jackulau/coding.sh
```

With Compose: `deploy/compose/compose.clickhouse.yml` runs serve and ClickHouse together, with
blobs on the `coding-sh-data` volume. Set `CLICKHOUSE_PASSWORD` in `.env` before the first start.

| URL part | Default | Meaning |
| --- | --- | --- |
| scheme | | `clickhouse` is HTTP, `clickhouses` is HTTPS. `?secure=1` also turns on HTTPS. |
| port | `8123`, or `8443` with TLS | The HTTP interface, not the native port 9000. |
| user, password | `default`, empty | Errors show the password as `***`. |
| path | `default` | The database. Created if missing. |
| anything else | | Passed to ClickHouse as a setting, such as `select_sequential_consistency=1`. |

- Blobs never go to ClickHouse. Keep them on `file://` or on S3.
- Each table is a `ReplacingMergeTree`, and every read uses `FINAL`, so the newest row wins.
  `coding.sh gc --compact` runs `OPTIMIZE TABLE … FINAL`.
- serve takes a 30-second lease in the `locks` table, so one replica writes. If the writer dies,
  another takes over within 30 s.
- Queries time out after 30 s.

:::more What ClickHouse does not support
- **Transactions.** Ingest writes events before it moves its cursors, so a crash replays rather
  than loses. Re-parsing a session inserts the new rows before it deletes the old ones, so a reader
  in between can see both.
- **More than one writer.** Two processes writing at once can over-count session stats. The lease
  prevents this for serve.
- **Replicated DDL.** Tables use plain MergeTree engines. On a self-managed cluster, create the
  database with the `Replicated` engine before the first start. ClickHouse Cloud converts the
  tables to SharedMergeTree; add `?select_sequential_consistency=1` for read-after-write across
  replicas.
:::

### Export to ClickHouse through an OpenTelemetry Collector

If your traces already go through the Collector's `clickhouse` exporter, send coding.sh sessions
there too. coding.sh keeps its own store, and an otlp sink copies each session's spans to the
collector, which writes them to `otel.otel_traces`. You query that table; coding.sh does not read
it.

`deploy/clickhouse/` has a working pair, `otel-collector.yaml` and `docker-compose.yml`, with pinned
images and ports on 127.0.0.1:

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
every trace it commits.

Point a sink or the forward at a collector, not back at the coding.sh server whose sessions it
sends. Spans that come back over `/v1/traces` are stored as new events of the same session, so
its tool calls, model calls and weight edits are counted twice.

#### The span table

What lands in `otel_traces`, with `ServiceName = 'coding.sh'`:

| `SpanName` | One per | Attributes (`SpanAttributes['…']`) |
| --- | --- | --- |
| `invoke_agent <agent>` | session (an open one can have several rows) | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.conversation.id` (the session id), `gen_ai.usage.*`, `coding_sh.cost_usd`, `coding_sh.stats.*` (events, turns, tool_calls, tool_errors, files_changed, tests_passed, tests_failed), `coding_sh.session.flags`, `vcs.ref.head.revision` |
| `execute_tool <tool>` | tool call | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.name`; `StatusCode` is `Error` when the call failed |
| `chat <model>` | model call | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.*`, `coding_sh.cost_usd` |
| `weights.edit` | weight edit | under `coding_sh.weights.`: `changed`, `l2` and `max_abs`; `mode = "full"` adds `tensor`, `shape`, `base_sha256`, `edited_sha256` and `note` |
| `weights.checkpoint` | weights checkpoint | under `coding_sh.weights.`: `sha256` and `base_sha256`, the hashes of the saved file and of its base; `mode = "full"` adds `note` |

`gen_ai.usage.*` is `input_tokens`, `output_tokens`, `cache_read.input_tokens` and
`cache_write.input_tokens`. `input_tokens` is the whole prompt, cache included; the uncached part
is `coding_sh.usage.uncached_input_tokens`. A call with reasoning tokens also gets
`reasoning.output_tokens`. A session's spans share one `TraceId`, subagents join their parent's
trace, and `Duration` is in nanoseconds.

- Map columns store every attribute as a string: cast with `toFloat64OrZero` and `toUInt64OrZero`.
  `coding_sh.session.flags` is a JSON array string.
- Cost is on the `invoke_agent` span (the session) and on each `chat` span. Sum one, never both.
- A session that edited weights also has `weight_edits` and `weights_changed` under `coding_sh.stats.`, and one `weights.edit` span per edit. Each checkpoint it recorded is one `weights.checkpoint` span.
- `mode = "full"` adds prompts, code and tool output as span attributes.
- The `invoke_agent` span is sent when the session ends. `coding.sh serve` and `coding.sh collector`
  also send it while a session is open: after 10 quiet seconds, and every 60 seconds while busy.
- Each send is a new row with the same `TraceId` and `SpanId` and newer totals. A session keyed by
  a conversation id never ends, so those are its only rows.
- The queries below keep the row with the most events (`coding_sh.stats.events`) for each span.
- A laptop sink (`coding.sh ingest`) sends the span at the session's end only.
- `ttl: 720h` drops rows after 30 days. Set it to your retention.

#### Sample queries

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
- It keeps its place per table and row filter. The next run starts an hour before it. `--since` or
  `--from-start` reads from that time again; leave both out of a scheduled import.
- It stores 5,000 rows at a time and retries a dropped connection or a 502, 503 or 504 three
  times. A run that still fails prints the command to run again.
- Both the default `Map(String, String)` columns and `json: true` columns work.

Every flag is on [coding.sh collector](https://coding.sh/docs/cli/collector).

## S3 blobs

`coding.sh-store-s3` keeps blobs (large prompts, tool output and transcripts) in AWS S3,
Cloudflare R2, MinIO or any S3-compatible endpoint:

```sh
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
export CODING_SH_BLOB_URL='s3://my-bucket/blobs?region=us-east-1'
# R2:    s3://bucket/blobs?region=auto&endpoint=https://<account>.r2.cloudflarestorage.com
# MinIO: s3://bucket/blobs?endpoint=http://127.0.0.1:9000
```

- Credentials come only from the environment. A URL with credentials in it is refused.
- Parameters: `region` (default `AWS_REGION`, then `us-east-1`), `endpoint` (default
  `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`) and `style=path|virtual`.
- The credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on
  the bucket and prefix.

## Next

- [Self-host for a team](../how-to/self-host-team.md): one server for the team's agents.
- [Deploy coding.sh serve](../production/deploy.md): Compose, Fly.io, Railway, Render and serverless.
- [Configuration](config.md#serve): every `[serve]` key and its environment variable.
