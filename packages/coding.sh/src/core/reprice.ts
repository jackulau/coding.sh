// One-time repricing of stored events. Ingest prices model calls as it stores
// them (pricing.ts priceEvent); events stored before that, or under an older
// price table, are filled in here, in place (same ids):
// - only calls (and usage snapshots) with tokens and no cost, or with a cost we
//   estimated earlier (rewritten when the estimate, or its split by token type,
//   `payload.costByTokenType`, differs); a cost the agent reported is never touched;
// - a call a gateway companion billed (`coding.sh gateway enrich`) is skipped:
//   the companion holds billed minus the cost the call had, so a new estimate
//   would be counted twice. A companion with no billed cost bills nothing, and
//   its call is priced like any other. A session's events are read again and
//   written in one transaction, so a companion stored meanwhile is seen;
// - each changed session gets its usage totals (and cache-break cost) refolded, nothing else.
// It runs once per price table (built-in + `[prices]` overrides) and lookup-rule
// version: the stamp is kept under a cursor, so later opens cost one read.
// Opening the index (store/factory.ts) leaves the pass to the background ingest that
// refolds (core/reparse.ts) when one will run, and runs it there and then otherwise.
// That ingest reprices a session it folds anyway right before the fold (repriceEvents),
// so the session is folded once, and runs the pass over the rest at its end.
// `coding.sh usage --reprice` forces a pass. A pass holds the lock the refold holds
// (repriceLock), so two processes never run one at once.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, CostByTokenType, Session } from "../schema/index.ts";
import { repriceProgress } from "../store/upgrade.ts";
import { sha256Hex } from "./ids.ts";
import { acquireLock, type Lock } from "./lock.ts";
import { priceEvent, PRICING_RULES_VERSION, pricesFor, TOKEN_TYPES, type Prices } from "./pricing.ts";
import { billedCallOf, buildSession } from "./sessions.ts";
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

export interface RepriceOptions {
  /** Run even when this price table was applied (`coding.sh usage --reprice`). */
  force?: boolean;
  /** Runs `fn` over the stored sessions in order (default one after another). The background ingest passes its short lock holds. */
  each?: (sessions: Session[], fn: (prev: Session) => Promise<void>) => Promise<void>;
  /** True for a session the pass leaves out: the caller repriced it already, right before its fold (core/reparse.ts). */
  skip?: (id: string) => boolean;
  /** Sessions looked at so far, of all of them. Default: a line where a person waits, after 2 s (store/upgrade.ts repriceProgress). */
  onProgress?: (done: number, total: number) => void;
  /**
   * The lock file the pass holds: default the one repriceLock set for this store, if any. false: none,
   * for a caller that holds it already (core/reparse.ts). A forced pass waits up to 30 s for it; any
   * other pass tries once. Busy, the pass throws LockBusyError and leaves the cursor as it was.
   */
  lock?: string | false;
}

/** The lock a store's pass holds, by store: set where the store is opened (store/factory.ts). */
const locks = new WeakMap<IndexStore, string>();

/** Sets the lock file a pass on this store holds: the one the refold of its home holds (core/reparse.ts). */
export function repriceLock(index: IndexStore, path: string): void {
  locks.set(index, path);
}

/** Fills missing (or our own stale) cost estimates on stored events, once per price table. `force` reruns it. */
export async function repriceStored(index: IndexStore, overrides?: Prices, opts: RepriceOptions = {}): Promise<RepriceResult> {
  const none = { ran: false, events: 0, sessions: 0 };
  if (!index.setEventCosts) return none;
  const prices = pricesFor(overrides);
  const stamp = priceStamp(prices);
  if (!opts.force && (await index.getCursor(REPRICE_CURSOR)) === stamp) return none;
  const path = opts.lock === undefined ? locks.get(index) : opts.lock || undefined;
  const lock = path ? await takeLock(path, opts.force ? 30_000 : 0) : undefined;
  try {
    // Another process may have run it while this one looked.
    if (lock && !opts.force && (await index.getCursor(REPRICE_CURSOR)) === stamp) return none;
    const each = opts.each ?? (async (list, fn) => {
      for (const s of list) await fn(s);
    });
    const progress = opts.onProgress ?? repriceProgress();
    const all = (await index.listSessions({})).filter((s) => !opts.skip?.(s.id));
    let events = 0;
    let sessions = 0;
    let done = 0;
    await each(all, async (prev) => {
      const r = await repriceSession(index, prev, prices, true);
      events += r.events;
      if (r.changed) sessions++;
      progress(++done, all.length);
    });
    await index.setCursor(REPRICE_CURSOR, stamp);
    return { ran: true, events, sessions };
  } finally {
    lock?.release();
  }
}

/** The lock at `path`, or undefined where no lock file can be made (a read-only home): the pass then runs as it did before it took one. Busy throws. */
async function takeLock(path: string, waitMs: number): Promise<Lock | undefined> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return await acquireLock(path, { waitMs });
  } catch (err) {
    if ((err as Error).name === "LockBusyError") throw err;
    return undefined;
  }
}

