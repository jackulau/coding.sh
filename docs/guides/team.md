# One server for a team

This guide sets up one `coding.sh serve` that everyone on a small team sends to and reads from.
That covers each person's coding agents and the team's API apps. The quickstart in
[Self-host for a team](../how-to/self-host-team.md) gets one server running with one shared key
pair in about a minute; this guide adds a key per person, a viewer login and retention.

You end up with:

- one server at a URL like `https://obs.example.com`;
- one **ingest key** per person or service, which decides the **project** their data lands in;
- one shared login for the viewer, or a **read key** per person;
- optional retention, so old sessions get deleted.

## 1. Start the server

On the machine that will host it, from a checkout of this repo:

```sh
docker compose -f deploy/compose/compose.postgres.yml up -d --wait
curl -s http://127.0.0.1:4318/readyz      # {"ok":true,"store":"postgres",...}
```

This stack runs serve on Postgres; `compose.yml` runs it on SQLite. Port 4318 is published on every
interface. On the internet, put a TLS proxy in front and keep the port on loopback: set
`CODING_SH_PUBLISH=127.0.0.1:4318` and `CODING_SH_TRUST_PROXY=1` in `deploy/compose/.env`, and
proxy with Caddy (`obs.example.com { reverse_proxy 127.0.0.1:4318 }`).

More detail: [Self-host for a team](../how-to/self-host-team.md).

## 2. Give everyone a key

Use one project per person and one per service, so you can tell who sent what: session ids show
up as `alice/<id>`. Use one shared project if you don't need that.

```sh
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project alice
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project billing-api
```

Each command prints a key (`csh_ik_...`) once, plus a `sha256:` line. Send the key to its owner over a
private channel. Put only the hashes in `deploy/compose/.env`. Hashes are safe to commit.

```sh
CODING_SH_INGEST_KEYS=alice:sha256:...,billing-api:sha256:...
CODING_SH_READ_KEYS=*:sha256:...          # a read key from step 3, or the first-start one
```

Then run `docker compose -f deploy/compose/compose.postgres.yml up -d`. To revoke a key, delete its
hash and run it again. Once you set your own keys, the first-start keys stop working. Set both
variables, or a viewer login from step 3: with only an ingest key, serve refuses to start.

For per-project settings such as `retention_days`, use `[[serve.projects]]` tables in a config file
instead ([PRODUCTION.md](../PRODUCTION.md)).

Projects keep teams' data apart, but they don't make the server safe for untrusted tenants. For
those, run a separate server and database for each tenant.

## 3. One login for the viewer

Pick one of these:

- **Shared login (simplest).** Add `CODING_SH_BASIC_AUTH=team:<a long password>` to
  `deploy/compose/.env`. Open `https://obs.example.com` and the browser asks for the user name and
  password. This login sees every project.
- **A read key per person.** Run `serve keygen --project '*' --read` (all projects) or
  `--project alice --read` (one project), and list the printed hashes in `CODING_SH_READ_KEYS`
  (`*:sha256:...,alice:sha256:...`). Each person opens `https://obs.example.com/?t=<their read key>`
  once, or pastes the key into the sign-in form. A cookie keeps them signed in until the browser
  closes. A one-project key only ever sees that project.

Run `docker compose -f deploy/compose/compose.postgres.yml up -d` after editing `.env`. For the
API, `GET /api/sessions?project=alice` filters by project.

In a config file, the same settings go under `[serve.viewer]` (`basic_user`,
`basic_password_sha256`, `read_keys`), where a read key's entry can also carry `name = "alice"` to
show that name on the labels its holder sets ([PRODUCTION.md](../PRODUCTION.md)).

## 4. Send your coding agents

Each developer runs, with their own ingest key:

```sh
coding.sh init --remote https://obs.example.com --key csh_ik_...
```

That installs the capture hooks if they are missing and adds the team server as a sink named
`team` in `~/.coding.sh/config.toml`. Add `--remote-mode full` to send prompts and output too.
On coding.sh 0.1.1 and older, add the sink by hand:

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

### The model API proxy

The server also mounts [the proxy](../how-to/capture-with-proxy.md) at `/proxy/`, so one URL logs
every model call the team's agents make. Point an agent's base URL at it and send an ingest key in
`x-coding-sh-key`; each call lands in that key's project:

```sh
export ANTHROPIC_BASE_URL=https://obs.example.com/proxy
export ANTHROPIC_CUSTOM_HEADERS="x-coding-sh-key: $INGEST_KEY"
```

The agent's own API key still goes to the API unchanged, and is never stored. The ingest key is
dropped before the call is forwarded. Upstreams come from `[proxy]` in the server's config.

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
