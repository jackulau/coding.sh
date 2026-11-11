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

/**
 * Session.stats.memoryUse: one memory or instruction file a session used, or a
 * skill its events name without a path.
 */
export interface MemoryUse {
  /** `loaded`: the agent put the file in its context. `read`: a tool read it, or the skill ran. `wrote`: a tool or a file change wrote it. */
  use: "loaded" | "read" | "wrote";
  /** The file, as an absolute path (`~/…` when the event wrote it so). Unset for a skill named without one. */
  path?: string;
  /** A skill named without a path: `harness audit` matches it to the SKILL.md files on disk. */
  skill?: string;
  /** With `skill`: `tool` when a Skill tool call named it, `harness` when the agent's record of loaded skills did. */
  by?: "tool" | "harness";
  /** The last time, in ms since the epoch. */
  ts: number;
}

/**
 * Session.stats.hookContext: text hooks added to the model's context
 * (`notification` events with `payload.kind: "hook.context"`), counted and
 * sized (characters / 4), in all and by source: `plugin:<name>`, `plugin` (a
 * plugin not installed where the session was parsed), `settings` (a hook from
 * a settings file) or `unknown` (the agent recorded no command).
 */
export interface HookContextStats {
  count: number;
  tokens: number;
  bySource: Record<string, { count: number; tokens: number }>;
}

/** Why a prompt cache broke: a compaction rewrote the context, the model changed, the cache expired while idle, or something else. */
export type CacheBreakCause = "compaction" | "model-switch" | "idle" | "other";

/**
 * Where an idle cache break's wait was: `wait`, one tool call ran past the cache
 * lifetime (a foreground wait); `subagent`, a subagent sat idle between turns;
 * `away`, the main session sat idle between turns.
 */
export type CacheIdleKind = "wait" | "subagent" | "away";

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
  /** The idle breaks (byCause.idle) split by where the wait was. Unset when none was idle. */
  byIdle?: Partial<Record<CacheIdleKind, { count: number; lostTokens: number; extraUsd?: number }>>;
  /** Breaks on models with no price (extraUsd is then left out). */
  unpriced?: number;
}

/**
 * Session.stats.modelSwitch: the model changed mid-session (core/models.ts): a
 * fallback the agent recorded (a switch and back included), any change inside a
 * subagent, or a main-thread hand-over from one model to another. The fields
 * name the first switch; the counts cover them all.
 */
export interface ModelSwitch {
  from: string;
  to: string;
  /** ts of the first call on `to`. */
  at: number;
  /**
   * What came right before: a fallback the agent recorded, `from`'s last call was refused
   * or failed, or a /model command. Unset when unknown.
   */
  trigger?: "fallback" | "refusal" | "error" | "command";
  /** For a recorded fallback: why, as the agent said (`overloaded`, `refusal`, `model_not_found`, …). */
  reason?: string;
  /** The first switch was inside a subagent (a subagent's own session, or one in this session). */
  subagent?: boolean;
  /** Switches in the session, when more than one. A return to the model a switch left is not one. */
  count?: number;
  /** Model calls that ran on a model a switch moved to (until the scope went back). */
  switchedCalls?: number;
  /**
   * What those calls cost at their model's list prices minus what the same tokens cost at the
   * list prices of the model the switch left (standard rates); negative when the other model is
   * cheaper. Unset when either model has no price.
   */
  extraUsd?: number;
}

/**
 * What an unapproved action did (core/unapproved.ts): `rm -rf` outside temp and build dirs; `git reset --hard`,
 * `git clean -f`, or `git checkout|restore .` with no commit or stash first; `git push --force`; dropping or
 * truncating a database; a tool's own `--yes`/`--force` on a repair, reinit, migrate, delete or purge
 * subcommand; deleting, moving or overwriting a data file or dir; a paid cloud or API batch job.
 */
export type UnapprovedKind = "rm-rf" | "git-reset-hard" | "git-clean" | "git-discard" | "git-push-force" | "db-drop" | "forced-subcommand" | "data-dir" | "paid";

/**
 * Session.stats.unapprovedActions: destructive or paid commands the agent ran when the user's last turn had not
 * approved them (it did not ask for the action, pre-approve it or say yes to the agent's question).
 */
