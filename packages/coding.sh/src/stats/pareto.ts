// Bayesian-bootstrap Pareto support (ParetoSaddler, Qian et al., arXiv
// 2611.02079 §3, Alg. 1): how sure are we that a candidate is credible
// progress over its parent in quality OR cost? Each draw puts Dirichlet(1)
// weights on each case's runs per arm (one weight vector for both quality and
// cost, so a run's q and c stay together) and, by default, Dirichlet(1)
// weights on the cases (shared by both arms). The event is
//   (dQ > 0 and dC ≤ εC)  or  (dC < 0 and dQ ≥ −εQ)
// and support is its share of draws; promote when support ≥ γ and an exact
// sign-flip test over cases agrees at level 1 − γ (see ParetoSupport.exact).
import { mulberry32 } from "./prng.ts";
import { quantileSorted } from "./summary.ts";
import { clusterSignFlip } from "./tests.ts";

/** One run's quality (pass = 1, or a partial score) and cost (USD, tokens, …). */
export interface QC {
  q: number;
  c: number;
}

export interface ParetoCase {
  id: string;
  base: readonly QC[];
  cand: readonly QC[];
}

export interface ParetoOpts {
  /** Bootstrap draws. Default 10000. */
  draws?: number;
  seed?: number;
  /** Promote when support ≥ gamma. Default 0.7. */
  gamma?: number;
  /** Quality the cost branch may give up. Default 0.1 (10 pp on pass rate). */
  epsQ?: number;
  /** Cost rise the quality branch may take: relative (0.2 = +20%) or absolute. Default Infinity. */
  epsC?: number;
  /** dC as (C+ − C−) / C− ("relative", default) or C+ − C− ("absolute"). */
  costScale?: "relative" | "absolute";
  /**
   * "dirichlet" (default): also resample cases, one Dirichlet(1) vector per
   * draw shared by both arms. "equal": every case weighs the same, as in the
   * paper (with one run per case that is the plain mean gate).
   */
  caseWeights?: "dirichlet" | "equal";
  /** Two-sided level for the dQ / dC intervals. Default 0.05. */
  alpha?: number;
}

export interface ParetoSupport {
  /** Share of draws where the candidate is credible progress in quality or cost. */
  support: number;
  /** support ≥ gamma and min(exact.pQuality, exact.pCost) ≤ exact.level. */
  promote: boolean;
  /**
   * Exact one-sided sign-flip tests over cases (Monte Carlo above 20): pQuality
   * of "per-case quality did not rise", pCost of "per-case cost did not fall".
   * level is 1 − gamma. When every case moves the same way the support is 1 at
   * any number of cases, so this is what keeps 1 task from promoting: its p is
   * 1/2, and it takes 2 cases to reach 1/4 ≤ 0.3.
   */
  exact: { pQuality: number; pCost: number; level: number };
  /** Share of draws with dQ > 0 and dC ≤ εC. */
  pQualityGain: number;
  /** Share of draws with dC < 0 and dQ ≥ −εQ. */
  pCostCut: number;
  /** Of the draws that count, the share each branch holds in (both can hold at once). */
  branchShares: { quality: number; cost: number };
  /** Candidate − base quality (mean over cases), with an equal-tailed interval over draws. */
  dQ: { mean: number; lo: number; hi: number };
  /** Candidate vs base cost on `scale`, with an equal-tailed interval over draws. */
  dC: { mean: number; lo: number; hi: number; scale: "relative" | "absolute" };
  draws: number;
  /** Cases used. */
  cases: number;
  /** Runs used per arm. */
  runs: { base: number; cand: number };
  gamma: number;
  epsQ: number;
  epsC: number;
  /** Case ids left out: no usable run in one arm. */
  skipped: string[];
  notes: string[];
}

/** a is at least as good as b on both (higher q, lower c) and strictly better on one. */
export function dominates(a: QC, b: QC): boolean {
  return a.q >= b.q && a.c <= b.c && (a.q > b.q || a.c < b.c);
}

const usable = (r: QC) => Number.isFinite(r.q) && Number.isFinite(r.c);

