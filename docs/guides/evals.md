# Evals and comparisons

Eval runs that drive a real agent or an LLM judge call that agent or provider, with your
credentials and at your cost.

## Session to eval

`coding.sh eval new <session> --verifier "<cmd>"` drafts a replayable task that starts from the
repo snapshot taken before the agent ran.

`coding.sh eval validate <task>` checks that the verifier is fair: a do-nothing attempt fails, the
reference fix passes k of k, near-misses fail, an impossible variant fails, and no future history
leaks.

`coding.sh eval export --format harbor` writes a Harbor-format task.

## Datasets and experiments

`coding.sh dataset add|import` keeps versioned cases with stable train/dev/test splits.

`coding.sh exp run` runs a command or HTTP task over a dataset. Graders can be deterministic
(exact, contains, regex, numeric, similarity, JSON schema, JSON path), a command, or an LLM judge.

`coding.sh exp compare A B` reports the paired bootstrap CI of the difference, an exact McNemar
test on flipped cases and the minimum detectable effect. It also reports:

- **Clusters.** `--cluster repo` resamples groups of related cases (any case metadata field;
  `session` falls back to the case's source session) instead of single cases. It prints the cluster
  count and warns below 10 clusters. Without the flag, cases are treated as independent.
- **A Bayesian check at small n.** Below 100 paired cases it adds P(B>A) and a credible interval
  from a Dirichlet posterior on the paired outcomes. The bootstrap interval stays.
- **Attrition.** Per arm, trials lost to task errors, grader errors or missing runs, split into
  infra errors (timeouts, network, HTTP 429/5xx) and agent errors. Fisher's exact test flags an
  uneven split at p < 0.01.
- **Noise floor.** When an A/A run exists for the baseline config, it prints the A/A flip rate,
  and the minimum detectable effect never goes below what that noise allows.
- **Timing.** When the two runs were not interleaved and ran one after the other, it warns and
  says how far apart they were. Provider drift, rate limits and time of day can look like a change.

`coding.sh exp run --arm base=a.json --arm cand=b.json` runs two task configs as one A/B. Cases go
in a random order, and each case runs in both arms back to back, in random arm order, so drift
hits both arms the same. Both arms are stored (as `<name>-base` and `<name>-cand`) and share a pair
id. `--seed` fixes the order, `--max-cases N` runs a random N cases.

Add `--stop-early` to stop once the answer is clear. It is a group sequential test with
O'Brien-Fleming alpha spending at `--looks` (default 4) evenly spaced points of the case budget,
never before 20 paired cases. Early looks need very strong evidence, so the last look is close to
the fixed-n test. The output says why it stopped (a boundary was crossed, or the budget ran out),
and the interval it prints is a repeated confidence interval, which stays valid however the run
stopped. After an early stop, the stored arms hold only the cases the deciding look saw, and
`exp compare` on them uses the sequential verdict and warns that its bootstrap interval is too
narrow.

`coding.sh exp aa --dataset D --task T --grader G` runs one config twice, interleaved like `--arm`,
and stores its run-to-run noise: the A/A delta, flipped cases, the SD of per-case differences, and
the cases needed to detect a 5pp or 10pp change. `coding.sh exp aa A B` measures it from two
stored runs instead, and warns when they were not interleaved.

`coding.sh exp sweep base=a.json b.json c.json -d D -g G` picks the best of several task configs.
It uses sequential halving (Karnin et al., ICML 2013): the budget is split over log2(N) rounds,
each round runs every surviving config on the same fresh cases from the train split, and the
better half goes on. Dropped configs show their gap to the leader with a CI, so you can see which
drops were close. Then the winner and the first (start) config run on the test split, which the
race never saw. The output prints the winner's train and held-out scores and the optimism gap
(train minus held-out). The winner of a race tends to be the luckiest config, so its train score
runs high; the held-out score is the one to trust. `--budget N` caps case runs for the race
(default: each train case used once), `--split` and `--held-out` pick the splits, and a dataset
with no splits gets a seeded 30% held out. Every run is stored as a normal experiment.

## Metric A/B (ms, bytes)

`coding.sh exp metrics --arm base='<cmd>' --arm cand='<cmd>'` compares two commands that print
numbers instead of pass/fail. Each run prints one JSON object, such as
`{"lcp_ms": 2310, "js_bytes": 48211}`. Nested objects flatten to dotted names
(`mobile.home.lcp_ms`). An arm is a command line, a `{"kind":"command"}` task spec or a spec file.
Each run gets `{"arm","pair","warmup"}` on stdin.

The arms run in `--pairs` interleaved pairs (default 11), one run at a time. Half the pairs run A
first and half B first, in a seeded random order, so a warm cache or a heating CPU hits both arms
alike. `--warmup N` runs each arm N times first and drops those runs.

For each metric it prints both arms' medians, the median paired delta (B − A) with a 95% paired
bootstrap CI, and a verdict: better, worse or inconclusive. Lower is better unless the metric is
named in `--higher` (`*` wildcards work). A verdict needs two things. The CI must exclude 0, and an
exact sign test on the paired deltas must give p < 0.05 after a Holm correction across the metrics.
At 11 pairs the bootstrap alone is too optimistic, and a page run reports dozens of metrics, so
without the correction an A/A run would flag a few by chance. With 11 pairs, a noisy metric needs
nearly every pair to agree; use `--pairs 21` to find smaller changes. A metric whose deltas are all
the same, like the byte count of a fixed build, has no noise: a non-zero delta is a change.

`--json` prints the whole result, runs included. `--fail-on-worse` exits 1 when any metric got
worse, for CI gates. scripts/perf/ uses it to gate the coding.sh site on Lighthouse metrics.

## Judges

`coding.sh judge calibrate` measures judge and human agreement (Cohen's kappa) on a held-out split.
Every report flags judges that are not calibrated. It also stores the judge's held-out sensitivity
and specificity, so later `exp compare` runs show a bias-corrected (Rogan-Gladen) judge pass rate.

`coding.sh exp compare A B --pairwise judge.json` adds a pairwise judge
(`{"kind":"pairwise","name":…,"rubric":…}` with the same provider options as `llm`). For each
shared case it shows the judge both outputs, then asks again with the order swapped. A side wins
only when both orders agree. When the answer changes with the order, the case is a tie, and the
share of such cases is printed as the position-bias rate (Wang et al., 2023). It reports B's win
rate (ties count half) with a bootstrap CI, a sign test on the decisive cases, and the ties.
`--labels labels.jsonl` (rows of `{"caseId","winner":"a"|"b"|"tie"}`) calibrates it the same way
as `judge calibrate`: kappa on the test split, with judge ties left out, stored on the judge.

## Harness A/B

`coding.sh harness snapshot` bundles an agent's harness files (CLAUDE.md, AGENTS.md, skills, hooks,
MCP config). `coding.sh compare A B` runs both bundles on eval tasks in isolated config
directories. It reports per-arm Wilson intervals and the first step where the traces diverge.

`coding.sh compare A --without .claude/skills/pdf` tests one piece of a harness. B is A minus that
path: a skill, `AGENTS.md`, `CLAUDE.md` or `.mcp.json`. The path is also deleted from each task's
repo. The report adds `effect of <path> = A − B` with its CI. `--without` can be repeated.

`coding.sh compare A B --gate` adds a ship-or-hold answer under the verdict: `Ship it: B wins 9
tasks, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 3 tasks A solved` with the
broken task ids. It exits 0 only for "Ship it", so it can gate a harness change in CI. It works on
each task's majority outcome. A task B fixed is a win, a task A solved that B failed is a loss, and
ties are ignored. B ships when three things hold. First, wins minus λ times losses is positive (λ =
`--lambda`, default 2, so one break cancels two fixes). Second, an exact one-sided binomial test on
the wins and losses beats break-even at `--gate-alpha` (default 0.05). Third, B breaks at most
`--tau` (default 10%) of the tasks A solved. This is SAGE's accept-or-abstain rule (Wang et al.,
arXiv 2609.36043). The paper reports no default settings; these are ours. B passes that tampered
with tests count as fails for the gate only. With `--without`, the line is labelled `drop-it gate`
and reads "Drop it" or "Keep it".

With `--k 2` or more, compare sorts each arm's failed runs three ways. A bad run failed on a task the
same arm passed in another attempt, so a retry would help. A beyond-arm failure is on a task only
the other arm solved. Unsolved-by-all is a task neither arm solved; check the task itself. It also
splits the outcome variance into task, arm and run-to-run shares. With `--k 1` these can't be told
apart, and the report says so.

A cost, token or turn value shows `(3/10)` when only 3 of the arm's 10 runs reported it. The
"X% cheaper" note needs a known cost for at least 80% of each arm's runs. Below that, the report
says how many runs were priced instead.

## Tool evals

`coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API: surface size,
schema checks, per-task tool-call metrics in a sandbox, variant comparisons and MCP description
compression. See [TOOL-EVALS.md](../TOOL-EVALS.md).

## Workflows

`coding.sh workflows` imports multi-agent workflow runs and reports the run tree, critical path,
concurrency, cost and paired variant comparisons. See [design/workflows.md](../design/workflows.md).
