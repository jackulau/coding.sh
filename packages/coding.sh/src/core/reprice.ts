// One-time repricing of stored events. Ingest prices model calls as it stores
// them (pricing.ts priceEvent); events stored before that, or under an older
// price table, are filled in here, in place (same ids):
// - only calls (and usage snapshots) with tokens and no cost, or with a cost we
//   estimated earlier (rewritten when the estimate, or its split by token type,
//   `payload.costByTokenType`, differs, and removed when no price backs one now);
//   a cost the agent reported is never touched;
// - a call a gateway companion billed (`coding.sh gateway enrich`) is skipped:
//   the companion holds billed minus the cost the call had, so a new estimate
//   would be counted twice. A companion with no billed cost bills nothing, and
//   its call is priced like any other. A session's events are read again right
//   before its writes, in one transaction with them where the store has
//   transactions, so a companion stored since the first read is seen (without
//   transactions, one stored between that second read and the writes is not);
// - each changed session gets its usage totals (and cache-break cost) refolded, nothing else.
//   Where the store has transactions (SQLite), a session's new costs and totals commit as one,
//   from its row and events read again inside it: an ingest's store-and-fold of the session
//   (one transaction too) falls before or after it, and a pass stopped halfway leaves the old
//   costs for the next pass to find. Where it has none, the pass holds the ingest lock around
//   each session's writes, and a later pass refreshes totals that a pass stopped between the
//   two left behind the session's events. It holds the lock for a second at most at a time
//   and leaves it free for a quarter second between holds, so an ingest waiting for it gets a turn.
// Reads and hooks that find a pass holding a lock leave the wake marker (spool/kick.ts) to it, as
// they do to an ingest. So between holds, while the marker is set, the pass runs an ingest
// (onWake: `usage --reprice`), or starts a background ingest and keeps off the lock until that
// ingest holds it (the kick repriceLock set: an open). A pass with neither, or whose background
// ingest never took the lock, leaves the spool to the next ingest.
// It runs once per price table (built-in + `[prices]` overrides) and lookup-rule
// version: the stamp is kept under a cursor, so later opens cost one read.
// Opening the index (store/factory.ts) leaves the pass to the background ingest that
// refolds (core/reparse.ts) when one will run, and runs it there and then otherwise.
// That ingest reprices a session it folds anyway right before the fold (repriceEvents),
// so the session is folded once, and runs the pass over the rest at its end.
// `coding.sh usage --reprice` forces a pass. A pass holds the lock the refold holds
// (repriceLock), so two processes never run one at once. Where that lock file can't
// be made (a read-only home), the pass waits for a run that can make it (a forced
// pass fails) rather than run without it.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentEvent, CostByTokenType, Session } from "../schema/index.ts";
import { repriceProgress } from "../store/upgrade.ts";
import { sha256Hex } from "./ids.ts";
import { acquireLock, isLocked, wakeMarker, type Lock } from "./lock.ts";
import { priceEvent, PRICING_RULES_VERSION, pricesFor, TOKEN_TYPES, type Prices } from "./pricing.ts";
import { billedCallOf, buildSession } from "./sessions.ts";
import type { EventCost, IndexStore } from "./types.ts";

