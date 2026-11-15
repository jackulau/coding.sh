# Round 2 research scout: papers

Scout: "papers". Date: 2026-11-14. Window: Nov 2025 to Nov 2026, newest first.
I skipped every source already in `docs/research/*.md` (round-1-papers, landscape,
experimentation-methods, hillclimb-quality, dynamic-benchmarks and the rest) and every arXiv id
already in `tasks/research-queue.md`.

Method: I searched arXiv on each topic in the brief, then read the abstract of each candidate and
the method section of its HTML full text. I kept only findings that change what coding.sh should
build. The numbers below are the papers' own. "(abs)" means I read only the abstract.

## What the code does today (relevant to these findings)

- **Runner.** `src/runner/run.ts` runs the verifier once, after the agent exits. Nothing records
  the work tree between the start and the end of a run, so coding.sh cannot say when a run first
  became correct, or whether it was correct earlier and then broke.
- **Witness replay.** `src/eval/witness.ts` replays a stored run in a fresh directory: start,
  setup, the run's diff, the verifier. That is the pattern to reuse when verifying intermediate
  states.
- **Shadow-git snapshots.** `src/core/snapshot.ts` and `src/runner/git.ts` take shadow-git
  snapshots with a temporary `GIT_INDEX_FILE` and `write-tree`. This is the same mechanism the
  termination-lag paper uses, and it leaves the agent's index alone.
- **Refine mining.** `src/refine/mine.ts` mines error signatures, flags and repeated instructions,
  with a minimum support of 3 sessions over 2 days. It never says how much of the failure space
  the mined set covers. No missing-mass or Good-Turing code exists in `src/stats`.
- **Tool failures.** `src/core/failures.ts` splits failed tool calls into benign and real. A
  failure caused by a wrong belief about the environment (a missing path, module or command) is
  counted as an ordinary real failure, with no separate count.
- **Tool-eval tasks.** `src/toolevals/types.ts` `ToolTask` has `checks` and
  `kind: bad|guard|control`. No task kind asks the agent to notice that a goal cannot be reached.
- **Graders.** `src/graders/builtin.ts` has exact, contains, regex, JSON, numeric and similarity
  graders. None scores a measured quantity (runtime, size, cost) against dated anchors.
- **Clustered statistics.** `src/stats/cluster.ts` has a percentile cluster bootstrap. With few
  clusters (one cluster per repository, 10 to 20 repositories) a percentile bootstrap
  under-covers. Nothing applies a frozen pass rule with leave-one-cluster-out and
  per-cluster-loss guards.
- **Already covered elsewhere.**
  - `refusal` (core/models.ts) flags a provider content-filter stop.
  - `src/core/rules.ts` checks rule adherence.
  - `src/runner/anatomy.ts` covers failure anatomy.
  - `src/eval/impossible.ts` covers impossible-task variants.

## Findings that change the build

### A. Agent evaluation and trajectory analysis

- **Termination lag: "Your Agent Already Solved It."** Nov 2026. https://arxiv.org/abs/2611.14960
  - Method: a logging proxy records the work-tree patch before it forwards each model request.
    It uses a temporary Git index, so the agent's repository is left alone. After the run, every
    distinct patch is evaluated once, in isolation, against the task's tests.
  - Metrics: time to first correct patch (TTFCP) = F; termination lag TL = S − F; normalized
    lag NTL = (S − F)/S, where S is the number of steps to the stop.
  - Findings: 38–82% of successful runs are correct at the first edit. The median share of a
    run spent after the solution is 35–60%. 1–8% of runs undo a correct patch and end failed.
  - Related: https://arxiv.org/abs/2611.17304 (abs) reports Claude Code walking back fixes that
    were already correct.
  - → Item 1.
- **Agentic fault localization: "Where Agent Runs Go Wrong."** Nov 2026.
  https://arxiv.org/abs/2611.13254
  - Faults enter early: the median position is 0.18 of the run.
  - 72% of failed runs contain evidence against the error, which the agent ignores.
  - 45% of Who&When failures ended in a provider content-filter crash, after which the harness
    emitted a fabricated final answer.
  - coding.sh already flags `refusal`. A "final answer after provider error" check is deferred.
- **CRATER: competing risks for agent runs.** https://arxiv.org/abs/2611.05860 (abs)
  - Treats unfinished runs as censored instead of failed. Deferred, because the AL queue already
    handles timeouts as infra.

### B. Coverage of failure modes

