# Configuration reference

Every key in `config.toml` and every environment variable coding.sh reads. Site version:
[coding.sh/docs/config](https://coding.sh/docs/config).

## Where settings come from

Later layers win:

1. Built-in defaults.
2. `~/.coding.sh/config.toml` (or `$CODING_SH_HOME/config.toml`), your user config.
3. `<repo>/.coding.sh/config.toml`, the nearest one above the working directory. A repo file arrives
   with `git clone`, so it may only make capture more private: it can set `capture` and `snapshot`
   keys, redaction lists are merged rather than replaced, `capture.mode` can only become
   `metadata`, and `capture.maxInlineBytes` can only go down. It can never set sinks or stores.
4. Environment variables (`CODING_SH_STORE_URL`, `CODING_SH_BLOB_URL`, and the server variables).
5. Command-line flags (`--store`, `--blobs`, and each command's own options).

```sh
coding.sh config path                          # the file in use
coding.sh config get                           # the effective config, all layers applied
coding.sh config get capture.mode
coding.sh config set capture.mode metadata --dry-run
coding.sh config set capture.redact '["secrets","env"]'
```

`config set` accepts the keys marked **settable** below, parses numbers, `true`/`false` and JSON
arrays, and keeps the rest of the file as it is. Edit the file by hand for sinks, prices, gateway
and serve settings.

String values in `store.*`, `sinks.*.endpoint`, `sinks.*.headers` and `gateway.apiKey` may use
`${NAME}`; it is replaced with that environment variable, and an unset variable is an error. Use it to
keep tokens out of the file.

## `[store]`

| Key | Default | Settable | What |
|---|---|---|---|
| `store.index` | `sqlite://~/.coding.sh/index.db` | yes | Index store URL. `sqlite://` and `memory://` are built in; `postgres://` needs the `coding.sh-store-postgres` package. Another scheme loads `coding.sh-store-<scheme>`. |
| `store.blobs` | `file://~/.coding.sh/blobs` | yes | Blob store URL for large payloads. `s3://` needs `coding.sh-store-s3`. With a `postgres://` index and no blob URL, blobs go to the same database. |

## `[capture]`

| Key | Default | Settable | What |
|---|---|---|---|
| `capture.mode` | `"full"` | yes | `full` keeps prompts, replies and tool input and output. `metadata` keeps ids, times, kinds, durations, token counts and short labels only. |
| `capture.redact` | `["secrets"]` | yes | Built-in redactors: `secrets` (API keys, tokens, private keys), `env` (values of environment variables), `none` (clears the list in your user config). |
| `capture.redactPatterns` | `[]` | yes | Extra regular expressions to redact. Matches become `[redacted:<kind>]`. |
| `capture.exclude` | `[]` | yes | Path globs (`*`, `**`, `?`, `~`). Sessions whose working directory, or a parent of it, matches are dropped at ingest. |
| `capture.maxInlineBytes` | `4096` | yes | Payloads larger than this go to the blob store. Minimum 256. |

Redaction runs at ingest, before anything is written to the index, blobs or sinks.

## `[snapshot]`

Used by `coding.sh run --`, which snapshots the repo before and after the command.

| Key | Default | Settable | What |
|---|---|---|---|
| `snapshot.enabled` | `true` | yes | Take repo snapshots. |
| `snapshot.maxFiles` | `20000` | yes | Skip the snapshot for repos with more files than this. |
| `snapshot.timeoutMs` | `2000` | yes | Give up on a snapshot after this many milliseconds. |

## `[retention]`

Applied by `coding.sh gc`.

| Key | Default | Settable | What |
|---|---|---|---|
| `retention.keepSpoolDays` | `7` | yes | Days to keep spool files after they were ingested and sent to every sink. |
| `retention.toolOutputDays` | `90` | yes | Days to keep blobs referenced only by tool output and file reads. Diffs and eval tasks are kept. |

## `[update]`

| Key | Default | Settable | What |
|---|---|---|---|
| `update.check` | `true` | yes | Check for a new release in the background, at most once a day. `coding.sh serve` never checks. |

## `[[sinks]]`

A sink copies events to another system as they are ingested. Add one table per sink.

```toml
[[sinks]]
kind = "otlp"                          # or "http"
name = "team"
endpoint = "https://obs.example.com"   # otlp posts to <endpoint>/v1/traces
mode = "metadata"
headers = { Authorization = "Bearer ${CODING_SH_INGEST_KEY}" }
```

| Key | Default | What |
|---|---|---|
| `kind` | required | `otlp` (OTLP/HTTP JSON traces) or `http` (coding.sh/trace JSON). Another kind loads `coding.sh-sink-<kind>`. |
| `endpoint` | required | Where to send. |
| `mode` | `"metadata"` | `metadata` sends no prompts, code or tool output. `full` sends everything that was captured. |
| `name` | the kind | Unique name: letters, digits, `.`, `_`, `-`. Needed when two sinks share a kind. |
| `batchSize` | | Events per request. |
| `headers` | | Table of HTTP headers. |

## `[prices]`

One `[prices."<model>"]` table per model, with prices in USD per million tokens. Ingest and
`coding.sh serve` use them to estimate cost for model calls that report tokens but no cost. They
replace the built-in row for that model, add models it lacks, and also price newer versions in the
same family (`[prices."house-coder-2"]` prices `house-coder-2.1` too). A cost the agent or gateway
reported is never replaced.

```toml
[prices."my-finetune"]
input = 3.0
output = 15.0
cache_read = 0.3
cache_write = 3.75
```

`input` and `output` are required. `cache_read` and `cache_write` are optional and default to the
input price. `[pricing."<model>"]`, the older spelling, still works; `[prices]` wins a model set in
both. Stored estimates are recomputed the next time the index opens after a change.

Long-context and service-tier rates are optional sub-tables:

```toml
[prices."my-finetune".long_context]   # prompts over `above` tokens (input + cache)
above = 200000
input = 6.0
output = 22.5

[prices."my-finetune".batch]          # also flex, priority, fast, ultrafast
input = 1.5
output = 7.5

[prices."my-finetune".batch.long_context]   # `above` defaults to the model's threshold
input = 3.0
output = 11.25
```

Each sub-table takes the same `input`, `output`, `cache_read` and `cache_write` keys, plus
`cache_write_1h` for Anthropic 1-hour cache writes (it defaults to `cache_write`). A `geo` table
multiplies every rate for calls that ran in that inference geography:

```toml
[prices."my-finetune".geo]   # payload.inferenceGeo, from Anthropic's usage.inference_geo
us = 1.1
```

A call goes to
a tier from its recorded service tier (`batch`, `flex`, `priority`), or `fast` for Claude fast mode
(`fast` falls back to `priority` rates when it has no table of its own). A tier with no table is
priced at the standard rates. An override replaces the whole built-in row, tiers included, so
add the tier tables you want to keep. See
[Where cost comes from](../how-to/expensive-sessions.md#where-cost-comes-from).

## `[gateway]`

For LLM gateways (`coding.sh gateway`, `compare --gateway`, and `gateway` judges). The top-level keys are for
Vercel AI Gateway. Other gateways get their own table, `[gateway.<name>]`, with the same keys. Names: `openrouter`,
`litellm`, `cloudflare`, `portkey`, `helicone`, `requesty`, `ramp`, `truefoundry`, `kong`, `bifrost`, `martian`.

| Key | Default | What |
|---|---|---|
| `apiKeyEnv` | the gateway's standard variable, e.g. `"AI_GATEWAY_API_KEY"`, `"OPENROUTER_API_KEY"` | Environment variable that holds the key. |
| `apiKey` | | The key itself, usually `"${SOME_VAR}"`. Used only when the variable above is empty. |
| `baseUrl` | the gateway's API, e.g. `https://ai-gateway.vercel.sh/v1` | API base. For Vercel, `CODING_SH_GATEWAY_URL` overrides it. Required for self-hosted LiteLLM unless `LITELLM_PROXY_API_BASE` is set. |
| `default` | | Top level only: the gateway a bare `compare --gateway` uses. |
| `accountId`, `gatewayId` | | `[gateway.cloudflare]` only: where the logs live. `CLOUDFLARE_ACCOUNT_ID` also works. |

Keys are never printed or stored. See [LLM gateways](../integrations/ai-gateway.md).

## `[serve]`

Read only by `coding.sh serve`. Every key has an environment variable, which wins over the file.
[PRODUCTION.md §1.1](../PRODUCTION.md#11-config) has the full rules.

| Key | Env | Default | What |
|---|---|---|---|
| `serve.host` | `CODING_SH_HOST` | `127.0.0.1` | Interface to bind. |
| `serve.port` | `CODING_SH_PORT`, then `PORT` | `4318` | Port. |
| `serve.retention_days` | `CODING_SH_RETENTION_DAYS` | `0` (keep) | Delete sessions older than this. |
| `serve.log` | `CODING_SH_LOG` | `json` when stderr is not a terminal | `json` or `text`. |
| `serve.queue_max_events` | `CODING_SH_QUEUE_MAX_EVENTS` | `50000` | Ingest queue limit; over it, requests get 429. |
| `serve.queue_max_bytes` | `CODING_SH_QUEUE_MAX_BYTES` | `134217728` | Same, in bytes. |
| `serve.insecure` | `CODING_SH_INSECURE=1` | off | Allow a non-loopback bind without keys. |
| `serve.trust_proxy` | `CODING_SH_TRUST_PROXY=1` | off | Honor `X-Forwarded-Proto` and `X-Forwarded-For`. |
| `serve.cors_origins` | | `[]` | Browser origins allowed to post to the ingest routes (`/v1/ingest`, OTLP). The viewer and `/api/*` stay same-origin. |
| `[[serve.projects]]` `id`, `ingest_keys`, `retention_days` | `CODING_SH_INGEST_KEYS` | | Projects and their ingest keys (`sha256:<hex>` in the file). |
| `[serve.viewer]` `read_keys` | `CODING_SH_READ_KEYS` | | Read keys: `[{ project = "*", key = "sha256:<hex>", name = "alice" }]`. `name` (optional) is recorded as the author of that key's labels. |
| `[serve.viewer]` `basic_user`, `basic_password_sha256` | `CODING_SH_BASIC_AUTH` (`user:password`) | | Basic auth for the viewer. |
| `capture.mode` | `CODING_SH_CAPTURE_MODE` | `full` | `metadata` drops content on ingest. |

## Other files

| File | Used by | Reference |
|---|---|---|
| `coding.sh.toml` at the repo root | `coding.sh toolevals` (targets, drivers, variants, `[toolevals] confirmAboveUsd`, default 5) | [TOOL-EVALS.md](../TOOL-EVALS.md) |
| `bench/<name>.toml` or `~/.coding.sh/benchmarks/<name>.toml` | `coding.sh bench` | `coding.sh bench new --help` |
| An experiment spec (JSON) | `coding.sh exp run <spec>` | [Evals](https://coding.sh/docs/evals) |
| A harness TOML | `coding.sh harness snapshot --file` | `coding.sh harness snapshot --help` |

## Environment variables

### Paths and stores

| Variable | What |
|---|---|
| `CODING_SH_HOME` | Data directory. Default `~/.coding.sh`. Use a temp dir in tests and CI to keep runs out of your history. |
| `CODING_SH_STORE_URL` | Index store for every command; same as `--store`. Skips the automatic ingest of the local spool. |
| `CODING_SH_BLOB_URL` | Blob store; same as `--blobs`. |
| `DATABASE_URL` | `coding.sh serve` only: the store when it is a `postgres://` URL and `CODING_SH_STORE_URL` is unset. |

### Capture

| Variable | What |
|---|---|
| `CODING_SH_DISABLE=1` | The hook reads its input and writes nothing. Set it in an agent's environment to pause capture. |
| `CODING_SH_NO_AUTO_INGEST=1` | The hook does not start a background ingest when a session ends. |
| `CODING_SH_ECHO_CONTINUE=1` | The hook prints `{"continue":true}`, for agents that need a JSON reply. `init` sets this up where needed. |
| `CODING_SH_HOOK_SOURCE` | Path of the `hook.mjs` that `init` copies into `~/.coding.sh/bin`. |
| `CODING_SH_CAPTURE_MODE` | `coding.sh serve` and the SDKs: `full` or `metadata`. |

### Set by coding.sh for the processes it starts

Read these in your agent or script to tie its output to a run.

| Variable | Set by | What |
|---|---|---|
| `CODING_SH_SESSION_ID` | `run --` | The session id of the wrapped command. |
| `CODING_SH_RUN_ID` | `exp run`, `compare`, `bench`, `workflows` | Run id. Hook events carrying it are tagged with the run, and the hook skips its own background ingest. You can set it yourself to tag a run. |
| `CODING_SH_CASE_ID`, `CODING_SH_TRIAL` | `exp run` command tasks | The case id and trial number. |
| `CODING_SH_WORKFLOW_RUN_ID` | `workflows run`, `workflows replay` | Workflow run id. |
| `CODING_SH_BENCH`, `CODING_SH_BENCH_SEED`, `CODING_SH_BENCH_DATE`, `CODING_SH_BENCH_RUN_ID`, `CODING_SH_BENCH_CASES` | `bench run` command sources | Benchmark name, seed, date, run id and number of cases to print. |
| `CODING_SH_BENCH_NOW` | you, in tests | Make `bench run` act as if it started at this time (ISO time or epoch ms), to simulate daily runs. |
| `CODING_SH_BENCH_SEED_KEY` | you, or a CI secret | Key for `seed = "secret"` benchmarks: each date's salt is an HMAC of the date under it. Rename it per benchmark with `seedKeyEnv`. |

### Server

`CODING_SH_HOST`, `CODING_SH_PORT`, `PORT`, `CODING_SH_INGEST_KEYS`, `CODING_SH_READ_KEYS`,
`CODING_SH_BASIC_AUTH`, `CODING_SH_INSECURE`, `CODING_SH_TRUST_PROXY`, `CODING_SH_LOG`,
`CODING_SH_RETENTION_DAYS`, `CODING_SH_QUEUE_MAX_EVENTS`, `CODING_SH_QUEUE_MAX_BYTES`: see
[`[serve]`](#serve).

### Evals and integrations

| Variable | What |
|---|---|
| `ANTHROPIC_API_KEY` | LLM judges with `"provider":"anthropic"` (the default). A grader's `apiKeyEnv` names another variable. |
| `OPENAI_API_KEY` | LLM judges with `"provider":"openai"`. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway: `gateway enrich`, `gateway status --credits`, `compare --gateway`, `gateway` judges. |
| `CODING_SH_GATEWAY_URL` | Vercel AI Gateway API base. |
| `OPENROUTER_API_KEY`, `LITELLM_PROXY_API_KEY`, `CLOUDFLARE_API_TOKEN`, `PORTKEY_API_KEY`, `HELICONE_API_KEY`, `RAMP_ROUTER_API_KEY` | Other gateways: `gateway enrich` lookups and `compare --gateway <name>`. |
| `CODING_SH_RETRY_BASE_MS` | First backoff (ms) before a trial is retried after a rate limit, 5xx or network error; it doubles per retry, with jitter. Default `2000`. Tests set `0`. |
| `CODING_SH_CONFIRM_ABOVE_USD` | `workflows run` and `replay` ask before running above this estimated cost. Default `1`. |
| `GITHUB_TOKEN`, `GH_TOKEN` | `bench` GitHub sources. Falls back to `gh auth token`. |

Tool-eval model drivers read the key variable set by `apiKeyEnv` in `coding.sh.toml`.

### Output and updates

| Variable | What |
|---|---|
| `NO_COLOR` | No color. Same as `--no-color`. |
| `FORCE_COLOR` | Color even when output is not a terminal. |
| `CI` | Treated as non-interactive: no prompts or spinners. Commands that would ask need `--yes`. |
| `NO_UPDATE_NOTIFIER`, `CODING_SH_NO_UPDATE_CHECK` | Turn off the update check. Same as `update.check = false`. |
| `CODING_SH_READ_BUDGET_MS` | How long `status`, `sessions`, `search` and MCP tool calls ingest pending captures before answering from what is indexed (with a `pending` field in JSON and MCP results). Default `1500`; `--fresh` waits for all. |

### Installer

Read by `curl -fsSL https://coding.sh/install | sh`.

| Variable | What |
|---|---|
| `CODING_SH_YES=1` | Don't ask before running `init`. |
| `CODING_SH_NO_INIT=1` | Install only. |
| `CODING_SH_NO_UI=1` | Don't open the viewer. |
| `CODING_SH_VERSION` | Install this release, e.g. `v0.1.0`. |
| `CODING_SH_TARBALL` | Install this tarball (path or URL) instead. |
| `CODING_SH_SOURCE` | `npm` or `github`. By default the installer uses npm when the registry has the version and the GitHub release tarball otherwise. |

### SDKs

Read by `@coding.sh/sdk` and the Python `coding_sh` package when they send to `coding.sh serve`.

| Variable | What |
|---|---|
| `CODING_SH_URL` | Server URL. |
| `CODING_SH_INGEST_KEY` | Ingest key. |
| `CODING_SH_SERVICE` | Service name; becomes the session's agent id. |
| `CODING_SH_DISABLED` | Send nothing. |
| `CODING_SH_DEBUG` | Log what the SDK does. |

### Where agents keep their files

Adapters look in each agent's default location, or where these point:
`CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `OPENCODE_CONFIG_DIR` and `OPENCODE_DB`
(OpenCode), `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` (Cursor), `GEMINI_CLI_HOME` (Gemini CLI),
`COPILOT_HOME` (Copilot CLI), `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` (Pi),
`GOOSE_PATH_ROOT` (Goose), `T3CODE_HOME` (T3 Code), and `XDG_CONFIG_HOME` / `XDG_DATA_HOME`.
