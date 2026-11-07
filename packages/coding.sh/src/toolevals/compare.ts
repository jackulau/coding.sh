// Compare two arms of a tool-eval experiment (§8.2). Same shape and verdict
// rules as runner/experiment.ts `compare`: pairing unit is the task, success is
// a paired bootstrap over per-task pass-rate differences plus exact McNemar
// over attempt-aligned trials, continuous metrics are per-task median
// differences through the same bootstrap.
import type { AgentEvent } from "../schema/index.ts";
import { firstDivergence } from "../runner/divergence.ts";
import type { VerdictKind } from "../runner/experiment.ts";
import { mean, median } from "../stats/summary.ts";
import { pairedBootstrap, wilson, type BootstrapResult } from "../stats/interval.ts";
import { mcnemarPaired, pairedPermutation, type McNemarResult } from "../stats/tests.ts";
import { totalTokens } from "./metrics.ts";
import type {
  ContinuousMetric,
  SurfaceReport,
  ToolArmSummary,
  ToolCompareReport,
  ToolMetricDelta,
  ToolRegression,
  ToolTaskOutcome,
  TrialResult,
} from "./types.ts";

export const CONTINUOUS_METRICS: readonly ContinuousMetric[] = ["turns", "tokens", "costUsd", "wallMs", "invalidRate", "helpLookups", "llmP95Ms", "targetLatencyP95Ms"];