export interface UnapprovedActions {
  count: number;
  byKind: Partial<Record<UnapprovedKind, number>>;
  /** The first one: its kind, its command (up to 200 characters), when, and whether a tool call had failed since the user's last turn. */
  first: { kind: UnapprovedKind; command: string; at: number; afterError?: boolean };
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
   *               tokensPerSec?, ok, error? } — one model API call; durationMs on the event.
   *   durationMs, ttftMs and tokensPerSec are absent when the source does not show when
   *   the request went out (a transcript read from the middle of a response, lines written late)
   * - subagent.start: { subagentId, type?, description?, prompt? }
   * - subagent.end:   { subagentId, ok?, result? (truncated), childSessionId? }
   * - tool.start: { tool, toolUseId, input, server? (MCP server name) }
   * - tool.end:   { tool, toolUseId, ok, durationMs?, output? (truncated), cut? (the agent's
   *   harness cut the output before the model saw it: adapters/_shared/cut.ts OutputCut) }
   *   (both: wrapper? — a call that runs other tool calls, e.g. a Codex code-mode
   *   cell; its calls point at it by parentId and only they count in session stats)
   * - file.change: { path, op: "add"|"modify"|"delete", additions?, deletions? }
   * - test.result: { runner?, passed, failed, skipped? }
   * - context.compact: { trigger: "auto"|"manual", tokensBefore? }
   * - error: { message, source?, statusCode?, errorType?, errorClass?, rateLimitType?, retryAfterMs?, retryAttempt? }
   * - session.end: { reason?, reportedUsage? (Claude Code's cost-state: costUsd, apiDurationMs, costUsdByModel) }
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
    /**
     * Tool calls that failed for real (core/failures.ts). A shell command whose
     * exit 1 is an answer (`rg` found nothing, `test -f` was false, `diff` saw a
     * difference) and a call the user stopped are counted apart, below.
     */
    toolErrors: number;
    /** Failed tool calls whose exit 1 is an answer: no match, a probe, files that differ. Absent when none. */
    benignToolErrors?: number;
    /** Tool calls the user or the harness stopped (Ctrl-C, a rejected prompt). Absent when none. */
    interruptedToolCalls?: number;
    filesChanged: number;
    testsPassed?: number;
    testsFailed?: number;
    usage?: Usage;
    /** Model-call usage left out of `usage` because an enclosing call or an earlier copy of the same response already counted it. */
    duplicateUsage?: DuplicateUsage;
    latency?: LatencyStats;
    /** Failed model calls: llm.call with `ok: false` or an HTTP status of 400 or more. Unset when none failed. */
    llmErrors?: LlmErrors;
    /** Model calls by model, when more than one model made them (core/models.ts). */
    models?: Record<string, number>;
    /** Model switches mid-session (the first one, how many, what the switched calls cost extra); it also tags the session `model:switch`. */
    modelSwitch?: ModelSwitch;
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
    /**
     * How the agent was launched: `headless` (`claude -p`, an Agent SDK, `codex exec`) or
     * `interactive` (a terminal UI or an IDE). Unset when the agent's start does not say.
     */
    launch?: "headless" | "interactive";
    /**
     * A fork subagent (Claude Code's `subagent_type: "fork"`): tokens of the parent's context it
     * started with (the prompt and output of the parent's call that started it). Its own calls
     * read that context from the prompt cache and count in `usage`; the parent's calls count only
     * in the parent. Unset for other sessions.
     */
    inheritedTokens?: number;
    /** Text hooks added to the model's context, by source (`plugin:<name>`, `settings`, …). Unset when no hook added any. */
    hookContext?: HookContextStats;
    /**
     * Memory and instruction files (AGENTS.md, rules, skills, Claude auto-memory) the
     * session's events name, in the order first seen: what `harness audit` counts
     * (core/memory-use.ts). Unset when its events name none.
     */
    memoryUse?: MemoryUse[];
    /**
     * Values redaction replaced before storage, by rule kind (`anthropic-key`, `password`, …): counts, never
     * the values. A vendor token kind also tags the session `secret:exposed`. Unset when nothing was redacted.
     */
    redactions?: Record<string, number>;
    /** Destructive or paid commands the agent ran without a user turn approving them (core/unapproved.ts); it also flags the session `unapproved-action`. Unset when none. */
    unapprovedActions?: UnapprovedActions;
    /**
     * Why coding.sh could not fold this session's stored events into its stats (a coding.sh bug, not
     * the agent's): the row then holds only what the events say directly (agent, start, end, cwd,
     * event count), and the session is tagged `fold:error`. `coding.sh ingest` folds it again. Unset
     * when the fold worked.
     */
    foldError?: string;
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
