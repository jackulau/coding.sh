# Catch a regression in CI

On every pull request, run your agent over a fixed set of cases on the base branch and on the PR,
compare the two runs case by case, and fail the job when a case that passed now fails.

This works for any agent you can call as a command that reads one case on stdin and prints an
answer, or as an HTTP endpoint. The paths below are examples inside a checkout of coding.sh; put
the files wherever suits your repo.

## 1. Write the cases

`evals/smoke/cases.jsonl`, one case per line:

```json
{"input":"2+2","expected":"4"}
{"input":"3*3","expected":"9"}
```

`dataset import` also reads JSON arrays and CSV. Start with the cases you care about most, such as
past bugs. A suite of 20 cases can only detect large changes; `exp compare` says so when it runs.

## 2. Write the experiment spec

`evals/smoke/experiment.json`:

```json
{
  "dataset": "smoke",
  "task": { "kind": "command", "command": "node", "args": ["scripts/agent.mjs"] },
  "graders": [{ "kind": "exact" }]
}
```

The command gets the case input as JSON on stdin and prints its answer. For an HTTP agent use
`{"kind":"http","url":"http://127.0.0.1:3000/api/agent","responsePath":"$.output"}`. Add
`"trials": 3` to run each case three times. See [Evals](https://coding.sh/docs/evals) for every
grader.

## 3. Try it locally

```sh
export CODING_SH_HOME=$(mktemp -d)        # keep these runs out of your own history
coding.sh dataset import evals/smoke/cases.jsonl --name smoke
coding.sh exp run evals/smoke/experiment.json --name base
# change the agent, then:
coding.sh exp run evals/smoke/experiment.json --name head
coding.sh exp compare base head
```

`exp compare` takes ids or names; a name means the newest experiment with that name.

## 4. Add the workflow

`.github/workflows/agent-evals.yml`:

```yaml
name: agent evals
on: pull_request

jobs:
  evals:
    runs-on: ubuntu-latest
    env:
      CODING_SH_HOME: ${{ runner.temp }}/coding.sh
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install coding.sh
        run: curl -fsSL https://coding.sh/install | CODING_SH_YES=1 CODING_SH_NO_INIT=1 CODING_SH_NO_UI=1 sh
      - name: Import the cases
        run: coding.sh dataset import evals/smoke/cases.jsonl --name smoke
      - name: Run the base branch
        run: |
          git worktree add ../base "origin/${{ github.base_ref }}"
          cd ../base && coding.sh exp run "$GITHUB_WORKSPACE/evals/smoke/experiment.json" --name base
      - name: Run this pull request
        run: coding.sh exp run evals/smoke/experiment.json --name head
      - name: Compare
        run: |
          coding.sh exp compare base head
          coding.sh exp compare base head --json > compare.json
          jq -e '.comparison.regressions | length == 0' compare.json
```

Both runs use the cases from the PR, so they are paired on the same dataset version. The base run
uses the base branch's code because the command runs in `../base`. Add your agent's API keys as
repository secrets and pass them under `env:`.

## 5. Choose the gate

`exp compare --json` prints `{"comparison": {...}}`. Pick the rule that fits:

| Fail when | Check |
|---|---|
| Any case that passed on base fails on the PR | `jq -e '.comparison.regressions \| length == 0'` |
| The pass rate is worse with 95% confidence | `jq -e '.comparison.verdict != "worse"'` |
| The pass rate dropped at all | `jq -e '.comparison.b.passRate >= .comparison.a.passRate'` |

The first is strict and suits small deterministic suites. The second ignores noise but needs more
cases or trials before it can say `worse`.

`exp compare` itself exits 0 whatever the result; the gate is the `jq -e` step. `exp run` exits 1
only when every case errored, which usually means the task command is broken.

## Benchmarks on a schedule

For a leaderboard that refreshes daily with fresh cases, `coding.sh bench schedule <name>` prints a
cron line and a GitHub Actions workflow. See `coding.sh bench --help`.