export const REPRICE_CURSOR = "pricing:repriced";
const KINDS = ["llm.call", "notification", "span"];
/** Longest the pass holds the ingest lock at a time (as core/reparse.ts LOCK_HOLD_MS); it checks the wake marker after each hold. */
const HOLD_MS = 1_000;
/** How long the pass leaves the ingest lock free between holds: an ingest waiting for it looks every 100 ms (core/lock.ts). */
const PAUSE_MS = 250;
/** Longest the pass keeps off the ingest lock for a background ingest it started to take it. */
const HANDOFF_MS = 10_000;

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
  /**
   * Runs `fn` over the stored sessions in order. The background ingest passes its short lock holds. Default: one after
   * another, in stretches of a second; when the store has no transactions, each stretch holds the ingest lock
   * repriceLock set (up to 5 s of waiting for it, 30 s when forced; busy longer, LockBusyError), with a pause between.
   */
  each?: (sessions: Session[], fn: (prev: Session) => Promise<void>) => Promise<void>;
  /**
   * With the default `each`: run between stretches while the ingest lock's wake marker is set (a hook or a read left
   * spool lines waiting): an ingest that takes the lock without waiting. Default: a background ingest started with the
   * kick repriceLock set, if any. Its errors are not the pass's: the marker stays for the next ingest.
   */
  onWake?: () => Promise<void>;
  /** True for a session the pass leaves out: the caller repriced it already, right before its fold (core/reparse.ts). */
  skip?: (id: string) => boolean;
  /** Sessions looked at so far, of all of them. Default: a line where a person waits, after 2 s (store/upgrade.ts repriceProgress). */
  onProgress?: (done: number, total: number) => void;
  /**
   * The lock file the pass holds: default the one repriceLock set for this store, if any. false: none,
   * for a caller that holds it already (core/reparse.ts). A forced pass waits up to 30 s for it; any
   * other pass tries once. Busy, the pass throws LockBusyError and leaves the cursor as it was. Where
   * no lock file can be made, a pass that is not forced does nothing and leaves the cursor; a forced one throws.
   */
  lock?: string | false;
}

/** The lock files a store's pass holds, by store, and how it starts a background ingest: set where the store is opened (store/factory.ts). */
const locks = new WeakMap<IndexStore, { pass: string; ingest: string | undefined; kick: (() => boolean) | undefined }>();

/**
 * Sets the lock files a pass on this store holds: `path`, the one the refold of its home holds for a whole
 * run (core/reparse.ts), and `ingest`, that home's ingest lock, held around each session's writes when the
 * store has no transactions. `kick` starts a background ingest of that home's spool (false: none started); a
 * pass with no onWake hands the spool to one when the lock's wake marker is set.
 */
export function repriceLock(index: IndexStore, path: string, ingest?: string, kick?: () => boolean): void {
  locks.set(index, { pass: path, ingest, kick });
}

/** No lock file can be made where the pass needs one (a read-only home). */
class NoLockError extends Error {
  constructor(path: string, cause: unknown) {
    super(`cannot make the lock file ${path} (${cause instanceof Error ? cause.message : String(cause)}); repricing runs only while it holds it, so it never runs beside a refold`);
    this.name = "NoLockError";
  }
}

/** Fills missing (or our own stale) cost estimates on stored events, once per price table. `force` reruns it. */
export async function repriceStored(index: IndexStore, overrides?: Prices, opts: RepriceOptions = {}): Promise<RepriceResult> {
  const none = { ran: false, events: 0, sessions: 0 };
  if (!index.setEventCosts) return none;
  const prices = pricesFor(overrides);
  const stamp = priceStamp(prices);
  if (!opts.force && (await index.getCursor(REPRICE_CURSOR)) === stamp) return none;
  const set = locks.get(index);
  const path = opts.lock === undefined ? set?.pass : opts.lock || undefined;
  let lock: Lock | undefined;
  try {
    lock = path ? await takeLock(path, opts.force ? 30_000 : 0) : undefined;
    // Another process may have run it while this one looked.
    if (lock && !opts.force && (await index.getCursor(REPRICE_CURSOR)) === stamp) return none;
    // A store without transactions: each session's writes under the ingest lock, so an ingest's store-and-fold falls before or after them.
    const held: { lock?: Lock } = {};
    const ingest = set?.ingest;
    const onWake = opts.onWake ?? (ingest && set?.kick ? handOff(ingest, set.kick) : undefined);
    const each = opts.each ?? sessionsUnder(ingest, !index.transaction, opts.force ? 30_000 : 5_000, held, onWake);
    const progress = opts.onProgress ?? repriceProgress();
    const all = (await index.listSessions({})).filter((s) => !opts.skip?.(s.id));
    let events = 0;
    let sessions = 0;
    let done = 0;
    await each(all, async (prev) => {
      const r = await repriceSession(index, prev, prices, true, () => held.lock?.assertHeld());
      events += r.events;
      if (r.changed) sessions++;
      progress(++done, all.length);
    });
    await index.setCursor(REPRICE_CURSOR, stamp);
    return { ran: true, events, sessions };
  } catch (err) {
    // Left for a run that can make the lock file: the sessions done so far stay done, and the cursor says the rest is due.
    if (err instanceof NoLockError && !opts.force) return none;
    throw err;
  } finally {
    lock?.release();
  }
}

