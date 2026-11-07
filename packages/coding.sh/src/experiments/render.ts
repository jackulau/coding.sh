// Plain-text experiment and comparison reports (stdout = the answer). Scores
// from judges that are not calibrated on held-out human labels are marked
// with "*" wherever they appear, including the overall pass rate they feed.
import type { CalibrationStatus, ExperimentResult } from "../datasets/types.ts";
import { calibrationBadge } from "../judge/render.ts";
import type { RoganGladenResult } from "../stats/interval.ts";
import type { SequentialOutcome } from "../stats/sequential.ts";
import type { AaResult } from "./aa.ts";
import type { ArmAttrition, Comparison } from "./compare.ts";
import { fixed, ms, paint, pct, pValue, signedPct, table, truncate, type RenderOpts } from "./text.ts";

const trusted = (c: CalibrationStatus | undefined) => c === undefined || c.state === "calibrated";

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

export function renderExperiment(r: ExperimentResult, opts: RenderOpts): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const s = r.summary;
  const anyUntrusted = r.graders.some((g) => !trusted(g.calibration));
  const star = (t: boolean) => (t ? "" : paint("*", "yellow", color));
  const out: string[] = [];
  out.push(`${paint(r.name, "bold", color)}  ${paint(r.id, "dim", color)}`);
  out.push(`dataset ${r.dataset.name}@${r.dataset.version}${r.dataset.split ? ` (${r.dataset.split})` : ""}  task ${r.task.kind}: ${r.task.ref}  trials ${r.trials}`);
  if (r.status === "cancelled" && s.n === 0) {
    out.push(paint("cancelled before any case run finished: nothing was graded", "yellow", color));
    return out.join("\n");
  }
  const rateColor = s.passRate.p >= 0.8 ? "green" : s.passRate.p >= 0.5 ? "yellow" : "red";
  out.push(
    `pass    ${paint(pct(s.passRate.p), rateColor, color)}${star(!anyUntrusted)} ${ci(s.passRate.lo, s.passRate.hi)} ` +
      `${paint(`(${s.passed}/${s.n - (s.ungraded ?? 0)}${r.trials > 1 ? ` over ${s.cases} cases` : ""}, 95% ${s.ciMethod === "wilson" ? "Wilson" : "cluster bootstrap"})`, "dim", color)}`,
  );
  if (r.status === "cancelled") out.push(paint(`cancelled: only ${s.n} case run${s.n === 1 ? "" : "s"} finished before the interrupt; this result is partial`, "yellow", color));
  if (s.errors) out.push(paint(`errors  ${s.errors} task error(s)`, "red", color));
  if (s.ungraded) out.push(paint(`ungraded ${s.ungraded} run(s) with a grader error: outcome unknown, left out of the pass rate`, "yellow", color));
  out.push(`latency median ${ms(s.latencyMs.median)}, p90 ${ms(s.latencyMs.p90)}, max ${ms(s.latencyMs.max)}`);
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
          return [
            g.id,
            g.kind,
            pct(g.passRate.p) + star(t),
            ci(g.passRate.lo, g.passRate.hi),
            fixed(g.meanScore) + star(t),
            String(g.errors),
            g.calibration ? calibrationBadge(g.calibration, color) : paint("deterministic", "dim", color),
          ];
        }),
        { color },
      ),
    );
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
    out.push(
      table(
        [{ header: "case" }, ...(r.trials > 1 ? [{ header: "trial", align: "right" as const }] : []), { header: "reason" }],
        rows.slice(0, limit).map((x) => [x.caseId, ...(r.trials > 1 ? [String(x.trial)] : []), truncate(failureReason(x), 100)]),
        { color },
      ),
    );
    if (rows.length > limit) out.push(paint(`… ${rows.length - limit} more (use --json for all)`, "dim", color));
  }
  return out.join("\n");
}

