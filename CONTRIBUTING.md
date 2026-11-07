# Contributing to coding.sh

Thanks for helping. Bug reports, adapter verification reports ("agent X works on a live install")
and pull requests are all welcome. Coding agents working on the repo: read [AGENTS.md](AGENTS.md).

## Setup

Node 22.15 or newer.

```sh
git clone https://github.com/jackulau/coding.sh && cd coding.sh
npm install
cd packages/coding.sh
npm run check     # typecheck + tests
npm run build     # dist/cli.mjs, dist/hook.mjs, dist/schema.mjs
node dist/cli.mjs --help
```

Website: `cd apps/site && npm run dev` (then `npm run build && npm run check` before a PR).

## Layout

The CLI lives in `packages/coding.sh`. It is TypeScript run directly by Node's type stripping, so
there is no compile step for development.

| Path | What |
|---|---|
| `src/core/types.ts`, `src/schema/index.ts` | the contracts: events, sessions, adapters, stores |
| `src/spool/hook.ts` | the hook agents run (hot path: no network, no git, always exits 0) |
| `src/adapters/` | one adapter per agent: detect, install, uninstall, normalize, backfill, run |
| `src/core/ingest.ts`, `src/core/redact.ts` | spool to index, with redaction before any write |
| `src/otel/` | the OTLP/HTTP receiver |
| `src/viewer/`, `src/mcp/` | the local viewer and the MCP server |
| `src/eval/`, `src/datasets/`, `src/graders/`, `src/judge/`, `src/experiments/` | evals and experiments |
| `src/cli/registry.ts` | every command, flag and help text |

Docs index: [docs/README.md](docs/README.md). Start with [docs/design/architecture.md](docs/design/architecture.md),
[docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/TOOL-EVALS.md](docs/TOOL-EVALS.md) and
[docs/design/workflows.md](docs/design/workflows.md).

## Rules

- **Zero runtime dependencies** in `packages/coding.sh`. Use `node:` built-ins. Store drivers and
  other heavy pieces go in plugin packages.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter
  properties. Import local files with their `.ts` extension.
- **Tests never touch your real agent configs.** Point `HOME` and `CODING_SH_HOME` at temp dirs.
  Never write Codex hook trust hashes; users approve hooks themselves.
- **The hook must never break an agent.** It exits 0, prints nothing unless the agent's protocol
  requires a reply, and stays well under 50 ms.
- **Redact before writing.** Anything that persists or sends event content goes through the
  redactor first. Remote sinks default to metadata only.
- **Docs claim only what the code does.** If you add or change a command, update its help in
  `src/cli/registry.ts`, the README and `CHANGELOG.md`.

## Adding an agent

1. Read the agent's hook, plugin or OpenTelemetry docs and add a row to `docs/ADAPTERS.md`.
2. Implement the `Adapter` interface (`src/core/types.ts`) in `src/adapters/` (or
   `src/adapters/more/`), and register it in `src/adapters/index.ts`.
3. Add fixtures under `test/fixtures/adapters/<agent>/`: spool lines plus golden normalized events.
   Use payloads recorded from a real session where you can, with secrets and personal data removed.
4. Test install and uninstall against a temp `HOME`. Uninstall must leave untouched files
   byte-for-byte identical.
5. Run `coding.sh doctor` against a live install and say in the PR whether you verified it live.

## Pull requests

- Keep each PR to one change, and include tests.
- `npm run check` and `npm run build` must pass in `packages/coding.sh`. CI also builds and checks
  the site on Node 22 and 24, on Linux and macOS.
- Timing tests (hook latency, help startup) assume an idle machine. If one fails on a loaded
  machine, rerun it alone before you treat it as a regression.

By contributing you agree that your contributions are licensed under the MIT license.
