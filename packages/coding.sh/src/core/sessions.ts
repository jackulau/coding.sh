// Session aggregation and failure-pattern detection. A fold over a session's
// events in time order (SessionState): buildSession folds them all; live
// ingest saves the state and folds only what was appended since (see
// recomputeSession in core/ingest.ts). Both give the same row.
import { GATEWAY_FLAG, gatewayFlagsOf, gatewayOfEvent } from "../integrations/gateway/ids.ts";
import type { GatewayId } from "../integrations/gateway/providers.ts";
import { DERAIL_FLAGS, derailsOf, derailState, detectDerails, foldDerails, type Derail, type DerailState } from "./derail.ts";
import { foldOutline, outlineOf, outlineState, phasesToStore, REOPEN_SLACK_MS, type OutlineState } from "./outline.ts";
import type { AgentEvent, DuplicateUsage, LatencyStats, LlmErrors, Session, Usage } from "../schema/index.ts";
import { DURABLE_FLAGS, durableFlags, durableStats } from "./durable.ts";
import { detectTestTamper, foldTamper, tamperState, type TamperState } from "./intent.ts";
// waste.ts and skills-use.ts import commandOf and FLAGS back from here, inside functions only.
import { cacheBreakState, cacheBreaksOf, foldCacheBreaks, type CacheBreakState } from "./cache-breaks.ts";
import { foldSkills, skillFlags, skillState, skillUseOf, type SkillState } from "./skills-use.ts";
import { foldWaste, wasteState, wasteStatsOf, type WasteState } from "./waste.ts";
import { exposesSecret, foldRedactions, redactionsOf, redactionState, SECRET_EXPOSED, type RedactionState } from "./redaction-stats.ts";

export { REOPEN_SLACK_MS };

export const FLAGS = {
  prematureCompletion: "premature-completion",
  repeatedToolFailure: "repeated-tool-failure",
  noVerification: "no-verification",
  compaction: "compaction",
  /** A test, runner config or CI file was skipped, deleted, or changed so failing tests went green (core/intent.ts). */
  testTamper: "test-tamper",
  /** Durable workflow runs (Session.stats.durable): a step ran again after failing. */
  stepRetried: DURABLE_FLAGS.stepRetried,
  /** Durable workflow runs: the run continued after a crash, a deploy or a worker restart. */
  resumed: DURABLE_FLAGS.resumed,
  /** A tag, not a failure: model calls went through Vercel AI Gateway. Other gateways get "gateway:<id>". */
  gateway: GATEWAY_FLAG,
  /** Three or more read-only calls repeated with an unchanged result in one context (core/waste.ts, Session.stats.waste). */
  duplicateFetch: "duplicate-fetch",
  /** One skill name loaded from two directories, e.g. a project copy and a personal copy (core/skills-use.ts). */
  skillCopyConflict: "skill-copy-conflict",
  /** A tag, not a failure: redaction replaced a vendor token (core/redaction-stats.ts, Session.stats.redactions). Rotate it. */
  secretExposed: SECRET_EXPOSED,
  /** Derails (core/derail.ts): where the session went off the rails. */
  ...DERAIL_FLAGS,
} as const;

/** Flags that name a failure pattern. Namespaced flags ("gateway:vercel") are tags. */
export const failureFlags = (flags: readonly string[]): string[] => flags.filter((f) => !f.includes(":"));

/** Events written by enrichment (`coding.sh gateway enrich`): they never decide a session's shape. */
const isEnrichment = (e: AgentEvent): boolean => e.source === "gateway";

export const TITLE_MAX = 280;
/** Cap on Session.traceIds (a long-lived conversation can span many traces). */
export const MAX_TRACE_IDS = 256;

/** Shell commands that verify work: tests, type checks, linters, builds. */
const VERIFY_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint|build|verify)\b`,
    String.raw`\b(?:pytest|py\.test|tox|nox|jest|vitest|mocha|ava|tap|rspec|phpunit|ctest|tsc|mypy|pyright|ruff|eslint|clippy)\b`,
    String.raw`\b(?:go|cargo|deno|bun|mix|dotnet|swift|zig|gradle|gradlew|mvn|sbt|stack|cabal)\s+(?:\S+\s+)*?test\b`,
    String.raw`\bcargo\s+(?:check|clippy|build)\b`,
    String.raw`\bnode\s+(?:\S+\s+)*?--test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
    String.raw`\bmake\s+(?:test|check|lint|verify)\b`,
    String.raw`\bnpx\s+(?:tsc|jest|vitest|playwright|eslint)\b`,
  ].join("|"),
  "i",
);

/** Extracts a shell command from common tool input shapes across agents. */
export function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "script", "commandLine"]) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return undefined;
}

export function isVerifyCommand(command: string | undefined): boolean {
  return !!command && VERIFY_COMMAND.test(command);
}

/** True for a tool.start whose input runs a test/check (or was marked so before metadata stripping). */
export function isVerifyToolStart(e: AgentEvent): boolean {
  if (e.kind !== "tool.start") return false;
  if (e.payload.verify === true) return true;
  return isVerifyCommand(commandOf(e.payload.input));
}

/** Events in time order; ties keep their order. */
export const byTime = (events: AgentEvent[]): AgentEvent[] =>
  events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);

function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Markup an agent harness injects as a "user" message (Claude Code: background
 * task completions, local command echoes, reminders). Not something the user typed.
 */
const SYNTHETIC_PROMPT = /^\s*<(task-notification|local-command-(?:stdout|stderr|caveat)|system-reminder|bash-(?:input|stdout|stderr)|user-prompt-submit-hook)>/;
/** A slash command echo: `<command-name>/clear</command-name> <command-message>… <command-args>…`. */
const COMMAND_PROMPT = /^\s*<command-(?:name|message|args)>/;