/** The lock at `path`. Busy throws LockBusyError; where no lock file can be made, NoLockError. */
async function takeLock(path: string, waitMs: number): Promise<Lock> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return await acquireLock(path, { waitMs });
  } catch (err) {
    if ((err as Error).name === "LockBusyError") throw err;
    throw new NoLockError(path, err);
  }
}

/**
 * The pass's own `each`: the sessions in order, in stretches of HOLD_MS at most. With `hold` (a store without
 * transactions), each stretch holds the ingest lock at `ingest` when the spool exists (an ingest takes it only then),
 * and the lock stays free PAUSE_MS before the next, so an ingest waiting for it gets it. Between stretches, while the
 * lock's wake marker is set, `onWake` runs. `held` holds the lock while it is held.
 */
function sessionsUnder(ingest: string | undefined, hold: boolean, waitMs: number, held: { lock?: Lock }, onWake?: () => Promise<void>): NonNullable<RepriceOptions["each"]> {
  const marker = ingest && wakeMarker(ingest);
  return async (list, fn) => {
    let i = 0;
    while (i < list.length) {
      const lock = hold && ingest && existsSync(dirname(ingest)) ? await takeLock(ingest, waitMs) : undefined;
      held.lock = lock;
      const until = Date.now() + HOLD_MS;
      try {
        do await fn(list[i++]!);
        while (i < list.length && Date.now() < until);
      } finally {
        lock?.release();
        held.lock = undefined;
      }
      if (i >= list.length) break;
      // A hook or a read that found the lock held (or a read that found the pass running) left the spool to the pass.
      if (onWake && marker && existsSync(marker)) await onWake().catch(() => {});
      if (lock) await sleep(PAUSE_MS);
    }
  };
}

/**
 * An onWake that hands the spool to a background ingest: `kick` starts one, and the pass keeps off the ingest lock
 * until it holds the lock or the marker is gone (another ingest took it), HANDOFF_MS at most. When none starts, or
 * none takes the lock in time, the pass starts no more: the spool waits for the next ingest. While an ingest holds
 * the lock it starts none: that ingest runs again for the marker (core/ingest.ts), as the hook leaves it to it.
 */
function handOff(lockPath: string, kick: () => boolean): () => Promise<void> {
  const marker = wakeMarker(lockPath);
  let done = false;
  return async () => {
    if (done || isLocked(lockPath)) return;
    if (!kick()) {
      done = true;
      return;
    }
    const until = Date.now() + HANDOFF_MS;
    while (!isLocked(lockPath) && existsSync(marker)) {
      if (Date.now() >= until) {
        done = true;
        return;
      }
      await sleep(50);
    }
  };
}

/**
 * One session's events repriced and nothing else, for a caller that folds the session right after
 * (core/reparse.ts), so the fold counts the new costs. True when that fold is owed: a cost changed,
 * or the session was folded before its totals said which part is estimated.
 */
export async function repriceEvents(index: IndexStore, prev: Session, prices: Prices): Promise<boolean> {
  return (await repriceSession(index, prev, prices, false)).changed;
}

/**
 * One session's pass: its events' new costs, then, with `totals`, its totals; nothing when nothing is due.
 * `guard` runs before each write (the ingest lock's assertHeld, which throws once the lock is lost).
 */
