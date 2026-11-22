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

`<run>` is a run id as `list` prints it, or a unique prefix of 4 or more characters, `wf_` or
`wfr_` included. `show`, `stats`, `score` and `replay` take either. A prefix that several runs
share fails and lists them.

`show` also prints what the run returned, as the workflow store keeps it, redacted: its first 6
lines on an `Output` row, then how many lines are left. `--json` prints all of it as `run.output`.
A run that returned nothing, or one imported while `capture.mode` is `metadata`, keeps none: it
has no `Output` row, and `run.output` is null.

An agent you stopped shows as `cancelled`, and one a resume ran again as `superseded`; neither
counts as a failure. On a resumed run, an agent that returned its recorded result is a cache hit,
not one of the agents that ran: `stats` counts it on the `cache hits` row, and its failed and null
shares are of the agents that ran.

`coding.sh ui` shows the same runs at `#/workflows`, one bar per agent grouped by phase, with the
critical path outlined. A bar links to that agent's session.

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
file = "/tmp/review-truth/seeded-1.json"   # outside repoRoot and snapshot
[start]
repoRoot = "../../../.."         # the repo root
snapshot = "/tmp/seeded-1"       # the clean tree with the bugs applied
```

Relative paths start from the case file's folder, so `../../../..` is the repo root. The truth file
must not sit inside `repoRoot` or `snapshot`, where the agents could read it, so here it is outside
the repo.

The same holds for each bug's `patch`: a case whose patch is inside either tree is refused,
with a folder to move it to. A `patch` already stored as a 64-character blob ref is not a file and is
not checked. The truth file lists the planted bugs:

```json title=/tmp/review-truth/seeded-1.json
{"bugs": [
  {"id": "b1", "file": "src/a.ts", "lines": [10, 12], "test": "node check.mjs", "patch": "b1.patch"},
  {"id": "b2", "file": "src/b.ts", "lines": [40, 40]}
]}
```

A case file can also list the bugs itself, as `[[truth.bugs]]` tables. Then the case file must not
sit inside `repoRoot` or `snapshot` either, so keep it in a folder outside both and pass that folder
with `--cases`.

| Truth `kind` | For | Score |
|---|---|---|
| `seeded-bugs` | A review workflow, on a snapshot with planted bugs | F1 of the findings against the bugs. A finding matches when it names the same file and a line within 5 (`--slack`). |
| `verifier` | A fix workflow | 1 when `command` exits 0, or the share of named `[[truth.tests]]` that pass. A `before = "pass"` test that fails after the run is a regression. |
| `judge` | A research or synthesis workflow | An LLM judge's grade on a `rubric`. Marked uncalibrated until `coding.sh judge calibrate` has run for that judge. |

When a planted bug has a `test` and the `patch` that planted it (a path relative to the file that
lists the bug), `workflows run` checks it first: the test must fail on the snapshot and pass with
the patch reverted. `coding.sh workflows score <run> --case seeded-1` scores one run by hand.

## Run two versions

```sh
coding.sh workflows run coding-sh-review --variant base=wf/review.js --variant cand=wf/review-v2.js -k 3 --split dev
```

Attempts alternate between variants, so a slow afternoon hits both alike. It estimates the cost from
past runs of the workflow and asks before it spends more than the confirm threshold ($1, set with
`CODING_SH_CONFIRM_ABOVE_USD`). With no past runs to estimate from, it asks too.

| Flag | Default | What it does |
|---|---|---|
| `--variant` | none | `name=script` for a Claude Code workflow, `name=command` with `--driver command`, or JSON, inline or in a `.json` file. JSON sets `name`, `script` or `command`, and optionally `args`, `resumeFromRunId`, `fromCheckpoint` and `replayFrom`. Any other field is ignored with a warning. Repeatable. |
| `--driver` | claude | `command` runs any program: it gets `--args <json>` and prints its output as JSON. |
| `-k` | 3 | Attempts per case and variant. |
| `--split` | all | `dev` or `heldout`. |
| `-j` | 1 | Jobs at once. A workflow already fans out. |
| `--no-validate` | validate | Skips the check of planted bugs. |
| `--resume` | off | Continues an interrupted experiment. Only unfinished runs run. |
| `-y`, `--yes` | off | Runs without asking about the cost. |

A run that fails keeps why: `timed out`, the last three lines the workflow printed to stderr, or
`exit <code>` when it printed none, redacted with your capture settings. A command that does not
exist shows its spawn error, such as `spawn wf-app ENOENT`. `workflows run` prints the reason for
each failed run, and `workflows show <run>` prints it on an `Error` row.

## Compare them

```sh
coding.sh workflows compare <experiment> --baseline base --candidate cand
```

Runs pair by case, so each case is compared with itself. The first line is the verdict.

| Verdict | When |
|---|---|
| `candidate better` or `candidate worse` | The bootstrap interval for the score change excludes zero, and McNemar's test on pass or fail agrees. |
| `no significant difference` | Neither test finds a change. |
| `inconclusive` | One test finds a change and the other does not, or no scored case ran in both variants. |

`underpowered` after a verdict means fewer than 10 cases were paired, too few to rule out a change.

The report also gives the paired change in cost, wall time and critical path, where cost and time
moved phase by phase, and each variant's P(front): the share of bootstrap draws where no other
variant beats it on both quality and cost. Runs that failed on a rate limit, a server error or the
network are left out, and `--resume` runs them again.

| Flag | Default | What it does |
|---|---|---|
| `--threshold` | the case's, else 0.5 | The score that counts as a pass. |
| `--seed` | fixed | Seeds the bootstrap. The default seed is fixed too, so the same runs give the same report. |
| `--select` | none | Picks a variant to deploy: `min-cost`, `weighted` or `pareto`. |
| `--q-min`, `--q-drop` | `--q-drop 10` | With `min-cost`: the quality floor. `--q-min` sets it; `--q-drop` sets it that many points below the baseline's mean. The pick is the cheapest variant whose quality lower bound clears it. |
| `--lambda` | none | With `weighted`: the quality given up per USD. `0` picks the best quality. |

The pick prints as a `deploy:` line. If no variant clears the floor, nothing is picked. When no run
records cost, P(front) and the picks use wall time instead, and `--lambda` is per second.

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

`workflows compare` has no recorded run to check these forks against, so it prints no replay noise
floor for them. A replay keeps the upstream outputs fixed, so it understates how much results vary.
Replay three or more recorded runs per case.
:::

## Next steps

- [Experiments](https://coding.sh/docs/experiments): the same paired comparison for a single agent
  or prompt.
- [Judges](https://coding.sh/docs/judges): calibrate the judge a `judge` case uses.
- [workflows reference](https://coding.sh/docs/cli/workflows): every command and flag.
