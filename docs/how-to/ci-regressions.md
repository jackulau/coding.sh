# Catch a regression in CI

The coding.sh GitHub Action installs coding.sh, runs one coding.sh command, writes the report to
the job's step summary and to a comment on the pull request, and fails the job when the command
fails. There are two ways to use it:

- [Run an eval suite](#run-an-eval-suite-on-every-pull-request) on the pull request. A regression
  suite fails the job when a task fails most of its trials.
- [Compare the base branch with the pull request](#compare-the-base-branch-with-the-pull-request)
  on the same cases, and fail the job when the pull request does worse.

## Run an eval suite on every pull request

Make a suite with `coding.sh eval init` (see [Your first eval in 5
minutes](../guides/evals.md#your-first-eval-in-5-minutes)) and commit `evals/<name>/`. Then add
`.github/workflows/evals.yml`:

```yaml
name: evals
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jackulau/coding.sh@main
        with:
          command: eval run triage --yes
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`@main` runs the action from the main branch and installs the coding.sh release named in
`packages/coding.sh/package.json` there. Pin a release tag instead (`@v<version>`) to keep both
fixed. `eval init` prints this workflow for a cases or skill suite, pinned to the release you
have installed. The API key is needed only when the suite calls a model: an LLM judge, a
`--draft`ed grader, or an agent for a skill suite.

`eval run` exits 1 when a regression suite has a task that fails most of its trials or nothing
could be graded. A capability suite never fails on its score, so its report shows up but the job
passes. Leave the suite name out to run every suite under `evals/`.

Repo task suites (from `eval init --sessions`) start from snapshots on the machine that made them,
so they run there, not in CI.

### The report

For `eval run`, the action passes `--summary` and posts the Markdown it writes: one row per suite
with pass@1 and its 95% interval, pass@k, pass^k and the result, then each suite's tasks, cases or
prompts with the first failure of each (a grader's reason, or the session to open with `coding.sh
show`). A failed suite's list is expanded.

```
### Evals: 1 of 1 suite failed

| Suite | Purpose | Size | Trials passed | pass@1 (95% CI) | pass@k | pass^k | Result |
| --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| triage | regression | 4 cases | 6/8 | 75.0% [40.9%, 92.9%] | 75.0% (k=2) | 75.0% (k=2) | **fail**: Button is the wrong color fails most trials |
```

For any other command the report is the last 200 lines of its output in a code block. Both end
with the command, its exit code and a link to the workflow run.

On a pull request the action posts the report as a comment and edits that comment on later
runs, so a pull request has one comment per workflow, job, working directory and command. Posting
needs `pull-requests: write`. Pull requests from forks get a read-only token: the action then
prints a warning and the report is only in the step summary. `comment: false` turns comments off.

To write the same Markdown without the action, pass the step summary file yourself:

```sh
coding.sh eval run triage --yes --summary "$GITHUB_STEP_SUMMARY"
```

`--summary` appends, so several steps can write to the same file.

### Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `command` | `eval run --yes` | The coding.sh arguments to run, split like a shell would. Empty: install coding.sh and stop. |
| `version` | the release that matches the action's ref | The coding.sh release to install, such as `0.1.3` or `latest`. It comes from npm when npm has it, else from the GitHub release. |
| `path` | | Install from a package tarball, directory or URL instead. A relative path is under the workspace. |
| `working-directory` | `.` | Where the command runs. |
| `comment` | `true` | Post the report on the pull request and edit it on later runs. |
| `github-token` | `${{ github.token }}` | The token for the comment. |
| `node-version` | `22` | The Node.js to set up with `actions/setup-node`. Empty uses the runner's (22.15 or newer). |

Outputs: `exit-code` is the command's exit code (0 passed, 1 failed, 2 a usage error), and `report`
is the path of a file holding the report, for a later step to post somewhere else.

The action sets `CODING_SH_HOME` to a directory under `$RUNNER_TEMP` when it is unset, for its
own step and the steps after it, so coding.sh never writes to the runner's home directory. When
`coding.sh --version` already prints the requested release, the action does not install it
again, so a job can use the action twice at little cost. `path` always installs.

## Compare the base branch with the pull request

This runs your agent over a fixed set of cases on the base branch and on the pull request, compares
the two runs case by case, and fails the job when the pull request does worse. It works for any
agent you can call as a command that reads one case on stdin and prints an answer, or as an HTTP
endpoint. The paths below are examples; put the files wherever suits your repo.

### 1. Write the cases

`evals/smoke/cases.jsonl`, one case per line:

```json
{"input":"2+2","expected":"4"}
{"input":"3*3","expected":"9"}
```

`dataset import` also reads JSON arrays and CSV. Start with the cases you care about most, such as
past bugs. A suite of 20 cases can only detect large changes; `exp compare` says so when it runs.

### 2. Write the experiment spec

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

### 3. Try it locally

```sh
export CODING_SH_HOME=$(mktemp -d)        # keep these runs out of your own history
coding.sh dataset import evals/smoke/cases.jsonl --name smoke
coding.sh exp run evals/smoke/experiment.json --name base
# change the agent, then:
coding.sh exp run evals/smoke/experiment.json --name head
coding.sh exp compare base head
```

`exp compare` takes ids or names; a name means the newest experiment with that name.

### 4. Add the workflow

`.github/workflows/agent-evals.yml`:

```yaml
name: agent evals
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Install coding.sh
        uses: jackulau/coding.sh@main
        with:
          command: ""
      - name: Import the cases
        run: coding.sh dataset import evals/smoke/cases.jsonl --name smoke
      - name: Run the base branch
        run: |
          git worktree add ../base "origin/${{ github.base_ref }}"
          cd ../base && coding.sh exp run "$GITHUB_WORKSPACE/evals/smoke/experiment.json" --name base
      - name: Run this pull request
        run: coding.sh exp run evals/smoke/experiment.json --name head
      - name: Compare
        uses: jackulau/coding.sh@main
        with:
          command: exp compare base head --margin 0.05
```

The first use of the action only installs coding.sh; the second runs the comparison, reports it
and sets the job's result. Both runs use the cases from the pull request, so they are paired on
the same dataset version. The base run uses the base branch's code because the command runs in
`../base`. Add your agent's API keys as repository secrets and pass them under `env:`.

### 5. Choose the gate

`exp compare` exits 0 whatever the result unless you give it a gate:

| Fail when | Command |
| --- | --- |
| B is worse than A by more than 5 pass-rate points, with 95% confidence | `exp compare base head --margin 0.05` |
| B does not win enough without breaking what A solved | `exp compare base head --gate` |
| Any case that passed on base fails on the pull request | a `run:` step with `coding.sh exp compare base head --json \| jq -e '.comparison.regressions \| length == 0'` |

`--margin` passes only when the lower bound of the 95% interval of B − A is above −0.05 and an
exact sign-flip test agrees, so a small or noisy suite can fail it with no real change; add cases
or trials until the interval is narrow enough. Below 6 cases (or 6 clusters with `--cluster`) it
always fails. `--gate` is for shipping a change that should help, and holds when the evidence is
weak. The `jq` check is strict and suits small deterministic suites. `exp run` exits 1 only when
every case errored, which usually means the task command is broken.

## Benchmarks on a schedule

For a leaderboard that refreshes daily with fresh cases, `coding.sh bench schedule <name>` prints a
cron line and a GitHub Actions workflow. See `coding.sh bench --help`.
