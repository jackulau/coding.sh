# Storage, sinks and privacy

## Storage

Everything lives in `~/.coding.sh` (override it with `CODING_SH_HOME`):

| Path | What |
|---|---|
| `index.db` | SQLite index of sessions and events (`node:sqlite`, no native deps) |
| `blobs/` | content-addressed, zstd-compressed blobs (large prompts and tool output) |
| `spool/` | raw hook payloads waiting to be ingested |
| `repos/` | shadow git objects for repo snapshots (your repository's refs are never touched) |
| `bin/hook.mjs` | the hook agents run |
| `backups/` | copies of every agent config file before coding.sh edited it |
| `config.toml` | settings (`coding.sh config get` / `set`) |

Store URLs are pluggable. `sqlite://` and `file://` are built in. Other schemes load a plugin
package named `coding.sh-store-<scheme>`. This repo has `coding.sh-store-postgres` and
`coding.sh-store-s3`, which are not published yet.

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
- **Redaction** runs at ingest, before anything is written to the index, blobs or sinks. Built-in
  rules catch private keys, vendor API keys and tokens (Anthropic, OpenAI, GitHub, GitLab, Slack,
  AWS, Google, Stripe, npm and more), JWTs, bearer and basic auth, and values next to secret-looking
  names. Add `redact = ["secrets", "env"]` to also replace the literal values of secret-looking
  environment variables, and `redactPatterns` for your own regexes.
- **Exposed secrets.** Redaction keeps a secret out of the store, but the agent and its model
  provider still saw it. Each session counts what was redacted by kind (`coding.sh show` prints a
  `Redacted` row), and a session that held a vendor token gets the `secret:exposed` tag:
  `coding.sh sessions --flag secret:exposed` lists the sessions whose credentials to rotate.
- **Remove a leaked secret.** When a value got past redaction, put it in a file (one value per
  line) and run `coding.sh purge --literal leaked.txt`; `--literal -` reads stdin. Add
  `--dry-run` first to count the copies. Every copy becomes `[redacted:purged]`: event payloads
  and the search index, session titles and stats, labels, eval docs and settings. Blobs holding
  the value are rewritten under a new hash and every reference follows. Spool, judge-cache and
  eval run files (`~/.coding.sh/runs`) keep their length (the value becomes asterisks); a run's
  `.git` directory and files over 64 MB are left alone. The index is then VACUUMed, so the old
  bytes leave the file. Values shorter than 8 characters are refused, the values are never
  printed, and only the SQLite store is supported. Rotate the secret as well: the agent's own
  transcripts, shell history and git are not touched.
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
- **Raw spool.** The hook writes the agent's raw payload to `~/.coding.sh/spool` (mode 600), and
  redaction happens when that file is ingested. `coding.sh gc` deletes ingested spool files older
  than 7 days (`[retention] keepSpoolDays`).
- **The viewer** binds to 127.0.0.1 and requires the per-process token in the URL it prints.
