# Benchmarks in one noun: `coding.sh bench`

Status: design, queued for round 2 (item B-1). The `bench` name now ships dynamic benchmarks
(fresh cases per run, see [guides/benchmarks.md](../guides/benchmarks.md)); the wrapper over
`eval`/`exp`/`compare` described here would need another noun or a `bench` source kind. Replaces the user-facing parts of `eval`, `exp`,
`compare`, `toolevals`, `harness` and `dataset`, which stay available under "Advanced".

## Why

Running a benchmark today needs six commands and seven concepts (task, dataset, bundle, experiment,
arm, variant, driver). The user should only have to think about three:

- **bench**: a named set of tasks plus how they are scored. It lives in one file.
- **run**: one agent setup run against a bench.
- **verdict**: whether B beats A, with the stats done for you.

## Commands

```
coding.sh bench                         # no args: pick or create a bench, run it, print the verdict
coding.sh bench new <name> [source]     # make a bench
coding.sh bench run <name> [setup]      # run one setup
coding.sh bench compare <run> <run>     # verdict for two stored runs
coding.sh bench list | show <name|run>
coding.sh try "<change>" [--bench <name>]   # A/B a change against the current setup, one command
```

Sources for `bench new` (pick one; the default is `--failures 14d`):

| flag | tasks come from |
|---|---|
| `--failures 14d` | your captured sessions that failed or got pushback (repo-replay tasks, validated) |
| `--sessions <ids>` | named sessions |
| `--from <path>` | a folder of tasks, JSONL/CSV cases, Harbor or SWE-bench style |
| `--tool <cmd>` / `--mcp <name>` | agents drive a CLI or MCP server (tool evals) |

Setup for `run` and `try`. Every flag accepts a comma list, and a list makes a matrix automatically:

```
--agent claude-code,codex   --model claude-sonnet-5-5,claude-opus-5-5
--harness <bundle|dir>      --prompt-file AGENTS.md   --mcp off   -k 3
```

`try` takes the change as text and figures out the arms:

```
coding.sh try "add 'run the tests before you finish' to AGENTS.md"
coding.sh try --model claude-opus-5-5          # same harness, other model
coding.sh try --harness ./candidate            # a whole bundle
```

The baseline is always the current setup, snapshotted automatically.

## The file

`bench new` writes `benches/<name>.toml`, and that is the whole definition:

```toml
name = "my-failures"
tasks = "failures:14d"        # or "dir:./tasks", "jsonl:cases.jsonl", "tool:coding.sh"
grade = "verifier"            # verifier | exact | contains | judge:<name> | checklist:<file>
k = 3
budget_usd = 5
agents = ["claude-code"]
```

Editing it is how you iterate. `coding.sh bench run my-failures --watch` reruns only the changed
tasks or arms when the file, the harness or `AGENTS.md` changes. Results are cached by
(task, setup hash, attempt), so a rerun only pays for what changed.

## Output

Human (stderr shows progress; stdout holds only the answer):

```
my-failures · 24 tasks · k=3 · claude-code
  baseline   15/24  62%  $1.84  p95 41s
  candidate  20/24  83%  $1.71  p95 38s
better: +21 pp (95% CI +8 to +33), p=0.004, 0 regressions, cost −7%
```

When the bench is too small to tell, it says so instead of guessing: `not enough data: needs ~60 tasks to see a 10 pp change`.

`--json` prints one document. Exit codes: 0 better or equal, 1 worse or regression (with
`--fail-on regression`), 2 usage error, 130 interrupted. That makes the same command a CI gate.

## Dogfooding: the `coding-sh-cli` bench

The first bench we ship benchmarks our own CLI. It is built with `--tool coding.sh` over a frozen
store of real sessions. Tasks are questions users actually ask, and an agent has to answer each one using only `coding.sh`:

- "what failed in my last session?"
- "slowest tool this week?"
- "turn my last failing session into an eval and run it"
- "did my AGENTS.md change help?"

Metrics: success, turns, wrong commands, `--help` lookups, tokens. Every CLI change runs
`coding.sh try --bench coding-sh-cli` before it lands, so the CLI gets measurably easier to use.
The same bench, pointed at `coding.sh mcp`, scores the MCP server.

## Rules

- No-arg `coding.sh bench` must work on a fresh install with captured sessions: it proposes
  `--failures 14d` and asks once.
- Cost is shown before spending. Above `budget_usd` it asks, or needs `--yes` when not on a TTY.
- Every verdict uses the paired stats already in `src/experiments` and `src/stats`: paired bootstrap,
  McNemar per task, an MDE warning, Holm correction for matrices, and a test-tamper flag.
- The old commands stay working. `bench` calls the same engines, so there is no second implementation.

## CLI contract (humans and agents)

Rauch: "Human-centric interfaces and agent-centric interfaces. You have to have both." The
whole CLI follows the Vercel CLI guidelines (vercel.com/design/cli), and the `coding-sh-cli` bench
measures that it does:

- stdout holds only the result; progress, spinners and hints go to stderr. `--json` prints exactly
  one document. Mutations print the bare id, so `id=$(coding.sh bench new x)` works.
- When stdin is not a TTY, or an agent env (CLAUDECODE, CODEX_*, CI, …) is detected, the CLI
  never prompts. It fails with `reason: "action_required"` plus the exact flag to pass (`--yes`).
- Every error carries `reason`, `next` (the command to run) and `retryable`, in both human and
  `--json` form.
- `coding.sh <cmd> --help --json` describes flags, arguments and examples as data, so agents
  never have to scrape help text.
- Exit codes: 0 ok, 1 failure, 2 usage, 130 interrupted. Unknown flags and commands suggest the
  closest match.
- The MCP server exposes the same verbs, with the same names and the same JSON.
