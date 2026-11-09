# Open-source, self-hosted LLM observability

coding.sh is MIT-licensed observability and evals for AI agents that runs on your own machines. On
a laptop it records coding-agent sessions into a local SQLite file. For a team or for production
apps, one `coding.sh serve` process takes OpenTelemetry traces and SDK events, and serves the
viewer and an API from a database you run.

## On one machine

```sh
curl -fsSL https://coding.sh/install | sh
```

Everything lives in `~/.coding.sh`: a SQLite index (`index.db`, through `node:sqlite`, with no
native dependencies) and a content-addressed blob store for large prompts and tool output.
Redaction of keys and tokens runs before anything is written. With no sinks configured, no session
data leaves the machine. The only default network request is a daily update check, which you can
turn off.

Apps and agent frameworks that export OpenTelemetry can send to a local receiver:

```sh
coding.sh collector       # OTLP/HTTP on 127.0.0.1:4318, prints the exporter environment
```

It reads the OTel GenAI semantic conventions, OpenInference, Vercel AI SDK spans and the Claude
Code, Codex and Gemini CLI log events. Every model call becomes an event with model, tokens,
duration and time to first token.

## For a team

```sh
docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data --restart unless-stopped ghcr.io/jackulau/coding.sh
docker logs coding-sh                                   # the read key, the ingest key, the connect command
coding.sh init --remote http://<server>:4318 --key csh_ik_…   # on each developer's machine
```

The first start makes a read key and an ingest key and keeps them on the volume. Developers'
machines then send new sessions as metadata only: no prompts, code or tool output unless the team
chooses `--remote-mode full`. Redaction runs on the developer's machine before anything is sent.

## What the server needs

- One Node process (Node 22.15 or newer) or the Docker image, on one port, 4318 by default. The
  image is distroless Node 22, built for amd64 and arm64.
- A store. SQLite on a volume is the default. Set `CODING_SH_STORE_URL` to a `postgres://` or
  `clickhouse://` URL for more traffic, and `CODING_SH_BLOB_URL` to an `s3://` URL (S3, R2, MinIO)
  for large payloads. On Postgres, blobs default to the same database.
- Keys. Set `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS`, or let the first start make them on
  a `/data` volume. On a non-loopback address, serve will not start with an ingest key but no read
  key or viewer login.
- TLS from a proxy in front. Serve speaks plain HTTP.

`deploy/compose/` has stacks for SQLite, Postgres 17 and ClickHouse, and there are recipes for
Fly, Railway, Render and Vercel Functions. Serve never checks for updates.

## What it receives

| Route | What |
|---|---|
| `POST /v1/traces`, `/v1/logs` | OTLP/HTTP, protobuf or JSON |
| `POST /v1/ingest` | batched events from the TypeScript and Python SDKs |
| `/proxy/` | the model API proxy, for agents that send every call through it |
| `GET /`, `/api/*` | the viewer and its API, with a read key |
| `/healthz`, `/readyz`, `/metrics` | health checks and Prometheus metrics |

A request is acknowledged only after its events are committed, and retries never create
duplicates. The CLI, MCP tools, datasets and experiments work on the same store URL.

## Current status

- `@codingdotsh/sdk` and the store plugins (`coding.sh-store-postgres`,
  `coding.sh-store-clickhouse`, `coding.sh-store-s3`) are on npm. The Python SDK, `coding-sh`, is
  not on PyPI yet; install it from a checkout. The Docker image includes the store plugins.
- The image `ghcr.io/jackulau/coding.sh` is published for every release from 0.1.2 on.

## Questions

### Can I use plain OpenTelemetry, with no SDK?

Yes. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the server and send the ingest key as an
`Authorization: Bearer` header.

### Can each person's data stay separate?

The ingest key decides the project its data lands in. With one key per person, sessions show up
per person, and a read key can be limited to one project.

### Does it delete old data?

Only if you set `CODING_SH_RETENTION_DAYS` (or a per-project retention). The default keeps
everything.

## Next

- [Self-host for a team](../how-to/self-host-team.md)
- [One server for a team](../guides/team.md)
- [coding.sh in production](../production/README.md)
- [Trace your own agent](../how-to/trace-your-agent.md)
- [Storage, sinks and privacy](../guides/privacy.md)
