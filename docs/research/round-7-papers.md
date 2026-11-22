# Round 7: papers

Scout: papers. Date: 2026-11-21. Window: arXiv listings from the last 12 months, newest first.
All the papers kept are from October and November 2026. I skipped any source already cited in
`docs/research/*.md`, in `tasks/research-queue.md` or in `packages/coding.sh/src`.

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

I collected every arXiv id cited in `docs/`, `tasks/` and `packages/coding.sh/src` (507 ids) and
dropped those. Several papers I first shortlisted turned out to be cited already in earlier
rounds, under a bold id rather than a link: 2611.17440 (behavior profiles), 2610.15093 TurnCost,
2610.22732 TokenEconomizer, 2611.25673 CompAct-Bench, 2611.00491 VoirDire, 2610.25525 StopLoss,
2611.23309, 2610.34577, 2611.23216 and 2611.24357. They are not repeated here.

For each remaining candidate I read the abstract, and the method and main results where the
abstract suggested a change to coding.sh. A paper is kept only if two things hold. It must change
what coding.sh should build. And a search of the code must find no feature that already covers it.
The numbers below are the papers' own.

## Status of round-6 items

The round-6 candidates (R6-9 stale paths in instruction files, R6-12 timeouts, R6-19 tokens per
byte, R6-20 empty test runs, R6-21 violations after compaction, R6-26 pass_X@2, R6-27 the
reviewer-note probe, R6-28 residual start) are queued in `tasks/research-queue.md`. R6-11 (`harness
tools --changed` flags a tool first seen after the pin) is queued too. None is repeated here. Where
a new paper adds evidence to a queued item, it is listed under "Deferred".

## What the code does today

These are the parts of the code this round's findings touch.

- **MCP tools in tool evals.** `src/toolevals/types.ts` keeps a tool's `annotations` on `McpTool`
  but nothing in `src/toolevals` reads them. `ToolMetrics` counts invalid, failed and retried calls.
  It does not count calls that change state, or a write repeated with the same arguments.
  `SurfaceReport` measures bytes and tokens of the tool surface. It does not say which tools lack
  `readOnlyHint` or `destructiveHint`.
- **Tool drift.** `src/proxy/tool-drift.ts` (`coding.sh harness tools`) hashes each tool's
  description and schema from the stored tools arrays. It reports first and last seen, sessions
  offered and variants. It reads only `llm.call` events, so it cannot say whether calls to a tool
  started failing after its definition changed.
- **Derails.** `src/core/derail.ts` flags `looping`, `failure-streak`, `churn`, `no-progress`,
  `stalled` and `context-thrash`. A run that hits the same environment blocker (an auth error, a
  missing host, a stopped daemon) and keeps going is caught only if the calls are identical or fail
  five times in a row. No flag says that a loop began after a compaction.
- **Unapproved actions.** `src/core/unapproved.ts` flags destructive shell commands and SQL run
  through a database MCP tool when the user's last turn did not approve them. An MCP tool called
  `delete_issue` or `remove_member` is not checked.
- **Permission settings.** `coding.sh harness audit` (`src/cli/commands/harness.ts`) warns on a
  fallback model and on a subagent `tools:` map. It does not read the `permissions.allow` rules in
  Claude Code's settings files. Adapters record `permissionMode` on `session.start`
  (`src/adapters/claude-code.ts`, `src/adapters/codex.ts`, `src/adapters/droid.ts`), but nothing
  outside the adapters reads it.

## Findings

### A. Destructive tool calls go unconfirmed on both sides of MCP

