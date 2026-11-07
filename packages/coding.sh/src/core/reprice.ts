// One-time repricing of stored events. Ingest prices model calls as it stores
// them (pricing.ts priceEvent); events stored before that, or under an older
// price table, are filled in here, in place (same ids):
// - only calls (and usage snapshots) with tokens and no cost, or with a cost we
//   estimated earlier; a cost the agent reported is never touched;
// - a call with a gateway companion (`coding.sh gateway enrich`) is skipped:
//   the companion holds billed minus the cost the call had, so a new estimate
//   would be counted twice;
// - each changed session gets its usage totals refolded, nothing else.
// It runs once per price table (built-in + `[prices]` overrides) and lookup-rule
// version: the stamp is kept under a cursor, so later opens cost one read.
// `coding.sh usage --reprice` forces a pass.
import type { AgentEvent, Session } from "../schema/index.ts";
import { sha256Hex } from "./ids.ts";
import { priceEvent, PRICING_RULES_VERSION, pricesFor, type Prices } from "./pricing.ts";
import { buildSession } from "./sessions.ts";
import type { EventCost, IndexStore } from "./types.ts";

export const REPRICE_CURSOR = "pricing:repriced";
const KINDS = ["llm.call", "notification", "span"];

/** Positive int that changes whenever the effective price table, or the rules that look it up, do. */
export function priceStamp(prices: Prices, rules: number = PRICING_RULES_VERSION): number {
  const table = Object.keys(prices).sort().map((k) => [k, prices[k]]);
  return parseInt(sha256Hex(JSON.stringify({ rules, table })).slice(0, 12), 16) || 1;
}

export interface RepriceResult {
  /** False when the table was already applied (or the store can't update events). */
  ran: boolean;
  events: number;
  sessions: number;
}

/** Fills missing (or our own stale) cost estimates on stored events, once per price table. `force` reruns it. */
export async function repriceStored(index: IndexStore, overrides?: Prices, opts: { force?: boolean } = {}): Promise<RepriceResult> {
  const none = { ran: false, events: 0, sessions: 0 };
  if (!index.setEventCosts) return none;
  const prices = pricesFor(overrides);
  const stamp = priceStamp(prices);
  if (!opts.force && (await index.getCursor(REPRICE_CURSOR)) === stamp) return none;
  let events = 0;
  let sessions = 0;
  for (const prev of await index.listSessions({})) {
    const stored = await index.listEvents(prev.id, { kinds: KINDS });
    const enriched = new Set(stored.filter((e) => e.source === "gateway" && e.parentId).map((e) => e.parentId!));
    const costs: EventCost[] = [];
    let estimates = false;
    for (const e of stored) {
      if (enriched.has(e.id)) continue;
      const ours = e.payload?.costEstimated === true;
      const priced = priceEvent(ours ? withoutCost(e) : e, prices);
      const cost = priced.usage?.costUsd;
      if (priced === e || typeof cost !== "number") continue;
      estimates = true;
      const pricedAs = typeof priced.payload.pricedAs === "string" ? priced.payload.pricedAs : undefined;
      const priceTier = typeof priced.payload.priceTier === "string" ? priced.payload.priceTier : undefined;
      if (cost !== e.usage?.costUsd || pricedAs !== e.payload?.pricedAs || priceTier !== e.payload?.priceTier)
        costs.push({ id: e.id, costUsd: cost, ...(pricedAs ? { pricedAs } : {}), ...(priceTier ? { priceTier } : {}) });
    }
    // Sessions folded before session totals said which part is estimated are refolded once.
    const unmarked = estimates && prev.stats.usage?.estimatedCostUsd === undefined;
    if (!costs.length && !unmarked) continue;
    if (costs.length) events += await index.setEventCosts(costs);
    await index.upsertSession(withUsage(prev, buildSession(await index.listEvents(prev.id), prev)));
    sessions++;
  }
  await index.setCursor(REPRICE_CURSOR, stamp);
  return { ran: true, events, sessions };
}

function withoutCost(e: AgentEvent): AgentEvent {
  const { costUsd: _drop, ...usage } = e.usage ?? {};
  const { pricedAs: _was, priceTier: _tier, ...payload } = e.payload ?? {};
  return { ...e, usage, payload };
}

/** The stored session with only its usage totals refolded (links, repo state and the rest stay). */
function withUsage(prev: Session, rebuilt: Session): Session {
  const { usage: _u, duplicateUsage: _d, ...stats } = prev.stats;
  const { usage, duplicateUsage } = rebuilt.stats;
  return { ...prev, stats: { ...stats, ...(usage ? { usage } : {}), ...(duplicateUsage ? { duplicateUsage } : {}) } };
}
