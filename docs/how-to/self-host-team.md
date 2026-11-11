# Self-host for a team

Run one `coding.sh serve` that the whole team sends sessions to and reads from. Each developer's
agents send to it, and everyone opens one viewer with all the sessions in it.

## Before you start

- A machine with Docker and Docker Compose that your team can reach, on port 4318.
- coding.sh on each developer's machine: `curl -fsSL https://coding.sh/install | sh`.
- No checkout of the repo. The server image is `ghcr.io/jackulau/coding.sh`.

## 1. Start the server

In an empty folder on the server, download the Compose file and start it:

```sh
curl -fsSLO https://raw.githubusercontent.com/jackulau/coding.sh/main/deploy/compose/compose.yml
docker compose up -d --wait
docker compose logs coding-sh
```

The stack is one container with SQLite on a volume. With no keys set, the first start makes a read
key and an ingest key, keeps them on the volume, and prints them:

```text
coding-sh-1  | http://127.0.0.1:4318
coding-sh-1  | No keys are configured, so serve uses the keys in /data/serve-keys.json (made now):
coding-sh-1  |   read key    csh_rk_…
coding-sh-1  |   ingest key  csh_ik_…
coding-sh-1  |   Open        http://127.0.0.1:4318/?t=csh_rk_…
coding-sh-1  |   Connect     coding.sh init --remote http://127.0.0.1:4318 --key csh_ik_…
coding-sh-1  | Use the server's public URL in place of the one above. Set CODING_SH_INGEST_KEYS and CODING_SH_READ_KEYS to use your own keys.
```

These keys are enough to try it: skip to step 4. The URLs are the address inside the container, so
use the server's own host name or IP.

## 2. Make your own keys

Make an ingest key for sending and a read key for the viewer. Each command prints the key once,
then the line the server needs, which holds only the key's sha256 hash:

```sh
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project team
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project '*' --read
```

```text
csh_ik_…
  Shown once. Store it in the client's secret manager.

  Server env:
    CODING_SH_INGEST_KEYS=team:sha256:…
  Or in the config file:
    [[serve.projects]]
    id = "team"
    ingest_keys = ["sha256:…"]
```

Put both `Server env` lines in a file named `.env` next to `compose.yml`, then start again:

```sh
# .env
CODING_SH_INGEST_KEYS=team:sha256:…
CODING_SH_READ_KEYS=*:sha256:…
```

```sh
docker compose up -d --wait
```

The first-start keys stop working. Set both variables: on a public address, serve does not start
with an ingest key and no read key or viewer login. To revoke a key, remove its hash and run
`docker compose up -d` again.

| Key | Can | Give it to |
| --- | --- | --- |
| ingest, `csh_ik_…` | send sessions into its project | each developer and app |
| read, `csh_rk_…` | open the viewer, the API and `/metrics` | people who read |

:::more Other ways to set keys
- `CODING_SH_INGEST_KEYS` takes a comma-separated list. Each entry is `project:sha256:<hex>`,
  `project:csh_ik_…` (the key itself), or a bare key, which lands in the `default` project.
  `CODING_SH_READ_KEYS` takes the same forms; `*`, or a bare key, reads every project.
- `CODING_SH_BASIC_AUTH=team:<a long password>` adds one shared browser login that sees every
  project, in place of read keys.
