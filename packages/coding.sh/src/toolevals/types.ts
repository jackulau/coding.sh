// Tool evals (docs/TOOL-EVALS.md §14): how well an agent uses one CLI, MCP
// server or HTTP API. Every metric comes from captured traces plus an
// agent-independent tap on the tool; nothing is self-reported by the agent.
import type { AgentEvent, AgentId, BlobRef, Usage } from "../schema/index.ts";
import type { BootstrapResult, Interval } from "../stats/interval.ts";
import type { McNemarResult } from "../stats/tests.ts";
import type { VerdictKind } from "../runner/experiment.ts";
import type { Divergence } from "../runner/divergence.ts";
import type { CallsSpec } from "./calls.ts";
import type { InfraKind } from "../jobs/retry.ts";
import type { OutputCapConfig } from "./model/cap.ts";
import type { CaseKind, KindSummary } from "../datasets/types.ts";
import type { KindComparisonReport } from "../datasets/kinds.ts";

export type { OutputCapConfig };

// ------------------------------------------------------------ targets

export interface TargetBase {
  name: string;
  /** Sandbox-relative globs whose reads count as doc lookups. */
  docs?: string[];
  /** Hosts/URLs whose fetches count as doc lookups. */
  docsUrls?: string[];
  /** Env for the tool process; `${sandbox}`, `${work}`, `${home}` expand per trial. */
  env?: Record<string, string>;
}

export interface CliTarget extends TargetBase {
  kind: "cli";
  /** The name the agent types. */
  bin: string;
  /** The real binary plus prefix args. */
  command: string[];
  usageExitCodes: number[];
  usagePatterns: string[];
  helpCrawl: boolean;
}

/** OAuth for an HTTP MCP target (model driver). Without it, a 401 still runs OAuth with dynamic client registration. */
export interface McpOAuth {
  clientId?: string;
  /** Env var holding the client secret. */
  clientSecretEnv?: string;
  scope?: string;
  grant?: "authorization_code" | "client_credentials";
  redirectUri?: string;
}

export type McpTarget = TargetBase & { kind: "mcp"; docTools?: string[]; validationPatterns?: string[] } & (
    | { transport: "stdio"; command: string[] }
    | { transport: "http"; url: string; headers?: Record<string, string>; oauth?: McpOAuth }
  );

export interface HttpTarget extends TargetBase {
  kind: "http";
  baseUrl: string;
  /** OpenAPI document (path relative to the suite dir, or absolute). */
  openapi?: string;
  auth?: { header: string; env: string };
  /** Env var that receives the proxy URL (default `<NAME>_URL`). */
  urlEnv?: string;
}

export type Target = CliTarget | McpTarget | HttpTarget;

export interface Variant {
  name: string;
  /** CLI / MCP-stdio: a different build or entry point. */
  command?: string[];
  env?: Record<string, string>;
  /** HTTP / MCP-http: a different URL. */
  url?: string;
  /** MCP tool → description. */
  descriptions?: Record<string, string>;
  /** MCP tool → param → description. */
  paramDescriptions?: Record<string, Record<string, string>>;
  hideTools?: string[];
  /** Harness bundle id or name for agent drivers. */
  bundle?: string;
  /** Model driver: tool-output cap for this variant (wins over the driver's). */
  outputCap?: OutputCapConfig;
  /** Model driver: Anthropic prompt caching for this variant (wins over the driver's). */
  promptCache?: boolean;
}

/** Model driver: a model that plays the shell (TB-14). Shell tool calls go to it, never to a real shell. */
export interface ShellSim {
  provider: "anthropic" | "openai" | "openai-chat";
  model: string;
  baseUrl?: string;
  apiKeyEnv: string;
  /** The date the simulated machine reports (ISO 8601). */
  date?: string;
}

// ------------------------------------------------------------ drivers

export type Driver =
  | { kind: "agent"; agent: AgentId; model?: string; flags?: string[] }
  | {
      kind: "model";
      provider: "anthropic" | "openai" | "openai-chat";
      model: string;
      baseUrl?: string;
      apiKeyEnv: string;
      system?: string;
      maxOutputTokens?: number;
      temperature?: number;
      /** Tool-output cap (default: structure mode, 16 KB). */
      outputCap?: OutputCapConfig;
      /** Anthropic: top-level `cache_control: {type: "ephemeral"}` on every request (default true). */
      promptCache?: boolean;
      /** Simulated shell for the CLI `shell` tool; part of the driver key. */
      shell?: ShellSim;
    };

