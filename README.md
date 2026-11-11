<p align="center">
  <img src=".github/assets/banner.png" alt="coding.sh: see what your AI agents did, and what it cost. Every prompt, tool call, file change and cost, kept on your machine. Below the headline, the top of one session in the coding.sh viewer: a Claude Code session that raised the OTLP receiver body limit to 8 MB, with its model, duration, estimated cost, a '31 passed' test badge and its first file edits." width="100%">
</p>

<p align="center">
  <a href="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml"><img src="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/coding.sh"><img src="https://img.shields.io/npm/v/coding.sh?label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen" alt="Node 22.16 or newer">
</p>

<p align="center">
  <b>coding.sh records what your AI agents do: every prompt, model call, tool call, file change and what it cost.</b><br>
  You read each run in a local viewer and turn the ones that went wrong into evals.<br>
  Your sessions stay on your machine.
</p>

<p align="center">
  <a href="https://coding.sh/docs">Docs</a> ·
  <a href="https://coding.sh/docs/quickstart">Quickstart</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="https://coding.sh/changelog">Changelog</a> ·
  <a href="https://github.com/jackulau/coding.sh/discussions">Discussions</a> ·
  <a href="https://github.com/jackulau/coding.sh/issues/new/choose">Report a bug</a>
</p>

```sh
npx coding.sh                               # try it: finds your agents, asks once, imports past sessions
curl -fsSL https://coding.sh/install | sh   # or install it: same setup, then opens the viewer
```

<p align="center">
  <img src=".github/assets/first-run.gif" alt="A terminal recording. Typing 'npx coding.sh' prints a plan: hooks and the MCP server for Claude Code and Codex CLI, T3 Code imported from its store with no hooks, and the coding.sh hook and config. It asks once, 'Set up coding.sh for 2 agents (4 config files, backed up first) and import past sessions? (Y/n)', the answer is y, and it reports 'Set up Claude Code and Codex CLI (hooks + MCP server)', that recording starts with the next session, and 'Imported 9 past sessions from Claude Code and Codex CLI in 0.2 s'. Then 'npx coding.sh usage --by model' prints a table of sessions, turns, tokens, output tokens, tokens per turn, cache read rate and estimated cost for claude-opus-5-5, claude-sonnet-5 and gpt-6.1-sol. The sessions come from .github/assets/sample-sessions.mjs.">
  <br>
  <sub>A first run of <code>npx coding.sh</code> 0.1.6 in a fresh home.</sub>
</p>

Run `npx coding.sh` again to open the viewer on your sessions.

**What it costs:** nothing. MIT licensed, runs on your machine, no account.

<p align="center">
  <img src=".github/assets/viewer-session.png" alt="The coding.sh viewer on one Claude Code session: the prompt as the title, agent, model, start time, duration, tokens with the cache rate, the estimated cost, latency percentiles, a '14 passed' test badge, Pass and Fail outcome buttons and a copyable 'coding.sh eval new' command. Below, the 16 steps with each model call's estimated cost and a timing bar, and the selected file change to usage.ts shown as a one-line diff." width="100%">
  <br>
  <sub>One Claude Code session in the local viewer (<code>coding.sh ui</code>), with the diff it made and the tests it ran.</sub>
</p>

Each session goes into a SQLite index on your machine, with its latency and tokens. You browse it in
a local viewer, query it from the CLI or from your agents over MCP, turn failures into evals, and
compare changes with paired statistics. No session data leaves your machine unless you add a remote sink.

No runtime dependencies. Node 22.16 or newer.

## Quickstart

1. Run `npx coding.sh`, or the install command above. It runs `coding.sh init`: it finds your
   agents, shows one plan and asks once.
2. Start a new agent session. Agents read their hooks when a session starts, so one that was
   already open may not be recorded.
3. Run `coding.sh` to open the viewer. New sessions show up on their own, with no ingest step, and
   your agents can read them over MCP.

