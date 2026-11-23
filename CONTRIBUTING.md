# Contributing to coding.sh

Thanks for helping. Bug reports, adapter verification reports ("agent X works on a live install")
and pull requests are all welcome. Coding agents working on the repo: read [AGENTS.md](AGENTS.md).

<p>
  <a href="#setup">Setup</a> ·
  <a href="#layout">Layout</a> ·
  <a href="#rules">Rules</a> ·
  <a href="#lint-and-git-hooks">Lint and git hooks</a> ·
  <a href="#adding-an-agent">Adding an agent</a> ·
  <a href="#pull-requests">Pull requests</a>
</p>

## Setup

Node 22.18 or newer: the tests and the CLI from source run `.ts` files directly. The published CLI
runs on Node 22.16 or newer.

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

The tests launch the CLI from source. After `npm run build`, set
`CODING_SH_TEST_CLI="$PWD/dist/cli.mjs"` and they launch the built CLI, which starts faster. Build
again after you change `src`. AGENTS.md "Commands" has the details.

Property and model tests live in `test/verify`. `test/_prop.ts` makes seeded cases and shrinks a
failure to a small one. `test/_model.ts` checks every state a model of the code can reach within its
bounds, and prints a shortest trace to a broken invariant. Both run the same cases every time. A
failing property prints the seed that replays it (`CODING_SH_PROP_SEED=<seed>`).
`CODING_SH_PROP_SEED=random` tries new cases, `CODING_SH_PROP_RUNS=1000` runs more of them, and
`CODING_SH_MODEL_BOUND=1` raises each model's bounds by one.

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
  `src/cli/registry.ts`, the README and `CHANGELOG.md`. Add the changelog line with
  `node scripts/changelog/add.mjs --section <S> --area <A> --text <T> --link <docs path[#id]>`:
  it refuses a line over 60 words, a character the site font has outside its CORE subset (the page
  would load a -rest font file for it), a duplicate, and a link to a missing doc or heading.
  `--check` runs the same checks over the unreleased lines, and `npm run changelog:test` runs its
  tests; `npm run gate` runs both.

## Lint and git hooks

`npm run lint` (from the repo root) runs `scripts/lint/slop.mjs`, a zero-dependency check for
patterns that read as unreviewed agent output. Exit 0 means clean, 1 means findings, 2 means a
usage error.

<details>
<summary>Rules, the allowlist and the opt-in git hooks</summary>

<br>

| Rule | Flags |
| --- | --- |
| `chained-as` | `x as unknown as T` and `(x as A) as B`: a cast that skips the type checker |
| `unknown-param` | a parameter typed `unknown` that the function casts with `as` and never checks. Type guards, functions named for the check (`is*`, `parse*`, `validate*`, ...) and functions that check the value (`typeof`, `instanceof`, `Array.isArray`, `in`, a null check, or passing it to another function) are trust boundaries and pass |
| `conditional-empty-spread` | `...(c ? { a } : {})` and `...(c && { a })`. Assign the field in an `if` instead |
| `barrel-file` | a module that only re-exports other modules |
| `site-placeholder` | visible "planned", "coming soon", "sample data", a bare "Sample" label, TODO or lorem ipsum on the site: text and visible attributes in `apps/site/src`, and the repo docs and changelog the site renders. Code, comments, `alt` text and `<code>` are not read |

It reads every file git does not ignore, and skips `node_modules`, `dist`, `fixtures` and hidden
folders other than `.github`. `--json` prints one document, `--rule <id>` runs one rule, `--staged` reads the staged version of
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
- **pre-push** checks the pushed commits' author addresses and that no private agent file is
  tracked, runs the lint on the files the push changes, then the same typecheck as pre-commit for
  each package the push touches. It runs no tests: CI runs them on the pull request, and
  `npm run gate` runs them on your machine. The lint and the typecheck read your working tree, so
  uncommitted edits are checked too. It prints a line when it takes more than 9 seconds.

When a commit or push touches more than one package, their typechecks run at the same time, and a
hook prints the output of the ones that fail.

Skip a hook once with `--no-verify`, or set `CODING_SH_SKIP_HOOKS=1`.
`node scripts/hooks/run.mjs pre-commit --dry-run` prints what a hook would run. The lint and hook
tests run with `npm run lint:test`.

