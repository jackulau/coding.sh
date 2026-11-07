// coding.sh/trace v0 — the open event format every adapter normalizes into.
//
// Stability: v0 is a draft. Breaking changes bump SCHEMA_VERSION and ship a
// migration in src/core (raw payloads are kept as blobs, so events can always
// be re-normalized from source).

export const SCHEMA_VERSION = 0 as const;
export const SCHEMA_ID = "coding.sh/trace" as const;

export const EVENT_KINDS = [
  "session.start",
  "session.end",
  "user.message",
  "assistant.message",
  "llm.call",
  "tool.start",
  "tool.end",
  "context.compact",
  "turn.end",
  "subagent.start",
  "subagent.end",
  "file.change",
  "test.result",
  "notification",
  "span",
  "error",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Known agent ids. Third-party adapters may use any other kebab-case id. */
export const KNOWN_AGENTS = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "gemini-cli",
  "antigravity",
  "copilot-cli",
  "amp",
  "pi",
  "droid",
  "goose",
  "aider",
  "t3code",
  "wrapper",
] as const;
export type AgentId = (typeof KNOWN_AGENTS)[number] | (string & {});

/** sha256 hex of the uncompressed content. */
export type BlobRef = string;

export interface RepoState {
  /** Absolute path of the repository root. */
  root: string;
  /** HEAD commit at the time of the event ("" for an unborn branch). */
  head: string;
  /** Snapshot commit in the shadow repo capturing the full working tree. */
  snapshot?: string;
  /** True when the snapshot fell back to tracked-files-only. */
  partial?: boolean;
  branch?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Reported (agent or gateway) or, when `estimatedCostUsd` covers it, computed from the price table. */
  costUsd?: number;
  /**
   * Session totals only: the part of `costUsd` computed from token counts and list
   * prices rather than reported (events say so with `payload.costEstimated`).
   */
  estimatedCostUsd?: number;
  /**
   * Session totals only: the part of `estimatedCostUsd` priced at non-standard
   * rates, keyed by the calls' `payload.priceTier` (`batch`, `long-context`, ...).
   */
  estimatedCostByTier?: Record<string, number>;
}

/** The Usage fields that are plain numbers (token counts and costs). */
export type UsageNumberKey = Exclude<keyof Usage, "estimatedCostByTier">;

/** Usage a session did not count because another model call already covered it (a nested span, a repeated response id). */
export interface DuplicateUsage {
  calls: number;
  tokens: number;
  costUsd?: number;
}

/**
 * Session.stats.waste: duplicate fetches, read-only tool calls (Read, Grep, a
 * `cat`, an MCP get) repeated while the first result was still in context and
 * unchanged, so the repeat re-sent tokens the model already had.
 */
export interface WasteStats {
  duplicateFetches: number;
  /** Estimated tokens the repeats re-sent: output characters / 4. */
  duplicateFetchTokens: number;
  /** All read-only calls in the session, the base for a duplicate share. */
  readOnlyCalls: number;
}

/** Why a prompt cache broke: a compaction rewrote the context, the model changed, the cache expired while idle, or something else. */
export type CacheBreakCause = "compaction" | "model-switch" | "idle" | "other";

/**
 * Session.stats.cacheBreaks: model calls whose prompt prefix was no longer cached,
 * so tokens read from cache on the previous call were billed again at the write
 * (or full input) rate.
 */
export interface CacheBreakStats {
  count: number;
  /** Prompt tokens that were cached before the break and paid for again. */
  lostTokens: number;
  /** USD the re-billing cost over cache-read prices; set only when every break's model has a price. */
  extraUsd?: number;
  byCause: Partial<Record<CacheBreakCause, { count: number; lostTokens: number; extraUsd?: number }>>;
  /** Breaks on models with no price (extraUsd is then left out). */
  unpriced?: number;
}