export function paretoSupport(input: readonly ParetoCase[], o: ParetoOpts = {}): ParetoSupport {
  const draws = Math.max(1, Math.floor(o.draws ?? 10_000));
  const gamma = o.gamma ?? 0.7;
  const epsQ = o.epsQ ?? 0.1;
  const epsC = o.epsC ?? Infinity;
  const alpha = o.alpha ?? 0.05;
  const caseWeights = o.caseWeights ?? "dirichlet";
  const notes: string[] = [];
  const skipped: string[] = [];
  const cases: { base: QC[]; cand: QC[] }[] = [];
  for (const c of input) {
    const base = c.base.filter(usable);
    const cand = c.cand.filter(usable);
    if (!base.length || !cand.length) skipped.push(c.id);
    else cases.push({ base, cand });
  }
  const n = cases.length;
  const runs = { base: cases.reduce((s, c) => s + c.base.length, 0), cand: cases.reduce((s, c) => s + c.cand.length, 0) };
  // Point estimates: equal weights on cases and runs.
  const avg = (xs: readonly QC[], f: (r: QC) => number) => xs.reduce((s, r) => s + f(r), 0) / xs.length;
  const pointC = n ? cases.reduce((s, c) => s + avg(c.base, (r) => r.c), 0) / n : NaN;
  let scale = o.costScale ?? "relative";
  if (scale === "relative" && !(pointC > 0)) {
    scale = "absolute";
    if (n) notes.push("base cost is not above 0, so the cost change is absolute, not relative");
  }
  const empty = { mean: NaN, lo: NaN, hi: NaN };
  if (!n) {
    notes.push("no case has a usable run in both arms");
    return { support: 0, promote: false, exact: { pQuality: 1, pCost: 1, level: 1 - gamma }, pQualityGain: 0, pCostCut: 0, branchShares: { quality: 0, cost: 0 }, dQ: empty, dC: { ...empty, scale }, draws: 0, cases: 0, runs, gamma, epsQ, epsC, skipped, notes };
  }
  if (cases.every((c) => c.base.length === 1 && c.cand.length === 1)) {
    notes.push(caseWeights === "equal" ? "no within-case replicates: equal-weight gate is the mean gate" : "no within-case replicates: support comes from resampling cases only");
  }

  const rand = mulberry32(o.seed ?? 0x5eed);
  // Dirichlet(1, …, 1): normalized Exp(1) draws; 1 − U keeps log away from 0.
  const exp1 = () => -Math.log(1 - rand());
  const weighted = (rs: readonly QC[]): [number, number] => {
    if (rs.length === 1) return [rs[0]!.q, rs[0]!.c];
    let w = 0;
    let q = 0;
    let cost = 0;
    for (const r of rs) {
      const e = exp1();
      w += e;
      q += e * r.q;
      cost += e * r.c;
    }
    return [q / w, cost / w];
  };
  const dQs = new Float64Array(draws);
  const dCs = new Float64Array(draws);
  const caseW = new Float64Array(n);
  let event = 0;
  let quality = 0;
  let cost = 0;
  for (let d = 0; d < draws; d++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      caseW[i] = caseWeights === "equal" ? 1 : exp1();
      total += caseW[i]!;
    }
    let qb = 0;
    let qc = 0;
    let cb = 0;
    let cc = 0;
    for (let i = 0; i < n; i++) {
      const w = caseW[i]! / total;
      const [bq, bc] = weighted(cases[i]!.base);
      const [aq, ac] = weighted(cases[i]!.cand);
      qb += w * bq;
      cb += w * bc;
      qc += w * aq;
      cc += w * ac;
    }
    const dq = qc - qb;
    const dc = scale === "relative" ? (cc - cb) / cb : cc - cb;
    dQs[d] = dq;
    dCs[d] = dc;
    const qBranch = dq > 0 && dc <= epsC;
    const cBranch = dc < 0 && dq >= -epsQ;
    if (qBranch) quality++;
    if (cBranch) cost++;
    if (qBranch || cBranch) event++;
  }
  const interval = (xs: Float64Array) => {
    const s = Array.from(xs).sort((x, y) => x - y);
    return { mean: s.reduce((t, x) => t + x, 0) / s.length, lo: quantileSorted(s, alpha / 2), hi: quantileSorted(s, 1 - alpha / 2) };
  };
  const support = event / draws;
  // Per-case mean differences; the sign of a cost change is the same on either scale.
  const seed = o.seed ?? 0x5eed;
  const pQuality = clusterSignFlip(
    cases.map((c) => avg(c.cand, (r) => r.q) - avg(c.base, (r) => r.q)),
    { alternative: "greater", seed },
  ).p;
  const pCost = clusterSignFlip(
    cases.map((c) => avg(c.cand, (r) => r.c) - avg(c.base, (r) => r.c)),
    { alternative: "less", seed },
  ).p;
  const level = 1 - gamma;
  const exactOk = Math.min(pQuality, pCost) <= level + 1e-12;
  if (support >= gamma && !exactOk) {
    notes.push(
      `support reaches ${gamma.toFixed(2)}, but the exact sign-flip test over ${n} case${n === 1 ? "" : "s"} gives p ${Math.min(pQuality, pCost).toFixed(3)} > ${level.toFixed(2)} (1 − γ); add cases`,
    );
  }
  return {
    support,
    promote: support >= gamma && exactOk,
    exact: { pQuality, pCost, level },
    pQualityGain: quality / draws,
    pCostCut: cost / draws,
    branchShares: { quality: event ? quality / event : 0, cost: event ? cost / event : 0 },
    dQ: interval(dQs),
    dC: { ...interval(dCs), scale },
    draws,
    cases: n,
    runs,
    gamma,
    epsQ,
    epsC,
    skipped,
    notes,
  };
}