`init` points each agent's hooks at coding.sh, registers the MCP server where the agent supports
it, and backs up every config file it edits. It also imports the sessions your agents already keep
on this machine, so the viewer opens on your own history.

| Command | What it does |
|---|---|
| `coding.sh init --dry-run` | Prints the plan without writing anything. `--diff` adds the edits. |
| `coding.sh init --no-import` | Sets up capture and skips the past-session import. |
| `coding.sh ingest --backfill` | Imports past sessions again, for example after adding an agent. |
| `coding.sh uninstall` | Removes the hooks and MCP entries again. |

<details>
<summary>npm install, the npx cache and other ways to install</summary>

<br>

You can also install with npm: `npm install -g coding.sh`. If you only ran `npx coding.sh`, the
hooks keep recording, but the MCP server runs the copy in the npx cache, so install it before you
clear that cache. Installing from source, updates and uninstall:
[docs/guides/install.md](docs/guides/install.md).

</details>

## What you get

| Area | What it does | Start with |
|---|---|---|
| **Record** | Captures each session, including subagents, from hooks and transcripts. Wraps any other agent. Takes OpenTelemetry from frameworks and apps. | `coding.sh init`, `coding.sh run -- <cmd>`, `coding.sh collector` |
| **Measure** | Turns, tool calls, model calls, tokens, latency and outcome for every session. Flags sessions that edited code and never ran a check. | `coding.sh sessions`, `coding.sh usage`, `coding.sh improve` |
| **Evaluate** | Turns a failed session into a replayable eval. Runs experiments with code graders or calibrated LLM judges. A/B tests prompts, harness files and models with paired statistics. | `coding.sh eval new`, `coding.sh exp compare` |
| **Benchmark** | Draws new cases every day, runs every contender on the same frozen set, and writes a static report. | `coding.sh bench` |
| **Production** | One server for ingest, the viewer and the API, backed by SQLite, Postgres or ClickHouse. SDKs for API apps. | `coding.sh serve` |

<p align="center">
  <img src=".github/assets/viewer-sessions.png" alt="The coding.sh session list: 13 sessions from Claude Code, Codex and a bot that labels coding.sh issues and sends OpenTelemetry traces, with agent, model, tool count, cost (~ where it is estimated from list prices), duration and start time. Two rows show a green 'passed' test badge and one has a failed tool call. Above the list, a histogram of sessions over time marks one flagged session in amber; filters on the left narrow by agent, model, repository, flag and tool." width="100%">
</p>

### Read your sessions

```sh
coding.sh sessions             # recent sessions
coding.sh show latest          # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"  # full-text search over prompts, replies and tool calls
coding.sh usage --by model     # tokens, turns and cache hits
coding.sh stats --by agent     # sessions, failures, cost and latency per agent, with a daily trend
coding.sh diff-calls latest#-1 # what changed since the previous model call, and why the cache missed
coding.sh ui                   # the local viewer
```

Every command takes `--json`. `coding.sh mcp` gives your agents the same data as MCP tools.
More in [docs/guides/explore.md](docs/guides/explore.md).

<details>
<summary><b>Record</b>: wrappers, OpenTelemetry and the model API proxy</summary>

<br>

- `coding.sh run -- <cmd>` wraps any other agent and snapshots the repo before and after.
- `coding.sh collector` takes OpenTelemetry from agent frameworks and apps.
- `coding.sh init --proxy` routes Claude Code and Codex through a local API proxy that logs each
  model call's system prompt, tools, messages and cache use. More in
  [docs/how-to/capture-with-proxy.md](docs/how-to/capture-with-proxy.md).

</details>

<details>
<summary><b>Evaluate</b>: evals, experiments and paired statistics</summary>

<br>

