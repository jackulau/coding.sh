# Self-host for a team

Run one `coding.sh serve` that the whole team sends sessions to and reads from. The full guide,
with roles, keys per person and day-two operations, is [guides/team.md](../guides/team.md). This page
is the short path.

## 1. Make keys

```sh
coding.sh serve keygen --project team          # csh_ik_... ingest key, for agents and apps
coding.sh serve keygen --project team --read   # csh_rk_... read key, for people
```

Each command prints the key once on stdout. On stderr it prints the server setting that holds
only the key's sha256 hash, such as `CODING_SH_INGEST_KEYS=team:sha256:<hex>`, so the server never
stores the key itself.

## 2. Run the server on Postgres

```sh
CODING_SH_STORE_URL='postgres://user:pass@db.example.com:5432/coding?sslmode=require' \
CODING_SH_INGEST_KEYS='team:sha256:<hex>' \
CODING_SH_READ_KEYS='team:sha256:<hex>' \
coding.sh serve --host 0.0.0.0
```

Postgres needs the `coding.sh-store-postgres` package installed next to coding.sh; the Docker image
already has it. `serve` refuses a non-loopback address without an ingest key and a read key (or basic auth).
Check it with `curl -s http://<host>:4318/readyz`, or `coding.sh serve healthcheck --url http://<host>:4318/readyz`.
Docker, Fly, Railway, Render and Compose recipes are in [production/](../production/README.md).

## 3. Send each person's sessions to it

Each teammate keeps capturing locally and adds a sink to `~/.coding.sh/config.toml`:

```toml
[[sinks]]
kind = "otlp"
endpoint = "https://obs.example.com"
mode = "metadata"                     # the default; "full" also sends prompts, code and tool output
headers = { Authorization = "Bearer ${CODING_SH_INGEST_KEY}" }
```

`${CODING_SH_INGEST_KEY}` is read from the environment, so the key stays out of the file. Decide as
a team whether `mode = "full"` is acceptable before anyone turns it on.

Apps and agents you built send to the same server: set `CODING_SH_URL` and `CODING_SH_INGEST_KEY`
for the SDKs, or point an OpenTelemetry exporter at `https://obs.example.com/v1/traces` with the
same key as a Bearer header. See [Trace your own agent](trace-your-agent.md).

## 4. Read it

- Viewer: open `https://obs.example.com/?t=csh_rk_...` once; the link sets a cookie.
- CLI and MCP against the shared store: `coding.sh sessions --store 'postgres://...' --project team`.
  With `--store`, local spool files are not pushed into the shared database.

## Next

- [guides/team.md](../guides/team.md): the complete team setup.
- [PRODUCTION.md](../PRODUCTION.md): every serve setting, auth, projects, retention and metrics.
- [Configuration](../reference/config.md#serve): the `[serve]` keys and their env vars.
