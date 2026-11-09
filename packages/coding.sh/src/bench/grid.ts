// Model × harness grid. A bench over agents × models is a factorial design, so
// ranking its contenders as a flat list hides the interaction: a harness that
// is best with one model can be worst with another (arXiv 2610.32483 §3-6).
// This module reads such a run as a grid:
//
// - residual Δ(m,h) = v(m,h) − v(m,·) − v(·,h) + v(·,·), with equal-weight
//   margins, for the pass rate p and the valid-completion rate v;
// - fit F(m,h) = J(m,h) / max_h' J(m,h'), J the joint rate (passed and
//   completed cleanly);
// - Cross-Model Fit(h) = 100 × geometric mean of F over models (0 when any F
//   is 0): how close h gets to each model's best harness;
// - leave-one-model-out regret: pick the harness with the best Cross-Model Fit
//   over the other models and measure how far it falls short of the held-out
//   model's best harness, in points;
// - 95% intervals from a bootstrap that resamples cases (trials of a case move
//   together), seeded with mulberry32.
import { mulberry32 } from "../stats/prng.ts";
import { quantile } from "../stats/summary.ts";
import type { Cell } from "./types.ts";

/** Grid coordinates of a contender. */
export interface GridAxes {
  model?: string;
  harness?: string;
}

export interface Est {
  est: number;
  lo: number;
  hi: number;
}

export interface GridCell {
  model: string;
  harness: string;
  contender: string;
  /** Pass rate (mean of each case's share of passing trials). */
  p: number;
  /** Valid-completion rate: share of attempts that did not time out, crash, error or come back empty. */
  v: number;
  /** Joint rate: passed and completed cleanly. */
  j: number;
  /** Interaction residuals of p and v. */
  dp: Est;
  dv: Est;
  /** J over the model's best J; absent when the model is dropped (its best J is 0). */
  f?: number;
}

export interface GridAnalysis {
  models: string[];
  harnesses: string[];
  cases: number;
  trials: number;
  draws: number;
  seed: number;
  /** Row-major: models × harnesses. */
  cells: GridCell[];
  /** Cross-Model Fit per harness (0-100), best first. */
  crossFit: (Est & { harness: string })[];
  /** Top harness minus the runner-up, on the Cross-Model Fit scale. */
  crossFitGap: Est & { top: string; second: string };
  /** Pairs of models whose order flips between two harnesses: models[0] leads under harnesses[0], models[1] under harnesses[1]. */
  reversals: { models: [string, string]; harnesses: [string, string] }[];
  /** Leave-one-model-out: the harness picked from the other models, and the held-out model's shortfall in points (0-100). */
  lomo: { model: string; pick: string; best: string; regret: number }[];
  meanRegret: number;
  /** Models left out of the fit numbers because no harness ever passed cleanly with them. */
  dropped: string[];
  notes: string[];
}

export type GridResult = GridAnalysis | { skipped: string };

/** Failure modes that are not a clean completion. */
const INVALID = new Set(["timeout", "crash", "http-error", "error", "empty"]);

const isValid = (x: Cell) => !(x.failure && INVALID.has(x.failure));

/**
 * The grid over a run's counted cells. Contenders without both axes are left
 * out; the rest must cover 2+ models × 2+ harnesses with exactly one contender
 * per combination, else the analysis is skipped with a reason.
 */
