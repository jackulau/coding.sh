// `coding.sh cache doctor`: how healthy a setup's prompt cache is, and what breaks the prefix.
//
// The breaks are the ones Session.stats.cacheBreaks counts (core/cache-breaks.ts, over the same
// events and prices), so tokens and USD reconcile with `usage` and `show`. Each break is then
// classified by the first structural change between the two calls, in the order the provider's
// cache reads a request (proxy/calls.ts diffCalls): the model, the tools, the system prompt, the
// message history, and only then the wait. A system prompt whose only change is a line that differs
// in its numbers (a timestamp, a date, a counter) is `system-volatile-line`, the commonest
// self-inflicted break ("Prompt Caching Lessons from Building Claude Code", Anthropic).
//
// Without stored requests (capture mode metadata, or transcript-only sessions) the diff falls back
// to the hashes and counts the events keep, or to the break's own cause; those breaks are counted
// as degraded and the report says so.
//
// The totals, the causes and the grade cover every session in the window: each session with breaks
// has its calls read (BREAK_EVENT_KINDS). `--limit` only bounds how many sessions get their stored
// requests read as well. Past it a break is classified as a degraded one is, from what its two
// events keep, so a session with no stored requests reads the same at any --limit, and one with
// them keeps its avoidable share wherever the hashes and counts show the change (a history edit
// that keeps the message count is the case only the requests show). Those breaks are `notRead`.
import { findCacheBreaks, CACHE_BREAK_FIX, type CacheBreak } from "../core/cache-breaks.ts";
import { byTime } from "../core/sessions.ts";
import type { BlobStore } from "../core/types.ts";
import { diffCalls, loadCall, type LineOp, type LoadedCall } from "../proxy/calls.ts";
import type { AgentEvent, CacheBreakCause, CacheBreakStats } from "../schema/index.ts";

export type CacheCause =
  | "model-switch"
  | "tools-added"
  | "tools-removed"
  | "tools-reordered"
  | "tools-changed"
  | "system-volatile-line"
  | "system-changed"
  | "history-rewritten"
  | "idle"
  | "other";

/** Cache order: what the provider reads first comes first; a volatile line outranks a generic system change. */
export const CACHE_CAUSES: readonly CacheCause[] = ["model-switch", "tools-added", "tools-removed", "tools-reordered", "tools-changed", "system-volatile-line", "system-changed", "history-rewritten", "idle", "other"];

/** Causes the setup can remove. An idle gap and an unexplained miss are not. */
export const AVOIDABLE: ReadonlySet<CacheCause> = new Set(CACHE_CAUSES.filter((c) => c !== "idle" && c !== "other"));

/** One line per cause: the change that keeps the prefix cached. */
export const CACHE_CAUSE_FIX: Record<CacheCause, string> = {
  "model-switch": "keep one model per session; hand work for another model to a subagent instead of switching mid-session (check fallbackModel too)",
  "tools-added": "keep the tool set fixed for the session; load tools on demand (defer_loading) instead of adding them",
  "tools-removed": "keep the tool set fixed for the session; mark tools unavailable in a message instead of removing them",
  "tools-reordered": "send the tools in a stable order (sort them by name)",
  "tools-changed": "keep tool descriptions and schemas byte-for-byte stable within a session",
  "system-volatile-line": "keep changing values (dates, times, counters) out of the static system prompt; pass them in the next user or tool message",
  "system-changed": "keep the system prompt byte-for-byte stable within a session; put per-turn context in messages",
  "history-rewritten": "compact less often, and let the compaction call reuse the parent prefix (same system prompt, tools and messages)",
  idle: CACHE_BREAK_FIX.idle,
  other: "same prefix within the cache lifetime: the entry may have been evicted, or the cache breakpoints moved",
};

/**
 * The events a session's breaks and their causes are read from. findCacheBreaks takes tool.end too,
 * but only to say where an idle wait was (CacheBreak.idle), which this report leaves out.
 */
export const BREAK_EVENT_KINDS: string[] = ["llm.call", "context.compact"];