/** Session.stats.llmErrors: how many model calls failed, and why the first one did. */
export interface LlmErrors {
  count: number;
  /** HTTP status of the first failed call, when it had one. */
  statusCode?: number;
  /** The first failed call's error message, up to 300 characters. */
  error?: string;
}

export interface AgentEvent {
  /** Deterministic: sha256(agent, sessionId, source line/offset). Re-ingest is idempotent. */
  id: string;
  v: typeof SCHEMA_VERSION;
  sessionId: string;
  turnId?: string;
  /** Parent event (subagent or nested tool). */
  parentId?: string;
  /** Milliseconds since epoch. For spans, the start time. */
  ts: number;
  /** Wall time of the thing this event describes (tool call, model call, turn), when known. */
  durationMs?: number;
  /** OpenTelemetry ids when the event came from (or is exported as) a span. */
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  /** Subagent this event belongs to, when the agent runs subagents inside one session. */
  subagentId?: string;
  /** Capture path that produced the event, for cross-path dedupe: "hook" | "transcript" | "otel-span" | "otel-log" | "wrapper" | … */
  source?: string;
  agent: AgentId;
  agentVersion?: string;
  model?: string;
  kind: EventKind;
  /** Working directory the agent ran in. */
  cwd?: string;
  repo?: RepoState;
  /**
   * Kind-specific, small (< 4 KB after normalization). Conventions:
   * - user.message / assistant.message: { text }
   * - llm.call: { provider?, requestModel?, responseModel?, ttftMs?, stopReason?,
   *               tokensPerSec?, ok, error? } — one model API call; durationMs on the event
   * - subagent.start: { subagentId, type?, description?, prompt? }
   * - subagent.end:   { subagentId, ok?, result? (truncated), childSessionId? }
   * - tool.start: { tool, toolUseId, input, server? (MCP server name) }
   * - tool.end:   { tool, toolUseId, ok, durationMs?, output? (truncated) }
   *   (both: wrapper? — a call that runs other tool calls, e.g. a Codex code-mode
   *   cell; its calls point at it by parentId and only they count in session stats)
   * - file.change: { path, op: "add"|"modify"|"delete", additions?, deletions? }
   * - test.result: { runner?, passed, failed, skipped? }
   * - context.compact: { trigger: "auto"|"manual", tokensBefore? }
   * - session.end: { reason? }
   * - span: { name, attributes } — an OTel span with no better mapping
   * - any kind: payload.reportedUsage = totals an agent span reports (not summed, avoids double counting)
   *
   * Pairing keys (how consumers match the two halves of a span-like pair):
   * - tool.start ↔ tool.end: same sessionId + payload.toolUseId.
   * - subagent.start ↔ subagent.end: same sessionId + payload.subagentId (also on
   *   event.subagentId for events the subagent itself emits). The child's own
   *   session, when it has one, is named by childSessionId on either event and
   *   carries `session.start` payload { parentSessionId, subagentId, … }.
   * - llm.call has no pair: one event per model call, durationMs on the event.
   *
   * Usage convention: `usage` holds the tokens/cost of THIS event only, so
   * summing `usage` over a session's events gives its total. An event that
   * merely repeats a running or final total (an agent span, a session summary)
   * puts it in payload.reportedUsage instead, never in `usage`.
   * Anything larger is moved to a blob and referenced from `blobs`.
   */
  payload: Record<string, unknown>;
  /** Blob refs: full tool output, diffs, raw source payload ("raw" is always blobs[0] when kept). */
  blobs?: BlobRef[];
  usage?: Usage;
  /** Run id when the event came from a coding.sh eval run (CODING_SH_RUN_ID). */
  runId?: string;
  /**
   * Project the event belongs to (`coding.sh serve` sets it from the ingest
   * key). Unset means "default", which is all local data.
   */
  project?: string;
}

