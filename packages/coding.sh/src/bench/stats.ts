// Per-run numbers: one summary per contender, a paired comparison for every
// pair (src/experiments/compare.ts + McNemar, Holm-adjusted across pairs),
// and places where contenders that don't differ significantly share a place.
import type { CaseRun, ExperimentResult } from "../datasets/types.ts";
import { compareExperiments } from "../experiments/compare.ts";
import { normalQuantile } from "../experiments/power.ts";
import { summarizeRuns } from "../experiments/run.ts";
import { pairedBootstrap } from "../stats/interval.ts";
import { quantile } from "../stats/summary.ts";
import { holm } from "../stats/tests.ts";
import type { Cell, ContenderSummary, CostSource, Dist, PairComparison } from "./types.ts";

export const ALPHA = 0.05;

export function dist(xs: readonly number[]): Dist {
  const n = xs.length;
  if (!n) return { n: 0, mean: NaN, p50: NaN, p90: NaN, p95: NaN, p99: NaN, max: NaN };
  return {
    n,
    mean: xs.reduce((a, b) => a + b, 0) / n,
    p50: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    p95: quantile(xs, 0.95),
    p99: quantile(xs, 0.99),
    max: Math.max(...xs),
  };
}

/** Cells that count: not excluded, and only for cases every contender finished (keeps every number paired). */
export function countedCells(cells: readonly Cell[], contenders: readonly string[], trials: number): { cells: Cell[]; dropped: Set<string> } {
  const dropped = new Set<string>();
  const have = new Map<string, number>();
  for (const x of cells) {
    if (x.excluded) dropped.add(x.caseId);
    else have.set(x.caseId, (have.get(x.caseId) ?? 0) + 1);
  }
  const need = contenders.length * trials;
  for (const [id, k] of have) if (k < need) dropped.add(id);
  return { cells: cells.filter((x) => !dropped.has(x.caseId)), dropped };
}

export function summarizeContender(cells: readonly Cell[], c: { name: string; kind: string; ref: string; experimentId?: string }, trials = 1): ContenderSummary {
  const mine = cells.filter((x) => x.contender === c.name);
  const n = mine.length;
  const passed = mine.filter((x) => x.pass).length;
  const costs = mine.map((x) => x.costUsd).filter((x): x is number => x !== undefined);
  const toks = mine.map((x) => x.tokens).filter((x): x is number => x !== undefined);
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const sources: Partial<Record<CostSource | "unknown", number>> = {};
  for (const x of mine) {
    const k = x.costUsd === undefined ? "unknown" : (x.costSource ?? "reported");
    sources[k] = (sources[k] ?? 0) + 1;
  }
  // Input counts every prompt token the call read: uncached plus cache reads and writes.
  const inOf = (x: Cell) => {
    const u = x.usage;
    if (!u || (u.inputTokens === undefined && u.cacheReadTokens === undefined && u.cacheWriteTokens === undefined)) return undefined;
    return (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  };
  const tally = (xs: (number | undefined)[]) => {
    const k = xs.filter((x): x is number => x !== undefined);
    const total = k.reduce((a, b) => a + b, 0);
    return { total, mean: k.length ? total / k.length : NaN, known: k.length };
  };
  const failures: Record<string, number> = {};
  for (const x of mine) if (x.failure) failures[x.failure] = (failures[x.failure] ?? 0) + 1;
  // Cases are the unit: Wilson when each case ran once, else a bootstrap over cases (summarizeRuns).
  const sum = summarizeRuns(cellsToRuns(mine, c.name), [], trials);
  return {
    contender: c.name,
    kind: c.kind,
    ref: c.ref,
    ...(c.experimentId ? { experimentId: c.experimentId } : {}),
    n,
    passed,
    passRate: { p: sum.passRate.p, lo: sum.passRate.lo, hi: sum.passRate.hi },
    ciMethod: sum.ciMethod === "cluster-bootstrap" ? "cluster-bootstrap" : "wilson",
    meanScore: n ? mine.reduce((a, x) => a + x.score, 0) / n : NaN,
    // Latency of answered requests only: an instant crash is not "fast".
    latencyMs: dist(mine.filter((x) => !x.error).map((x) => x.latencyMs)),
    costUsd: { total: totalCost, perRun: costs.length ? totalCost / costs.length : NaN, perThousandPasses: costs.length && passed ? (totalCost / passed) * 1000 : NaN, known: costs.length, sources },
    tokens: { total: toks.reduce((a, b) => a + b, 0), mean: toks.length ? toks.reduce((a, b) => a + b, 0) / toks.length : NaN, known: toks.length },
    tokensIn: tally(mine.map(inOf)),
    tokensOut: tally(mine.map((x) => x.usage?.outputTokens)),
    errors: mine.filter((x) => x.error !== undefined).length,
    failures,
    place: 0,
  };
}

/** Cells of one contender as experiment runs (what compareExperiments pairs on). */
export function cellsToRuns(cells: readonly Cell[], contender: string): CaseRun[] {
  return cells
    .filter((x) => x.contender === contender)
    .map((x) => ({
      caseId: x.caseId,
      trial: x.trial,
      latencyMs: x.latencyMs,
      pass: x.pass,
      startedAt: 0,
      grades: (x.grades ?? []).map((g) => ({ graderId: g.grader, result: { score: g.score, pass: g.pass } })),
      ...(x.error ? { error: x.error } : {}),
    }));
}

function shell(name: string, runs: CaseRun[], trials: number, dataset: { id: string; version: string }, graders: string[]): ExperimentResult {
  const ds = { id: dataset.id, name: dataset.id, version: dataset.version };
  return {
    id: name,
    name,
    dataset: ds,
    task: { kind: "command", ref: name },
    graders: graders.map((id) => ({ id, version: "", kind: "" })),
    trials,
    createdAt: 0,
    finishedAt: 0,
    runs,
    summary: { n: runs.length, cases: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0 }, ciMethod: "wilson", graders: [], latencyMs: { mean: 0, median: 0, p90: 0, max: 0 } },
  };
}

