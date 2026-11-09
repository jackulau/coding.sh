// Routing headroom: would picking a contender per case beat running the best
// one everywhere? The raw "any contender passed" oracle always looks better
// than the best single contender, because run noise alone makes contenders
// split cases. So the observed gap and upset rate are compared with what a
// no-specialization reference predicts: a Rasch model (one ability per
// contender, one difficulty per case) fitted to the same outcomes, simulated
// `sims` times. Each simulated case draws its difficulty from its posterior
// under the fit, so easy and hard cases stay easy and hard. Only a gap or
// upset rate above that reference is evidence that contenders specialize
// (arXiv 2611.08285 §5: none of 8 routing gaps survived this test after Holm).
// On Rasch-generated data the reference is somewhat conservative: the
// observed gap fell inside the 95% band in 360 of 360 simulated benches.
import { mulberry32 } from "../stats/prng.ts";
import { quantile } from "../stats/summary.ts";
import { holm } from "../stats/tests.ts";
import { ALPHA } from "./stats.ts";
import type { Cell } from "./types.ts";

/** Outcomes as y[case][contender][trial], each 0 or 1. */
export type Outcomes = readonly (readonly (readonly number[])[])[];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clampStep = (x: number) => Math.max(-3, Math.min(3, x));

export interface RaschFit {
  /** Contender abilities, centred on 0. */
  theta: number[];
  /** Each case's posterior mean difficulty. */
  b: number[];
  /** Grid of case difficulties and the fitted share of cases at each (nonparametric prior). */
  grid: number[];
  weights: number[];
  /** Posterior over the grid for each case, given its outcomes. */
  posterior: number[][];
  iterations: number;
  converged: boolean;
}

/**
 * Rasch with case difficulty treated as random: marginal maximum likelihood by
 * EM over a fixed grid of difficulties whose weights are estimated freely
 * (a nonparametric prior), so a bench with many all-pass and all-fail cases is
 * fitted as well as a bell-shaped one. Abilities take damped Newton steps on
 * the expected log-likelihood, with a small L2 penalty that keeps an all-fail
 * contender finite, and are kept centred, which pins the location the free
 * prior leaves open.
 *
 * Not joint ML: with few contenders that inflates abilities (about k/(k − 1))
 * and pins each case's difficulty to its own outcomes, so data simulated from
 * it splits cases too rarely and the expected gap comes out too small (two
 * thirds of Rasch-generated 3 × 60 benches looked "specialized").
 */
