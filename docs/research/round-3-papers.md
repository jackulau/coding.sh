# Round 3 research scout: papers

Scout: "papers". Date: 2026-11-17. Window: Nov 2025 to Nov 2026, newest first.
I skipped every source already in `docs/research/*.md`, including `round-2-papers.md`. Round 2
read arXiv ids up to about 2611.17304; this round reads newer ids and older ids that round 2 did
not cover.

Method: I searched the arXiv API on each topic in the brief, sorted by submission date. I read the
abstract of each candidate and the method section of its HTML full text when the abstract looked
like it changed the build. I kept only findings that change what coding.sh should build. The
numbers below are the papers' own. "(abs)" means I read only the abstract.

None of the round-2 candidates (termination lag, missing mass, environment mismatch, unreachable
goal, objective grader, boundary labels, wild cluster rule) are in the code yet. I do not propose
them again here.

## What the code does today (relevant to these findings)

- **Judge checks.**
  - `src/judge/pairwise.ts` measures position bias from both orders.
  - `src/judge/calibrate.ts` reports Cohen's kappa against human labels on a held-out split.
  - `src/judge/panel.ts` takes the median of a judge panel and watches anchors for drift.
  - `src/judge/discriminate.ts` mutates a trace (`MUTATION_OPS`: skipped verification, failing
    final test, ignored tool error, destructive command, constraint violation) and asks whether
    the judge prefers the original.
  - Nothing reruns a judge on the same item to measure whether its verdict repeats.
    `src/judge/cache.ts` returns the stored verdict, so a second run sees the first verdict.
  - Nothing shows the judge a compacted, summarized or delegated version of the same trace.
- **Duplicate work.** `src/core/waste.ts` counts duplicate read-only calls. A
  `context.compact` event clears the scope, so a re-read after a compaction is not counted
  anywhere. That re-read is the cost of the compaction, and coding.sh does not measure it.
- **Failures.** `src/core/failures.ts` splits failed calls into benign, interrupted and real.
  Nothing detects a shell call that failed because the harness or the shell mangled its quotes or
  backslashes, or a retry that differs only in quoting.
- **Harness audit.** `src/core/memory-audit.ts` (`harness audit`) counts how often each memory,
  rule, AGENTS.md and skill file is loaded, read and written. It does not read what the file
  says. `src/refine/protect.ts` stops refine from deleting safety lines, but nothing flags an
  existing file that tells the agent to skip checks.
- **Experiments.** `src/experiments/aa.ts` runs A/A tests and `src/experiments/continuation.ts`
  replays one next turn with a control arm. No experiment has a length-matched neutral arm, so an
  A/B of "AGENTS.md with advice" against "no AGENTS.md" cannot separate the advice from the extra
  context.
- **Leakage.** `src/eval/leakage.ts` checks whether a task's instruction already contains its
  answer. Nothing checks whether the agent states facts that only the hidden verifier knows, and
  no score is reported with such runs counted as failures.
- **Already covered elsewhere.** `src/stats/validity.ts` reports signal AUROC within task and
  within task and arm, which covers the confounding findings in 2610.35971 and 2611.20297.
  `src/bench/grid.ts` covers model by harness rank reversals. `src/core/rules.ts` covers context
  file adherence. `src/experiments/sweep.ts` and `src/stats/pareto.ts` cover budgeted selection.

## Findings that change the build

### A. Verifier verdicts do not survive trace abstraction

Source: "Do Verifier Judgments Survive Abstraction?", https://arxiv.org/abs/2611.18471

- **Method.** The authors build three views of a native agent trace. Each view replaces a region
  with a boundary marker that has a stable ID:
  - **Macro:** a contiguous block of two or more call/result pairs becomes one macro action.
  - **Delegation:** a block becomes one delegation call and its returned result.
  - **Compaction:** earlier history becomes a summary, and the final call/result pair is kept.
- **Restoration variants.** Restoration reinserts stored provenance for a marker:
  - Requery;
  - LossyR (action and tool names only);
  - ExactR (the exact original pairs).
- **Metric.** The verification transport failure rate (VTFR) is the share of verdicts that were
  correct on the native trace and became wrong, or became no verdict, on the view. The two
  outcomes are reported separately.
