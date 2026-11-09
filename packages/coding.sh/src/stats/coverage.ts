// Group coverage (AE-6): a partial run's verdict is only trustworthy once every
// task group (repo, difficulty, domain) is proportionally represented.
//
// "How Many Tasks Are Enough…" (arXiv 2607.12338): a coverage-aware policy defers
// a verdict until each group g of size n_g holds at least
//   r_g(b) = max(1, min(n_g, floor(k_b · n_g / N))),  k_b = ceil(b · N)
// of the first k_b revealed tasks. balancedOrder reveals tasks so that every
// prefix meets those minima whenever they can be met at all.
import { mulberry32 } from "./prng.ts";

export interface CoverageOpts {
  /** COVERAGE_SLACK: one fewer task per group (floor(k_b·n_g/N) − 1), still at least 1. */
  slack?: boolean;
}

export interface GroupRequirement {
  /** Total tasks over all groups. */
  N: number;
  /** Tasks revealed at budget b: ceil(b · N). */
  k: number;
  /** Minimum tasks per group. A group of size 0 needs 0. */
  required: Record<string, number>;
}

function checkBudget(b: number): void {
  if (!(b > 0 && b <= 1)) throw new RangeError(`coverage: budget b must be in (0, 1], got ${b}`);
}

function checkSizes(groupSizes: Readonly<Record<string, number>>): number {
  let N = 0;
  for (const [g, n] of Object.entries(groupSizes)) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`coverage: group ${JSON.stringify(g)} has size ${n}; sizes are whole numbers ≥ 0`);
    N += n;
  }
  return N;
}

/** ceil(b · N), tolerant of float noise (0.15 · 100 is 15, not 16). */
export function budgetTasks(b: number, N: number): number {
  checkBudget(b);
  return Math.min(N, Math.ceil(b * N - 1e-9));
}

function required(n: number, k: number, N: number, slack: boolean): number {
  if (n === 0) return 0;
  return Math.max(1, Math.min(n, Math.floor((k * n) / N) - (slack ? 1 : 0)));
}

/** r_g(b) for every group at budget b. */
export function requiredPerGroup(groupSizes: Readonly<Record<string, number>>, b: number, o: CoverageOpts = {}): GroupRequirement {
  const N = checkSizes(groupSizes);
  const k = budgetTasks(b, N);
  const out: Record<string, number> = {};
  for (const [g, n] of Object.entries(groupSizes)) out[g] = required(n, k, N, !!o.slack);
  return { N, k, required: out };
}

/** Whether the minima fit in the budget: Σ r_g(b) ≤ k_b. */
export function coverageFeasible(groupSizes: Readonly<Record<string, number>>, b: number, o: CoverageOpts = {}): boolean {
  const { k, required: r } = requiredPerGroup(groupSizes, b, o);
  let s = 0;
  for (const v of Object.values(r)) s += v;
  return s <= k;
}

/** Whether a subset meets every group's minimum at budget b (a group missing from the subset counts 0). */
export function isCovered(subsetGroupCounts: Readonly<Record<string, number>>, groupSizes: Readonly<Record<string, number>>, b: number, o: CoverageOpts = {}): boolean {
  const { required: r } = requiredPerGroup(groupSizes, b, o);
  for (const [g, need] of Object.entries(r)) if ((subsetGroupCounts[g] ?? 0) < need) return false;
  return true;
}

/** Group sizes from per-task labels; a missing or empty label is the one ungrouped group "". */
export function groupSizesOf(labels: readonly (string | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of labels) out[l ?? ""] = (out[l ?? ""] ?? 0) + 1;
  return out;
}

/**
 * A reveal order (a permutation of task indexes) whose every prefix of length L
 * covers each group's minimum whenever Σ_g r_g ≤ L. Each group's tasks are
 * shuffled with a seeded mulberry32; the c-th task of group g is due at the first
 * prefix length that needs c of g (1 for its first task, ceil(c · N / n_g) after),
 * and tasks go out in order of due length, ties by the exact proportional time
 * c · N / n_g, then by group size (largest first), then by group name. Sorting by
 * due length is earliest-deadline-first, so the tasks due by L always fill the
 * first Σ_g r_g(L) positions. Deterministic given the seed.
 */
export function balancedOrder(labels: readonly (string | undefined)[], seed = 1): number[] {
  const N = labels.length;
  const groups = new Map<string, number[]>();
  labels.forEach((l, i) => {
    const g = l ?? "";
    const xs = groups.get(g);
    if (xs) xs.push(i);
    else groups.set(g, [i]);
  });
  const rand = mulberry32(seed);
  const names = [...groups.keys()].sort();
  const slots: { idx: number; due: number; time: number; size: number; name: string }[] = [];
  for (const name of names) {
    const xs = groups.get(name)!;
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    const n = xs.length;
    xs.forEach((idx, c0) => {
      const c = c0 + 1;
      slots.push({ idx, due: c === 1 ? 1 : Math.ceil((c * N) / n - 1e-9), time: (c * N) / n, size: n, name });
    });
  }
  slots.sort((a, b) => a.due - b.due || a.time - b.time || b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return slots.map((s) => s.idx);
}