export function fitRasch(y: Outcomes, o: { l2?: number; maxIter?: number; tol?: number; step?: number; span?: number } = {}): RaschFit {
  const l2 = o.l2 ?? 0.01;
  const maxIter = o.maxIter ?? 500;
  const tol = o.tol ?? 1e-6;
  const span = o.span ?? 8;
  const stepSize = o.step ?? 0.25;
  const grid: number[] = [];
  for (let x = -span; x <= span + 1e-9; x += stepSize) grid.push(Math.round(x * 1e6) / 1e6);
  const G = grid.length;
  const n = y.length;
  const k = y[0]?.length ?? 0;
  const s = y.map((row) => row.map((t) => t.reduce((a, v) => a + v, 0)));
  const m = y.map((row) => row.map((t) => t.length));
  const theta = new Array<number>(k).fill(0);
  let w = grid.map((g) => Math.exp(-(g * g) / 8));
  const wsum = w.reduce((a, x) => a + x, 0);
  w = w.map((x) => x / wsum);
  let post: number[][] = [];
  const posterior = () => {
    // log σ(θ_c − b_g) and log(1 − σ(θ_c − b_g)) depend on the grid point, not the case.
    const lpass: number[][] = grid.map((b) => theta.map((th) => -Math.log1p(Math.exp(b - th))));
    const lfail: number[][] = grid.map((b) => theta.map((th) => -Math.log1p(Math.exp(th - b))));
    const lw = w.map((x) => Math.log(Math.max(x, 1e-300)));
    post = new Array(n);
    for (let i = 0; i < n; i++) {
      const si = s[i]!;
      const mi = m[i]!;
      const lp = new Array<number>(G);
      let mx = -Infinity;
      for (let g = 0; g < G; g++) {
        let l = lw[g]!;
        const a = lpass[g]!;
        const f = lfail[g]!;
        for (let c = 0; c < k; c++) l += si[c]! * a[c]! + (mi[c]! - si[c]!) * f[c]!;
        lp[g] = l;
        if (l > mx) mx = l;
      }
      let tot = 0;
      for (let g = 0; g < G; g++) {
        lp[g] = Math.exp(lp[g]! - mx);
        tot += lp[g]!;
      }
      for (let g = 0; g < G; g++) lp[g] = lp[g]! / tot;
      post[i] = lp;
    }
  };
  let it = 0;
  let converged = false;
  for (; it < maxIter; it++) {
    posterior();
    const nw = new Array<number>(G).fill(0);
    for (let i = 0; i < n; i++) for (let g = 0; g < G; g++) nw[g] = nw[g]! + post[i]![g]! / n;
    let moved = 0;
    for (let g = 0; g < G; g++) moved = Math.max(moved, Math.abs(nw[g]! - w[g]!));
    w = nw;
    // Expected passes and attempts per (grid point, contender).
    const es = grid.map(() => new Array<number>(k).fill(0));
    const em = grid.map(() => new Array<number>(k).fill(0));
    for (let i = 0; i < n; i++) {
      const q = post[i]!;
      for (let g = 0; g < G; g++) {
        const qg = q[g]!;
        if (qg < 1e-15) continue;
        const eg = es[g]!;
        const mg = em[g]!;
        for (let c = 0; c < k; c++) {
          eg[c] = eg[c]! + qg * s[i]![c]!;
          mg[c] = mg[c]! + qg * m[i]![c]!;
        }
      }
    }
    for (let c = 0; c < k; c++) {
      let gr = -l2 * theta[c]!;
      let h = l2;
      for (let g = 0; g < G; g++) {
        const p = sigmoid(theta[c]! - grid[g]!);
        gr += es[g]![c]! - em[g]![c]! * p;
        h += em[g]![c]! * p * (1 - p);
      }
      const st = clampStep(gr / h);
      theta[c] = theta[c]! + st;
      moved = Math.max(moved, Math.abs(st));
    }
    const mean = k ? theta.reduce((a, x) => a + x, 0) / k : 0;
    for (let c = 0; c < k; c++) theta[c] = theta[c]! - mean;
    if (moved < tol) {
      converged = true;
      it++;
      break;
    }
  }
  posterior();
  const b = post.map((q) => q.reduce((a, x, g) => a + x * grid[g]!, 0));
  return { theta, b, grid, weights: w, posterior: post, iterations: it, converged };
}

export interface HeadroomStats {
  /** Mean over trial indexes of the share of cases some contender passed. */
  oracle: number;
  /** Mean over trial indexes of the best single contender's pass rate in that trial. */
  best: number;
  /** oracle − best. */
  gap: number;
  /** Contender with the highest pass rate over every trial (first in order on ties). */
  bestIndex: number;
  rates: number[];
  /** Share of split (case, pair, trial) cells won by the lower-rate contender; NaN when none split. */
  upset: number;
  splits: number;
  upsets: number;
}

const EPS = 1e-12;

/** Oracle gap and upset rate of one outcome table. */
export function headroomStats(y: Outcomes): HeadroomStats {
  const n = y.length;
  const k = y[0]?.length ?? 0;
  const trials = n && k ? Math.min(...y.flatMap((row) => row.map((t) => t.length))) : 0;
  const rates = new Array<number>(k).fill(0);
  for (let c = 0; c < k; c++) {
    let pass = 0;
    for (let i = 0; i < n; i++) for (let t = 0; t < trials; t++) pass += y[i]![c]![t]!;
    rates[c] = n && trials ? pass / (n * trials) : 0;
  }
  let oracle = 0;
  let best = 0;
  for (let t = 0; t < trials; t++) {
    let any = 0;
    const per = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      let hit = 0;
      for (let c = 0; c < k; c++) {
        const v = y[i]![c]![t]!;
        per[c] = per[c]! + v;
        if (v) hit = 1;
      }
      any += hit;
    }
    oracle += any / n;
    best += Math.max(...per) / n;
  }
  oracle = trials ? oracle / trials : NaN;
  best = trials ? best / trials : NaN;
  let bestIndex = 0;
  for (let c = 1; c < k; c++) if (rates[c]! > rates[bestIndex]! + EPS) bestIndex = c;
  let splits = 0;
  let upsets = 0;
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      if (Math.abs(rates[a]! - rates[b]!) <= EPS) continue;
      const lo = rates[a]! < rates[b]! ? a : b;
      for (let i = 0; i < n; i++) {
        for (let t = 0; t < trials; t++) {
          const va = y[i]![a]![t]!;
          const vb = y[i]![b]![t]!;
          if (va === vb) continue;
          splits++;
          if ((lo === a ? va : vb) === 1) upsets++;
        }
      }
    }
  }
  return { oracle, best, gap: oracle - best, bestIndex, rates, upset: splits ? upsets / splits : NaN, splits, upsets };
}