- **Results.**
  - Pooled VTFR is 31.0% for macro, 30.9% for delegation and 20.3% for compaction.
  - A single LLM judge fails less often than a deliberative one: 16.4, 17.3 and 14.1% against
    49.3, 50.2 and 30.7%. The deliberative judge fails mostly by abstaining.
  - Exact restoration recovers 85.5% of the failures (87.9, 86.9 and 79.8%).
- **What it changes.** coding.sh judges traces from agents that compact and delegate (Claude Code
  subagents, Codex compaction). A judge that passes `judge discriminate` on native traces can
  still fail on the traces coding.sh actually stores. `judge discriminate` should be able to show
  the judge the same trace as a compacted or delegated view and report how often the verdict
  changes.

### B. A judge that repeats its verdict can still be wrong

Sources:

- "All Verdicts are Not Equal", https://arxiv.org/abs/2610.12083
- "Agreement Without Alignment", https://arxiv.org/abs/2610.13303

**2610.12083.**

- **Metric.** The trustworthy verdict rate is T = Pr(reproducible and order-invariant and
  correct). For binary verdicts it has a closed form: T = C x (A - phi/2), where:
  - C is the consistency over repeated runs;
  - phi is the order-flip rate;
  - A is the accuracy.
- **Method.** Ten repetitions per condition.
- **Results.**
  - 7 to 17% of verdicts change between runs at temperature 0.
  - Swapping the order flips up to 98% of verdicts.
  - Accuracy is capped at 1 - phi/2.
  - One judge had C = 100% and was right 51% of the time, so T = 2%.
  - Reliability differs per item.
  - Scoring with a single G-Eval-style rubric prompt raised T, for example from 28.9 to 77.9%.
    FLASK-style decomposition lowered C.

**2610.13303.** Label-free rubric edits raised agreement between judges (Krippendorff alpha
+0.069). Agreement with humans did not change (Kendall tau difference -0.007). Panel agreement is
not accuracy.

**What it changes.** `judge calibrate` reports kappa from one verdict per item, read through the
cache. It should be able to rerun each item k times without the cache. It should then report C,
phi (from `pairwise.ts`), A and T, plus the share of items that are "consistent but wrong". The
panel report should not present agreement between judges as a sign of accuracy.

### C. Compaction loses details, and the agent pays to read them again

Sources:

- Compact-Bench, https://arxiv.org/abs/2610.31710
- "Re-Reading Is Not Free", https://arxiv.org/abs/2611.20873 (abs)
- Compaction evaluated on later questions, https://arxiv.org/abs/2610.27301 (abs)

- **Compact-Bench.** LLM-written summaries keep at most 16.0% of recurring details. Mechanical
  extraction keeps 79.1%. Production summaries keep 15.7%. Stable damage across tasks is 5 to 64%.
- **2611.20873.** 94.8% of tokens in coding agent sessions are cached reads. Parent logs undercount
  subagent tokens by about 10x.
- **What it changes.** coding.sh already flags `compaction` and context thrash. It does not count
  the reads that the compaction caused: a read-only call whose identical earlier result was valid
  until a `context.compact` event. That count, with its tokens, is the measured cost of a
  compaction, and it is the number to watch when someone changes a compaction setting.

### D. Skills and instruction files that loosen oversight

Source: https://arxiv.org/abs/2610.37734

- About 1 in 17 published agent skills contains a directive that loosens oversight. The most
  common mechanism is a permission flag: `--no-verify`, skip permissions, or proceed without
  approval.
- 70.1% of these directives are unconditional, not limited to CI or to a named case.
- Skills that run shell code, install packages or use sudo have 1.7 to 1.8 times the odds.
- Open-source scanners catch at most 46% of them, at precision below 0.4. An LLM given the
  paper's codebook reaches 61% recall at 0.71 precision.
- **What it changes.** `harness audit` already lists the skills, AGENTS.md and rule files each
  session loaded. It can scan those files for loosening directives and then report whether the
  sessions that loaded a file ran the loosened action, for example `git commit --no-verify`.
  Without the second step, a lexical match is only a lead.

