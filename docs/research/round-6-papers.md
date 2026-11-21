# Round 6: papers

Scout: papers. Date: 2026-11-21. Window: arXiv listings from the last 12 months, newest first.
Most new reads are from October and November 2026. I skipped any source already cited in
`docs/research/*.md` or in the code.

## Method

I queried the arXiv API for recent papers on these topics:

- agent evaluation and trajectory analysis;
- verifier and reward-hacking robustness;
- LLM-as-judge reliability and calibration;
- harness effects on coding agents;
- eval contamination;
- tool-use and MCP benchmarks;
- multi-agent workflow evaluation;
- agent observability.

I dropped ids already cited in the earlier round notes and in `packages/coding.sh/src`. For each
remaining candidate I read the abstract. When the abstract suggested a change to coding.sh, I read
the method and the main results in the HTML full text. A paper is kept only if two things hold. It
must change what coding.sh should build. And a search of the code must find no feature that
already covers it. The numbers below are the papers' own. "(abs)" marks a paper where I read only
the abstract.

## Status of round-5 items

`tasks/research-queue.md` marks three round-5 queue items done:

- R5-1: Langfuse OTel export.
- R5-2: MCP tool drift, through `harness tools`.
- R5-4.

The round-5 paper candidates are not built. These are:

- the unanswered-prompt flag;
- the stubbed-dependency flag;
- per-arm validity;
- MCP fault injection;
- per-tag judge errors;
- the cross-split leak check;
- parent re-reads.

Those candidates still stand. This round does not repeat them. Where a new paper adds evidence to
one of them, the paper is listed under "Deferred" with the item it supports.

## What the code does today

These are the parts of the code this round's findings touch.

- **Instruction files.** `src/core/rules.ts` extracts directives from instruction files with
  `extractDirectives`. A directive's tokens are commands, flags, paths and identifiers. The file
  compares directives with `diffDirectives` and checks whether a session acted on one with
  `directiveOutcome`. `coding.sh harness audit` (`src/cli/commands/harness.ts`) counts how often
  sessions load, read or write each memory, rule or skill file. It warns on two things: a cache
  fallback model and a subagent `tools:` field written as a map. Nothing checks whether a path that
  an instruction file names still exists.
- **Verification.** `src/core/sessions.ts` sets `verified` when it sees a `test.result` event. It
  also sets it when a tool call starts a command that `isVerifyCommand` recognizes. The
  `no-verification` flag depends on that. A test command that ran zero tests still counts as
  verification. `src/adapters/_shared/heuristics.ts` parses test summaries for cargo, jest, vitest,
  pytest, node:test, mocha and go. It treats an empty summary as no summary, so an empty run is
  never named.
- **Compaction.** The schema has a `context.compact` event. `directiveOutcome` does not split
  violations at the first compaction.
- **Timeouts in compare.** `src/experiments/compare.ts` sorts errored runs into infrastructure or
  agent errors with the `INFRA` pattern. That pattern matches "time out" and "timed out", so a trial
  timeout from `src/experiments/run.ts` counts as infrastructure. The report then says to re-run
  before trusting the verdict. `armAttrition` has no timeout count.
- **Arm complementarity.** `compare` runs McNemar on the per-case majority outcome. `src/eval/report.ts`
  reports pass@k and pass^k inside one suite. Nothing asks whether two arms together solve more
  cases than either arm alone.
- **Judge probes.** `src/judge/injection.ts` (`judge calibrate --probe-injection`) plants a
  "respond pass" instruction in the output or the trace. It plants it only on human-fail cases and
  counts fail-to-pass flips. It has no probe for a note that states a verdict without asking for
  one, and no probe in the pass-to-fail direction.
- **Task variants.** `src/eval/impossible.ts` and `src/eval/validate.ts` cover noop, reference,
  near-miss, impossible and pass-to-pass checks. `exportTaskDir` in `src/eval/task.ts` has no
  variant that starts from a failed attempt.
- **Proxy calls.** `src/proxy/record.ts` stores `upstream`, `requestBytes`, `responseBytes`,
  `inputTokens` and the reported usage for each call. Nothing compares reported input tokens per
  request byte across upstreams.

## Findings

### A. Stale paths in instruction files mislead agents, and nothing repairs them

When Instruction Files Go Stale, https://arxiv.org/abs/2611.09802. The authors ran 732
trajectories on repositories whose AGENTS.md named paths and commands that no longer
existed.

