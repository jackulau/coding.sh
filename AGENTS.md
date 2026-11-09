# AGENTS.md

Instructions for coding agents working on coding.sh: local-first observability and evals for AI
agents. Humans: start with [CONTRIBUTING.md](CONTRIBUTING.md); this file is the short version plus
the repo's routines.

## Layout

- `packages/coding.sh`: the CLI, hook, viewer, MCP server and evals. Most work happens here.
- `packages/sdk`, `packages/sdk-python`: the TypeScript and Python SDKs.
- `packages/store-postgres`, `packages/store-clickhouse`, `packages/blob-s3`: store plugins.
- `apps/site`: the website (Astro). `docs/`: the docs, indexed in `docs/README.md`.
- `scripts/e2e`: real agent captures against a stub model. `scripts/dogfood`, `scripts/perf`:
  benchmarks and budgets. `scripts/release/smoke.sh`: the pre-publish smoke test.

Inside `packages/coding.sh/src`: `schema/index.ts` and `core/types.ts` are the contracts,
`adapters/` holds one adapter per agent (registered in `adapters/index.ts`), `core/sessions.ts`
builds sessions and their flags, `cli/registry.ts` holds every command, flag and help text, and
`spool/hook.ts` is the hook agents run.

## Commands

Node 22.15 or newer. Run these from `packages/coding.sh`:

```sh
npm run check                                        # typecheck + every test
npx tsc --noEmit -p .                                # typecheck only
node --no-warnings --test 'test/**/*.test.ts'        # every test
node --no-warnings --test test/core/waste.test.ts    # one file
npm run build                                        # dist/cli.mjs, dist/hook.mjs, dist/schema.mjs
node --no-warnings src/cli/main.ts --help            # the CLI from source, no build
```

There is no build step for development and no formatter; match the style of the file you edit.

The CLI from source (`src/cli/main.ts`, or a `dist/` built in the repo) won't open the default
`~/.coding.sh`: set `CODING_SH_HOME=$(mktemp -d)` for each run. A newer build migrates the index
one way and strands the user's installed coding.sh. `CODING_SH_DEV_REAL_STORE=1` opts in; never
set it for the user's store unless they ask.

## Code rules

- **Zero runtime dependencies** in `packages/coding.sh`. Use `node:` built-ins.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter
  properties. Import local files with their `.ts` extension.
- **The hook never breaks an agent.** `src/spool/hook.ts` exits 0, prints nothing unless the
  agent's protocol needs a reply, does no network or git work, and stays well under 50 ms.
- **Redact before writing.** Anything that stores or sends event content goes through
  `src/core/redact.ts` first.
- **Session stats are additive.** New fields on `Session.stats` are optional and absent when
  there is nothing to report. A flag with a colon (`gateway:vercel`, `skill:pdf`) is a tag, not a
  failure.
- When an adapter parses a source differently, bump its `parseVersion` so stored sessions are
  parsed again. When the stats, flags or titles derived from the same stored events change, bump
  `SESSION_FOLD_VERSION` in `src/core/sessions.ts` so stored sessions are folded again.

## Tests and fixtures

- Tests use `node:test` and `node:assert/strict`, under `packages/coding.sh/test`, mirroring `src`.
- **Never touch real agent configs or real sessions.** Point `HOME`, `CODING_SH_HOME` and the
  agent's own home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) at temp dirs; `tmpEnv()` in
  `test/adapters/_helpers.ts` does this. Never write Codex hook trust hashes.
- **Fixtures come from real runs, never from a personal `~/.claude` or `~/.codex`.** Record them
  with the scripts in `scripts/e2e` (for example `scripts/e2e/claude-transcript-capture.mjs`, a
  pinned Claude Code against `scripts/e2e/stub-model.mjs`) under a throwaway home, with paths
  scrubbed to `/work/demo` and `/home/user`. They live in `test/fixtures/adapters/<agent>/`.
- Adapter goldens: `UPDATE_GOLDEN=1` rewrites them. Read the diff before you commit it.
- Timing tests assume an idle machine. If one fails under load, rerun it alone first.

## Docs and changelog

- Docs claim only what the code does, in plain prose: short sentences, no marketing words.
- A new or changed command or flag: update `src/cli/registry.ts`, then regenerate the CLI
  reference with `node --no-warnings packages/coding.sh/scripts/cli-reference.ts` (from the repo
  root). `test/docs/cli-reference.test.ts` fails when it is stale.
- `docs/reference/sdk.md` and the SDK gateway tables are generated too, by
  `packages/coding.sh/scripts/sdk-reference.ts` and `packages/coding.sh/scripts/sdk-gateways.ts`.
- New stats or flags: `docs/reference/api.md` and `docs/concepts.md`. Adapter behavior:
  `docs/ADAPTERS.md`.
- Every user-visible change gets one line in `CHANGELOG.md` under the unreleased version's
  `### Added`, `### Changed` or `### Fixed`: a bold area (`**Sessions.**`, `**Cost.**`,
  `**Capture.**`, …), what changed in a sentence or two, and a link to the docs.

## Routines

**Before a commit.** Run `npm run check` in `packages/coding.sh` (and `npm run build && npm run
check` in `apps/site` if you touched the site). If you touched `.github/workflows`, run
`actionlint -shellcheck= .github/workflows/*.yml`. Scan the diff and any new fixture for secrets,
tokens, emails and home paths.

**Commit.** One change per commit, with a conventional message: `feat(core): …`, `fix(viewer): …`,
`test(otel): …`, `docs: …`, `perf: …`, `ci: …`. The subject says what the user gets, in plain words.
No co-author or tool footers.

**Review.** Read the whole diff as a reviewer would: does every doc line match the code, does
every new stat stay absent when empty, does the change hold on real fixtures as well as synthetic
ones, and is there a test that fails without it.

**Pull request.** One change per PR, with tests. `npm run check` and `npm run build` must pass in
`packages/coding.sh`; CI also runs Node 22 and 24 on Linux, macOS and Windows, and the real agent
captures in `scripts/e2e/real-capture.mjs`.

**Adding an agent.** Follow "Adding an agent" in CONTRIBUTING.md: a row in `docs/ADAPTERS.md`, the
`Adapter` interface from `src/core/types.ts`, fixtures with goldens, install and uninstall tested
against a temp `HOME` (uninstall leaves other files byte-for-byte identical), and say in the PR
whether `coding.sh doctor` passed on a live install.

**Release.** Follow `docs/RELEASE.md`. Run `scripts/release/smoke.sh` from the repo root after
`npm ci`; pushing a tag `vX.Y.Z` that matches `packages/coding.sh/package.json` runs
`.github/workflows/release.yml`.

**Measuring ease.** `npm run build` in `packages/coding.sh`, then `node scripts/e2e/ease.mjs
[--json] [--real]` from the repo root. It times setup by a person (steps, prompts, time to the first
session, empty states that name the next step) and checks setup by an agent that follows agents.md.
Rerun it when you change install, init, doctor, an empty state or agents.md; results and caveats
are in `docs/ease.md`.

**Measuring performance.** CLI budgets: `npm run build` in `packages/coding.sh`, then
`node scripts/dogfood/bench.mjs [hook|ingest|store|help|viewer]` from the repo root, with
`--baseline <dist dir>` for a paired A/B against another build. Site: `node scripts/perf/ab.mjs
--base <dir> --cand <dir>`, with site results in `docs/perf.md`. Report a speedup only with its
confidence interval.