/** True for a call whose request the proxy stored (capture mode full). */
export const hasStoredRequest = (e: AgentEvent): boolean => e.kind === "llm.call" && typeof e.payload.requestRef === "string";

/** A break and its structural cause. */
export interface ClassifiedBreak extends Omit<CacheBreak, "idle"> {
  sessionId: string;
  structural: CacheCause;
  /** Classified without both requests because they are not stored: from hashes, message counts, the model and timing. */
  degraded: boolean;
  /** Both requests are stored but were not read (--limit): classified as a degraded break is. */
  notRead?: boolean;
}

/** A line with its numbers and long hex runs blanked: two lines that differ only there are one volatile line. */
const skeleton = (s: string): string => s.replace(/\b[0-9a-f]{8,}\b/gi, "#").replace(/\d+/g, "#").trim();

/** True when a system prompt diff only swaps lines that differ in their numbers (a timestamp, a date, a counter). */
export function volatileLine(lines: readonly LineOp[] | undefined): boolean {
  if (!lines) return false;
  const removed = lines.filter((l) => l.op === "-").map((l) => l.text);
  const added = lines.filter((l) => l.op === "+").map((l) => l.text);
  if (!removed.length || removed.length !== added.length || removed.length > 3) return false;
  return removed.every((r, i) => r !== added[i] && skeleton(r) === skeleton(added[i]!) && /\d/.test(r));
}

/** A transcript call's proxy twin (same provider request id), whose request is stored. */
function twins(events: readonly AgentEvent[]): Map<string, AgentEvent> {
  const out = new Map<string, AgentEvent>();
  for (const e of events) if (e.kind === "llm.call" && e.source === "proxy" && typeof e.payload.requestId === "string") out.set(e.payload.requestId, e);
  return out;
}

/**
 * The cache breaks of one session, as stats.cacheBreaks counts them, each with its structural cause.
 * `events` may come in any order; BREAK_EVENT_KINDS are enough. `requests: false` leaves the stored
 * requests unread: every break is classified from its two events alone.
 */
export async function sessionBreaks(blobs: BlobStore, events: readonly AgentEvent[], opts: { requests?: boolean } = {}): Promise<ClassifiedBreak[]> {
  const sorted = byTime([...events]);
  // The calls stats count: without the proxy's copies when another capture path recorded them (core/sessions.ts).
  const proxied = sorted.some((e) => e.kind === "llm.call" && e.source === "proxy");
  const other = sorted.some((e) => e.kind === "llm.call" && e.source !== "proxy" && e.source !== "gateway");
  const counted = proxied && other ? sorted.filter((e) => !(e.kind === "llm.call" && e.source === "proxy")) : sorted;
  const breaks = findCacheBreaks(counted);
  if (!breaks.length) return [];
  const byId = new Map(sorted.map((e) => [e.id, e]));
  const twin = twins(sorted);
  const stored = (e: AgentEvent): AgentEvent => (e.source !== "proxy" && typeof e.payload.requestId === "string" ? (twin.get(e.payload.requestId) ?? e) : e);
  const unread = opts.requests === false;
  const load = async (e: AgentEvent): Promise<LoadedCall> => (unread ? { event: e } : loadCall(blobs, e));
  const out: ClassifiedBreak[] = [];
  for (const { idle: _idle, ...b } of breaks) {
    const prev = byId.get(b.prevEventId);
    const cur = byId.get(b.eventId);
    const sessionId = cur?.sessionId ?? prev?.sessionId ?? "";
    if (!prev || !cur) {
      out.push({ ...b, sessionId, structural: fallback(b), degraded: true });
      continue;
    }
    const [a, c] = [stored(prev), stored(cur)];
    const d = diffCalls(await load(a), await load(c));
    const t = d.tools;
    // Fewer messages than the call before: the history was rewritten, and the counts show it without the requests.
    const shrank = d.messages.b > 0 && d.messages.b < d.messages.a;
    let structural: CacheCause;
    if (d.model || b.cause === "model-switch") structural = "model-switch";
    else if (t.added.length) structural = "tools-added";
    else if (t.removed.length) structural = "tools-removed";
    else if (t.reordered) structural = "tools-reordered";
    else if (!t.same) structural = "tools-changed";
    else if (!d.system.same) structural = volatileLine(d.system.lines) ? "system-volatile-line" : "system-changed";
    else if (d.messages.rewritten || shrank || b.cause === "compaction") structural = "history-rewritten";
    else structural = b.cause === "idle" ? "idle" : "other";
    const notRead = unread && hasStoredRequest(a) && hasStoredRequest(c);
    const row: ClassifiedBreak = { ...b, sessionId, structural, degraded: d.content !== "full" && !notRead };
    if (notRead) row.notRead = true;
    out.push(row);
  }
  return out;
}