export interface Session {
  id: string;
  agent: AgentId;
  /**
   * The agent a host app ran, when `agent` is a host (T3 Code driving Codex or
   * Claude Code): "codex", "claude-code", or the host's driver name.
   */
  provider?: string;
  agentVersion?: string;
  model?: string;
  cwd?: string;
  repo?: RepoState;
  /** First user prompt, truncated to 280 chars, for lists. */
  title?: string;
  startedAt: number;
  /**
   * ts of the session.end event. Sessions keyed by conversation rather than by
   * a process (OTel: every event has an "otel-*" source, the session id is a
   * conversation id such as gen_ai.conversation.id rather than one of its
   * traceIds, and no session.end ever arrives) use the end of the last event
   * seen (ts + durationMs for events stamped at their start, ts for *.end
   * events), so the value moves forward as more turns arrive. Log-keyed OTel
   * sessions (no traceId at all) and sessions known only from a backfilled
   * transcript do the same. Trace-keyed OTel sessions end with their root
   * span. Unset = still running/unknown.
   */
  endedAt?: number;
  /** Aggregates maintained at ingest. */
  stats: {
    events: number;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    filesChanged: number;
    testsPassed?: number;
    testsFailed?: number;
    usage?: Usage;
    /** Model-call usage left out of `usage` because an enclosing call or an earlier copy of the same response already counted it. */
    duplicateUsage?: DuplicateUsage;
    latency?: LatencyStats;
    /** Failed model calls: llm.call with `ok: false` or an HTTP status of 400 or more. Unset when none failed. */
    llmErrors?: LlmErrors;
    /** Set when the session is one run of a durable workflow engine (Vercel Workflow, Temporal, …). */
    durable?: DurableStats;
    /** Where the session went off the rails (looping, failure-streak, churn, no-progress, stalled, context-thrash), earliest first. */
    derails?: SessionDerail[];
    /** The session's phases (core/outline.ts) when it has more than one: start, resumes, compactions, long idle gaps. */
    phases?: SessionPhase[];
    /** Read-only calls repeated with an unchanged result (core/waste.ts). Unset when none repeated. */
    waste?: WasteStats;
    /** Model calls that found the prompt cache gone and paid for the prompt again (core/cache-breaks.ts). Unset when none did. */
    cacheBreaks?: CacheBreakStats;
  };
  /** Detected failure patterns, e.g. "premature-completion". */
  flags: string[];
  runId?: string;
  /** Snapshot at session end, for diffs. */
  endSnapshot?: string;
  /**
   * Set when this session is a subagent of another session (own transcript / child trace).
   * Ingest links a child from either its `session.start` payload
   * `{ parentSessionId, parentEventId?, subagentId?, subagentType? }` or the parent's
   * `subagent.start|end` payload `childSessionId`. Adapters should prefer the former.
   */
  parent?: { sessionId: string; eventId?: string; subagentId?: string; type?: string };
  /** OTel trace ids that contributed to this session (first seen first, capped at 256). Filled by buildSession from events' traceId. */
  traceIds?: string[];
  /** Project, copied from the events by buildSession. Unset means "default". */
  project?: string;
  /**
   * Adapter.parseVersion of the code that produced this session's rows, set when
   * ingest first creates the session and kept as later events arrive (so it is
   * the oldest parse in the session). Older than the adapter's: re-parsed from
   * its transcript or spool (core/reparse.ts). Unset: not produced by an
   * adapter's ingest (OTel, SDK batches), never re-parsed automatically.
   * A store keeps the stored value when an upsert leaves it unset.
   */
  parseVersion?: number;
}

/** One attempt of a durable workflow step (DurableStats.steps[].attempts). Times are ms since epoch. */
export interface DurableAttempt {
  /** Attempt number: as the engine reported it, else by start order. */
  n: number;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  /** The engine re-ran recorded history here; nothing under it is counted again. */
  replay?: boolean;
  /** Process that ran it (service.instance.id, faas.instance, host:pid). */
  instance?: string;
  version?: string;
  /** Span id, for linking to the timeline. */
  spanId?: string;
}