/**
 * One session's events repriced and nothing else, for a caller that folds the session right after
 * (core/reparse.ts), so the fold counts the new costs. True when that fold is owed: a cost changed,
 * or the session was folded before its totals said which part is estimated.
 */
export async function repriceEvents(index: IndexStore, prev: Session, prices: Prices): Promise<boolean> {
  return (await repriceSession(index, prev, prices, false)).changed;
}

/** One session's pass: its events' new costs, then, with `totals`, its totals when they changed. */
async function repriceSession(index: IndexStore, prev: Session, prices: Prices, totals: boolean): Promise<{ events: number; changed: boolean }> {
  const unchanged = { events: 0, changed: false };
  if (!owed(await newCosts(index, prev, prices), prev)) return unchanged;
  // Read again and write in one transaction: a gateway companion stored since the read above
  // (`coding.sh gateway enrich`, another process) is seen, so the call it bills gets no estimate
  // on top of the companion's correction.
  return inTransaction(index, async () => {
    const plan = await newCosts(index, prev, prices);
    if (!owed(plan, prev)) return unchanged;
    const events = plan.costs.length ? await index.setEventCosts!(plan.costs) : 0;
    if (totals) await refreshTotals(index, prev.id, prev);
    return { events, changed: true };
  });
}

const inTransaction = <T>(index: IndexStore, fn: () => Promise<T>): Promise<T> => (index.transaction ? index.transaction(fn) : fn());

interface CostPlan {
  costs: EventCost[];
  /** Some stored event has a cost estimate under these prices. */
  estimates: boolean;
}

/** A session owes a write when a cost changed, or once when it was folded before its totals said which part is estimated. */
const owed = (p: CostPlan, prev: Session): boolean => p.costs.length > 0 || (p.estimates && prev.stats.usage?.estimatedCostUsd === undefined);

/** The new costs of one session's stored events. */
async function newCosts(index: IndexStore, prev: Session, prices: Prices): Promise<CostPlan> {
  const stored = await index.listEvents(prev.id, { kinds: KINDS });
  const enriched = new Set(stored.map(billedCallOf).filter((id) => id !== undefined));
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
    const parts = priced.payload.costByTokenType as CostByTokenType | undefined;
    if (cost !== e.usage?.costUsd || pricedAs !== e.payload?.pricedAs || priceTier !== e.payload?.priceTier || !sameParts(parts, e.payload?.costByTokenType)) {
      const c: EventCost = { id: e.id, costUsd: cost, ...(pricedAs ? { pricedAs } : {}), ...(priceTier ? { priceTier } : {}) };
      if (parts) c.costByTokenType = parts;
      costs.push(c);
    }
  }
  return { costs, estimates };
}

/**
 * Folds a session's priced totals again from its stored events, keeping the rest of the stored
 * session (links, repo state). Reads the session again, so totals written meanwhile are not
 * undone; `prev` is the row to use when it can't be read.
 */
export async function refreshTotals(index: IndexStore, id: string, prev?: Session): Promise<void> {
  const cur = (await index.getSession(id)) ?? prev;
  if (!cur) return;
  await index.upsertSession(withUsage(cur, buildSession(await index.listEvents(id), cur)));
}

/**
 * Opens that left the pass to a background ingest (store/factory.ts): the store, and the stamp
 * of the price table the pass is to apply. In memory, so only a process that opened the store
 * that way asks; the cursor says when the pass is done.
 */
const deferred = new WeakMap<IndexStore, number>();

/** Marks the pass for this price stamp as left to the background ingest that refolds (core/reparse.ts reparseDue). */
export function deferReprice(index: IndexStore, stamp: number): void {
  deferred.set(index, stamp);
}

/** True while a pass this process left to the background ingest has not run: one cursor read, none when none was left. */
export async function repricePending(index: IndexStore): Promise<boolean> {
  const stamp = deferred.get(index);
  if (stamp === undefined) return false;
  if ((await index.getCursor(REPRICE_CURSOR)) !== stamp) return true;
  deferred.delete(index);
  return false;
}

function withoutCost(e: AgentEvent): AgentEvent {
  const { costUsd: _drop, ...usage } = e.usage ?? {};
  const { pricedAs: _was, priceTier: _tier, costByTokenType: _parts, ...payload } = e.payload ?? {};
  return { ...e, usage, payload };
}

/** Whether a stored `payload.costByTokenType` holds exactly these parts. */
function sameParts(parts: CostByTokenType | undefined, stored: unknown): boolean {
  if (!parts || !stored || typeof stored !== "object") return !parts && stored === undefined;
  return TOKEN_TYPES.every((k) => (stored as Record<string, unknown>)[k] === parts[k]);
}

/** The stored session with only its priced totals refolded (links, repo state and the rest stay). */
function withUsage(prev: Session, rebuilt: Session): Session {
  const { usage: _u, duplicateUsage: _d, cacheBreaks: _c, ...stats } = prev.stats;
  const { usage, duplicateUsage, cacheBreaks } = rebuilt.stats;
  return { ...prev, stats: { ...stats, ...(usage ? { usage } : {}), ...(duplicateUsage ? { duplicateUsage } : {}), ...(cacheBreaks ? { cacheBreaks } : {}) } };
}
