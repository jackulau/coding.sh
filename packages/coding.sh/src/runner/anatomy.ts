// Failure anatomy for a harness compare (arXiv 2611.08285, "Hard Issue, Weak
// Model, or Bad Run?"): why each arm's failed runs failed, and how much of the
// outcome variance sits in the task, the arm and run-to-run noise.
import type { RunResult } from "../core/types.ts";
import { mean } from "../stats/summary.ts";

export interface ArmAnatomy {
  /** Failed runs on paired tasks. badRun + beyondArm + unsolvedByAll + infra = fails. */
  fails: number;
  /** The same arm passed this task in another attempt: a retry can rescue it. */
  badRun: number;
  /** This arm never passed the task; the other arm did. */
  beyondArm: number;
  /** Neither arm ever passed the task. */
  unsolvedByAll: number;
  /** Setup or harness failures (0 until runs carry an infra classification). */
  infra: number;
  tasks: { badRun: string[]; beyondArm: string[]; unsolvedByAll: string[] };
}

export interface VarianceShares {
  /** Share of the outcome sum of squares between tasks. */
  task: number;
  /** Between arms within a task. */
  arm: number;
  /** Between attempts within a (task, arm): run-to-run noise. */
  run: number;
  /** Runs counted. */
  n: number;
}

function armAnatomy(own: Map<string, RunResult[]>, other: Map<string, RunResult[]>, paired: readonly string[]): ArmAnatomy {
  const a: ArmAnatomy = { fails: 0, badRun: 0, beyondArm: 0, unsolvedByAll: 0, infra: 0, tasks: { badRun: [], beyondArm: [], unsolvedByAll: [] } };
  for (const id of [...new Set(paired)].sort()) {
    const rs = own.get(id) ?? [];
    const failed = rs.filter((r) => !r.pass).length;
    if (!failed) continue;
    a.fails += failed;
    const kind = rs.some((r) => r.pass) ? "badRun" : (other.get(id) ?? []).some((r) => r.pass) ? "beyondArm" : "unsolvedByAll";
    a[kind] += failed;
    a.tasks[kind].push(id);
  }
  return a;
}

/** Each arm's failed runs on paired tasks, split by cause. */
export function failureAnatomy(ta: Map<string, RunResult[]>, tb: Map<string, RunResult[]>, paired: readonly string[]): { baseline: ArmAnatomy; candidate: ArmAnatomy } {
  return { baseline: armAnatomy(ta, tb, paired), candidate: armAnatomy(tb, ta, paired) };
}

/**
 * Exact nested ANOVA over outcomes y: SS_total = SS_group + SS_sub|group +
 * SS_within, returned as shares of SS_total. NaN shares when every y is equal.
 */
export function nestedVarianceShares(cells: readonly { group: string; sub: string; y: number }[]): VarianceShares {
  const n = cells.length;
  if (!n) return { task: NaN, arm: NaN, run: NaN, n };
  const grand = mean(cells.map((c) => c.y));
  const groups = new Map<string, Map<string, number[]>>();
  for (const c of cells) {
    let g = groups.get(c.group);
    if (!g) groups.set(c.group, (g = new Map()));
    const ys = g.get(c.sub);
    if (ys) ys.push(c.y);
    else g.set(c.sub, [c.y]);
  }
  let ssGroup = 0;
  let ssSub = 0;
  let ssWithin = 0;
  for (const g of groups.values()) {
    const all = [...g.values()].flat();
    const mg = mean(all);
    ssGroup += all.length * (mg - grand) ** 2;
    for (const ys of g.values()) {
      const ms = mean(ys);
      ssSub += ys.length * (ms - mg) ** 2;
      for (const y of ys) ssWithin += (y - ms) ** 2;
    }
  }
  const total = ssGroup + ssSub + ssWithin;
  if (!(total > 1e-15)) return { task: NaN, arm: NaN, run: NaN, n };
  return { task: ssGroup / total, arm: ssSub / total, run: ssWithin / total, n };
}