- Per-project settings such as `retention_days` go in `[[serve.projects]]` tables in a config
  file. See the `[serve]` keys in [Configuration](../reference/config.md#serve).
:::

## 3. Optional: one key per person

The ingest key decides the project its sessions land in. With one key per person, you can tell who
sent what. Make a key for each person:

```sh
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project alice
docker run --rm ghcr.io/jackulau/coding.sh /app/cli.mjs serve keygen --project bob
```

Add each hash to the same variable and start again:

```sh
# .env
CODING_SH_INGEST_KEYS=team:sha256:…,alice:sha256:…,bob:sha256:…
CODING_SH_READ_KEYS=*:sha256:…
```

Alice's sessions then have ids like `alice/<id>`, and `GET /api/sessions?project=alice` returns
only hers. A read key made with `--project alice --read` sees only that project. The viewer list
does not show the project yet.

Projects keep data apart, but they do not make one server safe for untrusted tenants. For those,
run a separate server for each.

## 4. Connect each machine

Each developer runs this with their ingest key:

```sh
coding.sh init --remote http://<server>:4318 --key csh_ik_…
```

```text
  Checking http://<server>:4318…
  Detecting agents…
  Claude Code (user scope)
    create  ~/.claude/settings.json  hooks
✓ Set up Claude Code (hooks)
✓ Sending new sessions to http://<server>:4318 (metadata only). Sessions from before stay on this machine
  Team viewer: http://<server>:4318
```

`init --remote` checks the key against the server first, and changes nothing if the server is
down or refuses the key. Then it installs the capture hooks and adds a sink named `team` to
`~/.coding.sh/config.toml`. Run it again to change the URL, key or mode.

| Option | What it does |
| --- | --- |
| `--remote-mode full` | Also sends prompts, code and tool output. The default, `metadata`, sends none. |
| `CODING_SH_INGEST_KEY=csh_ik_…` | Reads the key from the environment, which keeps it out of shell history. |
| an `https://` URL | Sends the key encrypted. Use it over the internet (step 5). |

New sessions are sent at the end of each agent turn, and whenever a `coding.sh` command runs.
Sessions from before you connected stay on the machine. Apps send to the same server with the
SDKs or OpenTelemetry: see [Trace an app in production](../PRODUCTION.md).

:::more The sink init writes
To connect by hand, add this block to `~/.coding.sh/config.toml`, then run `coding.sh ingest`:

```toml
[[sinks]]
name = "team"
kind = "http"
endpoint = "http://<server>:4318/v1/ingest"
mode = "metadata" # "full" also sends prompts, code and tool output
headers = { Authorization = "Bearer csh_ik_…" }
```
:::

## 5. Serve it over HTTPS

serve speaks plain HTTP. On the internet, put a TLS proxy in front and keep port 4318 on the
loopback interface. Add two lines to `.env`:

```sh
# .env
CODING_SH_PUBLISH=127.0.0.1:4318
CODING_SH_TRUST_PROXY=1
```

With Caddy, which gets the certificate itself:

```caddyfile
obs.example.com {
	reverse_proxy 127.0.0.1:4318
}
```

Run `docker compose up -d`, and connect with `--remote https://obs.example.com`. Fly.io, Railway
and Render handle TLS for you: see [Deploy coding.sh serve](../production/deploy.md).

## Read the result

Open `http://<server>:4318/?t=csh_rk_…`, or open `http://<server>:4318` and paste the read key
into the form. A cookie keeps you signed in until the browser closes.

![The team viewer's session list: five Claude Code sessions, each with its title, model, tool count, tokens, cost and duration, and four with a test result](shot:docs/team-list "The team viewer's session list, with sessions sent by machines that connected with --remote-mode full.")

- **Metadata mode** sends no prompt text, so a session has no title: the list shows
  *Untitled session*, with its agent, model, tools, tokens, cost and duration.
- **Full mode** (`--remote-mode full`) adds the title, prompts, replies, code and tool output.
  Redaction runs on the developer's machine before anything is sent.

Decide the mode as a team. What each mode keeps is in [Privacy and redaction](../guides/privacy.md).

## Back up and upgrade

The data lives on the `coding-sh-data` volume: `index.db`, `blobs/` and `serve-keys.json`.

```sh
docker compose stop
docker compose cp coding-sh:/data ./coding-sh-backup
docker compose start
```

| Task | How |
| --- | --- |
| Upgrade | `docker compose pull`, then `docker compose up -d`. The schema migrates on start. |
| Pin a version | `CODING_SH_IMAGE=ghcr.io/jackulau/coding.sh:0.1.6` in `.env`. |
| Delete old sessions | `CODING_SH_RETENTION_DAYS=30` in `.env` deletes sessions older than 30 days, every hour. Eval assets stay. |
| Check health | `curl -s http://<server>:4318/readyz` answers `{"ok":true,…}` once the store is ready. |
| Use Postgres | Download `compose.postgres.yml` from the same folder and run it with `-f`. Postgres holds the index and the blobs. |

For ClickHouse, the store plugins and SQL over the tables, see
[Postgres and ClickHouse stores](../reference/stores.md).

## If something goes wrong

- **`init` prints `refused the key. Nothing was changed`.** The key's hash is not in
  `CODING_SH_INGEST_KEYS`, or it is a read key. Check `.env`, then run `docker compose up -d`.
- **`init` prints `Can't reach <url>`.** Check the URL and the port, then run
  `curl -s http://<server>:4318/healthz` from the developer's machine.
- **`docker compose up --wait` reports the container unhealthy.** On a busy host the first health
  checks can time out. Run `docker compose ps` a minute later; `curl -s http://<server>:4318/readyz`
  shows whether the store is ready.
- **serve exits with no read key.** You set `CODING_SH_INGEST_KEYS` alone. Add
  `CODING_SH_READ_KEYS` or `CODING_SH_BASIC_AUTH`.
- **No sessions show up.** Run `coding.sh ingest` on the developer's machine, then reload the
  viewer. Only sessions that started after `init --remote` are sent.
- **Every session says Untitled session.** The machine sends metadata. Run
  `coding.sh init --remote <url> --key csh_ik_… --remote-mode full` if the team agreed to full mode.

## Next steps

- [Trace an app in production](../PRODUCTION.md): send your API apps to the same server.
- [Deploy coding.sh serve](../production/deploy.md): Fly.io, Railway, Render and serverless.
- [Privacy and redaction](../guides/privacy.md): what each mode sends and stores.
- [Configuration](../reference/config.md#serve): every `[serve]` key and its environment variable.