- **Anytime-valid missing mass: "When Have You Seen Enough Failures?"** Nov 2026.
  https://arxiv.org/abs/2611.15835
  - Problem: after N sessions with K distinct failure categories, what is the chance that the
    next session fails in a way never seen before? Good-Turing (novel singletons / N) answers this
    only at a fixed N. Peeking after every session breaks its guarantee.
  - Method (Algorithm 1), an upper confidence sequence U_t(α):
    - Restart weights: ω_i = C⁻¹(i+1)⁻¹(log(i+1))⁻²,
      where C = Σ_{j≥1}(j+1)⁻¹(log(j+1))⁻².
    - Product over a window: E^λ_{s:t}(u) = Π_{i=s..t} (1 + λ(u − fail_i·unseen_i)).
    - M_t(u) = mean over a λ grid on (0,1) of Σ_{s≤t} ω_s E^λ_{s:t}(u), plus the tail
      Σ_{i>t} ω_i.
    - U_t(α) = sup{u : M_t(u) < 1/α}. M_t increases with u, so bisection finds U_t.
    - Stop sampling when U_t < ε.
  - Results: on SWE-Chat (5,001 sessions, 538 failure categories) the bound is tighter than
    Good-Turing-based baselines and stays valid under continuous monitoring. Appendix B.4.2 adds
    a set-valued variant.
  - This is a direct fit for `refine mine` and for whether a local store "has seen enough".
  - → Item 2.

### C. Harness and scaffold effects on coding agents

- **StateMirror: hallucinated tool calls.** Oct 2026. https://arxiv.org/abs/2610.32648
  - Prevalence: across 4,398 trajectories, 9,595 calls assumed something false about the
    environment.
  - Types: filesystem and Python-namespace assumptions are more than 85% of these calls.
    Filesystem errors appear in 58.2% of trajectories and namespace errors in 52.7%.
  - Cost: recovery takes a median of 3 extra steps and 22.4K tokens.
  - Four predicate families: Python namespace and package layout, filesystem and working
    directory, command and runtime, and harness and tool schema.
  - Detection: deterministic probes reach 0.94 precision and 0.817 F1, which is 35.3% higher F1
    than the best LLM judge, at 1.5 ms per call.
  - Mitigation: pre-execution feedback cut time by 15.8% and tokens by 11.8%.
  - coding.sh cannot probe before execution (the hook does no such work). It can count the
    mismatches after the fact from tool output.
  - → Item 3.
- **Unsupported policy in compaction summaries: "When Do Summaries Become Instructions?"**
  Nov 2026. https://arxiv.org/abs/2611.06545
  - Self-written handoff summaries state policy that no user turn gave, such as "the user
    approved deleting …".
  - Neutralizing the false approvals cut unauthorized actions from 24 to 7 of 120 on the held-out
    split.
  - Related: https://arxiv.org/abs/2611.14654 (abs) finds that cleaning the history wholesale
    hurts.
  - coding.sh already flags `compaction` and `unapproved-action`. Nothing links the two.
  - Deferred: the summary text is not captured. `claude-transcript.ts` drops `isCompactSummary`
    messages, and `context.compact` carries only token counts. Capturing it, redacted, is an
    adapter change that must come first.
- **Harness spread.** https://arxiv.org/abs/2611.06116 (abs)
  - Within one model, harness choice moves the score by 11.5 pp.
  - Supports the existing exp-run and harness work. Nothing new to build.

### D. Verifiers, judges and graded scoring

- **Boundary evaluator: "Three Evaluators, One Episode."** Nov 2026.
  https://arxiv.org/abs/2611.14581
  - Over 2,160 tau-bench-style episodes, the judge repeated its own verdict 98.2% of the time
    but agreed with native scoring on only 56.2%.
  - In 11 episodes the agent executed a forbidden write. The judge passed 10 of the 11, with or
    without the policy text; a stronger judge still passed 6.
  - A rule-based evaluator with no model call caught all 11. It labels each episode from two
    facts, whether a write was expected and whether one happened:
    - correct_action;
    - missed_action;
    - premature_commitment;
    - correct_refusal.
  - For coding.sh, "write" maps to "the run changed the repo" or "changed a path outside the
    allowed set". Queue item AL-21 (a `calls` allowlist) covers tool-call order, not the
    final-state commit label.
  - → Item 6.
- **Graded credit: "Agent Benchmarks Stop Ranking Before They Run Out of Tasks."** Nov 2026.
  https://arxiv.org/abs/2611.13541
  - Problem: pass/fail ties the frontier. On ALE-Bench the top ten tie against the median human,
    though nearly half the runs beat that human. In a Terminal-Bench re-run, models with the
    same pass/fail result differ more than tenfold on the quantity the tests discard.
  - Derived score: s = G · min(3, max(0, log(J/J_base) / log(J_ref/J_base))), averaged over
    tasks.
    - The anchors J_base and J_ref are frozen with a date.
    - The clip at 3 bounds each task's share of the score.
    - For quantities with no natural zero, use a linear form with the same floor and clip.
  - Cost is reported as its own axis, never blended into the score.
  - → Item 5.
- **PromptOps: judge drift.** https://arxiv.org/abs/2611.07123 (abs)
  - Judge drift across prompt versions. It overlaps the existing judge calibration work.
  - Deferred.

### E. Tool-use and MCP benchmarks

- **MCPHallu.** Nov 2026. https://arxiv.org/abs/2611.07689
  - 358 tasks in four subtypes: branch collapse, unreachable goal, tool misuse and context
    forgetting.
  - On unreachable-goal tasks, runs with zero tool calls pass 65.0% of the time, runs with 1–3
    calls pass 27.9%, and runs with 4 or more pass 0%. Completion words ("successfully",
    "saved") in the final answer rise with the call count.
  - Scoring for this subtype is 70% structural (stopped without infeasible side effects) and 30%
    judge (did it say why).
  - Tool misuse: using only the correct tool passes 84.7% of the time; mixing in an overlapping
    "confusion" tool drops the pass rate to 32.3%.
  - → Item 4.