Turn a failed session into a replayable eval with `coding.sh eval new`, and check that its
verifier is fair with `coding.sh eval validate`. Run experiments over versioned datasets with code
graders or calibrated LLM judges. `coding.sh exp compare` and `coding.sh compare` A/B prompts,
harness files and models with paired statistics. `coding.sh exp replay` resends one logged model
call with another model or system prompt. Tool evals and multi-agent workflow runs are covered
too. More in [docs/guides/evals.md](docs/guides/evals.md).

</details>

<details>
<summary><b>Benchmark</b>: daily cases and head-to-head reports</summary>

<br>

`coding.sh bench` draws new cases every day from a script, your failed sessions, GitHub issues or
a sitemap. Every contender gets the same frozen set in random order, and `bench report` writes a
static page with the trend, today's head to head and where each one fails. More in
[docs/guides/benchmarks.md](docs/guides/benchmarks.md).

</details>

<details>
<summary><b>Production</b>: server, SDKs and LLM gateways</summary>

<br>

`coding.sh serve` runs ingest, the viewer and the API on one port, backed by SQLite, Postgres or
ClickHouse. Your API apps send traces with the TypeScript SDK (`@codingdotsh/sdk`), the Python SDK
(`coding-sh`) or plain OpenTelemetry. `coding.sh gateway` links calls made through LLM gateways
(Vercel AI Gateway, OpenRouter, LiteLLM, Cloudflare, Portkey, Helicone) to their billed cost. The
TypeScript SDK and the store plugins are on npm, and the Python SDK is on PyPI. Start with
[docs/production/README.md](docs/production/README.md).

</details>

## Supported agents

| Agent | How it records | Status |
|---|---|---|
| Claude Code | hooks, transcript, subagents | Verified on real sessions |
| Codex CLI | hooks, rollout files, subagents | Verified on real sessions |
| Antigravity CLI (formerly Gemini CLI) | hooks, transcript | Verified on real sessions |
| OpenCode | plugin, session database | Verified on a real install |
| Cursor CLI | hooks, transcript | Not run live |
| GitHub Copilot CLI | hooks, session state | Verified on a real install |
| Factory Droid | hooks, transcript | Verified on a real install |
| Goose | plugin hooks, session database | Verified on a real install |
| Pi | extension, transcript | Verified on a real install |
| Amp | plugin | Not run live |
| T3 Code | its local store | Verified on a real install |
| Aider | `coding.sh run -- aider …` | Verified on a real install |
| Any other command | `coding.sh run -- <cmd>` | Tested |
| Your own agent or app (Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, LangGraph and more) | OpenTelemetry into `coding.sh collector`, or the TypeScript and Python SDKs | Tested |

<details>
<summary>What the statuses mean</summary>

<br>

- **Verified on real sessions.** Checked against sessions captured from a live install of the
  agent during development, in addition to the CI tests.
- **Verified on a real install.** The agent's current release was installed and run through a
  session against a local stub model, its hooks fired and the recorded session was checked, and
  the captured payloads are now CI fixtures. For OpenCode, Pi, Goose, Factory Droid, GitHub
  Copilot CLI and Aider, CI repeats that run on Linux and Windows on every change.
- **Not run live.** CI checks the adapter against the agent's documented formats, but nobody has
  run it against a live install yet. Cursor CLI and Amp are in that state because both need an
  account login.
- **Tested.** Covered by CI tests. There is no third-party agent to check against.

</details>

