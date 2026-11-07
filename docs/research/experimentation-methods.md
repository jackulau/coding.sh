# Experimentation methods we don't use yet

Date: 2026-11-07. Scope: statistics and experiment design for comparing agent configs (model,
harness, prompt, tools), with coding agents first-class. I read round-1-papers.md, seen.md,
dynamic-benchmarks.md §4, competitive-gap.md, landscape.md §7 and the open items in
tasks/research-queue.md first. Then I checked every "missing" claim against the code.

Most sources below were read at the abstract level ("(abs)"). Numbers are the authors' own.
Items already specced in the queue appear only when this round adds something; the overlap is
named in each case.

## What we already have (so it is not repeated below)

- **Paired comparison.** `exp compare` pairs by case id. It runs a percentile bootstrap over
  per-case deltas and an exact McNemar test on per-case majority outcomes, and gives a
  better/worse/inconclusive verdict (src/experiments/compare.ts:139-151). It also reports
  pass^k when trials > 1 (compare.ts:190-194).
- **Trials are clustered.** With trials > 1, the single-arm CI is a bootstrap over cases, not
  trials (src/experiments/run.ts:248-256).
- **Power.** The MDE (Miller eq. 10) and its warnings, including a small-n warning below 200
  cases (src/experiments/power.ts:86-123).
- **Bench.**
  - A seeded interleaved job order (src/bench/run.ts:397).
  - Holm across pairs and Connor sample size (src/bench/stats.ts:220).
  - Shared places when contenders don't differ (stats.ts:241).
  - DerSimonian-Laird/HKSJ pooling across runs (stats.ts:339).
  - An anchor set and stratified seeded sampling (src/bench/sample.ts:84).
- **Interleaving elsewhere.** The harness compare interleaves arms (src/runner/experiment.ts:63),
  and so do workflows, which also build a Pareto front (src/workflows/experiment.ts:279).
- **Non-inferiority.** A test exists only inside toolevals compression
  (src/toolevals/compress.ts:162).
- **Judges.** Kappa with a bootstrap CI on a held-out split (src/judge/calibrate.ts:212,
  src/stats/agreement.ts:16), a Rogan-Gladen helper, and a `holm()` helper
  (src/stats/tests.ts:65).
- **Covered in the docs, partly unbuilt.** dynamic-benchmarks.md §4 already covers e-processes,
  BH/e-BH, EWMA/CUSUM, variance components, cost-optimal repeats, latency GMR, the cost
  frontier and Bradley-Terry. I don't repeat that theory here.

## One bug found while checking

The Rogan-Gladen correction in `exp compare` never fires. `correctedRate` reads `sensitivity`
and `specificity` from the grader's calibration (compare.ts:48-55), but `CalibrationStatus` only
stores kappa, n, split and state (src/datasets/types.ts:85-94). The comment at compare.ts:33-36
admits this. So every judge delta in compare is uncorrected today. See EM-5.

## A. Statistics inside one comparison

### EM-1. Cluster-aware (hierarchical) bootstrap

- **What:** Resample clusters of related cases (same repo, same source session, same task family),
  then cases within them, instead of treating cases as independent.
- **Sources:**
  - Kwa et al., "Measuring AI Ability to Complete Long Software Tasks", METR 2025,
    https://arxiv.org/abs/2503.14499. Three-level bootstrap: family, then task, then run.
    Tasks are weighted 1/sqrt(family size).
  - Mandujano Reyes, "Statistical Methods for Multiple Language Model Comparison on a Shared
    Evaluation", 2026, https://arxiv.org/abs/2608.22659 (abs). Recovers Miller's clustered
    estimator and extends it to K > 2.
  - Inspect AI ships `stderr(cluster=...)`, https://inspect.aisi.org.uk/reference/inspect_ai.scorer.html
- **Have it?** No. `pairedBootstrap` resamples single cases (src/stats/interval.ts:49).
  landscape.md §7 proposed a cluster key, but it never reached the queue. This matters most for
  X-2 (many decision points mined from one session) and for datasets built from one repo.
  Miller saw clustering inflate the SE by up to 3x.
