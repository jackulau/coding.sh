# Workflow experiments

A workflow is a program that runs many agents: it fans out, pipelines, waits at barriers, verifies
and merges. Examples are a Claude Code Workflow tool script, or a LangGraph or Mastra app.
`coding.sh workflows` captures each run as one tree, measures where the time and money went, scores
the output against a known answer, and compares two versions of the workflow on the same cases with
paired statistics.

## Capture and measure

`coding.sh workflows import` reads Claude Code workflow runs from disk: each run's journal and the
transcript of every agent it started. Runs you start with `workflows run` are captured as they go.

```sh
coding.sh workflows list --since 7d
coding.sh workflows show <run> --tree
coding.sh workflows stats <run>
```

`show` prints the run tree with time, cost and status per node. `--gantt` prints the timeline as
tab-separated text instead. `stats` reports wall time, the critical path, how many agents ran at
once, how long agents sat idle at barriers, failed and null agents, schema retries, cache hits on a
resumed run, and cost per phase.

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
bug when it names the same file and a line within 5 of the bug's lines (`--slack`). The run's score
is the F1 of its findings against the bugs. `coding.sh workflows score <run> --case seeded-1` scores
one run by hand.

## Run an experiment

```sh
coding.sh workflows run review -v base=wf/review.js -v cand=wf/review-v2.js -k 3 --split dev
```

Each `-v` is a variant: a name and a script for the Claude Code driver, or a name and a command for
`--driver command`. A command gets `--args <json>`, runs with `CODING_SH_WORKFLOW_RUN_ID` set, and
prints its output as JSON. `-k` runs each case that many times per variant. Attempts alternate
between variants (base, cand, base, cand, …) so a slow afternoon or a rate limit hits both alike.
One job runs at a time by default, because a workflow already fans out.

The command prints the estimated cost from past runs and asks before spending more than the
confirm threshold (`--yes` skips the question). It prints the experiment id at the end. If it is
interrupted, run it again with `--resume`: finished runs are kept and only the rest run.

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
- **Pareto.** Each variant's quality, cost and wall time. A variant is marked dominated when another
  is at least as good on all three and better on one. Near-equal noisy variants can trade places on
  those means, so each variant also gets P(front): the share of bootstrap draws (runs and cases
  reweighted) in which no other variant beats it on both quality and cost, shown as `front 0.93` or
  `dominated by base (front 0.41)`. When no run records cost, P(front) uses wall time. A variant
  that reports cost on fewer than 80% of its scored runs gets no P(front), and a note says why.
- **Phases.** Where the cost and time moved, phase by phase.

The first line is the verdict. It says "candidate better" or "candidate worse" only when the
bootstrap interval excludes zero and McNemar's test agrees. When they disagree it says
"inconclusive" and suggests more cases or attempts. A result that is not significant with fewer
than 10 paired cases is marked "underpowered". Runs whose last attempt still failed on a rate
limit, a server error or the network are left out, because they never measured the workflow
(`--resume` runs them again). Cases that ran in only one variant are listed and left
out too. `--json` returns the whole report.

### Pick a variant to deploy

The comparison measures every variant. Which one to deploy is a separate choice, made once at the
end with `--select` (ParetoSaddler, arXiv 2611.02079):

```sh
coding.sh workflows compare <experiment> --baseline base --candidate cand --select min-cost --q-drop 10
```

- `--select min-cost` picks the cheapest variant whose quality interval stays above a floor. The
  floor is `--q-min 0.7`, or `--q-drop 10`, meaning 10 points below the baseline's mean quality.
  The default is `--q-drop 10`. If no variant clears the floor, nothing is picked and the reason
  names the closest one.
- `--select weighted --lambda 2` picks the highest quality minus λ × cost per run in USD (per second
  of wall time when no run records cost). `--lambda 0` picks the highest quality.
- `--select pareto` picks the highest-quality and the cheapest variant among those on the front in
  at least half the draws. That is two variants on a real trade-off and one when a variant wins on
  both.

The pick prints as a `deploy:` line, for example
`deploy: cand (min-cost: cheapest of 2 with quality lower bound ≥ base's 0.800 − 10 pp = 0.700: $0.0500, quality lower bound 0.720)`.
`--json` adds it as `deployment`, alongside `pFront` on each variant and `frontierAxes`. `--seed`
fixes the bootstrap, so the same runs always give the same report.

## Replays

Re-running a whole workflow to test an edit to its last stage wastes the earlier stages. A Claude
Code workflow can resume from a recorded run: the calls before the first edited one return their
recorded results, and only the edited call and the ones after it run again.

```sh
coding.sh workflows replay <run> --script wf/review-v2.js --dry-run   # predicted cache hits
coding.sh workflows replay <run> --script wf/review-v2.js
```

The cache follows call order. An edit to the first stage re-runs everything. Inside a pipeline,
items interleave across stages, so an edit to stage 2 can also re-run stage 1 for later items.
`--dry-run` prints how many calls will be served from the record before anything runs.

A variant in an experiment can resume too:

```sh
coding.sh workflows run review \
  -v '{"name":"control","script":"wf/review.js","resumeFromRunId":"<run>"}' \
  -v '{"name":"cand","script":"wf/review-v2.js","resumeFromRunId":"<run>"}'
```

A replay keeps the upstream outputs fixed, so it understates how much results vary. Replay three or
more recorded runs per case, so the comparison also varies over the recorded runs.

## The control fork

A replayed candidate differs from a fresh baseline in two ways: the edit, and the replay itself.
The cached prefix and an environment that changed since the recording can both move the outcome. Comparing the candidate with fresh baseline runs mixes the two effects.

The fix is a control: a variant that resumes the unedited script from the same recorded runs. The
control and the candidate then differ only in the edit. Compare the candidate against the control
(`--baseline control --candidate cand`).

When the candidate resumes from recorded runs and no baseline run resumes from the same ones,
`workflows compare` adds a note that starts with "no control fork". Treat that comparison as a mix
of the edit and the replay.

## The replay noise floor

With a control in place, `workflows compare` also checks how stable replays are. It compares each
control replay's outcome with the outcome of the run it resumed from. The script is the same, so
any change is caused by the replay alone:

```text
replay noise floor: 1 of 8 control replay(s) changed outcome from their source run (13%); differences below that are replay drift
```

Read the candidate's result against that number. If replays alone change the outcome of 13% of
cases, a candidate that changes 10% of outcomes has not shown that the edit did anything. `--json`
reports the same check as `control`: `sources` (the recorded runs the candidate resumes from),
`controlRuns`, and `drift` with `n`, `changed` and `rate`. The drift needs a score for both the
control replay and its source run in the experiment. When the source runs were scored somewhere
else, `control` lists the fork but has no `drift`.

## Reference

Every `workflows` command and flag is in the [CLI reference](../reference/cli.md). The
design, including the data model, the metrics and the capture details per framework, is in
[design/workflows.md](../design/workflows.md).
