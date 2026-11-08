// Iterating on a harness comparison without paying for it all again (X-25,
// after promptfoo's `eval --retry-errors`, `--filter-failing` and
// `--filter-sample`): run again only the runs of a stored comparison that
// errored, run only the tasks an arm failed before, or run a seeded sample
// of the tasks.
//
// A slot is one (task, bundle, attempt). A comparison counts one run per
// slot: when a slot holds several runs that count, the newest wins and the
// others are left out, so a retried slot is never counted twice.
import type { EvalTask, RunResult } from "../core/types.ts";
import { mulberry32 } from "../stats/prng.ts";

/** The slot a run fills: task, bundle and attempt. */
export const slotKey = (r: Pick<RunResult, "taskId" | "bundleId" | "attempt">): string => `${r.taskId}\u0000${r.bundleId}\u0000${r.attempt}`;

/** A run a comparison counts: finished, not replaced by a retry, not lost to infrastructure. */
const counts = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;

/**
 * One run per slot: the newest counting run of each slot, in input order.
 * `dropped` are the older counting runs of slots that held more than one;
 * every other run passes through unchanged (the report leaves out the ones
 * that don't count).
 */
export function latestPerSlot(runs: readonly RunResult[]): { runs: RunResult[]; dropped: RunResult[] } {
  const newest = new Map<string, RunResult>();
  for (const r of runs) {
    if (!counts(r)) continue;
    const k = slotKey(r);
    const have = newest.get(k);
    if (!have || r.endedAt > have.endedAt || (r.endedAt === have.endedAt && r.id > have.id)) newest.set(k, r);
  }
  const dropped: RunResult[] = [];
  const kept = runs.filter((r) => {
    if (!counts(r) || newest.get(slotKey(r)) === r) return true;
    dropped.push(r);
    return false;
  });
  return { runs: kept, dropped };
}

/**
 * The runs `--retry-errors` runs again: per slot, the run that counts or would
 * have counted ended in an error (the agent or verifier could not run) or an
 * infrastructure failure after its retries. A slot that also holds a good run
 * is not retried. Cancelled runs are left to `--resume`.
 */
export function erroredRuns(runs: readonly RunResult[]): RunResult[] {
  const good = new Set(runs.filter((r) => counts(r) && r.error === undefined).map(slotKey));
  const out = new Map<string, RunResult>();
  for (const r of runs) {
    if (r.cancelled || r.superseded || good.has(slotKey(r))) continue;
    if (r.error === undefined && !r.infra) continue;
    const have = out.get(slotKey(r));
    if (!have || r.endedAt > have.endedAt) out.set(slotKey(r), r);
  }
  return [...out.values()];
}

/** How `--failing` reads a task with several attempts: failed in any of them, or in more than half. */
export type FailingMode = "any" | "majority";

/**
 * The ids of the tasks `bundleId` failed in `runs` (one stored comparison),
 * in first-seen order. Only runs that count are read; a task with none is
 * not selected, since whether it failed is unknown.
 */
export function selectFailing(runs: readonly RunResult[], bundleId: string, mode: FailingMode = "any"): string[] {
  const per = new Map<string, { n: number; failed: number }>();
  for (const r of latestPerSlot(runs).runs) {
    if (r.bundleId !== bundleId || !counts(r)) continue;
    const s = per.get(r.taskId) ?? { n: 0, failed: 0 };
    s.n++;
    if (!r.pass) s.failed++;
    per.set(r.taskId, s);
  }
  return [...per].filter(([, s]) => (mode === "any" ? s.failed > 0 : s.failed * 2 > s.n)).map(([id]) => id);
}

/**
 * `n` tasks drawn without replacement with a seeded shuffle (mulberry32,
 * Fisher-Yates), returned in their input order. The same tasks, n and seed
 * always give the same sample; n at or above the count returns them all.
 */
export function sampleTasks<T>(tasks: readonly T[], n: number, seed: number): T[] {
  if (n >= tasks.length) return [...tasks];
  const rand = mulberry32(seed);
  const idx = tasks.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
  }
  const pick = new Set(idx.slice(0, n));
  return tasks.filter((_, i) => pick.has(i));
}

/** How the tasks of a comparison were picked, for the report and `--json`. */
export interface Selection {
  /** Tasks before selection. */
  from: number;
  /** Tasks run. */
  tasks: number;
  failing?: { experimentId: string; bundleId: string; bundle: string; mode: FailingMode; matched: number };
  sample?: { n: number; seed: number };
  note: string;
}

/** The selection block and its note. `failing` before `sample`, as the CLI applies them. */
export function describeSelection(o: { from: number; tasks: readonly EvalTask[]; failing?: Selection["failing"]; sample?: Selection["sample"] }): Selection {
  const tasks = o.tasks.length;
  const parts: string[] = [];
  if (o.failing) parts.push(`the ${o.failing.matched} task${o.failing.matched === 1 ? "" : "s"} ${o.failing.bundle} failed in ${o.failing.experimentId}${o.failing.mode === "majority" ? " (in most attempts)" : ""}`);
  if (o.sample) parts.push(`a sample of ${tasks} (seed ${o.sample.seed})`);
  let note = `selection: ${tasks} of ${o.from} task${o.from === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", then ")}` : ""}.`;
  if (o.failing) note += ` The B − A difference holds for these tasks; both pass rates are conditioned on ${o.failing.bundle} having failed them, so they are not the arms' rates on the full set.`;
  else if (o.sample) note += " Pass rates are estimates for the full set; the sample adds sampling error.";
  return { from: o.from, tasks, ...(o.failing ? { failing: o.failing } : {}), ...(o.sample ? { sample: o.sample } : {}), note };
}
