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

Run from the checkout (`node src/cli/main.ts` or `node dist/cli.mjs`), coding.sh won't open your
real `~/.coding.sh`: a newer build would migrate the index, and your installed coding.sh could not
open it again. Give it a throwaway home with `export CODING_SH_HOME=$(mktemp -d)`, or set
`CODING_SH_DEV_REAL_STORE=1` to use the real one. `npm link` counts as an install.

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

## Lint and git hooks

`npm run lint` (from the repo root) runs `scripts/lint/slop.mjs`, a zero-dependency check for
patterns that read as unreviewed agent output:

| Rule | Flags |
| --- | --- |
| `chained-as` | `x as unknown as T` and `(x as A) as B`: a cast that skips the type checker |
| `unknown-param` | a parameter typed `unknown` that the function casts with `as` and never checks. Type guards, functions named for the check (`is*`, `parse*`, `validate*`, ...) and functions that check the value (`typeof`, `instanceof`, `Array.isArray`, `in`, a null check, or passing it to another function) are trust boundaries and pass |
| `conditional-empty-spread` | `...(c ? { a } : {})` and `...(c && { a })`. Assign the field in an `if` instead |
| `barrel-file` | a module that only re-exports other modules |
| `site-placeholder` | visible "planned", "coming soon", "sample data", a bare "Sample" label, TODO or lorem ipsum on the site: text and visible attributes in `apps/site/src`, and the repo docs and changelog the site renders. Code, comments, `alt` text and `<code>` are not read |

It reads every file git does not ignore, and skips `node_modules`, `dist`, `fixtures` and hidden
folders other than `.github`. Exit 0 means clean, 1 means findings, 2 means a usage error.
`--json` prints one document, `--rule <id>` runs one rule, `--staged` reads the staged version of
staged files, and `--help --json` lists flags and rules as data.

Code that existed when the lint landed is listed in `scripts/lint/allowlist.json`. Each entry names
a rule, a file (or glob), a reason, and usually a `max`: the number of findings that file may
keep. A file that goes over its `max` fails, so new code can't add more. When you fix some, run
`node scripts/lint/slop.mjs --update-allowlist` to lower the counts. It also adds an entry for any
file with findings and no entry, so read its diff and never commit a raised count for new code.
For a one-off exception, put `slop-allow <rule>: <reason>` in a comment on the line or the line
above.

The git hooks are opt in. `npm run hooks:install` points this checkout's `core.hooksPath` at
`scripts/hooks`. It refuses to replace another hooks path, or to hide hooks in `.git/hooks`,
unless you pass `--force`; `node scripts/hooks/install.mjs --status` and `--uninstall` check and
undo it.

- **pre-commit** runs the lint on staged files, then the `typecheck` script (the site's
  `astro check`) of each package the commit touches.
- **pre-push** runs the `test` script of each package the pushed commits touch and of the
  packages that depend on it (a `packages/coding.sh` change also runs the store plugins' tests),
  the Python SDK's tests, and the lint, hook and dogfood script tests when those change.

Skip a hook once with `--no-verify`, or set `CODING_SH_SKIP_HOOKS=1`.
`node scripts/hooks/run.mjs pre-commit --dry-run` prints what a hook would run. The lint and hook
tests run with `npm run lint:test`.

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
