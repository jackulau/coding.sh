# Privacy and redaction

coding.sh keeps what it records on your machine, in `~/.coding.sh`. Secrets are replaced before a
session reaches the index, the blobs or a sink, and nothing is sent anywhere unless you add a sink
or connect to a team server.

## What redaction looks like

A prompt that pasted an API key, after `coding.sh ingest`:

```sh
coding.sh show cd0185b0
```

```text
Tidy notes.txt and greet. The API key is [redacted:anthropic-key] if you need it.
  Redacted      anthropic-key 1. The agent saw these credentials: rotate them
    +0ms  user        Tidy notes.txt and greet. The API key is [redacted:anthropic-key] if you need it.
```

The key never reached the index, the blobs or any sink. The agent and its model provider still saw
it, so the session gets the `secret:exposed` tag. List every session whose credentials to rotate:

```sh
coding.sh sessions --flag secret:exposed
```

A made-up key, like the ones in docs and test fixtures, is redacted too, but counts as
`placeholder-key` and does not add the tag.

## What is stored, and where

| Path in `~/.coding.sh` | What |
| --- | --- |
| `index.db` | The SQLite index of sessions and events. |
| `blobs/` | Large prompts and tool output, compressed and stored by hash. |
| `spool/` | What the hook received from the agent, redacted by the node hook; see below. |
| `repos/` | Snapshots of the working tree before and after a session. They hold your files as they are, not redacted; files your `.gitignore` skips are left out. On Windows, paths over 260 characters are kept too. Your repo's own refs are never touched. |
| `llm-cache/` | Model replies recorded by `exp run --record` or `--replay`, in any capture mode, redacted with your `[capture]` rules. See [Replay recorded model calls](../how-to/replay-llm-calls.md#what-is-stored). |
| `backups/` | A copy of every agent config file before coding.sh edited it. |
| `config.toml` | Your settings. |
| `star.json` | When you first ran coding.sh and when the one-time GitHub star prompt was shown, dismissed or clicked. Four timestamps, no network call. |

`CODING_SH_HOME` moves the folder. Outside Windows, the index, its WAL files, the blob store and
the index backups are readable by your user only (files 0600, folders 0700). In full mode, the default, coding.sh keeps prompts, replies,
tool calls with their input and output, file changes, errors, model names, token usage and timing.

- **Nothing leaves your machine by default.** With no sinks, no session data is sent. The only
  default network request is a daily update check to `api.github.com` (or `registry.npmjs.org`);
  [Install](install.md#updates) says how to turn it off.
- **The viewer** listens on 127.0.0.1 and needs the token in the URL it prints.
- **A repo's own `.coding.sh/config.toml` can only add privacy.** It can add redaction rules or
  switch to metadata mode, but never add a sink or move the store, so a cloned repo cannot send
  your sessions anywhere.
- **A repo's `redactPatterns` are literal text.** Regular expressions count only from your own
  config.

## Redaction

Redaction runs at ingest, before anything is written to the index, the blobs or a sink. Each
match becomes `[redacted:<kind>]`.

- A value nested more than 64 levels deep is redacted with the same rules. A value too deep to
  copy is stored as `[redacted:too-deep]`, also in the spool.
- A private key's `BEGIN` line with no `END` line, as in output cut short, is redacted to the end
  of the text when key data follows it. A `BEGIN` line named in prose is left as it is.

| `[capture] redact` | Replaces | On by default |
| --- | --- | --- |
| `secrets` | Private keys, also in base64; API keys and tokens from over thirty services and tools, such as Anthropic, OpenAI, GitHub and AWS; JWTs; `Authorization` headers; cookies; passwords and signatures in URLs; `.netrc` passwords; values next to names like `password` or `client_secret` | yes |
| `env` | The values of your environment variables whose names hold `KEY`, `TOKEN`, `SECRET`, `PASSW`, `PWD`, `CREDENTIAL`, `AUTH`, `COOKIE` or `SESSION` | no |
| `pii` | Email addresses, phone numbers, card numbers, IBANs and national ids | no |
| `email`, `phone`, `card`, `iban`, `national-id` | One kind of personal data | no |
| `none` | Nothing | no |

```toml
# ~/.coding.sh/config.toml
[capture]
redact = ["secrets", "env", "pii"]
redactPatterns = ["CSH-[0-9]{8}"]        # your own regular expressions
exclude = ["~/work/secret-client/**"]    # never capture sessions in these folders
```

:::more How the rules avoid false matches
- `env` skips variables that hold a place, not a secret: `PWD`, `OLDPWD`, and names ending in
  `_PATH`, `_DIR`, `_FILE` or `_SOCK`, such as `SSH_AUTH_SOCK`.
- `env` also skips values shorter than 8 characters, and values that are existing paths on this
  machine, so your working directory is not replaced wherever it appears.
- Card numbers must have a known issuer prefix and pass the Luhn check. IBANs must have their
  country's length and a valid check. So ids, versions, dates and timestamps pass through.
- National ids are a US SSN, a UK National Insurance number or a Canadian SIN.
- A span or log record that `coding.sh serve` or `coding.sh collector --keep-raw` keeps as a blob
  is redacted one string at a time, so the blob hides what its events hide.
:::

## Metadata mode

Metadata mode keeps the structure and the numbers, with no prompts, code or tool output: ids,
times, event kinds, durations, token counts, cost and short labels such as tool names.

| Where | Setting | Default |
| --- | --- | --- |
| Your machine's store | `[capture] mode = "metadata"` | `full` |
| A sink | `mode = "metadata"` on the `[[sinks]]` entry | `metadata` |
| A team server, from your machine | `coding.sh init --remote <url> --key csh_ik_… --remote-mode full` | `metadata` |
| The TypeScript or Python SDK in your app | `capture: "metadata"`, or `CODING_SH_CAPTURE_MODE=metadata` | `full` |
| `coding.sh serve` | `CODING_SH_CAPTURE_MODE=metadata`: drops content from everything it receives | `full` |

A session sent in metadata mode has no title, so a team viewer lists it as *Untitled session*.
The SDK setting drops message text and tool input and output before they leave your app.

## Sinks

A sink copies your sessions to another place: an OpenTelemetry collector (`otlp`) or any HTTP
endpoint that takes coding.sh's JSON (`http`). Sinks send metadata unless you set `mode = "full"`:

```toml
# ~/.coding.sh/config.toml
[[sinks]]
kind = "otlp"                      # or "http"
endpoint = "http://localhost:4318"
mode = "metadata"                  # the default; "full" sends content, redacted first
headers = { Authorization = "Bearer ${OTEL_TOKEN}" }
```

`coding.sh init --remote` writes an `http` sink named `team` for you: see
[Self-host for a team](../how-to/self-host-team.md). It sets the sink's `since` to the time you
first connect, so sessions that started before it stay on your machine. A sink you write by hand
without `since` can also send past sessions that are still on disk
([`[[sinks]]`](../reference/config.md#sinks)).

## The model API proxy

[The proxy](../how-to/capture-with-proxy.md) stores each call's request and response, redacted
with the same rules. It keeps an allowlist of headers (API version, beta flags, user agent,
session and request ids, rate limits) and never stores `Authorization`, `x-api-key` or cookies.
In metadata mode it keeps hashes of the system prompt and tools, counts, tool names, usage and
timing.

It listens on 127.0.0.1 unless you pass `--host` or set `host` under `[proxy]` in `config.toml`. The
proxy has no auth: anyone who can reach its port can send calls through it.

## The raw spool

The hook writes what the agent sends to `~/.coding.sh/spool` (mode 600). The node hook (`hook.mjs`,
what agents run on Windows) redacts the payload first, with `capture.redact` and
`capture.redactPatterns` from your `config.toml`, so a secret those rules match never reaches the
spool.

To stay fast, the node hook loads those rules only for a payload that may hold a secret, the only
kind they would change, or when your `config.toml` sets other rules. If it can't load them, it
writes no line for that payload and logs the error to `spool/errors.log`.

The line records how many values the node hook replaced, by rule, and ingest adds those counts to the
stored event. A repo's `.coding.sh/config.toml` can add rules; ingest applies them. The POSIX sh hook
(`hook.sh`, what agents run elsewhere) writes the payload without redacting it, to stay fast.
Ingest stores a redacted copy either way, and redacts what is left on disk:

- Both hooks give a payload its own file under `spool/<agent>/raw/`, unless its spool line fits in
  about 1 KB. Once ingested, that file is rewritten with secrets redacted, in every capture mode.
- A short payload inside the day's spool file stays as written until its UTC day has passed and
  ingest has read the whole file. Then ingest redacts it in place, keeping the line's length so
  ingest cursors still hold.
- Ingest does not open a spool file again when it read the file in one pass and found nothing to
  redact.
- With `CODING_SH_DISABLE=1` the hooks write no payload, only the session id, to
  `spool/disabled-sessions`, so ingest and `ingest --backfill` leave that session out.
- `coding.sh gc` deletes ingested spool files older than 7 days (`[retention] keepSpoolDays`),
  never the current day's. `coding.sh purge` removes a value sooner.

## Remove a leaked secret

When a value got past redaction, put it in a file, one value per line, and purge it. Count the
copies first:

```sh
coding.sh purge --literal leaked.txt --dry-run
coding.sh purge --literal leaked.txt
```

`--literal -` reads the values from stdin. To remove every value of one shape, pass a regular
expression; write the shape, not the secret, because it sits on the command line:

```sh
coding.sh purge --rule 'sk-ant-api03-[A-Za-z0-9_-]{80,}' --dry-run
```

Purge looks in each of these places:

| Where | What purge does |
| --- | --- |
| Events and the search index | Replaces the value with `[redacted:purged]`. |
| Session titles and stats, labels, eval docs, settings | Replaces the value with `[redacted:purged]`. |
| Blobs | Rewrites them under a new hash, and every reference follows. |
| Spool, judge cache and eval run files | Replaces the value with asterisks of the same length. |
| Recorded model calls (`llm-cache/`) | Waits for jobs still recording, then rewrites each recording that holds the value, keeping its replay keys. Deletes a torn or temp file holding it. |
| Snapshots (`repos/`) | Names each snapshot repo that holds the value or that git can't read, and exits 1 until you delete it. It does not rewrite snapshots. |
| `index.db` and `blobs/pack.db` | VACUUMs them, so the old bytes leave the files. |
| Index backups from an upgrade | Deletes them; `--dry-run` names them. |

Values shorter than 8 characters are refused, and neither values nor matches are printed. Purge
works on the SQLite store only. Rotate the secret as well: purge does not touch the agent's own
transcripts, your shell history or git.

:::more When purge exits 1
- **A file is open, or a job is recording.** The viewer, `serve`, `sqlite3` or a backup keeps
  old bytes until it closes. Purge waits (`CODING_SH_PURGE_WAIT_MS`), then names the file or job.
  Purge again once it ends.
- **A backup can't be deleted.** Purge names it. Delete it by hand.
- **A snapshot repo holds the value.** Sessions and eval tasks name a snapshot by its commit id,
  which a rewrite would change, so purge names the folder under `repos/`. Delete it and purge
  again.
- **Deleting a snapshot repo** drops its sessions' file changes from `coding.sh show`, and eval
  tasks that start from it can't run.
- **The database or its search index is damaged.** Purge checks both after it runs.
- A run's `.git` folder is left alone, and files and snapshot objects over 64 MB are not read. A
  `--rule` that matches empty text or more than 10,000 distinct values is refused.
:::

## Next steps

- [Self-host for a team](../how-to/self-host-team.md): what a team server receives in each mode.
- [Configuration](../reference/config.md): every `[capture]`, `[retention]` and `[[sinks]]` key.
- [Postgres and ClickHouse stores](../reference/stores.md): where a team server keeps the data.
