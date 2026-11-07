// `judge sample` (AB-16): which cases humans should label next, as a
// confidence-stratified random design; and `judge calibrate --plan` (AB-17):
// the human-audited pass rate from the labelled picks.
//
//   Choi et al., "From Self-Confidence to Statistical Accuracy", arXiv
//   2610.35698, §3.1-3.2, App. B.2 and C (https://arxiv.org/abs/2610.35698).
//
// A judge's confidence is a valid stratification variable even when it is
// miscalibrated. Strata are judge verdict × confidence bin; labels are
// allocated in proportion to stratum size and drawn at random inside each
// stratum, so the design is self-weighting: calibrate()'s unweighted κ,
// sensitivity and specificity stay unbiased, and the stratified mean (Eq.1-3)
// gives an unbiased human pass rate. Labelling the low-confidence or
// "interesting" outputs instead biases both (verification bias, Begg and
// Greenes 1983). Neyman or two-stage allocation gains ~0.05 pp and would need
// inverse-probability weights in calibrate, so it is out of scope.
import { mulberry32 } from "../stats/prng.ts";
import { allocateProportional, binStrata, hoeffdingBudget, stratifiedMean } from "../stats/stratified.ts";
import type { HumanLabel, JudgedCase } from "./calibrate.ts";

export interface AuditStratum {
  key: string;
  /** "all" when the budget was too small to stratify. */
  verdict: "pass" | "fail" | "unjudged" | "all";
  /** Confidence range [lo, hi); null when the judge gave none (or no verdict). */
  lo: number | null;
  hi: number | null;
  /** Cases in the population. */
  N: number;
  /** Picks allocated. */
  n: number;
}

export interface AuditPick {
  caseId: string;
  stratum: string;
  /** A human label already exists for this case (it stays in the draw so the design stays random). */
  alreadyLabelled: boolean;
  sessionId?: string;
}

export interface AuditPlan {
  kind: "coding.sh/audit-plan";
  version: 1;
  experimentId?: string;
  graderId?: string;
  split?: string;
  criterion?: string;
  seed: number;
  /** Requested budget; `picks.length` is what was allocated (clamped to the population). */
  budget: number;
  population: number;
  strata: AuditStratum[];
  picks: AuditPick[];
  warnings: string[];
}

export interface PlanAuditOpts {
  verdicts: ReadonlyMap<string, JudgedCase>;
  /** Case ids to estimate over (e.g. the test split's cases the experiment ran). */
  population: readonly string[];
  /** Case ids that already carry a human label. */
  labelled: ReadonlySet<string>;
  budget: number;
  seed?: number;
  /** Smallest confidence bin before it merges into a neighbour. Default 25. */
  minStratum?: number;
  /** Source session per case, for the viewer's pass/fail buttons. */
  sessions?: ReadonlyMap<string, string>;
  experimentId?: string;
  graderId?: string;
  split?: string;
  criterion?: string;
}

/** Same fallback as calibrate(): model-reported confidence, else |score − 0.5| · 2. */
export const confidenceOf = (v: JudgedCase): number | undefined => (v.confidence !== undefined ? v.confidence : v.score !== undefined ? Math.min(1, Math.abs(v.score - 0.5) * 2) : undefined);

const r2 = (x: number) => x.toFixed(2);

/** Worst-case half-width of the plan at 95%: √(log(2/δ) Σ π_j²/n_j / 2) (Eq.3). */
function planEps(strata: readonly AuditStratum[], N: number): number {
  let h = 0;
  for (const s of strata) if (s.N > 0) h += (s.N / N) ** 2 / s.n;
  return Math.sqrt((Math.log(2 / 0.05) * h) / 2);
}