/** True for a user.message text the harness injected rather than the user typed (incl. slash-command echoes). */
export function isSyntheticPrompt(text: string): boolean {
  return SYNTHETIC_PROMPT.test(text) || COMMAND_PROMPT.test(text);
}

/** A prompt the user typed to the main agent: not a harness notice, a slash-command echo or a subagent's prompt. */
export const isRealPrompt = (e: AgentEvent): boolean => e.kind === "user.message" && !e.subagentId && typeof e.payload.text === "string" && !isSyntheticPrompt(e.payload.text);

/** "/model opus" from a slash-command echo, else undefined. */
function commandTitle(text: string): string | undefined {
  if (!COMMAND_PROMPT.test(text)) return undefined;
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return makeTitle(args ? `${name} ${args}` : name);
}

/** Event kinds stamped at the END of what they describe (ts = end; durationMs looks back). */
const END_KINDS: ReadonlySet<string> = new Set(["turn.end", "tool.end", "subagent.end", "session.end"]);

/** When the thing an event describes finished: ts for *.end kinds, ts + durationMs for spans stamped at their start. */
export function eventEnd(e: AgentEvent): number {
  return END_KINDS.has(e.kind) ? e.ts : e.ts + (num(e.durationMs) ?? 0);
}

/** Capture paths that replay history (a recorded transcript) rather than observe it live. */
export const BACKFILL_SOURCES: readonly string[] = ["transcript", "backfill", "store"];
export const isBackfillEvent = (e: AgentEvent): boolean => e.source !== undefined && BACKFILL_SOURCES.includes(e.source);

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function addUsage(sum: Usage, u: Usage | undefined): void {
  if (!u) return;
  for (const k of [...TOKEN_KEYS, "costUsd"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) sum[k] = (sum[k] ?? 0) + v;
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Estimated USD by `payload.priceTier`. */
type Tiers = Record<string, number>;
const addTiers = (into: Tiers, from: Tiers): void => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

/** Parent walks stop after this many hops (and on a cycle). */
const MAX_PARENT_HOPS = 64;

const carriesUsage = (e: AgentEvent): boolean =>
  e.kind === "llm.call" && !!e.usage && [...TOKEN_KEYS, "costUsd" as const].some((k) => (num(e.usage![k]) ?? 0) > 0);

export interface UsageRollup {
  usage: Usage;
  duplicate?: DuplicateUsage;
}

/**
 * Session usage totals from its events (sorted by time). Plain sums, except:
 * - only the latest usage snapshot counts (they are running totals);
 * - a model call nested inside another usage-carrying model call of the same
 *   trace (a wrapper span over a provider span) is not counted again: the
 *   outermost call takes, per field, its own value, else the sum over its
 *   nearest nested calls. A reported nested cost beats the wrapper's estimate;
 * - a model call repeating an earlier call's `payload.responseId` counts once;
 * - `estimatedCostUsd` is the part of `costUsd` computed from the price table
 *   (`payload.costEstimated`), unless a gateway companion billed that call.
 * What was left out is returned as `duplicate`. Events without trace ids sum as before.
 */
export function rollupUsage(sorted: readonly AgentEvent[]): UsageRollup {
  const billed = new Set<string>();
  for (const e of sorted) if (isEnrichment(e) && e.parentId) billed.add(e.parentId);
  const bySpan = new Map<string, AgentEvent>();
  for (const e of sorted) {
    const k = e.traceId && e.spanId ? `${e.traceId}\u0000${e.spanId}` : undefined;
    if (k && !bySpan.has(k)) bySpan.set(k, e);
  }
  // Nearest usage-carrying model call above each one, within its trace.
  const children = new Map<AgentEvent, AgentEvent[]>();
  const nested = new Set<AgentEvent>();
  for (const e of sorted) {
    if (!e.traceId || !e.parentSpanId || !carriesUsage(e)) continue;
    const seen = new Set<AgentEvent>([e]);
    let cur = e;
    for (let hop = 0; hop < MAX_PARENT_HOPS && cur.parentSpanId; hop++) {
      const p = bySpan.get(`${e.traceId}\u0000${cur.parentSpanId}`);
      if (!p || seen.has(p)) break;
      if (carriesUsage(p)) {
        nested.add(e);
        children.set(p, [...(children.get(p) ?? []), e]);
        break;
      }
      seen.add(p);
      cur = p;
    }
  }
  const estimatedOf = (e: AgentEvent): number => (e.payload?.costEstimated === true && !billed.has(e.id) ? (num(e.usage?.costUsd) ?? 0) : 0);
  // The estimate of a call priced at tier or long-context rates, under its `payload.priceTier`.
  const tiersOf = (e: AgentEvent): Tiers => {
    const est = estimatedOf(e);
    const t = e.payload?.priceTier;
    return est > 0 && typeof t === "string" && t ? { [t]: est } : {};
  };
  // A call's usage with its nested calls folded in: own value per field, else the nested sum.
  const fold = (c: AgentEvent, depth = 0): { u: Usage; est: number; tiers: Tiers } => {
    const kids = depth < MAX_PARENT_HOPS ? (children.get(c) ?? []).map((k) => fold(k, depth + 1)) : [];
    const u: Usage = {};
    for (const k of TOKEN_KEYS) {
      const own = num(c.usage?.[k]);
      if (own !== undefined) u[k] = own;
      else if (kids.some((x) => x.u[k] !== undefined)) u[k] = kids.reduce((s, x) => s + (x.u[k] ?? 0), 0);
    }
    const own = num(c.usage?.costUsd);
    const ownEst = estimatedOf(c);
    const kidCost = kids.some((x) => x.u.costUsd !== undefined) ? kids.reduce((s, x) => s + (x.u.costUsd ?? 0), 0) : undefined;
    const kidEst = kids.reduce((s, x) => s + x.est, 0);
    // A billed call keeps its own cost: its gateway companion holds billed minus that cost.
    const kidsReported = kidCost !== undefined && kidCost - kidEst > 0;
    if (own !== undefined && (ownEst === 0 || !kidsReported || billed.has(c.id))) {
      u.costUsd = own;
      return { u, est: ownEst, tiers: tiersOf(c) };
    }
    if (kidCost !== undefined) u.costUsd = kidCost;
    const tiers: Tiers = {};
    if (kidCost !== undefined) for (const k of kids) addTiers(tiers, k.tiers);
    return { u, est: kidCost !== undefined ? kidEst : 0, tiers };
  };

  const usage: Usage = {};
  let estimated = 0;
  const byTier: Tiers = {};
  let snapshot: AgentEvent | undefined;
  const responses = new Set<string>();
  const dropped = new Set<string>();
  let raw = 0;
  let rawCost = 0;
  let counted = 0;
  let countedCost = 0;
  let calls = 0;
  const tokens = (u: Usage) => TOKEN_KEYS.reduce((s, k) => s + (num(u[k]) ?? 0), 0);
  for (const e of sorted) {
    if (isUsageSnapshot(e)) {
      // Latest snapshot wins; equal times keep the larger (running totals only grow).
      if (!snapshot || e.ts > snapshot.ts || (e.ts === snapshot.ts && tokenTotal(e.usage) >= tokenTotal(snapshot.usage))) snapshot = e;
      continue;
    }
    if (!carriesUsage(e)) continue;
    raw += tokens(e.usage!);
    rawCost += num(e.usage!.costUsd) ?? 0;
    const rid = typeof e.payload?.responseId === "string" && e.payload.responseId ? e.payload.responseId : undefined;
    // A durable engine replaying recorded history re-emits calls it already made (payload.replay).
    if (nested.has(e) || (rid && responses.has(rid)) || e.payload?.replay === true) {
      calls++;
      dropped.add(e.id);
      continue;
    }
    if (rid) responses.add(rid);
  }
  for (const e of sorted) {
    if (isUsageSnapshot(e)) continue;
    if (carriesUsage(e)) {
      if (dropped.has(e.id)) continue;
      const f = children.has(e) ? fold(e) : { u: e.usage!, est: estimatedOf(e), tiers: tiersOf(e) };
      addUsage(usage, f.u);
      estimated += f.est;
      addTiers(byTier, f.tiers);
      counted += tokens(f.u);
      countedCost += num(f.u.costUsd) ?? 0;
      continue;
    }
    // A gateway companion of a call that was not counted goes with it.
    if (isEnrichment(e) && e.parentId && dropped.has(e.parentId)) {
      rawCost += num(e.usage?.costUsd) ?? 0;
      continue;
    }
    addUsage(usage, e.usage);
    estimated += estimatedOf(e);
    addTiers(byTier, tiersOf(e));
  }
  return usageResult({ usage, estimated, byTier, ...(snapshot ? { snapshot: { usage: snapshot.usage ?? {}, est: estimatedOf(snapshot) } } : {}), calls, raw, rawCost, counted, countedCost });
}

/** Totals of a usage rollup before the snapshot is added (see rollupUsage). */
interface UsageTotals {
  usage: Usage;
  estimated: number;
  byTier: Tiers;
  snapshot?: { usage: Usage; est: number };
  calls: number;
  raw: number;
  rawCost: number;
  counted: number;
  countedCost: number;
}

function usageResult(t: UsageTotals): UsageRollup {
  const usage: Usage = { ...t.usage };
  const byTier: Tiers = { ...t.byTier };
  let estimated = t.estimated;
  if (t.snapshot) {
    addUsage(usage, t.snapshot.usage);
    estimated += t.snapshot.est;
  }
  if (estimated > 0 && usage.costUsd !== undefined) {
    usage.estimatedCostUsd = Math.min(estimated, usage.costUsd);
    if (Object.keys(byTier).length) usage.estimatedCostByTier = byTier;
  }
  if (!t.calls) return { usage };
  const dupCost = Math.round((t.rawCost - t.countedCost) * 1e9) / 1e9;
  return { usage, duplicate: { calls: t.calls, tokens: Math.max(0, t.raw - t.counted), ...(dupCost > 0 ? { costUsd: dupCost } : {}) } };
}

/**
 * rollupUsage as a fold, for sessions with no spans and no enrichment events
 * (SessionState.simple): no call nests in another and none is billed by a
 * companion, so each event is counted, or dropped as a repeat, as it comes.
 */
interface UsageState extends UsageTotals {
  /** Latest snapshot so far, and its token total (equal times keep the larger). */
  snapshotTs?: number;
  snapshotTokens: number;
  responses: Set<string>;
}

const usageState = (): UsageState => ({ usage: {}, estimated: 0, byTier: {}, calls: 0, raw: 0, rawCost: 0, counted: 0, countedCost: 0, snapshotTokens: 0, responses: new Set() });

const simpleEstimate = (e: AgentEvent): number => (e.payload?.costEstimated === true ? (num(e.usage?.costUsd) ?? 0) : 0);
const simpleTiers = (e: AgentEvent): Tiers => {
  const est = simpleEstimate(e);
  const t = e.payload?.priceTier;
  return est > 0 && typeof t === "string" && t ? { [t]: est } : {};
};
const usageTokens = (u: Usage) => TOKEN_KEYS.reduce((s, k) => s + (num(u[k]) ?? 0), 0);

function foldUsage(s: UsageState, e: AgentEvent): void {
  if (isUsageSnapshot(e)) {
    const total = tokenTotal(e.usage);
    if (s.snapshotTs === undefined || e.ts > s.snapshotTs || (e.ts === s.snapshotTs && total >= s.snapshotTokens)) {
      s.snapshotTs = e.ts;
      s.snapshotTokens = total;
      s.snapshot = { usage: { ...e.usage }, est: simpleEstimate(e) };
    }
    return;
  }
  if (carriesUsage(e)) {
    s.raw += usageTokens(e.usage!);
    s.rawCost += num(e.usage!.costUsd) ?? 0;
    const rid = typeof e.payload?.responseId === "string" && e.payload.responseId ? e.payload.responseId : undefined;
    if ((rid && s.responses.has(rid)) || e.payload?.replay === true) {
      s.calls++;
      return;
    }
    if (rid) s.responses.add(rid);
    s.counted += usageTokens(e.usage!);
    s.countedCost += num(e.usage!.costUsd) ?? 0;
  }
  addUsage(s.usage, e.usage);
  s.estimated += simpleEstimate(e);
  addTiers(s.byTier, simpleTiers(e));
}

const usageOf = (s: UsageState): UsageRollup => usageResult(s);

/**
 * A usage snapshot: running session totals (T3 Code v1 threads, OpenCode
 * sessions without per-message tokens), re-emitted as the totals grow. Only
 * the latest one counts; summing them would count the same tokens again.
 */
export const isUsageSnapshot = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.type === "usage-summary";

const tokenTotal = (u: Usage | undefined): number => (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0);


/**
 * Turns from turn.end rows. One capture path: every row is a turn. Both paths,
 * each with keyed rows: rows with a turnId count once per turn (both paths key
 * them alike and the store keeps one copy, so either may hold a given turn);
 * rows without one are each path's own count of the turns it could not key.
 * Otherwise a path that keys none of its turns (an older agent version, a
 * transcript that does not record what the hook keys by) counted the same turns
 * its own way, so the larger count wins (a hook installed mid-session saw fewer).
 */
function turnCount(t: { live: number; backfill: number; liveIdless: number; backfillIdless: number }, turnIds: Set<string>): number {
  if (t.live === 0 || t.backfill === 0) return t.live + t.backfill;
  if (t.live > t.liveIdless && t.backfill > t.backfillIdless) return turnIds.size + Math.max(t.liveIdless, t.backfillIdless);
  return Math.max(t.live, t.backfill);
}

/**
 * Bumped whenever SessionState (or anything folded into it) changes shape or
 * meaning: a saved fold of another version is dropped and the session rebuilt
 * from all its events.
 */
export const SESSION_FOLD_VERSION = 2;

/**
 * A session's events folded so far: everything buildSession needs from them,
 * as plain data (maps, sets, arrays), so live ingest can save it after one
 * append and fold only the next append's events into it (core/ingest.ts)
 * instead of reading and rebuilding a long session every time.
 */
export interface SessionState {
  v: number;
  /** Events folded (the next one's index in the session's sorted events). */
  n: number;
  first?: { ts: number; sessionId: string; agent: string };
  /** Agent of the first event that is not a durable engine span. */
  agent?: string;
  /** ts of the last event folded: a later append must not sort before it. */
  lastTs?: number;
  /** ts of the last prompt the user typed (isRealPrompt). */
  lastPromptTs?: number;
  /**
   * No spans and no enrichment events: every part streams. Span nesting
   * (rollupUsage), durable runs (durableStats) and gateway companions need the
   * whole event list, so sessionOf() is then given it. So does a test-tamper
   * call only the whole list can settle (TamperState.needsEvents).
   */
  simple: boolean;
  via?: string;
  /** Distinct agents of captured events, in order (the agent a host ran), and the first payload.provider. */
  agents: string[];
  provider?: string;
  /** Distinct trace ids in order, up to twice MAX_TRACE_IDS (enough to fill up whatever the previous row kept). */
  traceIds: Set<string>;
  lastEnd?: number;
  lastActivity?: number;
  captured: number;
  allLive: boolean;
  allTranscript: boolean;
  /** Any event captured live (not replayed from a transcript), and the first session.start's git facts (repo state at the start). */
  live: boolean;
  gitStart?: Record<string, unknown>;
  model?: string;
  agentVersion?: string;
  cwd?: string;
  runId?: string;
  /** Earliest repo state from the events (see sessionOf for how it meets the previous row's). */
  repo?: Session["repo"];
  endedAt?: number;
  endSnapshot?: Session["endSnapshot"];
  parent?: Session["parent"];
  project?: string;
  files: Set<string>;
  turnEnds: { live: number; backfill: number; liveIdless: number; backfillIdless: number };
  turnIds: Set<string>;
  userMessages: number;
  toolIds: Set<string>;
  idlessStarts: number;
  idlessEnds: number;
  toolErrors: number;
  llmErrors?: LlmErrors;
  lastTest?: { passed: number; failed: number };
  title?: string;
  fallbackTitle?: string;
  usage: UsageState;
  latency: LatencyState;
  flags: FlagState;
  derails: DerailState;
  outline: OutlineState;
  waste: WasteState;
  cacheBreaks: CacheBreakState;
  skills: SkillState;
  redactions: RedactionState;
}

/** A fresh fold: no events seen. */
export function sessionState(): SessionState {
  return {
    v: SESSION_FOLD_VERSION,
    n: 0,
    simple: true,
    agents: [],
    traceIds: new Set(),
    captured: 0,
    allLive: true,
    allTranscript: true,
    live: false,
    files: new Set(),
    turnEnds: { live: 0, backfill: 0, liveIdless: 0, backfillIdless: 0 },
    turnIds: new Set(),
    userMessages: 0,
    toolIds: new Set(),
    idlessStarts: 0,
    idlessEnds: 0,
    toolErrors: 0,
    usage: usageState(),
    latency: latencyState(),
    flags: flagState(),
    derails: derailState(),
    outline: outlineState({ days: false }),
    waste: wasteState(),
    cacheBreaks: cacheBreakState(),
    skills: skillState(),
    redactions: redactionState(),
  };
}

/** Folds the session's next event (in time order) into the state. */
export function foldSession(s: SessionState, e: AgentEvent): void {
  const index = s.n++;
  s.first ??= { ts: e.ts, sessionId: e.sessionId, agent: e.agent };
  if (s.agent === undefined && e.payload.durable === undefined) s.agent = e.agent;
  s.lastTs = e.ts;
  if (isRealPrompt(e)) s.lastPromptTs = e.ts;
  if (e.spanId || e.parentSpanId || isEnrichment(e)) s.simple = false;
  if (s.provider === undefined && typeof e.payload.provider === "string" && e.payload.provider) s.provider = e.payload.provider;
  if (s.project === undefined && e.project) s.project = e.project;
  if (!s.parent && e.kind === "session.start" && typeof e.payload.parentSessionId === "string") s.parent = parentOf([e]);
  if (!isBackfillEvent(e)) s.live = true;
  if (!s.gitStart && e.kind === "session.start") {
    const { gitBranch, gitCommit, git } = e.payload;
    s.gitStart = { gitBranch, gitCommit, git };
  }
  foldUsage(s.usage, e);
  foldLatency(s.latency, e);
  foldFlags(s.flags, e);
  if (s.flags.tamper.needsEvents) s.simple = false;
  foldDerails(s.derails, e, index);
  foldOutline(s.outline, e, index);
  foldWaste(s.waste, e);
  foldCacheBreaks(s.cacheBreaks, e);
  foldSkills(s.skills, e);
  foldRedactions(s.redactions, e);
  if (isEnrichment(e)) return;

  s.captured++;
  if (!s.agents.includes(e.agent)) s.agents.push(e.agent);
  // Host app that drove the agent (T3 Code): set on events by the host's adapter
  // or the hook's env marker. The session belongs to the host; the agent it ran
  // stays on the session as provider.
  if (typeof e.payload.via === "string" && e.payload.via) s.via ??= e.payload.via;
  if (e.traceId && s.traceIds.size < 2 * MAX_TRACE_IDS) s.traceIds.add(e.traceId);
  const end = eventEnd(e);
  if (s.lastEnd === undefined || end > s.lastEnd) s.lastEnd = end;
  // When it was stamped, not when it ended: a span that began before the end is not a resume.
  if (e.kind !== "session.end" && (s.lastActivity === undefined || e.ts > s.lastActivity)) s.lastActivity = e.ts;
  // Live-ingested (OTel or the SDKs' native batches): no adapter emits a session.end.
  if (!e.source?.startsWith("otel") && e.source !== "sdk") s.allLive = false;
  if (!isBackfillEvent(e)) s.allTranscript = false;
  if (e.model) s.model = e.model;
  if (e.agentVersion) s.agentVersion = e.agentVersion;
  s.cwd ??= e.cwd;
  s.runId ??= e.runId;
  // Keep the earliest repo state (the pre-agent snapshot evals replay from).
  // session.end carries the end snapshot, which must not become the start state.
  if (e.repo && e.kind !== "session.end" && (!s.repo || !s.repo.snapshot)) s.repo = { ...e.repo };
  switch (e.kind) {
    case "user.message": {
      const text = typeof e.payload.text === "string" ? e.payload.text : undefined;
      // Harness-injected notices (task completions, command output) are not user turns.
      if (text !== undefined && SYNTHETIC_PROMPT.test(text)) break;
      s.userMessages++;
      if (s.title !== undefined || !text?.trim()) break;
      if (COMMAND_PROMPT.test(text)) s.fallbackTitle ??= commandTitle(text);
      else s.title = makeTitle(text);
      break;
    }
    case "turn.end":
      // A Stop that fired because a Stop hook blocked the previous one continues the same turn.
      // Turn ends per capture path: a session seen live (hooks) and from its
      // transcript (backfill) has two turn.end rows per turn wherever the two paths
      // share no natural key (most hook payloads name no turn the transcript knows).
      if (e.payload.stopHookActive === true) break;
      if (isBackfillEvent(e)) s.turnEnds.backfill++;
      else s.turnEnds.live++;
      if (e.turnId) s.turnIds.add(e.turnId);
      else if (isBackfillEvent(e)) s.turnEnds.backfillIdless++;
      else s.turnEnds.liveIdless++;
      break;
    case "tool.start":
    case "tool.end": {
      // A wrapper (Codex code-mode cell) runs other tool calls; those are the ones counted.
      // Tool calls by toolUseId (a call seen only by its start or only by its end
      // still counts once); calls without an id are counted by start/end events.
      if (e.payload.wrapper === true) break;
      const id = e.payload.toolUseId;
      if (typeof id === "string" && id) s.toolIds.add(id);
      else if (e.kind === "tool.start") s.idlessStarts++;
      else s.idlessEnds++;
      if (e.kind === "tool.end" && e.payload.ok === false) s.toolErrors++;
      break;
    }
    case "llm.call":
      if (llmCallFailed(e.payload)) s.llmErrors = addLlmError(s.llmErrors, e.payload);
      break;
    case "file.change":
      if (typeof e.payload.path === "string") s.files.add(e.payload.path);
      break;
    case "test.result":
      s.lastTest = { passed: num(e.payload.passed) ?? 0, failed: num(e.payload.failed) ?? 0 };
      break;
    case "session.end":
      s.endedAt = e.ts;
      if (e.repo?.snapshot) s.endSnapshot = e.repo.snapshot;
      break;
  }
}

/**
 * The Session row for the events folded so far. Fields the events can't
 * provide (e.g. endSnapshot set by the snapshotter) are carried over from
 * `prev`. A state that is not `simple` needs `sorted`, the same events in time
 * order. Leaves the state as it was.
 */
export function sessionOf(s: SessionState, prev?: Session, sorted?: readonly AgentEvent[]): Session {
  const first = s.first;
  if (!first && !prev) throw new Error("buildSession needs at least one event or an existing session");
  if (!s.simple && !sorted) throw new Error("sessionOf needs the events of a session with spans or enrichment");
  const id = first?.sessionId ?? prev!.id;
  const { usage, duplicate } = s.simple ? usageOf(s.usage) : rollupUsage(sorted!);
  const derails = derailsOf(s.derails);
  // A session.end followed by later captured activity was reopened (resumed
  // under the same id): it is not ended, whatever an earlier build stored.
  let endedAt = s.endedAt;
  const reopened = endedAt !== undefined && s.lastActivity !== undefined && s.lastActivity > endedAt + REOPEN_SLACK_MS;
  if (reopened) endedAt = undefined;
  let fallbackTitle = s.fallbackTitle;

  const durable = s.simple ? undefined : durableStats(sorted!);
  const session: Session = {
    id,
    // Durable engine spans (workflow.start, steps) can precede the agent's own events; they don't name it.
    // Nor does the client that started a durable run (a Restate ingress call): the code making model calls does.
    agent: s.via ?? (durable ? sorted!.find((e) => e.kind === "llm.call") : undefined)?.agent ?? s.agent ?? first?.agent ?? prev!.agent,
    startedAt: first?.ts ?? prev!.startedAt,
    stats: {
      events: s.n,
      // Agents without a turn-end hook still have one turn per prompt.
      turns: turnCount(s.turnEnds, s.turnIds) || s.userMessages,
      // A crashed tool has a start without an end, a lost hook line an end without a start.
      toolCalls: s.toolIds.size + Math.max(s.idlessStarts, s.idlessEnds),
      toolErrors: s.toolErrors,
      filesChanged: s.files.size,
    },
    flags: flagsOf(s.flags, derails, sorted),
  };
  if (durable) {
    session.stats.durable = durable;
    session.flags.push(...durableFlags(durable));
    fallbackTitle ??= durable.workflow ?? `${durable.engine} run ${durable.runId}`;
  }
  if (derails.length) session.stats.derails = derails;
  const phases = phasesToStore(outlineOf(s.outline));
  if (phases) session.stats.phases = phases;
  const waste = wasteStatsOf(s.waste);
  if (waste) {
    session.stats.waste = waste.stats;
    session.flags.push(...waste.flags);
  }
  const cacheBreaks = cacheBreaksOf(s.cacheBreaks);
  if (cacheBreaks) session.stats.cacheBreaks = cacheBreaks;
  session.flags.push(...skillFlags(skillUseOf(s.skills, s.cwd ?? prev?.cwd)));
  const redactions = redactionsOf(s.redactions);
  if (redactions) session.stats.redactions = redactions;
  if (exposesSecret(redactions)) session.flags.push(FLAGS.secretExposed);
  if (s.lastTest) {
    session.stats.testsPassed = s.lastTest.passed;
    session.stats.testsFailed = s.lastTest.failed;
  }
  if (Object.keys(usage).length) session.stats.usage = usage;
  if (duplicate) session.stats.duplicateUsage = duplicate;
  if (s.llmErrors) session.stats.llmErrors = { ...s.llmErrors };
  const latency = latencyOf(s.latency, endedAt);
  if (Object.keys(latency).length) session.stats.latency = latency;
  const set = <K extends keyof Session>(k: K, v: Session[K] | undefined) => {
    if (v !== undefined) session[k] = v;
  };
  set("agentVersion", s.agentVersion ?? prev?.agentVersion);
  // The agent a host ran: the first event from another agent, else what the host's own events name.
  if (s.via) set("provider", s.agents.find((a) => a !== s.via) ?? s.provider ?? prev?.provider);
  set("model", s.model ?? prev?.model);
  set("cwd", s.cwd ?? prev?.cwd);
  // The earliest repo state wins; one with a snapshot is never replaced (see foldSession).
  set("repo", prev?.repo?.snapshot ? prev.repo : (s.repo ?? prev?.repo));
  set("title", s.title ?? fallbackTitle ?? prev?.title);
  const traceIds = new Set<string>(prev?.traceIds ?? []);
  for (const t of s.traceIds) {
    if (traceIds.size >= MAX_TRACE_IDS) break;
    traceIds.add(t);
  }
  // Sessions that never get a session.end end at their last activity seen so far
  // (see Session.endedAt), a value that moves forward as more events arrive:
  // - conversation-keyed OTel sessions (id is a conversation id, not one of its
  //   traces) and log-keyed ones (OTel logs carry no traceId at all);
  // - SDK sessions (source "sdk", alone or mixed with OTel spans): apps send
  //   events per conversation and rarely a session.end;
  // - sessions known only from a recorded transcript (backfill): a transcript
  //   is history, and it has no end marker.
  // Trace-keyed OTel sessions end with the root span's session.end.
  const allLive = s.captured > 0 && s.allLive;
  const allTranscript = s.captured > 0 && s.allTranscript;
  const endsAtLastActivity = (allLive && !traceIds.has(id)) || allTranscript;
  set("endedAt", endedAt ?? (endsAtLastActivity ? s.lastEnd : undefined) ?? (reopened ? undefined : prev?.endedAt));
  if (traceIds.size) session.traceIds = [...traceIds];
  set("runId", s.runId ?? prev?.runId);
  set("endSnapshot", s.endSnapshot ?? prev?.endSnapshot);
  set("parent", s.parent ?? prev?.parent);
  const project = s.project ?? prev?.project;
  if (project && project !== "default") session.project = project;
  set("parseVersion", prev?.parseVersion);
  return session;
}

/**
 * Folds a session's events into a Session row. Fields the events can't
 * provide (e.g. endSnapshot set by the snapshotter) are carried over from `prev`.
 */
export function buildSession(events: AgentEvent[], prev?: Session): Session {
  const sorted = byTime(events);
  const s = sessionState();
  for (const e of sorted) foldSession(s, e);
  return sessionOf(s, prev, sorted);
}

/** A model call that failed: `ok: false`, or an HTTP status of 400 or more. */
export function llmCallFailed(payload: Record<string, unknown>): boolean {
  return payload.ok === false || (typeof payload.statusCode === "number" && payload.statusCode >= 400);
}

/** Counts one failed call (sessions are built in time order, so the first one keeps its status and message). */
export function addLlmError(prev: LlmErrors | undefined, payload: Record<string, unknown>): LlmErrors {
  if (prev) return { ...prev, count: prev.count + 1 };
  const out: LlmErrors = { count: 1 };
  if (typeof payload.statusCode === "number") out.statusCode = payload.statusCode;
  if (typeof payload.error === "string" && payload.error) out.error = payload.error.slice(0, 300);
  return out;
}

/**
 * Parent link for a subagent session, from its session.start payload
 * ({ parentSessionId, parentEventId?, subagentId?, subagentType? }).
 * Ingest also links children named by a parent's subagent.* childSessionId.
 */
export function parentOf(sorted: AgentEvent[]): Session["parent"] | undefined {
  const start = sorted.find((e) => e.kind === "session.start" && typeof e.payload.parentSessionId === "string");
  if (!start) return undefined;
  const p = start.payload;
  const parent: NonNullable<Session["parent"]> = { sessionId: p.parentSessionId as string };
  if (typeof p.parentEventId === "string") parent.eventId = p.parentEventId;
  const subagentId = typeof p.subagentId === "string" ? p.subagentId : start.subagentId;
  if (subagentId) parent.subagentId = subagentId;
  if (typeof p.subagentType === "string") parent.type = p.subagentType;
  return parent;
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Latency inputs folded so far (see latencyStats). */
interface LatencyState {
  firstTs?: number;
  lastTs?: number;
  /** Latest end of any event (eventEnd). */
  maxEnd?: number;
  llmCalls: number;
  llm: number[];
  ttft: number[];
  toolStartTs: Map<string, number>;
  tools: number[];
  subagents: Set<string>;
  anonymousSubagents: number;
}

const latencyState = (): LatencyState => ({ llmCalls: 0, llm: [], ttft: [], toolStartTs: new Map(), tools: [], subagents: new Set(), anonymousSubagents: 0 });

function foldLatency(s: LatencyState, e: AgentEvent): void {
  s.firstTs ??= e.ts;
  s.lastTs = e.ts;
  const end = eventEnd(e);
  s.maxEnd = s.maxEnd === undefined ? end : Math.max(s.maxEnd, end);
  if (e.kind === "llm.call") {
    s.llmCalls++;
    const d = num(e.durationMs);
    if (d !== undefined) s.llm.push(d);
    const t = num(e.payload.ttftMs);
    if (t !== undefined) s.ttft.push(t);
  } else if (e.kind === "tool.start") {
    if (typeof e.payload.toolUseId === "string") s.toolStartTs.set(e.payload.toolUseId, e.ts);
  } else if (e.kind === "tool.end" && e.payload.wrapper !== true) {
    let d = num(e.durationMs) ?? num(e.payload.durationMs);
    if (d === undefined && typeof e.payload.toolUseId === "string") {
      const startTs = s.toolStartTs.get(e.payload.toolUseId);
      if (startTs !== undefined && e.ts >= startTs) d = e.ts - startTs;
    }
    if (d !== undefined) s.tools.push(d);
  } else if (e.kind === "subagent.start") {
    const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
    if (id) s.subagents.add(id);
    else s.anonymousSubagents++;
  }
}

function latencyOf(s: LatencyState, endedAt?: number): LatencyStats {
  const out: LatencyStats = {};
  if (s.firstTs !== undefined && s.lastTs !== undefined) out.wallMs = Math.max(0, Math.max(endedAt ?? s.lastTs, s.maxEnd!) - s.firstTs);
  if (s.llmCalls) {
    out.llmCalls = s.llmCalls;
    if (s.llm.length) {
      out.llmMs = round(s.llm.reduce((a, b) => a + b, 0));
      out.llmP50Ms = percentile(s.llm, 50);
      out.llmP95Ms = percentile(s.llm, 95);
    }
    if (s.ttft.length) out.ttftP50Ms = percentile(s.ttft, 50);
  }
  if (s.tools.length) {
    out.toolMs = round(s.tools.reduce((a, b) => a + b, 0));
    out.toolP95Ms = percentile(s.tools, 95);
  }
  const subagentCount = s.subagents.size + s.anonymousSubagents;
  if (subagentCount) out.subagents = subagentCount;
  return out;
}

/**
 * Latency aggregates. Tool durations come from tool.end (event.durationMs,
 * then payload.durationMs, then end − matching tool.start ts).
 */
export function latencyStats(sorted: AgentEvent[], endedAt?: number): LatencyStats {
  const s = latencyState();
  for (const e of sorted) foldLatency(s, e);
  return latencyOf(s, endedAt);
}

// ---------------------------------------------------------------- detectors

/** What the failure-pattern detectors carry from one event to the next. */
interface FlagState {
  premature: PrematureState;
  repeated: RepeatedFailureState;
  fileChange: boolean;
  verified: boolean;
  compaction: boolean;
  gateways: Set<GatewayId>;
  tamper: TamperState;
}

const flagState = (): FlagState => ({
  premature: { failing: false, endedWhileFailing: false },
  repeated: repeatedFailureState(),
  fileChange: false,
  verified: false,
  compaction: false,
  gateways: new Set(),
  tamper: tamperState(),
});

function foldFlags(s: FlagState, e: AgentEvent): void {
  foldPremature(s.premature, e);
  foldRepeatedFailure(s.repeated, e);
  foldTamper(s.tamper, e);
  if (e.kind === "file.change") s.fileChange = true;
  if (e.kind === "test.result" || isVerifyToolStart(e)) s.verified = true;
  if (e.kind === "context.compact") s.compaction = true;
  const g = gatewayOfEvent(e);
  if (g) s.gateways.add(g);
}

/** `sorted` (the events folded, in time order) is needed only when the tamper fold can't settle on its own. */
function flagsOf(s: FlagState, derails: readonly Derail[], sorted?: readonly AgentEvent[]): string[] {
  const flags: string[] = [];
  if (s.premature.endedWhileFailing) flags.push(FLAGS.prematureCompletion);
  if (s.repeated.found) flags.push(FLAGS.repeatedToolFailure);
  if (s.fileChange && !s.verified) flags.push(FLAGS.noVerification);
  if (s.compaction) flags.push(FLAGS.compaction);
  for (const d of derails) if (!flags.includes(d.flag)) flags.push(d.flag);
  if (s.tamper.high || (s.tamper.needsEvents && detectTestTamper(sorted!))) flags.push(FLAGS.testTamper);
  flags.push(...gatewayFlagsOf(s.gateways));
  return flags;
}

/** Failure flags for a session. `derails` (already detected on the same events) saves detecting them again. */
export function detectFlags(events: AgentEvent[], derails?: readonly Derail[]): string[] {
  const sorted = byTime(events);
  const s = flagState();
  for (const e of sorted) foldFlags(s, e);
  return flagsOf(s, derails ?? detectDerails(sorted), sorted);
}

interface PrematureState {
  failing: boolean;
  endedWhileFailing: boolean;
}

function foldPremature(s: PrematureState, e: AgentEvent): void {
  if (e.kind === "test.result") {
    s.failing = (num(e.payload.failed) ?? 0) > 0;
    // A later green run means the work was eventually finished.
    if (!s.failing) s.endedWhileFailing = false;
  } else if ((e.kind === "turn.end" || e.kind === "session.end") && s.failing) {
    s.endedWhileFailing = true;
  }
}

/** The agent ended a turn/session while the latest test run was failing, and tests never went green afterwards. */
export function detectPrematureCompletion(sorted: AgentEvent[]): boolean {
  const s: PrematureState = { failing: false, endedWhileFailing: false };
  for (const e of sorted) foldPremature(s, e);
  return s.endedWhileFailing;
}

function signature(tool: string, input: unknown): string {
  const cmd = commandOf(input);
  if (cmd !== undefined) return cmd;
  if (input === undefined) return tool;
  return typeof input === "string" ? input : JSON.stringify(input);
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean));
}

/** Jaccard similarity of token sets ≥ 0.6, or exact match after whitespace normalization. */
export function similarInputs(a: string, b: string): boolean {
  if (a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

interface RepeatedFailureState {
  /** Signature of each started call's input, by toolUseId (a tool.end often leaves its input out). */
  inputs: Map<string, string>;
  streaks: Map<string, { count: number; sig: string }>;
  found: boolean;
}

const repeatedFailureState = (): RepeatedFailureState => ({ inputs: new Map(), streaks: new Map(), found: false });

function foldRepeatedFailure(s: RepeatedFailureState, e: AgentEvent, threshold = 3): void {
  if (s.found) return;
  const id = typeof e.payload.toolUseId === "string" ? e.payload.toolUseId : undefined;
  if (e.kind === "tool.start" && id) {
    // signature() only names the tool when there is no input at all.
    if (e.payload.input === undefined) s.inputs.delete(id);
    else s.inputs.set(id, signature("", e.payload.input));
  }
  if (e.kind !== "tool.end") return;
  const tool = typeof e.payload.tool === "string" ? e.payload.tool : "?";
  if (e.payload.ok !== false) {
    s.streaks.delete(tool);
    return;
  }
  const input = e.payload.input;
  const sig = input !== undefined && input !== null ? signature(tool, input) : ((id ? s.inputs.get(id) : undefined) ?? signature(tool, input ?? undefined));
  const prev = s.streaks.get(tool);
  const count = prev && similarInputs(prev.sig, sig) ? prev.count + 1 : 1;
  if (count >= threshold) {
    s.found = true;
    s.inputs.clear();
    s.streaks.clear();
    return;
  }
  s.streaks.set(tool, { count, sig });
}

/** ≥3 consecutive failures of the same tool with similar input (the agent is stuck retrying). */
export function detectRepeatedToolFailure(sorted: AgentEvent[], threshold = 3): boolean {
  const s = repeatedFailureState();
  for (const e of sorted) {
    foldRepeatedFailure(s, e, threshold);
    if (s.found) return true;
  }
  return false;
}

/** Files were changed but nothing was ever run to check them. */
export function detectNoVerification(sorted: AgentEvent[]): boolean {
  if (!sorted.some((e) => e.kind === "file.change")) return false;
  return !sorted.some((e) => e.kind === "test.result" || isVerifyToolStart(e));
}
