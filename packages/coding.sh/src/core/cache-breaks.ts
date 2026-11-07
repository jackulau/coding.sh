// Cache breaks: a model call that finds the prompt cache gone. Every prompt
// token after the first change is billed again at the write (or full input)
// rate instead of the cache-read rate, so a context rewrite can cost more than
// it saves ("The Hidden Costs of Forgetting", arXiv 2610.35496: total tokens
// fell in 31 of 42 trajectory-deletion configs, caching-aware cost in none).
// Pure over a session's events.
//
// Per scope (sessionId, subagentId), over llm.call events with usage, P = input
// + cache reads + cache writes. A call breaks the cache when the previous call
// in its scope used the cache (has a cache field), had P > 4096, and this call
// read less than half of that from cache, losing more than 2048 tokens:
// lost = min(prev P, this P) − this call's cache reads.
// Cause, first match: a context.compact in the scope between the two calls;
// a different model; a gap past the cache lifetime (5 minutes, or 1 hour when
// the previous call wrote to the 1-hour cache); else other.
import type { AgentEvent, CacheBreakCause, CacheBreakStats, Usage } from "../schema/index.ts";
import { cacheWrite1h, callRates, callTier, eventPrice, geoValue, pricesFor, promptTokens, type Prices } from "./pricing.ts";

export interface CacheBreak {
  /** The llm.call that paid again, and the one before it in the same scope. */
  eventId: string;
  prevEventId: string;
  cause: CacheBreakCause;
  lostTokens: number;
  /** Time from the end of the previous call to the start of this one. */
  gapMs: number;
  /** lostTokens × (write or input rate − cache-read rate); unset when the model has no price. */
  extraUsd?: number;
}

export const CACHE_BREAK_MIN_PREV = 4096;
export const CACHE_BREAK_MIN_LOST = 2048;
export const CACHE_BREAK_READ_SHARE = 0.5;
/** Anthropic's default cache lifetime, and the 1-hour cache's. */
export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const hasCacheField = (u: Usage): boolean => num(u.cacheReadTokens) !== undefined || num(u.cacheWriteTokens) !== undefined;
const modelOf = (e: AgentEvent): string | undefined => {
  for (const m of [e.payload.responseModel, e.model, e.payload.requestModel]) if (typeof m === "string" && m) return m;
  return undefined;
};

/** USD per re-billed token for this call: what it paid to write (or send) them minus what reading them from cache costs. */
function extraRate(e: AgentEvent, prices: Prices): number | undefined {
  const r = eventPrice(e, prices);
  if (!r) return undefined;
  const u = e.usage!;
  const { rates } = callRates(r.price, callTier(e.payload), promptTokens(u), geoValue(e.payload.inferenceGeo));
  const read = rates.cacheRead ?? rates.input;
  const write = num(u.cacheWriteTokens) ?? 0;
  if (write <= 0) return (rates.input - read) / 1e6;
  // Writes split between the 5-minute and the 1-hour cache, priced by their shares.
  const w5 = rates.cacheWrite ?? rates.input;
  const long = Math.min(cacheWrite1h(e.payload), write) / write;
  return ((1 - long) * w5 + long * (rates.cacheWrite1h ?? w5) - read) / 1e6;
}

interface Prev {
  e: AgentEvent;
  p: number;
  end: number;
  compacted: boolean;
}

/** Cache breaks in time-sorted events, priced from `prices` (the built-in table by default). */
export function findCacheBreaks(sorted: readonly AgentEvent[], prices: Prices = pricesFor()): CacheBreak[] {
  const last = new Map<string, Prev>();
  const out: CacheBreak[] = [];
  for (const e of sorted) {
    const scope = `${e.sessionId}\u0000${e.subagentId ?? ""}`;
    if (e.kind === "context.compact") {
      const prev = last.get(scope);
      if (prev) prev.compacted = true;
      continue;
    }
    // Gateway companions repeat a call's usage; replayed calls were never sent again.
    if (e.kind !== "llm.call" || !e.usage || e.payload.replay === true || e.source === "gateway") continue;
    const u = e.usage;
    const p = promptTokens(u);
    if (p <= 0) continue;
    const prev = last.get(scope);
    last.set(scope, { e, p, end: e.ts + (num(e.durationMs) ?? 0), compacted: false });
    if (!prev || !hasCacheField(prev.e.usage!) || prev.p <= CACHE_BREAK_MIN_PREV) continue;
    const read = num(u.cacheReadTokens) ?? 0;
    const lost = Math.min(prev.p, p) - read;
    if (read >= CACHE_BREAK_READ_SHARE * prev.p || lost <= CACHE_BREAK_MIN_LOST) continue;
    const gapMs = Math.max(0, e.ts - prev.end);
    const ttl = cacheWrite1h(prev.e.payload) > 0 ? CACHE_TTL_1H_MS : CACHE_TTL_MS;
    const model = modelOf(e);
    const prevModel = modelOf(prev.e);
    const cause: CacheBreakCause = prev.compacted ? "compaction" : model && prevModel && model !== prevModel ? "model-switch" : gapMs >= ttl ? "idle" : "other";
    const rate = extraRate(e, prices);
    const b: CacheBreak = { eventId: e.id, prevEventId: prev.e.id, cause, lostTokens: lost, gapMs };
    if (rate !== undefined) b.extraUsd = Math.max(0, lost * rate);
    out.push(b);
  }
  return out;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Session.stats.cacheBreaks from the breaks; undefined when there are none. */
export function cacheBreakStats(breaks: readonly CacheBreak[]): CacheBreakStats | undefined {
  if (!breaks.length) return undefined;
  const byCause: CacheBreakStats["byCause"] = {};
  const unpricedBy = new Map<CacheBreakCause, number>();
  let lost = 0;
  let usd = 0;
  let unpriced = 0;
  for (const b of breaks) {
    const c = (byCause[b.cause] ??= { count: 0, lostTokens: 0, extraUsd: 0 });
    c.count++;
    c.lostTokens += b.lostTokens;
    lost += b.lostTokens;
    if (b.extraUsd === undefined) {
      unpriced++;
      unpricedBy.set(b.cause, (unpricedBy.get(b.cause) ?? 0) + 1);
    } else {
      c.extraUsd! += b.extraUsd;
      usd += b.extraUsd;
    }
  }
  for (const [k, c] of Object.entries(byCause) as [CacheBreakCause, NonNullable<CacheBreakStats["byCause"][CacheBreakCause]>][]) {
    if (unpricedBy.has(k)) delete c.extraUsd;
    else c.extraUsd = round6(c.extraUsd!);
  }
  return { count: breaks.length, lostTokens: lost, ...(unpriced ? { unpriced } : { extraUsd: round6(usd) }), byCause };
}