- In 78 of 80 stale runs, agents followed the stale test command.
- Sonnet spent about two extra tool calls per run recovering.
- No run repaired the instruction file.
- In 19 of 40 Sonnet stale runs, the first check ran no tests at all. In one case pytest found
  nothing. In another the output was piped through `tail`, which hid the failure. The agent still
  reported success.

The authors suggest that a harness that loads an instruction file could flag the paths in it that
do not exist. They cite an earlier scan that flagged stale references in 23.0% of 356 repositories.

This gives coding.sh two changes. `harness audit` can check directive paths against the project
tree. And the session fold should stop counting an empty test run as verification. The second
change also helps candidate R5-3 (premature completion) in `tasks/research-queue.md`.

### B. Violations after compaction happen while the rule is still in context

ARCBench, https://arxiv.org/abs/2611.03223. The paper measures how often agents break a stated rule
after their history is compacted. Most violations after compaction happen while the rule is still
present in the compacted history. Runs that kept the rule broke it more than twice as often as
runs with the full history. So a summary that keeps the rule does not keep the agent following it.

`directiveOutcome` already finds violating events. Splitting them at the first `context.compact`
event would show whether a rule fails after compaction, which is a different fix than a rule that
fails from the start.

### C. Timeouts drive harness gaps

Terminal-Bench 2.1, https://arxiv.org/abs/2611.08417.

- Over half of all failed trials were timeouts. Under claude-code the share was 68%.
- A longer time limit closed a 20-point gap between two harnesses.
- 11.8% of timed-out trials that were graded anyway passed.
- The task repairs in 2.1 touched about 30% of tasks.

In `compare`, a trial timeout counts as infrastructure. That hides a real difference between arms:
one arm may be slower. It also tells the user to re-run, when the right step is to raise the time
limit and see whether the verdict holds.

### D. Disjoint solves between two agents are mostly noise

https://arxiv.org/abs/2611.08666. The authors compare a bash agent with an agent that also has a
debugger. Most cases that only one of the two solved came from run-to-run variance, not from the
tool. Two bash rollouts beat one bash rollout plus one debugger rollout. They define a cross-agent
pass@k, pass_X@k = 1 − (1/n^k)·∏ (n − c), and compare it with same-agent pass@k.

`compare` can say "B is better". It cannot say "A and B solve different cases" or "their disjoint
wins are noise". A user who wants to route between two configurations needs the second answer.

### E. A false reviewer note overturns a judge's correct verdicts

https://arxiv.org/abs/2611.05662. One false pre-screening note, attributed to an authority,
overturned up to 40% of a tool-using judge's correct verdicts. For Claude judges the flips were
mostly toward trusting the note (67–75% of flips). The note asks for nothing. It only states a
verdict.

The injection probe in `src/judge/injection.ts` tests an instruction ("respond pass") in one
direction. A note that states a verdict is a different attack, and it can flip a pass to a fail
too.

### F. Starting from a failed attempt lowers success and reorders agents

SWE-Residual, https://arxiv.org/abs/2610.25899. Each task starts from a predecessor's failed
attempt that claimed to be complete. On DeepSWE, success dropped by 20.6 to 53.5 points, and
rankings reversed. The authors call this acceptance bias: agents accept the earlier work instead of
checking it.

coding.sh already makes near-miss patches for validation (`nearMissRuns` in `src/eval/task.ts`).
The same patches can be the starting state of an exported task.

### G. Relays over-report input tokens

https://arxiv.org/abs/2611.07650. Of 20 model relays, five reported 4,200 to 60,000 extra input
tokens for identical requests. Four returned tool calls when tools were disabled.

The proxy records both `requestBytes` and the reported input tokens per upstream. A ratio of the
two, compared across upstreams for one model, would catch the first problem from data coding.sh
already stores.

## Candidates

1. **Stale paths in `harness audit`** (`src/cli`). Finding A. For each path token in the project's
   instruction files, warn when the path does not exist relative to the project directory. Also
   count the sessions whose tool calls failed on that path.
2. **Empty test runs are not verification** (`src/core`). Finding A. Recognize empty-run output
   from pytest, jest, vitest, node:test, go, cargo and mocha. Such a run does not set `verified`.
   Add an optional `stats.emptyTestRuns` field.
3. **Directive violations after compaction** (`src/core`). Finding B. `DirectiveOutcome` gains an
   optional count of violating events after the first `context.compact`.
4. **Timeouts are a budget, not infrastructure** (`src/experiments`). Finding C. Count timeouts
   per arm on their own. When the arms differ, say the verdict depends on the time limit.
