// Workflow runs as trees (docs/design/workflows.md §3, §10). These types are the
// proposed contract additions; until src/schema and src/core/types.ts accept
// them they live here, and src/workflows/store.ts persists them.
import type { BlobRef, LatencyStats, Usage } from "../schema/index.ts";
import type { BootstrapResult, McNemarResult } from "../stats/index.ts";

export type WorkflowFramework =
  | "claude-code-workflow"
  | "claude-agent-sdk"
  | "openai-agents"
  | "langgraph"
  | "crewai"
  | "mastra"
  | "otel"
  | "command"
  // Durable workflow engines (src/otel/durable.ts): one run, stitched across processes.
  | "vercel-workflow"
  | "temporal"
  | "inngest"
  | "restate"
  | "dbos";

export interface WorkflowRun {
  /** Journal run id, or trace id, or our run id. */
  id: string;
  framework: WorkflowFramework;
  /** meta.name / root span name. */
  name: string;
  scriptHash?: string;
  argsHash?: string;
  variant?: string;
  /** Session that invoked the workflow. */
  hostSessionId?: string;
  /** Previous run id (resume). */
  resumedFrom?: string;
  startedAt: number;
  endedAt?: number;
  status: "ok" | "failed" | "aborted" | "running";
  /** min(16, cpus − 2) for Claude Code workflows, when known. */
  concurrencyCap?: number;
  /** The workflow's return value. */
  output?: BlobRef;
  /** The script text (Claude Code workflows), for replay predictions. */
  script?: BlobRef;
  /** §4, maintained at ingest. */
  stats: WorkflowStats;
  tags: string[];
  experimentId?: string;
  caseId?: string;
  attempt?: number;
  /** Driver attempts when infrastructure errors (rate limit, 5xx, network) were retried; absent for one. */
  attempts?: number;
  /** The last attempt still failed on an infrastructure error: outcome unknown, left out of comparisons, re-run by `workflows run --resume`. */
  infra?: "rate-limit" | "server" | "network" | "tempfail";
  /** Phase titles in script order (meta.phases), when known. */
  phases?: string[];
  /**
   * Launched segments of a run resumed in place (a Claude Code workflow stopped and resumed in
   * the same run dir), first to last; absent for a run launched once. The gaps between them are
   * not active time.
   */
  segments?: { startedAt: number; endedAt: number }[];
  /** Where the run was read from (journal path, trace id, driver), for re-import. */
  source?: { kind: "journal" | "otel" | "driver"; path?: string; signature?: string };
}

/** "wait": a durable sleep or wait for an event; time inside it is not busy time. */
export type WorkflowNodeKind = "workflow" | "phase" | "group" | "agent" | "subagent" | "step" | "handoff" | "llm" | "tool" | "wait";
/**
 * "cancelled": stopped by the operator before it returned (its transcript ends with Claude Code's
 * "[Request interrupted by user]"). "superseded": it never returned and a later call with the same
 * label ran in its place (a re-run after a resume). Neither counts as a failure.
 */
export type WorkflowNodeStatus = "ok" | "failed" | "null" | "skipped" | "cached" | "running" | "cancelled" | "superseded";

export interface WorkflowNode {
  id: string;
  runId: string;
  parentId?: string;
  kind: WorkflowNodeKind;
  /** label / span name / tool name. */
  name: string;
  phase?: string;
  groupId?: string;
  groupKind?: "parallel" | "pipeline" | "inferred";
  /** Pipeline stage index, item index. */
  stage?: number;
  item?: number;
  /** agent() call order (resume prefix). */
  ordinal?: number;
  /** Child session holding this agent's transcript. */
  sessionId?: string;
  /**
   * The agent ran earlier in this run, and a later resume of the same run replayed its result
   * instead of running it again (the persisted record marks it cached). Its status keeps how it ended.
   */
  cacheHit?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** When the call was issued (queue wait = startedAt − issuedAt), if recorded. */
  issuedAt?: number;
  status: WorkflowNodeStatus;
  model?: string;
  effort?: string;
  usage?: Usage;
  latency?: LatencyStats;
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  apiRetries?: number;
  schema?: { declared: boolean; attempts: number; failures: number; finalValid: boolean | null };
  /** Prompt + opts hash (replay matching); the journal key for Claude Code workflows. */
  inputHash?: string;
  /** Explicit dependencies (node ids) when the source records them. */
  deps?: string[];
  /** Handoff endpoints (OpenAI Agents SDK). */
  from?: string;
  to?: string;
  output?: BlobRef;
  error?: string;
  /** Durable step attempt number (1-based) and how many attempts its step made. */
  attempt?: number;
  attempts?: number;
  /** A durable step attempt the engine never reported (its process stopped); its time is inferred. */
  lost?: boolean;
  /** A lost attempt: time after its process was last seen until the next attempt started (downtime, not work). */
  lostMs?: number;
  /** The run resumed here after a crash, a deploy, a worker restart or a durable wait. */
  resume?: "crash" | "deploy" | "restart" | "wait";
  /** Process that ran this durable step attempt. */
  instance?: string;
}

