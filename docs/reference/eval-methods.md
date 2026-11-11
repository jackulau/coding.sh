# How evals are computed

The formulas behind the numbers `eval run`, `exp show`, `exp compare` and `judge calibrate` print:
pass rates, paired comparisons, the ship-or-hold gate and judge calibration.
Site version: [coding.sh/docs/eval-methods](https://coding.sh/docs/eval-methods).

Every number on this page is computed on your machine from the stored runs. Seeded resamples give the
same interval on every rerun. Terms used throughout:

| Term | Meaning |
|---|---|
| Case | One input, with an expected answer when there is one. A repo task is a case too. |
| Trial | One run of a case. `-k` sets the trials per case; the default is 3. |
| n, c | A case's trials and how many of them passed. |
| Majority outcome | A case passes when most of its trials pass. Paired comparisons and the gate use it. |
| Paired | Both runs answered the same cases, so each case is compared with itself. |

## Pass rates

What `eval run` and `exp show` print for one run.

| Number | Formula | Notes |
|---|---|---|
| pass@1 | Σc / Σn over every trial | 95% Wilson score interval, which stays inside [0, 1] at 0/n and n/n. |
| pass@k | 1 − C(n − c, k) / C(n, k), averaged over cases | The chance that at least one of k trials drawn from a case's trials passes. Unbiased for k ≤ n. |
| pass^k | C(c, k) / C(n, k), averaged over cases | The chance that all k pass. Use it when the agent must work every time. |
| k | The fewest trials any case has | pass@k and pass^k appear only when k is 2 or more. |
| Flaky | 0 < c < n | The case passed some trials and failed others. pass^k counts it as a failure. |
| Saturated | 90% or more of the cases pass every trial | Capability suites only. The suite no longer separates versions; add harder cases. |
| Small suite | Fewer than 20 cases | The report says so: only large changes show. |

A **regression suite** exits 1 when any case fails most of its trials. A **capability suite** always
exits 0; its score is expected to start low.

### Sequential attempts

With `exp run --seq K`, a failed trial is tried again with feedback, up to K attempts.

| Number | Meaning |
|---|---|
| Seq@k | The share of cases solved by attempt k. |
| Seq@k against pass@k | pass@k counts k independent tries; Seq@k counts k tries where each sees why the last one failed. The two rank agents differently, so the report shows the whole curve. |

## Comparing two runs

What `exp compare A B` and `coding.sh compare` print. Each case gives one paired difference
dᵢ = Bᵢ − Aᵢ: its pass rate, or score, in B minus the same in A.

| Method | Formula or rule | What it answers |
|---|---|---|
| B − A | mean of dᵢ | How much B moved the pass rate. |
| Paired bootstrap interval | Resample the cases with replacement 10,000 times (seeded) and take the 2.5th and 97.5th percentiles of the mean dᵢ | The 95% range for B − A. |
| Sign-flip test | Under "no difference", each dᵢ is as likely to be +dᵢ as −dᵢ. p is the share of the 2ⁿ sign assignments whose mean is at least as extreme as the one observed | Exact up to 20 cases, a seeded Monte Carlo estimate above. It holds its level on small suites, where a bootstrap does not. |
| McNemar's test | b cases only A passed, c only B passed. p = min(1, 2 · P(X ≤ min(b, c))) with X ~ Bin(b + c, ½) | Exact test on the cases that changed. Cases both or neither passed say nothing about the difference. |
| Verdict | `better` or `worse` when the interval excludes 0 and the sign-flip p is below 0.05; else `inconclusive` | p cannot go below 0.05 with fewer than 6 changed cases, so a smaller change is always inconclusive. |

### More checks `exp compare` prints

| Check | Rule |
|---|---|
| Clusters (`--cluster repo`) | The bootstrap and the sign-flip test resample whole clusters, such as every case from one repo, instead of single cases. Use it when cases in a cluster are not independent. |
| Bayesian check | Below 100 paired cases: a Dirichlet posterior with a uniform prior over {only A passed, only B passed, tie}. P(B > A) is the chance that the only-B share of changed cases is above ½, from Beta(c + 1, b + 1). |
| Minimum detectable effect (MDE) | The smallest true gap the comparison finds 80% of the time, from the exact power of McNemar's test at this many cases. A small suite may have none: `no 80% power at this n`. |
| Non-inferiority (`--margin D`) | B is at most D worse than A when the interval's lower bound is above −D and a one-sided sign-flip test of "B − A ≤ −D" has p below 0.025. Exits 1 otherwise. Use it for a cheaper or faster B. |
| Regression to the mean | When B ran only on the cases A failed, B looks better even if it changes nothing. The verdict is forced to `inconclusive`. |
| Interleaving | Runs that did not alternate A and B may differ because the model or the network changed between them. `compare` warns. |

## The ship-or-hold gate

`exp compare A B --gate` and `compare --gate` decide whether to ship B. Cases where both runs agree
are dropped. Each remaining case is a **win** (B solves a case A failed) or a **loss** (B breaks a case
A solved). `solved` is the number of cases A solved.

| Condition | Formula | Default |
|---|---|---|
| Net gain | wins − λ · losses > 0 | λ = 2 (`--lambda`): one break costs two fixes. |
| Significance | P(X ≥ wins) < α, with X ~ Bin(wins + losses, λ / (1 + λ)) | α = 0.05 (`--gate-alpha`). λ / (1 + λ) is the win share at which B only breaks even. |
| Breakage | losses / solved ≤ τ | τ = 0.10 (`--tau`). |
| Smallest clean win | The smallest w with (λ / (1 + λ))ʷ < α | 8 wins with no losses at the defaults. |

| Headline | When | Exit |
|---|---|---|
| `Ship it: B wins N cases, loses M` | All three conditions hold. | 0 |
| `Hold: not enough evidence (…)` | Any other failed condition, most often too few wins to pass the significance test. | 1 |
| `Don't ship: B breaks N cases A solved` | B broke at least one case, and the net gain or the breakage condition fails. | 1 |

With `--lambda 1 --gate-alpha 1 --tau 1` the gate reduces to "ship when wins exceed losses".

## Judge calibration

`judge calibrate <experiment>` compares an LLM judge's verdicts with your labels on the same cases.
Only cases in a held-out split count (`test` by default): a rubric written while reading the other
splits agrees with you there by construction.

| Number | Formula | Notes |
|---|---|---|
| Agreement p₀ | Share of cases where judge and label agree | |
| Chance agreement pₑ | P(judge pass) · P(label pass) + P(judge fail) · P(label fail) | |
| Cohen's κ | (p₀ − pₑ) / (1 − pₑ) | 1 is perfect agreement, 0 is chance. 95% interval from 2,000 bootstrap resamples. |
| Sensitivity q₁ | P(judge says pass, given you labelled pass) | Stored with the judge. |
| Specificity q₀ | P(judge says fail, given you labelled fail) | Stored with the judge. |

| Status | Rule |
|---|---|
| `calibrated` | κ ≥ 0.6 (`--threshold`) on at least 20 held-out cases (`--min-n`). |
| `insufficient-data` | Fewer than 20 held-out cases with both a label and a verdict, or κ is undefined because you and the judge each gave every case the same label. |
| `uncalibrated` | κ below the threshold. |
| `in-sample` | The split you asked about is one the rubric was tuned on (`tunedOn`). |

### Correcting a judge's pass rate

| Method | Formula | Used by |
|---|---|---|
| Rogan-Gladen correction | θ̂ = (p̂ + q₀ − 1) / (q₀ + q₁ − 1), with p̂ the judge's pass rate | `exp compare` for a calibrated judge. Refused when q₀ + q₁ ≤ 1. The interval counts the uncertainty in q₀ and q₁ too. |
| Judge-corrected delta (PPI++) | θ = ȳₙ + λ (f̄_N − f̄ₙ): the mean label on the n labelled cases, plus λ times the judge's mean on all N cases minus its mean on the labelled ones | `exp compare --labels-a A.jsonl --labels-b B.jsonl`, with at least 20 labels per run (`--min-labels`). λ is tuned so the interval is never wider than labels alone give. |

`exp compare` also warns when the judge's sensitivity or specificity differs between the two runs,
because that biases B − A even when each run's judge looks fine.

## Other terms

| Term | Meaning |
|---|---|
| Signal validity | Whether a failure flag or tool errors predict failure beyond how hard the case is. `compare --signals` prints the AUROC within each task, beside difficulty and length references. Needs `-k` 2 or more. |
| Plausibly best set | With three or more configurations, the ones not significantly worse than the best. `exp sweep` prints it. |
| Item difficulty | A per-case difficulty from an item response model, P(configuration j passes case i) = σ(aᵢ (θⱼ − bᵢ)), fit on stored runs. `compare --pick N --pick-by irt` runs the cases that best separate the configurations first. |

:::more Sources
- pass@k estimator: Chen et al., "Evaluating Large Language Models Trained on Code", arXiv 2107.03374.
- pass^k: Yao et al., "τ-bench", arXiv 2406.12045.
- Seq@k: Yen et al., arXiv 2610.37859.
- Small-sample intervals and the Bayesian check: Hariri et al., "Don't Pass@k", ICLR 2026.
- Sign-flip test: Fisher, *The Design of Experiments* (1935); p-values never zero: Phipson and Smyth, SAGMB 9(1), 2010.
- Non-inferiority: Piaggio et al., CONSORT extension, JAMA 308(24), 2012.
- Ship-or-hold gate: Wang et al., SAGE, arXiv 2609.36043.
- Judge correction: Lee et al. 2026, "How to Correctly Report LLM-as-a-Judge Evaluations" (Rogan-Gladen);
  Angelopoulos, Duchi and Zrnic, "PPI++", arXiv 2311.01453; Boyeau et al., "AutoEval Done Right", arXiv 2403.07008.
:::
