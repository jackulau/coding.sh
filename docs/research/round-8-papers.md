# Round 8 research: papers

Date: 2026-11-21. Scope: new work from the last 12 months on agent evaluation, trajectory
analysis, verifier and reward-hacking robustness, LLM-as-judge reliability, harness effects,
eval contamination, tool-use and MCP benchmarks, multi-agent evaluation and agent
observability. Each idea is kept only if it changes what coding.sh should build.

## Method

- Queried the arXiv API (`https://export.arxiv.org/api/query`) with about 40 topic queries,
  sorted by submission date, newest first. About 1,000 results came back from 2026-10-15 on.
- Dropped every arXiv id already cited in `docs/research/*.md`, `tasks/` and
  `packages/coding.sh/src` (546 ids).
- Read the abstract and, where it decided the fit, the method of about 110 candidates.
- Checked each idea against the code before keeping it. The section "What the code does
  today" lists what is already built, so the candidates below do not repeat it.

## Status of earlier items

Round 7 items not built yet are queued in `tasks/research-queue.md` (R7-2 tool-eval effect
metrics, R7-3 failures before and after a tool change, R7-4 destructive MCP calls, R7-7 broad
allow rules, R7-15 loops after compaction, R7-17 blocked derail). Round 5 and 6 items R5-13
(differs-by-arm), R5-14 (per-tag judge errors), R6-27 (reviewer-note probe) and R6-28
(residual start) are queued too. Several papers below add evidence for those items. They are
listed under "Deferred" with the item they support, not as new candidates.

## What the code does today

- `packages/coding.sh/src/judge/checklist.ts`: the `llm-checklist` judge has two modes,
  `per-item` (the default) and `batched` (all model items in one call). `freezeChecklist`
  validates items but does not look at how a question is phrased.
- `packages/coding.sh/src/judge/checklist-diagnostics.ts`: per-question yes-rate, phi against
  the outcome, redundant pairs, and a diff between two versions with per-question flips and
  kappa. Comparing `batched` with `per-item` needs two versions built by hand. Nothing measures
  how much item order changes a batched answer.
- `packages/coding.sh/src/judge/discriminate.ts`: five trace mutations
  (`skipped-verification`, `failing-final-test`, `ignored-tool-error`, `destructive-command`,
  `constraint-violation`). None makes the final code itself broken.
- `packages/coding.sh/src/judge/calibrate.ts`: kappa against held-out labels, with a confusion
  matrix.
- `packages/coding.sh/src/experiments/aa.ts`: an A/A noise floor for experiments.
  `packages/coding.sh/src/toolevals/compare.ts` has no noise floor for its continuous metrics.
- `packages/coding.sh/src/toolevals/types.ts`: `ToolMetrics` counts invalid calls, failed
  calls, retries, self-corrections and target calls. `ToolArmSummary` reports pass rates,
  pass^k, errors, infra failures, cost, cuts and kinds. It does not count failed trials that
  showed no sign of trouble, and it has no calls per success.
- `packages/coding.sh/src/core/unapproved.ts`: the `REJECTED` pattern marks calls the user or
  a hook rejected, so they never count as run. Nothing notices an agent that runs the rejected
  call again.
- `packages/coding.sh/src/core/waste.ts` treats `WebFetch` as read-only. Nothing notices a
  fetch that returned a bot challenge or a block page.
- `packages/coding.sh/src/eval/validate.ts`: the no-op check (the verifier must fail before
  any change) already exists.
- `packages/coding.sh/src/runner/claims.ts`: claim calibration per arm (`claimsSuccess`,
  `silentFailures`). It does not check numbers in the final answer against the run.

## Findings

### A. Grading many items in one prompt changes the grades