/** A durable workflow step and its attempts, in start order. */
export interface DurableStep {
  name: string;
  /** Stable step id (step.id, activity id) when the engine gives one. */
  id?: string;
  attempts: DurableAttempt[];
  /** Attempts the run made but never reported (a gap in attempt numbers, or time before the first reported attempt). */
  unreported?: number;
  /** Time between scheduling and the first reported attempt, when an earlier attempt went unreported. */
  unreportedMs?: number;
  /** Of unreportedMs, how long the lost attempt's process was still seen working (to its last export); the rest is lost. */
  unreportedRanMs?: number;
  ok: boolean;
}

/** A point where the run continued after a break: a crash, a deploy, a worker restart or a durable wait. */
export interface DurableResume {
  at: number;
  reason: "crash" | "deploy" | "restart" | "wait";
  /** Step the run resumed at, and the span of the attempt that ran first. */
  step?: string;
  spanId?: string;
  fromInstance?: string;
  toInstance?: string;
  fromVersion?: string;
  toVersion?: string;
  /** How long the run was stopped before it resumed. */
  afterMs?: number;
}

/** A durable sleep or wait for an event (not busy time). */
export interface DurableWait {
  startedAt: number;
  endedAt?: number;
  name?: string;
}

/**
 * One durable workflow run (Session.stats.durable), folded from the
 * payload.durable tags the OTLP mapper puts on its spans (src/otel/durable.ts).
 */
export interface DurableStats {
  engine: string;
  /** The engine's run id. */
  runId: string;
  workflow?: string;
  steps: DurableStep[];
  /** Steps in the run when `steps` keeps only some of them (retried, failed and unreported first). */
  stepCount?: number;
  /** Step attempts beyond each step's first, reported or not. */
  retries: number;
  failedAttempts: number;
  /** Replayed spans seen (history re-run; not counted as new work). */
  replays: number;
  /** Model calls under replay spans, left out of usage. */
  replayedCalls?: number;
  waits: DurableWait[];
  resumes: DurableResume[];
  /** Processes that worked on the run. */
  instances: number;
  /** First to last activity of the run. */
  wallMs: number;
  /** Time something ran: the union of step attempts, invocations and model/tool calls. */
  activeMs: number;
  /** Time inside explicit durable waits. */
  waitMs: number;
  /** wallMs − activeMs: waits, retry backoff, queueing and downtime. */
  idleMs: number;
}

/** One phase of a long session on Session.stats.phases (core/outline.ts). */
export interface SessionPhase {
  /** 1-based. */
  n: number;
  kind: "start" | "resume" | "compaction" | "idle";
  /** compaction: "auto" or "manual". */
  trigger?: string;
  /** idle/resume: the gap before it, ms. */
  gapMs?: number;
  startTs: number;
  /** ts of its last event. */
  endTs: number;
  /** Index range [from, to) into the time-sorted events, and the first event's id (a deep link). */
  from: number;
  to: number;
  eventId: string;
  events: number;
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: number;
  /** Last test result in the phase. */
  tests?: { passed: number; failed: number };
  tokens: number;
  costUsd?: number;
  /** First prompt in the phase, up to 120 characters. */
  title?: string;
}

/** One derail episode on Session.stats.derails: where it started and what happened. */
export interface SessionDerail {
  /** "looping", "failure-streak", "churn", "no-progress", "stalled" or "context-thrash". */
  flag: string;
  /** Onset time (ms epoch) and event. */
  ts: number;
  eventId: string;
  /** Index of the onset event in the session's events sorted by time. */
  index: number;
  /** When it was last seen. */
  endTs: number;
  detail: string;
}

/** Latency aggregates kept on Session.stats.latency. All milliseconds. */
export interface LatencyStats {
  wallMs?: number;
  llmCalls?: number;
  llmMs?: number;
  llmP50Ms?: number;
  llmP95Ms?: number;
  ttftP50Ms?: number;
  toolMs?: number;
  toolP95Ms?: number;
  subagents?: number;
}

export function isEventKind(k: string): k is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(k);
}
