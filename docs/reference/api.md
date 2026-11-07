# REST API reference

Every HTTP route that `coding.sh serve` answers, with auth, parameters, responses and errors.
Site version: [coding.sh/docs/api](https://coding.sh/docs/api).

The design notes behind these routes live in [PRODUCTION.md](../PRODUCTION.md). Server settings are in
[config.md](config.md#serve), and a full team setup is in [self-host-team.md](../how-to/self-host-team.md).

## Basics

**Base URL.** One process, one port. The default is `http://127.0.0.1:4318`, so an
`OTEL_EXPORTER_OTLP_ENDPOINT` base URL works as is. Serve speaks plain HTTP; put TLS on the platform
or a proxy in front of it.

**Auth.** Each route takes one kind of credential.

| Credential | How to send it | Opens |
|---|---|---|
| Ingest key `csh_ik_…` | `Authorization: Bearer csh_ik_…` | `/v1/*` ingest routes |
| Read key `csh_rk_…` | `Authorization: Bearer csh_rk_…`, the `csh_rk` cookie, or `/?t=<key>` once in a browser | `/`, `/api/*`; `/metrics` only with a `*` key |
| Basic auth | `Authorization: Basic …` for the user in `CODING_SH_BASIC_AUTH` | `/`, `/api/*`, `/metrics` |
| none | | `/healthz`, `/readyz` |

- Create keys with `coding.sh serve keygen`. The key goes to stdout once; the server keeps only its sha256.
- Ingest keys cannot read and read keys cannot ingest. Each gets 401.
- On a loopback bind with no keys configured, ingest is open and lands in project `default`, and reads are open too.
- A non-loopback bind refuses to start without an ingest key and a read key (or basic auth), unless you pass `--insecure`.

**Projects.** The ingest key decides the project of everything it sends; a client cannot pick one.
Every project other than `default` gets its session ids stored as `<project>/<sessionId>`, so
`chat-1` sent with a `team` key becomes `team/chat-1`. Percent-encode the slash when an id goes in a
path: `/api/sessions/team%2Fchat-1`. The raw form `/api/sessions/team/chat-1` answers 404 with a hint
to encode it (the viewer always encodes ids). A read key scoped to one project sees only that project: lists
are filtered, other sessions answer 404, and eval data (tasks, runs, bundles, experiments) comes back
empty. A `*` read key sees every project and can filter with `?project=`.

**Content types.** Requests: `application/json` for `/v1/ingest` and `POST /api/labels`;
`application/json` or `application/x-protobuf` for OTLP. Ingest bodies may use `Content-Encoding`
`gzip`, `deflate` or `br`. Responses are JSON, except the viewer page (HTML), `/metrics` (Prometheus
text), blobs (`text/plain`) and OTLP protobuf requests (answered in protobuf).

**Limits.**

| Limit | Value |
|---|---|
| Ingest body, before and after decompression | 16 MiB (16777216 bytes) |
| Events per `/v1/ingest` request | 10,000 |
| Ingest queue | 50,000 events or 128 MiB (`CODING_SH_QUEUE_MAX_EVENTS`, `CODING_SH_QUEUE_MAX_BYTES`) |
| `POST /api/labels` body | 1 MB |
| Blob response | 2 MiB unless `?full=1` |
| Request headers / whole request | 20 s / 120 s |

**Errors.** Ingest and read routes answer `{"error": "…", "status": N}`. OTLP routes answer in
google.rpc.Status form, `{"code": N, "message": "…"}` with the gRPC code (16 unauthenticated,
8 resource exhausted, 3 invalid argument), or the protobuf encoding of the same when the request
was protobuf. A 429 or 503 carries `Retry-After` in seconds; clients should wait and resend. Ingest is
idempotent on event ids, so a resend never duplicates.

**Running the examples.** Every example below ran against a server started like this, with a fresh
`CODING_SH_HOME`:

```sh
INGEST_KEY=$(coding.sh serve keygen --project team)
READ_KEY=$(coding.sh serve keygen --read --project '*')
SUPPORT_READ_KEY=$(coding.sh serve keygen --read --project support)
CODING_SH_INGEST_KEYS="team:$INGEST_KEY" \
CODING_SH_READ_KEYS="*:$READ_KEY,support:$SUPPORT_READ_KEY" \
coding.sh serve --port 4318 &
CSH=http://127.0.0.1:4318
```

The experiment examples use `$EXP_A` and `$EXP_B`: two ids from `coding.sh exp list`, run with the
same `CODING_SH_HOME` as the server.

## Routes

| Method | Path | Auth | Served by |
|---|---|---|---|
| POST | [`/v1/ingest`](#post-v1ingest) | ingest key | serve |
| POST | [`/v1/traces`](#post-v1traces-post-v1logs-post-v1metrics) | ingest key | serve, collector |
| POST | [`/v1/logs`](#post-v1traces-post-v1logs-post-v1metrics) | ingest key | serve, collector |
| POST | [`/v1/metrics`](#post-v1traces-post-v1logs-post-v1metrics) | ingest key | serve, collector |
| GET | [`/healthz`](#get-healthz) | none | serve |
| GET | [`/readyz`](#get-readyz) | none | serve |
| GET | [`/metrics`](#get-metrics) | `*` read key or basic auth | serve |
| GET | [`/`](#get--get-indexhtml) | read key or basic auth | serve, ui |
| GET | [`/index.html`](#get--get-indexhtml) | read key or basic auth | serve, ui |
| GET | [`/api/projects`](#get-apiprojects) | read key or basic auth | serve, ui |
| GET | [`/api/sessions`](#get-apisessions) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}`](#get-apisessionsid) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}/events`](#get-apisessionsidevents) | read key or basic auth | serve, ui |
| GET | [`/api/blobs/{sha256}`](#get-apiblobssha256) | read key or basic auth | serve, ui |
| GET | [`/api/search`](#get-apisearch) | read key or basic auth | serve, ui |
| GET | [`/api/stats`](#get-apistats) | read key or basic auth | serve, ui |
| GET | [`/api/labels`](#get-apilabels) | read key or basic auth | serve, ui |
| POST | [`/api/labels`](#post-apilabels) | read key or basic auth | serve, ui |
| GET | [`/api/experiments`](#get-apiexperiments) | read key or basic auth | serve, ui |
| GET | [`/api/experiments/{id}`](#get-apiexperimentsid) | read key or basic auth | serve, ui |
| GET | [`/api/compare`](#get-apicompare) | read key or basic auth | serve, ui |
| GET | [`/api/benchmarks`](#get-apibenchmarks) | read key or basic auth | serve, ui |
| GET | [`/api/benchmarks/{name}`](#get-apibenchmarksname) | read key or basic auth | serve, ui |
| GET | [`/api/tasks`](#get-apitasks-get-apiruns-get-apibundles) | read key or basic auth | serve, ui |
| GET | [`/api/runs`](#get-apitasks-get-apiruns-get-apibundles) | read key or basic auth | serve, ui |
| GET | [`/api/bundles`](#get-apitasks-get-apiruns-get-apibundles) | read key or basic auth | serve, ui |
| GET | [`/api/update`](#get-apiupdate) | read key or basic auth | serve, ui |
| GET | [`/api/ingest`](#get-apiingest) | read key or basic auth | serve, ui |

Any other path answers 404 `{"error":"not found","status":404}`.

## Which process serves what

`coding.sh serve` answers every route above. Two local commands answer a subset on their own port:

- `coding.sh ui` (default port 4319) serves `/`, `/index.html` and every `/api/*` route. Auth is a random token made per process: open the printed `/?t=…` URL once, or send `Authorization: Bearer <token>`. Read keys and basic auth do not apply. It binds loopback, checks the `Host` header, and has no `/v1/*`, `/healthz`, `/readyz` or `/metrics`. Its `/api/update` really checks for a new release.
- `coding.sh collector` (default port 4318) serves only `POST /v1/traces`, `/v1/logs` and `/v1/metrics`, with no auth. It binds loopback, rejects a non-loopback `Host` header, and allows browser origins on localhost. Every other path, including `/healthz` and `/v1/ingest`, answers 404 `{"code":5,"message":"no route for /healthz; use /v1/traces, /v1/logs or /v1/metrics"}`.
- `coding.sh serve --role viewer` is a read replica. It answers 404 `{"error":"this replica runs --role viewer and takes no ingest","status":404}` on every `/v1/*` route and serves the rest.

## Ingest

### `POST /v1/ingest`

Native batched ingest, used by the SDKs. Auth: ingest key. Body: `{"v": 0, "service": "…", "events": [AgentEvent, …]}`.

Each event needs `v: 0`, an `id` (1-128 printable ASCII characters, unique per project; a resend with
the same id inserts nothing), a `sessionId` (1-200 characters, no control characters), a `kind`, a
`ts` in epoch milliseconds no later than now plus one day, and a `payload` object. Optional fields:
`parentId`, `turnId`, `subagentId`, `agent`, `agentVersion`, `model`, `runId`, `traceId`, `spanId`,
`parentSpanId`, `cwd`, `source`, `durationMs`, `usage` (`inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `costUsd`, all non-negative) and `repo`. Anything else, and
`blobs`, is dropped.

Kinds: `session.start`, `session.end`, `user.message`, `assistant.message`, `llm.call`, `tool.start`,
`tool.end`, `context.compact`, `turn.end`, `subagent.start`, `subagent.end`, `file.change`,
`test.result`, `notification`, `span`, `error`.

The server sets `project` from the key, `source` to `"sdk"` when absent, and `agent` to the
kebab-cased `service` (or `"sdk"`) when absent. An invalid event is rejected on its own and the rest
are kept.

```sh
curl -sS -X POST "$CSH/v1/ingest" \
  -H "Authorization: Bearer $INGEST_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'EOF'
{
  "v": 0,
  "service": "support-bot",
  "events": [
    { "v": 0, "id": "evt-1", "sessionId": "chat-1", "ts": 1793872800000, "kind": "user.message",
      "payload": { "text": "Where is order 1042?" } },
    { "v": 0, "id": "evt-2", "sessionId": "chat-1", "ts": 1793872801000, "kind": "llm.call",
      "model": "gpt-4o", "durationMs": 900, "usage": { "inputTokens": 820, "outputTokens": 46 },
      "payload": { "ok": true } },
    { "v": 0, "id": "evt-3", "sessionId": "chat-1", "ts": 1793872802000, "kind": "tool.start",
      "payload": { "tool": "lookup_order", "toolUseId": "t1", "input": { "id": 1042 } } },
    { "v": 0, "id": "evt-4", "sessionId": "chat-1", "ts": 1793872802400, "kind": "tool.end",
      "durationMs": 400, "payload": { "tool": "lookup_order", "toolUseId": "t1", "ok": true, "output": "shipped" } },
    { "v": 0, "id": "evt-5", "sessionId": "chat-1", "ts": 1793872803000, "kind": "assistant.message",
      "payload": { "text": "Order 1042 shipped yesterday." } },
    { "v": 0, "id": "evt-6", "sessionId": "chat-1", "ts": -1, "kind": "session.end", "payload": {} }
  ]
}
EOF
```

```json
{"accepted":5,"inserted":5,"rejected":[{"index":5,"error":"ts must be epoch milliseconds between 0 and now + 1 day"}]}
```

A 200 means the events are committed. `accepted` counts valid events, `inserted` the ones that were
new (sending the same batch again gives `"inserted":0`), and `rejected` lists invalid events by index.

Browsers: a request with an `Origin` header is refused (403) unless that origin is listed in
`serve.cors_origins`. An allowed origin gets `Access-Control-Allow-Origin` on every answer, errors
included, and `OPTIONS` answers the preflight with 204 (methods `POST, OPTIONS`; headers
`Authorization, Content-Type, Content-Encoding`). Requests without `Origin` (server-side SDKs, curl)
are unaffected.

| Status | When | Body |
|---|---|---|
| 200 | committed | `{"accepted":n,"inserted":k,"rejected":[…]}` |
| 400 | body is not JSON, not an object, `v` is not 0, `events` is missing, or more than 10,000 events | `{"error":"events must be an array","status":400}` |
| 401 | missing or wrong key, or a read key; sets `WWW-Authenticate: Bearer` | `{"error":"missing or invalid ingest key; send Authorization: Bearer <key>","status":401}` |
| 404 | the server runs `--role viewer` | `{"error":"this replica runs --role viewer and takes no ingest","status":404}` |
| 403 | `Origin` not in `serve.cors_origins` | `{"error":"origin https://app.example.com is not allowed","status":403}` |
| 405 | method is not POST or OPTIONS; sets `Allow: POST, OPTIONS` | `{"error":"use POST","status":405}` |
| 413 | body over 16 MiB | `{"error":"request body exceeds 16777216 bytes","status":413}` |
| 415 | `Content-Type` is not `application/json`, or an unknown `Content-Encoding` | `{"error":"Content-Type must be application/json","status":415}` |
| 429 | ingest queue full; `Retry-After` set | `{"error":"ingest queue is full; retry after 1s","status":429}` |
| 503 | store error, shutting down, or a standby replica; `Retry-After` set | `{"error":"server is shutting down; retry","status":503}` |

### `POST /v1/traces`, `POST /v1/logs`, `POST /v1/metrics`

OTLP/HTTP. Auth: ingest key. Point an OpenTelemetry exporter at the base URL and it appends the
path:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20csh_ik_…
```

Bodies are `application/json` or `application/x-protobuf`, optionally compressed. Traces and logs
become events and sessions: one session per trace, or per conversation when spans carry
`gen_ai.conversation.id` or `session.id`. Metrics are accepted and dropped. Event ids come from
traceId and spanId, so re-exports insert nothing. `OPTIONS` answers CORS preflight; browser origins
are refused unless listed in `serve.cors_origins`.

```sh
curl -sS -X POST "$CSH/v1/traces" \
  -H "Authorization: Bearer $INGEST_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'EOF'
{
  "resourceSpans": [{
    "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "triage-agent" } }] },
    "scopeSpans": [{
      "scope": { "name": "manual" },
      "spans": [{
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "00f067aa0ba902b7",
        "name": "chat gpt-4o",
        "kind": 3,
        "startTimeUnixNano": "1793880000000000000",
        "endTimeUnixNano": "1793880001200000000",
        "attributes": [
          { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
          { "key": "gen_ai.request.model", "value": { "stringValue": "gpt-4o" } },
          { "key": "gen_ai.conversation.id", "value": { "stringValue": "triage-12" } },
          { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "410" } },
          { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "38" } }
        ]
      }]
    }]
  }]
}
EOF
```

```json
{}
```

That span becomes session `team/triage-12`. When some spans or log records cannot be stored, the
rest are kept and the 200 body says so (`rejectedLogRecords` for logs):

```json
{"partialSuccess":{"rejectedSpans":"1","errorMessage":"span \"broken\" has no valid traceId/spanId"}}
```

| Status | When | Body (JSON requests) |
|---|---|---|
| 200 | committed | `{}` or `{"partialSuccess":{…}}` |
| 204 | `OPTIONS` preflight with no `Origin`, or an allowed one | empty |
| 400 | body does not decode | `{"code":3,"message":"invalid JSON: …"}` |
| 401 | missing or wrong key; sets `WWW-Authenticate: Bearer` | `{"code":16,"message":"missing or invalid ingest key; send Authorization: Bearer <key>"}` |
| 403 | `Origin` not in `serve.cors_origins` | `{"code":7,"message":"origin https://app.example.com is not allowed"}` |
| 404 | the server runs `--role viewer` | `{"error":"this replica runs --role viewer and takes no ingest","status":404}` |
| 405 | method is not POST or OPTIONS; sets `Allow` | `{"code":12,"message":"method GET not allowed"}` |
| 413 | body over 16 MiB | `{"code":8,"message":"request body exceeds 16777216 bytes"}` |
| 415 | other `Content-Type`, or an unknown `Content-Encoding` | `{"code":3,"message":"unsupported Content-Type \"text/plain\"; use application/x-protobuf or application/json"}` |
| 429 | ingest queue full; `Retry-After` set | `{"code":8,"message":"ingest queue is full; retry after 1s"}` |
| 503 | store error, shutting down, or a standby replica; `Retry-After` set | `{"code":14,"message":"server is shutting down; retry"}` |

## Health and metrics

`/healthz`, `/readyz` and `/metrics` answer `GET` and `HEAD`. Any other method gets 405
`{"error":"method not allowed","status":405}` with `Allow: GET, HEAD`.

### `GET /healthz`

Auth: none. 200 while the process is up. It never touches the store.

```sh
curl -sS "$CSH/healthz"
```

```json
{"ok":true}
```

### `GET /readyz`

Auth: none. 200 when the store answers within 2 s, this replica holds the writer lock (or runs
`--role viewer`), the queue is under 90% and the server is not shutting down. Otherwise 503, with
`reason` set to `store did not answer`, `shutting down`, `standby: another replica holds the writer lock`
or `ingest queue above 90%`. The body holds no secrets.

```sh
curl -sS "$CSH/readyz"
```

```json
{"ok":true,"store":"sqlite","writer":true,"role":"all","queue":{"events":0,"max":50000},"insecure":false}
```

A `--role viewer` replica answers `{"ok":true,"store":"sqlite","writer":false,"role":"viewer",…}`.

### `GET /metrics`

Auth: a `*` read key or basic auth (or nothing, on a loopback bind with no keys). The counters cover
every project and their labels name them, so a project-scoped read key gets 403
`{"error":"metrics need a read key for every project (\"*\") or basic auth","status":403}`.
Prometheus text format (`text/plain; version=0.0.4`). The metric names are
listed in [PRODUCTION.md](../PRODUCTION.md#17-metrics-and-logs).

```sh
curl -sS "$CSH/metrics" -H "Authorization: Bearer $READ_KEY"
```

```text
# HELP coding_sh_http_requests_total HTTP requests by route and status.
# TYPE coding_sh_http_requests_total counter
coding_sh_http_requests_total{route="/v1/ingest",status="200"} 4
coding_sh_http_requests_total{route="/v1/traces",status="200"} 2
# HELP coding_sh_ingest_events_total Ingested events by project and result.
# TYPE coding_sh_ingest_events_total counter
coding_sh_ingest_events_total{project="team",result="inserted"} 26
coding_sh_ingest_events_total{project="team",result="duplicate"} 17
coding_sh_ingest_events_total{project="team",result="rejected"} 2
coding_sh_queue_events 0
coding_sh_writer_lock_held 1
```

Without a valid read credential: 401 `{"error":"missing or invalid read key","status":401}` with
`WWW-Authenticate: Bearer` (or `Basic realm="coding.sh"` when basic auth is configured).

## Viewer

### `GET /`, `GET /index.html`

The viewer page (HTML, also `HEAD`). Auth: read key or basic auth. `/?t=<read key>` trades the key
for an `HttpOnly; SameSite=Strict` cookie named `csh_rk` and redirects to `/`, so the key leaves the
address bar. Add `CODING_SH_TRUST_PROXY=1` behind a TLS proxy to mark the cookie `Secure`.

```sh
curl -sS -i "$CSH/?t=$READ_KEY"
```

```text
HTTP/1.1 302 Found
Set-Cookie: csh_rk=csh_rk_…; HttpOnly; SameSite=Strict; Path=/
Location: /
```

A missing or wrong key gets a 401 HTML page that explains how to sign in, with
`WWW-Authenticate: Basic` when basic auth is configured. Other methods get 405.

## Read API

All `/api/*` routes take a read key or basic auth, answer JSON with `Cache-Control: no-store`, and
share these errors:

| Status | When | Body |
|---|---|---|
| 400 | a bad parameter | `{"error":"limit must be between 1 and 500","status":400}` |
| 401 | no valid read credential | `{"error":"missing or invalid token","status":401}` |
| 403 | the server binds loopback and the `Host` header is not loopback (DNS-rebinding guard) | `{"error":"forbidden host","status":403}` |
| 404 | unknown route, a session outside the key's project, or a session id with a raw `/` (the error says to send `%2F`) | `{"error":"not found","status":404}` |
| 405 | wrong method | `{"error":"method not allowed","status":405}` |

Times are epoch milliseconds. `since` is inclusive and `until` exclusive, both on a session's start.

### `GET /api/projects`

Project ids the server knows: `default`, every project in the config, every project named by a
configured key, and every project that has sessions in the store (so a `--role viewer` replica with
only a `*` key still lists them all). A scoped read key gets only its own project.

```sh
curl -sS "$CSH/api/projects" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":["default","support","team"]}
```

### `GET /api/sessions`

Sessions, newest first.

| Parameter | Default | Meaning |
|---|---|---|
| `limit` | 50 | 1 to 500 |
| `offset` | 0 | rows to skip |
| `cursor` | | `nextCursor` from the previous page; steadier than `offset` while data arrives |
| `project` | all | one project (`*` read keys only; scoped keys are always filtered) |
| `scope` | `all` | `top` leaves out subagent sessions |
| `parent` | | only children of this session id |
| `agent`, `model`, `flag`, `repo` | | exact match on the session |
| `since`, `until` | | start time range |
| `q` | | substring of title, id, repo, branch or model (up to 500 characters) |

```sh
curl -sS "$CSH/api/sessions?project=team&limit=1" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "items": [{
    "id": "team/triage-12", "agent": "triage-agent", "startedAt": 1793880000000, "endedAt": 1793880001200,
    "stats": {"events": 3, "turns": 1, "toolCalls": 0, "toolErrors": 0, "filesChanged": 0,
      "usage": {"inputTokens": 410, "outputTokens": 38, "costUsd": 0.001405},
      "latency": {"wallMs": 1200, "llmCalls": 1, "llmMs": 1200, "llmP50Ms": 1200, "llmP95Ms": 1200}},
    "flags": [], "model": "gpt-4o", "traceIds": ["4bf92f3577b34da6a3ce929d0e0e4736"], "project": "team", "childCount": 0
  }],
  "limit": 1, "offset": 0, "hasMore": true, "nextCursor": "1793880000000:team/triage-12"
}
```

`childCount` is the number of subagent sessions under each row. `nextCursor` is present only when
`hasMore` is true; pass it back as `cursor` for the next page:

```sh
curl -sS "$CSH/api/sessions?project=team&limit=1&cursor=1793880000000:team/triage-12" -H "Authorization: Bearer $READ_KEY"
```

That page holds `team/chat-1`.

### `GET /api/sessions/{id}`

One session, the same shape as a list row without `childCount`. Percent-encode the id.

```sh
curl -sS "$CSH/api/sessions/team%2Fchat-1" -H "Authorization: Bearer $READ_KEY"
```

```json
{"id":"team/chat-1","agent":"support-bot","startedAt":1793872800000,"stats":{"events":5,"turns":1,"toolCalls":1,"toolErrors":0,"filesChanged":0,"usage":{"inputTokens":820,"outputTokens":46,"costUsd":0.00251,"estimatedCostUsd":0.00251},"latency":{"wallMs":3000,"llmCalls":1,"llmMs":900,"llmP50Ms":900,"llmP95Ms":900,"toolMs":400,"toolP95Ms":400}},"flags":[],"model":"gpt-4o","title":"Where is order 1042?","endedAt":1793872803000,"project":"team"}
```

`stats.usage.costUsd` is the reported or gateway-billed cost where there is one, else token counts
times list price; `estimatedCostUsd` is the part that was estimated (here all of it). Each estimated
`llm.call` has `payload.costEstimated: true`, plus `payload.pricedAs` when a sibling model's price was
used. `stats.duplicateUsage` (`calls`, `tokens`, `costUsd`) is model-call usage left out because an
enclosing call or an earlier copy of the same response already counted it.

A missing session, or one outside a scoped key's project, gets 404:

```sh
curl -sS "$CSH/api/sessions/team%2Fchat-1" -H "Authorization: Bearer $SUPPORT_READ_KEY"
```

```json
{"error":"session not found","status":404}
```

### `GET /api/sessions/{id}/events`

A session's events in order. Parameters: `limit` (1 to 20,000, default 5,000), `offset`, and
`kinds` (comma-separated). Native-ingest ids come back as stored hashes.

```sh
curl -sS "$CSH/api/sessions/team%2Fchat-1/events?kinds=tool.start,tool.end" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "items": [
    {"id": "54b366d0…", "v": 0, "sessionId": "team/chat-1", "ts": 1793872802000, "agent": "support-bot",
     "kind": "tool.start", "payload": {"tool": "lookup_order", "toolUseId": "t1", "input": {"id": 1042}},
     "source": "sdk", "project": "team"},
    {"id": "22270b1c…", "v": 0, "sessionId": "team/chat-1", "ts": 1793872802400, "agent": "support-bot",
     "kind": "tool.end", "payload": {"tool": "lookup_order", "toolUseId": "t1", "ok": true, "output": "shipped"},
     "durationMs": 400, "source": "sdk", "project": "team"}
  ],
  "limit": 5000, "offset": 0, "hasMore": false
}
```

### `GET /api/blobs/{sha256}`

The raw content behind a ref in an event's `blobs` array (full tool output, diffs, the source span).
Always `text/plain` with `X-Blob-Size` (full size) and `X-Truncated` (`1` when cut at 2 MiB). Add
`?full=1` for the whole blob. Blobs are content-addressed and shared across projects: a scoped key
that knows another project's hash can fetch it.

Here `$BLOB` is the source span of the OTLP example above:

```sh
BLOB=$(curl -sS "$CSH/api/sessions/team%2Ftriage-12/events?limit=1" -H "Authorization: Bearer $READ_KEY" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].blobs[0]')
curl -sS -i "$CSH/api/blobs/$BLOB" -H "Authorization: Bearer $READ_KEY"
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
X-Blob-Size: 513
X-Truncated: 0

{"format":"otlp.span","v":0,"resource":{"service.name":"triage-agent"},"scope":{"name":"manual"},"span":{"name":"chat gpt-4o",…}}
```

A ref that is not 64 lowercase hex characters gets 400 `{"error":"blob ref must be 64 lowercase hex chars","status":400}`;
an unknown one gets 404 `{"error":"blob not found","status":404}`.

### `GET /api/search`

Full-text search over prompts, replies and tool I/O. `q` is required (up to 500 characters).
Also takes `limit` (1 to 500, default 50), `project`, `scope`, `agent`, `model`, `flag`, `repo`,
`since` and `until`. Matches in `snippet` are wrapped in `«…»`.

```sh
curl -sS "$CSH/api/search?q=order&limit=1" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":[{"event":{"id":"22270b1c…","v":0,"sessionId":"team/chat-1","ts":1793872802400,"agent":"support-bot","kind":"tool.end","payload":{"tool":"lookup_order","toolUseId":"t1","ok":true,"output":"shipped"},"durationMs":400,"source":"sdk","project":"team"},"snippet":"lookup_«order»\nshipped"}]}
```

Without `q`: 400 `{"error":"q is required","status":400}`.

### `GET /api/stats`

Totals and facet counts for the session list. Takes `project`, `scope`, `agent`, `model`, `flag`,
`repo`, `since` and `until`. Each facet applies every filter except its own. `histogram` buckets
session starts over at most the 90 days before the newest session.

```sh
curl -sS "$CSH/api/stats?project=team&agent=support-bot" -H "Authorization: Bearer $READ_KEY"
```

```json
{"sessions":1,"subagents":0,"byAgent":{"triage-agent":1,"support-bot":1},"byFlag":{},"byRepo":{},"byModel":{"gpt-4o":1},"toolCalls":1,"toolErrors":0,"llmCalls":1,"costUsd":0.00251,"estimatedCostUsd":0.00251,"pricedSessions":1,"withTests":0,"testsFailing":0,"histogram":{"step":300000,"from":1793872800000,"buckets":[{"t":1793872800000,"n":1,"flagged":0}]}}
```

`byAgent` still lists every agent in `team`, because a facet skips its own filter. The totals apply all of them.

### `POST /api/labels`

Adds or replaces a label. Body (JSON, up to 1 MB): `sessionId` (required), `value` (`pass`, `fail`
or `skip`), `criterion` (default `outcome`, 1-100 characters of letters, digits and `_.:-`) and an
optional `note` (up to 4,000 characters). There is one label per session, criterion and labeller, so
labelling again replaces it. `by` is the basic-auth user name, the read key's `name` from
`[serve.viewer] read_keys`, or else `reader:` and the first 12 hex characters of the key's sha256
(never the key), so each read key keeps its own labels.

```sh
curl -sS -X POST "$CSH/api/labels" \
  -H "Authorization: Bearer $READ_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"team/chat-1","criterion":"resolved","value":"pass","note":"Answered with the tracking status."}'
```

```json
{"id":"1cec1aa4e5d701ef71b2682544643f4a214369b8602b84be04a77bb431521d75","sessionId":"team/chat-1","criterion":"resolved","value":"pass","by":"reader:3f9a1c0b7d2e","ts":1794030915938,"note":"Answered with the tracking status."}
```

| Status | When | Body |
|---|---|---|
| 201 | stored | the label |
| 400 | bad field or invalid JSON | `{"error":"value must be pass, fail or skip","status":400}` |
| 403 | an `Origin` header that is not this server | `{"error":"forbidden origin","status":403}` |
| 404 | session missing or outside the key's project | `{"error":"session not found","status":404}` |
| 413 | body over 1 MB | `{"error":"request body exceeds 1 MB","status":413}` |
| 415 | not `application/json` | `{"error":"content-type must be application/json","status":415}` |

### `GET /api/labels`

Human labels. Filters: `sessionId` and `criterion`. A scoped key sees only labels on its project's
sessions.

```sh
curl -sS "$CSH/api/labels?sessionId=team%2Fchat-1" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":[{"id":"1cec1aa4…","sessionId":"team/chat-1","criterion":"resolved","value":"pass","by":"reader:3f9a1c0b7d2e","ts":1794030915938,"note":"Answered with the tracking status."}]}
```

### `GET /api/experiments`

Dataset experiments written by `coding.sh exp run`, newest first, without their per-case runs.
Parameters: `limit` (1 to 500, default 50), `dataset` (dataset id) and `name`. Empty for a scoped key.

```sh
curl -sS "$CSH/api/experiments?dataset=refunds&name=baseline" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "items": [{
    "id": "exp_01M6T9E8YNKKKEX4GTT1TY5XQ5", "name": "baseline", "status": "completed",
    "dataset": {"id": "refunds", "name": "refunds", "version": "09d855430b57ff15"},
    "task": {"kind": "command", "ref": "echo 4"},
    "graders": [{"id": "exact", "version": "48fe67515f989183", "kind": "exact"}],
    "trials": 1, "createdAt": 1794031166421, "finishedAt": 1794031166436,
    "summary": {"n": 3, "cases": 3, "passed": 1, "errors": 0, "ungraded": 0,
      "passRate": {"p": 0.3333333333333333, "lo": 0.06149194472039621, "hi": 0.7923403991979522}, "ciMethod": "wilson", …},
    "runCount": 3
  }]
}
```

### `GET /api/experiments/{id}`

One experiment with its case runs (up to 5,000; `runsTruncated` says when more exist). Outputs over
4,000 characters are cut and marked `outputTruncated`. Ids come from `coding.sh exp list`. Unknown
ids, and any id for a scoped key, get 404 `{"error":"experiment not found","status":404}`.

```sh
curl -sS "$CSH/api/experiments/$EXP_A" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "id": "exp_01M6T9E8YNKKKEX4GTT1TY5XQ5", "name": "baseline", "status": "completed", …, "runCount": 3,
  "runs": [
    {"caseId": "c_992c448def7d1479", "trial": 1, "latencyMs": 11.42, "grades": [{"graderId": "exact", "result": {"score": 1, "pass": true}}], "pass": true, "startedAt": 1794031166424, "output": 4},
    {"caseId": "c_47dd42650c395e5c", "trial": 1, "latencyMs": 6.63, "grades": [{"graderId": "exact", "result": {"score": 0, "pass": false, "reason": "expected \"6\", got \"4\""}}], "pass": false, "startedAt": 1794031166429, "output": 4}
  ],
  "runsTruncated": false
}
```

### `GET /api/compare`

Paired comparison of two experiments: `a` is the baseline, `b` the candidate. Both are required.
The server computes the statistics. `partial` lists sides that were cancelled.

```sh
curl -sS "$CSH/api/compare?a=$EXP_A&b=$EXP_B" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "a": {"id": "exp_01M6T9E8YNKKKEX4GTT1TY5XQ5", "name": "baseline", "passRate": 0.3333333333333333},
  "b": {"id": "exp_01M6T9E94FSMK542B6WQHNCDMR", "name": "candidate", "passRate": 1},
  "ungraded": {"a": 0, "b": 0}, "paired": 3, "onlyInA": [], "onlyInB": [],
  "diff": {"mean": 0.6666666666666666, "lo": 0, "hi": 1, "iters": 4000},
  "mcnemar": {"b": 0, "c": 2, "n": 2, "p": 0.5}, "verdict": "inconclusive",
  "timing": {"interleaved": false, "gapMs": 81, "warning": "A and B ran one after the other, not interleaved, …"},
  "regressions": [], "improvements": [{"caseId": "c_47dd42650c395e5c", "a": 0, "b": 1, "delta": 1}, …],
  "graders": [{"id": "exact", "n": 3, "meanA": 0.3333333333333333, "meanB": 1, "diff": {"mean": 0.6666666666666666, "lo": 0, "hi": 1}}],
  "attrition": {"a": {"runs": 3, "completed": 3, "errored": 0, "infra": 0, "agent": 0, "ungraded": 0, "missing": 0, "lost": 0}, "b": {…}, "p": 1},
  "power": {"alpha": 0.05, "power": 0.8, "n": 3, "mde": 0.9338617396156048, "minPaired": 200, "warnings": […], …},
  "posterior": {"pBetter": 0.875, "mean": 0.2857142857142857, "lo": -0.24060826256615866, "hi": 0.7345975081216372, "prior": 1, "draws": 20000},
  "partial": []
}
```

A missing or malformed id gets 400 `{"error":"a and b must be experiment ids","status":400}`; an
unknown one gets 404 `{"error":"experiment not found","status":404}`.

### `GET /api/benchmarks`

Daily benchmarks written by `coding.sh bench run`, read from `~/.coding.sh/benchmarks/<name>/runs`.
Newest first. Each item has the latest run's leaderboard and the last 30 daily pass rates per
contender. `coding.sh ui` reads the local benchmark folder; `coding.sh serve` has none, so it
answers an empty list, as does a scoped key.

```sh
curl -sS "$CSH/api/benchmarks" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "items": [{
    "name": "coding-sh-issues", "description": "Fresh coding.sh issues each day; the agent's patch has to pass the repo's tests.",
    "counted": 24, "total": 24, "reference": "claude-code",
    "latest": {"id": "bench_codingshissues20261107", "date": "2026-11-07", "cases": 30, "mode": "scheduled", "status": "complete", "dataset": "coding-sh-issues@261107"},
    "contenders": [{"name": "codex", "model": "gpt-6.1-sol", "place": 1, "n": 30, "passed": 19, "passRate": {"p": 0.6333, "lo": 0.4551, "hi": 0.7813}}, …],
    "trend": {"claude-code": [0.6, 0.4, 0.7333, …], "codex": [0.4667, 0.3333, …]}
  }]
}
```

`counted` is the number of runs on the current protocol; `total` counts every run.

### `GET /api/benchmarks/{name}`

The same report `coding.sh bench show <name> --json` prints: the latest run, daily history per
metric, the gap to the reference contender, the pooled gap, difficulty, the anchor set, cases whose
content changed, the seed check and the failed cases. Two things differ: `cases` is left out, and
each failure carries `hasSession` (whether the session is in this index, so the page can link to
it) in place of `sessionUrl`.

```sh
curl -sS "$CSH/api/benchmarks/coding-sh-issues" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "v": 1, "bench": "coding-sh-issues", "reference": "claude-code", "window": 28,
  "latest": {"id": "bench_codingshissues20261107", "date": "2026-11-07", "summaries": […], "comparisons": […], "anchor": {…}, …},
  "history": {"pass": {"codex": [{"date": "2026-10-15", "run": "bench_codingshissues20261015", "value": 0.4667, "lo": 0.3023, "hi": 0.6386, "n": 30, "segment": 0}, …]}, "cost": {…}, …},
  "vsReference": {"codex": [{"date": "2026-10-15", "value": -0.1333, "lo": -0.3333, "hi": 0.0667, …}, …]},
  "protocolBreaks": [15],
  "pooled": {"codex": {"k": 9, "cases": 270, "random": {"mean": -0.0852, "lo": -0.1918, "hi": 0.0215}, "i2": 0.2018, …}},
  "difficulty": {"fresh": [{"date": "2026-10-15", "value": 0.5111, "n": 30}, …], "anchor": […]},
  "anchor": {"version": "v1", "cases": 10, "sha256": "…", "frozenBy": "bench_…", "history": {…}, "vsReference": {…}},
  "contentChanges": [{"key": "anchor-2", "anchor": true, "from": {"date": "2026-10-15", …}, "to": {"date": "2026-11-03", …}}],
  "seedCheck": {"ok": true, "publishedBy": {"run": "bench_codingshissues20261106", "date": "2026-11-06"}, "checks": […]},
  "failures": {"codex": [{"caseId": "2026-11-07-004", "failure": "wrong", "detail": "tsc: 1 error in src/viewer/server.ts", "latencyMs": 223519, "sessionId": "…", "hasSession": true}, …]},
  "unsolved": [{"caseId": "2026-11-07-011", "input": "…"}]
}
```

A name outside `[a-z0-9][a-z0-9._-]*` (up to 63 characters) gets 400 `{"error":"invalid benchmark name","status":400}`;
a benchmark with no runs gets 404 `{"error":"benchmark not found","status":404}`.

### `GET /api/tasks`, `GET /api/runs`, `GET /api/bundles`

Eval tasks (`coding.sh eval`), runs (`coding.sh compare`) and harness bundles (`coding.sh harness`). All three
answer `{"items":[…]}` and are empty for a scoped key.

- `/api/tasks` filters: `status` (`draft`, `validated` or `archived`) and `tag`.
- `/api/runs` filters: `experimentId`, `taskId` and `bundleId`.
- `/api/bundles` returns `id`, `name`, `agent`, `model`, `createdAt` and `note` only; overlay files stay behind `/api/blobs`.

```sh
curl -sS "$CSH/api/tasks?status=validated" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":[]}
```

### `GET /api/update`

Release check for the viewer's update banner. `coding.sh serve` never checks, so it always answers:

```sh
curl -sS "$CSH/api/update" -H "Authorization: Bearer $READ_KEY"
```

```json
{"current":"","latest":null,"updateAvailable":false,"url":null,"command":"","checkedAt":null}
```

### `GET /api/ingest`

Progress of the local spool ingest, for the viewer's "Indexing N files…" pill. `coding.sh ui` ingests in a background worker after it starts listening, so pages answer from what is already indexed while `filesPending` counts down. `lastIngestAt` is the end of the last finished pass (epoch ms), `null` before the first. `coding.sh serve` ingests events as they arrive, so it always answers:

```sh
curl -sS "$CSH/api/ingest" -H "Authorization: Bearer $READ_KEY"
```

```json
{"ingesting":false,"filesPending":0,"lastIngestAt":null}
```