- **Proposal:**
  - `stats.clusteredBootstrap(diffs, clusterIds, {weight: "equal"|"sqrt"})`.
  - `exp compare --cluster metadata.repo`, with a default of `metadata.cluster` when present.
  - Report the cluster count next to n, and warn when there are fewer than 10 clusters.
  - Bench and harness compare pick it up through the same helper.
- **Effort S. Value 8.**

### EM-2. Interleaved arms in `exp`

- **What:** Run A and B in one job queue, ordered by case and trial with the arm order shuffled,
  so provider drift, rate limits and time of day hit both arms equally.
- **Sources:**
  - Bjarnason, Silva, Monperrus, "On Randomness in Agentic Evals", 2026,
    https://arxiv.org/abs/2602.07150 (abs). On SWE-bench Verified, single-run pass@1 swings
    2.2-6.0 pp, the SD stays above 1.5 pp even at T=0, and runs diverge within the first few
    percent of tokens.
  - He et al., "Defeating Nondeterminism in LLM Inference", Thinking Machines 2025,
    https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/. Server batch
    size changes outputs at T=0: 80 unique completions out of 1,000.
- **Have it?** Only outside `exp`. `runExperiment` builds jobs for a single task
  (src/experiments/run.ts:121), and `exp compare` pairs two experiments that may have run days
  apart. X-3 (`exp ab`) also calls `runExperiment` once per arm.
- **Proposal:**
  - `exp run --arm a=task-a.json --arm b=task-b.json` schedules (case, trial, arm) in a seeded
    order and writes one ExperimentResult per arm with a shared `pairId`.
  - `compareExperiments` adds a `timingWarning` when the two arms' [createdAt, finishedAt]
    windows don't overlap.
  - X-3 should build on this.
- **Effort M. Value 7.**

### EM-3. Stop a run early once the answer is clear

- **What:** Check a valid sequential test after each paired case. Stop when B is clearly better,
  clearly worse, or clearly within ±δ. The case count is known in advance, which favours group
  sequential tests over open-ended mSPRT.
- **Sources:**
  - Johari, Pekelis, Walsh, "Always Valid Inference", 2015/2022,
    https://arxiv.org/abs/1512.04922 (abs).
  - Waudby-Smith, Ramdas, "Estimating means of bounded random variables by betting", 2020,
    https://arxiv.org/abs/2010.09686 (abs). Includes a without-replacement confidence sequence,
    which suits a fixed finite case set.
  - Spotify, "Choosing a Sequential Testing Framework", 2023,
    https://engineering.atspotify.com/2023/3/choosing-sequential-testing-framework-comparisons-and-discussions.
    Over 14 looks, a group sequential test reached power 0.93 against 0.72 for mSPRT.
  - Zhou et al., "CELEUS: Certifiable and Efficient LLM Evaluation via E-Processes", 2026,
    https://arxiv.org/abs/2606.20820 (abs). 54-62% fewer samples at the target precision.
  - Statsig ships mSPRT: https://docs.statsig.com/experiments/advanced-setup/sequential-testing
- **Have it?** No. X-17/X-18 detect a plateau across a series of experiments, and
  dynamic-benchmarks §4.5 puts e-processes under bench headline claims as NICE. Nothing stops a
  single A/B early.
- **Proposal:**
  - `exp run --arm … --stop-early [--looks 4] [--margin 0.03]`.
  - O'Brien-Fleming alpha spending at 25/50/75/100% of cases on the paired deltas, plus a
    betting confidence sequence for the live display.
  - The stored result records `stoppedAt` and the spending plan, so the CI is reported as
    sequential and not fixed-n.
  - Needs EM-2.
- **Effort M. Value 8.**

### EM-4. Attrition check (sample ratio mismatch for evals)

- **What:** Test whether errored, ungraded, timed-out or missing trials are unevenly split
  between arms. Uneven attrition biases a paired result the way SRM biases a web A/B test.