export interface AgentMetric {
  nodeId: string;
  label: string;
  phase?: string;
  status: WorkflowNodeStatus;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  llmP50Ms?: number;
  llmP95Ms?: number;
  ttftP50Ms?: number;
  toolCalls?: number;
  toolErrors?: number;
  turns?: number;
  model?: string;
  effort?: string;
}

export interface PhaseMetric {
  phase: string;
  startedAt?: number;
  endedAt?: number;
  wallMs?: number;
  agents: number;
  agentMs: number;
  tokens: number;
  costUsd?: number;
  failures: number;
  /** Agents stopped by the operator, and agents a later same-label call replaced; absent when none. */
  cancelled?: number;
  superseded?: number;
}

export interface WorkflowStats {
  /** First launch to last result, across every segment of a resumed run. */
  wallMs?: number;
  /** wallMs minus the gaps between segments of a run resumed in place; absent for a run launched once. */
  activeMs?: number;
  /** Launched segments of a run resumed in place; absent for one. */
  segments?: number;
  agentMs: number;
  parallelism?: number;
  utilization?: number;
  peakConcurrency: number;
  criticalPathMs?: number;
  criticalPathExact: boolean;
  criticalPath?: string[];
  orchestrationGapMs?: number;
  /** Durable runs: time inside sleeps and waits (wait nodes), left out of orchestrationGapMs. */
  waitMs?: number;
  /** Durable runs: step attempts after a step's first. */
  stepRetries?: number;
  /** Durable runs: time lost to crashed attempts after their process was last seen, left out of agentMs and orchestrationGapMs. */
  lostMs?: number;
  barrierIdleMs: number;
  pipelineSavingsMs?: number;
  queueWaitMs?: number;
  agents: number;
  nullAgents: number;
  failedAgents: number;
  /** Agents stopped by the operator / replaced by a later same-label call: left out of agents and the rates; absent when none. */
  cancelledAgents?: number;
  supersededAgents?: number;
  /** Over all agent nodes, cached included, cancelled and superseded left out. */
  nullRate?: number;
  failRate?: number;
  apiRetries: number;
  schemaFailures: number;
  schemaFinalInvalid: number;
  cacheHits: number;
  cacheHitRate?: number;
  resumeSavedMs?: number;
  resumeSavedUsd?: number;
  tokens: Usage;
  costUsd?: number;
  costShareByPhase?: Record<string, number>;
  perAgent?: AgentMetric[];
  perPhase?: PhaseMetric[];
}

export interface GanttRow {
  nodeId: string;
  label: string;
  start: number;
  end?: number;
  status: WorkflowNode["status"];
  critical: boolean;
  idleAfterMs?: number;
  sessionId?: string;
  costUsd?: number;
  /** Durable runs: a wait row (a gap, not work), attempt numbers, the resume reason. */
  wait?: boolean;
  /** A lost durable attempt (its process stopped before it reported). */
  lost?: boolean;
  attempt?: number;
  attempts?: number;
  resume?: WorkflowNode["resume"];
}

export interface GanttData {
  runId: string;
  startedAt: number;
  endedAt?: number;
  cap?: number;
  phases: { name: string; rows: GanttRow[] }[];
  concurrency: { t: number; running: number }[];
}

export interface SeededBug {
  id: string;
  file: string;
  lines: [number, number];
  category: string;
  severity: "P0" | "P1" | "P2";
  patch: BlobRef;
  /** Test command that fails with this bug applied and passes with it reverted (validation). */
  test?: string;
}

export type WorkflowTruth =
  | { kind: "seeded-bugs"; bugs: SeededBug[] }
  | { kind: "verifier"; command: string }
  | { kind: "judge"; rubric: string; judge: string };

export interface WorkflowCase {
  id: string;
  workflow: string;
  split: "dev" | "heldout";
  args: unknown;
  start?: { repoRoot: string; snapshot: string; head: string };
  truth: WorkflowTruth;
  /** Binary outcome threshold for McNemar (score ≥ threshold counts as a pass). Default 0.5. */
  threshold?: number;
}

export interface WorkflowVariant {
  name: string;
  /** Claude Code workflow script path. */
  script?: string;
  /** Framework entry command (command driver). */
  command?: string[];
  args?: unknown;
  /** Resume from this run id (replay). */
  resumeFromRunId?: string;
}