export function metricValue(t: TrialResult, m: ContinuousMetric): number | undefined {
  const x = t.metrics;
  if (!x) return undefined;
  const v =
    m === "tokens"
      ? totalTokens(x.usage)
      : m === "costUsd"
        ? (x.costUsd ?? undefined)
        : m === "llmP95Ms"
          ? x.llmP95Ms
          : m === "targetLatencyP95Ms"
            ? x.targetLatencyP95Ms
            : x[m];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function splitArm(arm: string): { variant: string; driver: string } {
  const i = arm.indexOf("@");
  if (i <= 0 || i === arm.length - 1) throw new Error(`arm "${arm}" is not <variant>@<driver>`);
  return { variant: arm.slice(0, i), driver: arm.slice(i + 1) };
}

export const trialArm = (t: TrialResult): string => `${t.variant}@${t.driver}`;

export function summarizeArm(trials: readonly TrialResult[], arm: string): ToolArmSummary {
  const { variant, driver } = splitArm(arm);
  const mine = trials.filter((t) => t.variant === variant && t.driver === driver);
  const passes = mine.filter((t) => t.pass).length;
  const byTask = groupByTask(mine);
  let passAllK = 0;
  let passAnyK = 0;
  for (const ts of byTask.values()) {
    if (ts.every((t) => t.pass)) passAllK++;
    if (ts.some((t) => t.pass)) passAnyK++;
  }
  const sources = new Set(mine.map((t) => t.metrics?.latencySource ?? "none"));
  return {
    arm,
    variant,
    driver,
    trials: mine.length,
    passes,
    passRate: wilson(passes, mine.length),
    passAllK,
    passAnyK,
    errors: mine.filter((t) => t.error).length,
    latencySource: sources.size === 1 ? ([...sources][0] as ToolArmSummary["latencySource"]) : sources.size === 0 ? "none" : "mixed",
  };
}

/** Every arm present in the trials, in first-seen order. */
export function summarizeArms(trials: readonly TrialResult[]): ToolArmSummary[] {
  const arms = [...new Set(trials.map(trialArm))];
  return arms.map((a) => summarizeArm(trials, a));
}

function groupByTask(ts: readonly TrialResult[]): Map<string, TrialResult[]> {
  const m = new Map<string, TrialResult[]>();
  for (const t of ts) m.set(t.taskId, [...(m.get(t.taskId) ?? []), t]);
  for (const v of m.values()) v.sort((a, b) => a.attempt - b.attempt);
  return m;
}

const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;
const pval = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function decide(paired: number, boot: BootstrapResult, mcn: McNemarResult, alpha: number): { kind: VerdictKind; text: string } {
  if (paired === 0) return { kind: "inconclusive", text: "inconclusive: no task ran in both arms" };
  const ci = `${Math.round((1 - alpha) * 100)}% CI [${pp(boot.lo)}, ${pp(boot.hi)}]`;
  const bootSig = boot.lo > 0 || boot.hi < 0;
  const mcSig = mcn.p < alpha;
  const small = paired < 10 ? ` (only ${paired} task${paired === 1 ? "" : "s"}; underpowered)` : "";
  if (bootSig && mcSig) {
    const better = boot.mean > 0;
    return { kind: better ? "better" : "worse", text: `candidate ${better ? "better" : "worse"}: ${pp(boot.mean)} success, ${ci}, McNemar ${pval(mcn.p)}` };
  }
  if (!bootSig && !mcSig) return { kind: "no-difference", text: `no significant difference: ${pp(boot.mean)} success, ${ci} includes 0, McNemar ${pval(mcn.p)}${small}` };
  return {
    kind: "inconclusive",
    text: `inconclusive: ${pp(boot.mean)} success; ${bootSig ? `bootstrap ${ci} excludes 0 but McNemar ${pval(mcn.p)}` : `McNemar ${pval(mcn.p)} but bootstrap ${ci} includes 0`}${small}; run more tasks or attempts`,
  };
}

/** Lower is better for every continuous metric. */
function metricVerdict(d: BootstrapResult): VerdictKind {
  if (d.n === 0 || !Number.isFinite(d.lo)) return "inconclusive";
  if (d.hi < 0) return "better";
  if (d.lo > 0) return "worse";
  return "no-difference";
}

const rel = (a: number, b: number) => (a ? (b - a) / a : b === 0 ? 0 : NaN);

export interface CompareToolOpts {
  baseline: string;
  candidate: string;
  alpha?: number;
  seed?: number;
  iters?: number;
  surfaces?: { baseline?: SurfaceReport; candidate?: SurfaceReport };
  /** Events by trial id, for first-divergence links in regressions. */
  events?: Map<string, AgentEvent[]>;
}

export function compareToolArms(trials: readonly TrialResult[], o: CompareToolOpts): ToolCompareReport {
  const alpha = o.alpha ?? 0.05;
  const a = splitArm(o.baseline);
  const b = splitArm(o.candidate);
  if (a.variant !== b.variant && a.driver !== b.driver) {
    throw new Error(`arms ${o.baseline} and ${o.candidate} differ on both variant and driver; compare one factor at a time`);
  }
  const comparing: ToolCompareReport["comparing"] = a.driver === b.driver ? "variant" : "driver";
  const A = trials.filter((t) => t.variant === a.variant && t.driver === a.driver);
  const B = trials.filter((t) => t.variant === b.variant && t.driver === b.driver);
  const ta = groupByTask(A);
  const tb = groupByTask(B);
  const ids = [...new Set([...ta.keys(), ...tb.keys()])].sort();

  const tasks: ToolTaskOutcome[] = [];
  const unpaired: string[] = [];
  const diffs: number[] = [];
  const alignedA: boolean[] = [];
  const alignedB: boolean[] = [];
  const regressions: ToolRegression[] = [];
  let k = 0;
  const pairedIds: string[] = [];
  for (const id of ids) {
    const ra = ta.get(id) ?? [];
    const rb = tb.get(id) ?? [];
    k = Math.max(k, ra.length, rb.length);
    if (!ra.length || !rb.length) {
      unpaired.push(id);
      continue;
    }
    pairedIds.push(id);
    const pa = ra.filter((t) => t.pass).length;
    const pb = rb.filter((t) => t.pass).length;
    const diff = pb / rb.length - pa / ra.length;
    diffs.push(diff);
    tasks.push({ taskId: id, baseline: { passes: pa, trials: ra.length }, candidate: { passes: pb, trials: rb.length }, diff });
    // Attempt-aligned pairs: attempt i of the baseline with attempt i of the candidate.
    const byAttempt = new Map(rb.map((t) => [t.attempt, t]));
    for (const x of ra) {
      const y = byAttempt.get(x.attempt);
      if (!y) continue;
      alignedA.push(x.pass);
      alignedB.push(y.pass);
    }
  }
  const kTask = (id: string) => Math.max(ta.get(id)?.length ?? 0, tb.get(id)?.length ?? 0);
  for (const id of pairedIds) {
    const ra = ta.get(id)!;
    const rb = tb.get(id)!;
    const pa = ra.filter((t) => t.pass).length;
    const pb = rb.filter((t) => t.pass).length;
    const kk = kTask(id);
    const lost = kk >= 2 ? pa - pb >= Math.ceil(kk / 2) : pa > 0 && pb === 0;
    if (!lost) continue;
    regressions.push({
      taskId: id,
      kind: "success",
      detail: kk >= 2 ? `passes ${pa}/${ra.length} → ${pb}/${rb.length}` : "pass → fail",
      baselineTrials: ra.map(link),
      candidateTrials: rb.map(link),
      firstDivergence: divergence(ra.find((t) => t.pass) ?? ra[0], rb.find((t) => !t.pass) ?? rb[0], o.events),
    });
  }

  const boot = pairedBootstrap(diffs, { iters: o.iters, seed: o.seed, alpha });
  const mcn = mcnemarPaired(alignedA, alignedB);
  // Same per-task diffs as the bootstrap; exact at the 5-20 tasks a suite usually has.
  const perm = pairedPermutation(diffs, { seed: o.seed });
  const baseline = summarizeArm(trials, o.baseline);
  const candidate = summarizeArm(trials, o.candidate);
  const notes: string[] = [];

  const metrics: Partial<Record<ContinuousMetric, ToolMetricDelta>> = {};
  const latencyComparable = baseline.latencySource === candidate.latencySource && baseline.latencySource !== "mixed";
  for (const m of CONTINUOUS_METRICS) {
    if (m === "llmP95Ms" && !latencyComparable) {
      notes.push(`model-call latency not compared: latency sources differ (${baseline.latencySource} vs ${candidate.latencySource})`);
      continue;
    }
    const perTask: { id: string; a: number; b: number }[] = [];
    for (const id of pairedIds) {
      const va = ta.get(id)!.map((t) => metricValue(t, m)).filter((x): x is number => x !== undefined);
      const vb = tb.get(id)!.map((t) => metricValue(t, m)).filter((x): x is number => x !== undefined);
      if (!va.length || !vb.length) continue;
      perTask.push({ id, a: median(va), b: median(vb) });
    }
    if (!perTask.length) continue;
    const d = pairedBootstrap(
      perTask.map((x) => x.b - x.a),
      { iters: o.iters, seed: o.seed, alpha },
    );
    const am = mean(perTask.map((x) => x.a));
    const bm = mean(perTask.map((x) => x.b));
    const verdict = metricVerdict(d);
    metrics[m] = { baseline: am, candidate: bm, diff: d, relative: rel(am, bm), verdict, n: perTask.length };
    if (verdict === "worse") {
      const worst = perTask.reduce((p, c) => (c.b - c.a > p.b - p.a ? c : p));
      const ra = ta.get(worst.id)!;
      const rb = tb.get(worst.id)!;
      regressions.push({
        taskId: worst.id,
        kind: "metric",
        metric: m,
        detail: `${m} up ${fmtNum(d.mean)} per task (CI [${fmtNum(d.lo)}, ${fmtNum(d.hi)}]); worst task ${fmtNum(worst.a)} → ${fmtNum(worst.b)}`,
        baselineTrials: ra.map(link),
        candidateTrials: rb.map(link),
        firstDivergence: divergence(ra[0], rb[0], o.events),
      });
    }
  }

  let surface: ToolCompareReport["surface"];
  if (o.surfaces?.baseline && o.surfaces.candidate) {
    const sa = o.surfaces.baseline;
    const sb = o.surfaces.candidate;
    const delta = (x: number, y: number) => ({ delta: y - x, relative: rel(x, y) });
    surface = {
      baseline: sa,
      candidate: sb,
      surfaceBytes: delta(sa.surfaceBytes, sb.surfaceBytes),
      descriptionBytes: delta(sa.descriptionBytes, sb.descriptionBytes),
      surfaceTokens: delta(sa.surfaceTokens, sb.surfaceTokens),
    };
  }

  if (k > 1) notes.push(`Wilson intervals treat the ${k} trials per task as independent and are optimistic; the bootstrap CI resamples tasks and is the one to trust`);
  if (unpaired.length) notes.push(`${unpaired.length} task(s) ran in only one arm and are excluded from paired stats`);
  const errs = baseline.errors + candidate.errors;
  if (errs) notes.push(`${errs} trial(s) recorded an error; they count as failures`);
  const verdict = decide(diffs.length, boot, mcn, alpha);
  return {
    baseline,
    candidate,
    comparing,
    tasks,
    pairedTasks: diffs.length,
    unpairedTasks: unpaired,
    k,
    diff: boot,
    mcnemar: mcn,
    permutation: { p: perm.p, method: perm.method },
    metrics,
    ...(surface ? { surface } : {}),
    verdict,
    regressions,
    notes,
    alpha,
  };
}

function link(t: TrialResult): { id: string; sessionId?: string } {
  return t.sessionId ? { id: t.id, sessionId: t.sessionId } : { id: t.id };
}

function divergence(x: TrialResult | undefined, y: TrialResult | undefined, events?: Map<string, AgentEvent[]>) {
  if (!x || !y || !events) return undefined;
  const ea = events.get(x.id);
  const eb = events.get(y.id);
  return ea && eb ? firstDivergence(ea, eb) : undefined;
}

function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const ax = Math.abs(x);
  return ax >= 100 ? x.toFixed(0) : ax >= 1 ? x.toFixed(2) : x.toFixed(3);
}
