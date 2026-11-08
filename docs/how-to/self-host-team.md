# Self-host for a team

One `coding.sh serve` that the whole team sends sessions to and reads from. One port (4318) takes
OpenTelemetry traces, sessions from each developer's agents, and serves the viewer and the API.

## Quickstart

**1. Run the server** on any machine with Docker that your team can reach:

```sh
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped ghcr.io/jackulau/coding.sh
docker logs coding-sh
```

The first start makes a read key and an ingest key, keeps them in the `coding-sh` volume, and
prints them with the two commands below. Every later start prints the same keys.

**2. Connect each developer's machine** with the ingest key:

```sh
coding.sh init --remote http://<server>:4318 --key csh_ik_…
```

New sessions from the coding agents on that machine now go to the server too, as metadata (no prompts,
code or tool output). Install coding.sh first if needed: `curl -fsSL https://coding.sh/install | sh`.

**3. Open the viewer** at `http://<server>:4318/?t=csh_rk_…` with the read key, or open
`http://<server>:4318` and paste the read key into the form.

### Before the first tagged release

The image and `init --remote` ship in coding.sh 0.1.2. Until that release is tagged,
`docker pull ghcr.io/jackulau/coding.sh` fails with "manifest unknown". Build the image from a
checkout, then run step 1 unchanged:

```sh
git clone https://github.com/jackulau/coding.sh && cd coding.sh
docker build -t ghcr.io/jackulau/coding.sh .
```

