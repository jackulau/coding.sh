// Task picker and dollar budget for `compare` (X-15, after DeltaSelect,
// arXiv 2609.19607). Most suite tasks say little about which harness is
// better: only 22 of 113 had a reliability q >= 0.5 there. So:
//
// - rankTasks: per task, q is the 5th percentile, over resampled draws (one
//   stored run per config), of the Pearson correlation between that task's
//   outcome and each config's leave-one-out suite score. Tiers: ranked (seen
//   under >= minConfigs configs with both outcomes; by q) → mixed (by p(1−p))
//   → unseen → saturated (every run passed).
// - estimateTaskCost: a run's cost from, in order, the baseline's runs of the
//   task, any runs of it, its source session, the median over the other
//   tasks, then --cost-per-run. TaskCostUnknown when none is known.
// - fitBudget: greedy in rank order over arms·k·cost, skipping a task that
//   doesn't fit and scanning on.
//
// DeltaSelect's OLS calibration and weighting are left out: they are fitted
// in-sample and need 5+ configurations.
import type { EvalTask, RunResult } from "../core/types.ts";
import { mulberry32 } from "../stats/prng.ts";

export type TaskTier = "ranked" | "mixed" | "unseen" | "saturated";

export interface RankedTask {
  taskId: string;
  tier: TaskTier;
  /** Ranked tier: 5th percentile of the resampled outcome–suite correlation. */
  q?: number;
  /** Pass rate over every counted stored run of the task (NaN when unseen). */
  p: number;
  /** Configs (bundles) with a counted run of the task. */
  configs: number;
  runs: number;
}

export interface RankOpts {
  /** Configs a task needs for a q. Default 3. */
  minConfigs?: number;
  /** Resampled draws per task. Default 400. */
  draws?: number;
  seed?: number;
}

/** Runs that say something about a task: finished, not superseded, not lost to infrastructure. */
const counted = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;

/** Pearson correlation; NaN when either side has no spread. */
export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2 || y.length !== n) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** The p-quantile (0..1) of sorted values, by linear interpolation. */
function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (h - lo);
}

/** Order tasks by how well they tell configs apart, from stored runs of any bundles. */
export function rankTasks(taskIds: readonly string[], runs: readonly RunResult[], o: RankOpts = {}): RankedTask[] {
  const minConfigs = o.minConfigs ?? 3;
  const draws = o.draws ?? 400;
  const rand = mulberry32(o.seed ?? 0x5e1ec7);
  // config → task → outcomes
  const grid = new Map<string, Map<string, boolean[]>>();
  for (const r of runs) {
    if (!counted(r)) continue;
    let m = grid.get(r.bundleId);
    if (!m) grid.set(r.bundleId, (m = new Map()));
    m.set(r.taskId, [...(m.get(r.taskId) ?? []), r.pass]);
  }
  const rateOf = (xs: readonly boolean[]) => xs.filter(Boolean).length / xs.length;
  const out: RankedTask[] = [];
  for (const t of taskIds) {
    const cfgs = [...grid.entries()].filter(([, m]) => m.get(t)?.length);
    const all = cfgs.flatMap(([, m]) => m.get(t) ?? []);
    const base = { taskId: t, configs: cfgs.length, runs: all.length, p: all.length ? rateOf(all) : NaN };
    if (!all.length) {
      out.push({ ...base, tier: "unseen" });
      continue;
    }
    if (all.every(Boolean)) {
      out.push({ ...base, tier: "saturated" });
      continue;
    }
    // Leave-one-out suite score per config: its mean pass rate over the other tasks it ran.
    const scored = cfgs
      .map(([, m]) => {
        const others = [...m.entries()].filter(([id, xs]) => id !== t && xs.length);
        return { outcomes: m.get(t) as boolean[], score: others.length ? others.reduce((a, [, xs]) => a + rateOf(xs), 0) / others.length : NaN };
      })
      .filter((c) => Number.isFinite(c.score));
    if (scored.length < minConfigs || all.every((x) => !x)) {
      out.push({ ...base, tier: "mixed" });
      continue;
    }
    const scores = scored.map((c) => c.score);
    const rs: number[] = [];
    for (let d = 0; d < draws; d++) {
      const y = scored.map((c) => (c.outcomes[Math.floor(rand() * c.outcomes.length)] ? 1 : 0));
      const r = pearson(y, scores);
      // A draw where every config passed (or failed) separates nothing.
      rs.push(Number.isFinite(r) ? r : 0);
    }
    rs.sort((a, b) => a - b);
    out.push({ ...base, tier: "ranked", q: quantile(rs, 0.05) });
  }
  const tierOrder: Record<TaskTier, number> = { ranked: 0, mixed: 1, unseen: 2, saturated: 3 };
  const pq = (x: RankedTask) => x.p * (1 - x.p);
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => tierOrder[a.x.tier] - tierOrder[b.x.tier] || (a.x.tier === "ranked" ? (b.x.q as number) - (a.x.q as number) : a.x.tier === "mixed" ? pq(b.x) - pq(a.x) : 0) || a.i - b.i)
    .map(({ x }) => x);
}