- **Sources:**
  - Fabijan et al., "Diagnosing Sample Ratio Mismatch in Online Controlled Experiments", KDD 2019,
    https://www.microsoft.com/en-us/research/?p=651990 (abs). SRM showed up in about 6% of
    Microsoft experiments and 10% at LinkedIn (https://lukasvermeer.nl/srm/docs/faq/).
  - Statsig SRM check: https://docs.statsig.com/guides/srm
  - Anthropic, "Demystifying evals for AI agents", 2026,
    https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents. Shared
    infrastructure failures break trial independence.
- **Have it?** Partly. compare warns when anything is ungraded (compare.ts:195-197) and lists
  onlyInA/onlyInB, but it never tests the imbalance. Task errors count as plain fails, with no
  infra/agent split.
- **Proposal:**
  - Per arm, count completed, errored, ungraded and missing trials.
  - Run an exact Fisher or chi-square test, and add `attritionWarning` at p < 0.01.
  - When the error strings look like infrastructure (timeout, spawn, HTTP 429/5xx), suggest
    `--retry-errors` (X-26).
- **Effort S. Value 6.**

### EM-5. Make judge correction real: persist confusion rates, then PPI++

- **What:** Correct judge-based deltas using the human-labelled calibration set. Rogan-Gladen
  needs sensitivity and specificity. PPI++ combines a few human labels with judge scores on every
  case, and its CI is never worse than human-only.
- **Sources:**
  - Angelopoulos, Duchi, Zrnic, "PPI++", 2023, https://arxiv.org/abs/2311.01453 (abs).
  - Boyeau et al., "AutoEval Done Right", 2024, https://arxiv.org/abs/2403.07008 (abs). Up to
    50% more effective labels.
  - Fisch et al., "Stratified PPI", 2024, https://arxiv.org/abs/2406.04291 (abs).
  - Zrnic, Candès, "Active Statistical Inference", 2024, https://arxiv.org/abs/2403.03208 (abs).
    Decides which cases humans should label.
  - GLIDE library, 2026, https://arxiv.org/abs/2605.31278 (abs). A reference implementation to
    test against.
  - Zhang et al., "Catching One in Five", 2026, https://arxiv.org/abs/2606.10315 (abs).
    Rogan-Gladen cannot recover a rate that the judge reports as zero.
- **Have it?** No (see the bug above). Queue #18 specs plain PPI with a ΔJ warning.
- **Proposal:**
  - Step 1 (S): `judge calibrate` stores sensitivity, specificity, positives and negatives in
    CalibrationStatus. That turns on the existing compare.ts code.
  - Step 2: extend #18 to PPI++ with the power-tuning λ, stratified by EM-1's cluster key.
  - Add a warning when judge sensitivity is below 0.5 or its pass rate is 0 or 1.
  - Use GLIDE outputs as test fixtures.
- **Effort S (step 1) + M (#18). Value 7.**

### EM-6. Honest intervals at small n

- **What:** Below about 100 cases, percentile bootstrap intervals under-cover. Use a Bayesian
  posterior on the paired outcome table instead: a Dirichlet over {A-only, B-only, both, neither}.
  Report P(B > A) and a credible interval.
- **Sources:**
  - Hariri et al., "Don't Pass@k: A Bayesian Framework for LLM Evaluation", ICLR 2026,
    https://arxiv.org/abs/2510.04265 (abs).
  - Bowyer et al. (already seen) and evalstats 2609.35815 (already seen) both warn against
    bootstrap CIs at N < 100.
- **Have it?** Partly. power.ts flags small n but still prints the percentile CI
  (interval.ts:49).
- **Proposal:**
  - `stats.pairedPosterior(b, c, ties, {prior: 1})`.
  - `exp compare` prints `P(B>A)=0.93` and switches the headline interval to the posterior when
    paired < 100, keeping the bootstrap in `--json`.
- **Effort S. Value 6.**

### EM-7. "Plausibly best" set when comparing more than two configs

- **What:** Picking the top of K configs is a selection event. Multiple Comparisons with the Best
  (MCB) returns the set of configs that could be best at 95%.
- **Source:** Jain, "The Leaderboard Lottery", ICML 2026, https://icml.cc/virtual/2026/80012
  (abs). Uncorrected, the reported winner was truly best only 0-58% of the time. Paired-bootstrap
  MCB restored at least 95% coverage.
- **Have it?** Partly. Bench shares places using Holm-adjusted pairwise tests (bench/stats.ts:241).
  `exp compare` takes exactly two experiments (src/cli/commands/exp.ts:93).
- **Proposal:**
  - `exp compare A B C …` gives a pairwise table plus a "best set" from a paired-bootstrap MCB.
  - Bench prints the same set next to places.
- **Effort S. Value 5.**

### EM-8. Total evaluation error: add prompt and judge variance

- **What:** Scores change with meaning-preserving prompt rewording and with the choice of judge.
  Treat both as random effects so the CI covers them.
- **Sources:**
  - Messing, "Hidden Measurement Error in LLM Pipelines", 2026, https://arxiv.org/abs/2604.11581
    (abs). Naive SEs were 40-60% too small, and coverage gets worse as n grows.
  - Romanou et al., "Brittlebench", 2026, https://arxiv.org/abs/2603.13285 (abs). One
    perturbation flipped rankings in 63% of cases.
  - Sclar et al., "FormatSpread", ICLR 2024, https://arxiv.org/abs/2310.11324 (abs).
- **Have it?** No. The paraphrase arm (2608.22331) is deferred in round 1. Each run has exactly
  one judge.
- **Proposal:**
  - `exp run --variants 3` runs each case under N seeded instruction paraphrases.
  - Optionally `--judges j1,j2` grades with more than one judge.
  - compare reports a variance split (case, trial, variant, judge) and a widened "TEE" interval
    next to the plain one.
- **Effort M. Value 6.**

### EM-9. Factorial grids: model x harness with an interaction term

- **What:** Cross factors (model, harness, prompt) in one paired design. Estimate main effects and
  their interaction instead of running separate A/Bs.
- **Sources:**
  - Liu et al., "Coding Agents Have Converged", ADMA 2026, https://arxiv.org/abs/2609.17394 (abs).
    Within one model, the scaffold moved scores by up to 29.8 pp, against an 8.8 pp spread across
    the top 30. McNemar separated 0 of 29 adjacent pairs.
  - Mandujano Reyes 2608.22659 (above) covers the K > 2 random-effects model.
- **Have it?** No. Bench runs K contenders but treats them as unrelated labels.
- **Proposal:**
  - `exp grid --factor model=a,b --factor harness=x,y` expands into interleaved arms (EM-2).
  - Report each main effect as a paired delta averaged over the other factor, plus the
    interaction (difference of differences) with a cluster bootstrap CI.
- **Effort M. Value 6.**

### Considered and not proposed: CUPED / control variates

- **Sources:** Deng et al., CUPED, WSDM 2013 (https://exp-platform.com/cuped/), Statsig CURE
  (https://statsig.com/blog/announcing-cure), Eppo CUPED++ (https://docs.geteppo.com/statistics/cuped/),
  and Zhou, Song, Zanette 2025 (https://arxiv.org/abs/2502.10563, abs).
- **Why not:**
  - CUPED removes variance that a pre-period covariate explains. In a paired design, the
    per-case difficulty it would capture is already differenced away, so the expected gain is
    small.
  - It helps only for single-arm estimates and unpaired online traffic.
  - Revisit with X-9 (`exp live`). The control-variate idea for human labels is better served by
    PPI++ (EM-5).

## B. Reliability and which cases to run

### EM-10. A/A runs and a stored noise floor

- **What:** Run the same config twice, interleaved. The observed delta, flip count and per-case
  flip rate show how much a "win" of that size could be noise. Store the result as the prior for
  power planning.
- **Sources:**
  - 2602.07150 (above): reported 2-3 pp gains may be noise.
  - Alvarado Gonzalez et al., "Do Repetitions Matter?", 2025, https://arxiv.org/abs/2509.24086
    (abs). 10 of 12 single-run slices inverted at least one rank.
  - Gonuguntla, "The Replay Gap", COLM 2026, https://arxiv.org/abs/2608.08239 (abs). Same-model
    control forks diverged in more than 90% of cases even at T=0.
- **Have it?** No. bench/stats.ts:220 assumes a discordance of 0.3 when there is no history.
- **Proposal:**
  - `exp aa <task> --dataset d [--trials 2]` prints the A/A delta with its CI, the McNemar flips,
    the flip rate and the empirical SD.
  - It saves `noise.json` per (dataset, task), which `pairedPower`/`powerPlan` read in place of
    the 0.3 default.
  - compare notes "A/A flip rate on this dataset: 9%".
- **Effort S. Value 7.**

### EM-11. Audit the test verifier, not only LLM judges

- **What:** Sample passing cases for a human "would merge" label to estimate the verifier's false
  positive rate, then correct pass rates the way judges are corrected.
- **Sources:**
  - METR, "Many SWE-bench-passing PRs would not be merged into main", 2026,
    https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/.
    The grader overstated success by 24.2 pp (SE 2.7). Human PRs merged only about 68% of the
    time, which served as the noise baseline.
  - METR, "Algorithmic vs. Holistic Evaluation", 2025,
    https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons.
    38% passed the tests; 0 of 15 were mergeable.
  - Vendrow et al., "Platinum benchmarks", 2025, https://arxiv.org/abs/2502.03461 (abs).
- **Have it?** No. `judge calibrate` takes LLM judges only. Exploit probes (#17) catch hacks,
  not "passes but wrong".
- **Proposal:**
  - Let `judge calibrate` accept any grader id, including command/test graders.
  - Add a `--sample-passes N` labelling queue (pairs with C-9).
  - Store precision on the grader. compare shows "verifier precision 0.78 (n=40)" and a corrected
    pass rate.
- **Effort M. Value 7.**

### EM-12. Item difficulty (IRT) and informative case selection

- **What:** Fit a Rasch/2PL model on stored per-case outcomes across configs. Use difficulty and
  discrimination to pick anchors, drop dead cases and run adaptive subsets.
- **Sources:**
  - Polo et al., "tinyBenchmarks", ICML 2024, https://arxiv.org/abs/2402.14992 (abs).
  - Kipnis et al., "metabench", ICLR 2025, https://arxiv.org/abs/2407.12844 (abs).
  - Hofmann et al., "Fluid Language Model Benchmarking", COLM 2025,
    https://arxiv.org/abs/2509.11106 (abs).
  - Li et al., "ATLAS", 2025, https://arxiv.org/abs/2511.04689 (abs).
  - Truong et al., "Reliable and Efficient Amortized Model-based Evaluation", ICML 2025,
    https://arxiv.org/abs/2503.13335 (abs). Predicts difficulty from item text.
  - Ge et al., "Agent psychometrics", 2026, https://arxiv.org/abs/2604.00594 (abs). Splits ability
    into LLM and scaffold parts.
  - Counterweight: Madaan et al., "Quantifying Variance in Evaluation Benchmarks", 2024,
    https://arxiv.org/abs/2406.10229 (abs). IRT barely reduced rerun noise.
- **Have it?** No. Bench sampling is seeded uniform within strata (bench/sample.ts:84). X-15
  (DeltaSelect) ranks tasks by correlation with the suite score, and Y-11 labels task history.
  Neither fits difficulty.
- **Proposal:**
  - `coding.sh cases fit --dataset d` fits a Rasch model by joint maximum likelihood, once at
    least 5 configs have run (fewer than that is refused).
  - It stores difficulty and discrimination per case.
  - Bench uses maximum information to pick the anchor set.
  - `exp run --sample informative:N` is available.
  - Local users rarely have many configs, which is why value is moderate.
- **Effort M. Value 5.**

### EM-13. Signal-to-noise per suite and per tag

- **What:** SNR is the spread between configs divided by the rerun spread within a config. Flag
  low-SNR tags or suites before trusting decisions made on them.
- **Source:** Heineman et al., "Signal and Noise", Ai2 2025, https://arxiv.org/abs/2508.13144
  (abs). Across 30 benchmarks and 375 models, higher SNR predicted more reliable small-scale
  decisions.
- **Have it?** No.
- **Proposal:**
  - Once EM-10 gives the noise term, `exp compare` and bench print SNR per metadata tag.
  - Tags with SNR < 1 are marked "too noisy to decide on".
- **Effort S (after EM-10). Value 5.**

## C. Judges

### EM-14. Pairwise judge with both-order scoring

- **What:**
  - A judge that sees A's and B's outputs for the same case.
  - It runs twice with the order swapped, and a win counts only when it holds in both orders.
    Otherwise the case is a tie.
  - It reports a position-consistency rate. A conformal abstain threshold is optional.
- **Sources:**
  - Wang et al., "Large Language Models are not Fair Evaluators", 2023,
    https://arxiv.org/abs/2305.17926 (abs).
  - Badshah et al., "SCOPE", ICML 2026, https://arxiv.org/abs/2602.13110 (abs). FDR held at 0.10
    while accepting 2.4x more judgments.
  - Jiang et al., "CodeJudgeBench", 2025, https://arxiv.org/abs/2507.10535 (abs). Pairwise beat
    pointwise on code tasks.
  - TRACE (round 1, already seen): comparing trajectories caught 63% of hacks against 45% for
    judging one alone.
  - LangSmith has `randomize_order`: https://docs.langchain.com/langsmith/evaluate-pairwise
- **Have it?** No. src/judge has pointwise and checklist judges only. A pairwise judge is the
  only place position bias applies, so there is no bias handling today either.
- **Proposal:**
  - `kind: "pairwise"` in src/judge. `exp compare --pairwise <judge>` grades shared cases from
    both stored outputs and reports a win rate with a CI, the tie rate and the position-flip
    rate.
  - Calibration reuses the human-label path (labels become A/B/tie).
- **Effort M. Value 7.**

### EM-15. Length and diff-size control for judges

- **What:** Regress judge verdicts on the length difference and report a length-controlled delta.
- **Source:** Dubois et al., "Length-Controlled AlpacaEval", COLM 2024,
  https://arxiv.org/abs/2404.04475 (abs). Spearman correlation with Arena rose from 0.94 to 0.98.
- **Have it?** No.
- **Proposal:**
  - Store output chars, and diff lines when there is a patch, on each grade.
  - compare reports the correlation of the judge delta with the length delta, and a
    length-controlled delta when |r| > 0.3.
- **Effort S. Value 4.**

### EM-16. Judge juries

- **What:** Pool 3 small judges from different vendors instead of using one big judge.
- **Source:** Verga et al., "Replacing Judges with Juries (PoLL)", 2024,
  https://arxiv.org/abs/2404.18796 (abs). More than 7x cheaper, with less self-family bias.
- **Have it?** No. Round 1 deferred multi-judge panels (2605.09702).
- **Proposal:**
  - A `jury` grader wraps N judges with a majority or mean vote.
  - Calibration runs on the pooled verdict.
  - EM-8 gets judge variance for free.
- **Effort M. Value 5.**

## D. Experiment design and loops

### EM-17. Racing for config sweeps (successive halving)

- **What:**
  - Run all candidates on a small case batch, then drop those clearly worse than the leader.
  - Double the batch and repeat.
  - Confirm the finalists on held-out cases.
- **Sources:**
  - Shi et al., "TRIPLE: best-arm identification for prompt learning", 2024,
    https://arxiv.org/abs/2402.09723 (abs).
  - Li et al., "Hyperband", JMLR 2018, https://arxiv.org/abs/1603.06560 (abs).
  - Hu, Tang, "The Winner's Curse in LLM Self-Improvement Loops", 2026,
    https://arxiv.org/abs/2610.09239 (abs). With 16 selection items, final scores were 13-20 pts
    above held-out; with 256, 1-5 pts above.
  - Xu et al., "SIREN", 2026, https://arxiv.org/abs/2605.05973 (abs).
- **Have it?** No sweep command. Bench and harness compare run every contender on every case.
  R2-8 has a dev/held-out split for refine but no racing.
- **Proposal:**
  - `exp sweep cfgs/*.json --dataset d --budget 400`.
  - Rounds of 25/50/100 cases, dropping a config when its paired upper bound against the leader
    is below −δ (Holm within the round).
  - The final report re-scores the start config and the winner on an untouched split, and prints
    the optimism gap.
  - Uses EM-2 for scheduling.
- **Effort M. Value 7.**

### EM-18. Guardrail metrics and a multi-metric verdict

- **What:**
  - Have one primary metric that must improve, plus guardrails (cost, p90 latency, error rate,
    turns) that must be non-inferior within a margin.
  - Report a single ship/hold/tradeoff verdict.
- **Sources:**
  - GrowthBook and Statsig guardrails, https://docs.growthbook.io/statistics/overview
  - Braintrust "Comparison grade" (Improvement/Regression/Tradeoff/Tie),
    https://docs.braintrust.dev/evaluate/compare-experiments
  - Lamichhane, Carmichael, "Where Should the Marginal Dollar Go?", NeurIPS 2026,
    https://neurips.cc/virtual/2026/173054 (abs). Cost per additional correct answer ranged
    $1.32-$3.53, and list prices within 3% of each other gave about 2x different spend.
- **Have it?** Partly. There is non-inferiority in toolevals (compress.ts:162). Latency is
  summarized per experiment, but `exp compare` gives only a pass-rate verdict. V-11 plans a
  shared verdict model but doesn't spec guardrails. Separately, CaseRun has no cost or token
  fields (src/datasets/types.ts:152-168), so `exp` cannot report cost per solved at all; queue
  #10 covers this only for harness compare.
- **Proposal:**
  - `exp compare --guard latency.p90:+15% --guard errors:+2pp [--guard cost:+20%]`.
  - Each guard gets a paired non-inferiority bound; latency uses a log-ratio bootstrap.
  - The verdict is ship (primary better, all guards hold), tradeoff, hold or inconclusive.
  - Add optional `usage` and `costUsd` to CaseRun, filled from `withTrace` or an output envelope,
    and report Δcost per extra solved case (an incremental cost ratio) with a bootstrap CI.
- **Effort M. Value 7.**

### EM-19. Control forks for any replay or continuation experiment

- **What:** When an experiment resumes from a recorded prefix, also run the original config from
  the same prefix (A vs A'), and never score a stitched log as an outcome.
- **Sources:**
  - 2608.08239 (above): only 3% of replayed states stayed valid, and the log-stitching evaluator
    got every outcome wrong.
  - Bhanushali, "ARC-DR", NeurIPS 2026, https://neurips.cc/virtual/2026/168256 (abs).
    Intercepting the first irreversible action gave rank correlation 0.83 across 24 variants.
- **Have it?** Not applicable yet. It affects specs X-1 (continuation tasks), X-7 (workspace
  rebuild) and X-11 (record/replay proxy).
- **Proposal:**
  - Add a required control arm to the X-1 and X-7 specs. Report the control's divergence rate
    as the replay noise floor.
  - X-7 refuses outcome scoring when it can't re-execute.
- **Effort S (spec edit). Value 6.**

### Considered and not proposed

- **Off-policy evaluation from logged traces** (Bhargava et al. 2024,
  https://arxiv.org/abs/2406.10030; Kiyohara et al. 2025, https://arxiv.org/abs/2504.02646).
  Both need logged action propensities, and local sessions have none. EM-19 is the practical
  version.
- **Interleaving in the search sense** (Chapelle et al., TOIS 2012,
  https://authors.library.caltech.edu/49362). It merges two rankings in one response, which an
  agent run has no analogue for, except tool or retrieval choice inside one run.
- **Novelty effects.** These need users exposed over time. Revisit only with X-9.
- **Prompt optimization loops** (LangSmith promptim, Phoenix prompt learning, Braintrust Loop).
  Already planned as refine (R2-5..R2-8). EM-17's held-out re-score is the missing statistical
  piece.

## Competitors, checked 2026-11-07

- **Braintrust:**
  - Has trials, a pinned or git-branch baseline, per-row regressions and a "Comparison grade"
    across quality, cost, latency and errors.
  - Has Battle/Summary comparative scorers.
  - No CIs or significance tests were found in its docs.
  - Sources: https://docs.braintrust.dev/evaluate/compare-experiments,
    https://docs.braintrust.dev/evaluate/advanced-evaluations
- **LangSmith:**
  - `num_repetitions` with mean and std.
  - A baseline compare view with red/green rows.
  - Pairwise evaluation with an optional `randomize_order`.
  - A promptim optimizer.
  - No significance tests.
  - Sources: https://docs.langchain.com/langsmith/repetition,
    https://docs.langchain.com/langsmith/evaluate-pairwise
- **Langfuse:**
  - A baseline run, quality/cost/latency charts and per-item side by side.
  - No repetitions or CIs found.
  - Source: https://langfuse.com/docs/evaluation/experiments/compare-experiments
- **W&B Weave:**
  - Trials, "Make baseline", delta badges, and per-example scatter for two evals.
  - Warns when the dataset or scorer differs.
  - No CIs.
  - Source: https://docs.coreweave.com/weave/guides/evaluation/compare_evals
- **Phoenix:**
  - Repetitions with an average, and a baseline that shows correct/incorrect flips.
  - Prompt learning without a formal holdout.
  - Source: https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/repetitions
- **Inspect AI:**
  - Epoch reducers (mean, median, mode, max, pass_at(k), at_least(k)).
  - `stderr(cluster=...)`, `bootstrap_stderr` (no cluster option) and `grouped()`.
  - No paired test between runs.
  - Source: https://inspect.aisi.org.uk/metrics.html
- **promptfoo:**
  - `--repeat`, `--filter-failing` and a `select-best` judge with no order handling.
  - Source: https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/select-best/
- **Statsig (and GrowthBook):**
  - mSPRT sequential testing, CUPED, SRM chi-square and guardrails.
  - Statsig AI Evals turns grader scores into experiment metrics on live traffic, but documents
    no eval-side statistics.
  - Source: https://docs.statsig.com/ai-evals/overview

**Read:** none of the LLM eval tools documents a paired test or a CI on the difference between
two runs, so our paired bootstrap plus McNemar is already ahead.

**Where they lead:**

| Gap | Competitor | Our item |
|---|---|---|
| Clustered SEs | Inspect | EM-1 |
| Pairwise judges with order randomization | LangSmith | EM-14 |
| Multi-metric verdicts including cost | Braintrust | EM-18 |
| Sequential testing and SRM | Statsig, GrowthBook | EM-3, EM-4 |
| Custom pairing key | Braintrust's SQL comparison key | Small; could fold into EM-1's `--cluster` flag parsing |

## Ranked top 10 for the queue

The score is value / effort (S=1, M=2), using the queue's rules: ties go to the experiment loop,
then to higher value.

| Rank | ID | Item | Module | Effort | Value | Needs |
|---|---|---|---|---|---|---|
| 1 | EM-1 | Cluster-aware bootstrap + `--cluster` | src/stats, src/experiments | S | 8 | none |
| 2 | EM-10 | `exp aa` noise floor stored for power planning | src/experiments | S | 7 | (EM-2 for interleaving) |
| 3 | EM-5a | Persist judge sensitivity/specificity so the Rogan-Gladen path fires (then PPI++ in #18) | src/judge | S | 7 | none |
| 4 | EM-4 | Attrition (SRM) check + infra/agent error split | src/experiments | S | 6 | none |
| 5 | EM-6 | Bayesian paired posterior, P(B>A), at n < 100 | src/stats | S | 6 | none |
| 6 | EM-3 | Group sequential early stopping for `exp` A/B | src/experiments, src/stats | M | 8 | EM-2 |
| 7 | EM-2 | Interleaved arms in `exp run` + timing warning | src/experiments | M | 7 | none |
| 8 | EM-18 | Guardrails + ship/tradeoff verdict + cost in CaseRun | src/experiments | M | 7 | (V-11, C-1) |
| 9 | EM-17 | `exp sweep` racing + held-out optimism gap | src/experiments | M | 7 | EM-2 |
| 10 | EM-14 | Pairwise both-order judge | src/judge | M | 7 | none |

Next in line: EM-11 (verifier precision audit, M 7), EM-19 (control forks, S 6, spec edit),
EM-8 (TEE variance, M 6), EM-9 (factorial grid, M 6), EM-7 (MCB best set, S 5), EM-13 (SNR,
S 5), EM-12 (IRT, M 5), EM-16 (juries, M 5), EM-15 (length control, S 4).

**Can run in parallel:**

- EM-1, EM-6 and the stats half of EM-3 add new functions in src/stats; each goes in its own new
  file.
- EM-5a touches src/judge/calibrate.ts and src/datasets/types.ts.
- EM-4 and EM-10 touch compare.ts and a new aa.ts. Land EM-4 before EM-2, since both edit
  compare.ts.