If you use an agent marked "Not run live", a short
[agent support report](https://github.com/jackulau/coding.sh/issues/new?template=agent-support.yml)
saying whether it works moves it to "Verified". Per-agent details, including which agents get the
MCP server, are in [docs/guides/agents.md](docs/guides/agents.md). T3 Code and Pi each have a
section on [Record coding agents](https://coding.sh/docs/agents).

## Privacy

With no sinks configured, no session data leaves your machine. The only default network request is
a daily update check, which `CODING_SH_NO_UPDATE_CHECK=1` turns off. Secrets are redacted at
ingest, before anything is written to the index, blobs or sinks. Remote sinks send metadata only
unless you opt in to full content.

<details>
<summary>What the hook writes to the spool</summary>

<br>

The hook first writes the agent's payload unredacted to `~/.coding.sh/spool` (mode 600). Ingest
redacts the payloads kept in `spool/<agent>/raw/` in place. A payload written inside its spool
line stays unredacted until `coding.sh gc` deletes the file after 7 days. Details in
[docs/guides/privacy.md](docs/guides/privacy.md).

</details>

## Status

coding.sh is pre-1.0 (latest: 0.1.6), so expect rough edges. What isn't done yet:

- **Windows.** CI runs on Linux, macOS and Windows. On Windows, CI runs the test suite, the installer (from
  Git Bash) and real OpenCode, Pi, Goose, Factory Droid, GitHub Copilot CLI and Aider sessions
  against a stub model. Capture from Claude Code, Codex CLI, Antigravity CLI, Cursor CLI, Amp and
  T3 Code has not been checked on Windows yet.
- **Not run live.** Two adapters, Cursor CLI and Amp, have not been run on a live install yet. Both need an account
  login (see [Supported agents](#supported-agents)).

Changes are listed in [CHANGELOG.md](CHANGELOG.md) and on the
[releases page](https://github.com/jackulau/coding.sh/releases).

## Getting help

| For | Go to |
|---|---|
| Questions and ideas | [Discussions](https://github.com/jackulau/coding.sh/discussions) |
| Bugs | [Open an issue](https://github.com/jackulau/coding.sh/issues/new/choose). The bug form asks for the output of `coding.sh doctor`, which answers most first questions. |
| A new agent, or a report on one not run live yet | The [agent support form](https://github.com/jackulau/coding.sh/issues/new?template=agent-support.yml) |
| Security issues | Report them privately through [SECURITY.md](SECURITY.md), not as an issue |

## Docs

- [coding.sh/docs](https://coding.sh/docs): quickstart, agents, CLI, MCP, evals, OpenTelemetry,
  storage and the trace format.
- [docs/](docs/README.md): the same guides in Markdown, plus production, design specs and
  research.
- [docs/troubleshooting.md](docs/troubleshooting.md): what to check when sessions don't show up.

## Repository layout

| Path | What it holds |
|---|---|
| [`packages/coding.sh`](packages/coding.sh) | The CLI, hook, adapters, OTLP receiver, viewer, MCP server and evals |
| [`packages/sdk`](packages/sdk), [`packages/sdk-python`](packages/sdk-python) | The TypeScript and Python SDKs for API apps |
| [`packages/store-postgres`](packages/store-postgres), [`packages/store-clickhouse`](packages/store-clickhouse), [`packages/blob-s3`](packages/blob-s3) | Store plugins |
| [`apps/site`](apps/site) | The coding.sh website (Astro, static) |
| [`docs`](docs/README.md) | Guides, production, reference and design docs |
| [`examples`](examples) | An eve agent, production apps, a plugin A/B and a skill eval |
| [`deploy`](deploy) | Deploy recipes for Compose, Fly, Railway and ClickHouse (Render uses `render.yaml`) |
| [`evals`](evals) | coding.sh's own CLI eval suite |
| [`scripts/dogfood`](scripts/dogfood) | The scorecard coding.sh runs on itself |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the codebase map. Issues labeled
[good first issue](https://github.com/jackulau/coding.sh/labels/good%20first%20issue) are small and
self-contained. Release steps are in [docs/RELEASE.md](docs/RELEASE.md).

## Star history

<a href="https://star-history.com/#jackulau/coding.sh&Date"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=jackulau/coding.sh&type=Date&theme=dark" /><source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=jackulau/coding.sh&type=Date" /><img alt="Star history for jackulau/coding.sh" src="https://api.star-history.com/svg?repos=jackulau/coding.sh&type=Date" /></picture></a>

## License

[MIT](LICENSE)
