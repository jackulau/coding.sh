// What a regrade changed (X-21): the same stored outputs graded twice, so every
// difference is the graders', never the agent's. Runs pair by case and trial.
import type { CaseRun, ExperimentResult } from "../datasets/types.ts";
import { idList } from "../stats/gate.ts";
import { paint, pct, signedPct, table, type RenderOpts } from "./text.ts";

/** One run's outcome: a task error is copied by a regrade, an ungraded run has no known outcome. */
export type RunOutcome = "pass" | "fail" | "ungraded" | "error";

export interface RegradeFlip {
  caseId: string;
  trial: number;
  before: RunOutcome;
  after: RunOutcome;
}

export interface RegradeGraderChange {
  id: string;
  /** Version before the regrade; absent when the grader is new. */
  before?: string;
  /** Version after; absent when the regrade dropped it. */
  after?: string;
  changed: boolean;
}

export interface RegradeDiff {
  before: { id: string; passRate: number; passed: number; graded: number };
  after: { id: string; passRate: number; passed: number; graded: number };
  /** Runs paired by case and trial. */
  paired: number;
  /** Runs whose outcome changed, in case then trial order. */
  flips: RegradeFlip[];
  /** pass → fail, fail → pass, graded → ungraded, ungraded → graded. */
  toFail: number;
  toPass: number;
  toUngraded: number;
  fromUngraded: number;
  graders: RegradeGraderChange[];
}

export function runOutcome(r: CaseRun): RunOutcome {
  if (r.error !== undefined) return "error";
  if (r.ungraded) return "ungraded";
  return r.pass ? "pass" : "fail";
}

function rate(r: ExperimentResult) {
  const graded = r.summary.n - (r.summary.ungraded ?? 0);
  return { id: r.id, passRate: graded ? r.summary.passed / graded : NaN, passed: r.summary.passed, graded };
}

/** Per-run outcome changes and grader version changes between an experiment and its regrade. */
export function regradeDiff(before: ExperimentResult, after: ExperimentResult): RegradeDiff {
  const key = (r: CaseRun) => `${r.caseId}\u0000${r.trial}`;
  const prev = new Map(before.runs.map((r) => [key(r), r]));
  const flips: RegradeFlip[] = [];
  let paired = 0;
  for (const r of after.runs) {
    const p = prev.get(key(r));
    if (!p) continue;
    paired++;
    const b = runOutcome(p);
    const a = runOutcome(r);
    if (a !== b) flips.push({ caseId: r.caseId, trial: r.trial, before: b, after: a });
  }
  flips.sort((x, y) => (x.caseId < y.caseId ? -1 : x.caseId > y.caseId ? 1 : x.trial - y.trial));
  const count = (f: (x: RegradeFlip) => boolean) => flips.filter(f).length;
  const ids = [...new Set([...before.graders.map((g) => g.id), ...after.graders.map((g) => g.id)])];
  const graders = ids.map((id): RegradeGraderChange => {
    const b = before.graders.find((g) => g.id === id)?.version;
    const a = after.graders.find((g) => g.id === id)?.version;
    return { id, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}), changed: a !== b };
  });
  return {
    before: rate(before),
    after: rate(after),
    paired,
    flips,
    toFail: count((x) => x.before === "pass" && x.after === "fail"),
    toPass: count((x) => x.before === "fail" && x.after === "pass"),
    toUngraded: count((x) => x.before !== "ungraded" && x.after === "ungraded"),
    fromUngraded: count((x) => x.before === "ungraded" && x.after !== "ungraded"),
    graders,
  };
}

const short = (v: string | undefined) => (v === undefined ? "—" : v.length > 12 ? v.slice(0, 12) : v);

/** The regrade report: rates before and after, grader versions, flip counts and the flipped runs. */
export function renderRegradeDiff(d: RegradeDiff, opts: RenderOpts): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const out: string[] = [];
  out.push(`${paint("regrade", "bold", color)} ${d.after.id} ${paint(`of ${d.before.id}; the task was not called`, "dim", color)}`);
  const delta = d.after.passRate - d.before.passRate;
  out.push(
    `pass    ${pct(d.before.passRate)} → ${pct(d.after.passRate)} ${Number.isFinite(delta) ? `(${signedPct(delta)}) ` : ""}` +
      paint(`(${d.before.passed}/${d.before.graded} → ${d.after.passed}/${d.after.graded} graded runs)`, "dim", color),
  );
  for (const g of d.graders) {
    const what = g.before === undefined ? "new" : g.after === undefined ? "dropped" : g.changed ? "changed" : "same";
    out.push(`grader  ${g.id} ${short(g.before)} → ${short(g.after)} ${paint(`(${what})`, g.changed ? "yellow" : "dim", color)}`);
  }
  const ungr = [...(d.toUngraded ? [`${d.toUngraded} now ungraded`] : []), ...(d.fromUngraded ? [`${d.fromUngraded} now graded`] : [])];
  out.push(`flips   ${d.flips.length} of ${d.paired} runs: ${d.toFail} pass → fail, ${d.toPass} fail → pass${ungr.length ? `, ${ungr.join(", ")}` : ""}`);
  if (d.toUngraded) {
    const cases = [...new Set(d.flips.filter((x) => x.after === "ungraded").map((x) => x.caseId))];
    out.push(paint(`! a grader errored on ${idList(cases)}: those runs are left out of the pass rate, not failed`, "yellow", color));
  }
  if (d.flips.length) {
    out.push("");
    out.push(
      table(
        [{ header: "case" }, { header: "trial", align: "right" }, { header: "before" }, { header: "after" }],
        d.flips.slice(0, limit).map((x) => [x.caseId, String(x.trial), x.before, paint(x.after, x.after === "pass" ? "green" : x.after === "fail" ? "red" : "yellow", color)]),
        { color },
      ),
    );
    if (d.flips.length > limit) out.push(paint(`… ${d.flips.length - limit} more (use --json for all)`, "dim", color));
  }
  return out.join("\n");
}
