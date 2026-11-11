<p align="center">
  <img src="https://raw.githubusercontent.com/jackulau/coding.sh/main/.github/assets/banner.png" alt="coding.sh: see what your AI agents did, and what it cost. Every prompt, tool call, file change and cost, kept on your machine. Below the headline, the top of one Claude Code session in the coding.sh viewer, with its model, duration, estimated cost, a '31 passed' test badge and its first file edits." width="100%">
</p>

<p align="center">
  <a href="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml"><img src="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/coding.sh"><img src="https://img.shields.io/npm/v/coding.sh?label=npm" alt="npm version"></a>
  <a href="https://github.com/jackulau/coding.sh/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen" alt="Node 22.16 or newer">
</p>

<p align="center">
  <a href="https://coding.sh/docs">Docs</a> ·
  <a href="https://coding.sh/docs/quickstart">Quickstart</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#agents">Agents</a> ·
  <a href="https://github.com/jackulau/coding.sh">Source</a>
</p>

# coding.sh

coding.sh records what your AI agents do: every prompt, model call, tool call, file change and what it cost.
It keeps them in a SQLite index on your machine. You browse it in a local viewer, query it from
the CLI or from your agents over MCP, turn failures into evals, and compare changes with paired
statistics. Zero runtime dependencies. Node 22.16 or newer.

## Quickstart

```sh
npx coding.sh      # try it: finds your agents, shows one plan, asks once (Y/n)
```

Run `npx coding.sh` again to open the viewer. To keep it, install it globally:

```sh
npm install -g coding.sh
coding.sh init     # finds your agents, shows one plan, asks once (Y/n)
coding.sh          # opens the viewer
```

`init` points each detected agent's hooks at `~/.coding.sh/bin/hook.sh` (`hook.mjs` on Windows)
and registers the coding.sh MCP server with Claude Code, Codex, Cursor, OpenCode and Gemini CLI.
Every config file it edits is backed up first. After that, use your agents as usual. New sessions
appear without an ingest step.

| Command | What it does |
|---|---|
| `coding.sh init --dry-run` | Shows the plan (agents, files, blockers) without writing anything. `--diff` adds the exact edits. |
| `coding.sh uninstall` | Restores the agent configs. Captured data in `~/.coding.sh` is kept. |
| `coding.sh update` | Installs the latest release. |

<details>
<summary>npx only, and the update check</summary>

<br>

With `npx` only, the hook is copied to a stable path, but the MCP entry points at the npx cache,
so a global install is the sturdier choice for daily use.

Commands print one dim line when a newer release is out (checked in the background, at most once a
day). Turn the check off with `NO_UPDATE_NOTIFIER=1`, `CODING_SH_NO_UPDATE_CHECK=1` or
`[update] check = false` in `~/.coding.sh/config.toml`.

</details>

## Agents

| Status | Agents |
|---|---|
| Verified on real sessions | Claude Code, Codex CLI (approve the hooks once with `/hooks`), Antigravity CLI (formerly Gemini CLI) |
| Verified on a real install (current release against a local stub model) | OpenCode, GitHub Copilot CLI, Factory Droid, Goose, Pi, T3 Code, Aider |
| Not run live (both need an account login) | Cursor CLI, Amp |
| Any other command | `coding.sh run -- <cmd>` takes shadow-git snapshots before and after |

Agent frameworks and apps can also send OpenTelemetry to `coding.sh collector`. The per-agent
table is in [docs/guides/agents.md](https://github.com/jackulau/coding.sh/blob/main/docs/guides/agents.md).

## Any agent over OpenTelemetry

```sh
coding.sh collector     # OTLP/HTTP on 127.0.0.1:4318; prints the OTEL_* env to export
```

It accepts traces and logs as protobuf or JSON and understands OTel GenAI semantic conventions,
OpenInference, Vercel AI SDK spans and Claude Code, Codex and Gemini CLI log events.

## Commands

| Group | Commands |
|---|---|
| Capture | `init`, `doctor`, `status`, `statusline`, `ingest [--backfill]`, `run -- <cmd>`, `collector`, `proxy`, `serve`, `uninstall` |
| Explore | `sessions`, `show <id\|latest>`, `tree`, `replay`, `attribution`, `blame`, `diff-calls`, `search <text>`, `usage`, `cache doctor`, `stats`, `sql`, `export`, `ui`, `mcp` |
| Evaluate | `eval new\|validate\|list\|export`, `dataset`, `exp run\|compare\|replay`, `score`, `judge`, `toolevals`, `workflows`, `bench new\|run\|history\|report\|schedule` |
| Harness | `improve`, `harness snapshot\|list`, `compare A B`, `refine` |
| Maintain | `gateway`, `gc`, `purge`, `config`, `update`, `upgrade-store`, `version` |

Every command takes `--json` and `--help`. The full reference is in [docs/reference/cli.md](https://github.com/jackulau/coding.sh/blob/main/docs/reference/cli.md).

## Privacy

With no sinks configured, no session data is sent anywhere. The only default network request is
the daily update check, which can be turned off. Secrets are redacted at ingest, before anything
reaches the index, blobs or sinks. `[capture] mode = "metadata"` keeps structure and numbers only.
Remote sinks (`otlp`, `http`) send metadata only unless you set `mode = "full"`. The hook writes
raw payloads to `~/.coding.sh/spool` (mode 600). Ingest redacts the ones in `spool/<agent>/raw/` in
place, and `coding.sh gc` deletes ingested spool files after 7 days.

## Uninstall

```sh
coding.sh uninstall --yes   # restores agent configs; captured data in ~/.coding.sh is kept
npm uninstall -g coding.sh
```

## Library

`coding.sh/schema` exports the trace schema constants: `SCHEMA_ID`, `SCHEMA_VERSION`, `EVENT_KINDS`,
`KNOWN_AGENTS` and `isEventKind()`, with TypeScript types for `AgentEvent` and `Session`.
`coding.sh/schema.json` is the same format as a JSON Schema (draft 2020-12), also served at
[coding.sh/schema.json](https://coding.sh/schema.json).

Docs: [coding.sh/docs](https://coding.sh/docs). Source, the agent matrix and the privacy details:
[github.com/jackulau/coding.sh](https://github.com/jackulau/coding.sh). MIT licensed.
