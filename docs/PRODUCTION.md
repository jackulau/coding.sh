# coding.sh in production (contract v1)

coding.sh also runs as the observability layer for API apps: any service that calls OpenAI, Anthropic,
the AI SDK or the Vercel AI Gateway, and any agent running in production. You run one server process
and point it at a database. Your apps send traces to it, and the same viewer, CLI, MCP tools, datasets
and experiments work on top of that database.

This doc is the contract that the parallel builders follow. Names, routes, env vars, file paths and
interfaces here are frozen. To change one, edit this doc first.

```
 API apps ──SDK (TS / Python)──▶ POST /v1/ingest ─┐
 OTel apps, AI SDK, Gateway ──▶ POST /v1/traces    ├─▶ bounded queue ─▶ writer ─▶ IndexStore (sqlite | postgres)
                                POST /v1/logs     ─┘   429 when full    1 tx/tick   BlobStore  (file | postgres | s3)
 people ─▶ /  /api/*  (viewer)     ops ─▶ /healthz /readyz /metrics      CLI + MCP ─▶ same store URL
```

**Invariants**

- The core package `packages/coding.sh` keeps **zero runtime deps**. Drivers live in plugin packages.
- A request is acknowledged (200) only **after its events are committed**. So an accepted batch is
  never lost, and a rejected one (429/503) is safe to retry.
- Event ids are deterministic or client-generated and stable across retries, and `putEvents` is
  idempotent. Retries and replays never create duplicates.
- Redaction runs before anything is written. Logs never contain keys, request bodies or store passwords.
- Local mode is unchanged: `coding.sh ui`, `collector`, hooks and `~/.coding.sh` behave as before.

## 1. `coding.sh serve`