export interface RecurringUpset {
  caseId: string;
  /** The lower-rate contender that won. */
  winner: string;
  /** The higher-rate contender it beat. */
  over: string;
  /** Trials in which it won that case. */
  trials: number;
}

export interface Specialization {
  cases: number;
  contenders: number;
  trials: number;
  sims: number;
  seed: number;
  /** The best single contender over the whole run and its pass rate. */
  best: { contender: string; rate: number };
  /** Any-contender pass rate and the best single contender's, both means over trial indexes. */
  oracle: number;
  bestSingle: number;
  /** oracle − bestSingle. */
  gap: number;
  /** Where the gap lands with no specialization (2.5th and 97.5th percentiles of the simulated gaps). */
  gapExpected: { lo: number; hi: number };
  /** Share of simulated gaps at least as large, (1 + #) / (sims + 1). */
  pGap: number;
  /** Share of split cells won by the lower-rate contender. NaN (null once stored) when no pair with different pass rates split a case. */
  upset: number | null;
  upsetExpected?: { lo: number; hi: number };
  pUpset?: number;
  splits: number;
  /** Holm-adjusted smallest of pGap and pUpset. */
  pAdj: number;
  verdict: "contenders-specialize" | "no-evidence-of-specialization";
  /** Cases a lower-rate contender won in two or more trials (at most 10), with several trials. */
  recurringUpsets: RecurringUpset[];
}

export type SpecializationResult = Specialization | { skipped: string };

/** y[case][contender][trial] from counted cells; cases sorted by id, trials by their index. */
export function outcomesOf(cells: readonly Cell[], contenders: readonly string[]): { ids: string[]; y: number[][][] } {
  const col = new Map(contenders.map((c, i) => [c, i]));
  const byCase = new Map<string, Cell[][]>();
  for (const x of cells) {
    const c = col.get(x.contender);
    if (c === undefined) continue;
    let row = byCase.get(x.caseId);
    if (!row) byCase.set(x.caseId, (row = contenders.map(() => [])));
    row[c]!.push(x);
  }
  const ids = [...byCase.keys()].sort();
  const y = ids.map((id) => byCase.get(id)!.map((xs) => [...xs].sort((a, b) => a.trial - b.trial || a.position - b.position).map((x) => (x.pass ? 1 : 0))));
  return { ids, y };
}

function recurring(y: Outcomes, ids: readonly string[], names: readonly string[], rates: readonly number[]): RecurringUpset[] {
  const out: RecurringUpset[] = [];
  const k = names.length;
  for (const [i, row] of y.entries()) {
    let top: RecurringUpset | undefined;
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        if (!(rates[a]! < rates[b]! - EPS)) continue;
        let won = 0;
        for (let t = 0; t < row[a]!.length; t++) if (row[a]![t] === 1 && row[b]![t] === 0) won++;
        if (won >= 2 && (!top || won > top.trials)) top = { caseId: ids[i]!, winner: names[a]!, over: names[b]!, trials: won };
      }
    }
    if (top) out.push(top);
  }
  return out.sort((x, y2) => y2.trials - x.trials || (x.caseId < y2.caseId ? -1 : x.caseId > y2.caseId ? 1 : 0)).slice(0, 10);
}

/**
 * Routing headroom on a run's counted cells (every case finished by every
 * contender). Skips with a reason under 2 contenders or `minCases` cases.
 */
