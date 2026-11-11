# Workflow experiments

A workflow is a program that runs many agents: it fans out, pipelines, waits at barriers, verifies
and merges. Examples are a Claude Code Workflow tool script, or a LangGraph or Mastra app.
`coding.sh workflows` captures each run as one tree, measures where the time and money went, scores
the output against a known answer, and compares two versions of the workflow on the same cases with
paired statistics.

## Capture and measure

`coding.sh workflows import` reads Claude Code workflow runs from disk: each run's journal and the
transcript of every agent it started. A run that has not changed since the last import is skipped
without reading its transcripts. Runs you start with `workflows run` are captured as they go.

```sh
coding.sh workflows list --since 7d
coding.sh workflows show <run> --tree
coding.sh workflows stats <run>
```

`show` prints the run tree with time, cost and status per node (`--gantt` prints the timeline).
`stats` reports wall time, the critical path, how many agents ran at once, idle time at barriers,
failed agents, schema retries, cache hits on a resumed run, and cost per phase.

An agent you stopped shows as `cancelled`, and one a resume ran again under the same label as
`superseded`; both are listed apart from failures.

`coding.sh ui` shows the same runs at `#/workflows`: one bar per agent, grouped by phase, with the
critical path outlined and idle time at barriers shaded. A bar links to that agent's session.

## Cases

A case is one input to the workflow with a known answer. Cases live in
`evals/workflows/<workflow>/cases/*.toml`:

```toml
id = "seeded-1"
split = "dev"                    # or "heldout"
args = '{"seeded":"seeded-1"}'   # passed to the workflow
threshold = 0.5                  # a score at or above this counts as a pass
[truth]
kind = "seeded-bugs"
file = "hidden/seeded-1.json"    # kept outside the workflow's working tree
```

For a review workflow, the truth is a set of bugs planted in a clean snapshot. A finding matches a
bug when it names the same file and a line within 5 of the bug's lines (`--slack`). The score is
the F1 of the findings against the bugs. `coding.sh workflows score <run> --case seeded-1` scores
one run by hand.

A `[start]` table names the tree the workflow works on, with paths relative to the case file. The
truth file may not sit inside `repoRoot` or `snapshot`, where the agents could read it; keep it in
`hidden/` next to `cases/`.

```toml
[start]
repoRoot = "../../../.."
snapshot = "/tmp/seeded-1"       # the clean tree with the bugs applied
```

When a bug has a `test`, `workflows run` checks it before any run starts: the test must fail on the
snapshot and pass with the bug's patch reverted. `--no-validate` skips the check.

For a fix workflow, the truth is a verifier. `command = "npm test"` scores 1 when it exits 0. Named
tests score the share that pass, and a `before = "pass"` test that fails after the run is a
regression:

```toml
[truth]
kind = "verifier"
[[truth.tests]]
id = "orders"
command = "node --test test/orders.test.ts"
before = "fail"                  # the bug the workflow should fix
[[truth.tests]]
id = "cart"
command = "node --test test/cart.test.ts"
before = "pass"                  # failing after the run is a regression
```

The commands run in the current directory with `CODING_SH_WORKFLOW_RUN_ID` set.

For a synthesis or research workflow, the truth is a rubric graded by an LLM judge:

```toml
[truth]
kind = "judge"
rubric = "Names the three sources and the one claim they disagree on."
judge = "anthropic"              # or "<provider>:<model>", or a table like a grader's
```

The score is marked uncalibrated until that exact judge version has a calibration from
`coding.sh judge calibrate`.

## Run an experiment

```sh
coding.sh workflows run review -v base=wf/review.js -v cand=wf/review-v2.js -k 3 --split dev
```

Each `-v` is a variant: a name and a script for the Claude Code driver, or a name and a command for
`--driver command` (it gets `--args <json>` and prints its output as JSON). `-k` runs each case that
many times per variant. Attempts alternate between variants, so a slow afternoon hits both alike.

It prints the estimated cost and asks before spending more than the confirm threshold (`--yes`
skips the question). After an interruption, run it again with `--resume`: only the unfinished runs
run.

## Compare two variants

```sh
coding.sh workflows compare <experiment> --baseline base --candidate cand
```

The comparison pairs runs by case, so each case is compared with itself:

- **Quality.** The mean score per case in each variant, and a paired bootstrap interval for the
  difference.
- **Pass or fail.** McNemar's test on cases that pass in one variant and fail in the other. A pass
  is a score at or above the case's threshold, or `--threshold`, or 0.5.