/** The structural cause a stored cause stands for when the two requests cannot be compared. */
const structuralOf = (c: CacheBreakCause): CacheCause => (c === "compaction" ? "history-rewritten" : c === "model-switch" ? "model-switch" : c === "idle" ? "idle" : "other");
const fallback = (b: Pick<CacheBreak, "cause">): CacheCause => structuralOf(b.cause);

/** Breaks, tokens and USD over every session in the window, from their stored stats. */
export interface BreakTotals {
  breaks: number;
  lostTokens: number;
  /** The priced breaks' USD. Absent only when no break has a price. */
  extraUsd?: number;
  /** Breaks on a model with no price, left out of extraUsd. Absent when there are none. */
  unpricedBreaks?: number;
}

/** The stored totals `usage` adds up, over the sessions' stats.cacheBreaks. */
export function breakTotals(stats: Iterable<CacheBreakStats>): BreakTotals {
  let breaks = 0;
  let lost = 0;
  let usd = 0;
  let priced = false;
  let unpriced = 0;
  for (const b of stats) {
    breaks += b.count;
    lost += b.lostTokens;
    if (b.extraUsd !== undefined) {
      usd += b.extraUsd;
      priced = true;
    } else {
      // A session with an unpriced model: keep what its priced causes cost and count the rest.
      unpriced += Math.max(1, b.unpriced ?? 0);
      for (const c of Object.values(b.byCause)) if (c?.extraUsd !== undefined) {
        usd += c.extraUsd;
        priced = true;
      }
    }
  }
  const t: BreakTotals = { breaks, lostTokens: lost };
  if (priced) t.extraUsd = round(usd, 6);
  if (unpriced) t.unpricedBreaks = unpriced;
  return t;
}

export interface CauseRow {
  cause: CacheCause;
  count: number;
  sessions: number;
  lostTokens: number;
  /** Extra USD over reading from cache; absent when a break's model has no price. */
  extraUsd?: number;
  avoidable: boolean;
  fix: string;
  /** The costliest break of this cause: the two calls to pass to `coding.sh diff-calls`. */
  example?: { a: string; b: string; command: string };
}