/** A confidence-stratified, proportionally allocated, seeded random label plan. */
export function planAudit(opts: PlanAuditOpts): AuditPlan {
  const seed = opts.seed ?? 0;
  const minStratum = opts.minStratum ?? 25;
  if (!(Number.isInteger(opts.budget) && opts.budget >= 1)) throw new RangeError(`planAudit: budget must be a positive integer (got ${opts.budget})`);
  if (!(Number.isInteger(seed) && seed >= 0)) throw new RangeError(`planAudit: seed must be a non-negative integer (got ${seed})`);
  if (!(Number.isInteger(minStratum) && minStratum >= 1)) throw new RangeError(`planAudit: minStratum must be a positive integer (got ${minStratum})`);
  const population = [...new Set(opts.population)].sort();
  const warnings: string[] = [];
  // Members per stratum, in a fixed order: pass bins (low → high confidence), fail bins, unjudged.
  let groups: { s: Omit<AuditStratum, "n">; ids: string[] }[] = [];
  for (const verdict of ["pass", "fail"] as const) {
    const ids = population.filter((id) => opts.verdicts.get(id)?.pass === (verdict === "pass"));
    if (!ids.length) continue;
    const { index, strata } = binStrata(
      ids.map((id) => confidenceOf(opts.verdicts.get(id)!)),
      { minSize: minStratum },
    );
    strata.forEach((b, j) => {
      const members = ids.filter((_, i) => index[i] === j);
      if (!members.length) return;
      const key = b.unknown ? `${verdict} no-confidence` : `${verdict} ${r2(b.lo)}-${r2(b.hi)}`;
      groups.push({ s: { key, verdict, lo: b.unknown ? null : b.lo, hi: b.unknown ? null : b.hi, N: members.length }, ids: members });
    });
  }
  const unjudged = population.filter((id) => !opts.verdicts.has(id));
  if (unjudged.length) groups.push({ s: { key: "unjudged", verdict: "unjudged", lo: null, hi: null, N: unjudged.length }, ids: unjudged });
  if (groups.length > opts.budget) {
    warnings.push(`budget ${opts.budget} is below the ${groups.length} strata: picks are a simple random sample of the whole population, unstratified`);
    groups = [{ s: { key: "all", verdict: "all", lo: null, hi: null, N: population.length }, ids: population }];
  }
  const N = population.length;
  const { n, clamped } = allocateProportional(
    groups.map((g) => g.s.N),
    opts.budget,
  );
  if (clamped) warnings.push(`budget ${opts.budget} is above the ${N} cases in the population: every case is picked`);
  const rand = mulberry32(seed);
  const picks: AuditPick[] = [];
  const strata: AuditStratum[] = groups.map((g, j) => {
    // Seeded Fisher–Yates over the whole stratum, labelled cases included, then the first n_j.
    const pool = g.ids.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const k = Math.floor(rand() * (i + 1));
      [pool[i], pool[k]] = [pool[k]!, pool[i]!];
    }
    for (const caseId of pool.slice(0, n[j]!).sort()) {
      const p: AuditPick = { caseId, stratum: g.s.key, alreadyLabelled: opts.labelled.has(caseId) };
      const sid = opts.sessions?.get(caseId);
      if (sid) p.sessionId = sid;
      picks.push(p);
    }
    return { ...g.s, n: n[j]! };
  });
  const need = hoeffdingBudget(0.05, 0.05);
  if (N > 0 && picks.length < need && picks.length < N) {
    warnings.push(`±${(planEps(strata, N) * 100).toFixed(1)} pp at 95% worst-case with this budget (±5 pp needs ${need} labels)`);
  }
  const plan: AuditPlan = { kind: "coding.sh/audit-plan", version: 1, seed, budget: opts.budget, population: N, strata, picks, warnings };
  if (opts.experimentId) plan.experimentId = opts.experimentId;
  if (opts.graderId) plan.graderId = opts.graderId;
  if (opts.split) plan.split = opts.split;
  if (opts.criterion) plan.criterion = opts.criterion;
  return plan;
}

/** Validate a plan read from disk (written by `judge sample --out`). */
export function parseAuditPlan(raw: unknown): AuditPlan {
  const o = raw as Partial<AuditPlan> | null;
  if (!o || typeof o !== "object" || o.kind !== "coding.sh/audit-plan" || o.version !== 1) throw new TypeError("not a coding.sh audit plan (write one with `coding.sh judge sample --out plan.json`)");
  if (!Array.isArray(o.strata) || !Array.isArray(o.picks) || typeof o.seed !== "number") throw new TypeError("audit plan is missing strata, picks or seed");
  const keys = new Set<string>();
  for (const s of o.strata) {
    if (!s || typeof s.key !== "string" || !Number.isInteger(s.N) || !Number.isInteger(s.n) || s.n > s.N || s.n < 0) throw new TypeError("audit plan has a malformed stratum");
    keys.add(s.key);
  }
  for (const p of o.picks) if (!p || typeof p.caseId !== "string" || !keys.has(p.stratum)) throw new TypeError("audit plan has a pick outside its strata");
  return o as AuditPlan;
}

export interface AuditedPassRate {
  /** Stratified human pass rate over the labelled picks (Eq.1); NaN when a stratum has none labelled. */
  p: number;
  lo: number;
  hi: number;
  /** Worst-case 95% half-width over the labelled picks (Eq.3). */
  hoeffdingEps: number;
  /** Labelled picks / picks. */
  coverage: number;
  labelled: number;
  picks: number;
  /** The plan's estimate if every unlabelled pick were a fail (lo) or a pass (hi). */
  bounds: { lo: number; hi: number };
  strata: { key: string; N: number; n: number; labelled: number; passed: number }[];
}

/**
 * Human-audited pass rate from a plan's labelled picks. A pick counts once its
 * human votes have a majority (as in calibrate); ties and missing labels are
 * unlabelled.
 */
export function auditedPassRate(plan: AuditPlan, labels: readonly HumanLabel[], criterion?: string): AuditedPassRate {
  const votes = new Map<string, { pass: number; fail: number }>();
  for (const l of labels) {
    if (l.value === "skip") continue;
    if (criterion !== undefined && l.criterion !== undefined && l.criterion !== criterion) continue;
    const v = votes.get(l.caseId) ?? { pass: 0, fail: 0 };
    v[l.value]++;
    votes.set(l.caseId, v);
  }
  const per = new Map(plan.strata.map((s) => [s.key, { key: s.key, N: s.N, n: s.n, labelled: 0, passed: 0 }]));
  for (const p of plan.picks) {
    const v = votes.get(p.caseId);
    if (!v || v.pass === v.fail) continue;
    const s = per.get(p.stratum)!;
    s.labelled++;
    if (v.pass > v.fail) s.passed++;
  }
  const strata = [...per.values()];
  const est = stratifiedMean(strata.map((s) => ({ N: s.N, n: s.labelled, successes: s.passed })));
  const N = strata.reduce((a, s) => a + s.N, 0);
  let blo = 0;
  let bhi = 0;
  for (const s of strata) {
    if (!s.N || !s.n) continue;
    const pi = s.N / N;
    blo += (pi * s.passed) / s.n;
    bhi += (pi * (s.passed + s.n - s.labelled)) / s.n;
  }
  const labelled = strata.reduce((a, s) => a + s.labelled, 0);
  const picks = plan.picks.length;
  return { p: est.p, lo: est.lo, hi: est.hi, hoeffdingEps: est.hoeffdingEps, coverage: picks ? labelled / picks : 0, labelled, picks, bounds: { lo: blo, hi: bhi }, strata };
}