One Node process with one port (default **4318**, so an `OTEL_EXPORTER_OTLP_ENDPOINT` base URL works as is).

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/traces`, `/v1/logs` | ingest key | OTLP/HTTP, JSON or protobuf, gzip/deflate/br. Reuses `src/otel` decode + map + enrichers (eve, gateway). |
| `POST /v1/metrics` | ingest key | Accepted and dropped, as today. |
| `POST /v1/ingest` | ingest key | Native batched `AgentEvent` JSON (§2). |
| `GET /`, `/api/*` | read key or basic auth | The existing viewer and its API. Adds `GET /api/projects` and a `?project=` filter on list/search/stats. |
| `GET /healthz` | none | 200 `{"ok":true}` while the process is up. It never touches the store. |
| `GET /readyz` | none | 200 when the store pings, migrations are done, this replica holds the writer lock (or runs `--role viewer`), the queue is under 90% and the server is not shutting down. Otherwise 503. The body is `{ok, store, writer, role, queue:{events,max}, insecure, reason?}` (`reason` says why it is 503) and contains no secrets. |
| `GET /metrics` | `*` read key or basic auth | Prometheus text format (§1.7). A project-scoped read key gets 403. |

**CLI**

- `coding.sh serve [--host H] [--port P] [--config FILE] [--store URL] [--blobs URL] [--role all|viewer] [--insecure]`
- `coding.sh serve keygen --project ID [--read]` prints a new key once, plus the `sha256:` line to put in a config file.
- `coding.sh serve healthcheck [--url U]` exits 0 when the URL (default `http://127.0.0.1:<port>/healthz`)
  answers 200, and 1 otherwise. Compose passes `--url …/readyz`. The distroless image has no
  curl, so the Docker `HEALTHCHECK` uses this.

### 1.1 Config

Precedence: flags > env > the `--config` file or `~/.coding.sh/config.toml` > defaults. A repo-level
`.coding.sh/config.toml` can never set `[serve]` or `[store]` (existing rule). TOML values support
the existing `${ENV}` interpolation.

| Env | TOML | Default |
|---|---|---|
| `CODING_SH_STORE_URL` (serve only: falls back to `DATABASE_URL` when that is `postgres://` or `postgresql://`; other commands never read `DATABASE_URL`) | `store.index` | `sqlite://$CODING_SH_HOME/index.db` |
| `CODING_SH_BLOB_URL` | `store.blobs` | `file://$CODING_SH_HOME/blobs`. When the index is `postgres://`, it defaults to **the same URL**: one DB is enough. |
| `CODING_SH_INGEST_KEYS` | `[[serve.projects]] id, ingest_keys = ["sha256:<hex>"]` | none |
| `CODING_SH_READ_KEYS` | `serve.viewer.read_keys = [{project = "*", key = "sha256:<hex>"}]` | none |
| `CODING_SH_BASIC_AUTH` (`user:password`) | `serve.viewer.basic_user`, `basic_password_sha256` | none |
| `CODING_SH_HOST` | `serve.host` | `127.0.0.1` (the image sets `0.0.0.0`) |
| `CODING_SH_PORT`, then `PORT` | `serve.port` | `4318` |
| `CODING_SH_QUEUE_MAX_EVENTS` / `_BYTES` | `serve.queue_max_events` / `_bytes` | `50000` / `134217728` |
| `CODING_SH_RETENTION_DAYS` | `serve.retention_days`, per project `retention_days` | `0` (keep forever) |
| `CODING_SH_CAPTURE_MODE` | `capture.mode` | `full` (`metadata` drops message text and tool I/O on ingest) |
| `CODING_SH_INSECURE=1` | `serve.insecure` | off |
| `CODING_SH_TRUST_PROXY=1` | `serve.trust_proxy` | off. When on, X-Forwarded-Proto/For are honored for cookie `Secure` and for logs. |
| `CODING_SH_LOG` (`json`\|`text`) | `serve.log` | `json` when stderr is not a TTY. Logs go to stderr; stdout gets only the URL (or one JSON document with `--json`) once ready. |

Other fixed limits: body ≤ 16 MiB (before and after decompression), ≤ 10,000 events per request,
writer tick ≤ 5,000 events, shutdown drain timeout 25 s. Serve forces `update.check = false`, so
servers never phone home.

**Key formats**

- Ingest keys are `csh_ik_` followed by 32 random bytes in base64url. Read keys are `csh_rk_…`.
- In `CODING_SH_INGEST_KEYS`, each entry is `project:key` or `project:sha256:<hex>`, comma-separated.
  A bare key means project `default`.
- In `CODING_SH_READ_KEYS`, each entry is `*:key` (all projects) or `project:key`.
- Config files hold only `sha256:` hashes. Keys are checked by sha256 lookup.
- `src/core/redact.ts` gains the rule `coding-sh-key` for `csh_(ik|rk)_[A-Za-z0-9_-]{32,}`.

**`CODING_SH_STORE_URL` is global.** Every command honors it (`sessions`, `show`, `search`, `mcp`,
`dataset`, `exp`, `judge`, `gc`), and so does a new global `--store/--blobs` flag. When the store is
overridden this way, **autoIngest is skipped**. Otherwise a developer's local agent spool would be
pushed into the production DB. An explicit `coding.sh ingest --store …` still works.

### 1.2 Auth

- **Ingest:** `Authorization: Bearer <ingest key>`. OTel exporters set it with
  `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<key>`. The key decides the project; the client
  cannot choose one. A missing or bad key gets 401 with `WWW-Authenticate: Bearer`. OTLP routes answer
  in google.rpc.Status form, with code 16.
- **Viewer, `/api/*` and `/metrics`:**
  - A read key works as a Bearer header, or as `?t=<key>` once. The viewer turns that into a cookie,
    which is the existing mechanism.
  - Basic auth also works.
  - A project-scoped read key only sees its project: lists are filtered, and other sessions return 404.
  - `/metrics` needs a `*` read key or basic auth. Its labels name every project, so a scoped key gets 403.
  - Labels record who set them as `by`: the basic-auth user, the read key's configured `name`, or
    `reader:<first 12 hex of the key's sha256>`. Never the key itself.
  - Ingest keys cannot read, and read keys cannot ingest.
  - Blobs are shared and content-addressed, so a scoped key that already knows another project's
    blob sha256 can fetch that blob. This is documented, not fixed.
- **First-start keys:** if the bind address is not loopback and no ingest key, read key or basic
  auth is configured (and no `--insecure`), serve makes one ingest key (project `default`) and one
  read key (every project). It keeps them in `<CODING_SH_HOME>/serve-keys.json` (mode 600) and uses
  the same file on every later start. Each start prints both keys, the viewer link and the
  `coding.sh init --remote` line on stdout, after the URL. A damaged file stops serve with exit 2; it
  is never replaced, because clients hold the old keys. Delete the file to make new keys. Configuring
  any key or basic auth turns this off. A `--role viewer` replica never makes keys.
- **Refusal rule:** otherwise, if the bind address is not loopback, serve exits 2 unless at least one
  ingest key **and** (a read key or basic auth) are configured, or `--insecure` is passed. The error
  message names the env vars and `--insecure`. On loopback with no keys, ingest is open to project
  `default` (single-user mode, J4). `--insecure` logs a warning at start and sets `insecure: true` in `/readyz`.
- Serve speaks plain HTTP. TLS is terminated by the platform or a proxy.
- CORS is closed by default. `serve.cors_origins` opens the ingest routes (`/v1/ingest` with its
  `OPTIONS` preflight, and OTLP) to the listed browser origins; any other `Origin` gets 403. The viewer
  and `/api/*` stay same-origin. Browser ingest needs a key in the page, so give it a dedicated
  project's ingest key and treat that project's data as untrusted.

### 1.3 Projects

- A project id matches `^[a-z0-9][a-z0-9-]{0,62}$`. `default` is reserved for unscoped data, which is
  all existing local data.
- Schema (additive): `AgentEvent.project?` and `Session.project?`. Unset means `default`. Stores keep
  a `project_id TEXT NOT NULL DEFAULT 'default'` column on events and sessions, and read `'default'`
  back as an unset field.
- **Session ids are namespaced at ingest** for any project other than `default`, as
  `<project>/<sessionId>`. The same applies to `payload.parentSessionId` and `childSessionId`.
  Two apps that both use conversation id `chat-1` stay apart, and the `IndexStore` keys stay unchanged.
  A `default`-project session id that contains `/` is stored as `default/<sessionId>`, so a default key
  can never write into another project's `<project>/…` namespace. `default` is reserved, so no other
  project owns that prefix.
  Helpers: `scopeEvents(events, project)` and `scopeSessionId` in `src/server/project.ts`.
- Native-ingest event ids are stored as `hashParts("sdk", project, clientId)`, and `parentId` gets the
  same transform. Projects cannot collide, and a retry still maps to the same id. OTLP ids already
  derive from traceId+spanId.
- `buildSession` copies `project` from the events. `SessionFilter.project` and `search(…, {project})`
  are added. `coding.sh sessions|search --project` and the MCP tools take an optional `project` argument.
- Projects partition data, keys and retention. They are **not** a hard boundary between mutually
  untrusted tenants: run one server and DB per tenant for that.

### 1.4 Ingest pipeline (`src/server/queue.ts`)

1. **Admission.** The request is authenticated, its body is read with limits, and it is decoded:
   OTLP through `src/otel`, native through §2 validation. The admission cost is the event or span
   count plus the decoded bytes. If the queue would exceed either max, the response is **429** with
   `Retry-After: <s>`. The value is `ceil(queued / observed write rate)`, clamped to 1..30, with a
   default of 2. Nothing is queued.
2. **Writer.** There is exactly one, serial. Each tick it takes up to 5,000 events' worth of queued
   requests and processes them in this order:
   1. OTLP entries are mapped through the shared OTLP pipeline. The receiver's `persist` (seed, map,
      kv) is extracted into `createOtlpPipeline()` in `src/otel/receiver.ts`, and `startReceiver`
      keeps using it.
   2. `scopeEvents`.
   3. Redaction (`createRedactor(config.capture)`), plus the metadata-mode strip.
   4. Pricing (§1.5).
   5. Payloads over `maxInlineBytes` move to blobs. This reuses the otel map offload helper; if
      needed, it is lifted into `src/core/offload.ts`.
   6. `kvSet("serve:dirty", touchedSessionIds)`.
   7. **One `putEvents`** for the whole tick.
   8. Each touched session is rebuilt once (`buildSession(listEvents(id), getSession(id))` →
      `upsertSession`).
   9. The dirty key is cleared.
   10. Every request in the tick is resolved. 200 means committed.
3. **Failure.** A store error rejects the whole tick with **503** + `Retry-After`. That status is
   retryable for OTLP and for the SDKs, and putEvents is idempotent.
4. **Crash repair.** On startup the writer rebuilds every session listed in `serve:dirty` before it
   takes traffic. A retried batch also rebuilds its sessions, because rebuild keys off the batch and
   not off `inserted`.
5. **Single writer.**
   - At start, serve calls `index.acquireWriterLock()`. On Postgres this is a session advisory lock;
     on SQLite it is `src/core/lock.ts` on `<db>.writer.lock`.
   - A replica without the lock is in standby: `/readyz` returns 503, ingest returns 503, and it
     retries the lock every 5 s. Rolling deploys therefore hand over cleanly.
   - Extra read replicas run `--role viewer`. They take no lock and expose no ingest routes.
6. **Shutdown.** SIGTERM/SIGINT sets `/readyz` to 503, stops accepting connections, returns 503 to
   new ingest, drains the queue for up to 25 s, then closes the stores and exits 0. A second signal
   exits at once. Unacknowledged requests are retried by clients, so nothing is lost.

Blobs are written during mapping, before the events commit. After a crash they are orphans, and gc
sweeps them (the minimum age is 1 h, so gc never races a write that is still in flight).

### 1.5 Cost

`src/core/pricing.ts` takes over `Prices`/`estimateCost` from `src/toolevals` (toolevals then imports
them from there). It also adds:

- a small built-in table for current OpenAI, Anthropic and Google models, with source URLs and an
  `updated` date;
- `[prices."<model>"] input, output, cache_read, cache_write`, all in USD per 1M tokens, which
  overrides the table.

In serve, an `llm.call` that has tokens but no `costUsd` gets
`costUsd = in·input + out·output + cacheRead·cache_read + cacheWrite·cache_write` and
`payload.costEstimated = true`.

- Model lookup tries the exact name, then the name without a `provider/` prefix, then the longest
  dated-variant prefix (`gpt-4o-mini-2024-07-18` → `gpt-4o-mini`). An unknown model gets no cost.
- `inputTokens` follows the existing convention: it counts **uncached** input. OpenAI
  `prompt_tokens − cached_tokens`; Anthropic `input_tokens`.
- Gateway enrichment still adds its billed-minus-reported delta on top.

### 1.6 Retention

- Retention runs at start and then hourly, for each project with `retention_days > 0`. It calls
  `index.deleteBefore(now − days, {project})`, which deletes sessions whose last activity (the
  latest of their end, their start and every event's end) is before the cutoff, together with
  their events and labels. A resumed or still-running session is never deleted while it is active.
- Tasks, datasets, experiments and judges are eval assets and are never deleted by retention.
- A daily `gc` (the existing mark-and-sweep) removes unreferenced blobs.

### 1.7 Metrics and logs

**Prometheus metrics.** Label values are bounded by the configured projects.

- `coding_sh_http_requests_total{route,status}`
- `coding_sh_ingest_events_total{project,result="inserted|duplicate|rejected"}`
- `coding_sh_ingest_throttled_total{project}`
- `coding_sh_ingest_auth_failures_total{route}`
- `coding_sh_queue_events`, `coding_sh_queue_bytes`
- `coding_sh_writer_tick_seconds` (histogram), `coding_sh_store_errors_total`
- `coding_sh_writer_lock_held`
- `process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds`

**Logs.** One JSON line per event. Store URLs pass through `redactUrl` (`src/sinks/post.ts`).
There is one summary line per minute (events in/out, throttled, queue depth).

### 1.8 Code layout and refactors (core package)

- New, all in `src/server/`:
  - `serve.ts` composes the handlers.
  - `config.ts`, `auth.ts`, `project.ts`.
  - `queue.ts`, `native.ts`, `metrics.ts`, `retention.ts`, `log.ts`.
- New: `src/cli/commands/serve.ts` and its `registry.ts` entry.
- `src/otel/receiver.ts` extracts `createOtlpPipeline()` and `createOtlpHandler({submit, authorize})`.
  `startReceiver` is rebuilt on top of them, and its existing tests must stay green.
- `src/viewer/server.ts` extracts `createViewerHandler({…, authorize, checkHost})`. `authorize`
  returns `{project?}` or undefined. `startViewer` is unchanged for local use.
- Do not edit `src/integrations/gateway`, `src/adapters` or `apps/site`. Serve uses
  `defaultEnricher` as is, so a Gateway trace drain pointed at `/v1/traces` with an ingest key works.

## 2. Native ingest API

The full reference for every route, with examples and errors, is [reference/api.md](reference/api.md).

```
POST /v1/ingest
Authorization: Bearer csh_ik_…
Content-Type: application/json          (Content-Encoding: gzip optional)
{ "v": 0, "service": "checkout-api", "events": [AgentEvent, …] }
```

**Per-event validation.** Invalid events are rejected individually, and the rest are kept.

- `v === 0`.
- `id` is 1–128 printable ASCII characters.
- `sessionId` is 1–200 characters with no control characters.
- `kind` is in `EVENT_KINDS`.
- `ts` is a finite number in `[0, now + 1 day]`.
- `payload` is an object.
- `usage` fields, when present, are non-negative numbers.

**The server sets:**

- `project`, taken from the key; a value the client sends is overwritten;
- `source = "sdk"` when absent;
- `agent` = the kebab-cased `service`, or `"sdk"`, when absent.

The server drops a client-sent `blobs` field (clients never reference blobs) and strips U+0000 from
strings that go into text columns.

| Status | Body |
|---|---|
| 200 | `{"accepted":n,"inserted":k,"rejected":[{"index":i,"error":"…"}]}` (committed). A tick makes one `putEvents`, so when it holds several requests its `inserted` total is credited to them in arrival order (ids repeated within the tick belong to the first request). |
| 400 | invalid envelope (body is not valid JSON, not an object, `v` is not 0, `events` missing or not an array, over 10,000 events), or a corrupt compressed body |
| 401 | missing or bad key, or a read key; `WWW-Authenticate: Bearer` |
| 403 | `Origin` not in `serve.cors_origins` |
| 404 | the server runs `--role viewer` (no ingest) |
| 405 | method other than POST or OPTIONS; `Allow: POST, OPTIONS` |
| 413 | body (compressed or decompressed) over 16 MiB |
| 415 | `Content-Type` is not `application/json`, or an unknown `Content-Encoding` |
| 429 / 503 | queue full / store down, shutting down or a standby replica, both with `Retry-After` |

## 3. Stores

### 3.1 Contract changes (core, owned by the serve builder)

Optional `IndexStore` capabilities. Callers feature-test them, and sqlite, memory and postgres
implement all of them.

```ts
ping?(): Promise<void>;
acquireWriterLock?(opts?: { waitMs?: number }): Promise<{ release(): Promise<void> } | undefined>;
deleteBefore?(cutoffMs: number, opts?: { project?: string }): Promise<{ sessions: number; events: number }>;
```

Also:

- `SessionFilter.project`, `search` opts `project`.
- SQLite migration **v4**: `project_id` on events and sessions, plus `sessions(project_id, started_at DESC)`
  and `events(project_id, ts)`.
- `src/store/conformance.ts` gains:
  - a project round-trip and filter test;
  - a search filter by project;
  - a `deleteBefore` test, when implemented;
  - two concurrent `putEvents` with overlapping ids, whose `inserted` counts sum to the number of
    unique ids.
- Plugins import shared helpers from the core package through new exports, both built by
  `scripts/bundle.mjs`:
  - `coding.sh/store` (`src/store/plugin-api.ts`: types, `searchableText`, `searchTerms`, snippet
    markers, and `snippet()` moved from `memory.ts` into `common.ts`);
  - `coding.sh/store/conformance`.

Plugins resolve through the existing factory convention: a package named `coding.sh-store-<scheme>`
exports `{ indexStore?, blobStore? }`. The factory maps the scheme `postgresql` to `postgres` before
that lookup, because Render, Railway and most hosts hand out `postgresql://` URLs. Installed next to `coding.sh`, whether in the same
`node_modules` or as a global install, they load with no registration.

### 3.2 `packages/store-postgres` → npm `coding.sh-store-postgres`

- Its dependency is `pg`, and `coding.sh` is an optional peer dependency. The build bundles the
  `coding.sh/store` helpers into `dist/index.mjs`, so at runtime it needs only `pg`. The image installs
  `pg`, not a second copy of `coding.sh`. It exports `indexStore` **and** `blobStore` for the scheme
  `postgres`. The core factory maps `postgresql://`, the form hosting platforms hand out, to the same
  package.
- In a checkout, `npm ci` builds `dist/index.mjs` through the package's `prepare` script (soft: a
  missing esbuild only warns), so `--store postgres://` works after `npm run build -w coding.sh` alone.
  Rebuild it after editing `src/` with `npm run build -w coding.sh-store-postgres`.
- URL: `postgres://user:pass@host:5432/db?sslmode=require&schema=coding_sh&pool_max=10`.
  - `schema` (default `public`) and `pool_max` (default 10) are stripped before the rest goes to
    `pg.Pool`. Tables are schema-qualified, so the store never depends on `search_path`.
  - int8 values parse to `Number` through a per-pool `types` override, never a global one.
  - `statement_timeout` is 30 s.
- **Migrations:** a `coding_sh_migrations` table, applied in one transaction under
  `pg_advisory_xact_lock`, so concurrent replicas are safe. The schema is created if missing.
- **Tables** mirror sqlite: events, sessions, cursors, tasks, bundles, runs, labels, kv, datasets,
  dataset_latest, experiments, judges, and blobs.
  - JSON fields (payload, usage, repo, blobs, stats, flags, parent) are stored as **`text`
    holding JSON**, as in sqlite, not as `jsonb`. jsonb rejects `\u0000` and renumbers values, and
    the conformance round-trip is exact.
  - `ts`, `duration_ms` and the other numbers that come from events and documents (`started_at`,
    `ended_at`, `created_at`, label `ts`, cursor offsets) are `double precision`. That type is exact for
    every JS number. A `bigint` column would reject the fractional ms in `ts + durationMs`, and that
    would poison a writer tick. `seq` (bigint) keeps batch order for events with equal `ts`.
- **Full-text search:**
  - `search_folded text`, computed in JS as `searchTerms(searchableText(e)).join(" ")`, so diacritics
    are folded the way FTS5 does it, with no `unaccent` extension.
  - `tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_folded)) STORED`, with a GIN index.
    `search_folded` is capped at 200,000 characters per event, because a tsvector must stay under 1 MB.
  - The query is `tsv @@ to_tsquery('simple', $1)` with `$1 = terms.map(t => t + ":*").join(" & ")`.
    Terms are alphanumeric only, and the query is still bound as a parameter.
  - Results are ordered by `ts_rank` and then `ts DESC`.
  - Snippets are built in JS with the shared `snippet()`.
- **`putEvents`:** de-duplicate the batch by id first, then
  `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id` in chunks of 500, all in one transaction.
  Rows are inserted in id order, so concurrent writers with overlapping ids cannot deadlock.
- Every optional capability is implemented: kv, datasets, experiments, judges (so evals live in PG,
  not in container files), `compact` (`VACUUM (ANALYZE)`), `ping`, `deleteBefore`, and
  `acquireWriterLock` (a dedicated client holding
  `pg_try_advisory_lock(hashtextextended('coding.sh:writer:' || <schema>, 0))`).
- **Blob store:** `blobs(ref text primary key, data bytea /* zstd */, size int, created_at bigint)`.
  `put` uses `ON CONFLICT DO NOTHING`, and `stat` returns size and created_at. A dedupe hit refreshes
  `created_at`, as the fs store touches mtime, so gc's age guard covers a blob that was just re-referenced.
  Index and blob stores on the same URL share one pool. `PgBlobStore.close()` exists, so serve calls
  `blobs.close?.()` on shutdown.
- **Tests:** `runIndexStoreConformance` and `runBlobStoreConformance` run against
  `CODING_SH_TEST_PG_URL`, and skip when it is unset. Each test uses a fresh schema `t_<rand>`,
  which is dropped on close.

### 3.3 `packages/blob-s3` → npm `coding.sh-store-s3`

- It has **zero deps**: SigV4 is built on `node:crypto`, requests use `fetch`, and blobs are
  compressed with zstd from `node:zlib`. It exports `blobStore` for `s3`.
- It is plain ESM JavaScript (`// @ts-check` + JSDoc, `src/index.js`), not TypeScript: Node does not
  strip types under `node_modules`, and the plugin must load from an npm install with no build step.
