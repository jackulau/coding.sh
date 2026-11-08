// What `compare --repair N` reports per arm: how many first-attempt failures
// the agent fixed once told the verifier failed, after how many rounds, at
// what extra cost, and (with `--false-alarm`) how often a false "failed" broke
// a passing run. Read from RunResult.repair; absent for runs without it.
import type { RunResult } from "../core/types.ts";
import { wilson, type Interval } from "../stats/interval.ts";

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
