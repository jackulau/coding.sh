# coding.sh

Local-first observability and evals for any AI agent. Coding agents are first-class.

coding.sh records what your agents do (prompts, tool calls, file changes, model calls, latency and
token usage) into a SQLite index on your machine. You browse it in a local viewer, query it from
the CLI or from your agents over MCP, turn failures into evals, and compare prompt, harness and
model changes with paired statistics. MIT licensed, zero runtime dependencies, Node 22.15+.

It covers the same ground as LangSmith, Braintrust or Judgment Labs, but runs locally: capture,
storage and the viewer stay on your machine unless you add a remote sink.

Status: 0.1.0, the first public release. Expect rough edges and say so in an issue.

## Quickstart

Once `coding.sh` is on npm:

```sh
npm install -g coding.sh   # or run any command with npx coding.sh
coding.sh init             # finds your agents, shows one plan, asks once (Y/n)
coding.sh                  # opens the viewer
```

Or use the installer (Node 22.15+ required). It installs the latest GitHub release, runs `init`,
then opens the viewer:

```sh
curl -fsSL https://coding.sh/install | sh
```

`init` points each detected agent's hooks at `~/.coding.sh/bin/hook.mjs` and registers the
coding.sh MCP server with the agents that support MCP. Every edited config file is backed up to
`~/.coding.sh/backups` first. Use `coding.sh init --dry-run` to see the exact changes without
writing anything. After that, use your agents as usual. Sessions show up in the viewer, in
`coding.sh sessions` and over MCP. You never need an ingest step, because read commands, the
viewer and the MCP server pick up new events on their own.

`npx coding.sh init` also works. The hook is copied to a stable path, but the MCP entry points at
the npx cache copy of the CLI. Install globally if you want the MCP server to survive
`npm cache clean`.

### From source (before the npm release)

```sh
git clone https://github.com/jackulau/coding.sh && cd coding.sh
npm install && npm run build -w coding.sh
npm install -g ./packages/coding.sh   # puts `coding.sh` on PATH (a symlink to this checkout)
coding.sh init
coding.sh
```

Or skip the global install and run `node packages/coding.sh/dist/cli.mjs <command>` directly.

### Updates

Commands print one dim line on stderr when a newer release is out. The check runs in the
background at most once a day, and commands never wait on it. `coding.sh update` installs the new
release. The check is off when `CI` is set, or with `NO_UPDATE_NOTIFIER=1`,
`CODING_SH_NO_UPDATE_CHECK=1` or `[update] check = false` in `~/.coding.sh/config.toml`.

## Supported agents

| Agent | Capture | History import | MCP registered by `init` | Status |
|---|---|---|---|---|
| Claude Code | hooks + transcript, subagents | yes | yes | Verified on real sessions |
| Codex CLI | hooks + rollout files, subagents | yes | yes | Verified on real sessions. Codex runs new hooks only after you approve them once with `/hooks`. |
| Antigravity CLI (`agy`) | hooks + transcript | yes | no | Verified on real sessions |
| OpenCode 2.x | plugin + session database | yes | yes | Fixture-tested |
| Cursor CLI | hooks + transcript | yes | yes | Fixture-tested. In `-p` mode Cursor does not fire `stop` or `beforeSubmitPrompt`. |
| Gemini CLI | hooks + chat files, subagents | yes | yes | Fixture-tested |
| GitHub Copilot CLI | hooks + session state | yes | no | Fixture-tested |
| Factory Droid | hooks + transcript | yes | no | Fixture-tested |
| Goose | plugin hooks + session database | yes | no | Fixture-tested |
| Pi | extension + transcript | yes | no | Fixture-tested |
| Amp | plugin | no | no | Fixture-tested |
| T3 Code | reads its local store on every ingest | yes | no | Fixture-tested |
| Aider | wrapper (`coding.sh run -- aider …`); eval runs parse its token and cost lines | no | no | Fixture-tested |
| Anything else | `coding.sh run -- <cmd>`: shadow-git snapshots before and after | no | no | Tested |
| Any OpenTelemetry exporter | `coding.sh collector` (OTLP/HTTP) | no | n/a | Tested |

What the statuses mean:

- **Verified on real sessions**: checked against sessions captured from a live install of the
  agent during development, in addition to the CI tests.
- **Fixture-tested**: CI tests the adapter against hook payloads, transcripts or session stores
  that follow the agent's documented format, plus its install and uninstall. It has not yet been
  checked against a live install of that agent. Reports are welcome.
- **Tested**: covered by CI tests; there is no third-party agent to verify against.

Import past sessions with `coding.sh ingest --backfill [--since 30d]`. Check your setup with
`coding.sh doctor`. See [docs/ADAPTERS.md](docs/ADAPTERS.md) for each agent's hook config, payload
ids and known breakage.

## Any agent over OpenTelemetry

`coding.sh collector` starts an OTLP/HTTP receiver on `127.0.0.1:4318` and prints the environment
that points an exporter at it:

```sh
coding.sh collector
# export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
# export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# export OTEL_TRACES_EXPORTER=otlp
# export OTEL_LOGS_EXPORTER=otlp
# export CLAUDE_CODE_ENABLE_TELEMETRY=1
```

