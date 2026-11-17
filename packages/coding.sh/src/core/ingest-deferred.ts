// Git work an ingest left for a later one. A budgeted read (a deadline) takes no
// end-of-turn shadow snapshot and, once past its deadline, resolves no session's
// start repo state: on a big repo each git call can take seconds, and one ingest
// can end hundreds of sessions. A stopped run (Ctrl-C, the viewer closing) does
// the same from the stop on. What it skipped is kept here, in one kv entry, and
// the next ingest without a deadline does it (core/ingest.ts): it takes the
// snapshots that are still fresh (END_SNAPSHOT_MAX_AGE_MS) and folds the
// sessions again to resolve their repo. Entries are removed once handled, so
// one that dies on the way is handled by the run after.
//
// Without kv (a store plugin that has none), nothing is deferred: the git work
// runs in the ingest as before.
import type { IndexStore } from "./types.ts";

export const DEFERRED_KEY = "ingest:deferred";
/** Most entries kept per kind: a run that never gets to them must not grow the row without end. */
const MAX_ENTRIES = 5000;

export interface DeferredWork {
  /** Session id → the end of turn (ms epoch) whose snapshot was not taken. */
  snapshots: Record<string, number>;
  /** Sessions folded without their start repo state. */
  repos: string[];
}

export const canDefer = (index: IndexStore): boolean => !!(index.kvGet && index.kvSet);

function parse(raw: string | undefined): DeferredWork {
  const out: DeferredWork = { snapshots: {}, repos: [] };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<DeferredWork>;
    if (v.snapshots && typeof v.snapshots === "object") for (const [id, ts] of Object.entries(v.snapshots)) if (typeof ts === "number") out.snapshots[id] = ts;
    if (Array.isArray(v.repos)) out.repos = v.repos.filter((id): id is string => typeof id === "string");
  } catch {
    // a torn entry: the work it named is lost, as before this existed
  }
  return out;
}

const tx = <T>(index: IndexStore, fn: () => Promise<T>): Promise<T> => (index.transaction ? index.transaction(fn) : fn());

/** The work waiting, or undefined when the store keeps none (no kv). */
export async function readDeferred(index: IndexStore): Promise<DeferredWork | undefined> {
  if (!canDefer(index)) return undefined;
  return parse(await index.kvGet!(DEFERRED_KEY));
}

/** True when an ingest left git work for a later one. */
export async function hasDeferred(index: IndexStore): Promise<boolean> {
  const w = await readDeferred(index).catch(() => undefined);
  return !!w && (w.repos.length > 0 || Object.keys(w.snapshots).length > 0);
}

/** Adds work for a later ingest. False (nothing kept) when the store has no kv. */
export async function addDeferred(index: IndexStore, add: { snapshots?: Iterable<[string, number]>; repos?: Iterable<string> }): Promise<boolean> {
  if (!canDefer(index)) return false;
  await tx(index, async () => {
    const w = parse(await index.kvGet!(DEFERRED_KEY));
    for (const [id, ts] of add.snapshots ?? []) w.snapshots[id] = Math.max(ts, w.snapshots[id] ?? -Infinity);
    const repos = new Set(w.repos);
    for (const id of add.repos ?? []) repos.add(id);
    const snaps = Object.entries(w.snapshots).sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
    await index.kvSet!(DEFERRED_KEY, JSON.stringify({ snapshots: Object.fromEntries(snaps), repos: [...repos].slice(-MAX_ENTRIES) }));
  });
  return true;
}

/** Removes handled work (whatever came of it): a snapshot entry only when no later end of turn replaced it meanwhile. */
export async function settleDeferred(index: IndexStore, done: { snapshots?: Iterable<[string, number]>; repos?: Iterable<string> }): Promise<void> {
  if (!canDefer(index)) return;
  await tx(index, async () => {
    const w = parse(await index.kvGet!(DEFERRED_KEY));
    for (const [id, ts] of done.snapshots ?? []) if ((w.snapshots[id] ?? Infinity) <= ts) delete w.snapshots[id];
    const gone = new Set(done.repos ?? []);
    w.repos = w.repos.filter((id) => !gone.has(id));
    await index.kvSet!(DEFERRED_KEY, w.repos.length || Object.keys(w.snapshots).length ? JSON.stringify(w) : undefined);
  });
}
