# How good is the hill-climb, really?

Date: 2026-11-08. Scope: a meta-eval of coding.sh's harness hill-climb — `refine test`,
`refine run`, and the `--suite` climb — judged on whether it finds real wins, refuses
regressions, converges, and reports honest statistics.

Method: the climb's quality lives in pure, paired code — the acceptance gate
(`src/stats/tests.ts`), the multi-objective decision (`src/refine/objectives.ts`), the
forgetting guard (`src/refine/guard.ts`), and the plateau detector
(`src/stats/edetector.ts`). A model run only turns a candidate into a pass/fail matrix;
every promote, reject, hold and stop decision is made by that code. So this meta-eval
drives the real functions with synthetic task matrices whose ground truth is known, over
many seeded draws, and measures what the code decides. No model calls, fully
deterministic. The headline properties are asserted as a permanent regression guard in
`test/refine/metaeval.test.ts`; the numbers below come from a wider run of the same
harness (more seeds), and all come from the real code.

A "suite" below is `T` tasks, each run `k` times per arm; `T = 12`, `k = 3` is a typical
small repo suite. A "decision point" round (`refine test` without `--suite`) uses the same
machinery with per-task majority outcomes.

## Summary

The hill-climb is **honest and conservative, and underpowered at small suites**. It almost
never promotes a non-improvement, it refuses cheaper-but-worse candidates and blocks a
candidate that forgets an earlier win, and its plateau detector stops on a plateau without
false-alarming on real progress. Its one real limitation is statistical power: at a
12-task, 3-trial suite it detects only large wins, and it holds (does not reject) most
genuine efficiency wins because it cannot prove quality stayed within the margin. The
previous message for that hold wrongly implied a quality loss; this round fixes the
message and adds a note that says the hold is a sample-size problem and names the fix.

## 1. Does it find real wins?

Promote precision and recall over a mixed population of candidates with known ground truth
(one third genuinely better on half their tasks with no regressions, one third identical,
one third worse on half their tasks), suite `T = 12`, `k = 3`, N = 1200:

- Keep rate by class: **GOOD 8.8%, NEUTRAL 2.0%, BAD 0.0%**.
- **Precision (a keep is a true improvement) = 0.81. Recall (a true improvement is kept) = 0.09.**

So when the climb promotes, four in five promotions are real wins; but it misses most real
wins at this suite size. Power rises with the effect: a uniform per-task gain is kept 4.0%
of the time at +5 pts, 8.0% at +10 pts, and 28.1% at +20 pts (N = 1000). This is not a bug
— it is the small-suite power ceiling the code already warns about
(`src/refine/objectives.ts` `MIN_TASKS`, and the "below 5 tasks no test can reach α"
warning). The practical reading: a 12-task suite reliably catches only large edits; catching
a 5–10 pt edit needs more tasks or trials.

## 2. Does it avoid regressions?

Yes, on every axis tested.

- **Margin guard.** A candidate 40% cheaper whose quality drops by a growing amount is kept
  less and less often, and a real loss is never kept: keep rate **4.4% → 3.6% → 2.0% →
  0.6% → 0.0%** as the quality drop goes 0 → 2 → 5 → 10 → 20 pts (objectives `cost,pass`,
  N = 500). The efficiency branch (`judgeObjectives`) requires the quality lower bound to
  clear `−margin`, so a gain that costs quality is refused.
- **Forgetting guard (K8, `checkGuard`).** A candidate that drops even one of 16 tasks an
  earlier kept edit won is blocked 100% of the time; a candidate that holds all of them
  passes. The guard runs the earlier wins through the acceptance gate, so losing solved
  tasks with no compensating wins is a don't-ship (`src/refine/guard.ts`).
- **Hard-regression screen.** A task the base solved on every attempt that the candidate
  now mostly fails is caught directly (`hardRegressions`), rejecting the round regardless
  of the net score.

## 3. Does it converge?