- URL: `s3://bucket/prefix?region=auto&endpoint=https://<acct>.r2.cloudflarestorage.com&style=path|virtual`.
  - Credentials come only from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and the optional
    `AWS_SESSION_TOKEN`. A URL that contains credentials is refused.
  - The region defaults to `AWS_REGION` or `us-east-1`.
  - The endpoint defaults to `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`, then AWS.
  - Path style is the default when an endpoint is set (MinIO), or when the bucket name has a dot
    (wildcard TLS certs do not cover it); virtual-host style otherwise.
  - Unknown URL parameters are refused, and so are empty, `.` or `..` prefix segments.
  - IMDS/ECS role credentials are out of scope for v1.
- Object keys follow `<prefix>/ab/cd/<sha256>.zst`, the same layout as the fs store.
- **Operations:**
  - `put`: `PUT` with `If-None-Match: *`. A 412 means the blob already exists, which counts as
    success. If conditional writes are unsupported (501 / `NotImplemented`), it falls back to HEAD
    and then PUT. A 409 `ConditionalRequestConflict` (a concurrent conditional PUT) is retried.
  - **Dedupe hits refresh the age gc sees.** gc never sweeps blobs younger than its age guard, and
    the fs store touches mtime on a dedupe hit so a blob re-referenced during a sweep survives. S3
    has no touch, so on a 412 the store HEADs the object, and if `Last-Modified` is older than 1 h it
    re-PUTs the same bytes unconditionally, which refreshes `Last-Modified`. On a versioned bucket,
    add a lifecycle rule that expires noncurrent versions.
  - `get`: `GET`, where 404 means undefined.
  - `has`: `HEAD` with concurrency 16. `stat` also uses `HEAD` and returns the compressed size and
    `Last-Modified` as `mtimeMs` (gc's age guard). `size()` sums `<Size>` from the listing.
  - `ping()` (optional, for readiness checks): one `ListObjectsV2` with `max-keys=1`.
  - `list`: `ListObjectsV2` with a continuation token, parsing the minimal XML (`<Key>`, entity
    decoding).
  - `delete`: `DELETE`.
- Every request has a 30 s timeout and up to 3 jittered retries on 429, 5xx or network errors.
  Errors name the bucket and key, never headers or credentials.
- `x-amz-content-sha256` is the payload's real hash. RFC 3986 encoding is applied per path segment,
  with no double-encoding.
- **Tests:** the conformance suite runs against MinIO (`CODING_SH_TEST_S3_URL` + AWS env), with a
  random prefix per test. SigV4 has unit tests using the AWS documentation test vectors.

## 4. SDKs

Attaching to an app takes 2 lines plus 2 env vars (`CODING_SH_URL`, `CODING_SH_INGEST_KEY`). Without
a URL, the SDK does nothing. The SDK never changes return values, errors or stream semantics, and it
never throws into the app.

**Event layout matches `src/otel/map.ts` for a model call.**

- Each call produces `llm.call`, with usage, model, `durationMs` and
  `{provider, requestModel, responseModel, ttftMs, stopReason, ok, error?, toolCalls?}`, plus
  `assistant.message {text}`.
- The trace input becomes one `user.message`.
- A trace emits `session.start` and `turn.end`, plus `session.end` when it is its own session. An
  untraced call or span gets the same implicit root, like a root OTel span; its `user.message` is
  the request's last user message.
- Tool helpers emit `tool.start`/`tool.end`.
- A golden test sends the same mock conversation through the SDK and through OTel, and the two
  results must have equal `Session.stats`.
- Sessions:
  - by default, each top-level `trace()`, or each untraced call, is its own session;
  - `sessionId` groups the turns of a conversation.
- The SDK never prices. Pricing happens on the server.

### 4.1 TypeScript: `packages/sdk` → `@codingdotsh/sdk`

It has zero runtime deps, ships ESM and types, and targets Node ≥ 18 (plus Vercel's Node runtime;
edge is best-effort).

```ts
import { observe } from "@codingdotsh/sdk";
const openai = observe(new OpenAI());          // or new Anthropic(); unknown objects are returned untouched
```

**API, frozen:**

- `init(opts?)` takes `{url, key, service, capture: "full"|"metadata", flushIntervalMs = 1000,
  maxBatch = 500, maxQueue = 10000, disabled, debug, fetch}`. It is called implicitly from env.
- `observe(client)` wraps:
  - OpenAI `chat.completions.create` and `responses.create`, sync and stream;
  - Anthropic `messages.create` and `messages.stream`.
- `observeFetch(fetch?)` records LLM calls made over raw HTTP. It matches paths ending in
  `/chat/completions`, `/responses` or `/messages`, including `ai-gateway.vercel.sh`, and reads
  streaming bodies through `tee()`.
- `trace(name, fn, {sessionId?, userId?, metadata?, input?})`.
- `span("tool"|"step", name, fn, {input?})`.
- `withSession(id, fn)`. Context propagates through `AsyncLocalStorage`.
- `aiSdkTracer({sessionId?})` returns an OTel `Tracer`-shaped object. On AI SDK 6 it goes in
  `experimental_telemetry: { isEnabled: true, tracer }`. AI SDK 7 dropped `tracer` and `metadata`
  from telemetry options, so there it goes in `telemetry: { integrations: new OpenTelemetry({ tracer }) }`
  from `@ai-sdk/otel`, and the session comes from `withSession`/`trace` or the `sessionId` option,
  stamped as `session.id`. It encodes spans as OTLP JSON and sends them to `/v1/traces`, where the
  server's existing `ai.*`/`gen_ai.*` mapping handles them. The plain OTel exporter path also works (J3).
- `flush(timeoutMs?)`, `shutdown()`, `stats() → {queued, sent, dropped, failed}`.
- Optional env: `CODING_SH_SERVICE` (else `OTEL_SERVICE_NAME`), `CODING_SH_CAPTURE_MODE`,
  `CODING_SH_DISABLED=1`, `CODING_SH_DEBUG=1`.

**Streams.** For an OpenAI chat stream with no `stream_options`, the SDK adds `include_usage: true`
**and swallows the usage-only final chunk itself**, so the user's loop sees exactly what it would
have seen without the SDK.

**Transport.**

- Batches of ≤ 500 events and ≤ 4 MiB go to `POST /v1/ingest`, gzip-compressed when
  `CompressionStream` or `zlib` is available.
- One request is in flight at a time. Timers are `unref()`'d.
- Retries happen on 429, 5xx and network errors, honoring `Retry-After`, otherwise backing off
  1, 2, 4… s up to 30 s, with at most 5 attempts.
- A 400/401/403 drops the batch and warns once.
- When the queue is full, new events are dropped and counted, and the SDK warns at most once a minute.
- The SDK flushes on `beforeExit`. Apps that call `process.exit` need `await shutdown()`; serverless
  apps use `waitUntil(flush())`.
- Event ids are `crypto.randomUUID()`, fixed when the event is created and reused on every retry.

### 4.2 Python: `packages/sdk-python` → PyPI `coding-sh`, import `coding_sh`

It is stdlib only (Python ≥ 3.9): `urllib`, `threading`, `queue`, `gzip`, `atexit`.

- `coding_sh.observe(client)` wraps `OpenAI`, `AsyncOpenAI`, `Anthropic` and `AsyncAnthropic` when
  installed. Wrapping is idempotent.
- `coding_sh.trace(name, session_id=…)` and `coding_sh.span("tool", name)` work as both context
  managers and decorators.
- `coding_sh.flush()`. A daemon sender thread does the sending, and an `atexit` flush is bounded
  to 2 s.
- The transport, behavior and env vars match the TS SDK. The rest of the API mirrors it in
  snake_case: `init(url, key, service, capture, flush_interval_ms, max_batch, max_queue, disabled, debug)`,
  `with_session(id)` (context manager or decorator), `shutdown()`, `stats()`, `current_session_id()`.
  `trace()` also takes `user_id`, `metadata` and `input`. Context propagates through `contextvars`.
- The event layout and ids match the TS SDK: `parentId` links to the parent's anchor event,
  `toolCalls` is `[{name, id?, arguments?}]`, and `llm.call` also carries `responseId` and
  `gateway: "vercel"` for clients whose base URL is `ai-gateway.vercel.sh`.
- `coding_sh.otel` (extra `coding-sh[otel]`) is the OTel helper for §4.3: `configure()` installs a
  TracerProvider with the OTLP/HTTP exporter (standard `OTEL_EXPORTER_OTLP_*` env, else
  `CODING_SH_URL` + `CODING_SH_INGEST_KEY`) and stamps `gen_ai.conversation.id` from the current
  session; `otel_env()` returns the `OTEL_*` vars for a subprocess.
- Tests use `unittest` against an in-process `http.server`. The golden test (`tests/test_golden.py`)
  runs the core's real OTLP receiver and `buildSession` through `tests/golden/harness.ts`.
- `examples/production/python` also has `app_api.py`, an HTTP API with one trace per request.

### 4.3 Plain OpenTelemetry (no SDK)

Any OTel SDK that emits gen_ai semconv works:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://obs.example.com        # base URL; the SDK appends /v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$CODING_SH_INGEST_KEY"
export OTEL_SERVICE_NAME=checkout-api                              # becomes the agent id
```

- Group turns with `gen_ai.conversation.id` (or `session.id`).
- Spans need `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` and
  `gen_ai.usage.output_tokens`.
- The per-framework recipes in the `src/otel/receiver.ts` header apply unchanged; only the URL and
  the header are different.

## 5. Deploy

- **`Dockerfile` (repo root).**
  - The build stage runs on `node:22-bookworm-slim` on the build platform (`--platform=$BUILDPLATFORM`):
    `npm ci`, a build of `coding.sh`, then an install of the production deps of
    `coding.sh-store-postgres`, `coding.sh-store-s3` and `coding.sh-store-clickhouse`. It is plain
    JavaScript, so the linux/arm64 image needs no emulation.
  - The runtime stage is `gcr.io/distroless/nodejs22-debian12:nonroot`, with
    `CMD ["/app/cli.mjs","serve"]`.
  - It sets `CODING_SH_HOME=/data` (a nonroot-owned directory to mount a volume on; no `VOLUME`
    instruction, which Railway rejects), `CODING_SH_HOST=0.0.0.0` and `EXPOSE 4318`, plus
    `HEALTHCHECK ["/nodejs/bin/node","/app/cli.mjs","serve","healthcheck"]`.
  - With no keys, the first start makes them in `/data/serve-keys.json` (see the first-start keys in §1).
  - The release workflow builds it for linux/amd64 and linux/arm64, smoke tests it and pushes it to
    `ghcr.io/jackulau/coding.sh` on version tags. CI builds and smoke tests it on every change
    (`deploy/test/smoke.mjs`).
- **`deploy/compose/compose{,.postgres,.clickhouse}.yml` (team stacks).**
  - `coding-sh` from `ghcr.io/jackulau/coding.sh:latest` (`CODING_SH_IMAGE`), built from the
    checkout when the pull is denied; port 4318 published on every interface (`CODING_SH_PUBLISH`);
    the `coding-sh-data` volume on `/data`; `stop_grace_period: 30s`.
  - The store is SQLite on the volume, `postgres:17`, or `clickhouse/clickhouse-server` with blobs
    on the volume. The database ports are not published. Database passwords default to `coding`
    (`POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`).
  - Every variable is optional and listed in `deploy/compose/.env.example`. With none set, serve
    makes first-start keys. serve retries opening the store for up to 30 s on connection errors, so
    it can start before the database accepts connections.
- **`docker-compose.yml` (repo root).** The stack the store tests and the journeys below use.
  - Services:
    - `coding-sh`, built from `.` and published on `127.0.0.1:4318`;
    - `postgres` (`postgres:17`, published on `127.0.0.1:5432`);
    - `minio`, published on `127.0.0.1:9000`. MinIO's images are gone from Docker Hub and quay.io,
      so it runs `rustfs/rustfs:1.0.4` (S3 API with conditional writes) under the same name;
    - `minio-init` (`amazon/aws-cli`), which creates the `coding-sh` bucket.
  - Secrets come from `.env`, written by `deploy/compose/gen-env.sh`. The script uses random values,
    writes the file with mode 600 and prints nothing secret. It defines `POSTGRES_PASSWORD`, the MinIO
    credentials (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`), `INGEST_KEY_DEMO`, `INGEST_KEY_FLOOD` and
    `READ_KEY`. It keeps an existing `.env` (Postgres only takes its first password) unless `--force`.
  - The serve container gets:
    - `CODING_SH_STORE_URL=postgres://coding:${POSTGRES_PASSWORD}@postgres:5432/coding`
    - `CODING_SH_BLOB_URL=s3://coding-sh/blobs?endpoint=http://minio:9000`
    - `CODING_SH_INGEST_KEYS=demo:${INGEST_KEY_DEMO},flood:${INGEST_KEY_FLOOD}`
    - `CODING_SH_READ_KEYS=*:${READ_KEY}`
  - It also mounts `deploy/compose/config.toml`, which pins `[pricing."mock-gpt"] input=1 output=2`
    and `[pricing."mock-claude"] input=3 output=15`.
