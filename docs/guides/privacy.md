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