Yes, and the plateau detector behaves as its paper (Yin et al., arXiv 2610.04756)
predicts. Over the e-detector at ε = 0.05, δ = 0.05, n = 12 tasks/round (N = 1500):

- **Change-point detection.** A loop that gains +10 pts/round for 3 (or 5) rounds then
  flatlines is stopped 100% of the time, and the reported change point is within ±2 rounds
  of the truth ~96% of the time.
- **No false stop on real progress.** A loop still gaining +8 or +10 pts/round for 30
  rounds never alarmed (0%).
- **Flat-plateau latency.** A loop flat from round 1 is stopped 100% of the time, median at
  round ~13, against the information-theoretic floor `plateauRoundsNeeded(12, 0.05) = 11`.

This settles the "it needed ~21 rounds — bug?" question: a flat plateau cannot be told from
noise before `log(1/δ) / (n·log(1 + λε))` rounds (`src/stats/edetector.ts` App. B). That
floor is 11 rounds at ε = 0.05 and n = 12, and **51 rounds at ε = 0.01** — so a ~21-round
plateau is expected for a small suite or a small ε, not a defect. The code already surfaces
the floor (`climbPlateauLine`, the `floor` field) and warns when a loop will run fewer
rounds than the floor allows.

## 4. Are the statistics honest?

Mostly yes, with one small-sample caveat worth knowing.

- **McNemar power is exact.** Empirical rejection rates match the analytic
  `mcnemarPower` curve within Monte-Carlo error over N = 20000: n=50 d=0.3 δ=0.2 gives
  69.5% vs 69.9%; n=30 d=0.4 δ=0.2 gives 30.1% vs 30.7%; n=12 d=0.4 δ=0.2 gives 5.5% vs
  5.4%. Size at the null is 2.9%, at or below the nominal 5%.
- **Gate false-promote is well controlled.** At the null (an identical candidate), the
  composite keep decision fires 1.8% of the time with the gate, 2.8% on quality alone —
  below the nominal 5%, even though the composite ORs two one-sided tests.
- **The percentile bootstrap undercovers a little at small n.** The 95% paired-bootstrap CI
  covers 89.3% at n=8, 91.3% at n=12, and 93.3% at n=30 — the known shortfall of the
  percentile method on small samples. Because the non-inferiority test inverts that same
  bound, its one-sided size at the margin boundary is 8.3% at n=12, above the nominal 5%.
  The margin guard is therefore slightly anti-conservative on a tiny suite: it can declare
  "quality held within the margin" a little more readily than its α claims. This did not
  translate into over-promotion in the composite decision (§2), because the efficiency
  branch also requires a separately significant efficiency gain and no hard regression. It
  is called out here so the number is on record, not hidden; the fix is more tasks or
  trials, which the climb now says.

## The one weakness, and what changed

The dominant outcome at a realistic suite is not a wrong decision — it is an **inconclusive
hold**: a candidate that is genuinely cheaper or faster with quality unchanged is kept only
4.4% of the time, because the quality interval at 12 tasks is too wide to prove the hold
within a 2 pt margin. That is statistically correct, but the old message —
*"…but a gain that costs quality is not kept"* — implied the candidate had lost quality,
when the real problem was sample size.

This round changes `judgeObjectives` to separate the two cases
(`src/refine/objectives.ts`): a candidate whose quality fell (mean below 0) still reads
"quality fell … a gain that costs quality is not kept"; a candidate whose quality held on
average but could not be confirmed now reads "quality not shown to hold … the quality
interval is too wide to adopt it within the margin at N tasks: add tasks or trials", and
the round carries a warning that names the quality lower bound against the margin and the
fix. The verdict is unchanged — the round is still correctly inconclusive — only the
explanation is now honest and actionable, which is what keeps the loop moving.

## Reproduce

```sh
# the permanent property guard (seeded, deterministic, ~5s)
node --no-warnings --test packages/coding.sh/test/refine/metaeval.test.ts
```

The wider study (the numbers above) is the same harness with more seeds and the per-study
breakdown printed; it reads only the pure functions this file cites.
