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
import { findCacheBreaks, CACHE_BREAK_FIX, type CacheBreak } from "../core/cache-breaks.ts";
import { byTime } from "../core/sessions.ts";
import type { BlobStore } from "../core/types.ts";
import { diffCalls, loadCall, type LineOp } from "../proxy/calls.ts";
import type { AgentEvent } from "../schema/index.ts";

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

/** A break and its structural cause. */
export interface ClassifiedBreak extends CacheBreak {
  sessionId: string;
  structural: CacheCause;
  /** Classified without both stored requests (hashes, or the break's own cause). */
  degraded: boolean;
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
 * `events` may come in any order.
 */
export async function sessionBreaks(blobs: BlobStore, events: readonly AgentEvent[]): Promise<ClassifiedBreak[]> {
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
  const out: ClassifiedBreak[] = [];
  for (const b of breaks) {
    const prev = byId.get(b.prevEventId);
    const cur = byId.get(b.eventId);
    const sessionId = cur?.sessionId ?? prev?.sessionId ?? "";
    if (!prev || !cur) {
      out.push({ ...b, sessionId, structural: fallback(b), degraded: true });
      continue;
    }
    const d = diffCalls(await loadCall(blobs, stored(prev)), await loadCall(blobs, stored(cur)));
    const t = d.tools;
    let structural: CacheCause;
    if (d.model || b.cause === "model-switch") structural = "model-switch";
    else if (t.added.length) structural = "tools-added";
    else if (t.removed.length) structural = "tools-removed";
    else if (t.reordered) structural = "tools-reordered";
    else if (!t.same) structural = "tools-changed";
    else if (!d.system.same) structural = volatileLine(d.system.lines) ? "system-volatile-line" : "system-changed";
    else if (d.messages.rewritten || b.cause === "compaction") structural = "history-rewritten";
    else structural = b.cause === "idle" ? "idle" : "other";
    out.push({ ...b, sessionId, structural, degraded: d.content !== "full" });
  }
  return out;
}

const fallback = (b: CacheBreak): CacheCause => (b.cause === "compaction" ? "history-rewritten" : b.cause === "model-switch" ? "model-switch" : b.cause === "idle" ? "idle" : "other");

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
  example: { a: string; b: string; command: string };
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
  avoidableTokens: number;
  avoidableShare?: number;
  causes: CauseRow[];
  /** Breaks classified without both stored requests. */
  degraded: number;
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

/** The report: breaks aggregated per cause, ranked by extra USD, then tokens, then cache order. */
export function cacheHealth(o: { hitRate?: number; promptTokens: number; breaks: readonly ClassifiedBreak[] }): CacheHealth {
  const by = new Map<CacheCause, { count: number; sessions: Set<string>; lost: number; usd: number; unpriced: boolean; top?: ClassifiedBreak }>();
  let lost = 0;
  let usd = 0;
  let unpriced = false;
  let avoidable = 0;
  for (const b of o.breaks) {
    const r = by.get(b.structural) ?? { count: 0, sessions: new Set<string>(), lost: 0, usd: 0, unpriced: false };
    r.count++;
    r.sessions.add(b.sessionId);
    r.lost += b.lostTokens;
    if (b.extraUsd === undefined) r.unpriced = unpriced = true;
    else {
      r.usd += b.extraUsd;
      usd += b.extraUsd;
    }
    const cost = (x: ClassifiedBreak) => x.extraUsd ?? 0;
    if (!r.top || cost(b) > cost(r.top) || (cost(b) === cost(r.top) && b.lostTokens > r.top.lostTokens)) r.top = b;
    by.set(b.structural, r);
    lost += b.lostTokens;
    if (AVOIDABLE.has(b.structural)) avoidable += b.lostTokens;
  }
  const causes: CauseRow[] = [...by].map(([cause, r]) => ({
    cause,
    count: r.count,
    sessions: r.sessions.size,
    lostTokens: r.lost,
    ...(r.unpriced ? {} : { extraUsd: round(r.usd, 6) }),
    avoidable: AVOIDABLE.has(cause),
    fix: CACHE_CAUSE_FIX[cause],
    example: { a: r.top!.prevEventId, b: r.top!.eventId, command: `coding.sh diff-calls ${r.top!.prevEventId} ${r.top!.eventId}` },
  }));
  causes.sort((x, y) => (y.extraUsd ?? 0) - (x.extraUsd ?? 0) || y.lostTokens - x.lostTokens || CACHE_CAUSES.indexOf(x.cause) - CACHE_CAUSES.indexOf(y.cause));
  const share = o.promptTokens > 0 ? avoidable / o.promptTokens : undefined;
  const graded = o.hitRate !== undefined ? cacheScore(o.hitRate, share ?? 0) : undefined;
  return {
    ...(o.hitRate !== undefined ? { hitRate: o.hitRate } : {}),
    ...(graded ? graded : {}),
    promptTokens: o.promptTokens,
    breaks: o.breaks.length,
    lostTokens: lost,
    ...(o.breaks.length && !unpriced ? { extraUsd: round(usd, 6) } : {}),
    avoidableTokens: avoidable,
    ...(share !== undefined ? { avoidableShare: round(share, 4) } : {}),
    causes,
    degraded: o.breaks.filter((b) => b.degraded).length,
  };
}
