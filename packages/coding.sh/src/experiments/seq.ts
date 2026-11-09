// `exp run --seq K` (AC-9): sequential attempts with grader feedback. A
// case-trial whose first attempt fails is tried again, up to K attempts, and
// each new attempt sees its earlier outputs and feedback on them; a pass ends
// the trajectory. The first attempt stays the run's outcome (pass rate =
// Seq@1); the trajectory gives the Seq@1..K curve, where the gain lands
// (EGS/LGS), how often a revision changed nothing, and the cost front of
// pass@k against seq@k (Yen et al., arXiv 2610.37859 §3-6, App. A.1-A.2).
//
// Feedback never carries the expected answer: a reason that quotes it has the
// quote replaced with [hidden].
import type { CaseRun, Grader, GraderOutcome, SeqAttempt, SeqSummary, SeqTrajectory } from "../datasets/types.ts";
import { gainShares, passAtK, protocolFront, seqCurve, unchangedRate, type ProtocolPoint } from "../stats/seqk.ts";
import type { TaskContext, TaskSpec } from "./task.ts";

export const SEQ_BIT = "Your previous answer failed the checks.";
/** Reasons feedback: at most this many failed graders, each clipped to this many characters. */
export const SEQ_MAX_REASONS = 3;
export const SEQ_REASON_CHARS = 300;

export interface SeqOpts {
  /** Attempts per case-trial, 2 to 10. */
  k: number;
  /** bit: one fixed sentence; reasons: the failed graders' reasons; critic: a grader's reason on the failed output (it never gates). */
  feedback: "bit" | "reasons" | { critic: Grader };
  /** full (default): every earlier attempt; last: only the one before. */
  history?: "full" | "last";
}

export const seqFeedbackName = (f: SeqOpts["feedback"]): string => (typeof f === "string" ? f : `critic:${f.critic.id}`);

/** Validate the options; a RangeError names the bad one. */
export function checkSeq(o: SeqOpts): void {
  if (!Number.isInteger(o.k) || o.k < 2 || o.k > 10) throw new RangeError(`seq k must be an integer from 2 to 10 (got ${o.k})`);
  if (o.history !== undefined && o.history !== "full" && o.history !== "last") throw new RangeError(`seq history must be full or last (got ${String(o.history)})`);
  if (typeof o.feedback === "string" ? o.feedback !== "bit" && o.feedback !== "reasons" : typeof o.feedback?.critic?.grade !== "function") {
    throw new RangeError("seq feedback must be bit, reasons or a critic grader");
  }
}

/**
 * Why a task can't run in seq mode, or undefined when it can. A function sees
 * ctx.attempt and ctx.history; a command or HTTP task only through its
 * envelope; a continuation or request task replays a fixed prefix.
 */
export function seqTaskError(spec: TaskSpec): string | undefined {
  if (typeof spec === "function" || spec.kind === "function") return undefined;
  if (spec.kind === "command" || spec.kind === "http") {
    return spec.envelope ? undefined : `--seq needs the ${spec.kind} task to read its earlier attempts: set "envelope": true in the task spec, so it gets {input, attempt, k, history} instead of the bare input`;
  }
  return `--seq runs function, command and http tasks; a ${spec.kind} task replays a fixed prefix and can't take feedback`;
}

