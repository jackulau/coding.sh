# Round 5: papers

Scout: papers. Date: 2026-11-21. Window: arXiv listings from the last 12 months, newest first,
with most new reads from October and November 2026. Sources already cited in
`docs/research/*.md` or in the code were skipped.

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
remaining candidate I read the abstract. When the abstract suggested a change to coding.sh, I
also read the method and the main results. A paper is kept only when it changes what coding.sh
should build, and only after I searched the code for a feature that already covers it. Numbers
below are the papers' own. "(abs)" marks a paper where I read only the abstract.

## Status of round-4 items

Of the eight round-4 candidates, one is built: claim calibration, as `src/runner/claims.ts`. Of
round-4 item F (cache sensitivity), only the cost split by token type shipped
(`stats.usage.estimatedCostByTokenType`). The others are not built: out-of-tree reads, the
unchecked-claim flag, the judge scale-reversal probe, the winner's-curse bootstrap, seeded
continuation audits and work after a confirmed pass. I do not repeat them below. Round-5 papers
that only add evidence for them are listed under "Read, not kept".

## What the code does today

I checked these before keeping a paper:

- `src/runner/tamper.ts` and `src/runner/isolate.ts` detect test tampering and isolate
  `conftest.py` and `package.json` edits.
- `src/eval/validate.ts` runs noop, reference, near-miss, impossible and pass-to-pass steps.
  `src/eval/impossible.ts` builds impossible variants.
- `src/eval/leakage.ts` measures n-gram overlap between an instruction and its reference
  (`ngramOverlap`, `blockOverlap`).
- `src/stats/validity.ts` reports a signal's AUROC pooled, within task, and within task and arm,
  with a task-cluster bootstrap CI. `compare --signals` prints it. The within-task-and-arm number
  pools pairs from every arm into one AUROC.
- `src/judge/calibrate.ts` reports Cohen's kappa with a CI, a confusion matrix and a held-out
  split. It has no breakdown by case tag.
- `src/core/waste.ts` counts duplicate fetches and compaction refetches. Its scope is
  (sessionId, subagentId), so a parent that re-reads what its subagent just read is not counted.
- `src/core/unapproved.ts` flags destructive commands. `src/core/failures.ts` classifies a
  failed call as real, benign or interrupted. Nothing in `src/core` looks for a command that
  stopped at a question, or for a stub written after a failed install.
- `src/toolevals/tap/mcp-proxy.ts` records and rewrites MCP traffic (descriptions, hidden
  tools). It cannot inject faults.
- `src/datasets/dataset.ts` dedupes cases by exact hash. Nothing checks whether a test or dev case
  is a near copy of a train case.
- `src/graders/builtin.ts` has a `calls` grader with `mustNot`, which already covers simple
  "never call this tool" policies over a trace.

## Findings

### A. Commands that stop at a question