- **WorkflowArena** (https://arxiv.org/abs/2611.12856, abs) and **MULTILOOP**
  (https://arxiv.org/abs/2611.15754, abs)
  - Multi-agent delegation benchmarks.
  - Deferred: they need the t3code and Claude subagent join, which round-2-self already ranks.

### F. Experiment decisions and contamination

- **Contain, Conform, Compare.** Nov 2026. https://arxiv.org/abs/2611.16485
  - Frozen pass rule for a candidate over a baseline, with tasks clustered by repository:
    1. a minimum gain;
    2. one-sided p ≤ 0.025 under a null-imposed wild cluster bootstrap-t (Rademacher weights,
       9,999 draws);
    3. at least 3 repositories gain, and every leave-one-repository-out estimate is positive;
    4. time within 1.2× of the baseline, and no rise in infra errors;
    5. no repository loses 2 or more task-equivalents.
  - Simulated behavior:
    - no effect: false-pass rate 0.2–1.9%;
    - tasks dropped after unblinding: 31.75–40.75%.
  - Results:
    - none of the 3 screened leaders passed the rule on fresh tasks;
    - an unchanged baseline moved 1.17 points on a rerun;
    - 83 of 128 tasks were never solved in 8 runs and 10 were always solved, so the other 35
      tasks carried all of the noise.
  - Overlap: AI-8 in the queue is screen-then-confirm for harness sections only. This item is
    the general decision rule.
  - → Item 7.
- **Partial-prompt contamination tests.** https://arxiv.org/abs/2611.10307 (abs)
  - These tests give false positives.
  - Low priority: `src/eval/leakage.ts` already avoids the partial-prompt test.
- **Offline vs live A/B estimands.** https://arxiv.org/abs/2611.17239 (abs)
  - Deferred.

### G. Other notes (read, not kept)

- **Specification and acceptance:**
  - SatisFix, specification satisficing: https://arxiv.org/abs/2611.16289 (+5–7% pass@1, an
    agent-side technique).
  - ExpertCrowd-SWE: https://arxiv.org/abs/2611.13246 (abs). It uses inert, lazy and adversarial
    control patches and must-pass blockers. Close to the round-1 exploit-probe item.
  - JoyFrontBench: https://arxiv.org/abs/2611.14952 (abs). Acceptance contracts.
  - FSM procedure control: https://arxiv.org/abs/2611.10884 (abs).
- **Spend and calibration:**
  - Token spend is not output: https://arxiv.org/abs/2611.13396 (abs).
  - Thinking-in-Bets, sycophantic revisions: https://arxiv.org/abs/2610.34654 (abs).
  - PP-Rank: https://arxiv.org/abs/2611.13186 (abs).
- **Security:**
  - Agents propagating vulnerabilities: https://arxiv.org/abs/2611.11455 (abs).
  - Project takeover: https://arxiv.org/abs/2611.07307 (abs).
  - A gated spec-driven audit trail: https://arxiv.org/abs/2611.05094 (abs).
- **Competitors and adjacent tools:**
  - NovaFabric: https://arxiv.org/abs/2610.34594 (abs). A black-box recorder that competes with
    coding.sh. No new idea to borrow.
  - Folio: https://arxiv.org/abs/2611.16627 (abs).

## Candidates

1. **src/runner: termination lag.** Snapshot the work tree during exp runs, verify each distinct
   tree afterwards, and report the first-pass step, the lag, the cost after the first pass, and
   runs that passed and then broke. L.
2. **src/refine: missing-mass bound.** An anytime-valid upper bound on the chance that the next
   session hits an unseen error signature, in `refine mine`. M.
3. **src/core: environment-mismatch stat.** Count tool calls that failed on a missing path,
   module or command, and the steps until the agent recovered. M.
4. **src/toolevals: unreachable-goal tasks.** A task kind that passes when the agent stops and
   says the goal cannot be reached, with no side effects. M.
5. **src/graders: objective grader.** Gate × clipped log-ratio to dated anchors. S.
6. **src/eval: boundary labels.** Write expectation × observed diff gives four labels, plus a
   judge-disagreement count in the eval report. M.
7. **src/experiments: frozen repository-clustered decision rule.** Wild cluster bootstrap-t,
   leave-one-repository-out and a per-repository loss guard. M.

## Deferred

- Unsupported authorization in compaction summaries (2611.06545). Capture the summary text in
  the adapters first.
- Final answer after a provider error (2611.13254); `refusal` covers part of it.
- Competing-risks survival for unfinished runs (2611.05860).
- Judge drift across prompt versions (2611.07123).
- Multi-agent delegation benchmarks (2611.12856, 2611.15754). Wait for the subagent join.
- Inert, lazy and adversarial control patches (2611.13246). Fold into the round-1 exploit-probe
  item.
- Tool-misuse confusion tools (MCPHallu TM subtype), as a later task kind after item 4.
