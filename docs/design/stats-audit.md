# Resampling audit: bootstrap shares used as decisions

Status: done, 2026-11-08. Changes are in 0.1.5.

## What was checked

gbrain-evals found a bug in its own statistics: a share of bootstrap draws was used as a p-value.
With few clusters that is anti-conservative. When a handful of units all move the same way, every
resample moves the same way too. The percentile interval is then a single point, such as
[+100pp, +100pp], and the share of draws on one side is 1, at any number of units. Their fix was an
exact one-sided cluster sign-flip p: enumerate every flip up to 20 clusters, and use seeded Monte
Carlo above that.

This audit covered every place in `packages/coding.sh/src` that turns resampling into a decision or
a reported probability, plus `scripts/dogfood/bench.mjs`. For each one it records what is computed,
whether a gate or exit code uses it, and a verdict:

- **OK**: an exact test already decides, or the number is labelled for what it is and no decision
  rests on it.
- **Mislabelled**: the number is described as something it is not.
- **Gate bug**: a decision rests on the interval or share alone, so a few units that agree pass it.

The smallest p an exact sign-flip test can give over n units is 2^-n one-sided and 2^(1-n)
two-sided. Rejecting at 0.05 two-sided therefore takes 6 units that changed, and so does 0.025
one-sided.

## Inventory

| Location | What it computes | Gate | Verdict |
|---|---|---|---|
| `stats/tests.ts`: `mcnemar`, `signTest`, `fisherExact`, `acceptanceGate`, `pairedPermutation`, `holm` | exact tests | various | OK |
| `stats/tests.ts` `nonInferiority` (`exp compare --margin`, refine efficiency keeps) | bootstrap lower bound against −δ | yes | Gate bug, fixed |
| `experiments/compare.ts` verdict (`exp compare`, A/A, sweeps, session replays, MCP `compare`) | CI excludes 0 | yes | Gate bug, fixed |
| `experiments/pairwise.ts` verdict (`exp compare --pairwise`) | win-rate CI excludes 50% | yes | Gate bug, fixed |
| `eval/trigger.ts` delta (`eval trigger --fail-on regression`) | CI over prompts below 0 | yes | Gate bug, fixed |
| `toolevals/compare.ts` metric verdicts and metric regressions | CI excludes 0 | yes | Gate bug, fixed |
| `stats/pareto.ts` `paretoSupport` (`compare --promote`) | Bayesian bootstrap support ≥ γ | yes | Gate bug, fixed |
| `refine/keep.ts` `KeepCandidate.effect` | compare's 95% CI, for ordering keeps | ordering only | Mislabelled ("Holm-adjusted"), fixed |
| `experiments/metrics.ts` metric verdicts | Holm-adjusted sign test and CI | yes | OK |
| `experiments/matrix-run.ts` `holmVerdict` | McNemar with Holm | yes | OK |
| `bench/stats.ts` | Holm McNemar verdict; latency CI reported | verdict yes | OK |
| `experiments/sweep.ts` `vsLeader` | CI; drops are by rank | no | OK |
| `experiments/run.ts` pass-rate intervals | CI | no | OK |
| `runner/experiment.ts`, `workflows/experiment.ts`, `toolevals/compare.ts` `decide` | CI and exact McNemar | yes | OK |
| `runner/experiment.ts` ablation effect | CI | no | OK |
| `toolevals/compress.ts` `nonInferior` | success CI lower bound, invalid-rate CI upper bound, no task may lose passes | yes | Gate bug, left alone |
| `workflows/experiment.ts` `--select min-cost` | quality CI lower bound above a floor | selection | Left alone |
| `workflows/experiment.ts` `pFront` (`frontierSupport`) | share of draws on the front, labelled as such; `--select pareto` keeps ≥ 0.5 | selection | OK |
| `refine` loop, guard and `decideRound` | exact acceptance gate (SAGE) | yes | OK |
| `refine/objectives.ts` quality and metric `better` | exact permutation test | yes | OK |
| `refine/objectives.ts` efficiency branch | `nonInferiority` | yes | Fixed with `nonInferiority` |
| `improve` | Fisher exact | yes | OK |
| `judge` calibrate | kappa point estimate with n ≥ 20; CI reported | yes | OK |
| `experiments/stability.ts` `directionStability` | share of resamples with the same winner, labelled; warnings only | no | OK |
| `experiments/compare.ts` posterior | P(B > A) from a Dirichlet posterior, labelled; report only | no | OK |
| sequential tests, `seqk`, e-detector, stratified, McNemar power | not resampling | — | OK |
| `scripts/dogfood/bench.mjs` `bootstrapMedianDiff` | CI of a median difference, reported | no | OK |

