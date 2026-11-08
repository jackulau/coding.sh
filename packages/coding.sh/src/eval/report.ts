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
/** What one row of a suite is: a repo task, a dataset case or a trigger prompt. */
export type SuiteUnit = "task" | "case" | "prompt";
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
  /** What each row is, for the wording: "task", "case" or "prompt". */
  unit: SuiteUnit;
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

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function suiteReport(suite: string, purpose: SuitePurpose, tasks: readonly TaskTrials[], unit: SuiteUnit = "task"): SuiteReport {
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
  if (graded.length && k < 2) notes.push(`one trial per ${unit}: agents vary from run to run, so pass@k and pass^k need --trials 3 or more`);
  if (tasks.length && tasks.length < SMALL_SUITE) notes.push(`${plural(tasks.length, unit)}: a suite this small only shows large changes; grow it toward 20 to 50 ${unit}s from real failures`);
  if (unknown) notes.push(`${unknown} trial${unknown === 1 ? "" : "s"} with an unknown outcome (grader or infrastructure error), left out of every rate`);
  return {
    suite,
    purpose,
    unit,
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
  const u = r.unit;
  const out: string[] = [];
  out.push(`${paint(r.suite, "bold", color)}  ${paint(`${r.purpose} suite · ${plural(r.tasks, u)} · ${r.k || "?"} trial${r.k === 1 ? "" : "s"} each`, "dim", color)}`);
  if (!r.trials) {
    out.push(paint("no trial finished with a known outcome", "yellow", color));
    for (const n of r.notes) out.push(paint(n, "dim", color));
    if (r.purpose === "regression") out.push(paint("regression suite: nothing was graded, so it can't pass", "red", color));
    return out.join("\n");
  }
  const tone = r.passRate.p >= 0.8 ? "green" : r.passRate.p >= 0.5 ? "yellow" : "red";
  out.push(`pass@1  ${paint(pct(r.passRate.p), tone, color)} [${pct(r.passRate.lo)}, ${pct(r.passRate.hi)}]  ${paint(`(${r.passed}/${r.trials} trials, 95% Wilson)`, "dim", color)}`);
  if (r.passAtK !== undefined) out.push(`pass@${r.k}  ${pct(r.passAtK)}  ${paint(`a ${u} counts when any of ${r.k} trials passes`, "dim", color)}`);
  if (r.passHatK !== undefined) out.push(`pass^${r.k}  ${pct(r.passHatK)}  ${paint(`a ${u} counts only when all ${r.k} trials pass`, "dim", color)}`);
  out.push("");
  const limit = o.limit ?? 50;
  const shown = [...r.rows].sort((a, b) => (a.rate || 0) - (b.rate || 0) || a.name.localeCompare(b.name)).slice(0, limit);
  out.push(
    table(
      [{ header: u }, { header: "passed", align: "right" }, { header: "" }, { header: "first failure" }],
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
  if (r.neverPassed.length) out.push(paint(`never passed: ${r.neverPassed.join(", ")}. Read its transcript or output first: a ${u} no trial passes is most often a broken ${u} or grader, not a weak agent.`, "yellow", color));
  if (r.flaky.length) out.push(paint(`flaky: ${r.flaky.join(", ")}. These pass some trials and fail others; pass^${r.k} counts them as failures.`, "yellow", color));
  if (r.saturated) out.push(paint(`saturated: ${pct(1 - r.rows.filter((x) => x.n && x.passed < x.n).length / Math.max(1, r.rows.filter((x) => x.n).length), 0)} of ${u}s pass every trial, so this suite can no longer show improvement. Set "purpose": "regression" in suite.json to keep it as a regression suite, and add harder ${u}s.`, "yellow", color));
  for (const n of r.notes) out.push(paint(n, "dim", color));
  if (r.purpose === "regression") {
    const ungraded = r.rows.filter((x) => x.n === 0).map((x) => x.name);
    if (r.ok) out.push(paint(`regression suite: no ${u} fails most of its trials`, "green", color));
    if (r.failing.length) out.push(paint(`regression suite: ${r.failing.join(", ")} fail${r.failing.length === 1 ? "s" : ""} most trials`, "red", color));
    if (ungraded.length) out.push(paint(`regression suite: ${ungraded.length} of ${plural(r.rows.length, u)} have no graded trial (grader or infrastructure errors), so it can't pass`, "red", color));
  }
  return out.join("\n").replace(/\n+$/, "");
}

/** One suite in the Markdown summary: its report, or the exit code of a run that ended without one. */
export interface MarkdownSuite {
  suite: string;
  report?: SuiteReport;
  exitCode?: number;
  /** Lines under the suite's table: tasks without a reference, the harness, the experiment id. */
  extra?: string[];
}

/** Text with no HTML that could end a <details> block or open a tag. */
const noHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A table cell: one line, with pipes escaped so they don't split it. */
const cell = (s: string, max = 120) => noHtml(oneLine(s, max)).replace(/\|/g, "\\|");

/** Why a regression suite failed, or that a capability suite is not gated. */
function verdict(r: SuiteReport): string {
  if (r.purpose === "capability") return r.saturated ? "not gated (saturated)" : "not gated";
  if (r.ok) return "pass";
  if (!r.trials) return "**fail**: nothing was graded";
  const ungraded = r.rows.filter((x) => x.n === 0).length;
  const names = r.failing.slice(0, 3).map((n) => cell(n, 40)).join(", ") + (r.failing.length > 3 ? ` and ${r.failing.length - 3} more` : "");
  const why = [r.failing.length ? `${names} fail${r.failing.length === 1 ? "s" : ""} most trials` : "", ungraded ? `${ungraded} of ${plural(r.rows.length, r.unit)} have no graded trial` : ""].filter(Boolean);
  return `**fail**: ${why.join("; ")}`;
}

/**
 * The `eval run` report as GitHub-flavored Markdown, for a CI step summary or a
 * pull request comment: one row per suite, then each suite's tasks in a
 * <details> block, open when the suite failed.
 */
export function renderSuitesMarkdown(suites: readonly MarkdownSuite[], o: { transcript?: (sessionId: string) => string; limit?: number } = {}): string {
  const failed = suites.filter((s) => (s.report ? !s.report.ok : (s.exitCode ?? 1) !== 0)).length;
  const n = suites.length;
  const out: string[] = [];
  out.push(`### Evals: ${failed ? `${failed} of ${n} suite${n === 1 ? "" : "s"} failed` : n === 1 ? "the suite passed" : `all ${n} suites passed`}`, "");
  out.push("| Suite | Purpose | Size | Trials passed | pass@1 (95% CI) | pass@k | pass^k | Result |", "| --- | --- | ---: | ---: | --- | ---: | ---: | --- |");
  for (const s of suites) {
    const r = s.report;
    if (!r) {
      out.push(`| ${cell(s.suite)} | | | | | | | **fail**: no report (exit ${s.exitCode ?? 1}) |`);
      continue;
    }
    const p1 = r.trials ? `${pct(r.passRate.p)} [${pct(r.passRate.lo)}, ${pct(r.passRate.hi)}]` : "—";
    const k = (x: number | undefined) => (x === undefined ? "—" : `${pct(x)} (k=${r.k})`);
    out.push(`| ${cell(s.suite)} | ${r.purpose} | ${plural(r.tasks, r.unit)} | ${r.passed}/${r.trials} | ${p1} | ${k(r.passAtK)} | ${k(r.passHatK)} | ${verdict(r)} |`);
  }
  const limit = o.limit ?? 50;
  for (const s of suites) {
    const r = s.report;
    if (!r) continue;
    const u = r.unit;
    const bad = r.rows.filter((x) => x.n === 0 || x.passed < x.n).length;
    const what = bad ? `${bad} with a failed or ungraded trial` : "every trial passed";
    out.push("", `<details${r.ok ? "" : " open"}><summary>${noHtml(s.suite)}: ${plural(r.tasks, u)}, ${what}</summary>`, "");
    out.push(`| ${u.charAt(0).toUpperCase()}${u.slice(1)} | Passed | | First failure |`, "| --- | ---: | --- | --- |");
    const shown = [...r.rows].sort((a, b) => (a.rate || 0) - (b.rate || 0) || a.name.localeCompare(b.name)).slice(0, limit);
    for (const t of shown) {
      const status = t.n === 0 ? "unknown" : t.passed === 0 ? "never" : t.flaky ? "flaky" : "ok";
      const first = t.failedSession ? `\`${(o.transcript ? o.transcript(t.failedSession) : t.failedSession).replace(/`/g, "")}\`` : t.passed < t.n && t.reason ? cell(t.reason, 80) : "";
      out.push(`| ${cell(t.name, 80)} | ${t.n ? `${t.passed}/${t.n}` : "—"} | ${status} | ${first} |`);
    }
    if (r.rows.length > limit) out.push("", `${r.rows.length - limit} more ${u}s: \`coding.sh eval run ${s.suite.replace(/`/g, "")} --json\` lists them all.`);
    const lines = [
      ...(r.neverPassed.length ? [`Never passed: ${r.neverPassed.join(", ")}. A ${u} no trial passes is most often a broken ${u} or grader; read its transcript or output first.`] : []),
      ...(r.flaky.length ? [`Flaky: ${r.flaky.join(", ")}. These pass some trials and fail others.`] : []),
      ...(r.saturated ? [`Saturated: this capability suite can no longer show improvement. Add harder ${u}s, or make it a regression suite.`] : []),
      ...r.notes.map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}.`),
      ...(s.extra ?? []),
    ];
    if (lines.length) out.push("", ...lines.map((l) => `- ${noHtml(oneLine(l, 400))}`));
    out.push("", "</details>");
  }
  return `${out.join("\n")}\n`;
}