export const driverKey = (d: Driver): string =>
  d.kind === "agent" ? `agent:${d.agent}${d.model ? ":" + d.model : ""}` : `model:${d.provider}/${d.model}${d.shell ? `+shell:${d.shell.provider}/${d.shell.model}` : ""}`;

/** The simulated shell model a driver key names (`provider/model`), if any. */
export const shellModelOf = (driver: string): string | undefined => /\+shell:(.+)$/.exec(driver)?.[1];

/** Arms are named `<variant>@<driver>`. */
export const armKey = (variant: string, driver: string): string => `${variant}@${driver}`;

// ------------------------------------------------------------ tasks

export interface Budget {
  turns?: number;
  tokens?: number;
  wallMs?: number;
  costUsd?: number;
}

export type StateAssertion =
  | { file: string; exists?: boolean; contains?: string; regex?: string; jsonPath?: string; equals?: unknown }
  | { command: string; stdoutContains?: string; jsonPath?: string; equals?: unknown };

export type Check =
  | { kind: "command"; run: string; timeoutMs?: number; hiddenFiles?: Record<string, string> }
  | { kind: "state"; assert: StateAssertion[] }
  | {
      kind: "output";
      equals?: string;
      contains?: string[];
      regex?: string;
      jsonPath?: string;
      jsonEquals?: unknown;
      normalize?: ("trim" | "lower" | "collapse-ws")[];
    }
  | { kind: "judge"; judge: string; rubric: string }
  | ({ kind: "calls" } & CallsSpec);

