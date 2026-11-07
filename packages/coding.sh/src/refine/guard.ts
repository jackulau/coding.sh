// Keep rule K8 (AB-3): a later candidate may not undo an earlier kept edit.
// Sequential harness edits forget earlier gains (arXiv 2611.03219: 94 → 32 on
// SWE after 5 rounds; its eq. 3 asks each new harness to hold every earlier
// stage). A random held-out pool rarely holds the tasks that justified the last
// keep, so those tasks become a guard set:
//
//   guardTasks   the dev tasks a kept candidate turned from fail to pass
//   guardSet     their union over kept, not rolled back entries, newest first,
//                minus this finding's dev and held-out tasks, capped
//   checkGuard   K8: the candidate must not be 'dont-ship' on the guard set under
//                the acceptance gate ('hold' passes); a failure names the kept
//                entries whose tasks went from pass to fail
//
// Pure: the ledger that stores guardTasks and the trial stage that runs the
// guard set are R2-8.
import { gateVerdict, type GateVerdict } from "../stats/gate.ts";
import { acceptanceGatePaired, type GateOpts, type GateResult } from "../stats/tests.ts";
import type { Outcomes } from "./keep.ts";

/** Per-task majority, as compare scores a task: a pass rate of at least 0.5 counts as solved. */
const solved = (xs: readonly boolean[] | undefined): boolean | undefined => (xs?.length ? xs.filter(Boolean).length / xs.length >= 0.5 : undefined);

/** The dev tasks the candidate won: unsolved by the base, solved by the candidate (per-task majority). Sorted. */
export function guardTasks(dev: { base: Outcomes; cand: Outcomes }): string[] {
  const out: string[] = [];
  for (const [id, a] of dev.base) if (solved(a) === false && solved(dev.cand.get(id)) === true) out.push(id);
  return out.sort();
}

/** A ledger entry as the guard set reads it. */
export interface GuardEntry {
  id: string;
  /** When it was applied (ISO 8601 or epoch ms): newer entries fill the cap first. */
  at: string | number;
  status: string;
  /** Set when the entry was rolled back: its tasks no longer guard anything. */
  rolledBack?: boolean;
  guardTasks?: readonly string[];
}

export interface GuardSet {
  /** Task ids, newest entry's first. */
  tasks: string[];
  /** Task id → the kept entries that won it. */
  from: Map<string, string[]>;
  /** Tasks left out by the cap. */
  dropped: number;
  /** "guard set capped at 24 of 31 tasks (newest kept edits first)" when capped. */
  note?: string;
}

const time = (at: string | number): number => (typeof at === "number" ? at : Date.parse(at));

/**
 * The guard set for a new candidate: guard tasks of every kept (or applied),
 * not rolled back entry, newest entry first, without the finding's own dev and
 * held-out tasks (`exclude`), capped at `maxGuard` (default 24).
 */
export function guardSet(entries: readonly GuardEntry[], opts: { exclude?: Iterable<string>; maxGuard?: number } = {}): GuardSet {
  const max = opts.maxGuard ?? 24;
  if (!(Number.isInteger(max) && max >= 0)) throw new RangeError(`guardSet: maxGuard must be a non-negative integer (got ${max})`);
  const exclude = new Set(opts.exclude ?? []);
  const live = entries.filter((e) => (e.status === "kept" || e.status === "applied") && !e.rolledBack && e.guardTasks?.length);
  live.sort((a, b) => time(b.at) - time(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const from = new Map<string, string[]>();
  const all: string[] = [];
  for (const e of live) {
    for (const t of e.guardTasks!) {
      if (exclude.has(t)) continue;
      const ids = from.get(t);
      if (ids) {
        if (!ids.includes(e.id)) ids.push(e.id);
        continue;
      }
      from.set(t, [e.id]);
      all.push(t);
    }
  }
  const tasks = all.slice(0, max);
  for (const t of all.slice(max)) from.delete(t);
  const dropped = all.length - tasks.length;
  return { tasks, from, dropped, ...(dropped ? { note: `guard set capped at ${max} of ${all.length} tasks (newest kept edits first)` } : {}) };
}

export interface GuardCheck {
  /** K8 passes: anything but 'dont-ship' on the guard set (an empty set passes). */
  ok: boolean;
  verdict: GateVerdict;
  gate?: GateResult;
  /** Guard tasks that went from solved to unsolved, and the kept entries they came from. */
  forgotten: { task: string; entries: string[] }[];
  /** Kept entries the candidate forgets, most tasks lost first. */
  forgets: string[];
  /** `forgets kept edit <id>[, <id>]` on a failure. */
  reason?: string;
}

/**
 * K8 on the guard set: per-task majority outcomes of base (the incumbent, with
 * the kept edits applied) and candidate go through the acceptance gate. Only a
 * 'dont-ship' rejects; 'hold' (not enough evidence either way) passes. Tasks
 * missing from either arm are skipped.
 */
export function checkGuard(guard: GuardSet, runs: { base: Outcomes; cand: Outcomes }, gate: GateOpts = {}): GuardCheck {
  const base: boolean[] = [];
  const cand: boolean[] = [];
  const forgotten: { task: string; entries: string[] }[] = [];
  for (const t of guard.tasks) {
    const a = solved(runs.base.get(t));
    const b = solved(runs.cand.get(t));
    if (a === undefined || b === undefined) continue;
    base.push(a);
    cand.push(b);
    if (a && !b) forgotten.push({ task: t, entries: guard.from.get(t) ?? [] });
  }
  if (!base.length) return { ok: true, verdict: "hold", forgotten: [], forgets: [] };
  const g = acceptanceGatePaired(base, cand, gate);
  const verdict = gateVerdict(g);
  const lost = new Map<string, number>();
  for (const f of forgotten) for (const e of f.entries) lost.set(e, (lost.get(e) ?? 0) + 1);
  const forgets = [...lost].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([e]) => e);
  const ok = verdict !== "dont-ship";
  return { ok, verdict, gate: g, forgotten, forgets, ...(ok ? {} : { reason: `forgets kept edit ${forgets.join(", ")}` }) };
}
