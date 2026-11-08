# Workflows: capturing, measuring and A/B-testing multi-agent runs

Status: design spec, not implemented. It builds on the trace schema (`subagentId`,
`Session.parent`, `llm.call`, `durationMs`, span ids), the OTLP receiver (`src/otel`), `src/stats`,
`src/judge` and the viewer. It proposes contract additions, listed in §3. None are made here.

A workflow is a program that orchestrates many agent invocations: fan-out, pipelines, barriers,
verification and synthesis. People build them with:

- Claude Code's Workflow tool: JS scripts using `agent()`, `parallel()`, `pipeline()`, `phase()`;
- the Claude Agent SDK;
- the OpenAI Agents SDK (handoffs);
- LangGraph graphs, CrewAI crews, and Mastra workflows.

What coding.sh adds for workflow development:

1. Every run is captured as one tree: workflow → phase → agent → subagent → tool / llm.call.
2. Time, cost and failures are measured per node and along the critical path.
3. Workflow outputs are scored against ground truth.
4. Two variants of a workflow are compared over a task set with paired statistics.
5. Only the stages a variant changed are re-run.

## 1. What a workflow run looks like per framework

| Framework | Structure available | Capture path | Certainty |
|---|---|---|---|
| Claude Code Workflow tool | Script with `meta.phases`. Each `agent()` call has `label`, `phase`, `schema`, `model`, `effort`, `isolation`. The run dir holds `journal.jsonl` (each agent's return value, used for resume) and `agent-<id>.jsonl` transcripts. The script file is persisted under the session dir. | §2.1: journal + transcripts, host-session hooks, OTel spans | Journal and transcripts: documented in the Workflow tool reference; exact path and record shape (U); record fixtures first |
| Claude Code subagents (`Agent` tool) | `<sid>/subagents/agent-<id>.jsonl` (`isSidechain`, `agentId`) + `agent-<id>.meta.json {agentType, description, toolUseId, parentAgentId, spawnDepth, effort}`; `SubagentStart/Stop` hooks | adapter backfill + hooks | verified on v2.1.319 |
| Claude Agent SDK | Runs Claude Code underneath. Subagents come from the `agents` option; hooks can be passed in code or loaded through `settingSources` | the same hooks + OTel env passed in the `env` option | inferred from the SDK docs; verify with a fixture |
| OpenAI Agents SDK | Trace → `agent` spans → `generation`, `function`, `handoff {from_agent, to_agent}` and `guardrail` spans | a custom `TracingProcessor` exporting OTLP, or OpenInference instrumentation → receiver | span types documented; OTLP attribute names (U) |
| LangGraph | Graph run → node runs; metadata `langgraph_node`, `langgraph_step`, `langgraph_triggers`; checkpoints | LangSmith OTel export (`LANGSMITH_OTEL_ENABLED=true`) or the OpenInference LangChain instrumentor → receiver | (U) attribute names |
| CrewAI | Crew → task → agent → tool | OpenInference CrewAI instrumentor → receiver | (U) |
| Mastra | `createWorkflow` / `createStep`, `.then` / `.parallel` / `.branch`; AI tracing span types for workflow run, step, agent run, LLM generation and tool call | Mastra observability with an OTLP exporter → receiver | (U) span type names |
| Any OTel app | Nested `invoke_agent` / `chat` / `execute_tool` spans (GenAI semconv, status Development) | receiver | verified (semconv) |

"(U)" items are confirmed by recording a fixture from a real run before the parser for them is
written. Parsers keep unknown fields in the raw blob, so a format change does not lose data.

## 2. Capture

### 2.1 Claude Code workflows

Three sources are merged by time and id:

1. **Journal.** At ingest, the Claude Code adapter's backfill globs `<session dir>/**/journal.jsonl`.
   Each journal is one workflow run. The parser reads the following, and keeps the rest raw:
   - per `agent()` call: ordinal, label, phase, the opts hash, status (returned / null / error),
     whether it was a cache hit on resume, and the return value (stored as a blob);
   - the run id, the script path and `resumeFromRunId` when present.

   Script hash: sha256 of the persisted script file. Args hash: sha256 of the args, when they
   appear in the journal or the host session's Workflow tool call input.
2. **Agent transcripts.** Each `agent-<id>.jsonl` is ingested as a child `Session` with `parent =
   {sessionId: host, subagentId: id, type: "workflow-agent"}`. Its tool calls, `llm.call` events
   and usage come from the normal Claude Code normalizer. StructuredOutput attempts are counted
   from its tool calls (§4).
3. **Host session events.** The Workflow tool call in the host session gives the run's start and
   end. If workflow agents fire `SubagentStart/Stop` in the host session (U: check with a fixture),
   those give live start and stop times. OTel `claude_code.llm_request` spans carry `agent_id` and
   `parent_agent_id` (v2.1.310+), which link model calls to agents even when transcripts are
   flushed late.

When the journal has no timestamps, an agent's start and end are taken from the first and last line
of its transcript. Phase membership comes from the `phase` field, or else from `phase()` order in
the script: a static scan of `phase('…')` calls. Group structure (which agents belong to one
`parallel()` or `pipeline()` call) is recorded in the journal if available (U). Otherwise it is
inferred: agents in the same phase whose start times fall within 2 s of each other form one
concurrent group.

### 2.2 OTel frameworks

The receiver stores spans as events (`traceId`, `spanId`, `parentSpanId`). `src/workflows/sources/otel.ts`
turns a trace into a tree:

| Span | Node kind |
|---|---|
| root span, or `gen_ai.operation.name = invoke_agent` with child agent spans | `workflow` |
| `invoke_agent` | `agent` (`gen_ai.agent.name`, `gen_ai.agent.id`) |
| `invoke_agent` under an `agent` | `subagent` |
| `chat` / `text_completion` / `generate_content` | `llm` |
| `execute_tool` | `tool` |
| framework step span (LangGraph node, Mastra step, CrewAI task, Agents SDK handoff) | `step`, or `handoff` with `from`/`to` |
| other span with agent descendants | `phase`, named after the span |

The framework mapping is a table in `sources/otel-frameworks.ts`, keyed by instrumentation scope
name, and is filled in from fixtures.

### 2.3 Workflows run by our own runner

`coding.sh workflows run` (§6) sets `CODING_SH_RUN_ID` and `CODING_SH_WORKFLOW_RUN_ID` in the
driver's env, so every event and span of the run carries the id, including those from child
processes that inherit the env. The tree is then built from those ids, with no time-window
matching.

## 3. Data model (proposed additions)

Proposed for `src/schema` and `src/core/types.ts`, for the contract owners to accept. Until they
land, `src/workflows/store.ts` persists runs as JSON blobs, indexed by a file
`~/.coding.sh/workflows/index.jsonl`.

```ts
export type WorkflowFramework =
  | "claude-code-workflow" | "claude-agent-sdk" | "openai-agents" | "langgraph" | "crewai" | "mastra" | "otel" | "command";

export interface WorkflowRun {
  id: string;                         // journal run id, or trace id, or our run id
  framework: WorkflowFramework;
  name: string;                       // meta.name / root span name
  scriptHash?: string; argsHash?: string; variant?: string;
  hostSessionId?: string;             // session that invoked the workflow
  resumedFrom?: string;               // previous run id (resume)
  startedAt: number; endedAt?: number;
  status: "ok" | "failed" | "aborted" | "running";
  concurrencyCap?: number;            // min(16, cpus − 2) for Claude Code workflows
  output?: BlobRef;                   // the workflow's return value
  stats: WorkflowStats;               // §4, maintained at ingest
  tags: string[]; experimentId?: string; caseId?: string; attempt?: number;
}

export type WorkflowNodeKind = "workflow" | "phase" | "group" | "agent" | "subagent" | "step" | "handoff" | "llm" | "tool";
export interface WorkflowNode {
  id: string; runId: string; parentId?: string; kind: WorkflowNodeKind;
  name: string;                       // label / span name / tool name
  phase?: string; groupId?: string; groupKind?: "parallel" | "pipeline" | "inferred";
  stage?: number; item?: number;      // pipeline stage index, item index
  ordinal?: number;                   // agent() call order (resume prefix)
  sessionId?: string;                 // child session holding this agent's transcript
  startedAt?: number; endedAt?: number;
  status: "ok" | "failed" | "null" | "skipped" | "cached" | "running";
  model?: string; effort?: string;
  usage?: Usage; latency?: LatencyStats;
  toolCalls?: number; toolErrors?: number; apiRetries?: number;
  schema?: { declared: boolean; attempts: number; failures: number; finalValid: boolean | null };
  inputHash?: string;                 // prompt + opts hash (replay matching)
  output?: BlobRef; error?: string;
}

// IndexStore additions
putWorkflowRun(run: WorkflowRun): Promise<void>;
getWorkflowRun(id: string): Promise<WorkflowRun | undefined>;
listWorkflowRuns(f?: { framework?: WorkflowFramework; name?: string; since?: number; experimentId?: string; limit?: number }): Promise<WorkflowRun[]>;
putWorkflowNodes(runId: string, nodes: WorkflowNode[]): Promise<void>;   // replaces the run's nodes
listWorkflowNodes(runId: string): Promise<WorkflowNode[]>;
```

Event additions: one optional field `AgentEvent.workflowRunId?: string`, set by normalizers when
known (§2.3, journal-linked transcripts). No new event kinds are needed. Phase and group structure
lives on `WorkflowNode`, not in the event stream.

## 4. Metrics

All metrics are computed by `metrics.ts` from the nodes. Times are in ms. "Agents" means nodes of
kind `agent` or `step` that ran (`status ≠ cached`), unless noted.

| Metric | Definition |
|---|---|
| `wallMs` | `endedAt − startedAt` of the run |
| `agentMs` | Σ agent durations |
| `parallelism` | `agentMs / wallMs` |
| `utilization` | ∫ (running agents) dt / (`concurrencyCap` × `wallMs`) |
| `peakConcurrency` | Max number of agents running at once |
| `criticalPathMs`, `criticalPath[]` | See below |
| `orchestrationGapMs` | Σ of gaps on the critical path where no agent of the path runs (queueing, script time, barrier waits) |
| `barrierIdleMs` | For each `parallel` group followed by later work: Σ over members of (`max end in group` − `member end`). This is agent-slot time spent waiting at the barrier. |
| `pipelineSavingsMs` | For barrier groups whose next stage maps items one-to-one (same `item`): `wallMs` minus the simulated wall time if every item ran its chain without the barrier, under the same cap. Reported only when item mapping is known. |
| `queueWaitMs` | Agent call issue time to start time, when the journal records issue times (U) |
| `perAgent[]` | Per node: duration, tokens, `costUsd`, `llmP50Ms`/`llmP95Ms`/`ttftP50Ms`, tool calls, tool errors, turns, model, effort |
| `perPhase[]` | Per phase: wall span, agent count, Σ duration, tokens, cost, failures |
| `apiRetries` | Σ API retry attempts (Claude Code `api_error.attempt`, `llm.call ok:false`) |
| `nullAgents`, `failedAgents` | Agents that returned `null` (skipped or died after retries) / ended in error. Rates are over all agents. |
| `schemaFailures` | StructuredOutput calls whose result was a validation error, summed over agents. `schemaFinalInvalid` counts agents that never produced a valid output. |
| `cacheHits`, `cacheHitRate` | Nodes with `status = cached` / all agent nodes in a resumed run |
| `resumeSavedMs`, `resumeSavedUsd` | Σ of the original durations and costs of cached nodes, looked up by `ordinal` in `resumedFrom` |
| `tokens`, `costUsd` | Σ over all nodes, including subagents |
| `costShareByPhase` | Phase cost / total |

A node's `costUsd` is the cost its transcript reported, or — when the agent reported none, as
Claude Code transcripts do, carrying tokens but no per-call cost — an estimate from the node's
token usage and the configured prices (`pricesFor(config.pricing)`, as everywhere else in
coding.sh), marked estimated. `coding.sh workflows import` prices as it reads, so per-agent,
per-phase and whole-run cost and `costShareByPhase` are populated; a run imported before this was
added shows cost after the next `coding.sh workflows import --force`.

**Critical path.** When the journal or spans give explicit dependencies (pipeline item chains,
group membership), the path is the longest weighted path in that DAG. Otherwise it is
approximated:

1. Start from the agent that ended last.
2. Repeatedly step to the agent that ended latest before the current one started.
3. Stop when no such agent exists.

The path and its gaps are returned, and `criticalPathExact: boolean` records which method was used.

## 5. Scoring workflow outputs

A workflow case is `{id, args, start?: RepoState snapshot, truth, split}`, stored in
`evals/workflows/<workflow>/cases/*.toml`. Graders by output type:

| Workflow type | Truth | Scores |
|---|---|---|
| Review / find (e.g. the Review → Verify stages of `coding-sh-improve.js`) | A seeded-bug set. Start from a clean snapshot, apply N bug patches (hand-written, or mutations from `src/eval/patch.ts` that make a test fail), and record `{id, file, lines:[a,b], category, severity}` | Matching (one finding ↔ one bug, greedy by line distance): same file, and the finding's line within `[a − 5, b + 5]`. When a finding has no line, an optional calibrated judge decides on the summary. `precision = matched findings / findings`, `recall = matched bugs / bugs`, `F1`, severity-weighted recall, `duplicateRate` (extra findings that match an already-matched bug). Unmatched findings are kept for human labeling, since a real unseeded bug counts against precision until labeled. |
| Verify stage | The same matching labels each finding that entered verify as real or spurious | Confusion matrix of survived/refuted vs real/spurious: `refuteAccuracy`, `falseKillRate` (real bugs refuted), `falseKeepRate` (spurious kept), κ against truth, and per-skeptic accuracy |
| Fix | Each case's `EvalTask` verifier (repo tests) | pass rate, regressions (previously passing tests that fail) |
| Synthesis / research | Rubric | Calibrated judge (`src/judge`); flagged `uncalibrated` below the κ threshold |
| Council / design loops | Programmatic budgets first (Lighthouse etc.), council relative score second | As in docs/design/dogfood.md §3.4 |

Seeded cases are validated before use: on the seeded snapshot, each bug's own test fails; with the
bug patch reverted, it passes. The truth file lives in `hidden/` and is never readable from the
workflow's working tree.

## 6. Experiments: A/B of workflow variants

A variant is `{name, script: path | framework entry command, args}`. Common axes:

| Axis | Example |
|---|---|
| Skeptics per finding | `args.skeptics = 2` vs `3`; survival rule majority vs unanimous |
| Barrier vs pipeline | `parallel()` stage boundary vs `pipeline()` |
| Model or effort per stage | verify stage `effort: "medium"` vs `"high"`; finder `model` |
| Prompt changes | lens descriptions, refute instructions |
| Fan-out width | number of lenses or finders |

Drivers:

- `claude-code-workflow`: `claude -p --settings <otel+hooks> "Run the workflow script at <path>
  with args <json>. Return its result as JSON and nothing else."` (U: confirm that the Workflow
  tool is available in `-p` mode; if it is not, run from an interactive session through `/loop`).
  The run id is read from the host session's Workflow tool result.
- `command`: any program, for example a LangGraph or Mastra app. It is called as
  `<cmd> --args <json>` with `CODING_SH_WORKFLOW_RUN_ID` set, and prints its output JSON on stdout.
  Its spans go to the receiver.

`runWorkflowExperiment` schedules (case, variant, attempt) jobs interleaved across variants, like
`scheduleJobs`. Concurrency defaults to 1, because a workflow already fans out internally.
`compareWorkflowVariants` pairs by case:

- **Quality:** a per-case F1 / pass-rate difference → `pairedBootstrap`. A binary case outcome
  (F1 ≥ the case threshold) → `mcnemarPaired`.
- **Cost, wall and critical path:** a per-case median difference → `pairedBootstrap`.
- **Pareto report:** each variant's (quality, cost, wall) point with CIs, and the list of variants
  that are dominated.
- **Verdict:** as in `CompareReport`, plus a per-stage breakdown showing where the cost or time
  moved.

## 7. Replay from journal

The Claude Code Workflow tool resumes a run with `resumeFromRunId`. The longest unchanged prefix of
`agent()` calls, in call order, returns cached results, and the first changed call and everything
after it run live.

`coding.sh workflows replay <runId> --script <edited.js> [--args json]` uses this to re-run only
the stages a variant changed.

- **Use.** Cheap A/B for late stages: verify prompts, synthesis, fix instructions. Upstream
  outputs are reused.
- **Limits.** Prefix caching is by call order, so a change in stage 1 re-runs everything. Inside
  a `pipeline()`, call order interleaves items across stages, so a stage-2 edit can invalidate the
  cache for items whose stage-1 calls come after the first stage-2 call. `replay` prints the
  predicted cache-hit count before running, from the ordinals of the base run.
- **Statistics.** A replay holds the upstream sample fixed, which understates variance. Replay
  experiments therefore use m ≥ 3 base runs per case and replay each, so the paired comparison
  resamples over base runs as well as over cases.
- **Control fork.** A replayed candidate differs from a fresh baseline in two ways: the edit, and
  the replay itself. Compare it against a control variant that resumes the unedited script from
  the same runs (A vs A'). `workflows compare` notes "no control fork" when the candidate resumes
  from runs the baseline never replays. When the control and its source runs are both scored, it
  reports how often the control's outcome changed from its source run as the replay noise floor
  (`control.drift` in `--json`). A log stitched from a recorded prefix and a new suffix is never
  scored as an outcome; only a re-executed run is (2608.08239: 3% of replayed states stayed valid).
- **Other frameworks.**
  - LangGraph: replay forks from a stored checkpoint (`get_state_history` → `update_state` /
    invoke with the checkpoint id); the command driver passes `--from-checkpoint`.
  - OpenAI Agents SDK, CrewAI, Mastra: no generic replay. The command driver may implement
    `--replay-from <node>` using the stored node inputs and outputs.

## 8. Viewer: Gantt timeline

Route `/workflows/:runId`, data from `GET /api/workflows/:runId/gantt` (`GanttData` in §10).

- One row per agent, grouped by phase. A bar spans start to end.
- Bar color:
  - green: ok;
  - red: failed;
  - grey: null or skipped;
  - outlined with hatching: cached.
- The critical path is drawn as a heavier outline. Barrier idle time is shaded after the early
  finishers in a group.
- A concurrency strip above the rows shows running agents over time against the cap line.
- Clicking a bar opens that agent's session timeline (the existing session view).
- A side panel shows per-phase cost and time, plus the metrics table from §4.
- Text and mobile fallback: the same data as a tab-separated table (`workflows show --gantt`).

## 9. Dogfooding on `coding-sh-improve.js`

`.claude/workflows/coding-sh-improve.js` is our own build/verify/improve workflow. Its phases are
Integrate, Build (4 parallel builders), Review (6 lenses, pipelined into 2 skeptics per finding),
Fix (one fixer per module), Site (QA + council loop), and Score. Every run is captured (the project
hooks from docs/design/dogfood.md §1 cover the host session; the journal and transcripts are picked up at
ingest) and scored.

Per-run record, appended to `tasks/dogfood/workflows.jsonl`:

| Score | Source |
|---|---|
| `wf.wallMs`, `wf.criticalPathMs`, `wf.utilization`, `wf.barrierIdleMs` | §4 |
| `wf.costUsd`, cost by phase | §4 |
| `wf.nullAgents`, `wf.schemaFailures`, `wf.apiRetries` | §4 |
| `wf.integrate.ok` | Integrate `DONE.ok` and the `CHECK` command green when re-run by the scorer (not the agent's claim) |
| `wf.review.precision`, `wf.review.recall` | Seeded mode, below |
| `wf.verify.falseKillRate`, `wf.verify.falseKeepRate` | Seeded mode |
| `wf.fix.regressions` | Tests failing after Fix that passed before |
| `wf.site.roundsToTarget`, `wf.site.costPerPoint` | Council loop: rounds used, and Δ(min score) per USD |
| `wf.score.headlineDelta` | docs/design/dogfood.md scorecard, before vs after the run |

**Seeded mode.** `args.seeded = "<case id>"` points Review at a worktree of the package with N
known bugs applied and skips Integrate, Build, Site and Score (`args.skip`). The script needs one
change to support this: it must read the review root from `args.root`. That change is proposed
here, not made. Five seeded cases with 8 bugs each form `evals/workflows/coding-sh-improve/cases/`.
Two held out, kept outside the repo.

First experiments to run, each paired over the 5 seeded cases with k = 3:

1. **Skeptic rule.** With 2 skeptics, the current rule keeps a finding when at least one skeptic
   fails to refute and fewer than 2 refute. That is "survive unless both refute". Compare it with
   3 skeptics and majority survival, on `falseKeepRate`, `recall` and verify cost.
2. **Verify effort.** `medium` vs `high` on the skeptics: does the extra cost lower
   `falseKeepRate`?
3. **Lens count.** 6 lenses vs 3 merged lenses: recall vs cost.
4. **Build barrier.** Build uses `parallel()` over four independent builders, and Review needs
   all of them, so the barrier is correct. Measure `barrierIdleMs` to see what the slowest builder
   costs.

The dogfood loop treats `wf.*` scores as reported (weight 0) until three runs exist. After that,
`wf.review.recall` (held-out cases) and `wf.verify.falseKeepRate` can be added to the headline with
human approval.

## 10. CLI and modules

| Command | Does |
|---|---|
| `coding.sh workflows list [--framework f] [--name n] [--since 7d] [--json]` | Runs with status, wall time, cost and agent count |
| `coding.sh workflows show <runId> [--tree] [--gantt] [--json]` | Tree with per-node time, cost and status; `--gantt` prints the TSV timeline |
| `coding.sh workflows stats <runId> [--json]` | §4 metrics |
| `coding.sh workflows score <runId> --case <caseId> [--json]` | §5 grading against the case truth |
| `coding.sh workflows run <workflow> --variant <v>… [--cases dir] [-k 3] [--split dev\|heldout] [--yes] [--json]` | §6 experiment; prints the experiment id |
| `coding.sh workflows compare <experimentId> --baseline <v> --candidate <v> [--json]` | §6 report |
| `coding.sh workflows replay <runId> --script <path> [--args json] [--dry-run]` | §7; `--dry-run` prints the predicted cache hits |

Output follows the Vercel CLI rules used across coding.sh: the result on stdout, progress on
stderr, `--json` as one document, exit codes 0/1/2/130. `run` and `replay` show the estimated cost
and require `--yes` above `confirmAboveUsd`.

```
src/workflows/
  types.ts          WorkflowRun, WorkflowNode, WorkflowStats, GanttData, WorkflowCase, Variant
  sources/claude-workflow.ts   journal + transcript + meta.json → nodes
  sources/otel.ts              span tree → nodes;  sources/otel-frameworks.ts (mapping table)
  tree.ts           merge sources, infer groups, attach child sessions
  metrics.ts        §4 (pure)
  critical-path.ts  exact DAG + approximation
  score/findings.ts matching, precision/recall/F1
  score/verify.ts   refute confusion matrix
  seed/bugs.ts      build seeded snapshots + truth, validate them
  experiment.ts     runWorkflowExperiment, compareWorkflowVariants
  replay.ts         prefix prediction, resume driving
  drivers/claude-workflow.ts   drivers/command.ts
  gantt.ts          GanttData builder
  store.ts          blob-backed persistence until the IndexStore additions land
src/cli/commands/workflows.ts
test/workflows/**   synthetic fixtures: a journal + transcripts for a 3-phase run with one barrier,
                    one pipeline, one null agent, one schema retry, one resumed run; an OTel
                    trace for an Agents SDK handoff and a LangGraph graph
```

```ts
export interface WorkflowStats {
  wallMs?: number; agentMs: number; parallelism?: number; utilization?: number; peakConcurrency: number;
  criticalPathMs?: number; criticalPathExact: boolean; orchestrationGapMs?: number;
  barrierIdleMs: number; pipelineSavingsMs?: number; queueWaitMs?: number;
  agents: number; nullAgents: number; failedAgents: number; apiRetries: number;
  schemaFailures: number; schemaFinalInvalid: number;
  cacheHits: number; cacheHitRate?: number; resumeSavedMs?: number; resumeSavedUsd?: number;
  tokens: Usage; costUsd?: number;
}
export interface GanttData {
  runId: string; startedAt: number; endedAt?: number; cap?: number;
  phases: { name: string; rows: { nodeId: string; label: string; start: number; end?: number;
    status: WorkflowNode["status"]; critical: boolean; idleAfterMs?: number; sessionId?: string; costUsd?: number }[] }[];
  concurrency: { t: number; running: number }[];
}
export interface WorkflowCase { id: string; workflow: string; split: "dev" | "heldout"; args: unknown;
  start?: { repoRoot: string; snapshot: string; head: string };
  truth: { kind: "seeded-bugs"; bugs: SeededBug[] } | { kind: "verifier"; command: string } | { kind: "judge"; rubric: string; judge: string } }
export interface SeededBug { id: string; file: string; lines: [number, number]; category: string; severity: "P0" | "P1" | "P2"; patch: BlobRef }

export function buildWorkflowTree(sources: { journal?: string; transcripts?: Session[]; spans?: AgentEvent[]; host?: AgentEvent[] }): { run: WorkflowRun; nodes: WorkflowNode[] };
export function workflowStats(run: WorkflowRun, nodes: WorkflowNode[], base?: { run: WorkflowRun; nodes: WorkflowNode[] }): WorkflowStats;
export function criticalPath(nodes: WorkflowNode[]): { path: string[]; ms: number; exact: boolean; gaps: { after: string; ms: number }[] };
export function matchFindings(findings: { file: string; line?: number; summary: string }[], bugs: SeededBug[], o?: { slack?: number; judge?: JudgeFn }):
  { matches: [number, string][]; precision: number; recall: number; f1: number; duplicates: number; unmatched: number[] };
export function verifyConfusion(entered: { findingIdx: number; survived: boolean; votes?: boolean[] }[], real: Set<number>):
  { refuteAccuracy: number; falseKillRate: number; falseKeepRate: number; kappa: number };
export function runWorkflowExperiment(o: { workflow: string; variants: WorkflowVariant[]; cases: WorkflowCase[]; k: number; driver: WorkflowDriver;
  index: IndexStore; blobs: BlobStore }): Promise<{ experimentId: string; runs: WorkflowRun[] }>;
export function compareWorkflowVariants(runs: WorkflowRun[], scores: Map<string, number>, o: { baseline: string; candidate: string }): WorkflowCompareReport;
export interface WorkflowDriver { id: string; run(v: WorkflowVariant, c: WorkflowCase, env: Record<string, string>): Promise<{ runId: string; output: unknown; exitCode: number | null }> }
```

## 11. Build order

1. Record fixtures. Run a tiny 3-phase workflow (one barrier, one pipeline, one schema-forced
   agent) and one resumed run in a temp project, then commit the redacted journal and transcripts
   under `test/workflows/fixtures/`. This settles every "(U)" for Claude Code workflows.
2. `sources/claude-workflow.ts` + `tree.ts` + `metrics.ts` + `critical-path.ts`, with
   `workflows list|show|stats`.
3. Gantt data and the viewer route.
4. Seeded-bug cases for `coding-sh-improve.js`, plus `score/*`.
5. Experiments and compare; then replay.
6. OTel framework mappings, one per fixture: Agents SDK, LangGraph, Mastra, CrewAI.