### E. The harness mangles shell commands, and the model gets the blame

Source: https://arxiv.org/abs/2610.04375

- Claude Code's Bash tool changed 12.0% of 47,828 shell calls that contained code, escapes or long
  text.
- For 80.7% of backslash changes, a different command ran and nothing reported an error.
- All 10 harnesses tested changed some calls.
- Judging from the trajectory alone blamed the model for 95.1% of failures, though the call path
  caused more than half of them.
- **What it changes.** `failures.ts` counts these as real failures of the agent. Two signals are
  cheap and local:
  - a shell parse error followed by a retry that is identical once quotes and backslashes are
    normalized;
  - the failure rate of risky calls (heredocs, inline `python -c` or `node -e` code, backslashes)
    against plain calls.

### F. Advice must be tested against a neutral control

Sources:

- AgentFaultBench, https://arxiv.org/abs/2611.20711
- https://arxiv.org/abs/2611.19359 (abs)

- **AgentFaultBench (1,944 runs).** Advice tested against a neutral reminder of the same length
  gave -8.33, 0.00 and +1.06 points on three settings. A guided policy gave +9.90 to +10.42
  points. The paper says to test advice against explicit controls.
- **2611.19359.** 19% of tasks flipped between identical runs. A preregistered memory effect did
  not replicate.
- **What it changes.** coding.sh A/B tests of AGENTS.md text, skills and refine edits compare
  "with" against "without". The difference mixes the advice with the extra tokens and the extra
  instruction. An optional third arm with length-matched neutral text separates them.

### G. Benchmark leakage shows up in what the agent says

Source: "Benchleaking", https://arxiv.org/abs/2611.21315

- **Anti-Hack score.** The score is recomputed with leaked items counted as wrong. The number of
  items does not change.
- **Strict leak criterion (L3).** The normalized full question and the reference answer both
  match.
- **MaxxBench replication.** Edited versions of 89 DeepSWE tasks dropped pass@1 by 13.3 and 15.8
  points for the two models tested.
- **Hidden-rule probe.**
  - Normal solving: on Terminal-Bench 4.0, the model stated hidden test rules on 14.3% of tasks.
    The rules were absent from the task text and from all earlier tool output.
  - Prefilled reasoning: the model was asked to list its instructions, and the list included
    hidden rules on 51.5% of tasks.
  - An older model stated hidden rules on 1.6% of tasks in normal solving and 9.1% with prefilled
    reasoning.
  - The paper's detector is a semantic judge. It does not report the judge's prompt or its error
    rate.
- **Cited audits.**
  - Schaeffer and Rauker, https://r40.org/papers/kimi_k31_benchmark_audit.pdf. When a task was
    edited to contradict a hidden rule, the model kept applying the old rule.
  - Lo and Lo, https://maxxbench.unlap.ai/research/why-maxxbench/
- **What it changes.** coding.sh owns both sides of a run: it knows the hidden verifier files and
  the full trace. It can run a deterministic check with no judge. The check flags a run where the
  agent's messages or written code contain a distinctive token that:
  - exists only in the hidden verifier (a test name, an expected literal, a magic constant);
  - appeared in no prompt or tool output before the agent produced it.

  coding.sh can then report the score with flagged runs counted as failures, next to the plain
  score.

### H. Replaying a person's own sessions changes the ranking

Source: SWE-WhatIf, https://arxiv.org/abs/2611.21095

- The paper replays recorded sessions with new agents. A user simulator models the user's intents
  and acceptance criteria, and the conditions that come up during the session.
- It used 89 sessions.
- Agents avoided actions the user had pushed back on in 66.3% of comparisons.
- For 14 of 16 users, their own sessions ranked agents differently from the public benchmark.
- **What it changes.** `continuation.ts` replays one turn. A multi-turn replay driven by the
  recorded user corrections would let a person rank agents on their own work. It is a large build
  and depends on a simulator model, so I list it last.

## Candidates

1. **`src/judge`: transport views in `judge discriminate`.** The same trace is shown as macro,
   delegation and compaction views, and the report gives the share of verdicts that flip and the
   share that abstain (finding A).
