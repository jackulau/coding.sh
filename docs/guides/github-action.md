# GitHub Action

The coding.sh action runs your agent over a fixed set of cases on a pull request and on its base
branch, compares the two runs case by case, writes the result to the job summary, and fails the
job when a case that passed on the base branch now fails.

It does the same thing as the manual workflow in [Catch a regression in CI](../how-to/ci-regressions.md),
in one step.

## Quick start

You need three files in your repo: the cases, an experiment spec, and an agent command.

`evals/smoke/cases.jsonl`, one case per line:

```json
{"input":"2+2","expected":"4"}
{"input":"3*3","expected":"9"}
```

`evals/smoke/experiment.json`:

```json
{
  "dataset": "smoke",
  "task": { "kind": "command", "command": "node", "args": ["scripts/agent.mjs"] },
  "graders": [{ "kind": "exact" }]
}
```

The command gets each case's input as JSON on stdin and prints its answer. For an HTTP agent use
`{"kind":"http","url":"http://127.0.0.1:3000/api/agent","responsePath":"$.output"}`. See
[Evals](evals.md) for every grader.

`.github/workflows/agent-evals.yml`:

```yaml
name: agent evals
on: pull_request

permissions:
  contents: read
  pull-requests: write   # only for comment: true

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jackulau/coding.sh@v0.1.1
        with:
          experiment: evals/smoke/experiment.json
          cases: evals/smoke/cases.jsonl
          comment: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # whatever your agent needs
```

Pin the action to a release tag or a commit SHA. The action ships from v0.1.1 on.

## What it does

1. Sets up Node.js if the runner's is older than coding.sh needs, and installs the coding.sh
   release tarball from GitHub (`version: latest` by default).
2. Imports the cases as the dataset the spec names, in a throwaway `CODING_SH_HOME`.
3. Checks out the base branch in a separate worktree and runs the experiment there. Both runs use
   the cases and spec from the pull request, so they are paired on the same dataset version; the
   base run uses the base branch's agent code.
4. Runs the experiment on the pull request, then `coding.sh exp compare base head`.
5. Writes a summary table to the job summary, optionally comments on the pull request (one
   comment, updated on each push), and fails the step if the gate trips.

The summary shows the pass rate of each side with its 95% Wilson interval, the pass-rate change
with its 95% paired bootstrap interval, the verdict (`better`, `worse` or `inconclusive`), the
McNemar p-value, and each case that regressed with the grader's reason.

On the first pull request that adds the evals, the base branch has nothing to run, so the action
warns and reports the pull request alone.

## Inputs

| Input | Default | What |
|---|---|---|
| `experiment` | required | Experiment spec JSON, relative to `working-directory` |
| `cases` | required | Cases file (JSONL, JSON array or CSV), relative to `working-directory` |
| `dataset` | spec's `dataset` | Dataset name to import the cases as |
| `baseline-ref` | the PR's base branch | Git ref for the baseline run; `none` skips it |
| `working-directory` | `.` | Where the agent command runs, in both checkouts |
| `trials` | spec | Attempts per case |
| `concurrency` | `4` | Parallel case runs |
| `gate` | `regressions` | `regressions`, `worse` or `pass-rate` (below) |
| `min-pass-rate` | none | Also fail when this run's pass rate is below this fraction, e.g. `0.9` |
| `fail-on-regression` | `true` | Fail the step when the gate trips |
| `comment` | `false` | Comment on the pull request; needs `pull-requests: write` |
| `github-token` | `github.token` | Token for the release lookup and the comment |
| `version` | `latest` | coding.sh release to install, e.g. `v0.1.0` |
| `source` | `release` | `local` runs coding.sh from the action's own checkout (for testing coding.sh itself) |
| `node-version` | `22` | Node.js version to set up when the runner's is too old |

## Gates

| `gate` | Fails when |
|---|---|
| `regressions` | Any case that passed on the base branch fails on the pull request |
| `worse` | The pass rate is worse with 95% confidence |
| `pass-rate` | The pass rate dropped at all |

`regressions` is strict and suits small deterministic suites. `worse` ignores noise but needs more
cases or trials before it can say `worse`; the summary prints the minimum detectable effect so you
can tell whether the suite is big enough. Set `fail-on-regression: false` to report without
failing.

## Outputs

`verdict`, `pass-rate`, `baseline-pass-rate`, `delta`, `ci-low`, `ci-high` (rates on a 0 to 1
scale), `regressions` (count), `regressed` (`true` when a gate tripped), `report` (path to the
markdown report) and `home` (the `CODING_SH_HOME` with both runs). To keep the runs:

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coding.sh-runs
          path: ${{ steps.evals.outputs.home }}
```

## Notes

- Pull requests from forks get a read-only token, so the comment is skipped with a warning; the job
  summary still has the result. Secrets are not passed to fork pull requests either, so agents that
  need API keys only run on branches in your repo.
- The action runs your agent on the runner. Keep it on GitHub-hosted runners for pull requests
  from people you don't know.
- `exp run` fails the step when every case errors, which usually means the task command is broken.
