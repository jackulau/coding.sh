// The suite report `coding.sh eval run` prints, after Anthropic's "Demystifying
// evals for AI agents" (2026): per task, how many of its k trials passed; for
// the suite, pass@1 (the mean trial pass rate), pass@k (a task counts when any
// of k trials passes) and pass^k (only when all k pass); flaky tasks (some
// trials pass, some fail); tasks that never passed (0% over many trials most
// often means the task or its grader is broken); and saturation (a capability
// suite every task passes has no room left to climb: graduate it to a
// regression suite).
//
// A regression suite should pass nearly everything, so it fails (exit 1) when a
// task fails most of its trials. A capability suite starts low on purpose and
// never fails on its score.
import { wilson, type Interval } from "../stats/interval.ts";
import { passAllK, passAtK } from "../stats/seqk.ts";
import { paint, pct, table } from "../experiments/text.ts";

export type SuitePurpose = "capability" | "regression";
export const SUITE_PURPOSES: readonly SuitePurpose[] = ["capability", "regression"];

/** A capability suite is saturated when at least this share of its tasks pass every trial. */
export const SATURATION_SHARE = 0.9;
/** Below this many tasks a suite can only show large changes (Anthropic: start with 20 to 50). */
export const SMALL_SUITE = 20;

export interface Trial {
  pass: boolean;
  /** Outcome unknown (a grader or the infrastructure failed): left out of every rate. */
  unknown?: boolean;
  /** The captured session of this trial, when there is one: its transcript. */
  sessionId?: string;
  /** Why it failed, one line. */
  reason?: string;
}

export interface TaskTrials {
  id: string;
  name: string;
  trials: readonly Trial[];
}

export interface TaskRow {
  id: string;
  name: string;
  passed: number;
  /** Trials with a known outcome. */
  n: number;
  unknown: number;
  rate: number;
  /** Some trials passed and some failed. */
  flaky: boolean;
  /** A failed trial's session (the transcript to read first). */
  failedSession?: string;
  reason?: string;
}

export interface SuiteReport {
  suite: string;
  purpose: SuitePurpose;
  /** The k of pass@k and pass^k: the fewest known trials of any task. */
  k: number;
  tasks: number;
  /** pass@1: every known trial, with a 95% Wilson interval. */
  passRate: Interval;
  passed: number;
  trials: number;
  /** Mean over tasks of the unbiased pass@k (Chen et al. 2021); absent when k < 2. */
  passAtK?: number;
  /** Mean over tasks of the unbiased pass^k (tau-bench); absent when k < 2. */
  passHatK?: number;
  rows: TaskRow[];
  flaky: string[];
  neverPassed: string[];
  /** Tasks that failed more than half their trials. */
  failing: string[];
  unknown: number;
  saturated: boolean;
  /** Regression: every task has a graded trial and none fails most of its trials. Capability: always (a low score is the point). */
  ok: boolean;
  notes: string[];
}

export function suiteReport(suite: string, purpose: SuitePurpose, tasks: readonly TaskTrials[]): SuiteReport {
  const rows: TaskRow[] = tasks.map((t) => {
    const known = t.trials.filter((x) => !x.unknown);
    const passed = known.filter((x) => x.pass).length;
    const failed = known.find((x) => !x.pass);
    return {
      id: t.id,
      name: t.name,
      passed,
      n: known.length,
      unknown: t.trials.length - known.length,
      rate: known.length ? passed / known.length : NaN,
      flaky: passed > 0 && passed < known.length,
      ...(failed?.sessionId ? { failedSession: failed.sessionId } : {}),
      ...(failed?.reason ? { reason: failed.reason } : {}),
    };
  });
  const graded = rows.filter((r) => r.n > 0);
  const k = graded.length ? Math.min(...graded.map((r) => r.n)) : 0;
  const passed = graded.reduce((s, r) => s + r.passed, 0);
  const trials = graded.reduce((s, r) => s + r.n, 0);
  const mean = (f: (r: TaskRow) => number) => graded.reduce((s, r) => s + f(r), 0) / graded.length;
  const multi = k >= 2;
  const flaky = graded.filter((r) => r.flaky).map((r) => r.name);
  const neverPassed = graded.filter((r) => r.passed === 0).map((r) => r.name);
  const failing = graded.filter((r) => r.passed * 2 < r.n).map((r) => r.name);
  const allPass = graded.filter((r) => r.passed === r.n).length;
  const saturated = purpose === "capability" && graded.length > 0 && allPass / graded.length >= SATURATION_SHARE;
  const unknown = rows.reduce((s, r) => s + r.unknown, 0);
  const notes: string[] = [];
  if (graded.length && k < 2) notes.push("one trial per task: agents vary from run to run, so pass@k and pass^k need --trials 3 or more");
  if (tasks.length && tasks.length < SMALL_SUITE) notes.push(`${tasks.length} task${tasks.length === 1 ? "" : "s"}: a suite this small only shows large changes; grow it toward 20 to 50 tasks from real failures`);
  if (unknown) notes.push(`${unknown} trial${unknown === 1 ? "" : "s"} with an unknown outcome (grader or infrastructure error), left out of every rate`);
  return {
    suite,
    purpose,
    k,
    tasks: tasks.length,
    passRate: wilson(passed, trials),
    passed,
    trials,
    ...(multi ? { passAtK: mean((r) => passAtK(r.n, r.passed, k)), passHatK: mean((r) => passAllK(r.n, r.passed, k)) } : {}),
    rows,
    flaky,
    neverPassed,
    failing,
    unknown,
    saturated,
    ok: purpose === "capability" || (rows.length > 0 && graded.length === rows.length && failing.length === 0),
    notes,
  };
}

