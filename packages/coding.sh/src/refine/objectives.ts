// Multi-objective acceptance for `refine test|run --suite`: is a harness edit
// better, and on what? Quality is the per-task pass rate of an eval suite;
// efficiency is cost, tokens, wall time, LLM time, turns per run and the
// harness file size. Every test is paired by task and reuses src/stats:
//
//   quality      per-task pass-rate difference (candidate − base);
//                nonInferiority (one-sided bootstrap lower bound) against
//                --margin, pairedPermutation (one-sided) for "better", and
//                hardRegressions for tasks the base always solved and the
//                candidate now mostly fails.
//   efficiency   per-task log ratio ln(mean_cand / mean_base) of the metric
//                (tasks where either arm has no value or a zero are left
//                out); the relative change is exp(mean) − 1 with its bootstrap
//                CI mapped the same way, and "better" / "worse" are one-sided
//                pairedPermutation tests that must also clear --min-gain.
//   size         the bytes of the instruction files, compared directly (no
//                sampling, so no test).
//
// A candidate is kept when
//   - quality is significantly better (or the SAGE gate says ship), no hard
//     regression, and no listed objective significantly worse; or
//   - quality is non-inferior within the margin, no hard regression, the gate
//     does not say don't ship, a listed efficiency objective is significantly
//     better by at least --min-gain, and none is significantly worse.
// It is rejected when quality fell (mean below 0 and not non-inferior), a hard
// regression, the gate says don't ship, or a listed objective got worse; else
// it is inconclusive. So a faster candidate that loses quality beyond the
// margin is never kept.
//
// Pure: the CLI gathers runs and sizes and writes the result to the ledger.
import { pairedBootstrap } from "../stats/interval.ts";
import { hardRegressions, nonInferiority, pairedPermutation } from "../stats/tests.ts";
import { createEDetector, plateauRoundsNeeded, type EDetectorResult } from "../stats/edetector.ts";
import { dominates } from "../stats/pareto.ts";

export type Objective = "pass" | "cost" | "tokens" | "wall" | "llm" | "turns" | "size";
export type Measure = Exclude<Objective, "pass" | "size">;
export const OBJECTIVES: readonly Objective[] = ["pass", "cost", "tokens", "wall", "llm", "turns", "size"];
export const MEASURES: readonly Measure[] = ["cost", "tokens", "wall", "llm", "turns"];

export const OBJECTIVE_LABEL: Record<Objective, string> = {
  pass: "pass rate",
  cost: "cost / run",
  tokens: "tokens / run",
  wall: "wall time / run",
  llm: "LLM time / run",
  turns: "turns / run",
  size: "harness size",
};

/** Defaults: quality may drop at most 5 points; an efficiency gain must be at least 10%. */
export const DEFAULT_MARGIN = 0.02;
export const DEFAULT_MIN_GAIN = 0.1;
/** The smallest one-sided permutation p over n tasks is 2^−n: below 5 tasks no test reaches α = 0.05. */
export const MIN_TASKS = 5;

/** One run of the agent on one task. A measure is absent when the run did not report it. */
export interface RunPoint {
  pass: boolean;
  cost?: number;
  tokens?: number;
  wall?: number;
  llm?: number;
  turns?: number;
}

export interface TaskPair {
  task: string;
  base: readonly RunPoint[];
  cand: readonly RunPoint[];
}

export interface ObjectiveOpts {
  /** Primary first. "pass" is always judged, listed or not. */
  objectives: readonly Objective[];
  /** How far the pass rate may drop (0.02 = 2 points). */
  margin: number;
  /** Smallest relative efficiency gain that counts (0.1 = 10%). */
  minGain: number;
  alpha?: number;
  /** Instruction bytes per arm, for "size". */
  size?: { base: number; cand: number };
  /** The SAGE acceptance gate's verdict on the same runs (compare --gate). */
  gate?: "ship" | "hold" | "dont-ship";
  seed?: number;
}

export interface QualityResult {
  /** Pass rate per run, per arm. */
  base: number;
  cand: number;
  /** Mean per-task difference with its 95% bootstrap CI. */
  mean: number;
  lo: number;
  hi: number;
  /** One-sided (1 − α) lower bound, for non-inferiority. */
  lower: number;
  nonInferior: boolean;
  /** One-sided permutation p for "better". */
  p: number;
  better: boolean;
  /** Tasks the base passed every time and the candidate passes at most a third of the time. */
  regressions: string[];
  n: number;
}