export type CostSource = "baseline" | "runs" | "session" | "pool" | "flag";

/** Where a cost comes from, first to last. */
export const COST_SOURCES: readonly CostSource[] = ["baseline", "runs", "session", "pool", "flag"];

export interface TaskCost {
  taskId: string;
  /** Estimated agent cost of one run, USD. */
  usd: number;
  source: CostSource;
}

export class TaskCostUnknown extends Error {
  readonly taskIds: string[];
  constructor(taskIds: string[]) {
    super(`no cost known for ${taskIds.length === 1 ? `task ${taskIds[0]}` : `${taskIds.length} tasks (${taskIds.slice(0, 3).join(", ")}${taskIds.length > 3 ? ", …" : ""})`}`);
    this.name = "TaskCostUnknown";
    this.taskIds = taskIds;
  }
}

export interface CostOpts {
  /** The baseline bundle: its runs of a task are the first source. */
  baselineId?: string;
  /** A task's source session cost (session.stats.usage.costUsd), when it has one. */
  sessionCost?: (task: EvalTask) => number | undefined;
  /** --cost-per-run: the last fallback. */
  flag?: number;
}

const runCost = (r: RunResult): number | undefined => {
  const c = r.agent.usage?.costUsd;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : undefined;
};

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * Per-run cost of each task, from the first source that knows it. Throws
 * TaskCostUnknown, naming the tasks, when some task has no source at all.
 */
export function estimateTaskCosts(tasks: readonly EvalTask[], runs: readonly RunResult[], o: CostOpts = {}): Map<string, TaskCost> {
  const out = new Map<string, TaskCost>();
  const priced = runs.filter((r) => counted(r) && !r.reusedFrom && runCost(r) !== undefined);
  for (const t of tasks) {
    const mine = priced.filter((r) => r.taskId === t.id);
    const fromBase = o.baselineId ? mine.filter((r) => r.bundleId === o.baselineId).map((r) => runCost(r) as number) : [];
    if (fromBase.length) {
      out.set(t.id, { taskId: t.id, usd: mean(fromBase), source: "baseline" });
      continue;
    }
    if (mine.length) {
      out.set(t.id, { taskId: t.id, usd: mean(mine.map((r) => runCost(r) as number)), source: "runs" });
      continue;
    }
    const s = o.sessionCost?.(t);
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) out.set(t.id, { taskId: t.id, usd: s, source: "session" });
  }
  const known = [...out.values()].map((c) => c.usd);
  const missing = tasks.filter((t) => !out.has(t.id));
  for (const t of missing) {
    if (known.length) out.set(t.id, { taskId: t.id, usd: median(known), source: "pool" });
    else if (o.flag !== undefined && Number.isFinite(o.flag) && o.flag >= 0) out.set(t.id, { taskId: t.id, usd: o.flag, source: "flag" });
  }
  const unknown = tasks.filter((t) => !out.has(t.id)).map((t) => t.id);
  if (unknown.length) throw new TaskCostUnknown(unknown);
  return out;
}

export interface BudgetFit {
  /** Picked task ids, in rank order. */
  picked: string[];
  /** Tasks passed over because they no longer fit. */
  skipped: string[];
  /** Estimated spend of the picked tasks: arms × k × cost each. */
  usd: number;
}

/** Greedy in rank order: take a task when arms·k·cost still fits, else skip it and keep scanning. */
export function fitBudget(order: readonly string[], costs: ReadonlyMap<string, TaskCost>, o: { budget: number; arms?: number; k?: number }): BudgetFit {
  const times = (o.arms ?? 2) * (o.k ?? 1);
  const out: BudgetFit = { picked: [], skipped: [], usd: 0 };
  // Cents, so 0.1 + 0.2 fits a 0.3 budget.
  const cents = (x: number) => Math.round(x * 1e6);
  for (const id of order) {
    const c = costs.get(id);
    if (!c) continue;
    const add = times * c.usd;
    if (cents(out.usd + add) <= cents(o.budget)) {
      out.picked.push(id);
      out.usd += add;
    } else out.skipped.push(id);
  }
  return out;
}