It accepts `POST /v1/traces` and `/v1/logs` as protobuf or JSON. `/v1/metrics` is accepted and
ignored. It understands OTel GenAI semantic conventions, OpenInference, Vercel AI SDK spans and the
Claude Code, Codex and Gemini CLI log events. Every model call becomes an `llm.call` event with
model, token usage, duration and time to first token. Point any SDK at the base URL, or set a
signal-specific endpoint such as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`.

## Explore

```sh
coding.sh sessions                 # recent sessions (--agent, --repo, --since, --subagents)
coding.sh show latest              # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"      # full-text search over prompts, replies and tool calls
coding.sh usage --by model         # tokens, turns and cache hits by agent, model, day or repo
coding.sh ui                       # local viewer on 127.0.0.1 (token-protected URL)
```

Every command takes `--json`.

**MCP.** `coding.sh mcp` serves your captured data to agents over stdio, with the tools
`sessions_list`, `session_get`, `session_current`, `search`, `failures`, `latency`, `usage`,
`subagents`, `eval_from_session`, `experiments_list`, `experiment_compare` and `status`.
`coding.sh init` registers it with Claude Code, Codex, Cursor, OpenCode and Gemini CLI
(`--no-mcp` skips this). `coding.sh mcp config` prints the snippet for any other client.

## Evals

- **Session to eval.** `coding.sh eval new <session> --verifier "<cmd>"` drafts a replayable task
  that starts from the repo snapshot taken before the agent ran. `coding.sh eval validate <task>`
  checks that the verifier is fair: a do-nothing attempt fails, the reference fix passes k of k,
  near-misses fail, an impossible variant fails, and no future history leaks. `eval export
  --format harbor` writes a Harbor-format task.
- **Datasets and experiments.** `coding.sh dataset add|import` keeps versioned cases with stable
  train/dev/test splits. `coding.sh exp run` runs a command or HTTP task over a dataset with
  deterministic graders (exact, contains, regex, numeric, similarity, JSON schema, JSON path),
  command graders or LLM judges. `coding.sh exp compare A B` reports the paired
  bootstrap CI of the difference, an exact McNemar test on flipped cases and the minimum detectable
  effect.
- **Judges.** `coding.sh judge calibrate` measures judge and human agreement (Cohen's kappa) on a
  held-out split. Uncalibrated judges are flagged in every report.
- **Harness A/B.** `coding.sh harness snapshot` bundles an agent's harness files (CLAUDE.md,
  AGENTS.md, skills, hooks, MCP config). `coding.sh compare A B` runs both bundles on eval tasks in
  isolated config directories, with per-arm Wilson intervals and the first step where the traces
  diverge.
- **Tool evals.** `coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API:
  surface size, schema checks, per-task tool-call metrics in a sandbox, variant comparisons and
  MCP description compression. See [docs/TOOL-EVALS.md](docs/TOOL-EVALS.md).
- **Workflows.** `coding.sh workflows` imports multi-agent workflow runs and reports the run tree,
  critical path, concurrency, cost and paired variant comparisons. See
  [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

Eval runs that drive a real agent or an LLM judge call that agent or provider, with your
credentials and at your cost.

## Storage and sinks

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

Store URLs are pluggable: `sqlite://` and `file://` are built in. Other schemes load a plugin
package named `coding.sh-store-<scheme>` (this repo has `coding.sh-store-postgres` and
`coding.sh-store-s3`, which are not published yet).

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
  version. Turn it off as described under [Updates](#updates).
- **What is captured** (full mode, the default): prompts, assistant replies, tool calls with
  inputs and outputs, file changes, errors, subagent links, model names, token usage, latency and
  a snapshot of the working tree before and after a session.
- **Redaction** runs at ingest, before anything is written to the index, blobs or sinks. Built-in
  rules catch private keys, vendor API keys and tokens (Anthropic, OpenAI, GitHub, GitLab, Slack,
  AWS, Google, Stripe, npm and more), JWTs, bearer and basic auth, and values next to secret-looking
  names. Add `redact = ["secrets", "env"]` to also replace the literal values of secret-looking
  environment variables, and `redactPatterns` for your own regexes.
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

## Uninstall

```sh
coding.sh uninstall --dry-run   # show what would change
coding.sh uninstall --yes       # remove hooks and MCP entries from every agent
npm uninstall -g coding.sh
rm -rf ~/.coding.sh             # optional: delete captured data
```

`uninstall` restores each agent config file byte-for-byte if nothing else has edited it since
`init`. Otherwise it removes only the coding.sh entries.

## Repository

| Path | What |
|---|---|
| `packages/coding.sh` | the CLI, hook, adapters, OTLP receiver, viewer, MCP server and evals (published to npm) |
| `packages/sdk`, `packages/sdk-python` | client SDKs (not published yet) |
| `packages/store-postgres`, `packages/blob-s3` | store plugins (not published yet) |
| `apps/site` | the coding.sh website (Astro, static) |
| `docs/` | architecture, adapters, tool evals, workflows, release |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).
Release steps are in [docs/RELEASE.md](docs/RELEASE.md).

## License

[MIT](LICENSE)