</details>

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
- `npm run gate` from the repo root must pass: it runs lint, actionlint, the generated files, the
  checks and the build, and the site, in a throwaway home. Its first step checks that your
  branch's commits are authored with your global git identity (`git config --global user.email`)
  and that the repo sets no `user.email` of its own.
- `npm run check` and `npm run build` must pass in `packages/coding.sh`. On a pull request CI
  runs the quick jobs: the tests on Linux (Node 24), the build and the site, the gate, the store
  plugins, the Python SDK, the packed CLI on the Node floor, the release smoke test and the
  GitHub Action. The Linux Node 24 tests launch the built CLI (`CODING_SH_TEST_CLI`, "Setup"
  above); the Node 22 and Windows tests of the full suite launch it from source. A pull request that only changes docs or the site skips the ones that never
  read them (`scripts/ci-changes.mjs`). Windows, Node 22, the real agent captures, the container
  image and cli-suite run in the full suite, below. CI does not run macOS: run `npm run check` on
  a Mac for a change that depends on it.
- Without the `ready` label the Linux tests run the test files the diff can reach
  (`packages/coding.sh/scripts/test-select.ts`). A changed test file runs, with the test files that
  import it. A changed helper under `test/` runs the test files that import it or write its file
  name. A change under `docs/`, `apps/site/`, a root `*.md`, the issue and pull request templates,
  or one of the other packages runs the test files that name that directory, package or file.
  Every other path runs every test file: the CLI source, `scripts/`, `skills/`, a workflow, a
  manifest, a lockfile, a compiler config, a fixture, a golden, a deleted or renamed file, a new
  file at the top of the repository, and a path no rule knows. So does any error in the selection.
  Each test leg prints what it selected and the rule and paths behind it, or that it runs every
  test file and why. `node scripts/test-select.ts origin/main` in `packages/coding.sh` prints the
  same for your branch. The full suite and a push to `main` never select. A new rule needs a
  measurement first: make the paths unreadable, run every test file, and list the ones that fail
  or lose tests. Pin that list in `test/scripts/test-select.test.ts`.
- `main` takes pull requests only, and each one runs the full suite first. A maintainer adds the
  `ready` label; CI then runs every job on the pull request merged with `main`, skips none for a
  docs or site change, and checks the commit authors as it does on `main`. That run reports one
  check named `full suite`, which passes only when every other job passed. `main` requires that
  check on a branch that is up to date with `main`, so a push or an update of the branch after the
  label runs it again. Without the label there is no check of that name and the pull request cannot
  merge. The full suite includes Site perf (`.github/workflows/site-perf.yml`, the Lighthouse A/B
  and the byte, request and layout-shift budgets) on GitHub's runners. Without the label a pull
  request gets Site perf only when it touches the site's measured paths. The timing budgets were
  set on the desk and are checked there after the merge, when the push to `main` touches those
  paths.
- The push to `main` that a merge makes does not run the full suite again: the merge commit
  holds the files the check passed on. It runs the quick jobs, with every test file and no job
  skipped, and the real agent captures, whose Windows job saves the caches the next pull
  request's Windows jobs restore. A manual run of the workflow runs every job but Site perf.
- Timing tests (hook latency, help startup) assume an idle machine. If one fails on a loaded
  machine, rerun it alone before you treat it as a regression.
- The viewer UI tests drive headless Chrome and skip when none is installed. In CI a missing
  Chrome is a failure: each test job starts Chrome once before its tests
  (`packages/coding.sh/scripts/warm-chrome.ts`), because a fresh runner's first start can take
  longer than the 20 s a test gives it. That first start has 60 s; past it the job fails. The
  first start prints what it did, fast or slow: Chrome's stderr, when the first byte came on
  stderr and on stdout, and on Linux how long the machine stalled meanwhile (from
  `/proc/pressure`). The
  same step loads the viewer's list and Explore once, at the size the tests give a page, because
  the first viewer page on a runner does work no later page does (it reads Chrome's number and
  date data from disk, for one) and can take longer than the 5 s a test gives a page. A page
  load that runs out of time says how long `Page.navigate` took, how long the page took to
  answer, and the state it was in. A start that fails stops Chrome and removes its profile.
  On Windows, a test home that moves `USERPROFILE` needs an `AppData\Local` folder in it:
  without one Chrome refuses remote debugging ("requires a non-default data directory"), and
  the tests fail at once and say so. `npm run gate` makes the folder.

By contributing you agree that your contributions are licensed under the MIT license.
