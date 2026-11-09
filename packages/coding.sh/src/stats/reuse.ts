// REUSE (AG-17): a certified-promotion budget for loops that reuse one eval set.
//
// Sun, Zeng, She, Wang, "Which Self-Improvements Should We Trust? Reliable
// Self-Improvement When Agents Reuse Their Benchmarks", arXiv 2609.33180v2.
// Round t after p promotions gives each of K candidates the error budget
//   δ_{t,p} = α · w_t · v_p / (C(t−1, p) · K^{p+1})            (eq. 4)
// with w_t = 1/(t(t+1)) (or 1/T over a horizon T) and v_p = 1/((p+1)(p+2)). One
// union bound over every decision history then covers best-of-K selection, many
// rounds and adaptive dependence (Thm 1): the chance of any false promotion stays
// ≤ α. A candidate is promoted when an exact one-sided paired sign test passes at
// ρ·δ (eq. 3); its gain gets a certificate at (1−ρ)·δ, the larger of an
// empirical-Bernstein bound (Lemma A1) and a Clopper-Pearson sign bound (Lemma A3).
import { binomUpperTail } from "./tests.ts";

export type ReuseWeights = { kind: "harmonic" } | { kind: "horizon"; rounds: number };

function lchoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  k = Math.min(k, n - k);
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

function checkUnit(name: string, x: number): void {
  if (!(x > 0 && x < 1)) throw new RangeError(`reuse: ${name} must be in (0, 1), got ${x}`);
}
function checkK(K: number): void {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`reuse: K must be a whole number ≥ 1, got ${K}`);
}
function checkTP(t: number, p: number, maxP: number): void {
  if (!Number.isInteger(t) || t < 1) throw new RangeError(`reuse: t must be a whole number ≥ 1, got ${t}`);
  if (!Number.isInteger(p) || p < 0 || p > maxP) throw new RangeError(`reuse: p must be a whole number in [0, ${maxP}], got ${p}`);
}
function checkWeights(w: ReuseWeights): void {
  if (w.kind === "horizon" && !(Number.isInteger(w.rounds) && w.rounds >= 1)) throw new RangeError(`reuse: horizon rounds must be a whole number ≥ 1, got ${w.rounds}`);
}
function checkCounts(nPlus: number, nMinus: number, n: number): void {
  for (const [k, v] of [["nPlus", nPlus], ["nMinus", nMinus], ["n", n]] as const) if (!Number.isInteger(v) || v < 0) throw new RangeError(`reuse: ${k} must be a whole number ≥ 0, got ${v}`);
  if (nPlus + nMinus > n) throw new RangeError(`reuse: nPlus + nMinus (${nPlus + nMinus}) exceeds n (${n})`);
}

/** w_t: the share of α round t may spend. */
export function reuseRoundWeight(t: number, weights: ReuseWeights): number {
  if (weights.kind === "harmonic") return 1 / (t * (t + 1));
  return t <= weights.rounds ? 1 / weights.rounds : 0;
}

/** v_p: the share of a round's budget for decision histories with p promotions so far. */
export function reusePromotionWeight(p: number): number {
  return 1 / ((p + 1) * (p + 2));
}

export interface ReuseDeltaOpts {
  alpha: number;
  /** Round, 1-based. */
  t: number;
  /** Promotions before this round, 0..t−1. */
  p: number;
  /** Candidates tested per round. */
  K: number;
  weights: ReuseWeights;
}

/** ln δ_{t,p}; −∞ when w_t = 0. Stays finite where δ itself underflows. */
export function reuseLogDelta(o: ReuseDeltaOpts): number {
  checkUnit("alpha", o.alpha);
  checkK(o.K);
  checkWeights(o.weights);
  checkTP(o.t, o.p, o.t - 1);
  const w = reuseRoundWeight(o.t, o.weights);
  if (w === 0) return -Infinity;
  return Math.log(o.alpha) + Math.log(w) + Math.log(reusePromotionWeight(o.p)) - lchoose(o.t - 1, o.p) - (o.p + 1) * Math.log(o.K);
}

/** δ_{t,p} = α·w_t·v_p / (C(t−1,p)·K^{p+1}) (eq. 4), computed in log space; 0 when w_t = 0. */
export function reuseDelta(o: ReuseDeltaOpts): number {
  return Math.exp(reuseLogDelta(o));
}

let logFact = new Float64Array([0, 0]);
function lf(n: number): Float64Array {
  if (n >= logFact.length) {
    const t = new Float64Array(Math.max(n + 1, logFact.length * 2));
    t.set(logFact);
    for (let i = logFact.length; i < t.length; i++) t[i] = t[i - 1]! + Math.log(i);
    logFact = t;
  }
  return logFact;
}