/** Inputs buildWorkflowTree merges. */
export interface TreeSources {
  /** journal.jsonl text. */
  journal?: string;
  /** Persisted run record (<session>/workflows/<runId>.json), parsed. */
  record?: Record<string, unknown>;
  /** agent-<id>.meta.json contents, keyed by agent id. */
  meta?: Record<string, Record<string, unknown>>;
  /** Child sessions of the workflow agents (parent.subagentId = agent id). */
  transcripts?: import("../schema/index.ts").Session[];
  /** Normalized transcript events per agent id (tool calls, llm.call, errors). */
  agentEvents?: Record<string, import("../schema/index.ts").AgentEvent[]>;
  /** OTel-derived events (receiver output) with traceId/spanId/parentSpanId. */
  spans?: import("../schema/index.ts").AgentEvent[];
  /** Host session events (Workflow tool call, SubagentStart/Stop). */
  host?: import("../schema/index.ts").AgentEvent[];
  /** Host session id (directory name of the session that ran the workflow). */
  hostSessionId?: string;
  /** Script text, for the script hash and the static phase() scan. */
  script?: string;
  /** Run id override (e.g. our CODING_SH_WORKFLOW_RUN_ID). */
  runId?: string;
  framework?: WorkflowFramework;
  /** Concurrency cap override. */
  concurrencyCap?: number;
}

export interface WorkflowDriverResult {
  runId: string;
  output: unknown;
  exitCode: number | null;
  /** Sources to build the run tree from, when the driver can find them. */
  sources?: TreeSources;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface WorkflowDriver {
  id: string;
  run(v: WorkflowVariant, c: WorkflowCase, env: Record<string, string>): Promise<WorkflowDriverResult>;
}

export interface MetricCompare {
  key: "quality" | "costUsd" | "wallMs" | "criticalPathMs";
  /** Mean over paired cases of the per-case value (median over attempts for cost/time, mean for quality). */
  baseline: number;
  candidate: number;
  /** Paired bootstrap over cases of candidate − baseline. */
  diff: BootstrapResult;
  pairs: number;
}

export interface ParetoPoint {
  variant: string;
  cases: number;
  quality: { mean: number; lo: number; hi: number };
  costUsd: { mean: number; lo: number; hi: number };
  wallMs: { mean: number; lo: number; hi: number };
  /** Point means: no other variant is at least as good on every axis and better on one. */
  dominated: boolean;
  dominatedBy?: string[];
  /**
   * Share of bootstrap draws (runs and cases reweighted) in which no other variant dominates
   * this one on the report's frontierAxes; absent when the variant can't be placed (see notes).
   */
  pFront?: number;
}

/** How to pick the variant to deploy from the compared variants (ParetoSaddler §3.3). */
export type DeploymentRule =
  /** Cheapest variant whose quality lower bound reaches qMin, or the baseline's mean minus pp points. */
  | { kind: "min-cost"; qMin?: number; qDropFrom?: { variant: string; pp: number } }
  /** Highest quality − lambda × cost (point means). */
  | { kind: "weighted"; lambda: number }
  /** The quality-extreme and cost-extreme variants on the front (pFront ≥ 0.5; non-dominated without pFront). */
  | { kind: "pareto" };

export interface Deployment {
  rule: DeploymentRule;
  /** Variants picked; empty when none qualifies. */
  picked: string[];
  reason: string;
}

export interface StageDelta {
  phase: string;
  baseline: { costUsd?: number; wallMs?: number; agentMs: number };
  candidate: { costUsd?: number; wallMs?: number; agentMs: number };
  deltaCostUsd?: number;
  deltaWallMs?: number;
  deltaAgentMs: number;
}

export interface WorkflowCompareReport {
  baseline: string;
  candidate: string;
  runs: { baseline: number; candidate: number };
  pairedCases: number;
  unpairedCases: string[];
  quality: MetricCompare;
  mcnemar: McNemarResult;
  metrics: MetricCompare[];
  pareto: ParetoPoint[];
  /** The axes pFront is measured on: cost when runs record it, else wall time. */
  frontierAxes?: ["quality", "costUsd" | "wallMs"];
  /** Present when a deployment rule was given. */
  deployment?: Deployment;
  stages: StageDelta[];
  verdict: { kind: "better" | "worse" | "no-difference" | "inconclusive"; text: string };
  notes: string[];
  alpha: number;
  /**
   * Present when candidate runs resume from recorded runs: the baseline runs that resume
   * from the same ones (the control fork, A vs A'), and how often a control replay's outcome
   * differs from its source run's (the replay noise floor), when both are scored.
   */
  control?: ReplayControl;
}

export interface ReplayControl {
  /** Recorded runs the candidate resumes from. */
  sources: string[];
  /** Baseline runs that resume from one of those sources. */
  controlRuns: number;
  /** Control replays whose pass at the threshold differs from their source run's. */
  drift?: { n: number; changed: number; rate: number };
}