- **`deploy/fly.toml`:** `internal_port = 4318`, an HTTP check on `/readyz`, and a `[mounts]` volume
  at `/data` for sqlite mode. Keys are made on first start and kept on the volume, or set with
  `fly secrets set`.
- **`deploy/railway.json`:** the Dockerfile builder and a `/healthz` healthcheck. The service
  variable `CODING_SH_STORE_URL=${{Postgres.DATABASE_URL}}` is set in the dashboard, because
  `railway.json` cannot hold variables.
- **`render.yaml` (root, for the Deploy button):** a Docker web service, a database whose
  `fromDatabase.connectionString` becomes the store URL, and `healthCheckPath: /healthz`. Blobs
  default to the same Postgres.
- **Railway and Render check `/healthz`, not `/readyz`.** Both start the new instance and wait for its
  check while the old one still runs and holds the writer lock, so a `/readyz` check would never pass.
  Fly (in-place replacement), compose and Kubernetes readiness use `/readyz`.
- Quickstarts live in `docs/production/` (README, compose, fly, railway, render, serverless).

### 5.1 Serverless (Vercel Functions)

Ingest does **not** run as a Function in v1. Run serve as a long-running service (Fly, Railway,
Render, or any container). Apps on Vercel are first-class *senders*: the SDK works in Functions with
`waitUntil(flush())`, and the AI Gateway drain posts to serve.