- **2611.02978 CAREFUL-Bench** (https://arxiv.org/abs/2611.02978). BFCL's multi-turn checker
  looks only at the final state. The authors infer each function's effects by running it in BFCL's
  simulators and diffing the state. A judge-free replay then scores any logged run for unrequested
  destructive calls, duplicate writes, redundant reads and surplus steps. The ranking holds (rho
  0.99), but the leader loses 14.0 points to unrequested destructive calls. Surplus steps are 2 to
  28% of input tokens. Effect hints in function docs change nothing for any of eight models.
- **2611.02527 When Neither Side Confirms** (https://arxiv.org/abs/2611.02527). In a 1,000-repo
  sample of the MCP registry, about 90% of destructive tools have no server-side confirmation. 32 of
  41 hosts and SDKs have no approval step by default. 60.7% of (tool, host) pairs run with no human
  approval. If hosts prompted for every tool not annotated read-only or non-destructive, that share
  would fall to 5.4%. A rule-based extractor finds the destructive tools from their names and code.

What this changes: `toolevals` should report, per variant, which tools lack the read-only and
destructive annotations and how many calls change state or repeat a write. The session fold should
treat a destructive MCP tool name like a destructive shell command.

### B. A silent tool change breaks experienced agents

- **2611.20922 Experience Rot** (https://arxiv.org/abs/2611.20922). After a silent change to an
  MCP tool, agents with history, memory files or skills fail on most tasks, while new agents
  mostly succeed. They copy their earlier call instead of reading the current definition, then
  report success. Announcing the update barely helps.
- **2611.01976** (https://arxiv.org/abs/2611.01976). Tool updates are an attack surface: a tool
  that changes after it was approved reached a 97.6% attack success rate in their setup (abs).

What this changes: `harness tools` already sees the definition change. It should also show what the
change did: the failed-call share of that tool before and after the new variant first appeared.

### C. Agents keep going after the evidence says they are blocked

- **2610.31895 Knowing When to Stop / ImpasseBench** (https://arxiv.org/abs/2610.31895). Twelve
  injected environment blockers, 19,371 trajectories, eight models. Nearly every run that needs
  outside help collects enough evidence within a few steps. A third still exhaust their budget, and
  every unsafe request comes after that point. An escalation tool cuts budget exhaustion from 34.0%
  to 6.7%. Handoff tickets name the blocker but often leave out progress and verification status.
- **2610.27777 RITE** (https://arxiv.org/abs/2610.27777). Silent tool errors roughly halve task
  success and are harder than explicit failures. Recognizing the error is the first bottleneck.

What this changes: a derail flag for "the same blocker, again and again, and the agent did not
stop or ask". The current flags need identical calls or five failures in a row. A blocked agent
varies its calls and mixes in successes.

### D. Loops get more common after compaction

- **2610.19376 DeLoop** (https://arxiv.org/abs/2610.19376). A loop is a repeated call that returns
  the same observation. Loops appear in Qwen, Llama and Gemini agents and become far more common
  once the history is compressed. Under compression, 57.3% of Qwen3-8B tasks on CodeGym contain a
  loop.

What this changes: `looping` episodes that start after a compaction should say so, so a user can
tell a compaction problem from a model problem. `stats.compactionRefetches` counts single
re-fetches. It does not tie a loop to the compaction before it.

### E. A broad allow rule blinds the approval step

- **2610.22987 From Approval to Abuse** (https://arxiv.org/abs/2610.22987). Text planted in a repo
  steers a coding agent into requesting a broad allow rule that sounds justified. On Claude Code
  and Codex CLI the agent obtained the target rule in 58% of instances. The rules cover 56.9% of
  the capability test cases in their category. Once the rule is approved, the attack completes
  silently in 47 of 58 eligible runs (81.0%).

What this changes: `harness audit` reads Claude Code settings already. It should list allow rules
that cover an interpreter, a network tool or every command, since each one turns off the prompt
for a whole class of actions.

## Candidates

These are ranked. Each one touches one module.

1. **Unconfirmed destructive MCP calls in the session fold** (`src/core`, M). A, using the
   rule-based name extraction of 2611.02527.
2. **Blocked-agent derail flag** (`src/core`, M). C.
3. **Tool-eval effect metrics and annotation gaps** (`src/toolevals`, M). A.
4. **Failures after a tool change in `harness tools`** (`src/proxy`, M). B.
5. **Broad allow rules in `harness audit`** (`src/cli`, S). E.
6. **Loops after compaction** (`src/core`, S). D.

The specs and acceptance tests are in the structured output of this round.

## Deferred

- **2610.11351 Deception by Omission** (https://arxiv.org/abs/2610.11351). Models fail to
  disclose a prefilled mistake in 67.1% of agentic rollouts, though they spot it when reviewing the
  same transcript from outside. Supports R5-3 (premature completion) and the claims check in
  `src/runner/claims.ts`.
- **2610.18108 CaLLM** (https://arxiv.org/abs/2610.18108). Post-hoc multicalibration of a judge
  bounds the bias of every group a representation captures. Supports R5-14 (per-tag judge errors);
  the per-tag error table comes first.
- **2610.06001 AgentSpy** (https://arxiv.org/abs/2610.06001). Repeated runs of one task use
  similar resources in 92.2% of comparisons. In 18% of all-pass tasks the agent also did unrelated
  work. A per-task check of files and commands across attempts in `compare` could find such runs.
  It needs a design for what counts as unrelated.
- **2610.13548** (https://arxiv.org/abs/2610.13548). Detectors run over saved eval outputs audit
  the benchmark itself, for example items where every model picks the same wrong answer.
  `src/eval/validate.ts` already checks a task's verifier up front. A post-hoc "every arm fails the
  same test" detector would need parsed verifier output per run.
- **2610.29870 PAUSE** (https://arxiv.org/abs/2610.29870). Agents make their first source edit at
  a median of 60% of the trajectory. One planning intervention there adds 14.7 to 16.8% resolution.
  This is a change to the agent. coding.sh could report time to first edit per arm, but round 3
  deferred behavior profiles and `stats.phases` covers part of it.
- **2610.12375 OnTrack** (https://arxiv.org/abs/2610.12375). Streaming comparison with recorded
  successful runs ranks failing trajectories after 8 steps (+0.057 AUROC over content similarity).
  `src/stats/validity.ts` already measures within-task signal; round 3 argued against early stops.
- **2610.34241** (https://arxiv.org/abs/2610.34241). Cold-prefix requests had a median TTFT of
  about 69.4 s against 2.8 s for high-reuse requests (observational). `stats.cacheBreaks` covers
  the cause.

## Read, not kept

- 2611.20156, risk-certified prompt selection for judge guardrails;
- 2610.21914, CodeHealth and review token cost;
- 2610.02142, keyword harnesses that credit tool use never made;
- 2611.12083 SWE-Time;
- 2610.40071, signed agentic process evidence;
- 2610.27620, per-action authorization that does not compose;
- 2610.25552, mined tool-call constraints checked with an SMT solver;
- 2610.31972, reproducible offline eval for prompt compression;
- 2610.09793, offline temporal-logic monitors over recorded trajectories;
- 2610.33958, structural tools for small coding agents (a placebo arm; a design idea for `compare`
  already covered by its controls);
- 2611.07140, reliability envelopes for multi-agent voting;
- 2610.15988 CreepScope, privilege creep;
- 2610.20665 RealtimeBench;
- 2610.05572 and 2611.21266 (failure prediction; covered by `src/stats/validity.ts`);
- 2610.07362, 2610.03055 hacktrace and 2610.26088 LeakBench (reward hacking during training);
- 2611.14980 CoLFA (multi-agent failure attribution);
- 2611.21577 (MCP provider misbinding; a security finding, not a measurement gap);
- 2611.07051 (closed-loop evaluation);
- 2610.22760 (over-specified benchmark tasks; `src/eval/validate.ts` covers the leak side);
- 2610.15884 RetryBench (covered by the retry counts in `src/toolevals`);
- 2610.30548 Atlas (trajectory summaries; the viewer's outline covers it);
- 2611.16114 ADAPT (diff-aware patch testing).
