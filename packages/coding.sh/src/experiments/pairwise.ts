// `exp compare A B --pairwise <judge>` (EM-14): a pairwise judge reads both
// experiments' stored outputs for each shared case, in both orders (see
// src/judge/pairwise.ts), and this module turns the verdicts into B's win
// rate with a bootstrap CI, a sign test on the decisive cases, the tie rate
// and the position-bias rate.
import type { CalibrationStatus, Case, CaseRun, ExperimentResult } from "../datasets/types.ts";
import { mapPool } from "../judge/limit.ts";
import type { PairVerdict, PairwiseJudge } from "../judge/pairwise.ts";
import { clusteredBootstrap } from "../stats/cluster.ts";
import { pairedBootstrap } from "../stats/interval.ts";
import { clusterSignFlip, mcnemar, type McNemarResult, type SignFlipResult } from "../stats/tests.ts";
import { directionStability, type DirectionStability } from "./stability.ts";

/** Position-bias rate above which the summary warns. */
export const POSITION_BIAS_WARN = 0.2;

export interface PairCase extends PairVerdict {
  caseId: string;
}

export interface PairwiseSummary {
  judge: { id: string; calibration?: CalibrationStatus };
  /** Cases judged in both orders. */
  n: number;
  /** Decisive cases: both orders agreed on the winner. */
  wins: { a: number; b: number };
  /** Cases with no winner: both orders said tie, or the orders disagreed. */
  ties: number;
  /** Cases where the answer changed with the order (counted in ties). */
  inconsistent: number;
  /** inconsistent / n, and which position the judge followed when both orders picked the same slot. */
  positionBias: { rate: number; first: number; second: number };
  /** B's win rate with ties as half, and its bootstrap CI over cases (or clusters). */
  winRate: { b: number; lo: number; hi: number; iters: number };
  /** Exact two-sided sign test on decisive cases (`b` = A wins, `c` = B wins). */
  signTest: McNemarResult;
  /**
   * Exact two-sided sign-flip test at the bootstrap's unit: per case (where it
   * equals the sign test) or per cluster sum with a cluster key.
   */
  signFlip: SignFlipResult;
  /**
   * "better" / "worse" when the win-rate CI excludes 50% and signFlip.p is
   * below alpha. With a few decisive cases that all go one way the bootstrap
   * CI is a single point, so the exact test is what holds the verdict back.
   */
  verdict: "better" | "worse" | "inconclusive";
  /** How often a resample of the cases (or clusters) picks the same winner, and n* (arXiv 2611.04090). */
  stability: DirectionStability;
  /** Shared cases not judged: no output on one side (task error), or the judge failed. */
  skipped: { noOutput: number; judgeErrors: number; firstError?: string };
  cluster?: { key: string; clusters: number };
  warnings: string[];
  cases: PairCase[];
}

export interface RunPairwiseOpts {
  /** Dataset cases by id, for the input and expected value the judge sees. */
  cases: ReadonlyMap<string, Pick<Case, "input" | "expected">>;
  /** Concurrent cases (each makes two judge calls). Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
  iters?: number;
  seed?: number;
  alpha?: number;
  /** Resample clusters of cases (see clusterMap in compare.ts). */
  cluster?: { key: string; of: ReadonlyMap<string, string> };
  /** Calibration to report (e.g. the stored judge's); default the judge version's. */
  calibration?: CalibrationStatus;
  onProgress?: (done: number, total: number) => void;
}

/** Output of the first trial that produced one (lowest trial number), per case. */
function firstOutputs(runs: readonly CaseRun[]): Map<string, { output: unknown } | null> {
  const out = new Map<string, { output: unknown } | null>();
  for (const r of [...runs].sort((x, y) => x.trial - y.trial)) {
    if (out.get(r.caseId)) continue;
    out.set(r.caseId, r.error === undefined ? { output: r.output } : null);
  }
  return out;
}

/** Judge every case both experiments ran, in both orders, and summarize. */
export async function runPairwise(judge: PairwiseJudge, a: ExperimentResult, b: ExperimentResult, opts: RunPairwiseOpts): Promise<PairwiseSummary> {
  const oa = firstOutputs(a.runs);
  const ob = firstOutputs(b.runs);
  const ids = [...oa.keys()].filter((id) => ob.has(id)).sort();
  let noOutput = 0;
  const todo: { caseId: string; a: unknown; b: unknown }[] = [];
  for (const id of ids) {
    const x = oa.get(id);
    const y = ob.get(id);
    if (!x || !y || !opts.cases.has(id)) noOutput++;
    else todo.push({ caseId: id, a: x.output, b: y.output });
  }
  let judgeErrors = 0;
  let firstError: string | undefined;
  let done = 0;
  const verdicts = await mapPool(todo, opts.concurrency ?? 4, async (t): Promise<PairCase | undefined> => {
    if (opts.signal?.aborted) return undefined;
    const c = opts.cases.get(t.caseId)!;
    try {
      const v = await judge.compare({ input: c.input, expected: c.expected, a: t.a, b: t.b, caseId: t.caseId, ...(opts.signal ? { signal: opts.signal } : {}) });
      return { caseId: t.caseId, ...v };
    } catch (e) {
      judgeErrors++;
      firstError ??= e instanceof Error ? e.message : String(e);
      return undefined;
    } finally {
      opts.onProgress?.(++done, todo.length);
    }
  });
  const calibration = opts.calibration ?? judge.version.calibration;
  return summarizePairwise(
    verdicts.filter((v): v is PairCase => v !== undefined),
    { id: judge.version.id, ...(calibration ? { calibration } : {}) },
    { noOutput, judgeErrors, ...(firstError ? { firstError } : {}) },
    opts,
  );
}