export interface CacheHealth {
  /** Cache reads / all prompt tokens, as `usage` reports it (cacheReadShare). Absent with no prompt tokens. */
  hitRate?: number;
  /** 0-100, from the hit rate and the share of prompt tokens re-billed by avoidable causes. */
  score?: number;
  grade?: "A" | "B" | "C" | "D" | "F";
  promptTokens: number;
  breaks: number;
  lostTokens: number;
  extraUsd?: number;
  /** Breaks on a model with no price: extraUsd leaves them out. Absent when there are none. */
  unpricedBreaks?: number;
  avoidableTokens: number;
  avoidableShare?: number;
  causes: CauseRow[];
  /** Breaks classified without both requests because they are not stored. */
  degraded: number;
  /** Breaks whose stored requests were not read (--limit), classified as a degraded break is. Absent when there are none. */
  breaksNotRead?: number;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * The score: 60% hit rate against 90% (about what Claude Code reaches), 40% the avoidable share,
 * where re-billing a quarter of all prompt tokens for avoidable reasons costs the whole 40.
 */
export function cacheScore(hitRate: number, avoidableShare: number): { score: number; grade: NonNullable<CacheHealth["grade"]> } {
  const score = Math.round(100 * (0.6 * Math.min(1, hitRate / 0.9) + 0.4 * (1 - Math.min(1, avoidableShare * 4))));
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  return { score, grade };
}

/**
 * The report: breaks aggregated per cause, ranked by extra USD, then tokens, then cache order.
 * `breaks` are every session's, so the avoidable share and the grade cover the window. `totals`
 * (every session's stored stats) is the headline; without it the headline is the sum of `breaks`.
 */
export function cacheHealth(o: { hitRate?: number; promptTokens: number; breaks: readonly ClassifiedBreak[]; totals?: BreakTotals }): CacheHealth {
  interface Row { count: number; sessions: Set<string>; lost: number; usd: number; priced: boolean; unpriced: number; top?: ClassifiedBreak }
  const by = new Map<CacheCause, Row>();
  const rowOf = (cause: CacheCause): Row => {
    let r = by.get(cause);
    if (!r) by.set(cause, (r = { count: 0, sessions: new Set<string>(), lost: 0, usd: 0, priced: false, unpriced: 0 }));
    return r;
  };
  let lost = 0;
  let usd = 0;
  let priced = false;
  let unpriced = 0;
  let avoidable = 0;
  for (const b of o.breaks) {
    const r = rowOf(b.structural);
    r.count++;
    r.sessions.add(b.sessionId);
    r.lost += b.lostTokens;
    if (b.extraUsd === undefined) {
      r.unpriced++;
      unpriced++;
    } else {
      r.usd += b.extraUsd;
      r.priced = true;
      usd += b.extraUsd;
      priced = true;
    }
    const cost = (x: ClassifiedBreak) => x.extraUsd ?? 0;
    if (!r.top || cost(b) > cost(r.top) || (cost(b) === cost(r.top) && b.lostTokens > r.top.lostTokens)) r.top = b;
    lost += b.lostTokens;
    if (AVOIDABLE.has(b.structural)) avoidable += b.lostTokens;
  }
  const notRead = o.breaks.filter((b) => b.notRead).length;
  const causes: CauseRow[] = [...by].map(([cause, r]) => {
    const row: CauseRow = {
      cause,
      count: r.count,
      sessions: r.sessions.size,
      lostTokens: r.lost,
      ...(r.priced ? { extraUsd: round(r.usd, 6) } : {}),
      avoidable: AVOIDABLE.has(cause),
      fix: CACHE_CAUSE_FIX[cause],
    };
    if (r.top) row.example = { a: r.top.prevEventId, b: r.top.eventId, command: `coding.sh diff-calls ${r.top.prevEventId} ${r.top.eventId}` };
    return row;
  });
  causes.sort((x, y) => (y.extraUsd ?? 0) - (x.extraUsd ?? 0) || y.lostTokens - x.lostTokens || CACHE_CAUSES.indexOf(x.cause) - CACHE_CAUSES.indexOf(y.cause));
  let totals = o.totals;
  if (!totals) {
    totals = { breaks: o.breaks.length, lostTokens: lost };
    if (priced) totals.extraUsd = round(usd, 6);
    if (unpriced) totals.unpricedBreaks = unpriced;
  }
  const share = o.promptTokens > 0 ? avoidable / o.promptTokens : undefined;
  const graded = o.hitRate !== undefined ? cacheScore(o.hitRate, share ?? 0) : undefined;
  const health: CacheHealth = {
    ...(o.hitRate !== undefined ? { hitRate: o.hitRate } : {}),
    ...(graded ? graded : {}),
    promptTokens: o.promptTokens,
    breaks: totals.breaks,
    lostTokens: totals.lostTokens,
    ...(totals.extraUsd !== undefined ? { extraUsd: totals.extraUsd } : {}),
    avoidableTokens: avoidable,
    ...(share !== undefined ? { avoidableShare: round(share, 4) } : {}),
    causes,
    degraded: o.breaks.filter((b) => b.degraded).length,
  };
  if (totals.unpricedBreaks) health.unpricedBreaks = totals.unpricedBreaks;
  if (notRead) health.breaksNotRead = notRead;
  return health;
}