- **Cost, wall time and critical path.** The median per case in each variant, and a paired interval
  for the difference.
- **Pareto.** Each variant's quality, cost and wall time, and P(front) (`front 0.93`): the share of
  bootstrap draws where no other variant beats it on both quality and cost, or wall time when no
  run records cost.
- **Phases.** Where the cost and time moved, phase by phase.

The first line is the verdict. It says "candidate better" or "candidate worse" only when the
bootstrap interval excludes zero and McNemar's test agrees; otherwise "inconclusive". A result that
is not significant with fewer than 10 paired cases is marked "underpowered".

Runs that still failed on a rate limit, a server error or the network are left out (`--resume` runs
them again), and so are cases that ran in only one variant. `--json` returns the whole report.

### Pick a variant to deploy

The comparison measures every variant. Which one to deploy is a separate choice, made once at the
end with `--select` (ParetoSaddler, arXiv 2611.02079):

```sh
coding.sh workflows compare <experiment> --baseline base --candidate cand --select min-cost --q-drop 10
```

- `--select min-cost` picks the cheapest variant whose quality interval stays above a floor:
  `--q-min 0.7`, or `--q-drop 10` (the default), 10 points below the baseline's mean. If none
  clears it, nothing is picked.
- `--select weighted --lambda 2` picks the highest quality minus λ × cost per run in USD (per second
  of wall time when no run records cost). `--lambda 0` picks the highest quality.
- `--select pareto` picks the highest-quality and the cheapest variant among those on the front in
  at least half the draws.

The pick prints as a `deploy:` line, for example
`deploy: cand (min-cost: cheapest of 2 with quality lower bound ≥ base's 0.800 − 10 pp = 0.700: $0.0500, quality lower bound 0.720)`.
`--seed` fixes the bootstrap, so the same runs always give the same report.

## Replays

Re-running a whole workflow to test an edit to its last stage wastes the earlier stages. A Claude
Code workflow can resume from a recorded run: the calls before the first edited one return their
recorded results, and only the edited call and the ones after it run again.

```sh
coding.sh workflows replay <run> --script wf/review-v2.js --dry-run   # predicted cache hits
coding.sh workflows replay <run> --script wf/review-v2.js
```

The cache follows call order, so an edit to the first stage re-runs everything. Inside a pipeline,
an edit to stage 2 can also re-run stage 1 for later items. `--dry-run` prints how many calls the record will serve.

A variant in an experiment can resume too:

```sh
coding.sh workflows run review \
  -v '{"name":"control","script":"wf/review.js","resumeFromRunId":"<run>"}' \
  -v '{"name":"cand","script":"wf/review-v2.js","resumeFromRunId":"<run>"}'
```

A command-driver variant can fork too, when the program supports it. `fromCheckpoint` passes
`--from-checkpoint <id>` (for example a LangGraph checkpoint) and `replayFrom` passes
`--replay-from <node>`. The program decides what the flags mean:

```sh
coding.sh workflows run graph --driver command \
  -v '{"name":"control","command":["node","app.mjs"],"fromCheckpoint":"<checkpoint>"}' \
  -v '{"name":"cand","command":["node","app-v2.mjs"],"fromCheckpoint":"<checkpoint>"}'
```

A replay keeps the upstream outputs fixed, so it understates how much results vary. Replay three or
more recorded runs per case, so the comparison also varies over the recorded runs.

## The control fork

A replayed candidate differs from a fresh baseline in two ways: the edit, and the replay itself.
The fix is a control: a variant that resumes the unedited script from the same recorded runs, so
the two differ only in the edit. Compare against it (`--baseline control --candidate cand`).
Without one, `workflows compare` adds a note that starts with "no control fork".

## The replay noise floor

With a control in place, `workflows compare` compares each control replay's outcome with the run it
resumed from. The script is the same, so any change is caused by the replay alone:

```text
replay noise floor: 1 of 8 control replay(s) changed outcome from their source run (13%); differences below that are replay drift
```

Read the candidate's result against that number. If replays alone change 13% of outcomes, a
candidate that changes 10% has not shown that the edit did anything. The check needs the source
runs scored in the same experiment. `--json` reports it as `control`.

## Reference

Every `workflows` command and flag is in the [CLI reference](../reference/cli.md). The
design, including the data model, the metrics and the capture details per framework, is in
[design/workflows.md](../design/workflows.md).