async function repriceSession(index: IndexStore, listed: Session, prices: Prices, totals: boolean, guard: () => void = () => {}): Promise<{ events: number; changed: boolean }> {
  const unchanged = { events: 0, changed: false };
  if (!(await dueCosts(index, listed, prices, totals))) return unchanged;
  // Read again right before the writes, in one transaction with them where the store has transactions: a gateway
  // companion stored since the read above (`coding.sh gateway enrich`, another process) is seen, so the call it bills
  // gets no estimate on top of the companion's correction. With `totals` the row is read again too: costs and a row
  // another process wrote since count, and a session deleted since stays deleted.
  return inTransaction(index, async () => {
    const cur = totals ? await index.getSession(listed.id) : listed;
    if (!cur) return unchanged;
    const costs = await dueCosts(index, cur, prices, totals);
    if (!costs) return unchanged;
    guard();
    const events = costs.length ? await index.setEventCosts!(costs) : 0;
    if (totals) {
      guard();
      // In a transaction the row and events read under its write lock are the ones to fold; without one, read them again.
      if (index.transaction) await index.upsertSession(withUsage(cur, buildSession(await index.listEvents(cur.id), cur)));
      else await refreshTotals(index, cur.id);
    }
    return { events, changed: true };
  });
}

const inTransaction = <T>(index: IndexStore, fn: () => Promise<T>): Promise<T> => (index.transaction ? index.transaction(fn) : fn());

/**
 * The new costs of a session's events: estimates added, changed, or removed where no price backs one now. Undefined when
 * nothing is due: no cost changes, and the row's totals already say which part is estimated and, on a store without
 * transactions, still match the events (a pass stopped between a session's costs and its totals left them behind).
 */
async function dueCosts(index: IndexStore, prev: Session, prices: Prices, totals: boolean): Promise<EventCost[] | undefined> {
  const stored = await index.listEvents(prev.id, { kinds: KINDS });
  const enriched = new Set(stored.map(billedCallOf).filter((id) => id !== undefined));
  const costs: EventCost[] = [];
  let estimates = false;
  for (const e of stored) {
    if (enriched.has(e.id)) continue;
    const ours = e.payload?.costEstimated === true;
    const priced = priceEvent(ours ? withoutCost(e) : e, prices);
    const cost = priced.usage?.costUsd;
    // Our estimate, and no price makes one now (the model left the table, an override was removed): it goes.
    if (ours && typeof cost !== "number") {
      costs.push({ id: e.id, clear: true });
      continue;
    }
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
  // Sessions folded before session totals said which part is estimated are refolded once.
  if (costs.length || (estimates && prev.stats.usage?.estimatedCostUsd === undefined)) return costs;
  const marked = estimates || prev.stats.usage?.estimatedCostUsd !== undefined;
  if (totals && !index.transaction && marked && !sameTotals(prev, buildSession(await index.listEvents(prev.id), prev))) return costs;
  return undefined;
}

/**
 * Folds a session's priced totals again from its stored events, keeping the rest of the stored
 * session (links, repo state). Reads the row and the events together where the store can (one
 * transaction, or rebuildSession's lock), so totals written meanwhile are not undone; a session
 * that is gone stays gone.
 */
export async function refreshTotals(index: IndexStore, id: string): Promise<void> {
  const build = (cur: Session | undefined, events: AgentEvent[]) => (cur ? withUsage(cur, buildSession(events, cur)) : undefined);
  if (index.rebuildSession) {
    await index.rebuildSession(id, build);
    return;
  }
  const write = async () => {
    const next = build(await index.getSession(id), await index.listEvents(id));
    if (next) await index.upsertSession(next);
  };
  await (index.transaction ? index.transaction(write) : write());
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

/** Whether the stored row's priced totals are the ones `rebuilt` folded from its events (compared as stored: JSON). */
function sameTotals(row: Session, rebuilt: Session): boolean {
  const priced = (s: Session) => JSON.parse(JSON.stringify({ u: s.stats.usage ?? null, d: s.stats.duplicateUsage ?? null, c: s.stats.cacheBreaks ?? null })) as unknown;
  return isDeepStrictEqual(priced(row), priced(rebuilt));
}

/** The stored session with only its priced totals refolded (links, repo state and the rest stay). */
function withUsage(prev: Session, rebuilt: Session): Session {
  const { usage: _u, duplicateUsage: _d, cacheBreaks: _c, ...stats } = prev.stats;
  const { usage, duplicateUsage, cacheBreaks } = rebuilt.stats;
  return { ...prev, stats: { ...stats, ...(usage ? { usage } : {}), ...(duplicateUsage ? { duplicateUsage } : {}), ...(cacheBreaks ? { cacheBreaks } : {}) } };
}
