# Workflow experiments

Capture multi-agent workflow runs, score them against known answers, compare two versions with
paired statistics, and replay with a control fork.

A workflow is a program that runs many agents: it fans out, pipelines, waits at barriers, verifies
and merges. It can be a LangGraph or Mastra app, any program you start as a command, or a Claude
Code workflow script. `coding.sh workflows` captures each run as one tree, scores its output
against a known answer, and compares two versions on the same cases.

## Capture and measure a run

`workflows import` reads Claude Code workflow runs from disk: each run's journal and the transcript
of every agent it started. Runs you start with `workflows run` are captured as they go.

```sh
coding.sh workflows import
coding.sh workflows list --since 7d
coding.sh workflows show <run> --tree
coding.sh workflows stats <run>
```

| Command | What it prints |
|---|---|
| `list` | Runs with status, wall time, cost and agent count. |
| `show` | The run tree with time, cost and status per node. `--gantt` prints the timeline. |
| `stats` | Wall time, the critical path, how many agents ran at once, idle time at barriers, failures, cache hits on a resumed run, and cost per phase. |

An agent you stopped shows as `cancelled`, and one a resume ran again as `superseded`; neither
counts as a failure. `coding.sh ui` shows the same runs at `#/workflows`, one bar per agent grouped
by phase, with the critical path outlined. A bar links to that agent's session.

## Write cases with known answers

A case is one input to the workflow and its known answer. Cases live in
`evals/workflows/<workflow>/cases/*.toml`:

```toml title=evals/workflows/coding-sh-review/cases/seeded-1.toml
id = "seeded-1"
split = "dev"                    # or "heldout"
args = '{"seeded":"seeded-1"}'   # passed to the workflow
threshold = 0.5                  # a score at or above this counts as a pass
[truth]
kind = "seeded-bugs"
file = "hidden/seeded-1.json"    # kept outside the workflow's working tree
[start]
repoRoot = "../../../.."
snapshot = "/tmp/seeded-1"       # the clean tree with the bugs applied
```

The truth file must not sit inside `repoRoot` or `snapshot`, where the agents could read it.

| Truth `kind` | For | Score |
|---|---|---|
| `seeded-bugs` | A review workflow, on a snapshot with planted bugs | F1 of the findings against the bugs. A finding matches when it names the same file and a line within 5 (`--slack`). |
| `verifier` | A fix workflow | 1 when `command` exits 0, or the share of named `[[truth.tests]]` that pass. A `before = "pass"` test that fails after the run is a regression. |
| `judge` | A research or synthesis workflow | An LLM judge's grade on a `rubric`. Marked uncalibrated until `coding.sh judge calibrate` has run for that judge. |

When a planted bug has a `test`, `workflows run` checks it first: the test must fail on the snapshot
and pass with the bug reverted. `coding.sh workflows score <run> --case seeded-1` scores one run by
hand.

## Run two versions

```sh
coding.sh workflows run coding-sh-review --variant base=wf/review.js --variant cand=wf/review-v2.js -k 3 --split dev
```

Attempts alternate between variants, so a slow afternoon hits both alike. It prints the estimated
cost and asks before it spends more than the confirm threshold.

| Flag | Default | What it does |
|---|---|---|
| `--variant` | none | `name=script` for a Claude Code workflow, `name=command` with `--driver command`, or JSON. Repeatable. |
| `--driver` | claude | `command` runs any program: it gets `--args <json>` and prints its output as JSON. |
| `-k` | 3 | Attempts per case and variant. |
| `--split` | all | `dev` or `heldout`. |
| `-j` | 1 | Jobs at once. A workflow already fans out. |
| `--no-validate` | validate | Skips the check of planted bugs. |
| `--resume` | off | Continues an interrupted experiment. Only unfinished runs run. |
| `-y`, `--yes` | off | Runs without asking about the cost. |

## Compare them

```sh
coding.sh workflows compare <experiment> --baseline base --candidate cand
```

Runs pair by case, so each case is compared with itself. The first line is the verdict.

| Verdict | When |
|---|---|
| `candidate better` or `candidate worse` | The bootstrap interval for the score change excludes zero, and McNemar's test on pass or fail agrees. |
| `inconclusive` | Otherwise. |
| `underpowered` | Not significant with fewer than 10 paired cases. |

The report also gives the paired change in cost, wall time and critical path, where cost and time
moved phase by phase, and each variant's P(front): the share of bootstrap draws where no other
variant beats it on both quality and cost. Runs that failed on a rate limit, a server error or the
network are left out, and `--resume` runs them again.

| Flag | Default | What it does |
|---|---|---|
| `--threshold` | the case's, else 0.5 | The score that counts as a pass. |
| `--seed` | random | Fixes the bootstrap, so the same runs give the same report. |
| `--select` | none | Picks a variant to deploy: `min-cost`, `weighted` or `pareto`. |
| `--q-min`, `--q-drop` | `--q-drop 10` | With `min-cost`: the cheapest variant whose quality lower bound clears this floor. |
| `--lambda` | none | With `weighted`: the quality given up per USD. `0` picks the best quality. |

The pick prints as a `deploy:` line. If no variant clears the floor, nothing is picked.

## Replay from a recorded run

Re-running a whole workflow to test an edit to its last stage wastes the earlier stages. A Claude
Code workflow can resume from a recorded run: calls before the first edited one return their
recorded results, and the rest run again.

```sh
coding.sh workflows replay <run> --script wf/review-v2.js --dry-run   # predicted cache hits
coding.sh workflows replay <run> --script wf/review-v2.js
```

The cache follows call order, so an edit to the first stage re-runs everything.

To test an edit this way, add a control fork: a variant that resumes the unedited script from the
same run, so the two differ only in the edit.

```sh
coding.sh workflows run coding-sh-review \
  --variant '{"name":"control","script":"wf/review.js","resumeFromRunId":"<run>"}' \
  --variant '{"name":"cand","script":"wf/review-v2.js","resumeFromRunId":"<run>"}'
coding.sh workflows compare <experiment> --baseline control --candidate cand
```

`workflows compare` then checks each control replay against the run it resumed from. The script is
the same, so any change comes from the replay alone:

```text
replay noise floor: 1 of 8 control replay(s) changed outcome from their source run (13%); differences below that are replay drift
```

A candidate that changes fewer outcomes than that has not shown the edit did anything. Without a
control, the report adds a note that starts with "no control fork".

:::more Forking a command-driver workflow
A command-driver variant can fork when the program supports it. `fromCheckpoint` passes
`--from-checkpoint <id>` (for example a LangGraph checkpoint) and `replayFrom` passes
`--replay-from <node>`; the program decides what they mean.

```sh
coding.sh workflows run graph --driver command \
  --variant '{"name":"control","command":["node","app.mjs"],"fromCheckpoint":"<checkpoint>"}' \
  --variant '{"name":"cand","command":["node","app-v2.mjs"],"fromCheckpoint":"<checkpoint>"}'
```

A replay keeps the upstream outputs fixed, so it understates how much results vary. Replay three or
more recorded runs per case.
:::

## Next steps

- [Experiments](https://coding.sh/docs/experiments): the same paired comparison for a single agent
  or prompt.
- [Judges](https://coding.sh/docs/judges): calibrate the judge a `judge` case uses.
- [workflows reference](https://coding.sh/docs/cli/workflows): every command and flag.