Why:

1. Session aggregates are rebuilt with a read-modify-write. Serve guarantees a single writer, while
   concurrent Function instances would store stale stats.
2. OTLP mapping keeps per-process trace state (`SpanTree`, `TraceSessionMap`) that is only partly
   persisted to kv.
3. Backpressure and batching need a process that outlives a request. Per-request Functions turn every
   exporter flush into a DB connection, which needs a pooler, and poolers break session advisory locks.

Path forward: the ingest core (decode → map → scope → write) is transport-agnostic. A
`createFetchHandler()` becomes a small adapter once the pg store takes a per-session
`pg_advisory_xact_lock` around each rebuild.

## 6. Build, test and ownership

- Unit tests use `node:test` with a temp `HOME` and `CODING_SH_HOME`. They never touch `~/.claude`,
  `~/.codex` or real configs, never print secrets, and nothing is published.
- Heavy runs go to the desktop, one `DESK_DIR` per builder. Install Docker there when missing:
  `apt-get install -y docker.io docker-compose-v2 && service docker start`.

```sh
DESK_DIR=coding-sh-prod-pg .claude/bin/desk run "docker compose up -d postgres minio minio-init && \
  CODING_SH_TEST_PG_URL=postgres://coding:\$(grep POSTGRES_PASSWORD .env|cut -d= -f2)@127.0.0.1:5432/coding \
  npm test -w coding.sh-store-postgres"
```