/** Exact one-sided paired sign test: P(Bin(M, ½) ≥ nPlus); 1 when M = 0. */
export function signP(nPlus: number, M: number): number {
  if (!Number.isInteger(nPlus) || !Number.isInteger(M) || M < 0) throw new RangeError(`signP: nPlus and M must be whole numbers, M ≥ 0 (got ${nPlus}, ${M})`);
  if (nPlus <= 0) return 1;
  if (nPlus > M) return 0;
  // Same sum as binomUpperTail(nPlus, M, ½), with the log-factorial table kept between calls.
  const t = lf(M);
  const base = t[M]! - M * Math.LN2;
  let s = 0;
  for (let i = nPlus; i <= M; i++) s += Math.exp(base - t[i]! - t[M - i]!);
  return Math.min(1, s);
}

/** Clean wins (n+ with n− = 0) a candidate needs to pass at `threshold`: ceil(log2(1/threshold)). */
export function minCleanWins(threshold: number): number {
  if (!(threshold > 0)) return Infinity;
  return Math.max(0, Math.ceil(Math.log2(1 / threshold) - 1e-12));
}

/** One-sided Clopper-Pearson lower bound: θ with P(Bin(m, θ) ≥ k) = a; 0 when k = 0. */
export function clopperPearsonLower(k: number, m: number, a: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 0 || k > m) throw new RangeError(`clopperPearsonLower: need whole numbers 0 ≤ k ≤ m, got k=${k}, m=${m}`);
  if (!(a > 0 && a < 1)) throw new RangeError(`clopperPearsonLower: a must be in (0, 1), got ${a}`);
  if (k === 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (binomUpperTail(k, m, mid) < a) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Bernoulli KL divergence kl(p ‖ q). */
function kl(p: number, q: number): number {
  const t = (x: number, y: number) => (x === 0 ? 0 : y === 0 ? Infinity : x * Math.log(x / y));
  return t(p, q) + t(1 - p, 1 - q);
}

function lcbFromMoments(mean: number, m2: number, n: number, L: number): number {
  if (n === 0) return -Infinity;
  // s⁺: the largest q in [m2, 1] with n·kl(m2 ‖ q) ≤ L (kl grows in q above m2).
  let sPlus: number;
  if (n * kl(m2, 1) <= L) sPlus = 1;
  else {
    let lo = m2;
    let hi = 1;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (n * kl(m2, mid) <= L) lo = mid;
      else hi = mid;
    }
    sPlus = lo;
  }
  const a = (2 * L) / (3 * n);
  return mean - (a + Math.sqrt(a * a + (2 * sPlus * L) / n));
}

/**
 * Empirical-Bernstein lower bound on the mean of paired differences z ∈ [−1, 1]
 * (Lemma A1, eqs. 5-7): mean(z) − ε(s⁺, L) with ε(v, L) = 2L/(3n) + sqrt((2L/(3n))² + 2vL/n)
 * and s⁺ the KL upper bound on mean(z²). −∞ for an empty sample.
 */
export function pairedLcb(z: readonly number[], L: number): number {
  const n = z.length;
  if (n === 0) return -Infinity;
  let s = 0;
  let s2 = 0;
  for (const x of z) {
    s += x;
    s2 += x * x;
  }
  return lcbFromMoments(s / n, Math.min(1, s2 / n), n, L);
}

export interface PassFailCounts {
  /** Cases the candidate passed and the incumbent failed. */
  nPlus: number;
  /** Cases the incumbent passed and the candidate failed. */
  nMinus: number;
  /** All paired cases. */
  n: number;
}

/**
 * Certified lower bound on the paired pass-rate gain at error δc (Lemma A3):
 * the larger of the empirical-Bernstein bound at L = ln(4/δc) and the sign bound
 * (2·q_lo − 1)·d_lo, with q_lo = CP(n+; M, δc/4) and d_lo = CP(M; n, δc/4)
 * (the sign bound is −∞ unless q_lo > ½).
 */
export function passFailLcb(c: PassFailCounts, deltaC: number): number {
  checkCounts(c.nPlus, c.nMinus, c.n);
  checkUnit("deltaC", deltaC);
  if (c.n === 0) return -Infinity;
  const M = c.nPlus + c.nMinus;
  const eb = lcbFromMoments((c.nPlus - c.nMinus) / c.n, M / c.n, c.n, Math.log(4 / deltaC));
  if (M === 0) return eb;
  const qLo = clopperPearsonLower(c.nPlus, M, deltaC / 4);
  const dLo = clopperPearsonLower(M, c.n, deltaC / 4);
  const sgn = qLo > 0.5 ? (2 * qLo - 1) * dLo : -Infinity;
  return Math.max(eb, sgn);
}

export interface ReuseState {
  alpha: number;
  /** Share of δ spent on the promotion test; the rest certifies the gain (default 0.5). */
  rho?: number;
  K: number;
  weights: ReuseWeights;
  /** This round, 1-based. */
  t: number;
  /** Promotions so far. */
  p: number;
  /** Running certified gain C_t (sum of max(ℓ*, 0) over promotions). */
  C: number;
}

