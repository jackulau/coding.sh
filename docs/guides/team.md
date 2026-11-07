# One server for a team

This guide sets up one `coding.sh serve` that everyone on a small team sends to and reads from.
That covers each person's coding agents and the team's API apps. It takes about 15 minutes.

You end up with:

- one server (Postgres + blob store) at a URL like `https://obs.example.com`;
- one **ingest key** per person or service, which decides the **project** their data lands in;
- one shared login for the viewer, or a **read key** per person;
- optional retention, so old sessions get deleted.

## 1. Start the server

On the machine that will host it, from a checkout of this repo:

```sh
deploy/compose/gen-env.sh                 # writes .env with random secrets (mode 600)
docker compose up -d --build --wait
curl -s http://127.0.0.1:4318/readyz      # {"ok":true,"store":"postgres",...}
```

Compose publishes port 4318 on `127.0.0.1` only. To let teammates reach it, put a TLS proxy in front
(Caddy: `obs.example.com { reverse_proxy 127.0.0.1:4318 }`) and add `CODING_SH_TRUST_PROXY: "1"` to
the `coding-sh` service's `environment` in `docker-compose.yml`. On a private network such as a
tailnet, you can publish the port on that interface instead.

More detail: [production/compose.md](../production/compose.md).

## 2. Give everyone a key

Use one project per person and one per service, so you can tell who sent what: session ids show
up as `alice/<id>`. Use one shared project if you don't need that.

```sh
docker compose run --rm --no-deps coding-sh /app/cli.mjs serve keygen --project alice
docker compose run --rm --no-deps coding-sh /app/cli.mjs serve keygen --project billing-api
```

Each command prints a key (`csh_ik_...`) once, plus a `sha256:` line. Send the key to its owner over a
private channel. Put only the hashes in `deploy/compose/config.toml`, which the server reads. Hashes
are safe to commit.

```toml
[[serve.projects]]
id = "alice"
ingest_keys = ["sha256:..."]

[[serve.projects]]
id = "billing-api"
ingest_keys = ["sha256:..."]
retention_days = 30            # optional, this project only
```

Then run `docker compose restart coding-sh`. To revoke a key, delete its hash and restart.

Projects keep teams' data apart, but they don't make the server safe for untrusted tenants. For
those, run a separate server and database for each tenant.

## 3. One login for the viewer

Pick one of these:

- **Shared login (simplest).** Hash a password with `printf %s 'the password' | shasum -a 256`, then add:

  ```toml
  [serve.viewer]
  basic_user = "team"
  basic_password_sha256 = "<the hex>"
  ```

  Open `https://obs.example.com` and the browser asks for the user name and password. This login
  sees every project.
- **A read key per person.** Run `serve keygen --project '*' --read` (all projects) or
  `--project alice --read` (one project). Add the printed `read_keys` line under `[serve.viewer]`.
  Each person opens `https://obs.example.com/?t=<their read key>` once. A cookie keeps them signed
  in until the browser closes. A one-project key only ever sees that project. Add
  `name = "alice"` to a key's entry to show that name on the labels its holder sets; without it,
  labels show `reader:` plus the start of the key's hash.

Restart `coding-sh` after editing the file. For the API, `GET /api/sessions?project=alice` filters by
project.

## 4. Send your coding agents

Each developer keeps coding.sh running locally as usual (`npx coding.sh init`) and adds the team
server as a sink in `~/.coding.sh/config.toml`:

```toml
[[sinks]]
name = "team"
kind = "http"
endpoint = "https://obs.example.com/v1/ingest"
mode = "full"                                   # the default "metadata" sends no prompts or output
headers = { Authorization = "Bearer csh_ik_..." }   # your own ingest key
```

Sessions are sent at the end of each turn, when the agent's hook starts a background ingest. They
are also sent whenever you run a `coding.sh` command. To check that it works, run
`coding.sh ingest`, then look for your session in the viewer under your project.

- Redaction runs on your machine before anything is sent.
- Long prompts and tool output are clipped to about 1.5 KB on the server. The full text stays in
  your local `~/.coding.sh`.
- If you write `${TEAM_KEY}` in `headers`, every shell and app that runs coding.sh must export
  `TEAM_KEY`, or coding.sh refuses to load the config. A key written directly in your own config
  file avoids that.

## 5. Send your apps

Set two environment variables wherever the app runs, using that service's key:

```sh
CODING_SH_URL=https://obs.example.com
CODING_SH_INGEST_KEY=csh_ik_...
```

The TypeScript and Python SDKs read these variables. Plain OpenTelemetry apps use
`OTEL_EXPORTER_OTLP_ENDPOINT=https://obs.example.com` and
`OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20csh_ik_..."`. Never ship an ingest key to a
browser.

## 6. Retention

`CODING_SH_RETENTION_DAYS=30` in the `coding-sh` environment deletes sessions older than 30 days
from every project. `retention_days` on a `[[serve.projects]]` entry overrides that for one project.
Retention runs at startup and then every hour. Eval assets (tasks, datasets and experiments) are
never deleted.

## Admins: the CLI on the team database

People with database access can run the CLI and MCP tools straight against it, for example
`CODING_SH_STORE_URL='postgres://coding:...@db-host:5432/coding' coding.sh sessions --project alice`.
This needs the `coding.sh-store-postgres` package installed next to coding.sh. The Postgres
password grants full access to the data, so most of the team should use the viewer instead.