function perCaseMean(cells: readonly Cell[], name: string, pick: (x: Cell) => number | undefined): Map<string, number> {
  const m = new Map<string, number[]>();
  for (const x of cells) {
    if (x.contender !== name) continue;
    const v = pick(x);
    if (v === undefined || !Number.isFinite(v)) continue;
    m.set(x.caseId, [...(m.get(x.caseId) ?? []), v]);
  }
  return new Map([...m].map(([k, v]) => [k, v.reduce((s, y) => s + y, 0) / v.length]));
}

/** Geometric mean of a/b over cases where both are positive. */
function geoRatio(a: Map<string, number>, b: Map<string, number>): number | undefined {
  const logs: number[] = [];
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (vb !== undefined && va > 0 && vb > 0) logs.push(Math.log(va / vb));
  }
  return logs.length ? Math.exp(logs.reduce((s, x) => s + x, 0) / logs.length) : undefined;
}

export function comparePairs(cells: readonly Cell[], contenders: readonly string[], o: { trials: number; dataset: { id: string; version: string }; graders: string[]; iters?: number; noVerdict?: boolean }): PairComparison[] {
  const pairs: PairComparison[] = [];
  // Leader first: each pair reads "a − b" with a the one that passed more (ties keep definition order).
  const rate = (name: string) => {
    const mine = cells.filter((x) => x.contender === name);
    return mine.length ? mine.filter((x) => x.pass).length / mine.length : 0;
  };
  const ordered = [...contenders].map((n, i) => ({ n, i, r: rate(n) })).sort((x, y) => y.r - x.r || x.i - y.i).map((x) => x.n);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      // compareExperiments(base, cand) reports cand − base; base = b gives a − b.
      const cmp = compareExperiments(shell(b, cellsToRuns(cells, b), o.trials, o.dataset, o.graders), shell(a, cellsToRuns(cells, a), o.trials, o.dataset, o.graders), { iters: o.iters ?? 4000 });
      // Latency, paired over cases both answered (mean over trials per case).
      const lat = (name: string) => perCaseMean(cells, name, (x) => (x.error ? undefined : x.latencyMs));
      const la = lat(a);
      const lb = lat(b);
      const cost = (name: string) => perCaseMean(cells, name, (x) => x.costUsd);
      const both = [...la.keys()].filter((k) => lb.has(k)).sort();
      const pc: PairComparison = {
        a,
        b,
        paired: cmp.paired,
        diff: { mean: cmp.diff.mean, lo: cmp.diff.lo, hi: cmp.diff.hi },
        aOnly: cmp.mcnemar.c,
        bOnly: cmp.mcnemar.b,
        p: cmp.mcnemar.p,
        pAdj: cmp.mcnemar.p,
        verdict: "tie",
        warnings: cmp.power.warnings.map((w) => w.message),
      };
      if (Number.isFinite(cmp.power.mde)) pc.mde = cmp.power.mde;
      const lr = geoRatio(la, lb);
      if (lr !== undefined) pc.latencyRatio = lr;
      const cr = geoRatio(cost(a), cost(b));
      if (cr !== undefined) pc.costRatio = cr;
      if (both.length) {
        const d = pairedBootstrap(
          both.map((k) => la.get(k)! - lb.get(k)!),
          { iters: o.iters ?? 4000 },
        );
        pc.latencyDiffMs = { mean: d.mean, lo: d.lo, hi: d.hi, n: d.n };
      }
      pairs.push(pc);
    }
  }
  const adj = holm(pairs.map((p) => p.p));
  for (const [i, p] of pairs.entries()) {
    p.pAdj = adj[i]!;
    if (!o.noVerdict && p.pAdj < ALPHA && p.aOnly !== p.bOnly) p.verdict = p.bOnly > p.aOnly ? "b" : "a";
  }
  return pairs;
}