| Builder | Owns |
|---|---|
| serve | `src/server/**`, `src/cli/commands/serve.ts`, the registry entry, receiver/viewer handler extraction, schema `project`, sqlite v4, the memory store, conformance additions, `pricing.ts`, the env/`--store` override, the redact rule, the `coding.sh/store` exports, `src/mcp` project args |
| pg | `packages/store-postgres/**` |
| s3 | `packages/blob-s3/**` |
| sdk-ts | `packages/sdk/**`, `examples/production/{node-openai,ai-sdk}` |
| sdk-py | `packages/sdk-python/**`, `examples/production/python` |
| deploy/QA | `Dockerfile`, `docker-compose.yml`, `render.yaml`, `deploy/**`, `examples/production/{mock-llm,flood.mjs,wait-session.mjs}`, the journeys below |

The serve builder ships the `coding.sh/store` export first, because pg and s3 depend on it.

**Shared fixtures (deploy/QA builder):**

- `examples/production/mock-llm/server.mjs` listens on `127.0.0.1:9999`.
  - It serves OpenAI `/v1/chat/completions` (plain and streaming, with the usage chunk when asked)
    and Anthropic `/v1/messages`.
  - It always answers `"pong"` with usage of **1000 input and 500 output** tokens, no cache, echoing
    the requested model.