/** A scripted answer to an MCP elicitation/create request (model driver). The first whose `match` regex finds the server's message wins. */
export interface ElicitAnswer {
  match?: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** What the model driver's MCP client does for a task (§10.3). */
export interface TaskMcp {
  /** Get this prompt before the run; its text goes before the instruction. */
  prompt?: { name: string; arguments?: Record<string, string> };
  /** Answers to elicitation requests; with none, the client declines. */
  elicitation?: ElicitAnswer[];
  /** roots/list: paths relative to the sandbox work dir, or absolute (default: the work dir). */
  roots?: string[];
}

/** Structurally a Case: id, input (= instruction), tags, metadata. */
export interface ToolTask {
  id: string;
  target: string;
  split: "dev" | "heldout";
  tags: string[];
  instruction: string;
  setup: { commands: string[]; files: Record<string, string>; env: Record<string, string> };
  checks: Check[];
  budget: Budget;
  reference?: string[];
  expect?: { minTargetCalls?: number };
  /** MCP targets, model driver: prompt, elicitation answers and roots. */
  mcp?: TaskMcp;
  status: "draft" | "validated";
  /** TB-12: bad (fails on the old variant, passes on the new), guard or control (pass on both). Absent for an ordinary task. */
  kind?: CaseKind;
  /** File path (and line for JSONL), for error messages. */
  source: string;
  /** Suite dir (`evals/toolevals/<target>/`): setup files and `${fixtures}` resolve against it. */
  suiteDir?: string;
}

// ------------------------------------------------------------ taps

export type TapClass = "ok" | "invalid" | "failed" | "help" | "meta";

export interface TapRecord {
  ts: number;
  durationMs: number;
  target: "cli" | "mcp" | "http";
  class: TapClass;
  reason?: string;
  // cli
  argv?: string[];
  cwd?: string;
  exitCode?: number | null;
  stderrHead?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  // mcp
  method?: string;
  tool?: string;
  /** tools/call arguments, redacted; left out above 4 KB of JSON. */
  args?: Record<string, unknown>;
  rpcErrorCode?: number;
  isError?: boolean;
  schemaViolations?: string[];
  serverStderr?: string;
  /** "server": a server → client request (sampling, elicitation, roots). */
  direction?: "server";
  // http
  httpMethod?: string;
  pathTemplate?: string;
  status?: number;
  requestBytes?: number;
  responseBytes?: number;
}

// ------------------------------------------------------------ results

export interface ToolMetrics {
  success: boolean;
  budgetExceeded?: keyof Budget;
  turns: number;
  turnsSource: "llm.call" | "messages" | "adapter";
  toolCalls: number;
  targetCalls: number;
  invalidCalls: number;
  invalidRate: number;
  invalidKinds: Record<string, number>;
  failedCalls: number;
  helpLookups: number;
  helpBytesRead: number;
  retries: number;
  selfCorrections: number;
  recoveryRate: number | null;
  firstCallCorrect: boolean | null;
  callsToFirstCorrect: number | null;
  timeToFirstCorrectMs: number | null;
  efficiency: number | null;
  usage: Usage;
  costUsd: number | null;
  costSource: "reported" | "estimated" | "none";
  wallMs: number;
  llmP50Ms?: number;
  llmP95Ms?: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  latencySource: "model-driver" | "otel-trace" | "otel-log" | "hooks" | "approx" | "none";
  targetLatencyP50Ms?: number;
  targetLatencyP95Ms?: number;
  toolLatencyP95Ms?: number;
  subagents: number;
  subagentTargetCalls: number;
  subagentTokenShare: number | null;
  tapCoverage: number | null;
  /** Model driver: tool results the output cap changed. */
  outputCuts?: number;
  /** outputCuts / tool results; null with no tool results. */
  outputCutRate?: number | null;
  /** Cut results that were JSON and reached the model as broken JSON. */
  brokenJsonCuts?: number;
  /** `tool.key` → share of cut JSON results of that tool whose top-level key reached the model. Only when a JSON result was cut. */
  fieldDelivery?: Record<string, number>;
  /** cacheRead / (input + cacheRead + cacheWrite); null with no prompt tokens. */
  cacheReadShare?: number | null;
  /** The same usage with cache reads and writes priced at the input rate; null when cost is unknown or reported. */
  flatCostUsd?: number | null;
}

export interface SurfaceReport {
  target: string;
  variant: string;
  surfaceBytes: number;
  descriptionBytes: number;
  surfaceTokens: number;
  tokensEstimated: boolean;
  /** Per tool or subcommand. */
  items: { name: string; bytes: number; descriptionBytes: number }[];
}

export interface CheckResult {
  kind: Check["kind"];
  pass: boolean;
  detail?: string;
}

export interface TrialResult {
  id: string;
  experimentId: string;
  taskId: string;
  /** The task's kind when it has one. */
  kind?: CaseKind;
  variant: string;
  driver: string;
  attempt: number;
  sessionId?: string;
  childSessionIds: string[];
  pass: boolean;
  checks: CheckResult[];
  metrics: ToolMetrics;
  tapBlob?: BlobRef;
  error?: string;
  /**
   * The trial failed on infrastructure, not on the task: a setup step failed
   * (after one retry), the agent was not logged in, or a rate limit, 5xx or
   * network error outlasted its retries. Its outcome is unknown: it is left
   * out of pass rates and paired comparisons and counted on its own.
   */
  infra?: InfraKind;
  /** Attempts the trial took when infrastructure errors were retried; absent for one. */
  attempts?: number;
  /** Model driver with a simulated shell: its `provider/model`. */
  shellModel?: string;
  startedAt: number;
  endedAt: number;
}

/** Prices in USD per million tokens, keyed by model id (`[prices."<model>"]`). Defined in core/pricing.ts. */
export type { Prices } from "../core/pricing.ts";

/** Judge hook for `judge` checks; results stay flagged uncalibrated until the judge's κ passes. */
export type JudgeFn = (o: { judge: string; rubric: string; output: string }) => Promise<{ pass: boolean; calibrated?: boolean; detail?: string }>;

// ------------------------------------------------------------ MCP

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object;
  annotations?: object;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: string; [k: string]: unknown };

export interface CallToolResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

// ------------------------------------------------------------ compare / compress