export interface ReuseCandidate extends PassFailCounts {
  id: string;
}

export interface ReuseRoundRow {
  id: string;
  /** One-sided sign-test p-value P(Bin(n+ + n−, ½) ≥ n+). */
  p: number;
  pass: boolean;
  /** Mean paired difference (n+ − n−)/n. */
  zbar: number;
}

export interface ReuseRoundResult {
  delta: number;
  /** ρ·δ: the sign test's level. */
  threshold: number;
  minCleanWins: number;
  rows: ReuseRoundRow[];
  /** The passing candidate with the largest z̄ (ties by id); absent when none passes. */
  promoted?: string;
  /** Its certificate ℓ* at (1−ρ)·δ. */
  ell?: number;
  /** Running certified gain after this round. */
  C: number;
  /** The state for the next round. */
  next: ReuseState;
}

/** One round: test up to K candidates against the incumbent, promote at most one, certify its gain. */
export function reuseRound(state: ReuseState, cands: readonly ReuseCandidate[]): ReuseRoundResult {
  const rho = state.rho ?? 0.5;
  checkUnit("rho", rho);
  if (cands.length > state.K) throw new RangeError(`reuse: ${cands.length} candidates in a round budgeted for K = ${state.K}`);
  const delta = reuseDelta(state);
  const threshold = rho * delta;
  const rows: ReuseRoundRow[] = cands.map((c) => {
    checkCounts(c.nPlus, c.nMinus, c.n);
    const p = signP(c.nPlus, c.nPlus + c.nMinus);
    return { id: c.id, p, pass: threshold > 0 && p <= threshold, zbar: c.n ? (c.nPlus - c.nMinus) / c.n : 0 };
  });
  const passing = rows.filter((r) => r.pass).sort((a, b) => b.zbar - a.zbar || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const win = passing[0];
  const out: ReuseRoundResult = { delta, threshold, minCleanWins: minCleanWins(threshold), rows, C: state.C, next: { ...state, rho, t: state.t + 1 } };
  if (win) {
    const c = cands.find((x) => x.id === win.id)!;
    const ell = passFailLcb(c, (1 - rho) * delta);
    out.promoted = win.id;
    out.ell = ell;
    out.C = state.C + Math.max(ell, 0);
    out.next = { ...out.next, p: state.p + 1, C: out.C };
  }
  return out;
}

export interface ReuseDirectOpts extends PassFailCounts {
  alphaC: number;
  /** Rounds run so far. */
  t: number;
  /** Promotions so far, 0..t. */
  p: number;
  K: number;
  weights: ReuseWeights;
  /** Candidates were screened on other data before one was tested here: drop K^p. */
  screened?: boolean;
}

/**
 * Direct certificate D_t of the current incumbent against the start A0 (Prop. A1,
 * eq. 18) at δc = αc·w_t·v_p / (C(t,p)·K^p); 0 when p = 0, −∞ when δc = 0.
 */
export function reuseDirect(o: ReuseDirectOpts): number {
  checkUnit("alphaC", o.alphaC);
  checkK(o.K);
  checkWeights(o.weights);
  checkTP(o.t, o.p, o.t);
  checkCounts(o.nPlus, o.nMinus, o.n);
  if (o.p === 0) return 0;
  const w = reuseRoundWeight(o.t, o.weights);
  if (w === 0) return -Infinity;
  const ld = Math.log(o.alphaC) + Math.log(w) + Math.log(reusePromotionWeight(o.p)) - lchoose(o.t, o.p) - (o.screened ? 0 : o.p * Math.log(o.K));
  const dc = Math.exp(ld);
  if (!(dc > 0)) return -Infinity;
  return passFailLcb(o, Math.min(dc, 0.999999));
}

/** Smallest detectable gain at n cases with discordance d and error δ (Prop. 1): sqrt(2·d·ln(2/δ)/n). */
export function reuseMde(o: { n: number; d: number; delta: number }): number {
  return Math.sqrt((2 * o.d * Math.log(2 / o.delta)) / o.n);
}

export interface ReuseScheduleRow {
  t: number;
  p: number;
  delta: number;
  minCleanWins: number;
}

/** δ and the clean wins needed per round and promotion count, to show before spending. */
export function reuseSchedule(o: { alpha: number; rho?: number; K: number; weights: ReuseWeights; rounds: number; maxP?: number }): ReuseScheduleRow[] {
  const rho = o.rho ?? 0.5;
  checkUnit("rho", rho);
  const maxP = o.maxP ?? 3;
  const rows: ReuseScheduleRow[] = [];
  for (let t = 1; t <= o.rounds; t++) {
    for (let p = 0; p <= Math.min(t - 1, maxP); p++) {
      const delta = reuseDelta({ alpha: o.alpha, t, p, K: o.K, weights: o.weights });
      rows.push({ t, p, delta, minCleanWins: minCleanWins(rho * delta) });
    }
  }
  return rows;
}
