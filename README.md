<p align="center">
  <img src=".github/assets/banner.png" alt="coding.sh: every agent run, recorded and measurable. Local-first observability and evals for any AI agent." width="100%">
</p>

<p align="center">
  <a href="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml"><img src="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.15-brightgreen" alt="Node 22.15 or newer">
</p>

<p align="center">
  Local-first observability and evals for any AI agent. Coding agents come first.<br>
  <a href="https://coding.sh/docs/">Docs</a> ·
  <a href="https://coding.sh/docs/quickstart/">Quickstart</a> ·
  <a href="https://coding.sh/changelog/">Changelog</a>
</p>

coding.sh records what your agents do: prompts, tool calls, file changes, model calls, latency and
tokens. It all goes into a SQLite index on your machine. You browse it in a local viewer, query it
from the CLI or from your agents over MCP, turn failures into evals, and compare changes with
paired statistics. It does the job of LangSmith or Braintrust, and capture, storage and the viewer
stay on your machine unless you add a remote sink. For API apps in production, the same tools run as
one server on SQLite or Postgres (see [Production](#what-you-get) below).

MIT licensed, zero runtime dependencies, Node 22.15 or newer. Version 0.1.0 is the first public
release, so expect rough edges and tell us about them in an issue.

## Install

```sh
curl -fsSL https://coding.sh/install | sh
```

The installer downloads the latest GitHub release, runs `coding.sh init`, then opens the viewer.
`init` finds your agents, shows one plan and asks once. It points their hooks at coding.sh,
registers the MCP server where the agent supports it, and backs up every config file it edits.
Run `coding.sh init --dry-run` to see the changes without writing anything.

Then use your agents as usual. Sessions show up on their own, with no ingest step.

npm, from source, updates and uninstall: [docs/guides/install.md](docs/guides/install.md).

## What you get

**Record.** Hooks and transcripts capture each session, including subagents.
`coding.sh run -- <cmd>` wraps any other agent and snapshots the repo before and after.
`coding.sh collector` takes OpenTelemetry from agent frameworks and apps. Past sessions import
with `coding.sh ingest --backfill`.

**Measure.** Every session has its turns, tool calls, model calls, tokens, latency and outcome.

```sh
coding.sh sessions             # recent sessions
coding.sh show latest          # timeline with turns, tools, subagents and latency
coding.sh search "rate limit"  # full-text search over prompts, replies and tool calls
coding.sh usage --by model     # tokens, turns and cache hits
coding.sh ui                   # the local viewer
```

Every command takes `--json`. `coding.sh mcp` gives your agents the same data as MCP tools.
More in [docs/guides/explore.md](docs/guides/explore.md).

**Compare.** Turn a failed session into a replayable eval with `coding.sh eval new`, and check
that its verifier is fair with `coding.sh eval validate`. Run experiments over versioned datasets
with code graders or calibrated LLM judges. `coding.sh exp compare` and `coding.sh compare` A/B
prompts, harness files and models with paired statistics. Tool evals and multi-agent workflow
runs are covered too. More in [docs/guides/evals.md](docs/guides/evals.md).

**Production.** `coding.sh serve` runs ingest, the viewer and the API on one port, backed by
SQLite or Postgres. Your API apps send traces with the TypeScript SDK (`@coding.sh/sdk`), the
Python SDK (`coding-sh`) or plain OpenTelemetry. `coding.sh gateway` links Vercel AI Gateway
calls to their billed cost. The SDKs and store plugins are not published yet. Start with
[docs/production/README.md](docs/production/README.md).

## Supported agents

| Agent | How it records | Status |
|---|---|---|
| Claude Code | hooks, transcript, subagents | Verified on real sessions |
| Codex CLI | hooks, rollout files, subagents | Verified on real sessions |
| Antigravity CLI (formerly Gemini CLI) | hooks, transcript | Verified on real sessions |
| OpenCode | plugin, session database | Fixture-tested |
| Cursor CLI | hooks, transcript | Fixture-tested |
| GitHub Copilot CLI | hooks, session state | Fixture-tested |
| Factory Droid | hooks, transcript | Fixture-tested |
| Goose | plugin hooks, session database | Fixture-tested |
| Pi | extension, transcript | Fixture-tested |
| Amp | plugin | Fixture-tested |
| T3 Code | its local store | Fixture-tested |
| Aider | `coding.sh run -- aider …` | Fixture-tested |
| Any other command | `coding.sh run -- <cmd>` | Tested |

Fixture-tested means CI checks the adapter against the agent's documented formats, but nobody has
run it against a live install yet. Reports are welcome. Per-agent details, including which agents
get the MCP server, are in [docs/guides/agents.md](docs/guides/agents.md).

## Privacy

With no sinks configured, no session data leaves your machine. The only default network request is
a daily update check, which you can turn off. Secrets are redacted at ingest, before anything is
written. Remote sinks send metadata only unless you opt in to full content. Details in
[docs/guides/privacy.md](docs/guides/privacy.md).

## Docs

- [coding.sh/docs](https://coding.sh/docs/): quickstart, agents, CLI, MCP, evals, OpenTelemetry,
  storage and the trace format.
- [docs/](docs/README.md): the same guides in Markdown, plus production, design specs and
  research.

## Repository layout

```
packages/
  coding.sh/        the CLI, hook, adapters, OTLP receiver, viewer, MCP server and evals (npm)
  sdk/              TypeScript SDK for API apps
  sdk-python/       Python SDK
  store-postgres/   Postgres store plugin
  blob-s3/          S3 blob store plugin
apps/site/          coding.sh website (Astro, static)
docs/               guides, production, reference and design docs
examples/           an eve agent and production app examples
deploy/             deploy recipes for Compose, Fly and Railway (Render uses render.yaml)
evals/              coding.sh's own CLI eval suite
scripts/dogfood/    the scorecard coding.sh runs on itself
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through [SECURITY.md](SECURITY.md).
Release steps are in [docs/RELEASE.md](docs/RELEASE.md).

## License

[MIT](LICENSE)
