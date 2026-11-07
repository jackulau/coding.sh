// `exp plateau` and `exp run --series` (X-18): has an iteration loop stopped
// paying, and which version should it ship?
//
//   Yin, Liu, Qi, "When Is Enough Enough? Stopping Self-Improvement Loops
//   with E-Detectors", arXiv 2610.04756, §3-4 and Alg. 1.
//   https://arxiv.org/abs/2610.04756
//
// A series is experiments in loop order: version 0 is the baseline, and round
// t puts version t (the candidate) against the incumbent I_{t−1} on the cases
// both ran. X_{t,i} = rate_cand(i) − rate_inc(i) ∈ [−1, 1] per shared case
// (caseRates: the pass share over trials, ungraded runs left out). The gate
// decides the next incumbent:
// - "greedy" (default): keep the candidate when mean X > 0, else keep I_{t−1};
// - "chain": every candidate becomes the incumbent (a loop that always builds
//   on its last version).
// A boolean `metadata.accepted` on the candidate overrides either gate (the
// loop's own accept decision). The restart e-detector (src/stats/edetector.ts)
// takes each round's X; on an alarm at round t with change point ν̂ the loop
// should stop and return I_{ν̂−1}, the incumbent before the plateau began.
import type { ExperimentResult } from "../datasets/types.ts";
import { createEDetector, plateauRoundsNeeded, type EBet, type EDetectorResult } from "../stats/edetector.ts";
import { caseRates } from "./run.ts";
import { fixed, paint, signedPct, table, type RenderOpts } from "./text.ts";

export type PlateauGate = "greedy" | "chain";
export type PlateauStatus = "stop" | "continue" | "insufficient";

export interface PlateauOpts {
  /** Smallest worthwhile gain per round, in (0, 1). Default 0.05. */
  eps?: number;
  /** Alarm at wealth ≥ 1/δ. Default 0.05. */
  delta?: number;
  bet?: EBet;
  gate?: PlateauGate;
}

export interface PlateauVersion {
  version: number;
  id: string;
  name: string;
}

export interface PlateauRound {
  /** 1-based; the candidate is version `round`. */
  round: number;
  candidate: string;
  incumbent: string;
  /** Cases both ran (with a graded run each). */
  n: number;
  /** Mean of candidate − incumbent over those cases; NaN when n is 0. */
  meanDiff: number;
  accepted: boolean;
  /** "metadata" when the candidate's `metadata.accepted` decided it. */
  decidedBy: "gate" | "metadata";
  /** False when the round had no shared cases and was left out of the detector. */
  counted: boolean;
}

export interface PlateauResult {
  status: PlateauStatus;
  gate: PlateauGate;
  versions: PlateauVersion[];
  rounds: PlateauRound[];
  /** The incumbent after the last round. */
  incumbent: PlateauVersion;
  /** On stop: I_{ν̂−1}, the version to ship. */
  recommend?: PlateauVersion;
  /** Series rounds (1-based) of the alarm and the change point ν̂. */
  alarmRound?: number;
  changePoint?: number;
  /** Fewest flat rounds before an alarm is possible, at the smallest round's case count (App. B). */
  floor?: number;
  detector: EDetectorResult;
  warnings: string[];
}

const MIN_PAIRED = 10;

function version(e: ExperimentResult, i: number): PlateauVersion {
  return { version: i, id: e.id, name: e.name };
}

