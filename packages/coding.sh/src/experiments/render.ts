// Plain-text experiment and comparison reports (stdout = the answer). Scores
// from judges that are not calibrated on held-out human labels are marked
// with "*" wherever they appear, including the overall pass rate they feed.
import type { CalibrationStatus, Case, ExperimentResult, SeqSummary } from "../datasets/types.ts";
import { CASE_KINDS } from "../datasets/types.ts";
import type { KindComparisonReport } from "../datasets/kinds.ts";
import { infraKinds, infraKindsText, infraStopText, voidText } from "../jobs/retry.ts";
import { calibrationBadge } from "../judge/render.ts";
import { llmLine, llmTotals, renderLlmReplay } from "../llmcache/report.ts";
import { formatVerifierAudit, verifierCorrected, type VerifierAudit, type VerifierCorrection } from "../judge/verifier.ts";
import type { RoganGladenResult } from "../stats/interval.ts";
import type { SequentialOutcome } from "../stats/sequential.ts";
import type { AaResult } from "./aa.ts";
import type { MatrixResult } from "./matrix-run.ts";
import { gateDetail, gateHeadline, idList } from "../stats/gate.ts";
import type { ArmAttrition, Comparison, ComparisonGate, ComparisonNonInferiority, ComparisonTurnover } from "./compare.ts";
import type { PairwiseSummary } from "./pairwise.ts";
import type { PairwiseReplication } from "./replicate.ts";
import { selectionOf, type CaseSelection } from "./select.ts";
import { exactPowerText, mdeText } from "./power.ts";
import type { ExperimentBlock, ExpSession, SessionBlock } from "./session.ts";
import { stabilityLine } from "./stability.ts";
import type { SweepResult } from "./sweep.ts";
import type { Turnover } from "./turnover.ts";
import { fixed, ms, paint, pct, pValue, signedPct, table, truncate, type RenderOpts } from "./text.ts";
import { formatBestSet } from "../stats/mcb.ts";

const trusted = (c: CalibrationStatus | undefined) => c === undefined || c.state === "calibrated";

/** The columns (header cells or body cells) whose `keep` entry is true. */
const keepColumns = <T>(keep: readonly boolean[], cols: readonly T[]): T[] => cols.filter((_, i) => keep[i]);

function ci(lo: number, hi: number): string {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${pct(lo)}, ${pct(hi)}]` : "—";
}

function untrustedLegend(r: Pick<ExperimentResult, "graders">, color: boolean): string[] {
  const bad = r.graders.filter((g) => !trusted(g.calibration));
  if (!bad.length) return [];
  return bad.map((g) =>
    paint(
      `* ${g.id}: ${calibrationBadge(g.calibration, false)} — ${g.calibration?.reason ?? "judge scores are not validated against human labels"}`,
      "yellow",
      color,
    ),
  );
}

/** Why a run failed, in one line: the task error or the first failing grader. */
export function failureReason(run: ExperimentResult["runs"][number]): string {
  if (run.error !== undefined) return `error: ${run.error}`;
  for (const g of run.grades) {
    if (g.error !== undefined) return `${g.graderId}: grader error: ${g.error}`;
    if (g.result && !g.result.pass) return `${g.graderId}: ${g.result.reason ?? `score ${fixed(g.result.score)}`}`;
  }
  return "";
}

/** A failure reason as a table shows it: an Anthropic 529 also says "overloaded". */
export function shownReason(reason: string): string {
  return /overload/i.test(reason) ? reason : reason.replace(/(\b(?:HTTP|status(?: code)?:?|error:?|API) ?529)\b/i, "$1 (overloaded)");
}

const PROMPT_KEYS = ["prompt", "task", "instruction", "question", "message", "text", "input"];

/**
 * A short label per case id for failure tables: the case's `name` or `title`
 * metadata, else its input on one line (an object's prompt field when it has
 * one, else its JSON), cut to 40 characters.
 */
export function caseLabels(cases: readonly Pick<Case, "id" | "input" | "metadata">[]): Map<string, string> {
  const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const out = new Map<string, string>();
  for (const c of cases) {
    const named = [c.metadata?.name, c.metadata?.title].find(str);
    const i = c.input;
    const prompt = i && typeof i === "object" && !Array.isArray(i) ? PROMPT_KEYS.map((k) => (i as Record<string, unknown>)[k]).find(str) : undefined;
    const text = named ?? (typeof i === "string" ? i : (prompt ?? JSON.stringify(i) ?? ""));
    const line = text.replace(/\s+/g, " ").trim();
    if (line) out.set(c.id, truncate(line, 40));
  }
  return out;
}

/** Whether a stored experiment is a checkpoint written mid-run (`exp run` keeps one while it runs). */
export function isCheckpoint(r: Pick<ExperimentResult, "metadata">): boolean {
  const ck = r.metadata?.checkpoint as { done?: unknown } | undefined;
  return !!ck && typeof ck.done === "number";
}

/** "12 of 40: failing in exp_…, sample 10 (seed 3)". */
export function selectionText(s: CaseSelection): string {
  const parts = [
    ...(s.from ? [`${s.from.kind === "failing" ? "failing in" : "errors in"} ${s.from.experiment}`] : []),
    ...(s.cases?.length ? [`case ${s.cases.join(", ")}`] : []),
    ...(s.sample !== undefined ? [`sample ${s.sample} (seed ${s.seed ?? 0})`] : []),
    ...(s.firstN !== undefined ? [`first ${s.firstN}`] : []),
  ];
  return `${s.selected} of ${s.of}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