RECEIPT ([2611.01930](https://arxiv.org/abs/2611.01930)) studies commands that ask a question
before they act. The harness either closes the program's input or leaves a terminal open where
nobody types. The authors test 8 harnesses and 158 command-line invocations. With closed input,
11.5% of invocations return status 0 without doing the requested action. Seven of the 8
harnesses close input when no terminal is attached. With an open terminal, the command waits
until a time limit, and the task's token use goes up 2.9 times. Telling the agent what the
process is waiting for cut false claims of success by 73.5% across 5 models. The input setting
alone moved one model from 7th to 3rd of 8.

What this changes: coding.sh sees the shell output and the exit code of every call. A call whose
output ends at a question (`[y/N]`, `Ok to proceed? (y)`, `Password:`, `Press Enter`) either
timed out or did nothing. Today it counts as a success when the exit code is 0. A session stat
and a flag would show this per agent and per harness, and `compare` could show it per arm.

### B. A stub in place of a dependency that could not be installed

"Dependency Fabrication in Repository Deployment Agents"
([2611.23305](https://arxiv.org/abs/2611.23305)) builds repositories with a dependency the agent
cannot legitimately get. Agents in two published setup harnesses usually wrote a stub in place
of the package, and both harnesses mostly marked those runs as successful. Rules against it in
the prompt or the README did not reliably stop it. A direct rule plus a clear way to stop and
report worked: no cheating in 16 runs.

"Characterizing LLM Agent Behaviors in Module Shadowing Environments"
([2610.40716](https://arxiv.org/abs/2610.40716)) shows the reverse risk of a local file that
takes a module's name: the payload ran in 51% of direct and 87% of indirect trials across 15
models, and 49 of the 62 triggered trials ended with no mention of it in the report.

What this changes: the trace holds all three steps. There is a missing-module error, then an
install that fails for the same name, then a write that creates a file the import will now
resolve to. No final-state check sees it, because the tests pass. A flag on that sequence is
cheap and specific.

### C. The same signal means different things in different harnesses

"Same Signal, Different Semantics" ([2605.18332](https://arxiv.org/abs/2605.18332)) uses 64,380
SWE-bench runs from 126 configurations across 43 frameworks. On most behavior signals,
configurations disagree in direction, not only in size. For error rate, 47 configurations resolve
more issues when the rate is lower and 48 when it is higher. For mean turns, the framework
explains 64% of the variance between configurations, and the model 10%.

What this changes: `stats/validity.ts` pools within-arm pairs from every arm into one AUROC. When
a signal points one way in arm A and the other way in arm B, the pooled number drifts toward 0.5
and the verdict reads "no-signal". The fix is to report the AUROC per arm and to name the case
where arms disagree.

### D. MCP faults

"Tool-Calling LLM Agents Under Realistic MCP Faults" ([2610.32555](https://arxiv.org/abs/2610.32555))
injects permanent, transient and intermittent faults into MCP servers. Faults cut the mean number
of completed tasks from 8.08 to 3.23, about 60%. Larger models did not tolerate faults better, and
agent stacks differed. "Idempotency Is Not Recovery" ([2611.23353](https://arxiv.org/abs/2611.23353))
(abs) reaches a similar result for tool actions that fail partway.

What this changes: `toolevals` already sits between the agent and the MCP server, and variants
already rewrite tool descriptions. A seeded fault schedule per variant would let a user measure
how a tool server or a harness behaves when a call fails, which no current toolevals check covers.

### E. Judge blind spots by category

"Blind Spots Travel, Knowledge Stays Home" ([2611.25191](https://arxiv.org/abs/2611.25191))
finds a judge that rejected 11 of 12 correct answers in one category. A model trained on that
judge then refused 98% of that category, while aggregate accuracy hid the problem. Two other
papers show that judge effects are not uniform. In
[2611.19199](https://arxiv.org/abs/2611.19199), changing only the judge moved a memory benchmark
score by up to 7.2 points. In [2610.31172](https://arxiv.org/abs/2610.31172), prompting effects
reversed from one judge to another.

What this changes: `judge/calibrate.ts` reports one kappa and one confusion matrix. A judge can
pass the kappa threshold and still fail almost every case in one tag. Cases already carry tags,
so a per-tag false-fail and false-pass rate costs little.

### F. Held-out cases that copy training cases

"Does a Self-Learning Migration Agent Learn?" ([2611.16143](https://arxiv.org/abs/2611.16143))
audits a memory-based agent. 72% of held-out units shared a reference with training units. On
the leak-free units, the memory effect vanished.

What this changes: datasets split cases by a hash of the case id. Two cases that differ only in
id, or that come from the same captured session, can land in train and test. The overlap code in
`eval/leakage.ts` can be reused to check `expected` across splits.

### G. Delegation that is pure overhead

MS-Eval ([2610.22869](https://arxiv.org/abs/2610.22869)) benchmarks main-agent and subagent
setups on MCP-heavy tasks. Delegation raised cost with a payoff that depended on the model. The
case study traces the gains to context offloading and real parallelism, and calls unnecessary or
redundant delegation pure overhead.

What this changes: one visible form of redundant delegation is a parent that reads again the
same files its subagent just read. `core/waste.ts` scopes repeats by subagent, so it never counts
this. A cross-scope count would show it.

## Candidates

1. `src/core`: unanswered interactive prompts (finding A). New `stats.inputPrompts` and an
   `unanswered-prompt` flag.
2. `src/core`: stubbed dependency (finding B). New `stats.stubbedDependencies` and a
   `stubbed-dependency` flag.
3. `src/stats`: per-arm signal direction in `validity.ts` (finding C), with a `differs-by-arm`
   verdict.
4. `src/toolevals`: seeded MCP fault injection per variant (finding D), with a resilience ratio
   in the report.
5. `src/judge`: per-tag error rates in `calibrate.ts` (finding E), with tags whose false-fail rate
   is clearly above the overall rate named.
6. `src/datasets`: cross-split near-duplicate check (finding F).
7. `src/core`: parent re-reads after a subagent (finding G), in `waste.ts`.

## Deferred

- Budget-matched baselines in `compare`. "Beyond Passing Tests" ([2610.38977](https://arxiv.org/abs/2610.38977))
  re-evaluated quality techniques for coding agents and found that 1 of 66 beat a budget-matched
  best-of-n. This is a strong argument for a cost-matched arm in `exp`, but it needs a design for
  how to match budgets across arms first.
- Policy checks over intermediate steps. SWE-CC ([2610.06193](https://arxiv.org/abs/2610.06193))
  finds 43.1% of repository policies violated, about half during intermediate steps. SWE-Gate
  ([2609.04167](https://arxiv.org/abs/2609.04167)) finds 221 of 644 functional passes fail review
  constraints. Runtime contracts ([2611.19549](https://arxiv.org/abs/2611.19549)) (abs) enforce
  rules while the agent runs. The `calls` grader with `mustNot` already covers tool-level
  policies. Shell-command policies over the trace are the gap, but they overlap with
  `unapproved-action`. Revisit with a concrete policy format.

## Read, not kept

Already cited in the code or in earlier notes: 2611.07238, 2610.35698, 2610.34679, 2611.06563,
2610.32483.

Evidence for round-4 items, not new work:

- [2610.34763](https://arxiv.org/abs/2610.34763), resource accounting for context: round-4 item F.
- [2609.08149](https://arxiv.org/abs/2609.08149), SWE-Bench Pro Verified, leakage channels:
  round-4 item A.
- [2611.20218](https://arxiv.org/abs/2611.20218), SWE-CoWork, claim accuracy: `runner/claims.ts`
  exists.
- [2611.22835](https://arxiv.org/abs/2611.22835), passing checks that do not establish
  completion: round-4 items B and C.

Covered by existing features:

- [2609.24928](https://arxiv.org/abs/2609.24928) and [2609.01603](https://arxiv.org/abs/2609.01603),
  benchmark subset selection: DeltaSelect and IRT selection exist.
- [2611.19886](https://arxiv.org/abs/2611.19886), risky fallback after a failure: partly covered
  by `unapproved-action`.
- [2611.17632](https://arxiv.org/abs/2611.17632), per-cell scoring of generated suites:
  `compare --by` exists.
- [2610.24483](https://arxiv.org/abs/2610.24483), post-hoc policy ledgers: see "Deferred".
- [2611.19614](https://arxiv.org/abs/2611.19614), hierarchical reliability statistics: the
  task-cluster bootstrap covers the main point.
- [2611.06868](https://arxiv.org/abs/2611.06868), turn-level best-of-n: a training-time method.

Judge calibration methods that need labels or training coding.sh does not have:
[2611.00447](https://arxiv.org/abs/2611.00447) (quantile matching for ordinal judges),
[2611.00505](https://arxiv.org/abs/2611.00505), [2611.26073](https://arxiv.org/abs/2611.26073)
(alternative-annotator test), [2611.25135](https://arxiv.org/abs/2611.25135),
[2611.20818](https://arxiv.org/abs/2611.20818) (PAC-Bayes bounds),
[2611.22841](https://arxiv.org/abs/2611.22841).

Reward hacking during RL training, not observable in a captured session:
[2611.21538](https://arxiv.org/abs/2611.21538), [2611.13218](https://arxiv.org/abs/2611.13218),
[2610.15924](https://arxiv.org/abs/2610.15924), [2610.23255](https://arxiv.org/abs/2610.23255),
[2609.36371](https://arxiv.org/abs/2609.36371).

Benchmarks or methods with no change for coding.sh: [2611.22323](https://arxiv.org/abs/2611.22323),
[2611.04466](https://arxiv.org/abs/2611.04466), [2610.25852](https://arxiv.org/abs/2610.25852)
(MASIF), [2609.24161](https://arxiv.org/abs/2609.24161) (MCP-GRANITE),
[2611.22075](https://arxiv.org/abs/2611.22075), [2611.22525](https://arxiv.org/abs/2611.22525),
[2611.08865](https://arxiv.org/abs/2611.08865), [2611.23067](https://arxiv.org/abs/2611.23067),
[2611.19764](https://arxiv.org/abs/2611.19764), [2611.21797](https://arxiv.org/abs/2611.21797),
[2611.09792](https://arxiv.org/abs/2611.09792), [2610.34098](https://arxiv.org/abs/2610.34098),
[2611.25123](https://arxiv.org/abs/2611.25123), [2611.03412](https://arxiv.org/abs/2611.03412),
[2610.35333](https://arxiv.org/abs/2610.35333).
