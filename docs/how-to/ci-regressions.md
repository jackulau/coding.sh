# Catch a regression in CI

Run an eval suite, or the same eval on the base branch and the pull request, with the coding.sh
GitHub Action, and fail the job when it regresses.

The coding.sh GitHub Action installs coding.sh, runs one coding.sh command, writes the report to the
job's step summary and to one comment on the pull request, and fails the job when the command fails.
Use it two ways: run an eval suite on the pull request, or compare the base branch with the pull
request on the same cases.

## Before you start

- A repo on GitHub, and an agent, prompt or tool you can call as a command or an HTTP endpoint.
- Cases to test it on. [Evals](https://coding.sh/docs/evals) shows how to make a suite with
  `coding.sh eval init`.
- The API keys your agent or judge needs, saved as repository secrets.

## Run an eval suite on every pull request

Commit the suite under `evals/<name>/`, then add `.github/workflows/evals.yml`:

```yaml title=.github/workflows/evals.yml
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

`eval init` prints this workflow for a cases or skill suite, pinned to the release you have
installed. `@main` installs the release that the main branch names; pin a tag (`@v<version>`) to
keep both fixed. Leave the suite name out to run every suite under `evals/`.

The key is needed only when the suite calls a model: an LLM judge, or an agent for a skill suite.
Repo task suites (from `eval init --sessions`) start from snapshots on the machine that made them,
so they run there, not in CI.

### Read the result

| Suite | The job fails when |
|---|---|
| Regression | A task fails most of its trials, or nothing could be graded. |
| Capability | Never. Its report still shows the score. |

For `eval run`, the report is a table with one row per suite (pass@1 with its 95% interval, pass@k,
pass^k and the result), then each failing task with its first failure: a grader's reason, or the
session to open with `coding.sh show`. For any other command, the report is the last 200 lines of
its output. To write the same Markdown without the action:

```sh
coding.sh eval run triage --yes --summary "$GITHUB_STEP_SUMMARY"
```

## Compare the base branch with the pull request

This runs your agent over a fixed set of cases on the base branch and on the pull request, and fails
the job when the pull request does worse, case by case.

### 1. Write the cases and the spec

`evals/triage/cases.jsonl`, one case per line:

```json title=evals/triage/cases.jsonl
{"input":"Viewer search misses tool output","expected":"bug, viewer"}
{"input":"Hook drops events when the spool is full","expected":"bug, capture"}
```

```json title=evals/triage/experiment.json
{
  "dataset": "triage",
  "task": { "kind": "command", "command": "node", "args": ["scripts/triage.mjs"] },
  "graders": [{ "kind": "exact" }]
}
```

The command gets the case input as JSON on stdin and prints its answer. For an HTTP agent use
`{"kind":"http","url":"http://127.0.0.1:3000/api/agent","responsePath":"$.output"}`. Add
`"trials": 3` to run each case three times. A suite of 20 cases detects only large changes, and
`exp compare` says so.

### 2. Try it locally

```sh
export CODING_SH_HOME=$(mktemp -d)        # keep these runs out of your own history
coding.sh dataset import evals/triage/cases.jsonl --name triage
coding.sh exp run evals/triage/experiment.json --name base
# change the agent, then:
coding.sh exp run evals/triage/experiment.json --name head
coding.sh exp compare base head
```

What `exp compare` prints, line by line, is in [Experiments](https://coding.sh/docs/experiments).

### 3. Add the workflow

```yaml title=.github/workflows/agent-evals.yml
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
        run: coding.sh dataset import evals/triage/cases.jsonl --name triage
      - name: Run the base branch
        run: |
          git worktree add ../base "origin/${{ github.base_ref }}"
          cd ../base && coding.sh exp run "$GITHUB_WORKSPACE/evals/triage/experiment.json" --name base
      - name: Run this pull request
        run: coding.sh exp run evals/triage/experiment.json --name head
      - name: Compare
        uses: jackulau/coding.sh@main
        with:
          command: exp compare base head --margin 0.05
```

The first use of the action only installs coding.sh; the second runs the comparison, reports it and
sets the job's result. Both runs use the pull request's cases, so they pair on the same dataset
version. Pass your agent's keys under `env:`.

### 4. Choose the gate

`exp compare` exits 0 whatever the result unless you give it a gate:

| Fail when | Command |
|---|---|
| B is worse than A by more than 5 points, with 95% confidence | `exp compare base head --margin 0.05` |
| B does not win enough without breaking what A solved | `exp compare base head --gate` |
| Any case that passed on base fails on the pull request | `coding.sh exp compare base head --json \| jq -e '.comparison.regressions \| length == 0'` in a `run:` step |

`--margin` suits a change that should not hurt; `--gate` suits a change that should help, and holds
when the evidence is weak. The `jq` check is strict and suits small deterministic suites.

## Action inputs

| Input | Default | What it does |
|---|---|---|
| `command` | `eval run --yes` | The coding.sh arguments, split like a shell would. Empty: install coding.sh and stop. |
| `version` | the release matching the action's ref | The release to install, such as `0.1.3` or `latest`. |
| `path` | none | Install from a package tarball, directory or URL instead. |
| `working-directory` | `.` | Where the command runs. |
| `comment` | `true` | Post the report on the pull request, and edit that comment on later runs. |
| `github-token` | `${{ github.token }}` | The token for the comment. |
| `node-version` | `22` | The Node.js to set up. Empty uses the runner's (22.15 or newer). |

Outputs: `exit-code` (0 passed, 1 failed, 2 a usage error) and `report`, the path of a Markdown file
with the report. The action sets `CODING_SH_HOME` under `$RUNNER_TEMP` when it is unset, so coding.sh
never writes to the runner's home.

## If something goes wrong

| Symptom | Check |
|---|---|
| No comment on the pull request | The job needs `pull-requests: write`. Pull requests from forks get a read-only token, so the report is only in the step summary. |
| `--margin` fails with no real change | The suite is small or noisy: add cases or trials. Below 6 cases it always fails. |
| `exp run` exits 1 | Every case errored, which usually means the task command is broken. Run it locally. |
| The base run uses the new code | The base step must run in `../base`, the worktree of the base branch. |

## Next steps

- [Experiments](https://coding.sh/docs/experiments): what each line of `exp compare` means.
- [Compare two agents on your repo](compare-agents.md): run whole agent setups with `compare --gate`.
- [Evals](https://coding.sh/docs/evals): suites, graders and judges.
