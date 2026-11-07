// Deterministic signal severity (Signals, arXiv 2611.04507v2 §3.3). A model,
// a detector or a person judges the semantic factor (how bad the consequence,
// how much waste, how reachable the harm); this code derives the scope from
// how many sessions were affected, looks up the points and does the arithmetic:
//
//   defect        s_d = min(100, C + A)
//   risk          s_r = min(100, ceil(Cp · R) + A),  R ∈ {0.4, 0.6, 0.8, 1.0}
//   inefficiency  s_i = min(100, W + A)
//
// C, Cp and W use the points 10 / 25 / 40 / 65 / 85. A is the scope points.
// A signal's severity is the max over its natures, never a sum or mean.
// Low 1-39, High 40-79, Critical 80-100. Worked example from the paper: a task
// failure (C = 40) in 5 of 30 sessions (17%, +7) = 47, High.
//
// Pure.
import type { Nature } from "./taxonomy.ts";

/** Consequence and waste points (§3.3): small, material, task failure, major, severe or until a hard limit. */
export const FACTOR_POINTS = Object.freeze([10, 25, 40, 65, 85] as const);
/** Reachability multipliers for a risk, by access path. */
export const REACH_VALUES = Object.freeze([0.4, 0.6, 0.8, 1.0] as const);

export type ScopeBand = "isolated" | "limited" | "repeated" | "broad" | "widespread";
export type SeverityLevel = "low" | "high" | "critical";

export interface Scope {
  band: ScopeBand;
  points: number;
  /** Which rule set the band: the session count, or the share (only with ≥ 20 sessions analyzed). */
  via: "count" | "share";
}

const BANDS: readonly { band: ScopeBand; points: number }[] = [
  { band: "isolated", points: 0 },
  { band: "limited", points: 3 },
  { band: "repeated", points: 7 },
  { band: "broad", points: 12 },
  { band: "widespread", points: 15 },
];

/** Share bands apply once this many sessions were analyzed. */
export const SHARE_MIN_ANALYZED = 20;

const nonNegInt = (name: string, v: number) => {
  if (!(Number.isInteger(v) && v >= 0)) throw new RangeError(`${name} must be a non-negative integer (got ${v})`);
};

/**
 * Scope points from distinct affected sessions: 1 → 0, 2-3 → 3, 4-10 → 7,
 * 11-100 → 12, > 100 → 15. With ≥ 20 sessions analyzed the share bands
 * (< 1%, < 10%, < 30%, < 60%, ≥ 60%) apply too, and the higher band wins.
 */
export function scopeBand(affected: number, analyzed: number): Scope {
  nonNegInt("affected", affected);
  nonNegInt("analyzed", analyzed);
  if (affected > analyzed) throw new RangeError(`affected (${affected}) exceeds analyzed (${analyzed})`);
  const byCount = affected <= 1 ? 0 : affected <= 3 ? 1 : affected <= 10 ? 2 : affected <= 100 ? 3 : 4;
  let i = byCount;
  let via: Scope["via"] = "count";
  if (analyzed >= SHARE_MIN_ANALYZED) {
    const share = affected / analyzed;
    const byShare = share < 0.01 ? 0 : share < 0.1 ? 1 : share < 0.3 ? 2 : share < 0.6 ? 3 : 4;
    if (byShare > byCount) {
      i = byShare;
      via = "share";
    }
  }
  return { ...(BANDS[i] as { band: ScopeBand; points: number }), via };
}

export interface NatureInput {
  nature: Nature;
  /** C (defect), Cp (risk) or W (inefficiency), usually one of FACTOR_POINTS. */
  factor: number;
  /** Risk only: one of REACH_VALUES. */
  reach?: number;
  /** Distinct sessions with the problem. */
  affected: number;
  /** Sessions analyzed. */
  analyzed: number;
}

export interface NatureScore {
  nature: Nature;
  factor: number;
  reach?: number;
  affected: number;
  analyzed: number;
  scope: Scope;
  /** 0-100. */
  score: number;
}