- `examples/production/mock-llm/answer.mjs` reads stdin and prints `pong`.
- `examples/production/wait-session.mjs --url U --key K --session ID --timeout-ms N` polls
  `/api/sessions/<id>` every 250 ms. It prints `{elapsedMs, stats}` and exits 1 on timeout.
- `examples/production/flood.mjs --url U --key K --events N --batch B --sessions S --seed X
  --concurrency C [--retry]` uses deterministic ids from the seed and session ids `s-0`…`s-<S-1>`. It prints
  `{sent, acked, throttled, retryAfterSeen}` (plus `inserted`, `rejected`, `other`, `requests`,
  `elapsedMs`). With `--retry`, it retries every non-200 and network error, waiting at least
  `Retry-After`, until acked; past `--deadline-ms` (default 600000) it stops and exits 1. A 401 or 403
  is never retried: every worker stops at once, the summary carries `error`, and it exits 1.
- `deploy/test/fixtures.test.mjs` checks these fixtures against a real `coding.sh serve`
  (`node --test "deploy/test/*.test.mjs"`).

## 7. Acceptance journeys (QA)

Run them from the repo root on the desktop
(`DESK_DIR=coding-sh-prod-qa .claude/bin/desk run "…"`). Before each one:

```sh
deploy/compose/gen-env.sh
set -a; . ./.env; set +a
node examples/production/mock-llm/server.mjs &
```

`desk run` re-syncs the repo with `--delete`, which removes the desk's `.env`. Run the later steps of a
journey with `desk sh` (no sync), or a fresh `.env` will not match the running Postgres.

Prices are pinned (§5), so costs are exact. `coding.sh` below means `node packages/coding.sh/dist/cli.mjs`. "Viewer" means a chrome-devtools screenshot of
`http://127.0.0.1:4318/?t=$READ_KEY`.

**J1: compose + Node + OpenAI SDK**

```sh
docker compose up -d --build --wait            # all healthy; GET /readyz → 200 {"ok":true,"store":"postgres",…}
(cd examples/production/node-openai && npm i)
CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO OPENAI_BASE_URL=http://127.0.0.1:9999/v1 \
  OPENAI_API_KEY=mock node examples/production/node-openai/app.mjs
node examples/production/wait-session.mjs --url http://127.0.0.1:4318 --key $READ_KEY --session demo/j1 --timeout-ms 5000
```

- The app runs, in session `j1`, a plain call, a tool span `lookup_order`, a streaming call and a
  plain call, then exits normally.
- Expected: `elapsedMs ≤ 5000`, and `stats.usage = {inputTokens: 3000, outputTokens: 1500, costUsd: 0.006}`
  (±1e-9).
- Also expected: `stats.toolCalls = 1` and `stats.latency.llmCalls = 3`.
- The viewer lists `demo/j1` and its timeline shows 3 model calls and 1 tool call.
- The app's stdout is unchanged with and without the SDK; the streaming call prints `pong`.

**J2: Python (SDK and plain OTel)**

```sh
python3 -m venv .venv && .venv/bin/pip install -q openai anthropic -e packages/sdk-python \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO .venv/bin/python examples/production/python/app_sdk.py
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$INGEST_KEY_DEMO" OTEL_SERVICE_NAME=j2-otel \
  .venv/bin/python examples/production/python/app_otel.py
```

- `demo/j2-sdk` comes from one OpenAI call (`mock-gpt`) and one Anthropic call (`mock-claude`).
  Expected: `inputTokens 2000, outputTokens 1000, costUsd 0.0125`.
- `demo/j2-otel` comes from one `chat mock-gpt` span with `gen_ai.conversation.id=j2-otel`.
  Expected: `1000 / 500 / 0.002`.
- Both appear within 5 s (`wait-session.mjs`).

**J3: AI SDK telemetry**

```sh
(cd examples/production/ai-sdk && npm i)
CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO node examples/production/ai-sdk/app.mjs
```

- The app uses AI SDK 7 (`ai@7` + `@ai-sdk/otel`).
- (a) `generateText` with `telemetry: {functionId: "j3", integrations: new OpenTelemetry({enrichSpan: () => ({"gen_ai.conversation.id": "j3"})})}`
  exports through `@opentelemetry/sdk-node` + `exporter-trace-otlp-proto` to `/v1/traces` with the
  Bearer header. (AI SDK 6 equivalent: `experimental_telemetry: {isEnabled: true, functionId: "j3", metadata: {sessionId: "j3"}}`.)
- (b) The same call with `new OpenTelemetry({tracer: aiSdkTracer()})` inside `withSession("j3-sdk", …)`.
- Each of `demo/j3` and `demo/j3-sdk` has `llmCalls 1` (`doGenerate` is counted once, not the wrapper
  span), with `1000 / 500 / 0.002`.

**J4: SQLite single binary.** J4, J5 and the J7 SQLite variant run `serve` on port 4318, which
the J1 compose stack holds. Run `docker compose stop coding-sh` first, or `serve` fails with
`EADDRINUSE`.