export interface PowerPlan {
  cases: number;
  pairs: number;
  /** Discordant share assumed (cases where exactly one side passes). */
  discordance: number;
  assumed: boolean;
  /** Per-pair α after Holm's worst case (α / pairs). */
  alpha: number;
  /** Smallest pass-rate gap detectable with 80% power. */
  mde: number;
  /** Cases needed to detect a 10-point and a 5-point gap (Connor's McNemar sample size). */
  nFor10: number;
  nFor5: number;
}

/**
 * How big a gap this many cases can find, before spending money on a run.
 * Paired binary outcomes: the per-case difference is −1, 0 or +1 and its
 * variance is about the discordant share q. MDE = (z₁₋α/₂ + z₀.₈)·√q/√n, and
 * the sample size for a gap δ is Connor (1987): n = (z₁₋α/₂·√q + z₀.₈·√(q − δ²))² / δ².
 * q comes from the last run when there is one, else 0.3.
 */
export function powerPlan(cases: number, contenders: number, discordance?: number, power = 0.8): PowerPlan {
  const pairs = Math.max(1, (contenders * (contenders - 1)) / 2);
  const alpha = ALPHA / pairs;
  const q = discordance !== undefined && discordance > 0 ? Math.min(1, discordance) : 0.3;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const connor = (d: number) => (q <= d * d ? NaN : Math.ceil((za * Math.sqrt(q) + zb * Math.sqrt(q - d * d)) ** 2 / (d * d)));
  return { cases, pairs, discordance: q, assumed: discordance === undefined || discordance <= 0, alpha, mde: cases > 0 ? ((za + zb) * Math.sqrt(q)) / Math.sqrt(cases) : NaN, nFor10: connor(0.1), nFor5: connor(0.05) };
}

/** Mean discordant share over a run's pairs (input for powerPlan). */
export function discordanceOf(pairs: readonly PairComparison[]): number | undefined {
  const xs = pairs.filter((p) => p.paired > 0).map((p) => (p.aOnly + p.bOnly) / p.paired);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

/**
 * Places by pass rate (then mean score, then name). A contender starts a new
 * place only when it differs significantly from the leader of the current
 * place; otherwise it shares that place.
 */
export function assignPlaces(summaries: ContenderSummary[], pairs: readonly PairComparison[]): ContenderSummary[] {
  const sig = (x: string, y: string) => pairs.some((p) => ((p.a === x && p.b === y) || (p.a === y && p.b === x)) && p.verdict !== "tie");
  const sorted = [...summaries].sort((x, y) => (y.passRate.p || 0) - (x.passRate.p || 0) || (y.meanScore || 0) - (x.meanScore || 0) || x.contender.localeCompare(y.contender));
  let leader: ContenderSummary | undefined;
  for (const [i, s] of sorted.entries()) {
    if (!leader || sig(leader.contender, s.contender)) {
      leader = s;
      s.place = i + 1;
    } else s.place = leader.place;
  }
  return sorted;
}

/** P(|T| < √ν·tan θ) for integer ν: the closed-form series (Abramowitz & Stegun 26.7.3-4). */
function tAbsCdf(theta: number, nu: number): number {
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const c2 = cos * cos;
  if (nu % 2 === 0) {
    let term = 1;
    let sum = 1;
    for (let j = 1; j <= nu / 2 - 1; j++) {
      term *= (c2 * (2 * j - 1)) / (2 * j);
      sum += term;
    }
    return sin * sum;
  }
  if (nu === 1) return (2 * theta) / Math.PI;
  let term = cos;
  let sum = cos;
  for (let j = 1; j <= (nu - 3) / 2; j++) {
    term *= (c2 * 2 * j) / (2 * j + 1);
    sum += term;
  }
  return (2 / Math.PI) * (theta + sin * sum);
}

/**
 * Student t quantile. Integer degrees of freedom (what the window estimate
 * uses) are exact: bisection on the closed-form CDF. Otherwise a
 * Cornish-Fisher expansion around the normal quantile.
 */
export function tQuantile(p: number, nu: number): number {
  if (!(nu > 0) || !(p > 0 && p < 1)) return NaN;
  if (p === 0.5) return 0;
  if (Number.isInteger(nu) && nu <= 1000) {
    const target = Math.abs(2 * p - 1);
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (tAbsCdf(mid, nu) < target) lo = mid;
      else hi = mid;
    }
    const t = Math.sqrt(nu) * Math.tan((lo + hi) / 2);
    return p < 0.5 ? -t : t;
  }
  const z = normalQuantile(p);
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  const z9 = z ** 9;
  return z + (z3 + z) / (4 * nu) + (5 * z5 + 16 * z3 + 3 * z) / (96 * nu ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * nu ** 3) + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * nu ** 4);
}

