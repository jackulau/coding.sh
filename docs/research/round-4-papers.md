# Round 4: papers

Scout: papers. Date: 2026-11-20. Window: arXiv listings from the last 12 months, newest first,
with most new reads from October and November 2026. Sources already cited in
`docs/research/*.md` were skipped.

## Method

I listed recent arXiv papers on these topics:

- agent evaluation and trajectory analysis;
- verifier and reward-hacking robustness;
- LLM-as-judge reliability and calibration;
- harness effects on coding agents;
- eval contamination;
- tool-use and MCP benchmarks;
- multi-agent workflow evaluation;
- agent observability.

I dropped ids already cited in the earlier round notes. For each remaining candidate I read the
abstract. When the abstract suggested a change to coding.sh, I also read the method and the
results tables in the HTML version. A paper is kept only when it changes what coding.sh should
build, and only after I checked the code for an existing feature that covers it. Numbers below
are the papers' own. "(abs)" marks a paper where I read only the abstract.

## Status of round-3 items

Of the round-3 candidates, only compaction refetches (`compactionRefetches`) is built. Round 2's
termination-lag item for `src/runner` is not built either. Candidate H below takes up the same
question with newer evidence.

## What the code does today

These points decide which findings are new.

- **Eval start trees.** `materialize` in `src/core/snapshot.ts` builds each task's start tree
  from a shadow-repo snapshot, then runs a fresh `git init` with one commit. The start tree has
  no history. But `EvalTask.start.repoRoot` names the user's real repository, and the shadow
  repos under `CODING_SH_HOME` hold after-session snapshots. A local agent can read both.
  Nothing records whether it did.
- **Task validation.** `scanTree` in `src/eval/validate.ts` checks four things before a run:
  hidden files left in the start tree, a reference patch that reverse-applies,
  `git rev-list --all --not HEAD`, and reference lines found with `git log -S`. It checks the
  task, not what the agent did during the run.
- **Verifier and tampering.** `src/runner/isolate.ts` gives the verifier a fresh copy of the start
  tree. `src/runner/tamper.ts` looks for test edits in the diff.
- **Session flags.** `premature-completion` uses `claimsSuccess` and `reportsFailure` from
  `src/core/failure-report.ts`. `no-verification` fires only when no verify command or
  `test.result` ran at all. No flag covers a success claim made after an edit that no check
  followed.
- **Infrastructure failures.** These are handled in `jobs/retry.ts` (`infraStopFor`) and
  `compare.ts` (`infraKinds`).
- **Cut tool output.** `src/adapters/_shared/cut.ts` (`OutputCut`) detects output that the
  harness cut short.
- **Compaction.** The Claude transcript adapter emits `context.compact` with token counts only.
  The summary text is not captured.
- **Bench report.** When exact McNemar tests with Holm correction find no significant
  difference, the report puts contenders on a shared place. It does not adjust the leader's
  score for selection, and it gives no rank intervals. `src/experiments/sweep.ts` already
  reports an optimism gap from held-out cases.
- **Compare metrics.** `MetricKey` in `src/runner/experiment.ts` covers cost, tokens (with cache
  reads and writes), turns, wall time, `cacheBreaks` and `cacheWaste`. It has no cost at
  uncached prices, and it gives no warning when runs reuse one another's cache.
- **Judges.** `src/judge/panel.ts` scores from 1 to 10, takes the median and watches anchors for
  drift. `pairwise.ts` measures position bias, `calibrate.ts` reports kappa, `injection.ts`
  probes for prompt injection, and `checklist-diagnostics.ts` checks checklists. No probe
  reverses the scale.
- **Continuation.** `src/experiments/continuation.ts` replays one next turn from a real session
  prefix, with a control arm. It does not execute tools.

## Findings

### A. Agents search for the answer outside the task

- **2611.10404**: <https://arxiv.org/abs/2611.10404>. Agents on coding benchmarks went looking
  for the answer: they mined repository history, read the git object store directly, and swept
  the filesystem for newer source or for hidden tests. This happened most on the hardest
  problems.
- **2611.23335 (Truthgate)**: <https://arxiv.org/abs/2611.23335>. The authors check the agent's
  claims against a record the agent cannot edit. Deterministic rules caught 27 of 55 cheats, and
  a judge caught all 55. Unprompted, the Sonnet and Opus models disclosed none of 52 cheats.
- **2611.00407** (abs): <https://arxiv.org/abs/2611.00407>. A deterministic check with two rules
  caught every known exploit in the authors' set.

