// Power analysis and trial-consistency metrics for paired experiment
// comparisons. The minimum detectable effect (MDE) follows Miller, "Adding
// Error Bars to Evals" (2024), Eq. 10, for the paired design: the variance
// that matters is that of per-case (B − A) differences, so with k trials per
// case the case is the cluster and the MDE is honest about correlated
// attempts. pass^k is tau-bench's consistency metric: a case counts only when
// every one of its k trials passed.
import type { CaseRun } from "../datasets/types.ts";

/**
 * Inverse standard normal CDF (Acklam's rational approximation, relative
 * error below 1.2e-9 over (0, 1)). Returns ±Infinity at 0 and 1.
 */
export function normalQuantile(p: number): number {
  if (!(p >= 0 && p <= 1)) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  const tail = (q: number) =>
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < lo) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - lo) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * "below-mde": a non-significant result smaller than the MDE (the design could
 * not have detected it). "near-mde": a significant result smaller than the
 * MDE, so the direction holds but the size is likely overstated.
 */
export type PowerWarningCode = "too-few" | "no-change" | "small-n" | "below-mde" | "near-mde";

export interface PowerWarning {
  code: PowerWarningCode;
  message: string;
}

export interface PowerAnalysis {
  /** Two-sided significance level. */
  alpha: number;
  /** Target power (1 − β). */
  power: number;
  /** Paired cases. */
  n: number;
  /** Observed mean of per-case (B − A) differences. */
  observed: number;
  /** Sample standard deviation of per-case (B − A) differences. NaN when n < 2. */
  sd: number;
  /**
   * Smallest true |B − A| this design detects with probability `power` at
   * level `alpha`: (z₁₋α/₂ + z_power) · sd / √n. A normal approximation, so
   * optimistic for very small n (which also triggers the "small-n" warning).
   * NaN when n < 2 or the differences have no spread.
   */
  mde: number;
  /** Cases below which the suite is flagged as small. */
  minPaired: number;
  warnings: PowerWarning[];
}

export interface PowerOpts {
  alpha?: number;
  power?: number;
  /** Warn when fewer paired cases than this. Default 200 (docs/research/landscape.md, Miller/Bowyer). */
  minPaired?: number;
  /**
   * Whether the comparison already found a significant difference (its CI
   * excludes 0). Then an effect below the MDE is reported as "near-mde"
   * rather than as undetectable. Default false.
   */
  significant?: boolean;
}

const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;

/** MDE and power warnings for a paired comparison, from the per-case (B − A) differences. */
export function pairedPower(diffs: readonly number[], opts: PowerOpts = {}): PowerAnalysis {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const minPaired = opts.minPaired ?? 200;
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`pairedPower: alpha must be in (0, 1) (got ${alpha})`);
  if (!(power > 0 && power < 1)) throw new RangeError(`pairedPower: power must be in (0, 1) (got ${power})`);
  const n = diffs.length;
  const observed = n ? diffs.reduce((s, x) => s + x, 0) / n : NaN;
  const sd = n >= 2 ? Math.sqrt(diffs.reduce((s, x) => s + (x - observed) ** 2, 0) / (n - 1)) : NaN;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  const mde = sd > 0 ? (z * sd) / Math.sqrt(n) : NaN;
  const warnings: PowerWarning[] = [];
  const level = `α ${alpha}, power ${Math.round(power * 100)}%`;
  if (n < 2) {
    warnings.push({ code: "too-few", message: `only ${n} paired case(s): too few to estimate the minimum detectable effect` });
  } else {
    if (n < minPaired) {
      warnings.push({
        code: "small-n",
        message: `only ${n} paired cases (< ${minPaired}): small suites detect only large effects and their intervals can under-cover; add cases or trials before trusting a null result`,
      });
    }
    if (sd === 0 && observed === 0) {
      warnings.push({ code: "no-change", message: "no paired case changed between A and B, so the minimum detectable effect cannot be estimated from these runs" });
    } else if (Number.isFinite(mde) && Math.abs(observed) < mde && opts.significant) {
      warnings.push({
        code: "near-mde",
        message: `observed |B − A| ${pp(Math.abs(observed))} is significant but below the minimum detectable effect ${pp(mde)} (${level}): the direction holds, but its magnitude may be overstated (underpowered tests that reach significance tend to exaggerate the effect)`,
      });
    } else if (Number.isFinite(mde) && Math.abs(observed) < mde) {
      warnings.push({
        code: "below-mde",
        message: `observed |B − A| ${pp(Math.abs(observed))} is below the minimum detectable effect ${pp(mde)} (${level}): this comparison cannot reliably detect a difference this small`,
      });
    }
  }
  return { alpha, power, n, observed, sd, mde, minPaired, warnings };
}

/** Per case: did every trial pass? (pass^k with k = the case's trial count). */
export function allTrialsPass(runs: readonly CaseRun[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of runs) out.set(r.caseId, (out.get(r.caseId) ?? true) && r.pass);
  return out;
}

/** pass^k over the given case ids: share of cases whose every trial passed. NaN for no cases. */
export function passHatK(runs: readonly CaseRun[], caseIds: readonly string[]): number {
  if (!caseIds.length) return NaN;
  const all = allTrialsPass(runs);
  let k = 0;
  for (const id of caseIds) if (all.get(id)) k++;
  return k / caseIds.length;
}