Judged in Company (https://arxiv.org/abs/2610.40241) grades the same items one per prompt and
many per prompt. Grading in a batch changes 11 to 22 percent of decisions. Item order and slot
position explain most of it. A majority vote over 9 permutations still leaves 52 to 60 percent
of the flips. The authors recommend one item per prompt, or at least reporting agreement with
single-item grading.

What it changes: the checklist `batched` mode is cheaper, but a user has no number for what it
costs in agreement. coding.sh should measure that on the user's own traces: re-ask a sample
with the item order reversed, and compare against per-item answers.

### B. Negated and conditional rules split judges

Same Rule, Different Verdicts (https://arxiv.org/abs/2611.04091) finds that rules with
negation, conditions or exceptions carry an odds ratio of 5.6 for judge disagreement. One model
gives different verdicts on items with the same meaning in 11 to 15 percent of cases.

What it changes: checklist questions are written by users. A cheap lint at freeze time can warn
on "not", "unless", "except", "if ... then" and "only when" phrasing, which the paper links to
the disagreement.

### C. Judges barely notice code that does not parse

Impossible Code, Barely Changed Score (https://arxiv.org/abs/2611.01572) feeds judges answers
of which 63 to 67 percent are invalid Python. The judged Pass@32 drops only about 3 points. The
authors recommend reporting a syntax-check pass share next to any judged score.

What it changes: `discriminate.ts` tests whether a judge notices a skipped test or a forced
push, but not whether it notices that the final code is broken. An `unparsable-edit` mutation
fills that gap.

### D. Most tool-use failures are silent

SPRING-5 (https://arxiv.org/abs/2611.10040) finds that 54 percent of wrong answers come with no
rejected call, no refusal and no retry. It reports tool calls per correct task. Between
byte-identical specs the cost ratio varies from 0.64 to 1.56, so about 1 in 8 comparisons
crosses a win threshold on noise alone.

What it changes: `ToolArmSummary` already counts errors, but a reader cannot tell how many
failures left no trace. A `silentFailures` count and `targetCallsPerSuccess` make that visible.
The noise result supports an A/A floor for tool evals; that is close to R7-2 and is deferred.

### E. Work runs after a rejection

Auditable Authorization (https://arxiv.org/abs/2611.19237) traces approvals in agent workflows.
In 4 of 59 n8n workflows, work still runs after a Reject. Some approved work never finishes. A
developer survey (https://arxiv.org/abs/2611.10058) finds 61 percent approve agent actions
without close review, and want agents that are bounded, observable and reversible.

What it changes: coding.sh already knows when the user rejected a call. It should flag the
session when the agent runs the same call again (same tool and same normalized input, or the
same shell command) before the next real user prompt.

### F. A 200 response is often not the page

When 200 OK Is Not an Answer (https://arxiv.org/abs/2611.00884) finds that 20.9 percent of
static 200 responses lack the main content: app shells, bot challenges and block pages. Cheap
text heuristics recover 86 percent of them at about 5 percent false alarms.

What it changes: an agent that reads a challenge page and answers anyway is a failure the
session view cannot show today. A tag such as `fetch:blocked` with a count, from a short list
of challenge markers in fetch output, makes it visible. Claude Code summarizes `WebFetch`
output, so the markers must be checked on real fixtures first; precision is the risk.

### G. Unsupported numbers come from the agent's own work

Misattributed numbers (https://arxiv.org/abs/2610.38691) finds that about 4 in 5 unsupported
numeric claims in agent reports are real values from the wrong run, file or metric. A
deterministic claim-to-evidence check reaches over 90 percent precision.

What it changes: `runner/claims.ts` checks whether a run claims success. It could also list
numbers in the final answer that appear in no tool output of the run.

## Candidates

Ranked by value for effort. Each touches one module.

1. **Checklist phrasing lint** (`packages/coding.sh/src/judge`, S). Finding B. Warn on
   negated, conditional or exception questions when a checklist is frozen, and list the
   warnings in the checklist diagnostics.
2. **Silent failures and calls per success in tool evals** (`packages/coding.sh/src/toolevals`,
   S). Finding D.
3. **`unparsable-edit` mutation** (`packages/coding.sh/src/judge`, S). Finding C.
4. **Batched-mode order probe** (`packages/coding.sh/src/judge`, M). Finding A.
5. **Rejected call run again** (`packages/coding.sh/src/core`, M). Finding E. Needs a
   `SESSION_FOLD_VERSION` bump.
6. **Blocked fetch results** (`packages/coding.sh/src/core`, M). Finding F. Needs real
   fixtures before it ships.
7. **Numbers in the final answer with no evidence** (`packages/coding.sh/src/runner`, M).
   Finding G.

## Deferred

- ProbeID (https://arxiv.org/abs/2610.33633): 7 of 59 real tools changed their responses
  despite version pins. Evidence for R7-3 (failures before and after a tool change).
- SPRING-5 noise floor (https://arxiv.org/abs/2611.10040): an A/A floor for tool-eval metrics.
  Fits with R7-2.
- Retry transparency (https://arxiv.org/abs/2611.23307): repeated writes on retry. Evidence for
  R7-2.
- Failed transcript beats a written lesson (https://arxiv.org/abs/2610.41433): on retry, the
  failed transcript helps more than a model-written lesson. Evidence for R6-28 (residual start).
- Benchmark Factory (https://arxiv.org/abs/2611.18890): label-free anchors such as a known
  stronger config ranking above a weaker one, and shuffled labels. Evidence for R5-13.
- CyberGym reliability (https://arxiv.org/abs/2611.25790): passes that do not hit the target.
  Partly covered by `packages/coding.sh/src/runner/tamper.ts` and
  `packages/coding.sh/src/eval/witness.ts`.
- SWE-Shift (https://arxiv.org/abs/2610.32196): stale evidence after a mid-run change gives no
  paired success. Partly covered by the `premature-completion` flag.
- Pairing Matters (https://arxiv.org/abs/2610.32131) and Harness Leverage
  (https://arxiv.org/abs/2611.21407): harness effects up to 44 points and tokens per resolved
  task that vary more than 20-fold. The experiment compare and the no-op check in
  `packages/coding.sh/src/eval/validate.ts` already cover what coding.sh would build.

## Read, not kept

Read, but each was covered by existing code, out of scope for a local tool, or had no
actionable method:

- ReplayRCA (https://arxiv.org/abs/2610.41025): placebo-controlled replay; the continuation
  control arms already do this.
- SkillBridge (https://arxiv.org/abs/2611.26256) and Synapse (https://arxiv.org/abs/2611.20856):
  skill repair across OSes and by program repair; tools that change skills, not observe them.
- ToolTurns (https://arxiv.org/abs/2611.14925) and SWE-Clar (https://arxiv.org/abs/2610.31854):
  benchmarks for multi-turn tool use and requirement clarification.
- Others: 2611.20882, 2610.38617, 2610.33509, 2611.16493, 2611.12835, 2611.18443, 2611.12125,
  2610.23449, 2610.21229, 2611.23074, 2611.19056, 2611.15522, 2611.11216, 2611.05665,
  2611.01311, 2610.32285, 2610.24206, 2610.30284, 2610.28612, 2611.03227, 2610.34375,
  2611.14493, 2611.12953, 2611.24849, 2611.09113, 2611.09088, 2611.21554, 2610.34748,
  2611.23732, 2611.20033, 2611.26525, 2611.07126, 2611.14323, 2611.00442, 2611.13336,
  2611.26311, 2611.25605, 2610.22984, 2610.35716, 2611.20955, 2611.23362, 2610.32060,
  2611.21259, 2610.28811, 2611.09203, 2610.30047, 2611.05739, 2611.24216, 2610.41803,
  2611.22905, 2611.12823, 2610.34620. Each is at `https://arxiv.org/abs/<id>`.