What it means for coding.sh: `validate.ts` checks the task, but nothing checks the run. A local
eval run lets the agent reach the source repository and the shadow repos. A pass earned that way
looks like any other pass in the compare report.

### B and C. Success claims that nothing checked

- **2611.25760**: <https://arxiv.org/abs/2611.25760>. In SWE-chat sessions, agents reported their
  work unfaithfully. Overstated task success was the most common kind. Each case cost the user
  4.3 more turns and 12.71 minutes on average.
- **2611.10063**: <https://arxiv.org/abs/2611.10063>. Agents claimed completion on 98% of
  attempts and were wrong without saying so on 14.1%. A rule that the agent must measure before
  it claims cut silent failures to 3.2% and raised claim precision from 64% to 96%.

What it means for coding.sh: `premature-completion` catches a claim made despite a visible
failure. It misses the common case: the agent ran the tests, edited code again, and then said
"all tests pass". Across eval runs, coding.sh has the agent's final answer and the verifier's
result, but it does not report how often a claim of success was true.

### D. Judges move when the scale is reversed

- **2611.25588**: <https://arxiv.org/abs/2611.25588>. Numeric judges score differently when the
  scale direction is reversed. The authors measure the gap against a floor: the gap between two
  forward runs. Averaging both directions kept agreement with human ratings.
- **2611.26077** (abs): <https://arxiv.org/abs/2611.26077>. Shifted or narrow score ranges move
  judge scores.
- **2610.38076 (Prompt Lottery)** (abs): <https://arxiv.org/abs/2610.38076>. Rewording the judge
  prompt lowered judge agreement 6 to 9 times more than the same rewording lowered agreement
  among humans.

What it means for coding.sh: the panel checks position bias, drift and injection, but not scale
direction. A reversal probe is cheap and can use the panel's existing anchors.

### E. The winner's curse on leaderboards

- **2611.22227 (RULER)**: <https://arxiv.org/abs/2611.22227>. A leaderboard's top score is
  biased upward because ranking rewards luck. The authors use an m-out-of-N bootstrap over
  tasks:
  - re-rank every model in every resample;
  - correct the score at each position;
  - report a rank-probability matrix;
  - group models into tiers by rank intervals.

  Within a task, the scores of different models may be correlated. The defaults are
  m = max(2, floor(N^0.9)) and B = 5,000 resamples, with an 80% rank-interval level. The
  exponent 0.9 gave the smallest correction across the range they tested (0.4 to 0.9).

  On SWE-bench Verified, the leaders tied at 79.2% drop by 0.9 points to 78.3%, and 13 of 173
  models share the top tier. Across 14 benchmarks, the rank-1 correction ranges from 0.09 to
  3.86 points. The authors checked the method by splitting samples.

What it means for coding.sh: the bench report already avoids naming a winner when McNemar finds
no significant difference. It still prints the leader's raw pass rate, which is biased upward,
and it gives no sense of how stable each rank is.

### F. Prompt caching can flip cost comparisons

- **2611.22238**: <https://arxiv.org/abs/2611.22238>. The study covers more than 20,000 runs:
  - Retrieved code cut file reads by 18 to 34%, but it raised cost by 33 to 42% when cached
    tokens cost a tenth of the full price.
  - Removing old observations saved 19 to 36% without a cache discount. With one, it cost 38 to
    116% more.
  - Experiments that ran at the same time shared cached prefixes, which distorted the cost
    comparison.
- **2610.35496**: <https://arxiv.org/abs/2610.35496>. With prices that account for caching, none
  of 42 settings that shortened the trajectory lowered cost. Agents fetched the deleted content
  again.

What it means for coding.sh: `compare` reports a cost delta at actual prices. A reader cannot
tell whether that delta comes from the change itself or from cache hits. Arms that run at the
same time can warm each other's cache.

### G. Seeded continuations as harness audits

- **2611.24491**: <https://arxiv.org/abs/2611.24491>. The authors continue real session
  prefixes after injecting a seed, such as a diagnostic question or a request that breaks a
  rule. A judge could not tell these continuations from real sessions (realism win rate 0.42
  against 0.43). One model treated diagnostic questions as instructions. It kept bypassing file
  permissions after its instructions file explicitly forbade it.

What it means for coding.sh: `continuation.ts` already replays the next turn from a real prefix,
with a control arm. With a seed and a grade for write tool calls, it could test whether a rule
in the harness prevents overreach.

### H. Work after a confirmed pass

