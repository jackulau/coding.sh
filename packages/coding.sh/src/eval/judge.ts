// LLM-judge versioning and calibration. No model calls here: a judge is any
// async function; this module only decides whether its verdicts can be trusted
// by comparing them with human labels (Cohen's κ).
import { hashParts } from "../core/ids.ts";
import type { AgentEvent, IndexStore, Label } from "../core/types.ts";
import { calibrate as calibrateCases, DEFAULT_KAPPA_THRESHOLD, DEFAULT_MIN_N, labelsFromCore, type JudgedCase } from "../judge/calibrate.ts";

export type Verdict = "pass" | "fail";

export interface JudgeSpec {
  /** Human name, e.g. "solved-the-task". */
  id: string;
  version: string;
  /** Label criterion this judge predicts (matches Label.criterion). */
  criterion: string;
  rubric: string;
  model?: string;
}

/**
 * Stable identity of a judge: `<id>@<hash12>` over version, criterion, rubric
 * and model. Any change to what the judge is asked or who answers changes the
 * id, so old calibration never silently applies to a new judge.
 */
export function judgeId(spec: JudgeSpec): string {
  const h = hashParts("judge", spec.version, spec.criterion, spec.rubric, spec.model ?? "").slice(0, 12);
  return `${spec.id}@${h}`;
}

export interface JudgeInput {
  sessionId: string;
  events: AgentEvent[];
  spec: JudgeSpec;
}

export type JudgeFn = (input: JudgeInput) => Promise<Verdict>;

/** Run a judge over sessions. Sessions whose judge call throws are left out and reported. */
export async function runJudge(opts: {
  spec: JudgeSpec;
  judge: JudgeFn;
  index: IndexStore;
  sessionIds: string[];
}): Promise<{ verdicts: Map<string, Verdict>; errors: Map<string, string> }> {
  const verdicts = new Map<string, Verdict>();
  const errors = new Map<string, string>();
  for (const id of opts.sessionIds) {
    try {
      const events = await opts.index.listEvents(id);
      verdicts.set(id, await opts.judge({ sessionId: id, events, spec: opts.spec }));
    } catch (e) {
      errors.set(id, e instanceof Error ? e.message : String(e));
    }
  }
  return { verdicts, errors };
}

export interface Confusion {
  /** judge pass, human pass */
  tp: number;
  /** judge pass, human fail */
  fp: number;
  /** judge fail, human pass */
  fn: number;
  /** judge fail, human fail */
  tn: number;
}

export interface Calibration {
  /** Sessions with both a verdict and a (non-skip) human label. */
  n: number;
  agreement: number;
  /** NaN when degenerate (one class only). */
  kappa: number;
  confusion: Confusion;
  ok: boolean;
  threshold: number;
  /** Why ok is false, when it is. */
  reason?: string;
  /** Human-labelled sessions the judge has no verdict for. */
  unjudged: number;
  /** Sessions whose human labels disagree with each other (resolved by majority, ties dropped). */
  contested: number;
}

/**
 * Collapse multiple human labels per session: majority of pass/fail, "skip"
 * ignored, ties dropped (an honest "humans don't agree" is not a ground truth).
 */
export function humanTruth(labels: readonly Label[], criterion?: string): { truth: Map<string, Verdict>; contested: number } {
  const votes = new Map<string, { pass: number; fail: number }>();
  for (const l of labels) {
    if (criterion !== undefined && l.criterion !== criterion) continue;
    if (l.value === "skip") continue;
    const v = votes.get(l.sessionId) ?? { pass: 0, fail: 0 };
    v[l.value]++;
    votes.set(l.sessionId, v);
  }
  const truth = new Map<string, Verdict>();
  let contested = 0;
  for (const [id, v] of votes) {
    if (v.pass > 0 && v.fail > 0) contested++;
    if (v.pass > v.fail) truth.set(id, "pass");
    else if (v.fail > v.pass) truth.set(id, "fail");
  }
  return { truth, contested };
}

/**
 * Session-level calibration of a judge against human labels. Delegates to
 * src/judge/calibrate.ts so there is one κ threshold, one minN and one set of
 * reasons: every labelled session is treated as the held-out "test" split and
 * nothing is marked as tuned on it. Callers that iterate on a judge prompt
 * must use judge/calibrate.ts directly with honest `tunedOn` splits.
 */
export function calibrate(opts: {
  judgeVerdicts: Map<string, Verdict>;
  labels: Label[];
  /** Only labels for this criterion count (default: all). */
  criterion?: string;
  /** Minimum κ for the judge's scores to count. Default DEFAULT_KAPPA_THRESHOLD (0.6). */
  threshold?: number;
  /** Minimum overlapping sessions for a meaningful κ. Default DEFAULT_MIN_N (20). */
  minN?: number;
}): Calibration {
  const labels = labelsFromCore(opts.criterion === undefined ? opts.labels : opts.labels.filter((l) => l.criterion === opts.criterion));
  const splits = new Map<string, "test">();
  for (const l of labels) splits.set(l.caseId, "test");
  const verdicts = new Map<string, JudgedCase>();
  for (const [caseId, v] of opts.judgeVerdicts) verdicts.set(caseId, { caseId, pass: v === "pass" });
  const r = calibrateCases({
    judge: { id: "session-judge", tunedOn: [] },
    labels,
    verdicts,
    splits,
    reportSplit: "test",
    kappaThreshold: opts.threshold ?? DEFAULT_KAPPA_THRESHOLD,
    minN: opts.minN ?? DEFAULT_MIN_N,
    bootstrapIters: 0,
  });
  const ok = r.state === "calibrated";
  // judge/calibrate counts "fail" as the positive class; this API counts "pass".
  const c = r.confusion;
  const out: Calibration = {
    n: r.n,
    agreement: r.agreement,
    kappa: r.kappa,
    confusion: { tp: c.tn, fp: c.fn, fn: c.fp, tn: c.tp },
    ok,
    threshold: r.threshold,
    unjudged: r.excluded.noVerdict,
    contested: r.noisy.filter((x) => x.kind === "labeler-disagreement").length,
  };
  if (!ok && r.reasons[0]) out.reason = r.reasons[0];
  return out;
}
