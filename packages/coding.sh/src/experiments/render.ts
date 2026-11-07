// Plain-text experiment and comparison reports (stdout = the answer). Scores
// from judges that are not calibrated on held-out human labels are marked
// with "*" wherever they appear, including the overall pass rate they feed.
import type { CalibrationStatus, ExperimentResult } from "../datasets/types.ts";
import { calibrationBadge } from "../judge/render.ts";
import type { RoganGladenResult } from "../stats/interval.ts";
import type { Comparison } from "./compare.ts";
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
  const rateColor = s.passRate.p >= 0.8 ? "green" : s.passRate.p >= 0.5 ? "yellow" : "red";
  out.push(
    `pass    ${paint(pct(s.passRate.p), rateColor, color)}${star(!anyUntrusted)} ${ci(s.passRate.lo, s.passRate.hi)} ` +
      `${paint(`(${s.passed}/${s.n}${r.trials > 1 ? ` over ${s.cases} cases` : ""}, 95% ${s.ciMethod === "wilson" ? "Wilson" : "cluster bootstrap"})`, "dim", color)}`,
  );
  if (s.errors) out.push(paint(`errors  ${s.errors} task error(s)`, "red", color));
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
  const failed = r.runs.filter((x) => !x.pass);
  if (failed.length) {
    out.push("");
    out.push(`${paint("failures", "bold", color)} ${failed.length}`);
    out.push(
      table(
        [{ header: "case" }, ...(r.trials > 1 ? [{ header: "trial", align: "right" as const }] : []), { header: "reason" }],
        failed.slice(0, limit).map((x) => [x.caseId, ...(r.trials > 1 ? [String(x.trial)] : []), truncate(failureReason(x), 100)]),
        { color },
      ),
    );
    if (failed.length > limit) out.push(paint(`… ${failed.length - limit} more (use --json for all)`, "dim", color));
  }
  return out.join("\n");
}

export function renderComparison(c: Comparison, opts: RenderOpts & { a?: ExperimentResult; b?: ExperimentResult }): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const out: string[] = [];
  out.push(`${paint("A", "bold", color)} ${c.a.name} ${paint(c.a.id, "dim", color)}  pass ${pct(c.a.passRate)}`);
  out.push(`${paint("B", "bold", color)} ${c.b.name} ${paint(c.b.id, "dim", color)}  pass ${pct(c.b.passRate)}`);
  if (c.datasetWarning) out.push(paint(`! ${c.datasetWarning}`, "yellow", color));
  const vColor = c.verdict === "better" ? "green" : c.verdict === "worse" ? "red" : "dim";
  out.push("");
  out.push(
    `B − A   ${paint(signedPct(c.diff.mean), vColor, color)} [${signedPct(c.diff.lo)}, ${signedPct(c.diff.hi)}] ` +
      `${paint(`(${c.paired} paired cases, 95% paired bootstrap)`, "dim", color)}`,
  );
  out.push(`mcnemar p=${pValue(c.mcnemar.p)}  ${c.mcnemar.b} regressed, ${c.mcnemar.c} improved`);
  if (c.passK) {
    const { a, b } = c.passK;
    const same = a.k === b.k;
    out.push(
      `${same ? `pass^${a.k}`.padEnd(8) : "pass^k  "}A ${pct(a.rate)}${same ? "" : ` (k=${a.k})`}  B ${pct(b.rate)}${same ? "" : ` (k=${b.k})`}  ` +
        `${signedPct(c.passK.diff)} ${paint("(cases where every trial passed)", "dim", color)}`,
    );
  }
  out.push(`verdict ${paint(c.verdict === "inconclusive" ? "inconclusive (CI includes 0)" : `B is ${c.verdict}`, vColor, color)}`);
  const p = c.power;
  out.push(
    `power   MDE ${Number.isFinite(p.mde) ? `${(p.mde * 100).toFixed(1)}pp` : "—"} ` +
      paint(`(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? fixed(p.sd) : "—"})`, "dim", color),
  );
  for (const w of p.warnings) out.push(paint(`! ${w.message}`, "yellow", color));
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