/** Restart e-detector over a series of experiments (arXiv 2610.04756, Alg. 1). */
export function plateau(series: readonly ExperimentResult[], opts: PlateauOpts = {}): PlateauResult {
  const eps = opts.eps ?? 0.05;
  const delta = opts.delta ?? 0.05;
  const gate = opts.gate ?? "greedy";
  if (gate !== "greedy" && gate !== "chain") throw new RangeError(`gate must be "greedy" or "chain", got ${String(gate)}`);
  const det = createEDetector({ eps, delta, ...(opts.bet ? { bet: opts.bet } : {}) });
  const versions = series.map(version);
  const warnings: string[] = [];
  const rounds: PlateauRound[] = [];
  const rates = series.map((e) => caseRates(e.runs));
  // incAfter[t]: the incumbent's version after round t (incAfter[0] = the baseline).
  const incAfter: number[] = [0];
  // pushed[k]: the series round of detector round k + 1.
  const pushed: number[] = [];
  for (let t = 1; t < series.length; t++) {
    const inc = incAfter[t - 1]!;
    const a = rates[inc]!;
    const b = rates[t]!;
    const diffs: number[] = [];
    for (const [id, rb] of b) {
      const ra = a.get(id);
      if (ra !== undefined) diffs.push(rb - ra);
    }
    const n = diffs.length;
    const meanDiff = n ? diffs.reduce((s, x) => s + x, 0) / n : NaN;
    const meta = series[t]!.metadata?.accepted;
    const decidedBy = typeof meta === "boolean" ? "metadata" : "gate";
    const accepted = typeof meta === "boolean" ? meta : gate === "chain" ? true : n > 0 && meanDiff > 0;
    if (n) {
      det.push(diffs);
      pushed.push(t);
    }
    rounds.push({ round: t, candidate: series[t]!.id, incumbent: series[inc]!.id, n, meanDiff, accepted, decidedBy, counted: n > 0 });
    incAfter.push(accepted ? t : inc);
  }
  const detector = det.result();
  const counted = rounds.filter((r) => r.counted);
  const status: PlateauStatus = !counted.length ? "insufficient" : detector.alarm ? "stop" : "continue";
  const out: PlateauResult = {
    status,
    gate,
    versions,
    rounds,
    incumbent: versions[incAfter[incAfter.length - 1]!] ?? { version: 0, id: "", name: "" },
    detector,
    warnings,
  };
  if (detector.alarm && detector.alarmRound !== undefined && detector.changePoint !== undefined) {
    out.alarmRound = pushed[detector.alarmRound - 1]!;
    out.changePoint = pushed[detector.changePoint - 1]!;
    out.recommend = versions[incAfter[out.changePoint - 1]!]!;
  }

  // Warnings: what can make the series mean something other than "the loop stopped helping".
  if (series.length < 2) warnings.push(`a series needs at least two experiments (a baseline and a candidate); it has ${series.length}`);
  const first = series[0];
  if (first) {
    for (let t = 1; t < series.length; t++) {
      const e = series[t]!;
      const prev = series[t - 1]!;
      if (e.dataset.id !== prev.dataset.id) warnings.push(`round ${t} runs dataset ${e.dataset.name}, round ${t - 1} ran ${prev.dataset.name}: the rounds compare different cases`);
      else if (e.dataset.version !== prev.dataset.version)
        warnings.push(`dataset ${e.dataset.name} changed version at round ${t} (${prev.dataset.version} → ${e.dataset.version}): a candidate can look better because its cases changed`);
      if ((e.dataset.split ?? "all") !== (prev.dataset.split ?? "all")) warnings.push(`split changed at round ${t} (${prev.dataset.split ?? "all"} → ${e.dataset.split ?? "all"}): the rounds compare different cases`);
    }
  }
  const empty = rounds.filter((r) => !r.counted).map((r) => r.round);
  if (empty.length) warnings.push(`round${empty.length > 1 ? "s" : ""} ${empty.join(", ")} share${empty.length > 1 ? "" : "s"} no case with the incumbent and ${empty.length > 1 ? "are" : "is"} left out`);
  const thin = counted.filter((r) => r.n < MIN_PAIRED);
  if (thin.length) warnings.push(`round${thin.length > 1 ? "s" : ""} ${thin.map((r) => r.round).join(", ")} pair${thin.length > 1 ? "" : "s"} fewer than ${MIN_PAIRED} cases: one case swings the round`);
  if (counted.length) {
    const minN = Math.min(...counted.map((r) => r.n));
    out.floor = plateauRoundsNeeded(minN, eps, delta);
    if (status !== "stop" && out.floor > 1 / delta)
      warnings.push(`a flat plateau needs at least ${out.floor} rounds of ${minN} cases to stop at ε ${eps}: add cases or raise --eps, or this loop can't tell a plateau apart`);
  }
  if (detector.rounds >= 1 / delta && status !== "insufficient")
    warnings.push(`${detector.rounds} rounds is past the ${Math.round(1 / delta)}-round average run length to a false alarm (1/δ): a stop is an average-run-length guarantee, not an error rate`);
  const split = series[series.length - 1]?.dataset.split;
  if (out.recommend && (split === "dev" || split === "train"))
    warnings.push(`the loop selected on the ${split} split: confirm ${out.recommend.name} (${out.recommend.id}) on test before shipping it`);
  return out;
}

