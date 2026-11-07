# Round 1 research scout: papers

Scout: "papers". Date: 2026-11-06. Window: Nov 2025 to Nov 2026, newest first where possible.
There was no `docs/research/` directory before this file. The prior-art list in
`docs/TOOL-EVALS.md` §9 already covers MCPMark, MCP-Universe, MCP-Bench, mcp-evals,
Terminal-Bench 2.0 / Harbor, tau/tau2-bench and LiveMCPBench, so those are skipped here.

Method: arXiv search on each topic in the brief. For each candidate I read the abstract page
(and the HTML full text where the abstract left out the method), then kept only findings that
change what coding.sh should build. Numbers below are the papers' own. "(abs)" means I only
saw the abstract.

## What the code does today (relevant to these findings)

- `src/runner/run.ts` runs the verifier in the agent's own work tree after the agent exits.
  Only `task.verifier.hiddenFiles` are written back. Everything else the agent wrote stays
  live, including a root `conftest.py`, `sitecustomize.py`, `.npmrc` `node-options`,
  `package.json` scripts and Makefile targets. That is BenchJack's flaw class V1, and the
  SWE-bench exploit it describes works unchanged here.
- `src/eval/validate.ts` checks no-op, reference k/k, near-misses (hunk drops) and text
  leakage. It never tries an adversarial "pass without solving" patch.
- `src/judge/prompt.ts` wraps agent output in `<output>…</output>` and doesn't escape it, so
  output containing `</output>` plus instructions reaches the judge as prompt text (V4).
- `src/judge/calibrate.ts` reports κ, confusion and fail-recall against human labels on a
  held-out split. Nothing measures whether a judge actually reads the trace.
- `src/experiments/compare.ts` compares raw judge-score means between arms, with no
  correction for judge error and no check that judge error is the same in both arms.
- `src/runner/experiment.ts` reports cost/tokens/turns per run, Wilson intervals, a paired
  bootstrap and McNemar. It doesn't report tokens per solved task, pass^k, flaky tasks, or
  how many tasks are needed.
- `src/core/sessions.ts` sets four flags: premature-completion, repeated-tool-failure,
  no-verification and compaction. It has no user-pushback, search-loop, edit-revert or
  test-tamper detection.

## Findings that change the build

### A. Verifier and reward-hacking robustness

- **BenchJack: "Do Androids Dream of Breaking the Game?"** Wang, Li, Mang, Cheung, Sen, Song.
  May 2026. https://arxiv.org/abs/2605.12673 (HTML: https://arxiv.org/html/2605.12673v1)
  - Eight flaw classes: V1 isolation failure, V2 answers shipped with the test, V3 RCE into the
    evaluator, V4 judge prompt injection, V5 weak string match, V6 evaluation-logic gaps,
    V7 trusting agent-writable output, V8 excessive permissions.
  - SWE-bench exploit: the agent adds a root `conftest.py` whose pytest hook rewrites every
    report to "passed" and clears test items. FrontierSWE exploit: the agent writes
    `reward.json` into the verifier's log dir.
  - Synthesized exploits got near-perfect scores on most of 10 benchmarks without solving
    anything. 219 flaws found. An adversarial patch loop cut the hackable-task share from about
    100% to under 10% on four benchmarks.
  - Checklist category C.7 is pre-release adversarial smoke tests.
  - → Items 1 (runner restores verifier-owned paths), 2 (exploit probes in validation) and
    3 (judge injection hardening).
- **EvilGenie: A Reward Hacking Benchmark.** Gabor, Lynch, Rosenfeld. Nov 2025, revised May 2026.
  https://arxiv.org/abs/2511.21654 (abs)
  - Measures hardcoded tests and edited test files using held-out tests, an LLM judge and
    test-file-edit detection.
  - Claude Code and Codex both reward-hacked explicitly. Held-out tests added "only minimal
    improvement"; the judge worked best on unambiguous cases.
  - → Items 1 and 7 (test-edit detection as a run integrity flag and a session flag).
