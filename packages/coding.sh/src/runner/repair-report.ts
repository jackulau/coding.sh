// What `compare --repair N` reports per arm: how many first-attempt failures
// the agent fixed once told the verifier failed, after how many rounds, at
// what extra cost, and (with `--false-alarm`) how often a false "failed" broke
// a passing run; and Seq@K over the attempts (first plus rounds): the curve,
// where its gain lands, rounds that changed nothing, cost to solve and the
// pass@k vs seq@k cost front (arXiv 2610.37859). Read from RunResult.repair;
// absent for runs without it.
import type { RunResult } from "../core/types.ts";
import { wilson, type BootstrapOpts, type Interval } from "../stats/interval.ts";
import { gainShares, passAtK, protocolFront, rankAgreement, seqCurve, type ProtocolPoint, type RankFlip, type SeqPoint } from "../stats/seqk.ts";

export interface ArmRepair {
  signal: "bit" | "names" | "mixed";
  mode: "resume" | "fresh" | "mixed";
  /** Rounds allowed (the largest, when runs differ). */
  limit: number;
  /** Runs with repair. */
  runs: number;
  /** Of those, runs that failed their first attempt and got repair rounds. */
  firstFails: number;
  /** First failures that passed after a round, no round tampering with tests. */
  repaired: number;
  /** repaired / firstFails; NaN when nothing failed. */
  repairRate: number;
  /** Over every run of the arm: the first attempt passed. */
  firstPass: Interval;
  /** Over every run of the arm: passing at the end (a run without repair counts its first attempt). */
  passAfterRepair: Interval;
  /** Mean rounds a repaired run took; absent when none was repaired. */
  meanRounds?: number;
  /** Repair rounds run in all. */
  rounds: number;
  /** What the rounds cost (rounds whose agent reported a cost), and how many did. */
  extraCostUsd: number;
  extraPriced: number;
  /** The agent's time in repair rounds. */
  extraAgentMs: number;
  /** Runs whose repair ended on a round that edited, deleted or skipped tests: not counted as repaired. */
  tamperedRepairs: number;
  /** Signal "names": rounds that got the bare bit because no failing test name could be parsed. */
  namesUnparsed?: number;
  /** Runs that got no rounds because the first attempt errored or timed out. */
  skipped: number;
  /** With `--false-alarm`: passing runs told they failed, and how many of them failed at the end. */
  falseAlarm?: { p: number; fired: number; broke: number };
}

/** The repair summary of one arm's counted runs; undefined when none of them ran with repair. */
export function armRepair(runs: readonly RunResult[]): ArmRepair | undefined {
  const withRepair = runs.filter((r) => r.repair);
  if (!withRepair.length) return undefined;
  const reps = withRepair.map((r) => r.repair!);
  const one = <T extends string>(xs: T[]): T | "mixed" => (new Set(xs).size === 1 ? (xs[0] as T) : "mixed");
  const firstFails = withRepair.filter((r) => !r.pass && !r.repair!.skipped && r.repair!.rounds.length > 0);
  const repaired = firstFails.filter((r) => r.repair!.pass);
  const rounds = reps.flatMap((x) => x.rounds);
  const costs = rounds.map((x) => x.usage?.costUsd).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const fired = withRepair.filter((r) => r.repair!.falseAlarmFired);
  const p = Math.max(0, ...reps.map((x) => x.falseAlarm ?? 0));
  const names = reps.some((x) => x.signal === "names");
  return {
    signal: one(reps.map((x) => x.signal)),
    mode: one(reps.map((x) => x.mode)),
    limit: Math.max(...reps.map((x) => x.limit)),
    runs: withRepair.length,
    firstFails: firstFails.length,
    repaired: repaired.length,
    repairRate: firstFails.length ? repaired.length / firstFails.length : NaN,
    firstPass: wilson(runs.filter((r) => r.pass).length, runs.length),
    passAfterRepair: wilson(runs.filter(passAfterRepair).length, runs.length),
    ...(repaired.length ? { meanRounds: repaired.reduce((s, r) => s + r.repair!.rounds.length, 0) / repaired.length } : {}),
    rounds: rounds.length,
    extraCostUsd: costs.reduce((s, c) => s + c, 0),
    extraPriced: costs.length,
    extraAgentMs: rounds.reduce((s, x) => s + (x.durationMs > 0 ? x.durationMs : 0), 0),
    tamperedRepairs: reps.filter((x) => x.rounds.at(-1)?.tamper).length,
    ...(names ? { namesUnparsed: rounds.filter((x) => x.namesParsed === false).length } : {}),
    skipped: reps.filter((x) => x.skipped).length,
    ...(p > 0 ? { falseAlarm: { p, fired: fired.length, broke: fired.filter((r) => !r.repair!.pass).length } } : {}),
  };
}

/** A run's outcome after repair: the repair's end state when it had repair, else its first attempt. */
export const passAfterRepair = (r: RunResult): boolean => (r.repair ? r.repair.pass : r.pass);

/**
 * Seq@K over repair rounds (arXiv 2610.37859): the first attempt is attempt 1,
 * repair round n is attempt n+1.
 */
