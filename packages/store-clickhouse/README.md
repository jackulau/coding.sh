# coding.sh-store-clickhouse

ClickHouse storage for [coding.sh](https://coding.sh). Install it next to `coding.sh` and point the
store URL at a database. `coding.sh serve`, the CLI, MCP tools, datasets and experiments then all
read and write that database.

```sh
npm i -g coding.sh coding.sh-store-clickhouse
export CODING_SH_STORE_URL='clickhouses://coding:secret@ch.internal:8443/coding'
export CODING_SH_BLOB_URL='s3://my-bucket/coding-sh'    # or leave the default file:// blobs
coding.sh serve
```

The core package loads this plugin by its name (`coding.sh-store-<scheme>`), so there is nothing to
register. Both `clickhouse://` and `clickhouses://` work. It has no runtime dependencies: it uses
`fetch` against ClickHouse's HTTP interface, sends and reads `JSONEachRow`, and passes every value
as a typed `{name:Type}` query parameter, never inside the SQL text.

There is no ClickHouse blob store. Blobs stay on `file://` (the default) or on S3 with
`coding.sh-store-s3`.

When to pick it over Postgres, and how to export to ClickHouse through an OpenTelemetry Collector
without this plugin: [Self-host for a team](https://github.com/jackulau/coding.sh/blob/main/docs/how-to/self-host-team.md#clickhouse).

## URL

```
clickhouse://user:pass@host:8123/db
clickhouses://user:pass@host:8443/db
```

| Part | Default | Meaning |
|---|---|---|
| scheme | | `clickhouse` is HTTP, `clickhouses` is HTTPS. `?secure=1` also turns on HTTPS. |
| port | `8123`, or `8443` with TLS | The HTTP interface, not the native port 9000. |
| user, password | `default`, empty | Sent as `X-ClickHouse-User` / `X-ClickHouse-Key`. Errors show the password as `***`. |
| path | `default` | The database. Created if missing. |
| anything else | | Passed to ClickHouse as a setting, such as `select_sequential_consistency=1`. |

Queries time out after 30 s (`max_execution_time`, plus a client-side abort).

## What it stores

The tables mirror the SQLite store: `events`, `sessions`, `cursors`, `tasks`, `bundles`, `runs`,
`labels`, `kv`, `datasets`, `dataset_latest`, `experiments`, `judges` and `locks`, plus
`coding_sh_migrations`.

- Migrations are versioned and run on open. Every statement is idempotent, so replicas can start
  together.
- Each table is a `ReplacingMergeTree` with a `ver` column, and every read uses `FINAL`, so the
  newest version of a row wins before ClickHouse merges. `coding.sh gc --compact` runs
  `OPTIMIZE TABLE … FINAL`.
- `putEvents` is idempotent within one writer: retries and replays never add an event twice.
- Search matches word prefixes on a `search_text` column with an `ngrambf_v1` skip index, using the
  same terms as the other stores. Each event indexes up to 200,000 characters of text.
- Deletes (retention, `deleteBefore`) are lightweight `DELETE`s.
- `coding.sh serve` takes a lease in the `locks` table (30 s, renewed every 10 s), so one replica
  writes. A writer that dies without releasing it is replaced within 30 s.

## Not supported

- **Transactions.** ClickHouse has none across statements, so the store has no `transaction()`.
  Ingest writes events before it advances its cursors, so a crash replays rather than loses.
  Re-parsing a session inserts the new rows before it deletes the old ones; a reader in between can
  see both.
- **More than one writer.** Two processes writing at once can each count an event as new, which
  over-counts session stats (reads still show the event once). The lease prevents this for serve.
- **Replicated DDL.** Tables use plain MergeTree engines. On a self-managed cluster, create the
  database with the `Replicated` engine before first start. ClickHouse Cloud converts the tables to
  SharedMergeTree; add `?select_sequential_consistency=1` for read-after-write across replicas.

## Tests

The conformance suite from `coding.sh/store/conformance` and the ClickHouse-specific tests run against
`CODING_SH_TEST_CH_URL`. They skip when it is unset. Each test creates a database `t_<random>` and drops it
afterwards, so the user needs `CREATE DATABASE` and `DROP DATABASE`.

```sh
docker run -d --name ch -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=coding -e CLICKHOUSE_PASSWORD=secret \
  clickhouse/clickhouse-server:26.3.62.3
CODING_SH_TEST_CH_URL=clickhouse://coding:secret@127.0.0.1:8123/coding npm test -w coding.sh-store-clickhouse
```