export function gridAnalysis(cells: readonly Cell[], contenders: readonly { name: string; axes?: GridAxes }[], o: { seed?: number; draws?: number } = {}): GridResult {
  const seed = o.seed ?? 1;
  const draws = o.draws ?? 2000;
  const placed = contenders.filter((c) => c.axes?.model && c.axes?.harness);
  if (!placed.length) return { skipped: "no contender has both a model and a harness" };
  const models = [...new Set(placed.map((c) => c.axes!.model!))];
  const harnesses = [...new Set(placed.map((c) => c.axes!.harness!))];
  const at = new Map<string, string>();
  for (const c of placed) {
    const key = `${c.axes!.model}\u0000${c.axes!.harness}`;
    if (at.has(key)) return { skipped: `${at.get(key)} and ${c.name} both run ${c.axes!.model} with ${c.axes!.harness}` };
    at.set(key, c.name);
  }
  if (models.length < 2 || harnesses.length < 2) return { skipped: `needs 2 or more models and 2 or more harnesses (have ${models.length} × ${harnesses.length})` };
  const M = models.length;
  const H = harnesses.length;
  const who: string[] = [];
  for (const m of models) {
    for (const h of harnesses) {
      const name = at.get(`${m}\u0000${h}`);
      if (!name) return { skipped: `no contender runs ${m} with ${h}` };
      who.push(name);
    }
  }
  // Per case, per grid cell: shares of trials that passed, completed cleanly, and both.
  const col = new Map(who.map((n, i) => [n, i]));
  const acc = new Map<string, { p: number[]; v: number[]; j: number[]; k: number[] }>();
  const K = M * H;
  for (const x of cells) {
    const g = col.get(x.contender);
    if (g === undefined) continue;
    let a = acc.get(x.caseId);
    if (!a) acc.set(x.caseId, (a = { p: new Array(K).fill(0), v: new Array(K).fill(0), j: new Array(K).fill(0), k: new Array(K).fill(0) }));
    const ok = isValid(x);
    a.p[g] = a.p[g]! + (x.pass ? 1 : 0);
    a.v[g] = a.v[g]! + (ok ? 1 : 0);
    a.j[g] = a.j[g]! + (x.pass && ok ? 1 : 0);
    a.k[g] = a.k[g]! + 1;
  }
  // Paired: only cases every grid contender answered.
  const ids = [...acc.keys()].filter((id) => acc.get(id)!.k.every((n) => n > 0)).sort();
  if (ids.length < 2) return { skipped: `${ids.length} paired case${ids.length === 1 ? "" : "s"}; needs 2` };
  const n = ids.length;
  const P = ids.map((id) => {
    const a = acc.get(id)!;
    return a.p.map((x, g) => x / a.k[g]!);
  });
  const V = ids.map((id) => {
    const a = acc.get(id)!;
    return a.v.map((x, g) => x / a.k[g]!);
  });
  const J = ids.map((id) => {
    const a = acc.get(id)!;
    return a.j.map((x, g) => x / a.k[g]!);
  });
  const trials = Math.max(...ids.map((id) => Math.max(...acc.get(id)!.k)));

  const means = (rows: number[][], pick: readonly number[]) => {
    const out = new Array<number>(K).fill(0);
    for (const i of pick) {
      const r = rows[i]!;
      for (let g = 0; g < K; g++) out[g] = out[g]! + r[g]!;
    }
    return out.map((x) => x / pick.length);
  };
  const residuals = (v: readonly number[]) => {
    const row = models.map((_, mi) => harnesses.reduce((a, _h, hi) => a + v[mi * H + hi]!, 0) / H);
    const colm = harnesses.map((_, hi) => models.reduce((a, _m, mi) => a + v[mi * H + hi]!, 0) / M);
    const all = v.reduce((a, x) => a + x, 0) / K;
    return v.map((x, g) => x - row[Math.floor(g / H)]! - colm[g % H]! + all);
  };
  const fitOf = (j: readonly number[], keep: readonly number[]) => {
    // F per cell for kept models; a model whose best J is 0 in a resample has no best harness, so every harness fits it equally (F = 1).
    const f = new Array<number>(K).fill(NaN);
    for (const mi of keep) {
      const best = Math.max(...harnesses.map((_, hi) => j[mi * H + hi]!));
      for (let hi = 0; hi < H; hi++) f[mi * H + hi] = best > 0 ? j[mi * H + hi]! / best : 1;
    }
    return f;
  };
  const crossFitOf = (f: readonly number[], keep: readonly number[]) =>
    harnesses.map((_, hi) => {
      if (!keep.length) return NaN;
      let logs = 0;
      for (const mi of keep) {
        const x = f[mi * H + hi]!;
        if (!(x > 0)) return 0;
        logs += Math.log(x);
      }
      return 100 * Math.exp(logs / keep.length);
    });

  const all = ids.map((_, i) => i);
  const p = means(P, all);
  const v = means(V, all);
  const j = means(J, all);
  const dp = residuals(p);
  const dv = residuals(v);
  const keep = models.map((_, mi) => mi).filter((mi) => harnesses.some((_, hi) => j[mi * H + hi]! > 0));
  const dropped = models.filter((_, mi) => !keep.includes(mi));
  const f = fitOf(j, keep);
  const cf = crossFitOf(f, keep);
  const order = harnesses.map((_, hi) => hi).sort((a, b) => cf[b]! - cf[a]! || a - b);
  const top = order[0]!;
  const second = order[1]!;

  // Case bootstrap.
  const rand = mulberry32(seed);
  const bDp: number[][] = Array.from({ length: K }, () => []);
  const bDv: number[][] = Array.from({ length: K }, () => []);
  const bCf: number[][] = Array.from({ length: H }, () => []);
  const bGap: number[] = [];
  const pick = new Array<number>(n);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) pick[i] = Math.floor(rand() * n);
    const rp = residuals(means(P, pick));
    const rv = residuals(means(V, pick));
    for (let g = 0; g < K; g++) {
      bDp[g]!.push(rp[g]!);
      bDv[g]!.push(rv[g]!);
    }
    if (keep.length) {
      const c = crossFitOf(fitOf(means(J, pick), keep), keep);
      for (let hi = 0; hi < H; hi++) bCf[hi]!.push(c[hi]!);
      bGap.push(c[top]! - c[second]!);
    }
  }
  const ci = (est: number, xs: number[]): Est => (xs.length ? { est, lo: quantile(xs, 0.025), hi: quantile(xs, 0.975) } : { est, lo: NaN, hi: NaN });

  const out: GridCell[] = [];
  for (let mi = 0; mi < M; mi++) {
    for (let hi = 0; hi < H; hi++) {
      const g = mi * H + hi;
      const c: GridCell = { model: models[mi]!, harness: harnesses[hi]!, contender: who[g]!, p: p[g]!, v: v[g]!, j: j[g]!, dp: ci(dp[g]!, bDp[g]!), dv: ci(dv[g]!, bDv[g]!) };
      if (keep.includes(mi)) c.f = f[g]!;
      out.push(c);
    }
  }

  const reversals: GridAnalysis["reversals"] = [];
  for (let a = 0; a < M; a++) {
    for (let b = a + 1; b < M; b++) {
      for (let h1 = 0; h1 < H; h1++) {
        for (let h2 = h1 + 1; h2 < H; h2++) {
          const d1 = p[a * H + h1]! - p[b * H + h1]!;
          const d2 = p[a * H + h2]! - p[b * H + h2]!;
          if (!(d1 * d2 < 0)) continue;
          reversals.push(d1 > 0 ? { models: [models[a]!, models[b]!], harnesses: [harnesses[h1]!, harnesses[h2]!] } : { models: [models[b]!, models[a]!], harnesses: [harnesses[h1]!, harnesses[h2]!] });
        }
      }
    }
  }

  const lomo: GridAnalysis["lomo"] = [];
  if (keep.length >= 2) {
    for (const mi of keep) {
      const rest = keep.filter((x) => x !== mi);
      const c = crossFitOf(f, rest);
      const pickH = harnesses.map((_, hi) => hi).sort((x, y) => c[y]! - c[x]! || x - y)[0]!;
      const bestH = harnesses.map((_, hi) => hi).sort((x, y) => j[mi * H + y]! - j[mi * H + x]! || x - y)[0]!;
      lomo.push({ model: models[mi]!, pick: harnesses[pickH]!, best: harnesses[bestH]!, regret: 100 * (j[mi * H + bestH]! - j[mi * H + pickH]!) });
    }
  }
  const notes: string[] = [];
  for (const m of dropped) notes.push(`${m} never passed cleanly with any harness, so it is left out of the fit, Cross-Model Fit and regret`);
  const skippedContenders = contenders.filter((c) => !(c.axes?.model && c.axes?.harness)).map((c) => c.name);
  if (skippedContenders.length) notes.push(`not on the grid (no model or harness): ${skippedContenders.join(", ")}`);
  return {
    models,
    harnesses,
    cases: n,
    trials,
    draws,
    seed,
    cells: out,
    crossFit: order.map((hi) => ({ harness: harnesses[hi]!, ...ci(cf[hi]!, bCf[hi]!) })),
    crossFitGap: { top: harnesses[top]!, second: harnesses[second]!, ...ci(cf[top]! - cf[second]!, bGap) },
    reversals,
    lomo,
    meanRegret: lomo.length ? lomo.reduce((a, x) => a + x.regret, 0) / lomo.length : NaN,
    dropped,
    notes,
  };
}

