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