export function renderExperiment(r: ExperimentResult, opts: RenderOpts & { verifiers?: ReadonlyMap<string, VerifierAudit>; cases?: ReadonlyMap<string, string> }): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const s = r.summary;
  const anyUntrusted = r.graders.some((g) => !trusted(g.calibration));
  const star = (t: boolean) => (t ? "" : paint("*", "yellow", color));
  const auditOf = (id: string) => {
    const version = r.graders.find((g) => g.id === id)?.version;
    return version ? opts.verifiers?.get(version) : undefined;
  };
  const out: string[] = [];
  out.push(`${paint(r.name, "bold", color)}  ${paint(r.id, "dim", color)}`);
  out.push(`dataset ${r.dataset.name}@${r.dataset.version}${r.dataset.split ? ` (${r.dataset.split})` : ""}  task ${r.task.kind}: ${r.task.ref}  trials ${r.trials}`);
  if (r.status === "cancelled" && s.n === 0) {
    out.push(paint("cancelled before any case run finished: nothing was graded", "yellow", color));
    return out.join("\n");
  }
  const rateColor = s.passRate.p >= 0.8 ? "green" : s.passRate.p >= 0.5 ? "yellow" : "red";
  const v = s.caseVerdicts;
  if (r.samples === "adaptive" && v) {
    // The trial count depends on the outcomes, so an interval over it is biased: no CI.
    const cases = v.passed + v.failed;
    const p = cases ? v.passed / cases : NaN;
    out.push(
      `pass    ${paint(pct(p), p >= 0.8 ? "green" : p >= 0.5 ? "yellow" : "red", color)}${star(!anyUntrusted)} ` +
        `${paint(`(${v.passed}/${cases} cases; adaptive, no CI: 2 trials each, a 3rd on ${v.tieBreaks} disagreement${v.tieBreaks === 1 ? "" : "s"}; a case fails at half or more failing)`, "dim", color)}`,
    );
  } else {
    out.push(
      `pass    ${paint(pct(s.passRate.p), rateColor, color)}${star(!anyUntrusted)} ${ci(s.passRate.lo, s.passRate.hi)} ` +
        `${paint(`(${s.passed}/${s.n - (s.ungraded ?? 0)}${r.trials > 1 ? ` over ${s.cases} cases` : ""}, 95% ${s.ciMethod === "wilson" ? "Wilson" : "cluster bootstrap"})`, "dim", color)}`,
    );
  }
  if (r.regression) out.push(paint(`regression: case ${r.regression.caseId} passed every trial of ${r.regression.baseline} and fails here; the run stopped (--stop-on-regression)`, "red", color));
  else if (r.infraStop) out.push(paint(infraStopText(r.infraStop), "red", color));
  else if (r.status === "cancelled" && isCheckpoint(r)) {
    const ck = r.metadata!.checkpoint as { done: number; total: number };
    out.push(paint(`partial: ${ck.done} of ${ck.total} case runs, written while the run was going; it is still running or stopped without finishing. Continue with: coding.sh exp run … --resume ${r.id}`, "yellow", color));
  } else if (r.status === "cancelled") out.push(paint(`cancelled: only ${s.n} case run${s.n === 1 ? "" : "s"} finished before the interrupt; this result is partial`, "yellow", color));
  if (s.n > 0 && s.infra === s.n && !r.infraStop) out.push(paint(voidText(s.n, infraKinds(r.runs)), "red", color));
  const sel = selectionOf(r);
  if (sel) out.push(paint(`cases   ${selectionText(sel)}`, "dim", color));
  if (s.kinds) {
    const cells = CASE_KINDS.flatMap((k) => {
      const x = s.kinds![k];
      return x ? [`${k} ${pct(x.passRate.p)} ${paint(`(${x.passed}/${x.n - (x.ungraded ?? 0)})`, "dim", color)}`] : [];
    });
    out.push(`kinds   ${cells.join("  ")}`);
  }
  // Task errors that were infrastructure are reported on the infra line, not as task errors.
  const taskErrors = s.errors - (s.infra ?? 0);
  if (taskErrors > 0) out.push(paint(`errors  ${taskErrors} task error(s)`, "red", color));
  const unscored = llmTotals(r.runs)?.unscored ?? 0;
  const graderErrors = (s.ungraded ?? 0) - (s.infra ?? 0) - unscored;
  if (graderErrors > 0) out.push(paint(`ungraded ${graderErrors} run(s) with a grader error: outcome unknown, left out of the pass rate`, "yellow", color));
  if (s.infra) out.push(paint(`infra ${s.infra} run(s) failed on infrastructure after retries (${infraKindsText(infraKinds(r.runs))}): outcome unknown, left out of the pass rate; --resume runs them again`, "yellow", color));
  const retried = r.runs.filter((x) => (x.attempts ?? 1) > 1);
  if (retried.length) out.push(paint(`retried ${retried.length} run(s) after infrastructure errors (${retried.reduce((n, x) => n + (x.attempts ?? 1) - 1, 0)} extra attempts); failures are never retried`, "dim", color));
  out.push(`latency median ${ms(s.latencyMs.median)}, p90 ${ms(s.latencyMs.p90)}, max ${ms(s.latencyMs.max)}`);
  const llm = llmLine(r);
  if (llm) out.push(llm);
  if (unscored) out.push(paint(`unscored ${unscored} replayed run(s) could not run past the replay boundary (no source recording, or an upstream error): left out of the pass rate`, "yellow", color));
  if (s.seq) out.push("", ...renderSeq(s.seq, color));
  if (s.graders.length) {
    out.push("");
    out.push(
      table(
        [
          { header: "grader" },
          { header: "kind" },
          { header: "pass", align: "right" },
          { header: "95% CI" },
          { header: "mean score", align: "right" },
          { header: "errors", align: "right" },
          { header: "trust" },
        ],
        s.graders.map((g) => {
          const t = trusted(g.calibration);
          const audit = auditOf(g.id);
          return [
            g.id,
            g.kind,
            pct(g.passRate.p) + star(t),
            ci(g.passRate.lo, g.passRate.hi),
            fixed(g.meanScore) + star(t),
            String(g.errors),
            g.calibration ? calibrationBadge(g.calibration, color) : audit?.precision !== undefined ? `precision ${fixed(audit.precision)} (n=${audit.passes})` : paint("deterministic", "dim", color),
          ];
        }),
        { color },
      ),
    );
    for (const g of s.graders) {
      const audit = auditOf(g.id);
      const v = audit && g.n > 0 ? verifierCorrected(g.passed / g.n, g.n, audit) : undefined;
      if (!v) continue;
      out.push(`${g.id} verifier-corrected pass ${pct(v.p)} ${ci(v.lo, v.hi)} ${paint(`(${formatVerifierAudit(audit!)}${v.assumesNoFalseRejects ? "; assumes no false rejects" : ""})`, "dim", color)}`);
    }
  }
  const legend = untrustedLegend(r, color);
  if (legend.length) out.push("", ...legend);
  // Failures, then ungraded runs (a grader errored: outcome unknown, not a failure).
  for (const [title, rows] of [
    ["failures", r.runs.filter((x) => !x.pass && !x.ungraded)],
    ["ungraded", r.runs.filter((x) => x.ungraded)],
  ] as const) {
    if (!rows.length) continue;
    out.push("");
    out.push(`${paint(title, "bold", color)} ${rows.length}`);
    const reasonOf = (x: (typeof rows)[number]) => truncate(shownReason(failureReason(x)), 100);
    const label = (id: string) => opts.cases?.get(id);
    const labelled = rows.some((x) => label(x.caseId) !== undefined);
    const shown = <T>(cols: T[]) => keepColumns([true, labelled, r.trials > 1, true], cols);
    const groups = new Map<string, (typeof rows)[number][]>();
    for (const x of rows) groups.set(reasonOf(x), [...(groups.get(reasonOf(x)) ?? []), x]);
    if (groups.size < rows.length) {
      // The same reason on several runs: one row per reason, with how many and which cases.
      const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
      out.push(
        table(
          [{ header: "runs", align: "right" }, { header: "reason" }, { header: "cases" }],
          sorted.slice(0, limit).map(([why, xs]) => {
            const ids = [...new Set(xs.map((x) => x.caseId))];
            // Each case id with its label, shorter when the row names several.
            const shown = ids.slice(0, 3).map((id) => (label(id) ? `${id} ${ids.length === 1 ? label(id) : truncate(label(id)!, 20)}` : id));
            return [String(xs.length), why, `${shown.join(", ")}${ids.length > 3 ? ` +${ids.length - 3} more` : ""}`];
          }),
          { color },
        ),
      );
      if (sorted.length > limit) out.push(paint(`… ${sorted.length - limit} more reasons (use --json for all)`, "dim", color));
      continue;
    }
    out.push(
      table(
        shown([{ header: "case" }, { header: "input" }, { header: "trial", align: "right" as const }, { header: "reason" }]),
        rows.slice(0, limit).map((x) => shown([x.caseId, label(x.caseId) ?? "", String(x.trial), reasonOf(x)])),
        { color },
      ),
    );
    if (rows.length > limit) out.push(paint(`… ${rows.length - limit} more (use --json for all)`, "dim", color));
  }
  return out.join("\n");
}

