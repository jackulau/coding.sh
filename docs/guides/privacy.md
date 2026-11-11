# Storage, sinks and privacy

## Storage

Everything lives in `~/.coding.sh` (override it with `CODING_SH_HOME`):

| Path | What |
|---|---|
| `index.db` | SQLite index of sessions and events (`node:sqlite`, no native deps) |
| `blobs/` | content-addressed, zstd-compressed blobs (large prompts and tool output) |
| `spool/` | hook payloads: unredacted until ingested; after ingest, payloads in `raw/` files are redacted in place and payloads inside a spool line stay as written until `gc` |
| `repos/` | shadow git objects for repo snapshots (your repository's refs are never touched) |
| `bin/hook.sh`, `bin/hook.mjs` | the hook agents run (`hook.sh` outside Windows, which hands what it does not cover to `hook.mjs`) |
| `backups/` | copies of every agent config file before coding.sh edited it |
| `config.toml` | settings (`coding.sh config get` / `set`) |

Store URLs are pluggable. `sqlite://` and `file://` are built in. Other schemes load a plugin
package named `coding.sh-store-<scheme>`. `coding.sh-store-postgres`, `coding.sh-store-clickhouse`
and `coding.sh-store-s3` are on npm.

## Sinks

To mirror events somewhere else, add a sink. Sinks send **metadata only** unless you set
`mode = "full"`. Metadata means ids, timestamps, kinds, durations, token counts and short labels.
It excludes prompts, code and tool output.

```toml
# ~/.coding.sh/config.toml
[[sinks]]
kind = "otlp"                      # or "http"
endpoint = "http://localhost:4318"
mode = "metadata"                  # default; "full" sends content
headers = { Authorization = "Bearer ${OTEL_TOKEN}" }
```

## Privacy

- **Nothing leaves your machine by default.** With no sinks configured, no session data is sent
  anywhere. The only default network request is the daily update check: a GET to
  `api.github.com` (falling back to `registry.npmjs.org`) whose User-Agent includes the coding.sh
  version. Turn it off as described in [install.md](install.md#updates).
- **What is captured** (full mode, the default): prompts, assistant replies, tool calls with
  inputs and outputs, file changes, errors, subagent links, model names, token usage, latency and
  a snapshot of the working tree before and after a session.
- **Redaction** runs at ingest, before anything is written to the index, blobs or sinks (the spool is
  covered under "Raw spool" below). Built-in
  rules catch private keys, vendor API keys and tokens (Anthropic, OpenAI, GitHub, GitLab, Slack,
  AWS, Google, Stripe, npm and more), JWTs, bearer and basic auth, and values next to secret-looking
  names. Add `redact = ["secrets", "env"]` to also replace the literal values of secret-looking
  environment variables, and `redactPatterns` for your own regexes. The `env` rule skips
  variables that hold a place rather than a secret (`PWD`, `OLDPWD`, names ending in `_PATH`,
  `_DIR`, `_FILE` or `_SOCK`, such as `SSH_AUTH_SOCK`) and values that are existing paths on this
  machine, so a path such as your working directory is not replaced wherever it appears.
  A source span or log record that `coding.sh serve` or `coding.sh collector --keep-raw` keeps as
  a blob is redacted one string at a time, and a string that holds JSON as JSON, so the blob hides
  what its events hide. Blobs stored before 0.1.6 were redacted as one text and can hold a
  `NAME=value` line or a JSON field in clear: remove such a value with `coding.sh purge` (below).
- **Personal data** is opt-in: `redact = ["secrets", "pii"]` also replaces email addresses, phone
  numbers, card numbers, IBANs and national ids (US SSN, UK National Insurance number, Canadian
  SIN) with `[redacted:<kind>]`. Card numbers must have a known issuer prefix and pass the Luhn
  check, and IBANs must have their country's length and a valid check, so ids, versions, dates and
  timestamps pass through. Each kind can be turned on alone: `phone`, `card`, `iban`,
  `national-id`, `email`.
- **Exposed secrets.** Redaction keeps a secret out of the store, but the agent and its model
  provider still saw it. Each session counts what was redacted by kind (`coding.sh show` prints a
  `Redacted` row), and a session that held a vendor token gets the `secret:exposed` tag:
  `coding.sh sessions --flag secret:exposed` lists the sessions whose credentials to rotate. A
  made-up key, like the ones in docs and test fixtures, is redacted but counts as
  `placeholder-key` and does not add the tag. Sessions captured before this rule keep their tag
  until `coding.sh ingest --rebuild` reads them again from their transcripts.
- **Remove a leaked secret.** When a value got past redaction, put it in a file (one value per
  line) and run `coding.sh purge --literal leaked.txt`; `--literal -` reads stdin. Add
  `--dry-run` first to count the copies. Every copy becomes `[redacted:purged]`: event payloads
  and the search index, session titles and stats, labels, eval docs and settings. Blobs holding
  the value are rewritten under a new hash and every reference follows. Spool, judge-cache and
  eval run files (`~/.coding.sh/runs`) keep their length (the value becomes asterisks); a run's
  `.git` directory and files over 64 MB are left alone. The index and the blob pack
  (`blobs/pack.db`) are then VACUUMed, so the old bytes leave the files, and checked: purge exits 1
  if the database or its search index is damaged. If another process holds a read on one of them
  (the viewer, `serve`, a `sqlite3` shell, a backup), SQLite keeps the old bytes until it closes:
  purge waits a few seconds (`CODING_SH_PURGE_WAIT_MS` sets how long), then says which file still
  holds them and exits 1. Close that process and run the same purge again. A copy of the index
  kept next to it by an upgrade (`index.db.v<N>.bak`) or by `upgrade-store --restore`
  (`index.db.v<N>.undone`) holds the value too. Purge deletes these copies instead of rewriting
  them, so `upgrade-store --restore` can no longer put one back; `--dry-run` names them, and
  purge exits 1 if one can't be deleted. Purge with coding.sh
  0.1.5 or newer: an older purge does not see blobs in the pack. Values shorter than 8 characters
  are refused, the values are never printed, and only the SQLite store is supported. Rotate the
  secret as well: the agent's own transcripts, shell history and git are not touched.
- **Remove secrets by shape.** `coding.sh purge --rule 'sk-ant-api03-[A-Za-z0-9_-]{80,}'` finds
  every distinct match of a regular expression in the same places and purges each one like a
  `--literal` value. `--rule` repeats, and combines with `--literal`. Matches shorter than 8
  characters are left alone, a rule that matches empty text or more than 10,000 distinct values
  is refused, and neither the rule nor a match is printed. The rule sits on the command line, so
  write the shape of the secret, not the secret.
- **Metadata mode.** `[capture] mode = "metadata"` stores structure and numbers only, with no
  prompts, code or tool output.
- **Exclusions.** `[capture] exclude = ["~/work/secret-client/**"]` drops events from matching
  directories.
- **Repo-level config can only add privacy.** A `.coding.sh/config.toml` inside a repository may
  add redaction rules or switch to metadata mode. It can never add sinks or move the stores, so a
  cloned repo cannot exfiltrate your sessions.
- **The model API proxy** ([Capture with the proxy](../how-to/capture-with-proxy.md)) stores each
  call's request (system prompt, tool definitions, messages and settings) and response, redacted with
  the same rules before they are written. It keeps an allowlist of headers (API version, beta flags,
  user agent, session ids, request ids, rate limits) and never stores `Authorization`, `x-api-key`
  or cookies, so no API key or login token is kept. In metadata mode it keeps hashes of the system
  prompt and tools, counts, tool names, usage and timings. The proxy listens on 127.0.0.1 unless you
  pass `--host`.
- **Raw spool.** The hook writes the agent's payload to `~/.coding.sh/spool` (mode 600) unredacted,
  to stay fast. Hooks share one spool file per agent per UTC day.
  - The shell hook handles most calls. It gives a payload its own file under `spool/<agent>/raw/`
    unless the payload is one line of up to about 1 KB.
  - Once ingest has stored the line, it rewrites that file with secrets redacted, in every capture
    mode. The file stays because a re-parse reads it again.
  - A payload inside the spool file stays as written: a short one-line payload, and any payload up
    to 256 KB from a call the node hook handles (an eval run, a reply to the agent, a gateway base
    URL).
  - `coding.sh gc` deletes ingested spool files and their `raw/` files older than 7 days
    (`[retention] keepSpoolDays`), never the current day's file. `coding.sh purge` removes a value
    from the spool sooner.
- **The viewer** binds to 127.0.0.1 and requires the per-process token in the URL it prints.