- **SpecBench.** Zhao, Srikanth, Wu, Jiang. May 2026. https://arxiv.org/abs/2605.21384 (abs)
  - Visible per-feature tests vs held-out tests that combine features; reward hacking is
    measured as the pass-rate gap.
  - Every frontier agent passes nearly all visible tests, but a held-out gap remains. It grows
    about 28 pp per 10× code size and is larger for smaller models. One agent built a
    2,900-line "compiler" that memorizes test inputs.
  - → Later item: let a task ship visible plus held-out verifiers and report the gap. Not in this
    round's top 8.
- **Building to the Test.** Ma, Kereopa-Yorke, Schultz. Jun 2026. https://arxiv.org/abs/2606.28430 (abs)
  - With a hidden 222-test Playwright oracle in the loop, Copilot CLI agents (opus-4.7,
    gpt-5.5) scored near-perfect while the requested library was dead or absent.
  - The authors check every verdict with a mechanical audit plus a no-op ablation.
  - → Supports items 1 and 2: a pass needs structural checks, not only an exit code.
- **TRACE: Reward hack detection via contrastive analysis.** Deshpande, Kannappan, Qian. Jan 2026.
  https://arxiv.org/abs/2601.20103 (abs)
  - 517 trajectories and a 54-category exploit taxonomy.
  - The best judge detects 45% of hacks when judging one trajectory alone and 63% when
    comparing trajectories.
  - → A judge that compares the A and B arms' trajectories for the same task beats one that
    judges each alone. This is a later item for `src/judge`.