2. **`src/judge`: `judge calibrate --repeats k`.** It reports per-item consistency, flip rate,
   accuracy and trustworthy verdict rate, plus the consistent-but-wrong share (finding B).
3. **`src/core`: `stats.compactionRefetches`.** Read-only repeats whose earlier result was
   invalidated only by a compaction (finding C).
4. **`src/core`: loosening directives in `harness audit`.** It lists loosening directives in the
   loaded files and whether the sessions that loaded them ran the loosened action (finding D).
5. **`src/core`: quoting failures and requote retries** in `failures.ts` (finding E).
6. **`src/experiments`: a length-matched neutral control arm** for advice A/B tests (finding F).
7. **`src/eval`: a hidden-verifier recall check and a leak-adjusted score** (finding G).
8. **`src/experiments`: multi-turn user replay.** Large; it may wait (finding H).

## Deferred

These are relevant, but covered already, or not a build change now.

- **Early-stop and restart monitors.**
  - 2610.36544: a monitor with 90% accuracy ranged from -5 to +35 points of decision value; 0 of
    103 comparisons were certified.
  - 2610.35971: within-task AUC was 0.50, and continuing beat restarting in 216 of 224 configs.
  - 2610.25525 StopLoss and 2611.17662 LeBet.

  `stats/validity.ts` already reports the within-task view. The evidence argues against building
  a monitor that stops runs early.
- **2611.20297.** A Simpson reversal (a co-author trailer gap of -21.8 points flips to +23.7).
  Covered by the within-strata view in `validity.ts`.
- **2610.00917.** Model by harness rankings reverse. Covered by `bench/grid.ts`.
- **2611.21515.** Budgeted model selection on HAL: 27 of 35 Pareto steps were unresolved, reported
  costs differed by up to 11.7x from token-based estimates, and successive halving needed 6.6% of
  the spend. Mostly covered by `experiments/sweep.ts` and `stats/pareto.ts`.
- **2610.11464.** A verifier that always passes trains skills as well as a real one, so a task
  score cannot certify a verifier. This is related to the round-1 exploit probe and is already
  planned.
- **2611.17440.** 143k trajectories with a rule-based action parser; behavior profiles identify
  the agent stack. `stats.phases` covers part of this.
- **2610.34577.** An independent critic adds 5.9 to 9.5 points on Terminal-Bench at 1.13 to 1.25
  times the cost. This is a change to the agent, not to coding.sh.
- **2611.06866 GH-AWTrace.** GitHub Agentic Workflow logs. A possible future adapter.
- **2611.16293 Rasoi.** Visual structural diffs. An idea for the viewer.
- **2610.32578.** Lessons outlive the failures they came from, so rules should be retested and
  retired. This is related to `refine` and `rules.ts`, and needs its own design.
- **2610.15093 TurnCost.** Turn count explains 84% of the variance in log cost. Turn count is
  already a stat.

Read, not kept:

- 2611.20844 DetourBench;
- 2610.09159 SpecGuard (covered by `eval/impossible`);
- 2610.12822, reward hacking spreading between agents;
- 2611.01334, evidence-view gaming;
- 2611.01950 CertClaim;
- 2610.07257 MemMux;
- 2610.32338, faulty chain-of-thought claims;
- 2610.28834, Banzhaf resource attribution;
- 2610.35486 ShutdownMod;
- 2611.13709, context-file adherence (covered by `rules.ts`);
- 2611.02383, an instruction-file template (16.1% of paired sections diverge);
- 2610.22732 TokenEconomizer;
- 2610.20673 HPCAgent-Bench;
- 2611.18067, an Agent-as-a-Judge survey;
- 2610.18389 PRISM;
- 2610.37679, exposure against commitment;
- 2611.11720 ShadowBench-MCP;
- 2610.32313, Copilot trajectories;
- 2610.39417 ExLabel;
- 2610.41435 BlindToChange;
- 2611.21056 ELITE;
- 2610.07256, two-stage trace auditing;
- 2610.28934 RegretBench;
- 2611.15436 AgentTorrent;
- 2611.04456, skill evolution.