On coding.sh 0.1.1, connect a machine by adding the block from [Connect by hand](#connect-by-hand)
to `~/.coding.sh/config.toml`.

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

Compose pulls `ghcr.io/jackulau/coding.sh:latest`. Before the image is published the pull is
denied and Compose builds it from the checkout instead. The database ports are not published; only
4318 is. `docker-compose.yml` at the repo root is a different stack, with S3 blobs and fixed test
projects, used by the store tests ([production/compose.md](../production/compose.md)).

## What the server prints

```text
http://127.0.0.1:4318
No keys are configured, so serve uses the keys in /data/serve-keys.json (made now):
  read key    csh_rk_…
  ingest key  csh_ik_…
  Open        http://127.0.0.1:4318/?t=csh_rk_…
  Connect     coding.sh init --remote http://127.0.0.1:4318 --key csh_ik_…
```

The URLs are the address inside the container. Use the server's own host name or IP in their place.

- The **ingest key** can only send. Give it to developers and apps. Sessions sent with it land in
  the `default` project.
- The **read key** opens the viewer, the API (`Authorization: Bearer csh_rk_…`) and `/metrics`.
  Give it to people who read.
- The keys are only made when no key and no viewer login is configured. Set your own with
  `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS` (both, or serve refuses to start on a public
  address). See [Your own keys](#your-own-keys-and-one-project-per-person).
- To make new keys, delete `serve-keys.json` from the volume and restart. The old keys stop
  working.

## Connect

`coding.sh init --remote <url> --key <ingest key>` checks the key against the server first and
changes nothing if the server is unreachable or refuses it. Then it installs capture hooks for the
agents on the machine, as `coding.sh init` does, and adds a sink named `team` to
`~/.coding.sh/config.toml`. Running it again replaces that sink and keeps the rest of the file.

- `--remote-mode full` also sends prompts, code and tool output. Decide this as a team first.
  Redaction runs on the developer's machine before anything is sent.
- `CODING_SH_INGEST_KEY=csh_ik_… coding.sh init --remote <url>` keeps the key out of shell history.
- Sessions are sent when the agent's hook runs at the end of each turn, and whenever a `coding.sh`
  command runs. Sessions captured before you connected stay on the machine.
- Use `https://` when the server is reached over the internet (see [TLS](#tls)). Plain `http://`
  sends the key in the clear, so keep it to a private network such as a tailnet.

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

Apps and agents you build send to the same server. Set these where the app runs:

```sh
CODING_SH_URL=http://<server>:4318
CODING_SH_INGEST_KEY=csh_ik_…
```

The TypeScript and Python SDKs read them. A plain OpenTelemetry app uses
`OTEL_EXPORTER_OTLP_ENDPOINT=http://<server>:4318` and
`OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20csh_ik_…"`. Never ship an ingest key to a
browser. See [Trace your own agent](trace-your-agent.md).

## Your own keys and one project per person

The project comes from the ingest key. With one key per person, sessions show up as
`alice/<id>`, and `GET /api/sessions?project=alice` filters by person. Make the keys with the image:

```sh
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project alice
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project '*' --read
```

Each command prints the key once on stdout, and on stderr the setting that holds only its sha256
hash. Hand each key to its owner, and put the hashes in `deploy/compose/.env` (or pass them with
`-e` to `docker run`):

```sh
CODING_SH_INGEST_KEYS=alice:sha256:<hex>,bob:sha256:<hex>,billing-api:sha256:<hex>
CODING_SH_READ_KEYS=*:sha256:<hex>
```

Then `docker compose -f deploy/compose/compose.yml up -d` again. To revoke a key, remove its hash
and restart. Retention per project, a shared viewer login and the other settings are in
[guides/team.md](../guides/team.md) and [PRODUCTION.md](../PRODUCTION.md).

## TLS

serve speaks plain HTTP. For a server on the internet, put a proxy in front and keep 4318 on the
loopback interface. With Caddy, which gets the certificate itself:

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

- **What is in the volume.** `index.db` (SQLite), `blobs/` and `serve-keys.json`. With Postgres,
  the sessions are in the `pgdata` volume; with ClickHouse, in `chdata`, and the blobs stay in
  `coding-sh-data`.
- **Backups.** Back up the volumes, or the database. For SQLite, stop the container, copy the
  volume and start it again:
  `docker stop coding-sh && docker run --rm -v coding-sh:/data -v "$PWD":/backup alpine tar czf /backup/coding-sh.tgz -C /data . && docker start coding-sh`
- **Upgrades.** `docker pull ghcr.io/jackulau/coding.sh`, then remove and run the container again
  with the same command. With Compose: `docker compose -f deploy/compose/compose.yml pull` and
  `up -d`. The schema migrates on start. Pin a version (`ghcr.io/jackulau/coding.sh:0.1.2`, or
  `CODING_SH_IMAGE` in `.env`) to upgrade on your own schedule.
- **Health.** `curl -s http://<server>:4318/readyz` answers `{"ok":true,…}` once the store is
  ready. The image has a Docker healthcheck on the same path.
- **Retention.** `CODING_SH_RETENTION_DAYS=30` deletes sessions older than 30 days, every hour.

## Read from the CLI

The viewer and the API cover most reading. People with database access can also run the CLI and
MCP tools against the team database, for example
`coding.sh sessions --store 'postgres://coding:…@db-host:5432/coding' --project alice`. This
needs the `coding.sh-store-postgres` package next to coding.sh. With `--store`, local spool files
are not pushed into the shared database.

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
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped \
  -e CODING_SH_STORE_URL='clickhouses://coding:pass@ch.example.com:8443/coding' \
  -e CODING_SH_BLOB_URL='file:///data/blobs' \
  ghcr.io/jackulau/coding.sh
```

The image has the ClickHouse plugin. Outside Docker, install `coding.sh-store-clickhouse` next to
coding.sh. Keys work as in the [quickstart](#quickstart).

The URL is `clickhouse://user:pass@host:8123/database` for HTTP and `clickhouses://…:8443/…` for
HTTPS (`?secure=1` does the same). The plugin talks to ClickHouse's HTTP interface, not the native
port 9000. The default port is 8123, or 8443 with TLS. A missing database is created, and the
tables are migrated when the store opens. Any other query parameter is passed to ClickHouse as a
setting, for example `?select_sequential_consistency=1`. The same URL works for the CLI and MCP:
`coding.sh sessions --store 'clickhouse://…'`.

Blobs (transcripts, snapshots, large payloads) do not go to ClickHouse. Keep them on `file://`
(one host with a volume) or on S3 with `coding.sh-store-s3` (`CODING_SH_BLOB_URL=s3://…`).

With Compose, `deploy/compose/compose.clickhouse.yml` runs serve and ClickHouse together, with the
blobs on the `coding-sh-data` volume:

```sh
docker compose -f deploy/compose/compose.clickhouse.yml up -d --wait
```

serve waits up to 30 s for ClickHouse (or Postgres) to accept connections when both start at once.

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