```sh
npm run build -w coding.sh && export CODING_SH_HOME=$(mktemp -d) HOME=$(mktemp -d)
CODING_SH_INGEST_KEYS=demo:csh_ik_0123456789abcdef node packages/coding.sh/dist/cli.mjs serve --host 0.0.0.0; echo $?   # → 2, stderr mentions CODING_SH_READ_KEYS and --insecure
CODING_SH_STORE_URL=sqlite://$CODING_SH_HOME/index.db node packages/coding.sh/dist/cli.mjs serve --config deploy/compose/config.toml & SERVE=$!
CODING_SH_URL=http://127.0.0.1:4318 OPENAI_BASE_URL=http://127.0.0.1:9999/v1 OPENAI_API_KEY=mock node examples/production/node-openai/app.mjs
```

- `GET /readyz` returns `"store":"sqlite"`.
- Session `j1` is unprefixed (project `default`, loopback, no keys), with the same stats as J1.
- `npm ls --omit=dev -w coding.sh` shows no dependencies.
- No `pg` is required, because no plugin is loaded.

**J5: auth and backpressure.** Run serve as in J4, with
`CODING_SH_INGEST_KEYS=demo:$INGEST_KEY_DEMO,flood:$INGEST_KEY_FLOOD`,
`CODING_SH_READ_KEYS=demo:$READ_KEY` and `CODING_SH_QUEUE_MAX_EVENTS=2000`.

| Request | Expect |
|---|---|
| `POST /v1/ingest` without a key, or with `Bearer csh_ik_wrong…` | 401 + `WWW-Authenticate: Bearer` |
| `POST /v1/traces` (protobuf) with a bad key | 401, google.rpc.Status code 16 |
| `POST /v1/ingest` with `$READ_KEY` | 401 |
| `GET /api/sessions` with `$INGEST_KEY_DEMO` | 401 |
| `GET /api/sessions/flood%2Fs-0` with `$READ_KEY` (scoped to `demo`) | 404 |
| `GET /healthz` without auth | 200 |
| `GET /metrics` without auth / with `$READ_KEY` (scoped to `demo`) / with a `*` read key | 401 / 403 / 200, and the 200 body contains `coding_sh_ingest_events_total` |
| A 17 MiB body | 413 |

Then the flood:

```sh
node examples/production/flood.mjs --url http://127.0.0.1:4318 --key $INGEST_KEY_FLOOD --events 50000 --batch 500 --sessions 20 --seed 5 --concurrency 32
```

- The first run (no `--retry`) gets `throttled > 0`, and every 429 carries an integer
  `Retry-After ≥ 1`.
- The stored count equals the acknowledged count exactly:
  `coding.sh sessions --project flood --limit 1000 --json`, summing `stats.events`, equals `acked`.
- A re-run with `--retry` brings that sum to exactly 50,000, so nothing is duplicated.
- The server stays up throughout, and RSS stays under 512 MB.

**J6: CLI, MCP and evals on the production store.** With J1–J3 data in the compose stack:

```sh
export CODING_SH_HOME=$(mktemp -d) HOME=$(mktemp -d) PGURL=postgres://coding:$POSTGRES_PASSWORD@127.0.0.1:5432/coding
node packages/coding.sh/dist/cli.mjs sessions --store $PGURL --project demo --json      # lists demo/j1, demo/j2-sdk, demo/j3 …
CODING_SH_STORE_URL=$PGURL CODING_SH_BLOB_URL=$PGURL node packages/coding.sh/dist/cli.mjs search pong --json   # hits in demo/*
CODING_SH_STORE_URL=$PGURL node packages/coding.sh/dist/cli.mjs show demo/j1           # timeline renders, cost $0.006
```

- **MCP:** pipe `initialize`, `notifications/initialized` and `tools/call sessions_list {"project":"demo"}`
  into `coding.sh mcp` with `CODING_SH_STORE_URL=$PGURL`. The id-2 result contains `demo/j1`.
- **Evals:**

  ```sh
  coding.sh dataset add prod-chats --session demo/j1 --session demo/j3
  coding.sh exp run -d prod-chats \
    --task '{"kind":"command","command":"node","args":["examples/production/mock-llm/answer.mjs"]}' \
    --grader '{"kind":"contains","value":"pong"}' --name prod-smoke --json
  ```

  Both run with `CODING_SH_STORE_URL=$PGURL`. Expected: 2 cases and `passRate 1`.
- **Proof the evals live in PG:**
  `docker compose exec postgres psql -U coding -c "select count(*) from experiments"` returns ≥ 1, and
  `$CODING_SH_HOME/datasets` does not exist. No local spool was ingested.

**J7: crash safety**

```sh
node examples/production/flood.mjs --url http://127.0.0.1:4318 --key $INGEST_KEY_FLOOD --events 20000 --batch 200 --sessions 50 --seed 7 --concurrency 8 --retry & F=$!
sleep 2; docker compose kill -s SIGKILL coding-sh; sleep 1; docker compose up -d --wait coding-sh; wait $F
```

- `flood` exits 0 with `acked = 20000`.
- `select count(*), count(distinct id) from events where project_id='flood'` returns `20000 | 20000`.
- `select count(*), sum((stats::jsonb->>'events')::int) from sessions where project_id='flood'`
  returns `50 | 20000`. Dirty sessions were repaired.
- **SQLite variant:** use the J5 server, which is the J4 command plus
  `CODING_SH_INGEST_KEYS=demo:$INGEST_KEY_DEMO,flood:$INGEST_KEY_FLOOD`. The keys are required. The
  J4 server has no keys, so it rejects `$INGEST_KEY_FLOOD` with 401 and has no `flood` project; flood
  then stops at once with `error` and exit 1. On SQLite the 20,000-event flood takes under 2 s, so
  wait for `/readyz` before the flood and kill 0.5 s into it:

  ```sh
  export CODING_SH_INGEST_KEYS=demo:$INGEST_KEY_DEMO,flood:$INGEST_KEY_FLOOD CODING_SH_STORE_URL=sqlite://$CODING_SH_HOME/index.db
  node packages/coding.sh/dist/cli.mjs serve --config deploy/compose/config.toml & SERVE=$!
  until node packages/coding.sh/dist/cli.mjs serve healthcheck --url http://127.0.0.1:4318/readyz; do sleep 0.2; done
  node examples/production/flood.mjs --url http://127.0.0.1:4318 --key $INGEST_KEY_FLOOD --events 20000 --batch 200 --sessions 50 --seed 7 --concurrency 8 --retry & F=$!
  sleep 0.5; kill -9 $SERVE; sleep 1
  node packages/coding.sh/dist/cli.mjs serve --config deploy/compose/config.toml & SERVE=$!
  wait $F
  ```

  Expect `"error"` absent, `other.network ≥ 1` (the kill landed mid-flood) and the same counts.
  `node -e` running `PRAGMA integrity_check` through `node:sqlite` returns `ok`.
