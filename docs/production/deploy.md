# Deploy coding.sh serve

`coding.sh serve` is one process on one port that takes sessions and traces, and serves the viewer
and the API. Run it anywhere that runs a Docker image. The image is `ghcr.io/jackulau/coding.sh`,
built for amd64 and arm64.

| Host | Store | Keys | TLS |
| --- | --- | --- | --- |
| [Docker Compose](#docker-compose) | SQLite, Postgres or ClickHouse | made on first start | your proxy |
| [Fly.io](#flyio) | SQLite on a volume, or Postgres | made on first start | Fly's |
| [Railway](#railway) | Railway Postgres | yours | Railway's |
| [Render](#render) | Render Postgres | yours | Render's |
| [Serverless](#serverless) | Postgres | yours | the platform's |

Every host follows the same rules:

- **Keys.** With a volume on `/data` and no keys set, the first start makes a key pair, keeps it on
  the volume and prints it in the logs.
- **Keys without a volume.** Set `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS` yourself, or the
  keys change on every deploy. Make them with `serve keygen`, as in
  [Self-host for a team](../how-to/self-host-team.md#2-make-your-own-keys).
- **One writer.** Run one instance that ingests. With Postgres, add read-only viewers with
  `serve --role viewer`.
- **Health.** `/healthz` answers while the process is up. `/readyz` answers 200 once the store is
  ready and this instance holds the writer lock.
- **TLS.** serve speaks plain HTTP. Behind a proxy or a platform's TLS, set
  `CODING_SH_TRUST_PROXY=1`.

## Docker Compose

`deploy/compose/` has three stacks. None needs edits; each runs the published image.

```sh
curl -fsSLO https://raw.githubusercontent.com/jackulau/coding.sh/main/deploy/compose/compose.yml
docker compose up -d --wait
docker compose logs coding-sh     # the keys and the connect command
```

| File | Store |
| --- | --- |
| `compose.yml` | SQLite on the `coding-sh-data` volume |
| `compose.postgres.yml` | Postgres 17 in the stack; set `POSTGRES_PASSWORD` in `.env` first |
| `compose.clickhouse.yml` | ClickHouse in the stack, blobs on the volume; set `CLICKHOUSE_PASSWORD` in `.env` first |

Use another file with `docker compose -f compose.postgres.yml up -d --wait`. Optional settings go
in `.env` next to the file: your own keys, `CODING_SH_PUBLISH=127.0.0.1:4318` to keep the port on
loopback behind a proxy, `CODING_SH_RETENTION_DAYS`, and `CODING_SH_IMAGE` to pin a version.

The walkthrough, with keys per person, TLS with Caddy and backups, is
[Self-host for a team](../how-to/self-host-team.md).

:::more The test stack: serve, Postgres and S3 blobs
`docker-compose.yml` at the repo root is the stack the Postgres and S3 store tests use. It runs
serve, Postgres and an S3-compatible blob store (RustFS), with every port on `127.0.0.1` and keys
for fixed test projects. From a checkout:

```sh
deploy/compose/gen-env.sh                 # writes .env: random secrets, mode 600, prints no secret
docker compose up -d --build --wait
set -a; . ./.env; set +a
curl -s http://127.0.0.1:4318/readyz      # {"ok":true,"store":"postgres",…}
```

- `.env` holds `POSTGRES_PASSWORD`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` (the blob store's
  credentials), `INGEST_KEY_DEMO`, `INGEST_KEY_FLOOD` and `READ_KEY`.
- Running `gen-env.sh` again keeps the file, because Postgres takes its password only on first
  start. To start over: `docker compose down -v && deploy/compose/gen-env.sh --force`.
- `deploy/compose/config.toml` is mounted as the server config. Add `[prices."<model>"]` tables
  there to override built-in prices.
- `docker compose stop` sends SIGTERM; serve drains its queue for up to 25 s.
:::

## Fly.io

`deploy/fly.toml` runs one machine with SQLite on a volume. From a checkout, after
`fly auth login`:

```sh
fly launch --no-deploy --copy-config --config deploy/fly.toml --name my-coding-sh
fly volumes create coding_sh_data --size 3 --config deploy/fly.toml
fly deploy --config deploy/fly.toml --image ghcr.io/jackulau/coding.sh:latest
fly logs --config deploy/fly.toml --no-tail | grep -A5 'No keys are configured'
```

The logs print the first-start keys. Use `https://my-coding-sh.fly.dev` in place of the URLs they
show, then connect with `coding.sh init --remote https://my-coding-sh.fly.dev --key csh_ik_…`.

To move to Postgres, set one secret; blobs follow to the same database:

```sh
fly secrets set --config deploy/fly.toml CODING_SH_STORE_URL='postgres://…?sslmode=require'
```

:::more Fly.io details
- **One machine.** SQLite on a volume means exactly one machine: `fly scale count 1`.
- **Your own keys.** `fly secrets set --config deploy/fly.toml CODING_SH_INGEST_KEYS='myapp:sha256:…' CODING_SH_READ_KEYS='*:sha256:…'`.
  Set them before you remove `[mounts]` from `fly.toml`: without the volume, first-start keys change
  on every deploy.
- **Always on.** `auto_stop_machines = "off"`, because a stopped machine would drop exporter
  batches.
- **Deploys.** Fly replaces the machine in place: SIGTERM, a drain of up to 25 s
  (`kill_timeout = 30`), then the new version. Clients retry during the gap. The check is `/readyz`.
- **Blue-green deploys.** With the `bluegreen` strategy, change the check to `/healthz`: the new
  machine waits in standby until the old one releases the writer lock.
- **TLS** is Fly's. `CODING_SH_TRUST_PROXY=1` is set in `fly.toml`.
:::

## Railway

`deploy/railway.json` builds the repo's Dockerfile and checks `/healthz`. The store is a Railway
Postgres database in the same project. In the dashboard:

1. Create a project with *Deploy from GitHub repo* (your fork of coding.sh). Add *+ New → Database
   → PostgreSQL*.
2. In the coding.sh service, set *Settings → Config-as-code* to `/deploy/railway.json`, and add
   these variables:

   ```sh
   CODING_SH_STORE_URL=${{Postgres.DATABASE_URL}}
   CODING_SH_INGEST_KEYS=myapp:sha256:…
   CODING_SH_READ_KEYS=*:sha256:…
   CODING_SH_TRUST_PROXY=1
   ```

3. Generate a public domain under *Settings → Networking*, deploy, and check
   `https://<your-domain>/readyz` for `{"ok":true,"store":"postgres",…}`.

:::more Railway details
- **No build.** *+ New → Docker Image* with `ghcr.io/jackulau/coding.sh:latest` skips the build.
  Add a volume at `/data` and leave `CODING_SH_STORE_URL` unset to run on SQLite; serve then makes
  its keys on first start and prints them in the deploy logs.
- **Why `/healthz`.** Railway starts the new deployment while the old one still holds the writer
  lock, so the new one answers `/readyz` with 503 until the old one stops.
- **Handover.** `drainingSeconds: 30` covers the 25 s queue drain, and clients retry in between.
- **Port.** Railway sets `PORT`; serve listens on it.
- **One replica.** Only one replica ingests; more add nothing.
:::

## Render

`render.yaml` at the repo root is a Blueprint: a Docker web service plus a Render Postgres
database whose connection string becomes the store URL.

1. Make an ingest key and a read key with `serve keygen`. Render services have no volume here, so
   serve cannot keep first-start keys.
2. Open `https://render.com/deploy?repo=<your fork's URL>`, or pick *New → Blueprint* in the
   dashboard. Render asks once for `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS`.
3. Check `https://<service>.onrender.com/readyz` for `{"ok":true,"store":"postgres",…}`.

:::more Render details
- **Plans.** The Blueprint uses `0.5c-512mb` for the service and `0.1c-256mb` for the database.
  The free web plan sleeps when idle and would drop exporter batches.
- **Why `/healthz`.** Render starts the new instance while the old one holds the writer lock, so
  the Blueprint checks `/healthz`. Clients retry the 503s during the handover.
- **Port.** Render sets `PORT`; serve listens on it.
- **Retention.** A small database fills up. Add `CODING_SH_RETENTION_DAYS=30` to the service.
:::

## Serverless

Apps on Vercel, Cloudflare or any serverless platform send to a coding.sh server like any other app.
A function can freeze as soon as it responds, so flush the SDK before it does:

```ts
import { waitUntil } from "@vercel/functions";
import { flush, observe } from "@codingdotsh/sdk";

const openai = observe(new OpenAI());

export async function POST(req: Request) {
  const res = await openai.chat.completions.create({ /* … */ });
  waitUntil(flush());
  return Response.json(res);
}
```

The ingest routes can also run as a function, with `createFetchHandler()` from `coding.sh/server`
and a Postgres store:

```sh
npm install coding.sh coding.sh-store-postgres
```

```ts
// app/api/coding-sh/[...path]/route.ts
import { waitUntil } from "@vercel/functions";
import { createFetchHandler } from "coding.sh/server";

const handler = createFetchHandler({ basePath: "/api/coding-sh", waitUntil });
export { handler as GET, handler as POST, handler as OPTIONS };
```

Senders then use `https://app.example.com/api/coding-sh` as their endpoint. The function takes
`/v1/traces`, `/v1/logs`, `/v1/metrics`, `/v1/ingest`, `/healthz` and `/readyz`. It runs the same
code as serve: auth, limits, redaction, the cost estimate and the write. The viewer, the read API,
`/metrics` and retention still need a `coding.sh serve --role viewer` on the same database.

:::more Serverless details
- **Config** comes from the environment, as for serve: `DATABASE_URL` or `CODING_SH_STORE_URL`,
  `CODING_SH_BLOB_URL`, `CODING_SH_INGEST_KEYS` and `CODING_SH_CAPTURE_MODE`. Pass `config` or
  `stores` to set them in code.
- **Keys.** Every request counts as remote. With no ingest keys, every ingest request gets 401 and
  `/readyz` answers 503.
- **Other runtimes.** On Cloudflare Workers with `nodejs_compat`, `export default { fetch: handler }`.
  With Deno or Bun, `Deno.serve(handler)`, then `await handler.close()` on shutdown. These use the
  same code through `node:` built-ins but are not tested here.
- **Several instances.** `coding.sh-store-postgres` locks each session while it rebuilds its stats,
  so concurrent writers end with the same stats as serial ones. A transaction-mode pooler works.
- **SQLite and memory stores** have no such lock: use one instance with them.
- **Limits.** Spans of one trace that land on different instances can map less well than on one
  serve. Each instance opens its own database connection, so use a pooler.
- **AI Gateway.** Point the Vercel AI Gateway trace drain at `https://<your server>/v1/traces` with
  the ingest key as a Bearer header. No code in your app.
:::

## Next steps

- [Self-host for a team](../how-to/self-host-team.md): keys per person, TLS and backups.
- [Trace an app in production](../PRODUCTION.md): send traces from your app.
- [Postgres and ClickHouse stores](../reference/stores.md): store URLs, the tables and SQL.
- [Configuration](../reference/config.md#serve): every `[serve]` key and environment variable.