/** One nature's score (eqs 1-3). Throws when `reach` is missing for a risk or given for anything else. */
export function natureScore(x: NatureInput): NatureScore {
  if (!(Number.isFinite(x.factor) && x.factor >= 0 && x.factor <= 100)) throw new RangeError(`factor must be a number in [0, 100] (got ${x.factor})`);
  if (x.nature === "risk") {
    if (x.reach === undefined) throw new RangeError("a risk needs reach (0.4, 0.6, 0.8 or 1.0)");
    if (!(REACH_VALUES as readonly number[]).includes(x.reach)) throw new RangeError(`reach must be 0.4, 0.6, 0.8 or 1.0 (got ${x.reach})`);
  } else if (x.reach !== undefined) throw new RangeError(`reach applies to a risk only, not a ${x.nature}`);
  const scope = scopeBand(x.affected, x.analyzed);
  // Round Cp·R to 10 decimals first so 65 × 0.6 = 39.00000000000001 is 39, not 40.
  const base = x.nature === "risk" ? Math.ceil(Math.round(x.factor * (x.reach as number) * 1e10) / 1e10) : x.factor;
  return {
    nature: x.nature,
    factor: x.factor,
    ...(x.reach !== undefined ? { reach: x.reach } : {}),
    affected: x.affected,
    analyzed: x.analyzed,
    scope,
    score: Math.min(100, base + scope.points),
  };
}

/** Low 1-39 (and 0), High 40-79, Critical 80-100. */
export function levelOf(score: number): SeverityLevel {
  if (!(Number.isFinite(score) && score >= 0 && score <= 100)) throw new RangeError(`score must be in [0, 100] (got ${score})`);
  return score >= 80 ? "critical" : score >= 40 ? "high" : "low";
}

export interface SignalSeverity {
  score: number;
  level: SeverityLevel;
  /** The nature with the highest score (defect, then risk, then inefficiency on a tie). */
  drivingNature: Nature;
  parts: NatureScore[];
  /** Largest affected and analyzed counts over the parts. */
  population: { affected: number; analyzed: number };
}

const NATURE_ORDER: readonly Nature[] = ["defect", "risk", "inefficiency"];

/** A signal's severity: the max over its nature scores, never a sum or mean. */
export function signalSeverity(parts: readonly NatureScore[]): SignalSeverity {
  if (!parts.length) throw new RangeError("signalSeverity needs at least one nature score");
  let top = parts[0] as NatureScore;
  for (const p of parts) {
    if (p.score > top.score || (p.score === top.score && NATURE_ORDER.indexOf(p.nature) < NATURE_ORDER.indexOf(top.nature))) top = p;
  }
  return {
    score: top.score,
    level: levelOf(top.score),
    drivingNature: top.nature,
    parts: [...parts],
    population: { affected: Math.max(...parts.map((p) => p.affected)), analyzed: Math.max(...parts.map((p) => p.analyzed)) },
  };
}

/**
 * Waste points from counts, for detectors with no model: ≤ 2 wasted calls → 10,
 * 3-5 → 25, 6-20 → 40, > 20 or more than half the session's tool calls → 65,
 * and 85 when the work ran until a hard limit (a timeout, max turns or a user interrupt).
 */
export function defaultWasteFactor(x: { wastedCalls: number; sessionToolCalls?: number; hitLimit?: boolean }): number {
  nonNegInt("wastedCalls", x.wastedCalls);
  if (x.hitLimit) return 85;
  const total = x.sessionToolCalls ?? 0;
  if (x.wastedCalls > 20 || (total > 0 && x.wastedCalls / total > 0.5)) return 65;
  if (x.wastedCalls >= 6) return 40;
  if (x.wastedCalls >= 3) return 25;
  return 10;
}

/** Consequence points without a model: a known task failure → 40 (task failure), anything else → 25 (material, reversible). */
export function defaultConsequence(x: { outcome?: "pass" | "fail" | "unknown" } = {}): number {
  return x.outcome === "fail" ? 40 : 25;
}

/** A finding's diagnosis: what went wrong (taxonomy ids), how (nature) and how much it matters. Findings rank by severity.score, then support. */
export interface Diagnosis {
  typeIds: string[];
  nature: Nature;
  severity: SignalSeverity;
}