export function specialization(cells: readonly Cell[], contenders: readonly string[], trials: number, o: { sims?: number; seed?: number; minCases?: number } = {}): SpecializationResult {
  const sims = o.sims ?? 500;
  const seed = o.seed ?? 1;
  const minCases = o.minCases ?? 20;
  if (contenders.length < 2) return { skipped: "needs 2 or more contenders" };
  const { ids, y } = outcomesOf(cells, contenders);
  if (ids.length < minCases) return { skipped: `${ids.length} counted case${ids.length === 1 ? "" : "s"}; needs ${minCases}` };
  const T = Math.min(...y.flatMap((row) => row.map((t) => t.length)));
  if (!T) return { skipped: "no trials" };
  const obs = headroomStats(y);
  const fit = fitRasch(y);
  const rand = mulberry32(seed);
  const gaps: number[] = [];
  const ups: number[] = [];
  const k = contenders.length;
  // Each simulated case draws a difficulty from its own posterior (given its outcomes), then fresh outcomes.
  const cdf = fit.posterior.map((q) => {
    let acc = 0;
    return q.map((x) => (acc += x));
  });
  const pAt = fit.grid.map((b) => fit.theta.map((th) => sigmoid(th - b)));
  const draw = (c: number[]) => {
    const u = rand() * c[c.length - 1]!;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let s = 0; s < sims; s++) {
    const sim: number[][][] = new Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const pg = pAt[draw(cdf[i]!)]!;
      const row: number[][] = new Array(k);
      for (let c = 0; c < k; c++) {
        const pc = pg[c]!;
        const t: number[] = new Array(T);
        for (let r = 0; r < T; r++) t[r] = rand() < pc ? 1 : 0;
        row[c] = t;
      }
      sim[i] = row;
    }
    const st = headroomStats(sim);
    gaps.push(st.gap);
    if (Number.isFinite(st.upset)) ups.push(st.upset);
  }
  const pOf = (xs: number[], v: number) => (1 + xs.filter((x) => x >= v - 1e-12).length) / (xs.length + 1);
  const pGap = pOf(gaps, obs.gap);
  const out: Specialization = {
    cases: ids.length,
    contenders: k,
    trials: T,
    sims,
    seed,
    best: { contender: contenders[obs.bestIndex]!, rate: obs.rates[obs.bestIndex]! },
    oracle: obs.oracle,
    bestSingle: obs.best,
    gap: obs.gap,
    gapExpected: { lo: quantile(gaps, 0.025), hi: quantile(gaps, 0.975) },
    pGap,
    upset: obs.upset,
    splits: obs.splits,
    pAdj: pGap,
    verdict: "no-evidence-of-specialization",
    recurringUpsets: [],
  };
  const ps = [pGap];
  if (Number.isFinite(obs.upset) && ups.length) {
    out.upsetExpected = { lo: quantile(ups, 0.025), hi: quantile(ups, 0.975) };
    out.pUpset = pOf(ups, obs.upset);
    ps.push(out.pUpset);
  }
  out.pAdj = Math.min(...holm(ps));
  if (out.pAdj < ALPHA) {
    out.verdict = "contenders-specialize";
    if (T >= 2) out.recurringUpsets = recurring(y, ids, contenders, obs.rates);
  }
  return out;
}

const pct1 = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "-");
const pts = (x: number) => (x * 100).toFixed(1);
const pv = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? "-" : p < 0.001 ? "<0.001" : p.toFixed(p < 0.01 ? 3 : 2));

/** Plain-text summary for `bench show` and `bench run`. */
export function specializationLines(s: Specialization): string[] {
  const lines = [
    `Routing headroom: any contender ${pct1(s.oracle)} vs best single (${s.best.contender}) ${pct1(s.bestSingle)}: gap ${pts(s.gap)} pp; with no specialization expect ${pts(s.gapExpected.lo)}-${pts(s.gapExpected.hi)} pp (p ${pv(s.pGap)}).`,
    typeof s.upset === "number" && Number.isFinite(s.upset)
      ? `Upsets ${pct1(s.upset)} of ${s.splits} split cells${s.upsetExpected ? ` (expected ${pct1(s.upsetExpected.lo)}-${pct1(s.upsetExpected.hi)}, p ${pv(s.pUpset)})` : ""}.`
      : `Upsets -: no pair of contenders with different pass rates split a case.`,
    s.verdict === "contenders-specialize"
      ? `Contenders specialize (Holm p ${pv(s.pAdj)}): routing each case to the right contender could beat running ${s.best.contender} alone.`
      : `No evidence of specialization: per-case routing is unlikely to beat running ${s.best.contender} alone.`,
  ];
  if (s.recurringUpsets.length) lines.push(`Recurring upsets: ${s.recurringUpsets.map((u) => `${u.caseId} (${u.winner} over ${u.over}, ${u.trials}/${s.trials} trials)`).join("; ")}`);
  return lines;
}