export function renderComparison(c: Comparison, opts: RenderOpts & { a?: ExperimentResult; b?: ExperimentResult }): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const out: string[] = [];
  // A forced compare of a cancelled experiment keeps saying it is partial.
  const partial = (e?: ExperimentResult) => (e?.status === "cancelled" ? `  ${paint(`cancelled: ${e.runs.length} case run${e.runs.length === 1 ? "" : "s"} only`, "yellow", color)}` : "");
  out.push(`${paint("A", "bold", color)} ${c.a.name} ${paint(c.a.id, "dim", color)}  pass ${pct(c.a.passRate)}${partial(opts.a)}`);
  out.push(`${paint("B", "bold", color)} ${c.b.name} ${paint(c.b.id, "dim", color)}  pass ${pct(c.b.passRate)}${partial(opts.b)}`);
  if (c.datasetWarning) out.push(paint(`! ${c.datasetWarning}`, "yellow", color));
  if (c.gradeWarning) out.push(paint(`! ${c.gradeWarning}`, "yellow", color));
  if (c.timing.warning) out.push(paint(`! ${c.timing.warning}`, "yellow", color));
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
  out.push(`mcnemar p=${pValue(c.mcnemar.p)}  ${c.mcnemar.b} regressed, ${c.mcnemar.c} improved`);
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
  if (c.sequential) out.push(...renderSequential(c.sequential, color));
  if (c.sequentialWarning) out.push(paint(`! ${c.sequentialWarning}`, "yellow", color));
  const why = c.sequential ? (c.verdict === "inconclusive" ? "no boundary crossed" : "group sequential test") : "CI includes 0";
  out.push(`verdict ${paint(c.verdict === "inconclusive" ? `inconclusive (${why})` : `B is ${c.verdict}${c.sequential ? ` (${why})` : ""}`, vColor, color)}`);
  const p = c.power;
  out.push(
    `power   MDE ${Number.isFinite(p.mde) ? `${(p.mde * 100).toFixed(1)}pp` : "—"} ` +
      paint(`(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? fixed(p.sd) : "—"})`, "dim", color),
  );
  if (p.noise) {
    out.push(
      `noise   A/A flip rate on this dataset ${pct(p.noise.flipRate)} ` +
        paint(`(sd ${fixed(p.noise.sd)} over ${p.noise.paired} cases${p.noise.used ? "; the MDE uses it as a floor" : ""})`, "dim", color),
    );
  }
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
  if (c.graders.length) {
    out.push("");
    out.push(
      table(
        [{ header: "grader" }, { header: "A", align: "right" }, { header: "B", align: "right" }, { header: "B − A", align: "right" }, { header: "95% CI" }],
        c.graders.map((g) => {
          const s = untrusted.has(g.id) ? paint("*", "yellow", color) : "";
          return [g.id + s, fixed(g.meanA), fixed(g.meanB), (g.diff.mean >= 0 ? "+" : "") + fixed(g.diff.mean), `[${fixed(g.diff.lo)}, ${fixed(g.diff.hi)}]`];
        }),
        { color },
      ),
    );
    if (untrusted.size) out.push(paint("* uncalibrated judge: score differences are not validated against human labels", "yellow", color));
    const side = (r: RoganGladenResult | undefined) =>
      r === undefined ? "—" : r.corrected ? `${pct(r.p)} ${ci(r.lo, r.hi)}` : "refused (sensitivity + specificity ≤ 1)";
    for (const g of c.graders) {
      if (!g.corrected) continue;
      out.push(`${g.id} bias-corrected pass  A ${side(g.corrected.a)}  B ${side(g.corrected.b)} ${paint("(Rogan–Gladen, 95%)", "dim", color)}`);
    }
  }
  const list = (title: string, rows: Comparison["regressions"], style: "red" | "green") => {
    if (!rows.length) return;
    out.push("");
    out.push(`${paint(title, "bold", color)} ${rows.length}`);
    out.push(
      table(
        [{ header: "case" }, { header: "A", align: "right" }, { header: "B", align: "right" }, { header: "Δ", align: "right" }],
        rows.slice(0, limit).map((x) => [x.caseId, pct(x.a, 0), pct(x.b, 0), paint(signedPct(x.delta, 0), style, color)]),
        { color },
      ),
    );
    if (rows.length > limit) out.push(paint(`… ${rows.length - limit} more (use --json for all)`, "dim", color));
  };
  list("regressions", c.regressions, "red");
  list("improvements", c.improvements, "green");
  return out.join("\n");
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