export function renderComparison(c: Comparison, opts: RenderOpts & { a?: ExperimentResult; b?: ExperimentResult; matrix?: boolean; cases?: ReadonlyMap<string, string> }): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const out: string[] = [];
  // A forced compare of a cancelled experiment keeps saying it is partial.
  const partial = (e?: ExperimentResult) => (e?.status === "cancelled" ? `  ${paint(`cancelled: ${e.runs.length} case run${e.runs.length === 1 ? "" : "s"} only`, "yellow", color)}` : "");
  out.push(`${paint("A", "bold", color)} ${c.a.name} ${paint(c.a.id, "dim", color)}  pass ${pct(c.a.passRate)}${partial(opts.a)}`);
  out.push(`${paint("B", "bold", color)} ${c.b.name} ${paint(c.b.id, "dim", color)}  pass ${pct(c.b.passRate)}${partial(opts.b)}`);
  if (c.datasetWarning) out.push(paint(`! ${c.datasetWarning}`, "yellow", color));
  if (c.gradeWarning) out.push(paint(`! ${c.gradeWarning}`, "yellow", color));
  if (c.ungradedCases) out.push(paint(`unpaired because ungraded on a side: ${idList(c.ungradedCases)}`, "dim", color));
  if (c.instrumentWarning) out.push(paint(`! ${c.instrumentWarning}`, "yellow", color));
  if (c.timing.warning) out.push(paint(`! ${c.timing.warning}`, "yellow", color));
  if (c.selectionWarning) out.push(paint(`! ${c.selectionWarning}`, "yellow", color));
  const vColor = c.verdict === "better" ? "green" : c.verdict === "worse" ? "red" : "dim";
  out.push("");
  out.push(
    `B − A   ${paint(signedPct(c.diff.mean), vColor, color)} [${signedPct(c.diff.lo)}, ${signedPct(c.diff.hi)}] ` +
      paint(
        c.cluster
          ? `(${c.paired} paired cases in ${c.cluster.clusters} ${c.cluster.key} clusters, 95% cluster bootstrap)`
          : `(${c.paired} paired cases, 95% paired bootstrap)`,
        "dim",
        color,
      ),
  );
  if (c.cluster?.missing) out.push(paint(`${c.cluster.missing} paired case(s) have no ${c.cluster.key}; each counts as its own cluster`, "dim", color));
  if (c.cluster?.warning) out.push(paint(`! ${c.cluster.warning}`, "yellow", color));
  const unit = c.cluster ? `${c.cluster.key} cluster` : "case";
  const flipUnits = `${c.signFlip.units} ${unit}${c.signFlip.units === 1 ? "" : "s"}`;
  out.push(`mcnemar p=${pValue(c.mcnemar.p)}  ${c.mcnemar.b} regressed, ${c.mcnemar.c} improved  ${paint(`sign-flip p=${pValue(c.signFlip.p)} over ${flipUnits}`, "dim", color)}`);
  if (c.posterior) {
    const q = c.posterior;
    out.push(
      `bayes   P(B>A)=${q.pBetter > 0.995 ? ">0.99" : q.pBetter < 0.005 ? "<0.01" : q.pBetter.toFixed(2)}  B − A ${signedPct(q.mean)} [${signedPct(q.lo)}, ${signedPct(q.hi)}] ` +
        paint(`(95% credible, Dirichlet on paired outcomes; shown below 100 paired cases)`, "dim", color),
    );
  }
  if (c.passK) {
    const { a, b } = c.passK;
    const same = a.k === b.k;
    out.push(
      `${same ? `pass^${a.k}`.padEnd(8) : "pass^k  "}A ${pct(a.rate)}${same ? "" : ` (k=${a.k})`}  B ${pct(b.rate)}${same ? "" : ` (k=${b.k})`}  ` +
        `${signedPct(c.passK.diff)} ${paint("(cases where every trial passed)", "dim", color)}`,
    );
  }
  if (c.seqK) {
    const q = c.seqK;
    out.push(
      `${`seq@${q.k}`.padEnd(8)}A ${pct(q.a)}  B ${pct(q.b)}  B − A ${signedPct(q.diff.mean)} [${signedPct(q.diff.lo)}, ${signedPct(q.diff.hi)}] ` +
        paint(`(solved within ${q.k} attempts, ${q.feedback} feedback, ${q.n} paired cases, 95% paired bootstrap)`, "dim", color),
    );
  }
  if (c.seqNote) out.push(paint(`! ${c.seqNote}`, "yellow", color));
  // With one trial per case, coverage is the pass rate and gained/lost are McNemar's flips.
  const multi = c.passK !== undefined;
  if (multi && c.turnover.paired) out.push(...renderTurnover(c.turnover, color));
  if (c.sequential) out.push(...renderSequential(c.sequential, color));
  if (c.sequentialWarning) out.push(paint(`! ${c.sequentialWarning}`, "yellow", color));
  const onSeq = c.verdictOn === "seq" && c.seqK ? `Seq@${c.seqK.k}` : undefined;
  const ciExcludes0 = c.diff.lo > 0 || c.diff.hi < 0;
  const seqExcludes0 = !!c.seqK && (c.seqK.diff.lo > 0 || c.seqK.diff.hi < 0);
  const why = !c.paired
    ? "no paired cases"
    : c.selectionWarning
    ? "one side ran only on the other's failures"
    : onSeq
      ? seqExcludes0
        ? `the ${onSeq} CI excludes 0, but the exact sign-flip test over its per-case differences does not`
        : `${onSeq} CI includes 0`
      : c.sequential
        ? c.verdict === "inconclusive"
          ? "no boundary crossed"
          : "group sequential test"
        : ciExcludes0
          ? `the CI excludes 0, but the exact sign-flip test does not: p=${pValue(c.signFlip.p)} over ${flipUnits}`
          : "CI includes 0";
  out.push(`verdict ${paint(c.verdict === "inconclusive" ? `inconclusive (${why})` : `B is ${c.verdict}${onSeq ? ` (on ${onSeq})` : c.sequential ? ` (${why})` : ""}`, vColor, color)}`);
  if (c.verdictOn === "pass") out.push(paint("! --verdict seq: no Seq@K row to read the verdict from, so it is the first-attempt pass rate's", "yellow", color));
  if (c.gate) out.push(...renderGate(c.gate, color));
  if (c.nonInferiority) out.push(...renderNonInferiority(c.nonInferiority, color));
  const p = c.power;
  out.push(
    `power   MDE ${mdeText(p.mde)}${exactPowerText(p)} ` +
      paint(
        `(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? fixed(p.sd) : "—"}${p.exact ? `, ${Math.round(p.exact.discordance * 100)}% discordant` : ""})`,
        "dim",
        color,
      ),
  );
  if (p.noise) {
    out.push(
      `noise   A/A flip rate on this dataset ${pct(p.noise.flipRate)} ` +
        paint(`(sd ${fixed(p.noise.sd)} over ${p.noise.paired} cases${p.noise.used ? "; the MDE uses it as a floor" : ""})`, "dim", color),
    );
  }
  if (c.replay) {
    const r = c.replay;
    out.push(`replay noise floor ${pct(r.rate, 0)} (n=${r.n}) ${paint(`${ci(r.lo, r.hi)}; control arm vs the recorded turns from the same prefixes`, "dim", color)}`);
    if (r.warning) out.push(paint(`! ${r.warning}`, "yellow", color));
  }
  if (c.controlWarning) out.push(paint(`! ${c.controlWarning}`, "yellow", color));
  if (c.llmReplay) out.push(...renderLlmReplay(c.llmReplay, (s, style) => paint(s, style, color)));
  for (const w of p.warnings) out.push(paint(`! ${w.message}`, "yellow", color));
  const att = c.attrition;
  if (att.a.lost || att.b.lost) {
    const arm = (x: ArmAttrition) => {
      const n = (k: number, what: string) => (k ? [`${k} ${what}${k === 1 ? "" : "s"}`] : []);
      const parts = [...n(x.infra, "infra error"), ...n(x.agent, "agent error"), ...n(x.ungraded, "ungraded run"), ...n(x.missing, "missing run")];
      return `${x.lost}/${x.runs}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    };
    out.push(`lost    A ${arm(att.a)}  B ${arm(att.b)}  ${paint(`Fisher p=${pValue(att.p)}`, "dim", color)}`);
  }
  if (att.warning) out.push(paint(`! ${att.warning}`, "yellow", color));
  if (c.onlyInA.length || c.onlyInB.length) out.push(paint(`unpaired: ${c.onlyInA.length} only in A, ${c.onlyInB.length} only in B`, "dim", color));
  const untrusted = new Set(
    [...(opts.a?.graders ?? []), ...(opts.b?.graders ?? [])].filter((g) => !trusted(g.calibration)).map((g) => g.id),
  );
  const anyPpi = c.graders.some((g) => g.ppi);
  if (c.graders.length) {
    out.push("");
    out.push(
      table(
        [
          { header: "grader" },
          { header: "A", align: "right" },
          { header: "B", align: "right" },
          { header: "B − A", align: "right" },
          { header: "95% CI" },
          ...(anyPpi ? [{ header: "judge-corrected B − A (human scale)" }] : []),
        ],
        c.graders.map((g) => {
          const s = untrusted.has(g.id) ? paint("*", "yellow", color) : "";
          const row = [g.id + s, fixed(g.meanA), fixed(g.meanB), (g.diff.mean >= 0 ? "+" : "") + fixed(g.diff.mean), `[${fixed(g.diff.lo)}, ${fixed(g.diff.hi)}]`];
          if (anyPpi) {
            const d = g.ppi?.corrected?.diff;
            row.push(d ? `${signedPct(d.mean)} [${signedPct(d.lo)}, ${signedPct(d.hi)}]` : paint("raw (uncorrected)", "dim", color));
          }
          return row;
        }),
        { color },
      ),
    );
    for (const g of c.graders) {
      const p = g.ppi;
      if (!p) continue;
      if (p.corrected) {
        const k = p.corrected;
        out.push(
          paint(
            `${g.id} PPI++ ${k.method}: ${p.labels.a} + ${p.labels.b} human labels, λ A ${fixed(k.a.lambda)} B ${fixed(k.b.lambda)}; raw judge B − A ${signedPct(k.raw)}; A ${pct(k.a.theta)} B ${pct(k.b.theta)} on the human scale`,
            "dim",
            color,
          ),
        );
      } else if (p.reason) out.push(paint(`${g.id} raw (uncorrected): ${p.reason}`, "dim", color));
      for (const w of g.warnings ?? []) out.push(paint(`! ${g.id}: ${w}`, "yellow", color));
    }
    if (untrusted.size) out.push(paint("* uncalibrated judge: score differences are not validated against human labels", "yellow", color));
    for (const g of c.graders) if (g.stability) out.push(paint(`${g.id} ${stabilityLine(g.stability)}`, "dim", color));
    const side = (r: RoganGladenResult | undefined) =>
      r === undefined ? "—" : r.corrected ? `${pct(r.p)} ${ci(r.lo, r.hi)}` : "refused (sensitivity + specificity ≤ 1)";
    for (const g of c.graders) {
      if (!g.corrected) continue;
      out.push(`${g.id} bias-corrected pass  A ${side(g.corrected.a)}  B ${side(g.corrected.b)} ${paint("(Rogan–Gladen, 95%)", "dim", color)}`);
    }
    const vside = (v: VerifierCorrection | undefined) => (v ? `${pct(v.p)} ${ci(v.lo, v.hi)} (precision ${fixed(v.precision)}, n=${v.n})` : "—");
    for (const g of c.graders) {
      if (!g.verifier) continue;
      const assumes = [g.verifier.a, g.verifier.b].some((v) => v?.assumesNoFalseRejects);
      out.push(`${g.id} verifier-corrected pass  A ${vside(g.verifier.a)}  B ${vside(g.verifier.b)} ${paint(`(audited precision, 95%${assumes ? "; assumes no false rejects" : ""})`, "dim", color)}`);
    }
  }
  const list = (title: string, rows: Comparison["regressions"], style: "red" | "green") => {
    if (!rows.length) return;
    out.push("");
    out.push(`${paint(title, "bold", color)} ${rows.length}`);
    const keep = [true, rows.some((x) => opts.cases?.has(x.caseId)), true, true, true];
    out.push(
      table(
        keepColumns(keep, [{ header: "case" }, { header: "input" }, { header: "A", align: "right" as const }, { header: "B", align: "right" as const }, { header: "Δ", align: "right" as const }]),
        rows.slice(0, limit).map((x) => keepColumns(keep, [x.caseId, opts.cases?.get(x.caseId) ?? "", pct(x.a, 0), pct(x.b, 0), paint(signedPct(x.delta, 0), style, color)])),
        { color },
      ),
    );
    if (rows.length > limit) out.push(paint(`… ${rows.length - limit} more (use --json for all)`, "dim", color));
  };
  if (c.kinds) out.push("", ...renderKinds(c.kinds, color));
  if (opts.matrix && c.turnover.matrix) out.push("", ...renderMatrix(c.turnover, color));
  if (multi && c.turnover.lost.length) {
    const lost = new Set(c.turnover.lost);
    list("lost coverage", c.regressions.filter((x) => lost.has(x.caseId)), "red");
  }
  list("regressions", c.regressions, "red");
  list("improvements", c.improvements, "green");
  return out.join("\n");
}

/** TB-12: A → B per case kind, then the bad cases still failing and the guards and controls that broke. */
function renderKinds(k: KindComparisonReport, color: boolean): string[] {
  const cells = k.kinds.map((x) => {
    const moved = x.kind === "bad" ? `${x.fixed!.length}/${x.paired} fixed` : `${x.broken!.length}/${x.paired} broke`;
    const bad = x.kind === "bad" ? x.stillFailing!.length > 0 : x.broken!.length > 0;
    return `${x.kind} ${pct(x.a)} → ${pct(x.b)} ${paint(`(${moved})`, bad ? (x.kind === "bad" ? "yellow" : "red") : "dim", color)}`;
  });
  const out = [`kinds   ${cells.join("  ")}`];
  for (const n of k.notes) out.push(paint(`! ${n}`, /^(regression|overcorrection)/.test(n) ? "red" : "yellow", color));
  return out;
}

const pp = (x: number) => signedPct(x);
const span = (t: readonly [number, number]) => (t[0] === t[1] ? `trial ${t[0]}` : `trials ${t[0]}-${t[1]}`);

/** Coverage (passed in any trial) gained and lost, the reliability shift and the trial-half check. */
function renderTurnover(t: ComparisonTurnover, color: boolean): string[] {
  const lost = t.lost.length ? paint(`lost ${t.lost.length}`, "red", color) : "lost 0";
  const out = [
    `coverage A ${pct(t.coverage.a)} → B ${pct(t.coverage.b)} (${pp(t.coverage.diff)})  gained ${t.gained.length}  ${lost}  kept ${t.keptCovered} ` +
      paint(`(cases that passed in any of ${t.k ?? "k"} trials)`, "dim", color),
    `         reliability ${t.reliability.up} up, ${t.reliability.down} down, ${t.reliability.same} same ${paint("(cases by per-case pass rate)", "dim", color)}`,
  ];
  const h = t.halves;
  if (h) {
    out.push(`halves  ${span(h.first.trials)} ${pp(h.first.avgDiff)}, ${span(h.second.trials)} ${pp(h.second.avgDiff)} ${paint("(B − A mean pass rate in each half of the trials)", "dim", color)}`);
    if (t.warning) out.push(paint(`! ${t.warning}`, "yellow", color));
    else if (h.reversed.avg) out.push(paint(`! the change reverses between trial halves (${span(h.first.trials)} vs ${span(h.second.trials)}); confirm with more trials`, "yellow", color));
  }
  return out;
}

/** `exp compare --matrix`: cases by passes in A (rows) and in B (columns); below the diagonal B passed fewer. */
function renderMatrix(t: Turnover, color: boolean): string[] {
  const m = t.matrix as number[][];
  const k = m.length - 1;
  const cell = (n: number, i: number, j: number) => (n === 0 ? paint("·", "dim", color) : i > j ? paint(String(n), "red", color) : j > i ? paint(String(n), "green", color) : String(n));
  return [
    `${paint("success counts", "bold", color)} ${paint(`(cases by passes out of ${k}: A in rows, B in columns)`, "dim", color)}`,
    table(
      [{ header: "A\\B" }, ...m.map((_, j) => ({ header: String(j), align: "right" as const }))],
      m.map((r, i) => [String(i), ...r.map((n, j) => cell(n, i, j))]),
      { color },
    ),
  ];
}

const GATE_COLOR = { ship: "green", hold: "bold", "dont-ship": "red" } as const;

/** `gate    Ship it: …`, the numbers under it, the lost cases and any note. */
function renderGate(g: ComparisonGate, color: boolean): string[] {
  const head = g.judgeHold ? `Hold: judges disagree (${g.judgeHold.detail})` : gateHeadline(g, "case");
  const out = [`gate    ${paint(head, GATE_COLOR[g.verdict], color)}`, `        ${paint(gateDetail(g), "dim", color)}`];
  if (g.lostCases.length) out.push(`        lost: ${idList(g.lostCases)}`);
  if (g.note) out.push(paint(`! ${g.note}`, "yellow", color));
  return out;
}

/** `exp compare --margin`: is B at most δ worse, and which pass^k cases it now mostly fails. */
function renderNonInferiority(ni: ComparisonNonInferiority, color: boolean): string[] {
  const level = `${Math.round((1 - 2 * ni.alpha) * 100)}% CI`;
  const head = `non-inf B − A ≥ ${signedPct(-ni.delta)}: `;
  const bound = `${level} lower bound ${signedPct(ni.lower)} ${ni.lower > -ni.delta ? ">" : "≤"} ${signedPct(-ni.delta)}`;
  const exact = `sign-flip p=${pValue(ni.p)} ${ni.p < ni.alpha ? "<" : "≥"} ${ni.alpha} over ${ni.units} unit${ni.units === 1 ? "" : "s"}`;
  const out = [
    !ni.n
      ? `${head}${paint("unknown (no paired cases)", "yellow", color)}`
      : `${head}${ni.nonInferior ? paint("yes", "green", color) : paint("no", "red", color)} ${paint(`(${bound}, ${exact})`, "dim", color)}`,
  ];
  if (ni.hardRegressions.length) {
    out.push(paint(`! B now mostly fails ${ni.hardRegressions.length} case(s) A passed on every trial: ${idList(ni.hardRegressions)}`, "yellow", color));
  }
  return out;
}

/** The plan, where a group sequential A/B stopped and why, and its repeated CI. */
export function renderSequential(s: SequentialOutcome, color: boolean): string[] {
  const p = s.plan;
  const K = p.looks.length;
  const last = s.history.at(-1);
  const out = [`plan    group sequential, ${K} look${K === 1 ? "" : "s"} at ${p.looks.join("/")} paired cases ${paint(`(O'Brien–Fleming spending, α ${p.alpha})`, "dim", color)}`];
  const z = (l: NonNullable<typeof last>) => `|z| ${fixed(Math.abs(l.z))} ${l.crossed ? "≥" : "<"} ${fixed(l.bound)}`;
  if (!last) out.push(`stopped cancelled before the first look (${p.looks[0]} paired cases)`);
  else if (s.reason === "crossed") {
    out.push(`stopped ${s.early ? "early, " : ""}look ${s.history.length} of ${K} at ${s.stoppedAt} paired cases: B is ${s.verdict} ${paint(`(${z(last)})`, "dim", color)}`);
  } else if (s.reason === "budget") out.push(`stopped at the case budget (${p.maxCases}), no boundary crossed ${paint(`(${z(last)})`, "dim", color)}`);
  else out.push(`stopped cancelled after look ${s.history.length} of ${K} (${s.stoppedAt} paired cases) ${paint(`(${z(last)})`, "dim", color)}`);
  if (last) {
    out.push(
      `seq Δ   ${signedPct(s.diff.mean)} [${signedPct(s.diff.lo)}, ${signedPct(s.diff.hi)}] ` +
        paint(`(${last.n} paired cases, ${Math.round((1 - p.alpha) * 100)}% repeated CI: valid however the run stopped)`, "dim", color),
    );
  }
  return out;
}

/** `exp aa`: the noise one config shows against itself. */
export function renderAa(r: AaResult, opts: RenderOpts & { first?: ExperimentResult; second?: ExperimentResult }): string {
  const color = opts.color;
  const n = r.noise;
  const c = r.comparison;
  const out: string[] = [];
  out.push(`${paint("A/A", "bold", color)} ${c.a.name} ${paint(c.a.id, "dim", color)} vs ${c.b.name} ${paint(c.b.id, "dim", color)}`);
  out.push(`task    ${n.task.kind}: ${n.task.ref}  dataset ${n.datasetId}@${n.datasetVersion}`);
  for (const w of r.warnings) out.push(paint(`! ${w}`, "yellow", color));
  out.push("");
  out.push(`delta   ${signedPct(n.delta.mean)} [${signedPct(n.delta.lo)}, ${signedPct(n.delta.hi)}] ${paint(`(${n.paired} paired cases, 95% paired bootstrap)`, "dim", color)}`);
  out.push(`flips   ${n.flips} of ${n.paired} cases (${pct(n.flipRate)}): ${c.mcnemar.b} passed only in the first run, ${c.mcnemar.c} only in the second  mcnemar p=${pValue(n.mcnemarP)}`);
  out.push(`sd      ${fixed(n.sd)} ${paint("(per-case Δ between the two runs)", "dim", color)}`);
  const cases = (x: number) => (Number.isFinite(x) ? String(x) : "—");
  out.push(`plan    paired cases to detect 5pp: ${cases(r.plan.for5)}, 10pp: ${cases(r.plan.for10)} ${paint("(α 0.05, power 80%, at this noise)", "dim", color)}`);
  return out.join("\n");
}

/** `exp compare --pairwise`: B's win rate from a both-order pairwise judge. */
export function renderPairwise(s: PairwiseSummary, opts: RenderOpts): string {
  const color = opts.color;
  const out: string[] = [];
  const star = s.judge.calibration?.state === "calibrated" ? "" : paint("*", "yellow", color);
  out.push(`${paint("pairwise", "bold", color)} ${s.judge.id}${star} ${paint(`(both orders, ${s.n} case${s.n === 1 ? "" : "s"})`, "dim", color)}`);
  if (!s.n) {
    out.push(paint("no case was judged", "yellow", color));
  } else {
    out.push(`wins    B ${s.wins.b}, A ${s.wins.a}, ties ${s.ties}${s.inconsistent ? ` (${s.inconsistent} from order flips)` : ""}`);
    const vColor = s.verdict === "better" ? "green" : s.verdict === "worse" ? "red" : "dim";
    // Without clusters the sign-flip p is the sign test's p; with them it runs over cluster sums.
    const decisive = s.wins.a + s.wins.b;
    const flipUnits = s.cluster
      ? `${s.signFlip.units} ${s.cluster.key} cluster${s.signFlip.units === 1 ? "" : "s"}`
      : `${decisive} decisive case${decisive === 1 ? "" : "s"}`;
    out.push(
      `B wins  ${paint(pct(s.winRate.b), vColor, color)} ${ci(s.winRate.lo, s.winRate.hi)} ` +
        paint(`(ties count half, 95% ${s.cluster ? `cluster bootstrap over ${s.cluster.clusters} ${s.cluster.key} clusters` : "paired bootstrap"})`, "dim", color) +
        `  sign test p=${pValue(s.signTest.p)}` +
        (s.cluster ? paint(`  sign-flip p=${pValue(s.signFlip.p)} over ${flipUnits}`, "dim", color) : ""),
    );
    const b = s.positionBias;
    out.push(
      `order   answer changed with the order on ${s.inconsistent} of ${s.n} (${pct(b.rate)})` +
        (b.first || b.second ? `: ${b.first} favored the first response, ${b.second} the second` : ""),
    );
    const why =
      s.winRate.lo > 0.5 || s.winRate.hi < 0.5 ? `the CI excludes 50%, but the exact test does not: p=${pValue(s.signFlip.p)} over ${flipUnits}` : "CI includes 50%";
    out.push(`verdict ${paint(s.verdict === "inconclusive" ? `inconclusive (${why})` : `B is ${s.verdict}`, vColor, color)}`);
    out.push(paint(stabilityLine(s.stability), "dim", color));
  }
  const skipped = s.skipped.noOutput;
  if (skipped) out.push(paint(`${skipped} shared case(s) not judged: no output on one side (task error)`, "dim", color));
  for (const w of s.warnings) out.push(paint(`! ${w}`, "yellow", color));
  return out.join("\n");
}

const CONCLUSION_COLOR = { "replicated-better": "green", "replicated-worse": "red", "judges-disagree": "red", unresolved: "yellow" } as const;

/** `exp compare` with two or more `--pairwise` judges: each judge's verdict, how far they agree, and the conclusion. */
export function renderReplication(r: PairwiseReplication, opts: RenderOpts): string {
  const color = opts.color;
  const out: string[] = [];
  out.push(`${paint("judges", "bold", color)}  ${r.judges.length} pairwise judges, ${r.providers.length} provider${r.providers.length === 1 ? "" : "s"}`);
  out.push(
    table(
      [{ header: "judge" }, { header: "provider/model" }, { header: "B wins", align: "right" }, { header: "95% CI" }, { header: "verdict" }, { header: "calibration" }],
      r.judges.map((j) => [
        j.id,
        `${j.provider}/${j.model}`,
        j.n ? pct(j.winRate.b) : "-",
        j.n ? ci(j.winRate.lo, j.winRate.hi) : "-",
        r.screened.includes(j.id) ? paint(`${j.verdict} (screened out)`, "dim", color) : paint(j.verdict, j.verdict === "better" ? "green" : j.verdict === "worse" ? "red" : "dim", color),
        j.calibration ?? "none",
      ]),
      { color },
    ),
  );
  for (const a of r.agreement) {
    const k = Number.isFinite(a.kappa) ? a.kappa.toFixed(2) : "undefined";
    out.push(`agree   ${a.a} vs ${a.b}: κ ${k}, ${a.n ? pct(a.percentAgreement) : "-"} same winner ${paint(`(${a.n} shared case${a.n === 1 ? "" : "s"})`, "dim", color)}`);
  }
  out.push(`judges  ${paint(r.conclusion, CONCLUSION_COLOR[r.conclusion], color)}`);
  for (const w of r.warnings) out.push(paint(`! ${w}`, "yellow", color));
  return out.join("\n");
}

/** `exp run --seq K`: the Seq@1..K curve, where the gain lands, unchanged revisions, and the pass@k vs seq@k front. */
function renderSeq(q: SeqSummary, color: boolean): string[] {
  const out = [`${paint("sequential feedback", "bold", color)} (K ${q.k}, feedback ${q.feedback}, history ${q.history}) ${paint("pass above is Seq@1, the first attempt", "dim", color)}`];
  out.push(`seq@k   ${q.curve.map((p) => `${p.k}: ${pct(p.rate)} ${paint(ci(p.lo, p.hi), "dim", color)}`).join("  ")}`);
  if (q.egs !== undefined) {
    out.push(`gain    EGS ${q.egs.toFixed(2)}${q.lgs !== undefined ? `, LGS ${q.lgs.toFixed(2)}` : ""} ${paint(`(share of the Seq@1 → Seq@${q.k} gain made at attempt 2${q.lgs !== undefined ? `, and at attempt ${q.k}` : ""})`, "dim", color)}`);
  } else out.push(paint("gain    none: feedback solved nothing the first attempt missed", "dim", color));
  if (q.unchangedRate !== undefined) out.push(`unchanged ${pct(q.unchangedRate)} of revisions repeated the previous output`);
  if (q.costToSolve !== undefined) out.push(`cost    $${q.costToSolve.toFixed(4)} per solved trial (task and critic, every attempt)`);
  if (q.passAtK?.length) out.push(`pass@k  ${q.passAtK.map((p) => `${p.k}: ${pct(p.rate)}`).join("  ")} ${paint("(independent first attempts, unbiased estimator)", "dim", color)}`);
  if (q.front?.length) {
    const cost = (x: number) => (q.costUnit === "usd" ? `$${x.toFixed(4)}` : `${fixed(x)} attempts`);
    out.push(`front   ${q.front.map((p) => `${p.protocol.replace("@k", `@${p.k}`)} ${pct(p.success)} at ${cost(p.cost)}${p.overall ? "" : paint(" (beaten)", "dim", color)}`).join(" · ")}`);
  }
  return out;
}

/** `exp sweep`: the race, the winner's held-out score and the optimism gap. */
export function renderSweep(r: SweepResult, opts: RenderOpts): string {
  const color = opts.color;
  const out: string[] = [];
  const sp = r.splits;
  out.push(
    `${paint("sweep", "bold", color)} ${r.name}  ${r.configs.length} configs, sequential halving, budget ${r.budget} (used ${r.used}) ` +
      paint(`seed ${r.seed}`, "dim", color),
  );
  out.push(
    `splits  race on ${sp.select} (${sp.selectCases} cases), held out ${sp.heldOut} (${sp.heldOutCases} cases)` +
      (sp.source === "random" ? paint(" (random split: the dataset has no splits)", "dim", color) : ""),
  );
  out.push("");
  out.push(
    table(
      [{ header: "round" }, { header: "config" }, { header: "cases", align: "right" }, { header: "pass", align: "right" }, { header: "result" }],
      r.rounds.flatMap((rd) =>
        rd.configs.map((c, i) => [
          i === 0 ? String(rd.round) : "",
          c.config,
          String(c.n),
          pct(c.passRate),
          c.kept
            ? "kept"
            : paint(`dropped, ${signedPct(c.vsLeader?.mean ?? NaN)} [${signedPct(c.vsLeader?.lo ?? NaN)}, ${signedPct(c.vsLeader?.hi ?? NaN)}] vs leader`, "dim", color),
        ]),
      ),
      { color },
    ),
  );
  if (r.bestSet) out.push(formatBestSet(r.bestSet) + paint(`  (on the ${sp.select} cases every config ran; paired-bootstrap MCB)`, "dim", color));
  for (const n of r.notes) out.push(paint(`! ${n}`, "yellow", color));
  if (r.status === "cancelled") {
    out.push(paint("cancelled: no winner was re-scored on the held-out split", "yellow", color));
    return out.join("\n");
  }
  const w = r.winner;
  if (!w) return out.join("\n");
  out.push("");
  out.push(`winner  ${paint(w.name, "bold", color)}  ${sp.select} ${pct(w.train.passRate)} (${w.train.n} cases)  held-out ${pct(w.heldOut.p)} ${ci(w.heldOut.lo, w.heldOut.hi)} (${w.heldOut.n} cases)`);
  const gColor = w.optimismGap > 0.05 ? "yellow" : "dim";
  out.push(`gap     ${paint(signedPct(w.optimismGap), gColor, color)} ${paint(`optimism (${sp.select} − held-out): how much the race overstates the winner`, "dim", color)}`);
  if (r.start && r.start.name !== w.name) {
    out.push(`start   ${r.start.name}  held-out ${pct(r.start.heldOut.p)} ${ci(r.start.heldOut.lo, r.start.heldOut.hi)}`);
  } else out.push(paint("start   the start config won; nothing to compare it against", "dim", color));
  if (r.comparison) {
    const c = r.comparison;
    const vColor = c.verdict === "better" ? "green" : c.verdict === "worse" ? "red" : "dim";
    out.push(
      `held-out B − A ${paint(signedPct(c.diff.mean), vColor, color)} [${signedPct(c.diff.lo)}, ${signedPct(c.diff.hi)}] ` +
        paint(`(winner vs start, ${c.paired} paired cases)`, "dim", color) +
        `  verdict ${paint(c.verdict === "inconclusive" ? "inconclusive" : `winner is ${c.verdict}`, vColor, color)}`,
    );
  }
  const g = r.adopt;
  if (g && r.start) {
    const cases = (n: number) => `${n} case${n === 1 ? "" : "s"}`;
    const line = r.blockedBy?.length
      ? `keep    ${paint(r.start.name, "bold", color)}: ${w.name} forgets ${r.blockedBy.join(", ")} (guard)`
      : g.verdict === "ship"
        ? `adopt   ${paint(w.name, "green", color)}: wins ${cases(g.wins)}, loses ${g.losses} on held-out`
        : g.verdict === "dont-ship"
          ? `keep    ${paint(r.start.name, "bold", color)}: ${w.name} breaks ${cases(g.losses)} ${r.start.name} solved`
          : `keep    ${paint(r.start.name, "bold", color)}: not enough evidence that ${w.name} is better (wins ${g.wins}, loses ${g.losses}; needs ${g.minCleanWins}+ wins with no losses)`;
    out.push(line, `        ${paint(gateDetail(g), "dim", color)}`);
    if (g.lostCases.length) out.push(`        lost: ${idList(g.lostCases)}`);
  }
  if (r.guards?.length) {
    out.push("");
    out.push(paint("guards", "bold", color) + paint(" (start vs winner on earlier suites; a dont-ship gate blocks adoption)", "dim", color));
    out.push(
      table(
        [{ header: "suite" }, { header: "start", align: "right" }, { header: "winner", align: "right" }, { header: "Δforget", align: "right" }, { header: "ρforget", align: "right" }, { header: "gate" }],
        r.guards.map((x) => [
          `${x.name}@${x.version}`,
          pct(x.start.p),
          pct(x.winner.p),
          signedPct(x.deltaForget),
          pct(x.rhoForget),
          x.blocks ? paint(`BLOCKS: ${gateHeadline(x.gate, "case")}`, "red", color) : paint(gateHeadline(x.gate, "case"), GATE_COLOR[x.gate.verdict], color),
        ]),
        { color },
      ),
    );
  } else if (r.guards && r.winner && r.start?.name === r.winner.name) out.push(paint("guards  not run: the start config won", "dim", color));
  return out.join("\n");
}

const NO_CI = { mean: NaN, lo: NaN, hi: NaN };
const signedCi = (d: { mean: number; lo: number; hi: number }) => `${signedPct(d.mean)} [${signedPct(d.lo)}, ${signedPct(d.hi)}]`;
const flipList = (ids: readonly string[] | undefined, count: number | undefined) =>
  !count ? "—" : `${count}${ids?.length ? `: ${ids.join(", ")}${count > ids.length ? ", …" : ""}` : ""}`;

/** The delta block `exp run` prints in a session: this run against the previous one on the dataset. */
export function renderSessionDelta(b: ExperimentBlock, opts: RenderOpts & { session?: string }): string[] {
  const color = opts.color;
  const d = b.delta;
  const head = opts.session ? `session ${opts.session}` : "previous run";
  if (!d) return [paint(`${head}: first run on ${b.dataset.id}`, "dim", color)];
  if (!d.paired) return [`${head}: vs ${d.vs} not paired ${paint(`(${d.reason ?? "different runs"})`, "dim", color)}`];
  const vColor = d.verdict === "better" ? "green" : d.verdict === "worse" ? "red" : "dim";
  const out = [`${head}: vs ${d.vs}${b.changed?.length ? paint(`  changed ${b.changed.join(", ")}`, "dim", color) : ""}`];
  out.push(
    `pass    ${pct(d.before ?? NaN)} → ${pct(d.after ?? NaN)}  Δ ${paint(signedCi(d.diff ?? NO_CI), vColor, color)}  mcnemar p=${pValue(d.p ?? NaN)} ` +
      paint(`(${d.pairedCases ?? 0} paired cases, 95% CI)`, "dim", color),
  );
  for (const g of d.graders ?? []) {
    // A grader's change is coloured only when its CI excludes 0.
    const gColor = g.diff.lo > 0 ? "green" : g.diff.hi < 0 ? "red" : undefined;
    const text = signedCi(g.diff);
    out.push(`grader  ${g.id}  score Δ ${gColor ? paint(text, gColor, color) : text}`);
  }
  out.push(`fixed   ${flipList(d.fixed, d.fixedCount)}`);
  out.push(`broke   ${flipList(d.broke, d.brokeCount)}`);
  return out;
}

/** `exp session summary`: one line per experiment, note and command, oldest first. */
export function renderSessionSummary(s: Pick<ExpSession, "id" | "name">, blocks: readonly SessionBlock[], opts: RenderOpts): string {
  const color = opts.color;
  const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  const out = [`${paint("session", "bold", color)} ${s.name ? `${s.name} ` : ""}${paint(s.id, "dim", color)}`];
  if (!blocks.length) out.push(paint("no runs or notes yet; coding.sh exp run <spec> in this folder joins it", "dim", color));
  let exps = 0;
  for (const b of blocks) {
    if (b.kind === "note") out.push(`${when(b.at)}  ${paint("note", "cyan", color)}  ${truncate(b.text, 160)}`);
    else if (b.kind === "command") out.push(paint(`${when(b.at)}  $ ${truncate(b.command, 160)}`, "dim", color));
    else {
      exps++;
      const d = b.delta;
      const delta = !d ? "" : !d.paired ? `  not paired vs ${d.vs}` : `  Δ ${signedCi(d.diff ?? NO_CI)} p=${pValue(d.p ?? NaN)} fixed ${d.fixedCount ?? 0} broke ${d.brokeCount ?? 0}`;
      const changed = b.changed?.length ? paint(`  changed ${b.changed.join(", ")}`, "dim", color) : "";
      out.push(`${when(b.at)}  ${b.expId}  ${b.mode.padEnd(7)}  ${b.dataset.id}  ${pct(b.passRate.p)} (${b.passed}/${b.n - b.ungraded})${delta}${changed}`);
    }
  }
  if (exps) out.push(paint(`${exps} experiment${exps === 1 ? "" : "s"}`, "dim", color));
  return out.join("\n");
}

/** `exp run` over a matrix spec: one row per cell against the baseline cell, with Holm-adjusted p-values. */
export function renderMatrixRun(r: MatrixResult, opts: RenderOpts): string {
  const color = opts.color;
  const out: string[] = [];
  const names = Object.keys(r.experiments);
  const base = r.experiments[r.plan.baseline]!;
  const comps = Object.values(r.comparisons);
  const vColor = (v: string) => (v === "better" ? "green" : v === "worse" ? "red" : "dim");
  const reusedTotal = Object.values(r.reused ?? {}).reduce((s, n) => s + n, 0);
  out.push(
    `${paint("matrix", "bold", color)} ${paint(r.id, "dim", color)}  ${paint(`${names.length} cells, interleaved (seed ${r.seed})${reusedTotal ? `, ${reusedTotal} case-trials reused` : ""}; baseline ${r.plan.baseline}`, "dim", color)}`,
  );
  out.push("");
  out.push(
    table(
      [
        { header: "cell" },
        { header: "pass", align: "right" },
        { header: "B − A", align: "right" },
        { header: "95% CI" },
        { header: "p", align: "right" },
        { header: "p (Holm)", align: "right" },
        { header: "regressed", align: "right" },
        { header: "improved", align: "right" },
        { header: "verdict" },
      ],
      names.map((n) => {
        const pass = pct(r.experiments[n]!.summary.passRate.p);
        const c = r.comparisons[n];
        if (!c) return [n, pass, paint("baseline", "dim", color), "", "", "", "", "", ""];
        return [
          n,
          pass,
          paint(signedPct(c.diff.mean), vColor(c.verdict), color),
          `[${signedPct(c.diff.lo)}, ${signedPct(c.diff.hi)}]`,
          pValue(c.mcnemar.p),
          pValue(c.pHolm),
          String(c.mcnemar.b),
          String(c.mcnemar.c),
          paint(c.holmVerdict, vColor(c.holmVerdict), color),
        ];
      }),
      { color },
    ),
  );
  out.push(
    paint(
      `p: exact McNemar on flipped cases, Holm-adjusted over ${comps.length} comparison${comps.length === 1 ? "" : "s"} with the baseline; verdict at Holm p < 0.05; CI: paired bootstrap, unadjusted`,
      "dim",
      color,
    ),
  );
  if (r.bestSet) out.push(formatBestSet(r.bestSet) + paint("  (configs not significantly worse than the best, paired-bootstrap MCB)", "dim", color));
  for (const n of names) {
    const c = r.comparisons[n];
    if (!c) continue;
    for (const w of [c.gradeWarning, c.attrition.warning, c.datasetWarning]) if (w) out.push(paint(`! ${n}: ${w}`, "yellow", color));
  }
  const copied = names.filter((n) => r.reused?.[n]);
  if (copied.length) {
    const which = copied.map((n) => `${n} ${r.reused![n]}/${r.experiments[n]!.runs.length}`).join(", ");
    out.push(paint(`! reused case-trials from earlier experiments (${which}): they did not run interleaved with the new ones, so drift since then is not balanced across the cells`, "yellow", color));
  }
  out.push("");
  const w = Math.max(...names.map((n) => n.length));
  for (const n of names) out.push(`${n.padEnd(w)}  ${r.experiments[n]!.id}`);
  const first = names.find((n) => n !== r.plan.baseline);
  if (first) out.push(paint(`per-case diff of a cell: coding.sh exp compare ${base.id} ${r.experiments[first]!.id}`, "dim", color));
  return out.join("\n");
}
