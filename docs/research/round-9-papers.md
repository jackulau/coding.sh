# Round 9 research: papers

Date: 2026-11-22. Scope: new work from the last 12 months on agent evaluation, trajectory
analysis, verifier and reward-hacking robustness, LLM-as-judge reliability, harness effects,
eval contamination, tool-use and MCP benchmarks, multi-agent evaluation and agent
observability. Each idea is kept only if it changes what coding.sh should build. Baseline:
[round-8-papers.md](round-8-papers.md).

## Method

- Queried the arXiv API (`https://export.arxiv.org/api/query`) with about 50 topic queries,
  sorted by submission date, newest first. The API rate-limited some queries (HTTP 429); they
  were run again with a backoff until each one returned.
- Dropped every arXiv id already cited in `docs/research/*.md`, `tasks/research-queue.md` and
  `packages/coding.sh/src`.
- Read the abstract and, where it decided the fit, the method of about 60 candidates.
- Checked each idea against the code and against the ranked rows in `tasks/research-queue.md`
  before keeping it.

## Status of earlier items

Round 8 candidates are not built yet. Two queued rows already cover ideas that new papers
support, so those papers are listed under "Deferred" and not as new candidates: AH-9 (`judge
rerun`, re-judge stored outputs past the cache and report flip rate) and AJ-12 (budget-matched
complementarity in `exp compare`). R7-15 (loops after compaction) is related to finding A but
reads tool calls, not instructions.

## What the code does today

- `packages/coding.sh/src/adapters/_shared/claude-transcript.ts`: a `compact_boundary` system
  entry becomes a `context.compact` event with the trigger and token counts. The
  `isCompactSummary` user message only marks a request boundary. Its text, the summary the
  agent works from after the compaction, is not stored.
- `packages/coding.sh/src/core/sessions.ts` sets the `compaction` flag, and
  `packages/coding.sh/src/core/waste.ts` counts `stats.compactionRefetches` (reads that fetch
  again what a compaction dropped). Nothing checks whether the user's instructions survived it.
- `packages/coding.sh/src/core/rules.ts` already records stages per directive: whether its
  file was seen (`seen`) and whether the actions follow it (`acted`). The review-comment paper
  in "Read, not kept" asks for this split, so it is not a candidate.