export interface RenderSuiteOpts {
  color: boolean;
  /** How to open a trial's transcript, e.g. (id) => `coding.sh show ${id}`. */
  transcript?: (sessionId: string) => string;
  limit?: number;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function renderSuiteReport(r: SuiteReport, o: RenderSuiteOpts): string {
  const { color } = o;
  const out: string[] = [];
  out.push(`${paint(r.suite, "bold", color)}  ${paint(`${r.purpose} suite · ${r.tasks} task${r.tasks === 1 ? "" : "s"} · ${r.k || "?"} trial${r.k === 1 ? "" : "s"} each`, "dim", color)}`);
  if (!r.trials) {
    out.push(paint("no trial finished with a known outcome", "yellow", color));
    for (const n of r.notes) out.push(paint(n, "dim", color));
    if (r.purpose === "regression") out.push(paint("regression suite: nothing was graded, so it can't pass", "red", color));
    return out.join("\n");
  }
  const tone = r.passRate.p >= 0.8 ? "green" : r.passRate.p >= 0.5 ? "yellow" : "red";
  out.push(`pass@1  ${paint(pct(r.passRate.p), tone, color)} [${pct(r.passRate.lo)}, ${pct(r.passRate.hi)}]  ${paint(`(${r.passed}/${r.trials} trials, 95% Wilson)`, "dim", color)}`);
  if (r.passAtK !== undefined) out.push(`pass@${r.k}  ${pct(r.passAtK)}  ${paint(`a task counts when any of ${r.k} trials passes`, "dim", color)}`);
  if (r.passHatK !== undefined) out.push(`pass^${r.k}  ${pct(r.passHatK)}  ${paint(`a task counts only when all ${r.k} trials pass`, "dim", color)}`);
  out.push("");
  const limit = o.limit ?? 50;
  const shown = [...r.rows].sort((a, b) => (a.rate || 0) - (b.rate || 0) || a.name.localeCompare(b.name)).slice(0, limit);
  out.push(
    table(
      [{ header: "task" }, { header: "passed", align: "right" }, { header: "" }, { header: "first failure" }],
      shown.map((t) => [
        t.name,
        t.n ? `${t.passed}/${t.n}` : "—",
        t.n === 0 ? paint("unknown", "yellow", color) : t.passed === 0 ? paint("never", "red", color) : t.flaky ? paint("flaky", "yellow", color) : paint("ok", "green", color),
        t.failedSession ? (o.transcript ? o.transcript(t.failedSession) : t.failedSession) : t.passed < t.n && t.reason ? oneLine(t.reason, 60) : "",
      ]),
      { color },
    ),
  );
  if (r.rows.length > limit) out.push(paint(`… ${r.rows.length - limit} more (use --json for all)`, "dim", color));
  out.push("");
  if (r.neverPassed.length) out.push(paint(`never passed: ${r.neverPassed.join(", ")}. Read its transcript or output first: a task no trial passes is most often a broken task or grader, not a weak agent.`, "yellow", color));
  if (r.flaky.length) out.push(paint(`flaky: ${r.flaky.join(", ")}. These pass some trials and fail others; pass^${r.k} counts them as failures.`, "yellow", color));
  if (r.saturated) out.push(paint(`saturated: ${pct(1 - r.rows.filter((x) => x.n && x.passed < x.n).length / Math.max(1, r.rows.filter((x) => x.n).length), 0)} of tasks pass every trial, so this suite can no longer show improvement. Set "purpose": "regression" in suite.json to keep it as a regression suite, and add harder tasks.`, "yellow", color));
  for (const n of r.notes) out.push(paint(n, "dim", color));
  if (r.purpose === "regression") {
    const ungraded = r.rows.filter((x) => x.n === 0).map((x) => x.name);
    if (r.ok) out.push(paint("regression suite: no task fails most of its trials", "green", color));
    if (r.failing.length) out.push(paint(`regression suite: ${r.failing.join(", ")} fail${r.failing.length === 1 ? "s" : ""} most trials`, "red", color));
    if (ungraded.length) out.push(paint(`regression suite: ${ungraded.length} of ${r.rows.length} tasks have no graded trial (grader or infrastructure errors), so it can't pass`, "red", color));
  }
  return out.join("\n").replace(/\n+$/, "");
}
