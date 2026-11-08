// Power analysis and trial-consistency metrics for paired experiment
// comparisons. The minimum detectable effect (MDE) follows Miller, "Adding
// Error Bars to Evals" (2024), Eq. 10, for the paired design: the variance
// that matters is that of per-case (B − A) differences, so with k trials per
// case the case is the cluster and the MDE is honest about correlated
// attempts. pass^k is tau-bench's consistency metric: a case counts only when
// every one of its k trials passed.
import type { CaseRun } from "../datasets/types.ts";

export { normalQuantile } from "../stats/normal.ts";
import { normalQuantile } from "../stats/normal.ts";
import { mcnemarPlan, type McNemarPlan } from "../stats/mcnemar-power.ts";

/**
 * "below-mde": a non-significant result smaller than the MDE (the design could
 * not have detected it). "near-mde": a significant result smaller than the
 * MDE, so the direction holds but the size is likely overstated. "no-power":
 * the exact McNemar test cannot reach the target power for any gap at this
 * number of cases and discordance.
 */
export type PowerWarningCode = "too-few" | "no-change" | "small-n" | "below-mde" | "near-mde" | "no-power";

export interface PowerWarning {
  code: PowerWarningCode;
  message: string;
}

/**
 * Run-to-run noise of one config on one dataset, measured by an A/A run
 * (`exp aa`): the same config twice, compared as if it were A and B.
 */
export interface NoisePrior {
  /** Sample SD of per-case (second − first) differences. */
  sd: number;
  /** Share of paired cases whose majority outcome flipped between the two runs. */
  flipRate: number;
  /** Paired cases the A/A run measured. */
  paired: number;
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
  /**
   * The A/A noise floor, when one was given. `used` is true when its SD was
   * larger than the observed one, so the MDE above is computed from it.
   */
  noise?: NoisePrior & { used: boolean };
  /**
   * The exact McNemar design (stats/mcnemar-power.ts), when the discordant
   * counts were given and some case is discordant: the power ceiling and the
   * exact MDE (NaN when no gap reaches `power`). Its discordance is the
   * observed one, raised to the A/A flip rate when that is larger.
   */
  exact?: McNemarPlan;
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
  /**
   * A/A noise floor for this config and dataset. The MDE uses the larger of
   * its SD and the observed one: a comparison where few cases happened to
   * change cannot claim to detect effects smaller than run-to-run noise.
   */
  noise?: NoisePrior;
  /**
   * The McNemar discordant counts behind the differences (b: A passed and B
   * failed, c: the reverse). With them the analysis adds the exact McNemar
   * power ceiling and MDE (`exact`) and the "no-power" warning.
   */
  discordant?: { b: number; c: number };
}

const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

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
  const floor = opts.noise && opts.noise.sd > 0 ? opts.noise.sd : undefined;
  const useFloor = floor !== undefined && n >= 2 && !(sd >= floor);
  const planSd = useFloor ? (floor as number) : sd;
  const mde = planSd > 0 ? (z * planSd) / Math.sqrt(n) : NaN;
  const warnings: PowerWarning[] = [];
  const level = `α ${alpha}, power ${Math.round(power * 100)}%`;
  // The exact test's view: discordance from the counts, never below the A/A flip rate.
  let exact: McNemarPlan | undefined;
  if (opts.discordant && n >= 2) {
    const d = Math.min(1, Math.max((opts.discordant.b + opts.discordant.c) / n, opts.noise?.flipRate ?? 0));
    if (d > 0) exact = mcnemarPlan(n, d, { alpha, power });
  }
  const noPower = exact !== undefined && Number.isNaN(exact.mde);
  // The larger MDE is the honest one: the normal approximation is optimistic at small n.
  const bar = exact && !noPower ? Math.max(Number.isFinite(mde) ? mde : 0, exact.mde) : mde;
  if (n < 2) {
    warnings.push({ code: "too-few", message: `only ${n} paired case(s): too few to estimate the minimum detectable effect` });
  } else {
    if (n < minPaired) {
      warnings.push({
        code: "small-n",
        message: `only ${n} paired cases (< ${minPaired}): small suites detect only large effects and their intervals can under-cover; add cases or trials before trusting a null result`,
      });
    }
    if (sd === 0 && observed === 0 && !useFloor && !exact) {
      warnings.push({ code: "no-change", message: "no paired case changed between A and B, so the minimum detectable effect cannot be estimated from these runs" });
    } else if (noPower) {
      const x = exact as McNemarPlan;
      warnings.push({
        code: "no-power",
        message:
          `at ${n} paired cases and ${pct(x.discordance)} discordance no difference reaches ${Math.round(power * 100)}% power (the exact McNemar ceiling is ${pct(x.ceiling)}; ` +
          `it needs at least ${x.minDiscordant} discordant cases to reject at alpha ${alpha})` +
          (opts.significant ? ": the direction may hold, but an underpowered test that reaches significance tends to exaggerate the effect" : ""),
      });
    } else if (Number.isFinite(bar) && Math.abs(observed) < bar && opts.significant) {
      warnings.push({
        code: "near-mde",
        message: `observed |B − A| ${pp(Math.abs(observed))} is significant but below the minimum detectable effect ${pp(bar)} (${level}): the direction holds, but its magnitude may be overstated (underpowered tests that reach significance tend to exaggerate the effect)`,
      });
    } else if (Number.isFinite(bar) && Math.abs(observed) < bar) {
      warnings.push({
        code: "below-mde",
        message: `observed |B − A| ${pp(Math.abs(observed))} is below the minimum detectable effect ${pp(bar)} (${level}): this comparison cannot reliably detect a difference this small`,
      });
    }
  }
  const out: PowerAnalysis = { alpha, power, n, observed, sd, mde, minPaired, warnings };
  if (opts.noise) out.noise = { sd: opts.noise.sd, flipRate: opts.noise.flipRate, paired: opts.noise.paired, used: useFloor };
  if (exact) out.exact = exact;
  return out;
}

/**
 * The exact McNemar part of a power line: ` · exact MDE 10.6pp` or ` · no 80%
 * power at this n (exact McNemar ceiling 62%)`; empty without an exact design.
 */
export function exactPowerText(p: Pick<PowerAnalysis, "exact" | "power">): string {
  const x = p.exact;
  if (!x) return "";
  return Number.isNaN(x.mde) ? ` · no ${Math.round(p.power * 100)}% power at this n (exact McNemar ceiling ${pct(x.ceiling)})` : ` · exact MDE ${pp(x.mde)}`;
}

/**
 * Paired cases needed to detect a true |B − A| of `effect` with probability
 * `power` at level `alpha`, given an SD of per-case differences (e.g. the A/A
 * noise floor): ⌈((z₁₋α/₂ + z_power) · sd / effect)²⌉. NaN without spread.
 */
export function casesFor(effect: number, sd: number, opts: { alpha?: number; power?: number } = {}): number {
  const z = normalQuantile(1 - (opts.alpha ?? 0.05) / 2) + normalQuantile(opts.power ?? 0.8);
  return effect > 0 && sd > 0 ? Math.ceil(((z * sd) / effect) ** 2) : NaN;
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