- `packages/coding.sh/src/refine/protect.ts` protects harness lines by marker, config regex,
  or an automatic safety rule (Masked Erosion, https://arxiv.org/abs/2610.38392).
  `packages/coding.sh/src/refine/canary.ts` re-tests subtractive edits under a cheaper model.
  No check asks whether a line carries knowledge the model already has.
- `packages/coding.sh/src/refine/ledger.ts` records `propose`, `test`, `apply`, `rollback` and
  `recheck`. `packages/coding.sh/src/cli/commands/refine-loop.ts` stops at a drain without a
  row for the candidates it did not test, and a proposer reply that is not a usable edit
  (`bad_proposal`, `proposer_failed`) throws before any row is written.
- `packages/coding.sh/src/eval/validate.ts` runs checks (a) to (h): no-op fails, reference
  passes k/k, near misses fail, no leakage, impossible variant fails, pass-to-pass, gold-only
  coupling, and reference edits to the verifier's tests. Every step runs in a fresh folder.
  No check looks at what the verifier command itself writes into the tree it grades.
- `packages/coding.sh/src/judge/calibrate.ts` has `--probe-injection`, `--plan` and
  `--judge-cost`. `packages/coding.sh/src/judge/panel.ts` tracks anchor drift.

## Findings

### A. Compaction drops "how to work" instructions first

Benchmarks Are Surprisingly Compaction-Friendly (https://arxiv.org/abs/2610.31778) compares
compaction summaries with the context they replace. The first summary drops about a third of
the anti-cheating rules in a task prompt, and the share grows with each later compaction. On
real SWE-chat sessions, instructions about how to work or what not to do are dropped about six
times as often as build specs. CTXAgent (https://arxiv.org/abs/2610.34425) checks standing
instructions again after each compaction, and LMLineage (https://arxiv.org/abs/2611.22511)
keeps user instructions verbatim through summaries. Both report fewer violations after the
compaction.

coding.sh sees every Claude Code compaction and the user prompts before it, but throws away
the summary text, so it cannot tell which instructions the agent lost. Keeping the summary
(redacted and capped) makes a check possible: a constraint sentence from a user prompt before
the compaction whose content words appear neither in the summary nor in the messages kept
verbatim after it. The real fixture
`packages/coding.sh/test/fixtures/adapters/claude-code/real/config/projects/-work-demo/cd0185b0-305a-4df2-92fa-6fc6caffdb55.jsonl`
has one such summary to test on.

### B. Rewriting a skill without feedback pulls it toward what the model already knows

Feedback-free skill rewriting (https://arxiv.org/abs/2611.25534) lets a model rewrite skills
for 30 rounds with no task signal. Pass rate on SkillsBench falls by 15 points. The rewrites
remove the lines the model would not have written itself, which are the lines that carry
knowledge it lacks. Their method, SkillDiff, asks the model to draft the skill from its topic
alone, marks the lines of the real skill that the draft does not cover, and keeps those lines
fixed. That gains 4.8 points over plain rewriting.

`coding.sh refine` proposes edits to the same kind of files. Its protection rules cover safety
lines and user markers, not lines that hold knowledge outside the model's prior. A prior draft
is one extra model call per round and gives a concrete, checkable list of lines to protect.

### C. A verifier can grade a state it wrote itself

Oracle integrity audit (https://arxiv.org/abs/2610.16067) runs five state invariants and three
known-answer controls on agent benchmarks. In one benchmark the reward function reset the
database to the reference state before checking it, which raised measured success from 65.5%
to 94.3% and changed the order of the agents. The controls that caught it were simple: the
verifier must fail on the untouched start state, and the state the verifier sees must be the
state the agent left.

`packages/coding.sh/src/eval/validate.ts` already has the no-op control. It does not check
that the verifier leaves the agent's work alone: a verifier that runs `git checkout`, a
generator, or a setup script over source files grades its own output. Snapshotting the tracked
files before and after the verifier on the reference run finds this without extra model cost.

### D. A log of successes hides most of the search

Governed ML experimentation (https://arxiv.org/abs/2611.23678) keeps a ledger of every action
an experiment agent proposes, including invalid and cancelled ones. A success-only log missed
43 of 50 trials. The paper reports provenance completeness, the invalid-action rate, and the
repeated-bad rate (a rejected change proposed again).

The refine ledger holds tested candidates only. Drained candidates and unusable proposals leave
no row, and nothing flags a candidate whose files match one already rejected, so `refine log`
overstates how well the search goes and the proposer can spend money on a known loser.

### E. Temperature-0 judges still flip, mostly near the margin

Run-to-run variance (https://arxiv.org/abs/2610.13823) finds that 0.07% to 10.2% of rows
change verdict between identical runs at temperature 0, and the judge's decision margin
predicts which ones. Shared item-level error (https://arxiv.org/abs/2611.16315) finds item
error is about 0.906 of verdict variance, so a panel of 30 judges cuts error by only 1.7%.
Both are evidence for AH-9 (`judge rerun`), which is queued; see "Deferred".

## Candidates

Ranked by value for effort. Each touches one module.

1. **Keep the compaction summary** (`packages/coding.sh/src/adapters`, M). Finding A. Store
   Claude Code's `isCompactSummary` text, redacted and capped, on the `context.compact` event.
   Bump the Claude Code `parseVersion`.
2. **`compaction:constraint-lost` tag** (`packages/coding.sh/src/core`, M). Finding A. Needs
   candidate 1 and a `SESSION_FOLD_VERSION` bump.
3. **Verifier writes into the tree it grades** (`packages/coding.sh/src/eval`, M). Finding C.
4. **Prior-coverage protection in refine** (`packages/coding.sh/src/refine`, M). Finding B.
5. **Repeated rejected candidates and ledger completeness** (`packages/coding.sh/src/refine`,
   S). Finding D.

## Deferred

- Run-to-run variance (https://arxiv.org/abs/2610.13823) and shared item-level error
  (https://arxiv.org/abs/2611.16315): evidence for AH-9. The margin as a predictor of flips is
  worth adding to AH-9's close-call report.
- Multi-agent against matched baselines (https://arxiv.org/abs/2611.17610): multi-agent setups
  score 0.042 below baselines matched on samples or budget. Evidence for AJ-12 and Y-2.
- Eval budget in scaffold evolution (https://arxiv.org/abs/2610.37276): sparse feedback during
  search and paired successive halving at the final pick use about half the evaluation cells.
  `packages/coding.sh/src/experiments/ab.ts` already stops early on a group sequential bound.
- Maat (https://arxiv.org/abs/2609.34017): scorers counted every early halt as a prevented
  defect, and 37% of halts were false alarms from validator defects. coding.sh scores no halts
  today; revisit if a guard metric is added.
- YUL (https://arxiv.org/abs/2611.23314): agents declare stale dependency versions in 29% to
  39% of runs. A possible session tag, but it needs a registry lookup, which the fold cannot do.
- CTXAgent (https://arxiv.org/abs/2610.34425) and LMLineage (https://arxiv.org/abs/2611.22511):
  support for finding A. A re-injection of lost instructions is a harness feature, not an
  observability one.

## Read, not kept

Read, but each was covered by existing code, out of scope for a local tool, or had no
measurable effect a session or eval could show:

- Rules from review comments (https://arxiv.org/abs/2611.25918): 55.8% of rules were named,
  20.3% led to a code change. `packages/coding.sh/src/core/rules.ts` already splits `seen` and
  `acted`.
- WikiTrace (https://arxiv.org/abs/2611.14320): evidence-linked memory lessons.
  `packages/coding.sh/src/core/memory-use.ts` covers what coding.sh observes.
- Study contracts (https://arxiv.org/abs/2610.11754): pre-registered eval plans. Partly covered
  by `judge calibrate --plan`.
- Also read: 2611.13412, 2610.37868, 2610.34875, 2610.29005, 2610.26394, 2610.19525,
  2611.09938, 2610.16911, 2610.12849, 2610.12598, 2610.13227, 2610.08651, 2609.35739,
  2608.30685, 2605.27492, 2606.01326, 2611.23570, 2611.20644, 2611.15568, 2611.19598,
  2611.12063, 2611.08516, 2610.23996, 2611.25903, 2611.18939, 2611.12128, 2610.12569,
  2609.05274, 2611.25557, 2611.26346, 2611.10098 (all at `https://arxiv.org/abs/<id>`).