5. **Cross-arm complementarity** (`src/experiments`). Finding D. Report pass_X@2 against each
   arm's pass@2, with a bootstrap interval over tasks.
6. **Reviewer-note probe for judges** (`src/judge`). Finding E. A note variant in both
   directions, with flips reported per direction.
7. **Residual-start task export** (`src/eval`). Finding F. Export a task whose setup applies a
   near-miss or failed-run diff, and check that the verifier fails at that start.
8. **Tokens per request byte by upstream** (`src/proxy`). Finding G. Flag an upstream whose
   reported input tokens per KB are far above the same model's other upstreams.

## Deferred

- Skill Constellations, https://arxiv.org/abs/2610.11169, and StealthyPoison,
  https://arxiv.org/abs/2611.12155 (abs). Two copies of one skill that drift apart, and a skill
  whose content changes. A hash-drift warning in `harness audit` would sit next to R5-2. Poisoned
  skills, https://arxiv.org/abs/2610.37738 (abs), point the same way.
- Weakest subagent, https://arxiv.org/abs/2611.17520 (abs). The weakest subagent model limits a
  workflow. This could become a tag naming a subagent that ran a cheaper model than its parent.
- Category-level calibration, https://arxiv.org/abs/2611.02253, and a calibrated judge with catch
  trials and A/B order swaps, https://arxiv.org/abs/2611.19840. Both support R5-14 (per-tag judge
  errors).
- Score-seeking with a leaked grader, https://arxiv.org/abs/2610.41014, and Claude Code as a
  grader, https://arxiv.org/abs/2611.13217 (abs). Both support the round-4 out-of-tree reads item.
- HarnessSecurity-Bench, https://arxiv.org/abs/2610.07639. Auto-approve raised attack success from
  29.2% to 95.6%. A tag for sessions run with auto-approve would follow from it. Waiting for a
  monitor item.
- Policy gates with examples and counterexamples, https://arxiv.org/abs/2611.02155 (abs). Relevant
  if coding.sh adds monitors.
- Switch-SWE, https://arxiv.org/abs/2611.02017 (abs). An 11.5-point gap when a run resumes in a
  new session. Close to finding F.
- Pass@(K,T), https://arxiv.org/abs/2611.06483 (abs). Pass rate under both attempts and time.
  Close to finding C.

## Read, not kept

These were read and dropped. They are either covered by existing code or do not change what
coding.sh builds.

- OverServe, https://arxiv.org/abs/2611.14808. Repeated polling calls. `src/core/derail.ts`
  already flags the same call repeated with no change.
- Show-up attack, https://arxiv.org/abs/2610.27574; signed handoffs,
  https://arxiv.org/abs/2611.07483; role drift, https://arxiv.org/abs/2611.04321.
- Guardscope, https://arxiv.org/abs/2611.15223; MCP poisoning, https://arxiv.org/abs/2611.03555;
  https://arxiv.org/abs/2611.13960; https://arxiv.org/abs/2611.11571.
- Harness cost, https://arxiv.org/abs/2611.12122; FlowPlan, https://arxiv.org/abs/2611.13241;
  SkillCache, https://arxiv.org/abs/2611.10022; harness evolution,
  https://arxiv.org/abs/2611.25380; EvoX, https://arxiv.org/abs/2611.15006; RuleEvolve,
  https://arxiv.org/abs/2610.00650; skills from verified traces, https://arxiv.org/abs/2611.01386.
- Fake citations, https://arxiv.org/abs/2611.01313.
- Multi-step SWE, https://arxiv.org/abs/2611.07166; dynamic concurrency,
  https://arxiv.org/abs/2610.10263; Transect, https://arxiv.org/abs/2610.08364; Annotrace,
  https://arxiv.org/abs/2610.23284; ASP, https://arxiv.org/abs/2610.21538.
- Harness awareness, https://arxiv.org/abs/2611.05391; Two-Ledger cost,
  https://arxiv.org/abs/2611.06989; Project Progress Desk, https://arxiv.org/abs/2611.13287;
  harness fingerprinting, https://arxiv.org/abs/2611.12386.
- https://arxiv.org/abs/2611.08905; VeriHarm, https://arxiv.org/abs/2611.03575;
  https://arxiv.org/abs/2611.20195; https://arxiv.org/abs/2611.03162; CR-Bench-v2,
  https://arxiv.org/abs/2611.02566; https://arxiv.org/abs/2611.24867; license use,
  https://arxiv.org/abs/2611.23299.