export interface GapPoint {
  /** Per-run paired gap and its 95% CI. */
  value: number;
  lo: number;
  hi: number;
  /** Paired cases behind it. */
  n: number;
}

export interface PooledGap {
  /** Runs pooled. */
  k: number;
  /** Paired cases across them. */
  cases: number;
  /** Inverse-variance mean, as if every day drew from one pool of cases. */
  fixed: { mean: number; lo: number; hi: number };
  /** DerSimonian-Laird random effects with the Hartung-Knapp-Sidik-Jonkman interval: days differ, and the CI says so. */
  random: { mean: number; lo: number; hi: number };
  /** Where one more day's gap should land (95%); from 5 runs (with fewer, t with k − 2 df makes it uselessly wide). */
  predict?: { lo: number; hi: number };
  /** Between-day variance of the true gap, and the share of spread it explains. */
  tau2: number;
  i2: number;
}

const Z975 = 1.959964;

/**
 * Pool per-run gaps over a window of days. Each day's standard error comes
 * from its CI, (hi − lo) / (2 · 1.96), floored at 1/(2n) so a day where both
 * sides passed every case doesn't get infinite weight. The window is fixed in
 * the definition (window = 28) so it can't be picked after seeing the numbers.
 */
export function pooledGap(points: readonly GapPoint[]): PooledGap | undefined {
  const xs = points.filter((x) => Number.isFinite(x.value) && Number.isFinite(x.lo) && Number.isFinite(x.hi) && x.n > 0);
  const k = xs.length;
  if (k < 2) return undefined;
  const se = xs.map((x) => Math.max((x.hi - x.lo) / (2 * Z975), 1 / (2 * x.n), 1e-4));
  const th = xs.map((x) => x.value);
  const w = se.map((s) => 1 / (s * s));
  const sw = w.reduce((a, b) => a + b, 0);
  const fe = w.reduce((a, wi, i) => a + wi * th[i]!, 0) / sw;
  const seFe = Math.sqrt(1 / sw);
  const q = w.reduce((a, wi, i) => a + wi * (th[i]! - fe) ** 2, 0);
  const c = sw - w.reduce((a, wi) => a + wi * wi, 0) / sw;
  const tau2 = c > 0 ? Math.max(0, (q - (k - 1)) / c) : 0;
  const i2 = q > 0 ? Math.max(0, (q - (k - 1)) / q) : 0;
  const ws = se.map((s) => 1 / (s * s + tau2));
  const sws = ws.reduce((a, b) => a + b, 0);
  const re = ws.reduce((a, wi, i) => a + wi * th[i]!, 0) / sws;
  // HKSJ, with the variance never below the DL one (q* ≥ 1) so a run of identical days can't shrink the interval to nothing.
  const qs = ws.reduce((a, wi, i) => a + wi * (th[i]! - re) ** 2, 0) / (k - 1);
  const seHk = Math.sqrt(Math.max(1, qs) / sws);
  const t = tQuantile(0.975, k - 1);
  // A pass-rate gap lives in [−1, 1]; intervals are clipped to it.
  const clip = (x: number) => Math.max(-1, Math.min(1, x));
  const out: PooledGap = {
    k,
    cases: xs.reduce((a, x) => a + x.n, 0),
    fixed: { mean: fe, lo: clip(fe - Z975 * seFe), hi: clip(fe + Z975 * seFe) },
    random: { mean: re, lo: clip(re - t * seHk), hi: clip(re + t * seHk) },
    tau2,
    i2,
  };
  if (k >= 5) {
    const tp = tQuantile(0.975, k - 2);
    const half = tp * Math.sqrt(tau2 + 1 / sws);
    out.predict = { lo: clip(re - half), hi: clip(re + half) };
  }
  return out;
}
