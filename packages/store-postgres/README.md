# coding.sh-store-postgres

Postgres storage for [coding.sh](https://coding.sh). Install it next to `coding.sh` and point the
store URL at a database. `coding.sh serve`, the CLI, MCP tools, datasets and experiments then all
read and write that database.

```sh
npm i -g coding.sh coding.sh-store-postgres
export CODING_SH_STORE_URL='postgres://coding:secret@db.internal:5432/coding?sslmode=require'
coding.sh serve
```

The core package loads this plugin by its name (`coding.sh-store-<scheme>`), so there is nothing to
register. Both `postgres://` and `postgresql://` work. When the index is on Postgres, blobs default
to the same database. Set `CODING_SH_BLOB_URL=s3://…` to keep them in object storage instead.

## URL

```
postgres://user:pass@host:5432/db?sslmode=require&schema=coding_sh&pool_max=10
```

| Parameter | Default | Meaning |
|---|---|---|
| `schema` | `public` | Created if missing. Separate deployments can share a database with separate schemas. |
| `pool_max` | `10` | Connections in the pool. The writer lock uses one more. |
| anything else | | Passed to [`pg`](https://node-postgres.com) as is (`sslmode`, `host=/socket/dir`, …). |

Statements time out after 30 s.

## What it stores

The tables mirror the SQLite store: `events`, `sessions`, `cursors`, `tasks`, `bundles`, `runs`, `labels`,
`kv`, `datasets`, `dataset_latest`, `experiments`, `judges` and `blobs`, plus `coding_sh_migrations`.

- Migrations run on open, in one transaction under an advisory lock, so replicas can start together.
- `events` and `sessions` carry `project_id` (`default` when unset).
- JSON fields are `text` holding JSON, so `stats::jsonb->>'events'` works in ad-hoc SQL.
- `putEvents` is idempotent: retries and replays never duplicate an event.
- Full-text search uses a GIN-indexed `tsvector` over diacritic-folded terms. It needs no extensions.
  Each event indexes up to 200,000 characters of text.
- `coding.sh serve` takes a session advisory lock per schema, so only one replica writes. It needs a direct
  connection or a session-mode pooler. Transaction-mode poolers drop session locks.
- Blobs are zstd-compressed `bytea` rows keyed by sha256.

## Tests

The conformance suite from `coding.sh/store/conformance` and the Postgres-specific tests run against
`CODING_SH_TEST_PG_URL`. They skip when it is unset. Each test creates a schema `t_<random>` and drops it
afterwards. `npm ci` builds this package's `dist/` through its `prepare` script; after editing `src/`,
rebuild with `npm run build -w coding.sh-store-postgres`.

```sh
npm run build -w coding.sh
CODING_SH_TEST_PG_URL=postgres://coding:secret@127.0.0.1:5432/coding npm test -w coding.sh-store-postgres
```