export interface ArmSeq {
  /** Attempts counted: the first plus the most repair rounds allowed. */
  k: number;
  /** Seq@1..k over tasks: a run counts at k when it passed by its k-th attempt on a round that did not tamper with tests. */
  curve: SeqPoint[];
  /** Share of the gain from attempt 1 to k made by attempt 2 (EGS) and by the last (LGS). */
  egs?: number;
  lgs?: number;
  /** Repair rounds whose agent changed no file. */
  unchanged: number;
  /** unchanged / repair rounds; absent with no round. */
  unchangedRate?: number;
  /** Agent spend (first attempts and rounds) per run solved within k; absent when a cost is missing or nothing was solved. */
  costToSolve?: number;
  /** With 2+ attempts on every task: unbiased pass@1..min(attempts, k) from the first attempts alone. */
  passAtK?: { k: number; rate: number }[];
  /**
   * Mean agent cost per task to reach each point, for seq@k (rounds only as needed)
   * and pass@k (k independent first attempts): the points no other point of the
   * same protocol beats, `overall` when no point of any protocol does. Absent without passAtK or when a cost is missing.
   */
  front?: (ProtocolPoint & { overall: boolean })[];
}

/** The 1-based attempt that first passed: 1 for a first pass, n+1 for repair round n, null when none did (a tampering round never counts). */
export function solvedAt(r: RunResult): number | null {
  if (r.pass) return 1;
  const i = r.repair?.rounds.findIndex((x) => x.pass && !x.tamper) ?? -1;
  return i >= 0 ? i + 2 : null;
}

const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** Seq@K of one arm's counted runs, grouped by task; undefined when none ran with repair. */
export function armSeq(runs: readonly RunResult[], opts: BootstrapOpts = {}): ArmSeq | undefined {
  const reps = runs.flatMap((r) => (r.repair ? [r.repair] : []));
  if (!reps.length) return undefined;
  const K = 1 + Math.max(...reps.map((x) => x.limit));
  const byTask = new Map<string, RunResult[]>();
  for (const r of runs) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const tasks = [...byTask.values()];
  const curve = seqCurve(
    tasks.map((rs) => ({ id: rs[0]!.taskId, solvedAt: rs.map(solvedAt) })),
    K,
    opts,
  );
  const rounds = reps.flatMap((x) => x.rounds);
  const unchanged = rounds.filter((x) => x.unchanged).length;
  const out: ArmSeq = { k: K, curve, ...gainShares(curve), unchanged, ...(rounds.length ? { unchangedRate: unchanged / rounds.length } : {}) };

  const nMin = Math.min(...tasks.map((rs) => rs.length));
  const kMax = Math.min(nMin, K);
  if (nMin >= 2) {
    out.passAtK = Array.from({ length: kMax }, (_, j) => ({
      k: j + 1,
      rate: mean(tasks.map((rs) => passAtK(rs.length, rs.filter((r) => r.pass).length, j + 1))),
    }));
  }

  // Cost of a run's first k attempts: the rounds after a pass never ran, so they cost nothing.
  const costUntil = (r: RunResult, k: number): number | undefined => {
    const first = r.agent.usage?.costUsd;
    if (!finite(first)) return undefined;
    let c = first;
    for (const x of (r.repair?.rounds ?? []).slice(0, k - 1)) {
      const rc = x.usage?.costUsd;
      if (!finite(rc)) return undefined;
      c += rc;
    }
    return c;
  };
  const all = runs.map((r) => costUntil(r, K));
  if (!all.every(finite)) return out;
  const solved = runs.filter((r) => solvedAt(r) !== null).length;
  if (solved) out.costToSolve = all.reduce((s, c) => s + c, 0) / solved;
  // Per task, the mean over its runs; then the mean over tasks, as the curve weighs them.
  const perTask = (k: number) => mean(tasks.map((rs) => mean(rs.map((r) => costUntil(r, k) as number))));
  const firstCost = perTask(1);
  const points: ProtocolPoint[] = curve.map((p) => ({ protocol: "seq@k", k: p.k, cost: perTask(p.k), success: p.rate }));
  // pass@1 is seq@1: the first attempt alone.
  for (const p of out.passAtK ?? []) if (p.k > 1) points.push({ protocol: "pass@k", k: p.k, cost: p.k * firstCost, success: p.rate });
  if (out.passAtK) out.front = protocolFront(points);
  return out;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** How the two arms rank by first pass and by Seq@K; only for arms with the same repair settings. */
export interface SeqRanking {
  k: number;
  byPass1: Record<string, number>;
  bySeqK: Record<string, number>;
  /** Kendall's τ-b between the two rankings; absent when either ties. */
  kendallTau?: number;
  /** The pairs ranked the other way within k attempts. */
  flipped: RankFlip[];
}

export function seqRanking(arms: readonly { label: string; seq: ArmSeq }[]): SeqRanking | undefined {
  const k = arms[0]?.seq.k;
  if (arms.length < 2 || arms.some((a) => a.seq.k !== k || !a.seq.curve.length) || k === undefined) return undefined;
  const byPass1 = Object.fromEntries(arms.map((a) => [a.label, a.seq.curve[0]!.rate]));
  const bySeqK = Object.fromEntries(arms.map((a) => [a.label, a.seq.curve[k - 1]!.rate]));
  const ag = rankAgreement(byPass1, bySeqK);
  return { k, byPass1, bySeqK, ...(ag.kendallTau !== undefined ? { kendallTau: ag.kendallTau } : {}), flipped: ag.flipped };
}