export interface FrontierOpts {
  /** Bootstrap draws. Default 10000. */
  draws?: number;
  seed?: number;
  /** As in ParetoOpts: "dirichlet" (default) also resamples cases, one vector per draw shared by every arm. */
  caseWeights?: "dirichlet" | "equal";
}

export interface FrontierPoint {
  arm: string;
  /** Share of draws in which no other arm dominates this one. */
  pFront: number;
  /** Point estimates over the shared cases: the mean of each case's mean run. */
  q: number;
  c: number;
}

/**
 * P(on the frontier) per arm (ParetoSaddler §3.3). Each draw reweights every
 * arm's runs within a case (Dirichlet(1)) and, by default, the cases (one
 * Dirichlet(1) vector shared by every arm), then counts the arms no other arm
 * dominates. Uses the cases where every arm has a usable run; empty when none.
 */
export function frontierSupport(arms: ReadonlyMap<string, ReadonlyMap<string, readonly QC[]>>, o: FrontierOpts = {}): FrontierPoint[] {
  const draws = Math.max(1, Math.floor(o.draws ?? 10_000));
  const names = [...arms.keys()];
  const runsOf = names.map((a) => {
    const m = new Map<string, QC[]>();
    for (const [id, rs] of arms.get(a)!) {
      const ok = rs.filter(usable);
      if (ok.length) m.set(id, ok);
    }
    return m;
  });
  const shared = [...(runsOf[0]?.keys() ?? [])].filter((id) => runsOf.every((m) => m.has(id))).sort();
  const n = shared.length;
  if (!n) return [];
  // cells[a][i]: arm a's runs on shared case i.
  const cells = runsOf.map((m) => shared.map((id) => m.get(id)!));
  const avg = (xs: readonly QC[], f: (r: QC) => number) => xs.reduce((s, r) => s + f(r), 0) / xs.length;
  const point = cells.map((cs) => ({ q: cs.reduce((s, rs) => s + avg(rs, (r) => r.q), 0) / n, c: cs.reduce((s, rs) => s + avg(rs, (r) => r.c), 0) / n }));

  const rand = mulberry32(o.seed ?? 0x5eed);
  const exp1 = () => -Math.log(1 - rand());
  const caseW = new Float64Array(n);
  const drawn: QC[] = names.map(() => ({ q: 0, c: 0 }));
  const front = names.map(() => 0);
  for (let d = 0; d < draws; d++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      caseW[i] = o.caseWeights === "equal" ? 1 : exp1();
      total += caseW[i]!;
    }
    for (let a = 0; a < names.length; a++) {
      let q = 0;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const rs = cells[a]![i]!;
        let rq = rs[0]!.q;
        let rc = rs[0]!.c;
        if (rs.length > 1) {
          let w = 0;
          rq = 0;
          rc = 0;
          for (const r of rs) {
            const e = exp1();
            w += e;
            rq += e * r.q;
            rc += e * r.c;
          }
          rq /= w;
          rc /= w;
        }
        const cw = caseW[i]! / total;
        q += cw * rq;
        c += cw * rc;
      }
      drawn[a] = { q, c };
    }
    for (let a = 0; a < names.length; a++) {
      if (!drawn.some((x, b) => b !== a && dominates(x, drawn[a]!))) front[a]!++;
    }
  }
  return names.map((arm, a) => ({ arm, pFront: front[a]! / draws, q: point[a]!.q, c: point[a]!.c }));
}