export interface ToolArmSummary {
  arm: string;
  variant: string;
  driver: string;
  trials: number;
  passes: number;
  passRate: Interval;
  /** Tasks where all k trials pass (pass^k). */
  passAllK: number;
  /** Tasks where at least one trial passes (pass@k). */
  passAnyK: number;
  /** Task errors among the trials with a known outcome. */
  errors: number;
  /** Trials that failed on infrastructure (outcome unknown), left out of `trials`, `passes` and the rates; absent when none. */
  infra?: number;
  latencySource: ToolMetrics["latencySource"] | "mixed";
  /** Adaptive sampling: per-task verdicts (a task fails at half or more failing trials); no CI applies. */
  verdicts?: { passed: number; failed: number; tieBreaks: number };
  /** Only when a trial of the arm had cache tokens: mean cost per trial, cache-aware and flat, and the cache-read share of prompt tokens. */
  cost?: { costUsd: number | null; flatCostUsd: number | null; cacheReadShare: number | null };
  /** Only when a trial of the arm had a capped tool result. */
  cuts?: { outputCuts: number; toolResults: number; outputCutRate: number | null; brokenJsonCuts: number };
  /** Pass rate per task kind; only when a trial's task had a kind. */
  kinds?: Partial<Record<CaseKind, KindSummary>>;
}

export interface ToolTaskOutcome {
  taskId: string;
  baseline: { passes: number; trials: number };
  candidate: { passes: number; trials: number };
  diff: number;
}

export type ContinuousMetric =
  | "turns"
  | "tokens"
  | "costUsd"
  | "wallMs"
  | "invalidRate"
  | "helpLookups"
  | "llmP95Ms"
  | "targetLatencyP95Ms"
  | "flatCostUsd"
  | "outputCutRate"
  | "brokenJsonCuts";

export interface ToolMetricDelta {
  /** Mean over paired tasks of the per-task median. */
  baseline: number;
  candidate: number;
  /** Paired bootstrap over per-task median differences (candidate − baseline). */
  diff: BootstrapResult;
  /** Exact two-sided paired permutation p on the same per-task differences (Monte Carlo above 20 tasks). */
  p: number;
  relative: number;
  /**
   * All these metrics are lower-is-better. "better" or "worse" needs the CI to
   * exclude 0 and p below alpha; a CI that excludes 0 without that is "inconclusive".
   */
  verdict: VerdictKind;
  n: number;
}

export interface ToolRegression {
  taskId: string;
  kind: "success" | "metric";
  metric?: ContinuousMetric;
  detail: string;
  baselineTrials: { id: string; sessionId?: string }[];
  candidateTrials: { id: string; sessionId?: string }[];
  firstDivergence?: Divergence;
}

export interface ToolCompareReport {
  baseline: ToolArmSummary;
  candidate: ToolArmSummary;
  /** "variant" when the arms share the driver, "driver" when they share the variant. */
  comparing: "variant" | "driver";
  tasks: ToolTaskOutcome[];
  pairedTasks: number;
  unpairedTasks: string[];
  k: number;
  diff: BootstrapResult;
  /** Exact McNemar over attempt-aligned trial pairs. */
  mcnemar: McNemarResult;
  /**
   * Two-sided task-paired permutation test on the same per-task pass-rate
   * differences as `diff` (stats.pairedPermutation): exact up to 20 tasks.
   * Reported only; the verdict still uses the bootstrap and McNemar.
   */
  permutation: { p: number; method: "exact" | "monte-carlo" };
  metrics: Partial<Record<ContinuousMetric, ToolMetricDelta>>;
  surface?: {
    baseline: SurfaceReport;
    candidate: SurfaceReport;
    surfaceBytes: { delta: number; relative: number };
    descriptionBytes: { delta: number; relative: number };
    surfaceTokens: { delta: number; relative: number };
  };
  verdict: { kind: VerdictKind; text: string };
  regressions: ToolRegression[];
  /** TB-12: baseline → candidate per task kind (bad fixed, guards broken, controls broken = overcorrection); only when a paired task has a kind. */
  kinds?: KindComparisonReport;
  notes: string[];
  alpha: number;
}

export interface CompressStep {
  tool: string;
  fromBytes: number;
  toBytes: number;
  accepted: boolean;
  source: "rule" | "model";
  evidence: { diffLo: number; invalidRateHi: number; lostTasks: string[]; trials: number; reason?: string };
}

export interface CompressReport {
  steps: CompressStep[];
  /** Final description overrides: tool → description. */
  final: Record<string, string>;
  /** Final param description overrides. */
  finalParams: Record<string, Record<string, string>>;
  bytesBefore: number;
  bytesAfter: number;
  surfaceTokensBefore: number;
  surfaceTokensAfter: number;
  evals: number;
  heldout?: ToolCompareReport;
  overfit: boolean;
  notes: string[];
}

export type { AgentEvent };