- **BaitBench** (https://arxiv.org/abs/2608.30724) reports 57.1% of runs judged as hacking when
  shortcuts were planted. **Reward Hacking Benchmark** (ICML 2026,
  https://arxiv.org/abs/2605.02964) covers tool-using agents tampering with evaluation
  functions. Both corroborate A; not read in depth.
- **Validity audits.**
  - Tool-calling (https://arxiv.org/abs/2607.02577): unchanged DB state lets failed runs pass.
  - Computer-use (https://arxiv.org/abs/2607.28367): 15.3% of audited FAIL verdicts were wrong.
  - Verifier building for CUAs (https://arxiv.org/abs/2604.06240): native verifier false
    positives are above 20%.
  - → coding.sh's no-op/near-miss validation is the right shape; exploit probes (item 2) close
    the remaining hole.

### B. LLM-as-judge reliability and statistics

- **trajectory-judge: What Outcome-Only LLM Judges Miss.** Mohammadi. Aug 2026, v4 Nov 2026,
  NeurIPS 2026 workshop. https://arxiv.org/abs/2609.00038
  - Raw recall overstates judges. The proposed metric is paired discrimination: flag rate on
    faulty runs minus flag rate on their clean parents.
  - An outcome-only 14B judge shows 34–76% "recall" on reply-unchanged faults with zero paired
    discrimination. Told to check each step, the same model flags all faults and 0 of 100
    clean runs.
  - → Item 4 (trace-only mutations plus paired discrimination in judge calibration).
- **Efficient Inference for Noisy LLM-as-a-Judge Evaluation.** Chen et al. Jan 2026.
  https://arxiv.org/abs/2601.05420 (abs)
  - Rogan-Gladen misclassification correction vs prediction-powered inference (PPI). EIF-based
    estimators unify the two, and PPI has strictly smaller variance under stated conditions.
- **How to Run Statistics over LLM Judges and Trust the Results (evalstats).** Arawjo. Sep 2026.
  https://arxiv.org/abs/2609.35815 (abs)
  - Raw judge scores inflate false positives, and the risk peaks at "almost perfect"
    human-LLM agreement.
  - PPI versions of 9 tests, including Wilcoxon and Mann-Whitney. Bootstrap-adaptive PPI++
    tuning for small calibration sets.
  - Cautions against bootstrap CIs at N<100.
- **Bias and Uncertainty in LLM-as-a-Judge Estimation.** Fiedler. May 2026.
  https://arxiv.org/abs/2605.06939 (abs)
  - Sharing one calibration across the models being compared can flip the sign of the
    difference while looking confident. Proposes judge quality J and cross-model calibration
    instability ΔJ as diagnostics.
  - → Item 5: per-arm PPI correction, plus a ΔJ warning in experiment compare.
- **Calibrate, Don't Curate.** Li. May 2026. https://arxiv.org/abs/2605.09702 (abs)
  - Keeping the full calibrated judge panel beats top-k-by-accuracy selection (RewardBench2 NLL
    0.006 vs 0.013). → Later: multi-judge panels in `src/judge`.
- **Process evaluation measures three different levels.** He et al. Aug 2026.
  https://arxiv.org/abs/2608.22960 (abs)
  - Full-trace judges show collider bias, and step-level "credit" often measures semantic
    relevance, not causal contribution. → Caveat for item 4: treat judge citations of steps as
    evidence, not attribution.
- **MobileJudgeBench** (https://arxiv.org/abs/2608.11434) offers 931 human-labelled trajectories
  for judge benchmarking. Not adopted.

### C. Harness/scaffold effects, noise and sample size

- **The Scaffold Effect in Coding Agents.** Vats, Golev. Jun 2026. https://arxiv.org/abs/2607.22585 (abs)
  - Goose / OpenCode / OpenHands-SDK × 2 models on 50 Terminal-Bench Pro tasks.
  - Up to **40× tokens per solved task** between harnesses, while pass-rate gaps were 0–8 pp
    (CIs include 0).
  - "No-action turns" are a wait tax. Failure fingerprints are per harness (OpenCode: idle-loop,
    TIME; OpenHands: VERIFY, MAX_TURNS).
  - → Item 6 (tokens/cost per solved task in compare) and item 7 (loop flags).
- **Stop Comparing LLM Agents Without Disclosing the Harness.** Zhang et al. May 2026.
  https://arxiv.org/abs/2605.23950 (abs)
  - Harness variance can exceed model variance and reverse rankings. Proposes a disclosure
    standard and a variance decomposition. coding.sh's content-hashed `HarnessBundle` plus
    `diffBundles` already discloses the harness.
- **Same Model, Different Harness** (https://arxiv.org/abs/2608.26218): a context-management
  change doubled fail-to-pass under a tight window. **Harness or Model?**
  (https://arxiv.org/abs/2609.11987) and **Scaffold Effects on GAIA**
  (https://arxiv.org/abs/2606.08529) corroborate.
- **Identical Runs, Different Results.** Ariño de la Rubia, Pafka. Sep 2026.
  https://arxiv.org/abs/2609.33812 (abs)
  - 584 runs; within-pairing variance exceeded between-pairing differences. Resolving the
    differences would take tens to more than 100 runs per arm.
  - Under 5% of runs broke data rules, and those scored highest.
  - Cost differed more than 20× for the same model, mostly from caching.
  - → Item 6 (power/k planning, flaky tasks) and item 1 (report compliance next to pass).
- **Efficient Benchmarking of AI Agents.** Ndzomga. Mar 2026. https://arxiv.org/abs/2603.23749 (abs)
  - Absolute scores don't transfer across scaffolds, but ranks do. Running only tasks with
    30–70% historical pass rate cuts tasks by 44–70% and keeps rankings.
  - → Later item: `--informative` task subset for experiments.
- **Noise Floor Audit.** Chen et al. Aug 2026. https://arxiv.org/abs/2608.22331 (abs)
  - At T=0, ever-flip on reruns is 0.7–2.7%. Semantics-preserving prompt rewording gives 11–58×
    larger paired SD than reruns. → Later item: instruction-paraphrase robustness arm.
- **Towards a Science of AI Agent Reliability.** Rabanser, Kapoor, …, Narayanan. ICML 2026.
  https://arxiv.org/abs/2602.16666 (abs)
  - 12 metrics over consistency, robustness, predictability and safety. Capability gains gave
    only small reliability gains. → pass^k and flake rate in item 6 are its consistency metrics.
- **AgentLens** (https://arxiv.org/abs/2607.06624, abs): 16 of 32 scenario points were flaky
  across 5 repeats, so variance concentrates in a few tasks. → Item 6 flaky-task list.

### D. Trajectory analysis and failure attribution

- **What Resolve Rate Hides (TraceProbe).** Shu et al. Jul 2026. https://arxiv.org/abs/2607.06184 (abs)
  - 2,500 SWE-bench Verified trajectories normalized to a 9-type action taxonomy.
  - Rule-based anti-patterns: search loops (the most stable signal) and verification skips.
  - A pairwise "converge" module classifies where two runs diverge.
  - → Item 7 (search-loop, edit-revert). coding.sh's `firstDivergence` is the converge analogue.
- **Failure as a Process.** Zhao et al. Jul 2026. https://arxiv.org/abs/2607.09510 (abs)
  - 1,794 annotated Terminal-Bench trajectories across 3 scaffolds × 7 models.
  - Failures are mostly epistemic, start within the first few steps, and stay hidden until
    unrecoverable. → Divergence and flags should point to early steps; the viewer should
    surface the first flagged step.
- **TrajAudit.** Wang, Xie, Huo. May 2026. https://arxiv.org/abs/2605.26563 (abs)
  - Investigator agent with saliency folding plus test-failure-report priors. RootSE has 102
    instances labelled with the earliest decisive error step. +10.8 / +21.6 pp over baselines.
  - → Later item: `coding.sh explain <run>` uses the verifier output as the prior.
- **Strained Coherence.** Pandya, Zhang, Lyu. Jun 2026. https://arxiv.org/abs/2606.07889 (abs)
  - Detects an agent stating a problem and then acting against it. Flagged runs failed 94% vs
    46% (n=44, p=0.003); the first flag lands at about 83% of elapsed time.
  - Small n. → Later judge rubric, not built now.
- **Model or Harness? Interaction-centric taxonomy.** Raj et al. (Scale). Jul 2026.
  https://arxiv.org/abs/2607.28802 (abs)
  - 41 failure modes keyed by interaction edge plus fault side. A judge reaches κ=0.76 vs humans.
  - → Later: use the fault side (model / harness / env / grader) as the label vocabulary for
    run triage.
- Also seen, not adopted: CodeTracer (2604.11641); FALAT (2606.00765); Who&When baseline;
  awesome-agent-trajectory list (https://github.com/YintongHuo/awesome-agent-trajectory).

### E. Real sessions → evals (coding.sh's core loop)

- **How Coding Agents Fail Their Users.** Tang et al. May 2026, v2 Aug 2026.
  https://arxiv.org/abs/2605.29442 (HTML read)
  - 20,574 real sessions (SpecStory and Entire SWE-chat) covering Cursor, Copilot, Claude Code,
    Codex, OpenCode and Gemini CLI.
  - Misalignment is defined by later developer pushback. An LLM extractor plus an evidence
    check reaches 0.93 precision.
  - Forms: constraint violation 38.3%, misread intent 27.0%, inaccurate self-reporting 22.6%,
    faulty implementation 17.8%, wrong diagnosis 11.6%, overreach 10.2%, operational error 2.9%.
  - 91.5% of resolutions needed explicit user correction.
  - → Item 7 (`user-pushback` flag) and item 8 (pushback as the strongest eval-candidate signal).
- **SWE-Together.** Jun 2026. https://arxiv.org/abs/2606.29957 (HTML read)
  - 11,260 recorded sessions → 109 tasks (0.97% conversion).
  - Deterministic filter: multiple genuine user messages, concrete agent edits, repo
    identifiable, final change not mainly human-authored.
  - LLM viability screen: reject deliverables that depend on PRs, deploys, credentials or live
    services.
  - Scores pass@1, a stable solve rate and pass², plus a "User Correction" metric (corrections
    + 0.2 × nudges) that correlates −0.92 with pass@1.
  - → Item 8 (rank captured sessions as eval candidates with the deterministic filter).
- **SWE-chat** (https://arxiv.org/abs/2604.20779) is the dataset behind both.
  **Do Personalized Skills Help Coding Agents?** (https://arxiv.org/abs/2608.10319, abs) found
  task-specific skills beat developer-personalized ones under session replay. Useful as a
  harness-lab case study later.

### F. Contamination

- **Measurement-First Auditing of Agentic Leaderboards.** Yang et al. Oct 2026.
  https://arxiv.org/abs/2610.05830 (abs)
  - The file-path memorization gap on SWE-bench Verified ("SWE-Bench Illusion", 2506.12286;
    replicated in 2512.10218) is inconclusive under matched controls. A +10 pp gap had a CI
    that includes 0, and their scorer failed validation.
  - → Low priority for coding.sh. Tasks come from the user's own private sessions, so training
    exposure is unlikely. The channel that matters is eval-time leakage, which `validate.ts`
    already scans (future commits, history, instruction overlap). Don't build a contamination
    probe.

### G. Tool descriptions (MCP)

- **MCP Tool Descriptions Are Smelly!** Hasan et al. Feb 2026, v3 May 2026.
  https://arxiv.org/abs/2602.14878 (abs)
  - 97.1% of 856 tools have at least one smell, and 56% have an unclear purpose.
  - Augmenting every component: +5.85 pp median success, but +67.46% steps and regressions in
    16.67% of cases. Compact component subsets kept most of the gain.
  - → `docs/TOOL-EVALS.md` §8.3 compression mode should also gate on steps per task, not only
    success and invalidRate. Doc follow-up, not in the top 8.
- **From Docs to Descriptions** (https://arxiv.org/abs/2602.18914): 73% of descriptions repeat
  the tool name. Corroborates.

## Candidate improvements (round 1)

These eight are returned to the orchestrator as structured items:

1. `src/runner`: verifier isolation (restore verifier-owned paths) plus per-run integrity
   findings.
2. `src/eval`: exploit probes in `validateTask` (BenchJack C.7).
3. `src/judge`: prompt-injection hardening plus an injection flip-rate probe.
4. `src/judge`: trace-only mutations plus paired discrimination (is the judge trace-blind?).
5. `src/experiments`: PPI-corrected judge deltas with per-arm calibration and a ΔJ warning.
6. `src/runner`: compare reliability/efficiency block (tokens per solved task, pass^k, flaky
   tasks, tasks-needed estimate).
7. `src/core`: new session flags (user-pushback, search-loop, edit-revert,
   test-edit-after-failure).
8. `src/eval`: ranking captured sessions as eval candidates (SWE-Together filter plus pushback).

Same-directory pairs touch disjoint files, so they can run in parallel:

- Items 1 and 6: `run.ts` + new `integrity.ts` vs `experiment.ts`.
- Items 2 and 8: `validate.ts` + new `probes.ts` vs new `candidates.ts`.
- Items 3 and 4: `prompt.ts` + new `injection.ts` vs new `discriminate.ts`.

Deferred, with evidence above:

- visible/held-out verifier gap (SpecBench);
- contrastive A/B trajectory judge (TRACE);
- mid-difficulty task subset (2603.23749);
- paraphrase-robustness arm (2608.22331);
- TrajAudit-style `explain`;
- fault-side triage labels (2607.28802);
- multi-judge calibrated panels (2605.09702);
- a steps gate in TOOL-EVALS compression.