export interface MetricResult {
  objective: Exclude<Objective, "pass">;
  /** Mean per run, per arm (runs that reported it). */
  base: number;
  cand: number;
  /** Candidate over base − 1 (geometric mean of per-task ratios; size: the byte ratio). */
  relative: number;
  /** 95% CI of `relative`; equal to it for size. */
  lo: number;
  hi: number;
  /** One-sided permutation p in the direction of the change (absent for size). */
  p?: number;
  /** Tasks with a value in both arms. */
  n: number;
  /** Share of runs per arm that reported the measure. */
  coverage: { base: number; cand: number };
  better: boolean;
  worse: boolean;
}

export type ObjectiveVerdict = "keep" | "reject" | "inconclusive";

export interface ObjectiveDecision {
  verdict: ObjectiveVerdict;
  /** Why a kept candidate was kept: quality got better, or it held and something got cheaper or faster. */
  branch?: "quality" | "efficiency";
  reasons: string[];
  quality: QualityResult;
  metrics: MetricResult[];
  warnings: string[];
  /** Per-task gain in [−1, 1] on the primary objective, for the e-detector. */
  gains: number[];
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const rate = (rs: readonly RunPoint[]) => (rs.length ? rs.filter((r) => r.pass).length / rs.length : NaN);
const valuesOf = (rs: readonly RunPoint[], m: Measure) => rs.map((r) => r[m]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
/** At least this share of each arm's runs must report a measure for it to decide anything. */
const COVERAGE_MIN = 0.8;

function quality(pairs: readonly TaskPair[], o: ObjectiveOpts, alpha: number): QualityResult {
  const usable = pairs.filter((t) => t.base.length && t.cand.length);
  const diffs = usable.map((t) => rate(t.cand) - rate(t.base));
  const all = (k: "base" | "cand") => usable.flatMap((t) => t[k]);
  const boot = pairedBootstrap(diffs, { seed: o.seed ?? 0x5eed });
  const ni = nonInferiority(diffs, o.margin, { alpha, seed: o.seed ?? 0x5eed });
  const perm = pairedPermutation(diffs, { alternative: "greater" });
  const base = new Map(usable.map((t) => [t.task, t.base.map((r) => r.pass)]));
  const cand = new Map(usable.map((t) => [t.task, t.cand.map((r) => r.pass)]));
  const m = mean(diffs);
  return {
    base: rate(all("base")),
    cand: rate(all("cand")),
    mean: m,
    lo: boot.lo,
    hi: boot.hi,
    lower: ni.lower,
    nonInferior: ni.nonInferior,
    p: perm.p,
    better: diffs.length > 0 && m > 0 && perm.p < alpha,
    regressions: hardRegressions(base, cand),
    n: diffs.length,
  };
}

function measure(pairs: readonly TaskPair[], m: Measure, o: ObjectiveOpts, alpha: number): MetricResult {
  const ratios: number[] = [];
  let runsB = 0;
  let runsC = 0;
  const allB: number[] = [];
  const allC: number[] = [];
  for (const t of pairs) {
    runsB += t.base.length;
    runsC += t.cand.length;
    const b = valuesOf(t.base, m);
    const c = valuesOf(t.cand, m);
    allB.push(...b);
    allC.push(...c);
    const mb = mean(b);
    const mc = mean(c);
    if (b.length && c.length && mb > 0 && mc > 0) ratios.push(Math.log(mc / mb));
  }
  const coverage = { base: runsB ? allB.length / runsB : 0, cand: runsC ? allC.length / runsC : 0 };
  const boot = pairedBootstrap(ratios, { seed: o.seed ?? 0x5eed });
  const relative = ratios.length ? Math.exp(boot.mean) - 1 : NaN;
  const known = ratios.length > 0 && coverage.base >= COVERAGE_MIN && coverage.cand >= COVERAGE_MIN;
  const down = known ? pairedPermutation(ratios, { alternative: "less" }).p : 1;
  const up = known ? pairedPermutation(ratios, { alternative: "greater" }).p : 1;
  const p = relative <= 0 ? down : up;
  return {
    objective: m,
    base: mean(allB),
    cand: mean(allC),
    relative,
    lo: ratios.length ? Math.exp(boot.lo) - 1 : NaN,
    hi: ratios.length ? Math.exp(boot.hi) - 1 : NaN,
    ...(known ? { p } : {}),
    n: ratios.length,
    coverage,
    better: known && down < alpha && relative <= -o.minGain,
    worse: known && up < alpha && relative >= o.minGain,
  };
}

function sizeResult(size: { base: number; cand: number }, minGain: number): MetricResult {
  const relative = size.base > 0 ? size.cand / size.base - 1 : size.cand > 0 ? Infinity : 0;
  return { objective: "size", base: size.base, cand: size.cand, relative, lo: relative, hi: relative, n: 1, coverage: { base: 1, cand: 1 }, better: relative <= -minGain, worse: relative >= minGain };
}

/** Per-task gain on the primary objective, in [−1, 1]: the pass-rate difference, or 1 − cand/base capped by any pass-rate drop. */
export function taskGains(pairs: readonly TaskPair[], primary: Objective, size?: { base: number; cand: number }): number[] {
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  const out: number[] = [];
  for (const t of pairs) {
    if (!t.base.length || !t.cand.length) continue;
    const d = rate(t.cand) - rate(t.base);
    if (primary === "pass") {
      out.push(d);
      continue;
    }
    let g: number;
    if (primary === "size") g = size && size.base > 0 ? 1 - size.cand / size.base : 0;
    else {
      const b = mean(valuesOf(t.base, primary));
      const c = mean(valuesOf(t.cand, primary));
      g = b > 0 && Number.isFinite(c) ? 1 - c / b : d;
    }
    out.push(clamp(d < 0 ? Math.min(g, d) : g));
  }
  return out;
}

export function judgeObjectives(pairs: readonly TaskPair[], o: ObjectiveOpts): ObjectiveDecision {
  const alpha = o.alpha ?? 0.05;
  const objectives = o.objectives.length ? o.objectives : (["pass"] as const);
  const primary = objectives[0]!;
  const q = quality(pairs, o, alpha);
  const metrics: MetricResult[] = [];
  for (const ob of objectives) {
    if (ob === "pass" || metrics.some((m) => m.objective === ob)) continue;
    if (ob === "size") {
      if (o.size) metrics.push(sizeResult(o.size, o.minGain));
    } else metrics.push(measure(pairs, ob, o, alpha));
  }
  const warnings: string[] = [];
  if (q.n < MIN_TASKS) warnings.push(`${q.n} paired task${q.n === 1 ? "" : "s"}: below ${MIN_TASKS} no one-sided test can reach α ${alpha} (the smallest p is 2^-n), so nothing sampled can be significant`);
  for (const m of metrics) {
    if (m.objective === "size") continue;
    if (!(m.coverage.base >= COVERAGE_MIN && m.coverage.cand >= COVERAGE_MIN)) warnings.push(`${OBJECTIVE_LABEL[m.objective]}: reported by ${Math.round(m.coverage.base * 100)}% / ${Math.round(m.coverage.cand * 100)}% of runs (base / candidate), under ${COVERAGE_MIN * 100}%, so it decides nothing`);
  }
  if (o.size === undefined && objectives.includes("size")) warnings.push("harness size: unknown for these arms");

  const reasons: string[] = [];
  const qText = `pass rate ${(q.base * 100).toFixed(0)}% → ${(q.cand * 100).toFixed(0)}% (${pts(q.mean)} per task [${pts(q.lo)}, ${pts(q.hi)}], one-sided lower bound ${pts(q.lower)} vs margin −${(o.margin * 100).toFixed(1)} pts)`;
  const better = metrics.filter((m) => m.better);
  const worse = metrics.filter((m) => m.worse);
  const mText = (m: MetricResult) => `${OBJECTIVE_LABEL[m.objective]} ${pct(m.relative)}${m.objective === "size" ? "" : ` [${pct(m.lo)}, ${pct(m.hi)}], p ${m.p === undefined ? "—" : m.p.toFixed(3)}`}`;
  const gains = taskGains(pairs, primary, o.size);
  const out = (verdict: ObjectiveVerdict, branch?: "quality" | "efficiency"): ObjectiveDecision => ({ verdict, ...(branch ? { branch } : {}), reasons, quality: q, metrics, warnings, gains });

  if (!q.n) {
    reasons.push("no task ran in both arms");
    return out("inconclusive");
  }
  if (q.regressions.length) {
    reasons.push(`hard regression: the base passed ${q.regressions.join(", ")} every time and the candidate now mostly fails`, qText);
    return out("reject");
  }
  if (o.gate === "dont-ship") {
    reasons.push("the acceptance gate says don't ship: the candidate broke tasks the base solved", qText);
    return out("reject");
  }
  if (worse.length) {
    reasons.push(`worse on ${worse.map(mText).join("; ")}`, qText);
    return out("reject");
  }
  if (q.better || o.gate === "ship") {
    reasons.push(`quality improved: ${qText}${q.better ? `, p ${q.p.toFixed(3)}` : ", the acceptance gate says ship"}`, ...better.map(mText));
    return out("keep", "quality");
  }
  if (!q.nonInferior) {
    // Quality fell (mean below 0): a gain that costs quality is never kept.
    if (q.mean < 0) {
      reasons.push(`quality fell: ${qText}`, ...better.map((m) => `${mText(m)}, but a gain that costs quality is not kept`));
      return out("reject");
    }
    // Quality held on average (mean ≥ 0) but the interval is too wide to prove
    // it stays within the margin: a hold the suite can't yet confirm, not a
    // quality loss. Say so, and when something is cheaper or faster, that the
    // win is real but unprovable here — the common outcome on a small suite.
    reasons.push(
      `quality not shown to hold: ${qText}`,
      ...better.map((m) => `${mText(m)}, but the quality interval is too wide to adopt it within the margin at ${q.n} task${q.n === 1 ? "" : "s"}: add tasks or trials`),
    );
    if (better.length) warnings.push(`the quality lower bound ${pts(q.lower)} is below the −${(o.margin * 100).toFixed(1)} pt margin, so this cheaper or faster candidate can't be adopted yet: add tasks or trials to narrow the interval, or raise --margin if the drop is acceptable`);
    return out("inconclusive");
  }
  if (better.length) {
    // The primary objective first, then the rest in the order given.
    const order = objectives.filter((x) => x !== "pass");
    better.sort((a, b) => order.indexOf(a.objective) - order.indexOf(b.objective));
    reasons.push(`${better.map(mText).join("; ")} with quality held: ${qText}`);
    return out("keep", "efficiency");
  }
  const tried = metrics.length ? metrics.map(mText).join("; ") : "no efficiency objective listed";
  reasons.push(`quality held but nothing listed got significantly better by ${(o.minGain * 100).toFixed(0)}%: ${tried}`, qText);
  return out("inconclusive");
}

// ---------------------------------------------------------------- flags

/** `--objective cost,pass` → ["cost", "pass"]; "time" means wall time. */
export function parseObjectives(values: readonly string[]): Objective[] {
  const out: Objective[] = [];
  for (const raw of values.flatMap((v) => v.split(","))) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    const ob = (v === "time" ? "wall" : v === "quality" ? "pass" : v === "llm-time" ? "llm" : v) as Objective;
    if (!OBJECTIVES.includes(ob)) throw new RangeError(`unknown objective ${JSON.stringify(raw)} (one of ${OBJECTIVES.join(", ")})`);
    if (!out.includes(ob)) out.push(ob);
  }
  return out;
}

/** A share from "2pp", "2%", "0.02" or "2" (points from 1 up). */
export function parseShare(raw: string | number, what: string): number {
  const s = String(raw).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(pp|pts?|%)?$/.exec(s);
  if (!m) throw new RangeError(`${what} must be a share like 0.02, 2% or 2pp, got ${JSON.stringify(String(raw))}`);
  const n = Number(m[1]);
  const v = m[2] || n >= 1 ? n / 100 : n;
  if (!(v >= 0 && v < 1)) throw new RangeError(`${what} must be between 0 and 100%, got ${JSON.stringify(String(raw))}`);
  return v;
}

// ---------------------------------------------------------------- the climb across rounds

/** One arm of one round, as point estimates (pass rate and mean per run). */
export interface ArmPoint {
  pass: number;
  cost?: number;
  tokens?: number;
  wall?: number;
  llm?: number;
  turns?: number;
  size?: number;
}

/** Point estimates per arm from the runs. */
export function armPoint(pairs: readonly TaskPair[], arm: "base" | "cand", size?: number): ArmPoint {
  const runs = pairs.flatMap((t) => t[arm]);
  const p: ArmPoint = { pass: rate(runs) };
  for (const m of MEASURES) {
    const v = valuesOf(runs, m);
    if (v.length) p[m] = mean(v);
  }
  if (size !== undefined) p.size = size;
  return p;
}

export interface ClimbRound {
  id: string;
  round: number;
  kept: boolean;
  base: ArmPoint;
  cand: ArmPoint;
  gains: readonly number[];
}

export interface FrontPoint {
  /** "base" for the starting files, else the candidate id. */
  id: string;
  round: number;
  pass: number;
  value: number;
  kept: boolean;
}

/**
 * The Pareto front over every version measured (the first base, then each
 * candidate): higher pass rate, lower `key`. Point estimates from different
 * rounds are not paired, so the front is a map, not a test.
 */
export function climbFront(rounds: readonly ClimbRound[], key: Exclude<Objective, "pass">): { points: FrontPoint[]; front: FrontPoint[] } {
  const points: FrontPoint[] = [];
  const first = rounds[0];
  if (first && first.base[key] !== undefined) points.push({ id: "base", round: 0, pass: first.base.pass, value: first.base[key]!, kept: true });
  for (const r of rounds) if (r.cand[key] !== undefined) points.push({ id: r.id, round: r.round, pass: r.cand.pass, value: r.cand[key]!, kept: r.kept });
  const qc = (p: FrontPoint) => ({ q: p.pass, c: p.value });
  const front = points.filter((p) => !points.some((x) => x !== p && dominates(qc(x), qc(p))));
  return { points, front };
}

/** The objective the front trades quality against: the primary when it is not pass, else cost, then wall time, then size. */
export function frontKey(primary: Objective, rounds: readonly ClimbRound[]): Exclude<Objective, "pass"> | undefined {
  if (primary !== "pass") return primary;
  for (const k of ["cost", "wall", "size"] as const) if (rounds.some((r) => r.cand[k] !== undefined)) return k;
  return undefined;
}

export interface ClimbPlateau {
  status: "stop" | "continue" | "insufficient";
  result: EDetectorResult;
  /** Rounds a flat plateau needs before the detector can alarm, at this suite size. */
  floor?: number;
  /** At an alarm: the version to keep (the incumbent before the plateau began). */
  keep?: string;
}

/**
 * The restart e-detector over the rounds' per-task gains (src/stats/edetector.ts,
 * as `exp plateau` uses it). On an alarm the version to keep is the last kept
 * candidate before the change point (or the starting files).
 */
export function climbPlateau(rounds: readonly ClimbRound[], o: { eps?: number; delta?: number } = {}): ClimbPlateau {
  const eps = o.eps ?? 0.05;
  const delta = o.delta ?? 0.05;
  const det = createEDetector({ eps, delta });
  for (const r of rounds) if (r.gains.length) det.push(r.gains);
  const result = det.result();
  const n = rounds.find((r) => r.gains.length)?.gains.length;
  const floor = n ? plateauRoundsNeeded(n, eps, delta) : undefined;
  if (!result.rounds) return { status: "insufficient", result, ...(floor ? { floor } : {}) };
  if (!result.alarm) return { status: "continue", result, ...(floor ? { floor } : {}) };
  const counted = rounds.filter((r) => r.gains.length);
  const before = counted.slice(0, (result.changePoint ?? 1) - 1).filter((r) => r.kept);
  return { status: "stop", result, ...(floor ? { floor } : {}), keep: before.at(-1)?.id ?? "base" };
}

export function climbPlateauLine(p: ClimbPlateau): string {
  const r = p.result;
  const wealth = `log wealth ${r.logWealth.toFixed(2)} of ${r.logThreshold.toFixed(2)}`;
  if (p.status === "stop") return `climb: plateau at round ${r.changePoint} (alarm at round ${r.alarmRound}, ${wealth}); keep ${p.keep}`;
  if (p.status === "insufficient") return "climb: no rounds with paired tasks yet";
  return `climb: still gaining after ${r.rounds} round${r.rounds === 1 ? "" : "s"} (${wealth}${p.floor ? `; a flat plateau needs at least ${p.floor} rounds to show at this suite size` : ""})`;
}