/** The expected value's verbatim spans: its string form and, for objects, their string leaves. */
function expectedSpans(expected: unknown): string[] {
  if (expected === undefined || expected === null) return [];
  const out = new Set<string>();
  const add = (s: string) => {
    if (s.trim()) out.add(s);
  };
  if (typeof expected === "string") add(expected);
  else {
    const json = JSON.stringify(expected);
    if (json !== undefined) add(json);
    const walk = (v: unknown) => {
      if (typeof v === "string" && v.length >= 3) add(v);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    if (typeof expected === "object") walk(expected);
    else add(String(expected));
  }
  // Longest first, so a leaf inside the JSON form does not break the longer match.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every verbatim span of the expected value with [hidden]. */
export function hideExpected(text: string, expected: unknown): string {
  let out = text;
  for (const s of expectedSpans(expected)) out = out.split(s).join("[hidden]");
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Feedback on a failed attempt, from its grades or its error (bit and reasons; the critic's comes from seqCritic). */
export function seqFeedback(mode: "bit" | "reasons", attempt: { error?: string; grades: readonly GraderOutcome[] }, expected: unknown): string {
  if (mode === "bit") return SEQ_BIT;
  if (attempt.error !== undefined) return `The previous attempt failed with an error: ${clip(hideExpected(attempt.error, expected), SEQ_REASON_CHARS)}`;
  const failed = attempt.grades.filter((g) => g.result?.pass === false && g.result.reason?.trim()).slice(0, SEQ_MAX_REASONS);
  if (!failed.length) return SEQ_BIT;
  return failed.map((g) => `${g.graderId}: ${clip(hideExpected(g.result!.reason!.trim(), expected), SEQ_REASON_CHARS)}`).join("\n");
}

/** A critic's feedback on a failed output, and what it reported it cost. A critic that errors or gives no reason falls back to the bit. */
export async function seqCritic(
  critic: Grader,
  ctx: { input: unknown; output: unknown; expected: unknown; caseId: string; metadata?: Record<string, unknown>; signal?: AbortSignal; error?: string },
): Promise<{ feedback: string; costUsd?: number }> {
  try {
    const r = await critic.grade({
      input: ctx.input,
      output: ctx.error !== undefined ? `(the attempt failed with an error: ${ctx.error})` : ctx.output,
      expected: ctx.expected,
      caseId: ctx.caseId,
      ...(ctx.metadata ? { metadata: ctx.metadata } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const extra = r as { costUsd?: unknown; cost_usd?: unknown };
    const cost = [extra.costUsd, extra.cost_usd].find((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    const reason = r.reason?.trim();
    return { feedback: reason ? clip(hideExpected(reason, ctx.expected), SEQ_REASON_CHARS * SEQ_MAX_REASONS) : SEQ_BIT, ...(cost !== undefined ? { costUsd: cost } : {}) };
  } catch {
    return { feedback: SEQ_BIT };
  }
}

const show = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)));

/**
 * The attempt prompt (arXiv 2610.37859 App. A.2): the task, a note on which
 * attempt this is, then each earlier attempt and its feedback. Outside seq
 * mode, or on attempt 1, the input as text.
 */
export function seqPrompt(input: unknown, ctx: Pick<TaskContext, "attempt" | "k" | "history">): string {
  const task = show(input);
  if (!ctx.attempt || ctx.attempt < 2 || !ctx.history?.length) return task;
  const of = ctx.k ? ` of ${ctx.k}` : "";
  const parts = [task, "", `This is attempt ${ctx.attempt}${of}. Review your previous attempt(s) and the feedback below, then provide an improved answer.`];
  const first = ctx.attempt - ctx.history.length;
  ctx.history.forEach((h, i) => {
    const n = first + i;
    parts.push("", `<PreviousAttempt ${n}>`, show(h.output), `</PreviousAttempt ${n}>`, `<Feedback ${n}>`, h.feedback, `</Feedback ${n}>`);
  });
  return parts.join("\n");
}

const norm = (v: unknown) => show(v ?? "");

/** Mark attempts whose output is the previous one's (whitespace aside). */
export function markUnchanged(attempts: SeqAttempt[], outputs: readonly unknown[]): void {
  for (let i = 1; i < attempts.length; i++) {
    if (attempts[i]!.error !== undefined || attempts[i - 1]!.error !== undefined) continue;
    if (unchangedRate([{ prev: norm(outputs[i - 1]), next: norm(outputs[i]) }]) === 1) attempts[i]!.unchanged = true;
  }
}

/** The Seq@K summary over runs that carry a trajectory; undefined when none does. */
export function summarizeSeq(runs: readonly CaseRun[], trials: number, boot: { iters: number; seed: number }): SeqSummary | undefined {
  const seqRuns = runs.filter((r): r is CaseRun & { seq: SeqTrajectory } => r.seq !== undefined && !r.ungraded);
  if (!seqRuns.length) return undefined;
  const { k, feedback, history } = seqRuns[0]!.seq;
  const byCase = new Map<string, (CaseRun & { seq: SeqTrajectory })[]>();
  for (const r of seqRuns) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const curve = seqCurve(
    [...byCase].map(([id, rs]) => ({ id, solvedAt: rs.map((r) => r.seq.solvedAt ?? null) })),
    k,
    boot,
  );
  const out: SeqSummary = { k, feedback, history, curve, ...gainShares(curve) };
  const revisions = seqRuns.flatMap((r) => r.seq.attempts.slice(1).filter((a) => a.error === undefined));
  if (revisions.length) out.unchangedRate = revisions.filter((a) => a.unchanged).length / revisions.length;
  const allAttempts = seqRuns.flatMap((r) => r.seq.attempts);
  const usd = allAttempts.every((a) => a.costUsd !== undefined);
  const attemptCost = (a: SeqAttempt) => (usd ? (a.costUsd ?? 0) + (a.criticCostUsd ?? 0) : 1);
  const solved = seqRuns.filter((r) => r.seq.solvedAt !== undefined).length;
  if (usd && solved) out.costToSolve = allAttempts.reduce((s, a) => s + attemptCost(a), 0) / solved;
  if (trials >= 2) {
    const per = [...byCase.values()];
    const maxK = Math.min(k, ...per.map((rs) => rs.length));
    if (maxK >= 1) {
      out.passAtK = [];
      for (let j = 1; j <= maxK; j++) {
        const rate = per.reduce((s, rs) => s + passAtK(rs.length, rs.filter((r) => r.pass).length, j), 0) / per.length;
        out.passAtK.push({ k: j, rate });
      }
      const first = seqRuns.reduce((s, r) => s + attemptCost(r.seq.attempts[0]!), 0) / seqRuns.length;
      const points: ProtocolPoint[] = out.passAtK.map((p) => ({ protocol: "pass@k", k: p.k, cost: p.k * first, success: p.rate }));
      for (const p of curve) {
        const cost = seqRuns.reduce((s, r) => s + r.seq.attempts.slice(0, p.k).reduce((t, a) => t + attemptCost(a), 0), 0) / seqRuns.length;
        points.push({ protocol: "seq@k", k: p.k, cost, success: p.rate });
      }
      out.front = protocolFront(points);
      out.costUnit = usd ? "usd" : "attempts";
    }
  }
  return out;
}