Probes before the fixes, all on units that agree:

- `exp compare`: 3, 4, 5 or 6 improved cases were `better`, with the CI at [+100pp, +100pp]. The
  exact two-sided p was 0.25, 0.125, 0.0625 and 0.031. 30 improved cases in 3 clusters were
  `better` too, at p 0.25 over clusters.
- `nonInferiority`: 3 tied cases were non-inferior at any margin; the exact p at the margin is 0.125.
- `exp compare --pairwise`: 3 decisive B wins were `better`; the sign test p is 0.25.
- `eval trigger`: 3 prompts that all got worse exited 1 under `--fail-on regression`.
- `toolevals compare`: +2 turns on 3 tasks was a metric regression.
- `compare --promote`: one improved task promoted B with support 1.00.

## What changed

Each gate now needs its interval or support and an exact test to agree. The exact test is
`clusterSignFlip` in `stats/tests.ts`. It sums each cluster's differences, or uses each unit's
difference when there is no cluster key, and calls `pairedPermutation`. That flips every sign
exactly up to 20 units that changed and uses seeded Monte Carlo above that.

- `nonInferiority` needs the one-sided p of "B − A ≤ −δ" to be below α, after shifting each unit by
  δ times its size. The result carries `p` and `units`.
- The `exp compare` verdict needs the two-sided p, over cases or clusters, below α
  (`comparison.signFlip`).
- The pairwise verdict needs the same test over decisive cases or clusters (`pairwise.signFlip`).
  Without clusters its p equals the sign test's.
- `eval trigger` needs the two-sided p over prompts below 0.05 for Better and Worse
  (`delta.signFlip`, `delta.improvement`).
- `toolevals compare` needs the paired permutation p on per-task differences below α for a metric
  to be `better` or `worse`. Otherwise the metric is `inconclusive`, with a note
  (`metrics.<name>.p`).
- `compare --promote` needs min(pQuality, pCost) ≤ 1 − γ, from one-sided tests on per-task
  quality and cost differences (`pareto.exact`). The level matches the support's γ, so one task
  holds (p 0.5) and two promote (p 0.25).

With one trial per case, a case's difference is −1, 0 or 1. The two-sided sign-flip p then equals
the exact McNemar p, so a verdict at larger n changes only where McNemar never agreed with it. On a
grid of 30-case comparisons, the only verdicts that changed had exact p between 0.051 and 0.125.
The existing tests kept their verdicts, except three synthetic ones built on 4 prompts or on one
improved task. Those now assert the new result.

## Left alone

- **`toolevals/compress.ts` `nonInferior`.** This is the same bug as `nonInferiority`: a few tied
  dev tasks give a lower bound of 0. Two other rules limit it: any task that loses passes blocks
  the step, and the result is confirmed on held-out tasks. An exact test at the margin would block
  every compression on a dev split with fewer than 6 tasks, so it needs a product decision first.
- **`workflows` `--select min-cost`.** It picks the cheapest variant whose quality lower bound
  clears a floor. This is a preference among variants the user lists, not a pass or fail, and its
  text names the lower bound.
- **`pFront`.** It is labelled as a share of draws, and the selection threshold of 0.5 is a
  majority, not a significance level.
- **`directionStability`, the compare posterior, `bootstrapMedianDiff`.** They are reported with
  their own names, and nothing decides on them.
- **Sequential verdicts** (`exp ab`, `stats/sequential.ts`). They use group-sequential boundaries
  with O'Brien–Fleming alpha spending, not resampling.
