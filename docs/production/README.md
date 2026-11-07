# coding.sh in production

Run one `coding.sh serve` process, point it at a database, and send traces to it from your API apps:
OpenAI, Anthropic, the AI SDK, an LLM gateway (Vercel AI Gateway, OpenRouter, LiteLLM, ...), or any OpenTelemetry app. The viewer, CLI, MCP
tools, datasets and experiments run on the same database.

The full contract is [docs/PRODUCTION.md](../PRODUCTION.md). This page is the short version.

## Point it at a database in 3 steps

**1. Make keys.** One ingest key per app, one read key for people:

```sh
docker build -t coding-sh .                                   # or: npx coding.sh serve keygen …
docker run --rm coding-sh /app/cli.mjs serve keygen --project myapp         # csh_ik_… for apps
docker run --rm coding-sh /app/cli.mjs serve keygen --project myapp --read  # csh_rk_… for people
```

Each key is printed once. No Node or Docker at hand? A key is just `csh_ik_` (or `csh_rk_`) plus 32
random bytes in base64url:
`echo "csh_ik_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"`.

**2. Run serve with a store URL.**

```sh
docker run -d -p 4318:4318 \
  -e CODING_SH_STORE_URL='postgres://user:pass@db.example.com:5432/coding?sslmode=require' \
  -e CODING_SH_INGEST_KEYS='myapp:csh_ik_…' \
  -e CODING_SH_READ_KEYS='*:csh_rk_…' \
  coding-sh
curl -s http://127.0.0.1:4318/readyz      # {"ok":true,"store":"postgres",…}
```

Serve creates its tables on first start. Blobs (large payloads) go to the same Postgres unless you set
`CODING_SH_BLOB_URL`.

**3. Point your app at it.**

```sh
export CODING_SH_URL=https://obs.example.com CODING_SH_INGEST_KEY=csh_ik_…
```

```ts
import { observe } from "@coding.sh/sdk";
const openai = observe(new OpenAI()); // or new Anthropic()
```

Open `https://obs.example.com/?t=csh_rk_…` to see the sessions. The link sets a cookie, so you only
pass the key once.

## Pick a store

| Setup | `CODING_SH_STORE_URL` | `CODING_SH_BLOB_URL` |
|---|---|---|
| One box, small traffic | `sqlite:///data/index.db` (the default in the image) | `file:///data/blobs` (default) |
| Real traffic | `postgres://…` (Neon, Supabase, RDS, Railway, Render, your own) | same URL (default) |
| Lots of large payloads | `postgres://…` | `s3://bucket/blobs?region=…` (S3, R2, MinIO, RustFS) |

- `DATABASE_URL` is used when `CODING_SH_STORE_URL` is unset and it holds a `postgres://` or
  `postgresql://` URL.
- Managed Postgres over the internet needs `?sslmode=require`.
- Use a direct connection or a **session** pooler. Transaction poolers (PgBouncer in transaction mode,
  Supabase port 6543) break the session advisory lock that keeps one writer.
- S3 credentials come only from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus the optional
  `AWS_SESSION_TOKEN`). A URL with credentials in it is refused. For R2:
  `s3://bucket/blobs?region=auto&endpoint=https://<account>.r2.cloudflarestorage.com`.

## Recipes

| Where | Store | Guide |
|---|---|---|
| Any machine with Docker | Postgres + S3-compatible blobs | [compose.md](compose.md) |
| Fly.io | SQLite on a volume, or Postgres | [fly.md](fly.md) |
| Railway | Railway Postgres | [railway.md](railway.md) |
| Render | Render Postgres, Deploy button | [render.md](render.md) |
| Vercel Functions | not as the server; apps on Vercel send to it | [serverless.md](serverless.md) |

## Send traces

| From | How |
|---|---|
| Node (OpenAI, Anthropic, fetch, AI SDK) | `@coding.sh/sdk`: `observe(client)`, `observeFetch()`, `aiSdkTracer()` |
| Python | `pip install coding-sh`, then `coding_sh.observe(client)` |
| Any OpenTelemetry SDK (gen_ai semconv) | `OTEL_EXPORTER_OTLP_ENDPOINT=https://obs.example.com` and `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20csh_ik_…"` |
| Vercel AI Gateway | point its trace drain at `https://obs.example.com/v1/traces` with the ingest key as a Bearer header |

The key decides the project. Sessions from project `myapp` show up as `myapp/<sessionId>`. Group the
turns of a conversation with `sessionId` (SDK) or `gen_ai.conversation.id` (OTel).

## Run it

- **Health.** `/healthz` answers while the process is up. `/readyz` answers 200 only when the store
  responds, migrations are done, this replica holds the writer lock and the queue has room. Point
  load balancers at `/readyz` unless the platform starts the new instance before stopping the old one
  (Railway, Render): there use `/healthz`, because the new instance stays in standby until the old one
  lets go of the writer lock.
- **One writer.** Run one serve replica with ingest. Add read-only replicas with `--role viewer`.
- **Metrics.** `/metrics` (Prometheus, needs a read key) has ingest, throttling, queue and writer
  numbers.
- **Backpressure.** When the queue is full, ingest answers 429 with `Retry-After`. The SDKs and OTel
  exporters retry, and a retried batch never duplicates.
- **TLS.** Serve speaks plain HTTP. Put it behind the platform's TLS or a proxy and set
  `CODING_SH_TRUST_PROXY=1`.
- **Retention.** `CODING_SH_RETENTION_DAYS=30` deletes old sessions hourly. Datasets and experiments
  are kept.
- **Privacy.** `CODING_SH_CAPTURE_MODE=metadata` drops message text and tool I/O on ingest. Keys and
  secrets are redacted before anything is written.
- **Backups.** Back up the database (and the bucket if you use one). Everything is in there.
- **CLI on the production store.** `coding.sh sessions --store postgres://… --project myapp`, or set
  `CODING_SH_STORE_URL`. `search`, `show`, `mcp`, `dataset` and `exp` all honor it.

Serve refuses to bind a public address without an ingest key and a read key (or basic auth). Pass
`--insecure` only on a private network.
