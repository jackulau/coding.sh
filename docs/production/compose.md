# Docker Compose: serve + Postgres + S3 blobs

One machine runs the whole stack: `coding-sh` (serve), `postgres` (index, datasets, experiments) and
an S3-compatible blob store with a one-shot bucket creator. Every port is published on `127.0.0.1`
only.

## 3 steps

```sh
deploy/compose/gen-env.sh                 # 1. writes .env: random secrets, mode 600, prints no secret
docker compose up -d --build --wait       # 2. builds the image, starts everything, waits for healthy
set -a; . ./.env; set +a                  # 3. load the keys into this shell
curl -s http://127.0.0.1:4318/readyz      #    {"ok":true,"store":"postgres",…}
```

Send traces with `CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO`, then
open `http://127.0.0.1:4318/?t=$READ_KEY`.

## What is in `.env`

| Variable | Used for |
|---|---|
| `POSTGRES_PASSWORD` | the `coding` database user |
| `CLICKHOUSE_PASSWORD` | the `coding` ClickHouse user, with `deploy/compose/clickhouse.yml` |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | blob store credentials (serve gets them as `AWS_*`) |
| `INGEST_KEY_DEMO`, `INGEST_KEY_FLOOD` | ingest keys for projects `demo` and `flood` |
| `READ_KEY` | a read key for all projects |

Running `gen-env.sh` again keeps the existing file, because Postgres only takes its password on first
start. To start over: `docker compose down -v && deploy/compose/gen-env.sh --force`.

Lost `.env` while the volumes still exist? Compose refuses to run without it, and a new password will
not match the old database. Run `deploy/compose/gen-env.sh && docker compose down -v` (this deletes
the data), then start again.

To add your own app, append a key to `CODING_SH_INGEST_KEYS` in `docker-compose.yml`
(`myapp:${INGEST_KEY_MYAPP}`) and put the key in `.env`.

## Notes

- **Blob store image.** The services are named `minio` and `minio-init`, but they run RustFS and the
  AWS CLI: MinIO's images are no longer published on Docker Hub or quay.io. Any S3-compatible server
  works. To use a managed bucket instead, set `CODING_SH_BLOB_URL=s3://…` and real `AWS_*` values, and
  delete the two services.
- **Prices.** `deploy/compose/config.toml` is mounted as the server config. It pins the mock models
  used by the acceptance tests. Add `[prices."<model>"]` tables there to override the built-in prices.
- **TLS.** Put Caddy, nginx or a cloud load balancer in front of `127.0.0.1:4318` and add
  `CODING_SH_TRUST_PROXY: "1"` to the `coding-sh` environment.
- **Health.** The `coding-sh` healthcheck uses `/readyz`, so `--wait` returns once migrations are done
  and the writer lock is held.
- **Shutdown.** `docker compose stop` sends SIGTERM. Serve drains its queue for up to 25 s
  (`stop_grace_period` is 30 s).
- **ClickHouse.** `docker compose -f docker-compose.yml -f deploy/compose/clickhouse.yml up -d --build --wait`
  runs serve on ClickHouse instead of Postgres, with the `chdata` volume. See
  [Self-host for a team](../how-to/self-host-team.md#clickhouse).
- **Data.** Three named volumes: `pgdata`, `minio-data` and `coding-sh-data`. Back up the first two.
- **Tests.** The Postgres and S3 store suites run against this stack:
  `docker compose up -d postgres minio minio-init`, then `CODING_SH_TEST_PG_URL=postgres://coding:$POSTGRES_PASSWORD@127.0.0.1:5432/coding`.