/** One line for `exp run --series`: `series s1: continue, incumbent exp_… (round 3 +4.0pp, 30 cases)`. */
export function plateauLine(name: string, p: PlateauResult): string {
  const last = p.rounds[p.rounds.length - 1];
  const round = last ? ` (round ${last.round} ${last.counted ? signedPct(last.meanDiff) : "no shared cases"}${last.counted ? `, ${last.n} cases` : ""}${last.accepted ? ", kept" : ""})` : "";
  if (p.status === "stop") return `series ${name}: stop, ship ${p.recommend!.name} ${p.recommend!.id} (version ${p.recommend!.version}; the plateau began at round ${p.changePoint})${round}`;
  if (p.status === "insufficient") return `series ${name}: ${p.versions.length} experiment${p.versions.length === 1 ? "" : "s"}, run another to start the stopping test`;
  return `series ${name}: continue, incumbent ${p.incumbent.name} ${p.incumbent.id}${round}`;
}

export function renderPlateau(p: PlateauResult, opts: RenderOpts & { series?: string }): string {
  const color = opts.color;
  const d = p.detector;
  const out: string[] = [];
  const head = `${paint("plateau", "bold", color)}${opts.series ? ` ${opts.series}` : ""}  ${p.versions.length} versions, gate ${p.gate}, ε ${d.eps}, δ ${d.delta}, bet ${d.bet}`;
  out.push(head);
  for (const w of p.warnings) out.push(paint(`  ! ${w}`, "yellow", color));
  if (p.rounds.length) {
    out.push("");
    out.push(
      table(
        [{ header: "round" }, { header: "candidate" }, { header: "vs" }, { header: "cases", align: "right" }, { header: "Δ", align: "right" }, { header: "kept" }],
        p.rounds.map((r) => [
          String(r.round),
          `${p.versions[r.round]!.name} ${r.candidate}`,
          r.incumbent,
          String(r.n),
          r.counted ? signedPct(r.meanDiff) : "—",
          `${r.accepted ? "yes" : "no"}${r.decidedBy === "metadata" ? " (metadata)" : ""}`,
        ]),
        { color },
      ),
    );
  }
  out.push("");
  const wealth = `wealth ${fixed(Math.exp(d.logWealth))} of ${fixed(Math.exp(d.logThreshold))} to stop`;
  if (p.status === "stop") {
    out.push(paint(`stop: the loop stopped gaining ${d.eps} per round at round ${p.changePoint}; alarm at round ${p.alarmRound}`, "yellow", color));
    out.push(`ship ${p.recommend!.name} ${p.recommend!.id} (version ${p.recommend!.version}, the incumbent before the plateau)`);
    out.push(paint(`${wealth}; false alarms come on average no sooner than every ${Math.round(1 / d.delta)} rounds (1/δ)`, "dim", color));
  } else if (p.status === "continue") {
    out.push(paint(`continue: no plateau yet; incumbent ${p.incumbent.name} ${p.incumbent.id} (version ${p.incumbent.version})`, "green", color));
    out.push(paint(`${wealth}${p.floor !== undefined ? `; a flat plateau needs ≥ ${p.floor} rounds` : ""}`, "dim", color));
  } else {
    out.push(paint("insufficient: no round to test yet (needs a baseline and a candidate sharing cases)", "yellow", color));
  }
  return out.join("\n");
}