/** Win rate, sign test and position bias from per-case verdicts. */
export function summarizePairwise(
  cases: readonly PairCase[],
  judge: PairwiseSummary["judge"],
  skipped: PairwiseSummary["skipped"] = { noOutput: 0, judgeErrors: 0 },
  opts: Pick<RunPairwiseOpts, "iters" | "seed" | "alpha" | "cluster"> = {},
): PairwiseSummary {
  const sorted = [...cases].sort((x, y) => (x.caseId < y.caseId ? -1 : x.caseId > y.caseId ? 1 : 0));
  const n = sorted.length;
  const wins = { a: 0, b: 0 };
  let inconsistent = 0;
  const bias = { first: 0, second: 0 };
  for (const c of sorted) {
    if (c.winner === "a") wins.a++;
    else if (c.winner === "b") wins.b++;
    if (!c.consistent) inconsistent++;
    if (c.favored) bias[c.favored]++;
  }
  // Per case: 1 when B wins, 0 when A wins, 0.5 for a tie; centered on 0.5 for the bootstrap.
  const centered = sorted.map((c) => (c.winner === "b" ? 0.5 : c.winner === "a" ? -0.5 : 0));
  const boot = { iters: opts.iters ?? 10_000, seed: opts.seed ?? 0x5eed, alpha: opts.alpha ?? 0.05 };
  const cl = opts.cluster;
  const clusterIds = sorted.map((c) => cl?.of.get(c.caseId) ?? `\u0000${c.caseId}`);
  const d = cl ? clusteredBootstrap(centered, clusterIds, boot) : pairedBootstrap(centered, boot);
  const signFlip = clusterSignFlip(centered, { seed: boot.seed, iters: boot.iters, ...(cl ? { clusterIds } : {}) });
  const exact = signFlip.p < boot.alpha;
  const verdict: PairwiseSummary["verdict"] = n > 0 && exact && d.lo > 0 ? "better" : n > 0 && exact && d.hi < 0 ? "worse" : "inconclusive";
  const rate = n ? inconsistent / n : NaN;
  const warnings: string[] = [];
  if (n > 0 && rate > POSITION_BIAS_WARN) {
    warnings.push(
      `the judge changed its answer with the order on ${(rate * 100).toFixed(0)}% of cases; those count as ties, so the win rate is diluted toward 50%. Tighten the rubric or use a stronger judge model`,
    );
  }
  const stability = directionStability(centered, { seed: boot.seed, ...(cl ? { clusterIds } : {}) });
  const cal = judge.calibration;
  if (n > 0 && !stability.stable && verdict === "inconclusive" && stability.direction !== "none") {
    warnings.push(
      `${stability.direction === "b" ? "B" : "A"}'s lead held in only ${Math.round(stability.share * 100)}% of resamples at n=${stability.bySize.at(-1)?.m}; more cases help only if the judge is calibrated`,
    );
  }
  if (n > 0 && stability.nStar === "censored" && cal?.state !== "calibrated") warnings.push("unresolved: pick or calibrate the judge before collecting more verdicts");
  if (!cal) warnings.push("the pairwise judge is uncalibrated: its picks are not validated against human pairwise labels (add --labels)");
  else if (cal.state !== "calibrated") warnings.push(`the pairwise judge is ${cal.state}: ${cal.reason ?? "its picks are not validated against human pairwise labels"}`);
  if (skipped.judgeErrors) warnings.push(`${skipped.judgeErrors} case(s) left out after a judge error: ${skipped.firstError ?? "unknown error"}`);
  const out: PairwiseSummary = {
    judge,
    n,
    wins,
    ties: n - wins.a - wins.b,
    inconsistent,
    positionBias: { rate, ...bias },
    winRate: { b: 0.5 + d.mean, lo: 0.5 + d.lo, hi: 0.5 + d.hi, iters: d.iters },
    signTest: mcnemar(wins.a, wins.b),
    signFlip,
    verdict,
    stability,
    skipped,
    warnings,
    cases: sorted,
  };
  if (cl) out.cluster = { key: cl.key, clusters: new Set(clusterIds).size };
  return out;
}
