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
- A non-loopback bind with no credentials at all makes one ingest key and one read key on first start, keeps them in `<CODING_SH_HOME>/serve-keys.json` and prints them on every start. With only some credentials configured (an ingest key but no read key, say), it refuses to start unless you pass `--insecure`.

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
| POST | [`/proxy/{path}`](#post-proxypath) | ingest key in `x-coding-sh-key` | serve |
| GET | [`/healthz`](#get-healthz) | none | serve |
| GET | [`/readyz`](#get-readyz) | none | serve |
| GET | [`/metrics`](#get-metrics) | `*` read key or basic auth | serve |
| GET | [`/`](#get--get-indexhtml) | read key or basic auth | serve, ui |
| GET | [`/index.html`](#get--get-indexhtml) | read key or basic auth | serve, ui |
| GET | [`/api/projects`](#get-apiprojects) | read key or basic auth | serve, ui |
| GET | [`/api/sessions`](#get-apisessions) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}`](#get-apisessionsid) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}/events`](#get-apisessionsidevents) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}/outline`](#get-apisessionsidoutline) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}/replay`](#get-apisessionsidreplay) | read key or basic auth | serve, ui |
| GET | [`/api/sessions/{id}/fork`](#get-apisessionsidfork-post-apisessionsidfork) | ui token | ui |
| POST | [`/api/sessions/{id}/fork`](#get-apisessionsidfork-post-apisessionsidfork) | ui token | ui |
| GET | [`/api/blobs/{sha256}`](#get-apiblobssha256) | read key or basic auth | serve, ui |
| GET | [`/api/calls/{id}`](#get-apicallsid) | read key or basic auth | serve, ui |
| GET | [`/api/calls/{id}/diff`](#get-apicallsiddiff) | read key or basic auth | serve, ui |
| GET | [`/api/search`](#get-apisearch) | read key or basic auth | serve, ui |
| GET | [`/api/stats`](#get-apistats) | read key or basic auth | serve, ui |
| GET | [`/api/facets`](#get-apifacets) | read key or basic auth | serve, ui |
| GET | [`/api/events`](#get-apievents) | read key or basic auth | serve, ui |
| GET | [`/api/where`](#get-apiwhere) | read key or basic auth | serve, ui |
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

## Model API proxy

### `POST /proxy/{path}`

The model API proxy of [`coding.sh proxy`](../how-to/capture-with-proxy.md), mounted so a team
needs one URL. `/proxy/v1/messages` and `/proxy/v1/messages/count_tokens` go to the Anthropic API,
`/proxy/v1/chat/completions` and `/proxy/v1/responses` to the OpenAI API; any other path and
method is forwarded without being logged. Upstreams come from `[proxy]` in the server's
`config.toml`.

The ingest key goes in `x-coding-sh-key` and picks the project the call is logged into. It is
dropped before forwarding. `Authorization` and `x-api-key` carry the client's own API key, which
goes upstream unchanged and is never stored. Streams pass through as they arrive.

```sh
curl -sS "$CSH/proxy/v1/messages" -H "x-coding-sh-key: $INGEST_KEY" \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model": "claude-haiku-4-5", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]}'
```

The upstream's status, headers and body come back as they are. The proxy's own errors use the
Anthropic error shape, so agents show the message:

| Status | When | Body |
|---|---|---|
| 401 | missing or wrong ingest key | `{"type":"error","error":{"type":"authentication_error","message":"coding.sh serve: missing or invalid ingest key; send it in the x-coding-sh-key header"}}` |
| 404 | the server runs `--role viewer` | `{"error":"this replica runs --role viewer and takes no ingest","status":404}` |
| 403 | a browser request (`Origin` other than localhost) | `{"type":"error","error":{"type":"invalid_request_error","message":"coding.sh proxy: cross-origin requests are not allowed"}}` |
| 502 | the upstream could not be reached | `{"type":"error","error":{"type":"api_error","message":"coding.sh proxy: upstream https://api.anthropic.com unreachable (…)"}}` |

Each call becomes an `llm.call` event with `source: "proxy"`, read back with
[`GET /api/calls/{id}`](#get-apicallsid).

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
| `where` | | a [`--where` query](query.md#filter-with---where), and-ed with the other filters |

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

With `where`, rows follow the query's `sort:` (newest first without one) and pages go by `offset`;
`cursor` answers 400. A bad query answers 400 with `reason`, the 0-based `offset` of the problem
and `next`:

```sh
curl -sS "$CSH/api/sessions?where=agent:codex%20modle:x" -H "Authorization: Bearer $READ_KEY"
```

```json
{"error":"where: unknown key \"modle\"","status":400,"reason":"unknown_key","offset":12,"next":["did you mean model:?"]}
```

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
used, and `payload.priceTier` when it was priced at batch, flex, priority, fast, long-context or US-only rates
(`batch+long-context` for both). `stats.usage.estimatedCostByTier` totals the estimate by
`priceTier`, and is left out when every call was standard. `stats.duplicateUsage` (`calls`, `tokens`, `costUsd`) is model-call usage left out because an
enclosing call or an earlier copy of the same response already counted it. `stats.llmErrors`
(`count`, plus the first failure's `statusCode` and `error`) counts `llm.call` events with
`ok: false` or a status of 400 or more; it is absent when none failed.

`model` is the model that made most of the session's main-thread model calls (calls without a
`subagentId`; the earlier one on a tie), else the last model any event named. `stats.models`
counts model calls per model (`{"claude-sonnet-5-5": 3, "claude-sonnet-5": 2}`), subagent calls in
the session included; it is absent when one model or none made them. `stats.modelSwitch`
(`from`, `to`, `at`, `trigger`) is the main thread's first hand-over to another model: every
main-thread call on `from` came before the first call on `to`, at `at`. `trigger` is `refusal` or
`error` when the last call on `from` stopped on a refusal or failed, `command` when a `/model`
command came right before the first call on `to`, and absent otherwise. Without a trigger, each
model needs at least two calls, so a helper model's single call before or after the others (a
title) is not a switch; a helper model whose calls run between the main model's never is. A switch
adds the `model:switch` tag to `flags`. A call whose `payload.stopReason` is `refusal`,
`content_filter` or `safety` (any case) adds the `refusal` flag. Calls logged by `coding.sh proxy`
count here only in a session with no other model calls, as they do for usage.

Model calls logged by [`coding.sh proxy`](../how-to/capture-with-proxy.md) have `source: "proxy"`.
Their payload adds `provider`, `api` (`messages`, `count_tokens`, `chat` or `responses`),
`statusCode`, `stream`, `ttfbMs`, `ttftMs`, `stopReason`, `systemHash` and `toolsHash` (16 hex
characters each), `toolNames`, `toolCount`, `messageCount`, `prompt` (the last user message,
clipped), `linkedBy` (`header`, `metadata`, `previous-response` or `conversation`: how the call
found its session), rate limits (`rlRequestsRemaining`, `rlTokensRemaining`, … when the API sent
them), `errorClass` on failure, and `requestRef` and
`responseRef` (the stored request and response blobs, absent in `metadata` mode), and
`requestPaged: true` when the request's messages are stored in blocks, not inside the request blob
(`show <session>#<n>` puts them back). When the request
or response has them, it also adds `reasoningEffort` (`reasoning.effort`, `reasoning_effort` or
`output_config.effort`), `serviceTier` and `speed` (the response's value, else the request's;
`requestedServiceTier` when the request asked for another tier),
`thinkingBudget`, and `compaction: true` on a call that compacted the conversation (Codex's
`/responses/compact`, or a `compaction` block or output item). When the client names them, it adds
`parentSessionId` (the session that started this one; for a Claude Code subagent, whose calls go to
`<session>:sub:<agentId>`, the parent's), `agentId`, `parentAgentId` and `agentType` (Claude Code),
`forkedFromSessionId` and `subagentKind` (Codex), `accountHash` (16 hex characters of the sha256 of
the account id), and `upstreamAuth` (CLIProxyAPI's credential index). A session seen only through
the proxy takes its `parent` from its calls' `parentSessionId`. When the
session also has model calls from the agent's transcript or OpenTelemetry, those count toward
`stats` and the proxy's copies are detail only; failed proxy calls count either way.

`errorClass` is one of `rate_limit` (429), `overloaded` (529), `auth` (401, 403), `too_large`
(413), `timeout`, `server` (other 5xx), `invalid_request` (other 4xx), `network` and `api`. Each
API error Claude Code retried (a transcript's `api_error` line) is an `error` event with
`source: "api"`, and a backfill also keeps what the transcript records about it: `statusCode`,
`errorType` (`rate_limit_error`, `overloaded_error`, …), `errorClass`, `rateLimitType` (the limit
that was hit, such as `seven_day` or `five_hour`), `resetsAt` (ms), `retryAfterMs` (how long Claude
Code waited before the next attempt), `retryAttempt` and `maxRetries`. A weekly-limit stall then
reads as hundreds of `rate_limit` errors on `seven_day`, not as one transient error.

Two waste stats are absent when there is nothing to report. `stats.waste` (`duplicateFetches`,
`duplicateFetchTokens`, `readOnlyCalls`) counts read-only calls that repeated an earlier call in the
same context with the same result, and the tokens they sent again (output length / 4).
`stats.cacheBreaks` (`count`, `lostTokens`, `extraUsd`, `byCause`) counts model calls that found the
prompt cache gone: the previous prompt was over 4,096 tokens, this call read less than half of it
from cache, and more than 2,048 tokens were billed again. `byCause` splits them into `compaction`,
`model-switch`, `idle` (5 minutes, or an hour after a 1-hour cache write) and `other`. `extraUsd` is
the cache-write (or input) price minus the cache-read price for those tokens; it is left out, and
`unpriced` counts the breaks, when the model has no price.

`stats.launch` is `headless` for a session the agent ran without a person at the keyboard
(`claude -p`, the Claude Agent SDK, `codex exec`, Codex as an MCP server) and `interactive` for a
terminal or IDE session. It comes from the session's start: Claude Code's `entrypoint` (`sdk-cli`,
`sdk-ts`, `sdk-py`; `cli`, `claude-vscode`, …) and Codex's `originator` and `launch` (the rollout's
`session_meta.source`). It is absent when the start does not say. `--where launch:headless` and
`--facets launch` use it.

`stats.hookContext` (`count`, `tokens`, `bySource`) counts the texts hooks added to the model's
context (Claude Code), and their size in tokens (characters / 4). `bySource` splits them by whose
hook it was: `plugin:<name>`, `plugin` (a plugin not installed where the session was parsed),
`settings` (a hook in a settings file) or `unknown` (the agent recorded no command). Each source also
adds a `hook:<source>` tag to `flags`, such as `hook:plugin:caveman`. It is absent when no hook added
context. Each text is a `notification` event with `payload.kind: "hook.context"` and `hookEvent`,
`hookName`, `hookSource`, `command`, `chars`, `tokens` and `text` (clipped; metadata mode keeps only
`hookEvent`, `hookSource`, `chars` and `tokens`).

`stats.redactions` counts the values redaction replaced before storage, by rule kind
(`{"anthropic-key": 1, "password": 2}`); it never holds the values, and it is absent when nothing was
redacted. Each event's own counts are in `payload.redactions`, which metadata mode keeps; a tool
output moved to a blob counts what was redacted inside the blob. A vendor token kind also adds the
`secret:exposed` tag to `flags`. Events stored before counting existed are counted from the
`[redacted:<kind>]` markers in their payload.

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

### `GET /api/sessions/{id}/outline`

A long session at a glance: its phases (the start, each resume, compaction and long idle gap),
the first event of each local day, and its derails. `index`, `from` and `to` count events in time
order, the same order `/events` pages through.

```sh
curl -sS "$CSH/api/sessions/team%2Fchat-1/outline" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "phases": [
    {"n": 1, "kind": "start", "label": "start", "startTs": 1793872802000, "endTs": 1793876402000,
     "from": 0, "to": 1840, "eventId": "54b366d0…", "events": 1840, "prompts": 6, "toolCalls": 512,
     "toolErrors": 9, "filesChanged": 14, "tokens": 2210000, "derails": []},
    {"n": 2, "kind": "compaction", "trigger": "auto", "label": "compacted (auto)", "startTs": 1793876410000,
     "endTs": 1793880010000, "from": 1840, "to": 3600, "eventId": "9a1f03c2…", "events": 1760, "prompts": 2,
     "toolCalls": 498, "toolErrors": 31, "filesChanged": 3, "tokens": 1980000,
     "derails": [{"flag": "failure-streak", "ts": 1793877000000, "eventId": "c41e88a0…", "index": 2210,
                  "endTs": 1793877090000, "detail": "6 failed tool calls in a row (Bash)"}]}
  ],
  "days": [{"date": "2026-11-04", "ts": 1793872802000, "index": 0, "eventId": "54b366d0…"}],
  "derails": [{"flag": "failure-streak", "ts": 1793877000000, "eventId": "c41e88a0…", "index": 2210,
               "endTs": 1793877090000, "detail": "6 failed tool calls in a row (Bash)"}],
  "events": 3600
}
```

### `GET /api/sessions/{id}/replay`

The session as numbered steps, and the files the agent touched as of any step, rebuilt from its own
tool calls. A step is a prompt, a reply, a tool call (with the file changes and test results it
produced), a subagent start, a compaction, an error, or a file change no tool call claims.

Without parameters it returns the step list. `steps[].eventId` is the step's first event, and
`files` names the paths each step wrote, deleted or fully read (relative to `root` when inside it).
`baseline` is `snapshot` when `coding.sh ui` can read the session's start snapshot, else `none`.

```sh
curl -sS "$CSH/api/sessions/cd0185b0-305a-4df2-92fa-6fc6caffdb55/replay" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "sessionId": "cd0185b0-305a-4df2-92fa-6fc6caffdb55", "root": "/work/demo", "baseline": "none",
  "steps": [
    {"n": 1, "ts": 1794084489400, "kind": "prompt", "label": "Tidy notes.txt and greet.", "eventId": "0c1f…"},
    {"n": 2, "ts": 1794084489611, "kind": "read", "label": "Read notes.txt", "eventId": "5e2a…", "tool": "Read",
     "ok": true, "durationMs": 38, "files": [{"path": "notes.txt", "op": "read"}]},
    {"n": 4, "ts": 1794084489801, "kind": "shell", "label": "$ sed -i 's/alpha/beta/' notes.txt", "eventId": "9b7d…",
     "tool": "Bash", "ok": true, "durationMs": 171, "files": [{"path": "notes.txt", "op": "modify"}]}
  ],
  "files": ["gen.txt", "notes.txt", "out.txt", "sub/inner.txt"]
}
```

`step=N` returns what step N did: `detail` (the prompt or reply text, the tool input, or for a shell
call `shell` with `command`, `exitCode` when known, `durationMs` and `output`), `changes` (one entry
per file with a unified `diff`), and `tree` (every file touched up to step N, with `status` `added`,
`modified`, `deleted` or `read`). Add `file=<path>` for that file's content as of step N.

`from=A&to=B` returns what steps A through B changed together, one diff per file.

A diff with `exact: true` compares the rebuilt file before and after, with real line numbers. When
the content on one side is unknown, `exact` is `false`, the diff is the change as the agent
recorded it, and `why` says what is missing, for example `Step 3 patched it before any step showed
its content (no earlier read, full write or start snapshot).` A file's content is unknown until a
step writes or fully reads it, or the start snapshot has it; an edit that does not match the
rebuilt content makes it unknown again.

```sh
curl -sS "$CSH/api/sessions/cd0185b0-305a-4df2-92fa-6fc6caffdb55/replay?step=4&file=notes.txt" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "sessionId": "cd0185b0-305a-4df2-92fa-6fc6caffdb55", "steps": 15,
  "step": {"n": 4, "kind": "shell", "label": "$ sed -i 's/alpha/beta/' notes.txt", "tool": "Bash", "ok": true, "durationMs": 171},
  "detail": {"input": {"command": "sed -i 's/alpha/beta/' notes.txt"},
             "shell": {"command": "sed -i 's/alpha/beta/' notes.txt", "ok": true, "durationMs": 171, "output": "…"}},
  "changes": [{"path": "notes.txt", "op": "modify", "exact": true,
               "diff": "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n-alpha\n+beta\n bravo\n"}],
  "tree": [{"path": "notes.txt", "status": "modified", "edits": 1, "lastStep": 4, "here": true}],
  "file": {"path": "notes.txt", "exists": true, "content": "beta\nbravo\n", "changedAt": 4}
}
```

A step past the last one gets 400. File content is cut at 1 MiB (`contentTruncated`) and a diff at
512 KB (`diffTruncated`).

### `GET /api/sessions/{id}/fork`, `POST /api/sessions/{id}/fork`

Fork the session at a replay step: send the model call behind that step again with changed
context files (CLAUDE.md, AGENTS.md) and compare the forked next action with the recorded one.
Only `coding.sh ui` answers these routes; `coding.sh serve` answers 404. The session needs model
calls captured by [`coding.sh proxy`](../how-to/capture-with-proxy.md). When forking is on, the
replay step list adds `"canFork": true`.

`GET ?step=N` returns the call a fork at step N starts from and the context files it carried. It
does not call the model. `by` is `tool-use` when the call's reply holds the step's tool call, else
`time` (the agent's last call before the step, or for a prompt the first call after it). `canCall` is false when neither `keyEnv` nor `CLAUDE_CODE_OAUTH_TOKEN` (for
Anthropic) is set in the environment `coding.sh ui` runs in.

```sh
curl -sS "http://127.0.0.1:4319/api/sessions/cd0185b0-305a-4df2-92fa-6fc6caffdb55/fork?step=4" -H "Authorization: Bearer $UI_TOKEN"
```

```json
{
  "step": {"n": 4, "kind": "shell", "label": "$ npm test"},
  "call": {"id": "7a1c…", "model": "claude-sonnet-4-5", "by": "tool-use", "messages": 5},
  "files": [{"path": "CLAUDE.md", "text": "Run the tests with npm test.\n"}],
  "recorded": {"action": {"type": "tool", "name": "Bash", "input": {"command": "npm test"}}, "label": "Bash: npm test"},
  "canCall": true, "keyEnv": "ANTHROPIC_API_KEY"
}
```

`POST` with `{"step": N, "files": {"CLAUDE.md": "…"}, "trials": 1}` sends the call with each file
replaced, added, or removed when its text is empty. `trials` is 1 to 5. The request must come from
the viewer's own origin. It calls the model and costs money. `edits` says what changed in the
request, each trial has the forked first action and `differs`, and `differ` counts the trials whose
action is not the recorded one.

```json
{
  "sessionId": "cd0185b0-305a-4df2-92fa-6fc6caffdb55",
  "step": {"n": 4, "kind": "shell", "label": "$ npm test"},
  "call": {"id": "7a1c…", "model": "claude-sonnet-4-5", "by": "tool-use", "messages": 5},
  "change": "CLAUDE.md changed",
  "edits": [{"path": "CLAUDE.md", "how": "replaced", "count": 1}],
  "recorded": {"action": {"type": "tool", "name": "Bash", "input": {"command": "npm test"}}, "label": "Bash: npm test"},
  "trials": [{"action": {"type": "tool", "name": "Bash", "input": {"command": "node --test"}}, "label": "Bash: node --test",
              "differs": true, "model": "claude-sonnet-4-5", "costUsd": 0.0123}],
  "differ": 1
}
```

A step out of range, a session without stored requests, or a missing key gets 400 with the reason.

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

### `GET /api/calls/{id}`

One model call logged by [`coding.sh proxy`](../how-to/capture-with-proxy.md): the `llm.call`
event, the request as the client sent it (system prompt and tool definitions put back from their
blobs; auth headers are never stored) and the response. `{id}` is the event id or a unique prefix
of at least 6 characters. `request` and `response` are `null` in `metadata` capture mode.

```sh
curl -sS "$CSH/api/calls/319a57022de6" -H "Authorization: Bearer $READ_KEY"
```

```json
{
  "call": {"id": "319a57022de66bd9…", "kind": "llm.call", "source": "proxy", "model": "claude-sonnet-4-5-20250929",
           "usage": {"inputTokens": 12, "outputTokens": 42, "cacheReadTokens": 4600, "cacheWriteTokens": 100},
           "payload": {"api": "messages", "statusCode": 200, "systemHash": "907e1d58151bd256", "toolCount": 3, "…": "…"}},
  "request": {"provider": "anthropic", "api": "messages", "method": "POST", "path": "/v1/messages",
              "headers": {"anthropic-version": "2023-06-01"},
              "body": {"model": "claude-sonnet-4-5", "system": [{"type": "text", "text": "You are a careful coding agent.…"}],
                       "tools": [{"name": "Bash", "…": "…"}], "messages": ["…"]}},
  "response": {"status": 200, "headers": {"request-id": "req_…"}, "body": {"content": ["…"], "stop_reason": "end_turn"}}
}
```

An unknown or ambiguous id gets 404.

### `GET /api/calls/{id}/diff`

What changed between this call and the model call before it in its session, or `?with=<id>`:
model, settings, tool definitions, the system prompt as a line diff, and the message history.
When this call read less of the prompt cache than the other one cached, `cache.cause` names the
first change in the order the cache reads a request (tools, then system, then messages), or the
5-minute cache lifetime. The same object as `coding.sh diff-calls <a> <b> --json`.

```json
{
  "a": {"id": "dc1d0bae0de0…", "model": "claude-sonnet-4-5-20250929", "usage": {"cacheReadTokens": 4000, "cacheWriteTokens": 200}},
  "b": {"id": "7c8944291203…", "model": "claude-sonnet-4-5-20250929", "usage": {"cacheReadTokens": 0, "cacheWriteTokens": 4400}},
  "content": "full",
  "params": [],
  "tools": {"same": true, "added": [], "removed": [], "changed": [], "reordered": false},
  "system": {"same": false, "lines": [{"op": " ", "text": "Run the tests before you say done."},
                                      {"op": "-", "text": "Today is 2026-11-06."}, {"op": "+", "text": "Today is 2026-11-07."}]},
  "messages": {"a": 3, "b": 5, "shared": 3, "rewritten": false},
  "cache": {"reused": false, "expected": 4200, "read": 0, "write": 4400, "gapMs": 812,
            "cause": "the system prompt changed (first change: - Today is 2026-11-06.)"}
}
```

`content` is `metadata` when either request was not stored: tools and system are then compared
by their short hashes. The first call of a session, without `?with=`, gets 404.

### `GET /api/search`

Full-text search over prompts, replies and tool I/O. `q` is required (up to 500 characters).
Also takes `limit` (1 to 500, default 50), `project`, `scope`, `agent`, `model`, `flag`, `repo`,
`since`, `until` and `where` (event keys test the matching event, session keys its session). Matches in `snippet` are wrapped in `«…»`.

```sh
curl -sS "$CSH/api/search?q=order&limit=1" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":[{"event":{"id":"22270b1c…","v":0,"sessionId":"team/chat-1","ts":1793872802400,"agent":"support-bot","kind":"tool.end","payload":{"tool":"lookup_order","toolUseId":"t1","ok":true,"output":"shipped"},"durationMs":400,"source":"sdk","project":"team"},"snippet":"lookup_«order»\nshipped"}]}
```

Without `q`: 400 `{"error":"q is required","status":400}`.

### `GET /api/stats`

Totals and facet counts for the session list. Takes `project`, `scope`, `agent`, `model`, `flag`,
`repo`, `since`, `until` and `where`. A `where` query narrows the totals, facets and histogram
(its `sort:` and `limit:` do not apply), and a bad one answers 400 as on `/api/sessions`. Each facet applies every filter except its own. `histogram` buckets
session starts over at most the 90 days before the newest session.

```sh
curl -sS "$CSH/api/stats?project=team&agent=support-bot" -H "Authorization: Bearer $READ_KEY"
```

```json
{"sessions":1,"subagents":0,"byAgent":{"triage-agent":1,"support-bot":1},"byFlag":{},"byRepo":{},"byModel":{"gpt-4o":1},"toolCalls":1,"toolErrors":0,"llmCalls":1,"costUsd":0.00251,"estimatedCostUsd":0.00251,"pricedSessions":1,"withTests":0,"testsFailing":0,"histogram":{"step":300000,"from":1793872800000,"buckets":[{"t":1793872800000,"n":1,"flagged":0}]}}
```

`byAgent` still lists every agent in `team`, because a facet skips its own filter. The totals apply all of them.

### `GET /api/facets`

Session counts per value of each key in `keys` (comma-separated, at most 12, default
`agent,model,repo,flag`): `agent`, `model`, `provider`, `repo`, `branch`, `flag`, `skill`, `kind`,
`tool` or `mcp`. Takes `where`, `project`, `scope`, `since`, `until` and `limit` (values per key, 1
to 200, default 20). Each key is counted over `where` without that key's own clauses, so a picked
value does not hide the others. `prefix` (up to 200 characters) keeps only values that start with
it, ignoring case, for autocomplete.

```sh
curl -sS "$CSH/api/facets?keys=agent,tool&where=-flag:compaction" -H "Authorization: Bearer $READ_KEY"
```

```json
{"facets":{"agent":[{"value":"codex","count":2},{"value":"claude-code","count":1},{"value":"gemini","count":1}],"tool":[{"value":"Bash","count":3},{"value":"Edit","count":1},{"value":"Grep","count":1}]}}
```

An unknown key answers 400.

### `GET /api/events`

Events that match `where` across sessions, newest first. Event keys (`kind`, `tool`, `ok`, `mcp`,
`error`, `event.duration`, text) test each event; session keys (`agent`, `repo`, `flag`, …) test
its session. Takes `limit` (1 to 200, default 50), `cursor`, `project`, `since` and `until` (on the
session's start, as on the list), and `scope` (`top` leaves out subagent sessions' events; default
`all`). Each item is the event with its payload clipped for a list row,
`session` (`id`, `title`, `agent`, `model`, and `parent` and `type` for a subagent), and a
`snippet` with matches wrapped in `«…»` when the query has text. `next` is the cursor for the
following page and is absent on the last one. The first page also counts the matches: `total`, up
to 10,000, with `totalCapped: true` past that.

```sh
curl -sS "$CSH/api/events?where=tool:lookup_order&limit=1" -H "Authorization: Bearer $READ_KEY"
```

```json
{"items":[{"id":"22270b1c…","v":0,"sessionId":"team/chat-1","ts":1793872802400,"agent":"support-bot","kind":"tool.end","durationMs":400,"source":"sdk","project":"team","payload":{"tool":"lookup_order","toolUseId":"t1","ok":true,"output":"shipped"},"session":{"id":"team/chat-1","title":"Where is my order?","agent":"support-bot","model":"gpt-4o"}}],"total":1,"totalCapped":false}
```

A bad `where` or `cursor` answers 400. A store plugin with no event query path answers 400 with
`reason: "unsupported_store"`.

### `GET /api/where`

The `--where` keys, for the viewer's query bar to complete. Each item has `name`, `level`
(`session`, `event` or `query`), `type`, `doc` and `example`; `facet: true` when
[`/api/facets`](#get-apifacets) can list its values, and `values` when the key takes a few fixed
ones (`ok`, `is`, `has`, `sort`, and times such as `7d` for `since` and `until`).

```sh
curl -sS "$CSH/api/where" -H "Authorization: Bearer $READ_KEY"
```

```json
{"keys":[{"name":"agent","level":"session","type":"text","doc":"Agent id","example":"agent:codex","facet":true},{"name":"ok","level":"event","type":"bool","doc":"Tool call or model call succeeded","example":"ok:false","values":[{"value":"true"},{"value":"false"}]},…]}
```

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

An experiment run with `--samples adaptive` also has `"samples": "adaptive"` and
`summary.caseVerdicts` (`passed`, `failed`, `tieBreaks`); its `passRate` interval is biased, so
use the verdicts. One that `--stop-on-regression` stopped has status `cancelled` and
`regression: {caseId, baseline}`. Both fields are absent otherwise.

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

`power.exact` is the exact McNemar design when some case flipped: `{"n", "discordance",
"alpha", "power", "minDiscordant", "ceiling", "mde"}`, where `ceiling` is the power at the largest
possible gap and `mde` is `null` when no gap reaches `power`. Then `power.warnings` has a
`no-power` entry.

Present only when they apply: `graders[].versionChanged` (`{"a","b"}` versions) and
`gradersOnlyIn` (`{"a":[…],"b":[…]}`) when the sides were graded differently, with
`instrumentWarning` saying so; `ungradedCases` for cases that ran on both sides but have no graded
run on one.
`timing.interleaved` is also true for two cells of one `exp run` matrix (both carry the same
`metadata.matrix.id`).

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
- `/api/runs` filters: `experimentId`, `taskId` and `bundleId`. A run carries `cellKey` (the content key
  `compare --reuse` matches on; absent on older runs) and, when `compare --reuse` copied it, `reusedFrom`
  (the id of the run it was copied from). A run carries `tamper` when its diff was checked: `flagged`,
  `flags` (each with `kind`, `path`, `why` and `detail`) and `addedTests`, the existing test files the
  agent only added new test cases to (absent when none). `verifierOutput` holds the end of what the
  verifier printed: `stdout` and `stderr`, each the last 4096 characters, colour codes removed and
  redacted with `capture.redact` and `capture.redactPatterns`; a stream that was empty is absent, and
  so is the field when both were. A run from `compare --repair` carries `repair`: `signal`
  (`bit` or `names`), `mode` (`resume` or `fresh`), `limit`, `rounds` (each with `n`, `pass`,
  `verifierExit`, `verifierOutput`, `durationMs`, `usage`, `sessionId`, `diffBlob`, `unchanged` when the round changed no
  file, `tamper` when the round's diff tampers with tests, and `namesParsed` with signal `names`),
  `pass` (the outcome after the last
  round; `pass` on the run stays the first attempt's), `falseAlarm` and `falseAlarmFired` with
  `--false-alarm`, and `skipped` (`error` or `timeout`) when the first attempt could not be repaired.
  `agentVersion` is the agent release the run started on (the adapter's detected version, checked at
  most once a minute); absent when the adapter can't tell and on older runs.
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

Progress of the local spool ingest, for the viewer's "Indexing N files…" pill. `coding.sh ui` ingests in a background worker after it starts listening, so pages answer from what is already indexed while `filesPending` counts down. `lastIngestAt` is the end of the last finished pass (epoch ms), `null` before the first. Under `coding.sh ui`, `importing` is `true` while past sessions are being imported (the background import `coding.sh init` starts when its 8 seconds run out); the pill and the empty session list then say "Importing past sessions…". `coding.sh serve` ingests events as they arrive, so it always answers:

```sh
curl -sS "$CSH/api/ingest" -H "Authorization: Bearer $READ_KEY"
```

```json
{"ingesting":false,"filesPending":0,"lastIngestAt":null}
```
