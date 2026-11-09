// Cross-judge replication for `exp compare --pairwise` (AB-13): run more than
// one pairwise judge on the same pair of experiments, measure how far the
// judges agree with each other case by case, and conclude only when they all
// point the same way. Swapping the judge changes the ranking often enough
// (arXiv 2611.04090) that one judge's "better" is a weak signal; two judges
// from different providers that both say "better" screen out a misaligned
// one. This is a screen, not a substitute for human labels.
import type { CalibrationState, CalibrationStatus } from "../datasets/types.ts";
import { cohenKappa } from "../stats/agreement.ts";
import type { PairwiseSummary } from "./pairwise.ts";
import type { DirectionStability } from "./stability.ts";

/** Pair κ below which the judges are said to agree poorly. */
export const MIN_JUDGE_KAPPA = 0.4;

export interface ReplicationJudge {
  id: string;
  provider: string;
  model: string;
  verdict: PairwiseSummary["verdict"];
  /** Cases judged in both orders. */
  n: number;
  winRate: { b: number; lo: number; hi: number };
  /** The judge's calibration state; "failed" when it was measured against human labels and κ fell below the threshold. */
  calibration?: CalibrationState | "failed";
  stability?: DirectionStability;
}

export interface JudgeAgreement {
  /** Judge ids. */
  a: string;
  b: string;
  /** Cases both judges judged. */
  n: number;
  /** Cohen's κ over per-case winners (a, b, tie); NaN when both judges used one answer only, or n = 0. */
  kappa: number;
  percentAgreement: number;
}

export type ReplicationConclusion = "replicated-better" | "replicated-worse" | "judges-disagree" | "unresolved";

export interface PairwiseReplication {
  judges: ReplicationJudge[];
  /** One row per pair of judges, in the order given. */
  agreement: JudgeAgreement[];
  /** Distinct providers, in the order given. */
  providers: string[];
  /** Judges left out of the conclusion: their calibration against human labels failed. */
  screened: string[];
  /**
   * replicated-better / replicated-worse: at least two unscreened judges, all
   * with that verdict. judges-disagree: one says better and another worse.
   * unresolved: anything else (fewer than two judges, or some inconclusive).
   */
  conclusion: ReplicationConclusion;
  warnings: string[];
}

export interface ReplicateOpts {
  /** Warn when any pair's κ is below this. Default 0.4. */
  minKappa?: number;
}

/** Conclusion over the unscreened judges' verdicts. */
function conclude(verdicts: readonly PairwiseSummary["verdict"][]): ReplicationConclusion {
  const better = verdicts.filter((v) => v === "better").length;
  const worse = verdicts.filter((v) => v === "worse").length;
  if (better && worse) return "judges-disagree";
  if (verdicts.length >= 2 && better === verdicts.length) return "replicated-better";
  if (verdicts.length >= 2 && worse === verdicts.length) return "replicated-worse";
  return "unresolved";
}

/** A measured κ below the threshold is a failed calibration; "uncalibrated" without a κ was never measured. */
const calibrationOf = (c: CalibrationStatus): ReplicationJudge["calibration"] => (c.state === "uncalibrated" && c.kappa !== undefined ? "failed" : c.state);

const k2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "undefined");

export function replicatePairwise(summaries: readonly PairwiseSummary[], meta: readonly { id: string; provider: string; model: string }[], opts: ReplicateOpts = {}): PairwiseReplication {
  if (summaries.length !== meta.length) throw new RangeError("replicatePairwise: one meta row per summary");
  const minKappa = opts.minKappa ?? MIN_JUDGE_KAPPA;
  const judges: ReplicationJudge[] = summaries.map((s, i) => {
    const m = meta[i]!;
    return {
      id: m.id,
      provider: m.provider,
      model: m.model,
      verdict: s.verdict,
      n: s.n,
      winRate: { b: s.winRate.b, lo: s.winRate.lo, hi: s.winRate.hi },
      ...(s.judge.calibration ? { calibration: calibrationOf(s.judge.calibration) } : {}),
      ...(s.stability ? { stability: s.stability } : {}),
    };
  });
  const agreement: JudgeAgreement[] = [];
  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const wb = new Map(summaries[j]!.cases.map((c) => [c.caseId, c.winner]));
      const xa: string[] = [];
      const xb: string[] = [];
      for (const c of summaries[i]!.cases) {
        const w = wb.get(c.caseId);
        if (w === undefined) continue;
        xa.push(c.winner);
        xb.push(w);
      }
      const k = cohenKappa(xa, xb, ["a", "b", "tie"]);
      agreement.push({ a: judges[i]!.id, b: judges[j]!.id, n: k.n, kappa: k.kappa, percentAgreement: k.agreement });
    }
  }
  const providers = [...new Set(judges.map((j) => j.provider))];
  const screened = judges.filter((j) => j.calibration === "failed").map((j) => j.id);
  const kept = judges.filter((j) => j.calibration !== "failed");
  const warnings: string[] = [];
  if (judges.length >= 2) {
    const byProvider = new Map<string, string[]>();
    for (const j of judges) byProvider.set(j.provider, [...(byProvider.get(j.provider) ?? []), j.id]);
    for (const [p, ids] of byProvider) {
      if (ids.length > 1) warnings.push(`judges ${ids.join(", ")} share provider ${p}: they can share its blind spots, so their agreement is weaker evidence than two providers'`);
    }
    for (const a of agreement) {
      if (a.n && Number.isFinite(a.kappa) && a.kappa < minKappa) warnings.push(`judges ${a.a} and ${a.b} agree poorly case by case (κ ${k2(a.kappa)} < ${minKappa} over ${a.n} shared cases)`);
    }
    if (!judges.some((j) => j.calibration === "calibrated")) warnings.push("no judge is calibrated against human labels: agreement between judges is not agreement with people (add --labels)");
  }
  for (const id of screened) warnings.push(`judge ${id} failed its calibration against human labels and is left out of the conclusion`);
  return { judges, agreement, providers, screened, conclusion: conclude(kept.map((j) => j.verdict)), warnings };
}

/**
 * Whether the pairwise judges hold a gate that would ship: one unscreened
 * judge saying B is worse, or two or more judges that do not replicate
 * "better". Returns undefined when the judges do not stand in the way.
 */
export function judgeHold(rep: PairwiseReplication): { conclusion: ReplicationConclusion; detail: string } | undefined {
  const kept = rep.judges.filter((j) => !rep.screened.includes(j.id));
  const worse = kept.filter((j) => j.verdict === "worse");
  if (worse.length) {
    const better = kept.filter((j) => j.verdict === "better");
    const detail = better.length
      ? `${better.map((j) => j.id).join(", ")} prefer${better.length === 1 ? "s" : ""} B, ${worse.map((j) => j.id).join(", ")} prefer${worse.length === 1 ? "s" : ""} A`
      : `${worse.map((j) => j.id).join(", ")} prefer${worse.length === 1 ? "s" : ""} A`;
    return { conclusion: rep.conclusion, detail };
  }
  if (rep.judges.length >= 2 && rep.conclusion !== "replicated-better") {
    const better = kept.filter((j) => j.verdict === "better").length;
    return { conclusion: rep.conclusion, detail: `${better} of ${kept.length} judge${kept.length === 1 ? "" : "s"} found B better; replication needs every one${rep.screened.length ? ` (${rep.screened.length} screened out)` : ""}` };
  }
  return undefined;
}