/** The CI excludes 0. */
export const excludesZero = (e: Est) => e.lo > 0 || e.hi < 0;

const sgn = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(d)}` : "-");
const fx = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");

/** Text for `bench show`: a heading, the models × harnesses table of Δp, and the fit, reversal and regret lines. */
export function gridText(g: GridAnalysis): { heading: string; columns: string[]; rows: string[][]; lines: string[] } {
  const cellAt = (m: string, h: string) => g.cells.find((c) => c.model === m && c.harness === h)!;
  const rows = g.models.map((m) => [m, ...g.harnesses.map((h) => {
    const c = cellAt(m, h);
    return `${(c.p * 100).toFixed(1)}% ${sgn(c.dp.est * 100)}${excludesZero(c.dp) ? "*" : ""}`;
  })]);
  const lines = [
    g.dropped.length === g.models.length
      ? "Cross-model fit: none, no model passed cleanly with any harness."
      : `Cross-model fit: ${g.crossFit.map((c) => `${c.harness} ${fx(c.est)} (${fx(c.lo)}-${fx(c.hi)})`).join("; ")}. ${g.crossFitGap.top} leads ${g.crossFitGap.second} by ${sgn(g.crossFitGap.est)} (95% CI ${sgn(g.crossFitGap.lo)} to ${sgn(g.crossFitGap.hi)})${excludesZero(g.crossFitGap) ? "" : ", not a clear lead"}.`,
  ];
  for (const r of g.reversals) lines.push(`Rank reversal: ${r.models[0]} leads ${r.models[1]} under ${r.harnesses[0]}, ${r.models[1]} leads under ${r.harnesses[1]}.`);
  const vBad = g.cells.filter((c) => excludesZero(c.dv) && c.dv.est < 0);
  if (vBad.length) lines.push(`Completes cleanly less often than the margins predict: ${vBad.map((c) => `${c.model} + ${c.harness} ${sgn(c.dv.est * 100)} pp`).join("; ")}.`);
  if (g.lomo.length) lines.push(`Leave-one-model-out regret: ${g.lomo.map((x) => `${x.model} ${fx(x.regret)} pts (picks ${x.pick}${x.pick === x.best ? ", its best" : `, best ${x.best}`})`).join("; ")}; mean ${fx(g.meanRegret)}.`);
  lines.push(...g.notes);
  return {
    heading: `Model × harness grid: ${g.cases} cases; pass rate and interaction Δp in pp (* = 95% CI excludes 0)`,
    columns: ["MODEL", ...g.harnesses.map((h) => h.toUpperCase())],
    rows,
    lines,
  };
}