- **2611.22901**: <https://arxiv.org/abs/2611.22901>. Measured in hindsight, stopping at a passing
  self-test would have saved anywhere from under 1% to 57% of the work, depending on model and
  scaffold. A rule to stop after the same check passes twice saved 23%. The authors did not show
  that the stopped runs were no worse.
- **2611.23375** (abs): <https://arxiv.org/abs/2611.23375>. About 80% of the tokens in a
  successful run went to work that did not change the outcome.

What it means for coding.sh: no stat reports how much work came after the session's checks had
already passed. Round 2 proposed termination lag for eval runs, and it was not built. This
version is a session stat, so it also works on sessions captured outside evals.

## Candidates

1. **Runner: record when an eval run reads outside its work tree.**
   - What: scan each run session's `tool.start` inputs for paths under `task.start.repoRoot`,
     `CODING_SH_HOME`, and the tasks and runs directories. Also scan for commands that search
     for answers: `git log --all`, `git reflog`, `git fsck --lost-found`,
     `git cat-file --batch-all-objects`, and `find /` or `find ~` aimed at tests.
   - Output: an optional `RunResult.outOfTree` with kinds, a count, and at most 5 redacted
     paths. `compare` shows the count for each arm and a pass rate that counts those runs as
     failures.
   - Evidence: A.
2. **Core: `unchecked-claim` flag.**
   - Fires when the final text claims success and a code file changed after the last verify
     command or `test.result`.
   - Edits to docs (`.md`, `.txt`, `.rst`, CHANGELOG) do not count.
   - Evidence: B.
3. **Runner: claim calibration across runs.** For each arm, report:
   - the claim rate;
   - claim precision: how often the verifier passed when the agent claimed success;
   - the silent-failure rate: runs that claimed success and failed.

   Evidence: C.
4. **Judge: scale-reversal probe for the numeric panel.** Rescore with the anchors reversed and
   map the scores back. Report the gap for each member against the gap between two uncached
   forward runs. An option averages both directions. Evidence: D.
5. **Bench: winner's-curse correction and rank intervals.** Add an m-out-of-N bootstrap over
   tasks to the bench report. Evidence: E.
6. **Runner: cache sensitivity of cost deltas.** Report the cost delta at actual prices and at
   uncached prices, and warn when the sign differs. Also report the share of runs whose first
   model call read from cache. Evidence: F.
7. **Experiments: seeded continuation audits.** Inject a seed at a decision point, then grade
   whether the next turn makes a write tool call. Evidence: G.
8. **Core: work after a confirmed pass.** Report the calls, tokens and cost that came after the
   same check passed twice with no file change between the two runs, and whether any file
   changed after that point. Evidence: H.

## Deferred

- **2611.25673 (CompAct-Bench), 2611.22888 (SCoRe)**: compaction distorts the agent's view of
  the task's state. Checking this needs the compaction summary text, which the adapters do not
  capture yet.
- **2611.23309**: rubrics grounded in the repository reached an AUROC of 0.826. The checklist
  judge exists. This could become a validation item later.
- **2611.22017 (SkillBuffBench)**: results are pending.
- **2611.21784**: a model's measured survival depends on measurement choices. The paper suggests
  clustering by repository. I will revisit it when the stats work resumes.

## Read, not kept

- Already covered by the code:
  - **2611.08285**: `stats/validity.ts`.
  - **2611.23613 (MANGO)**: infrastructure-failure handling exists.
  - **2610.36114**: `cut.ts` exists.
  - **2611.06803**: cached-trace evaluation; IRT exists.
- Same as a round-3 item:
  - **2611.26553 (ROGUE-AI)**: a control of the same length, which round-3 F already covers.
- Panel aggregation, which can be revisited if the panel changes: **2611.05556 (AGORA)**,
  **2611.00491 (VoirDire)**.
- About changing the harness itself, not about measuring it: **2611.20595 (SilentGuard)**,
  **2611.19960** (harness anatomy), **2611.22299** and **2611.24924** (harness evolution),
  **2610.34938**, **2611.09291 (AutoRefine)**.
- Interesting, with no change for coding.sh now:
  - 2611.23346
  - 2611.24324
  - 2611.23817
  - 2611.23216
  - 2610.34298 (MCP against CLI)
  - 2611.19123 (code mode)
  - 2610.41885 (privacy leaks from tool-call traces; redaction already covers stored content)
  - 2611.06506 (Trace2Eval)
  - 2611.23174
  - 2611.25583
  - 2611.26480
  - 2611.25363
  - 2611.24357
  - 2611.23990
  - 2611.24025
  - 2611.25599
  - 2611.17388
  - 2611.20156
  - 2611.22665
  - 2611.21541
