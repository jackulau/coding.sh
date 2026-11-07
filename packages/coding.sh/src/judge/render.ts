// Plain-text calibration report.
import type { CalibrationStatus } from "../datasets/types.ts";
import { fixed, paint, pct, table, truncate, type RenderOpts } from "../experiments/text.ts";
import type { CalibrationReport, JudgeEfficiency, SplitMetrics } from "./calibrate.ts";
import { formatInjection } from "./injection.ts";

/** Short badge for a judge's trust state, e.g. "calibrated κ=0.74" or "UNCALIBRATED". */
export function calibrationBadge(c: CalibrationStatus | undefined, color: boolean): string {
  if (!c) return "";
  const k = c.kappa !== undefined ? ` κ=${c.kappa.toFixed(2)}` : "";
  switch (c.state) {
    case "calibrated":
      return paint(`calibrated${k}`, "green", color);
    case "in-sample":
      return paint(`IN-SAMPLE${k}`, "yellow", color);
    case "insufficient-data":
      return paint(`UNCALIBRATED (insufficient data${c.n !== undefined ? `, n=${c.n}` : ""})`, "yellow", color);
    default:
      return paint(`UNCALIBRATED${k}`, "red", color);
  }
}

function confusionTable(m: SplitMetrics, color: boolean): string {
  const c = m.confusion;
  return table(
    [{ header: "" }, { header: "judge fail", align: "right" }, { header: "judge pass", align: "right" }],
    [
      ["human fail", String(c.tp), String(c.fn)],
      ["human pass", String(c.fp), String(c.tn)],
    ],
    { color },
  );
}

function metricLines(m: SplitMetrics): string[] {
  const ci = Number.isFinite(m.kappaCI.lo) ? ` [${fixed(m.kappaCI.lo)}, ${fixed(m.kappaCI.hi)}]` : "";
  return [
    `cases          ${m.n}`,
    `agreement      ${pct(m.agreement)}`,
    `cohen κ        ${fixed(m.kappa)}${ci}${m.kappaCI.degenerate ? ` (${m.kappaCI.degenerate}/${m.kappaCI.iters} resamples degenerate)` : ""}`,
    `fail precision ${pct(m.failPrecision)}  (of cases the judge failed, humans also failed)`,
    `fail recall    ${pct(m.failRecall)}  (of cases humans failed, the judge caught)`,
    `fail rate      human ${pct(m.humanFailRate)}, judge ${pct(m.judgeFailRate)}`,
  ];
}

const usd = (x: number) => `$${x >= 1 ? x.toFixed(2) : String(Number(x.toPrecision(2)))}`;

/** Discrimination gap, label efficiency η and the cost break-even (arXiv 2610.35698, Eq.6-8). */
function efficiencyLines(e: JudgeEfficiency, split: string, color: boolean): string[] {
  const out = [`discrimination gap ${fixed(e.gap)} (pass-recall ${fixed(e.sensitivity)}, false-pass ${fixed(e.alpha)})`];
  if (e.eta !== undefined) {
    const at = e.thetaFrom === "corrected-judge" ? `at pass rate ${fixed(e.theta)}, corrected over ${e.judged} judged ${split} cases` : `at the human pass share ${fixed(e.theta)}`;
    const what =
      e.eta < 1
        ? `auditing outputs directly needs ~${(1 / e.eta).toFixed(1)}x fewer human labels for the same precision`
        : `calibrating this judge needs ~${(1 / e.eta).toFixed(2)}x the labels a direct audit would`;
    out.push(`label efficiency η ${fixed(e.eta)} · ${paint(what, e.eta < 1 ? "yellow" : "green", color)} ${paint(`(${at})`, "dim", color)}`);
  }
  if (e.judgeCost !== undefined) {
    out.push(
      e.breakEvenHumanCost === null || e.breakEvenHumanCost === undefined
        ? paint("no break-even: the judge never saves labels at this accuracy", "yellow", color)
        : `judge pays off when a human label costs more than ${usd(e.breakEvenHumanCost)} ${paint(`(judge call ${usd(e.judgeCost)})`, "dim", color)}`,
    );
  }
  return out;
}

export function renderCalibration(r: CalibrationReport, opts: RenderOpts): string {
  const color = opts.color;
  const limit = opts.limit ?? 20;
  const out: string[] = [];
  out.push(`${paint("judge", "bold", color)} ${r.judgeId}${r.criterion ? `  criterion ${r.criterion}` : ""}`);
  out.push(`status  ${calibrationBadge(r.status, color)}  (threshold κ ≥ ${r.threshold}, n ≥ ${r.minN})`);
  out.push(`split   ${r.reportSplit}${r.heldOut ? " (held out)" : paint(" (IN-SAMPLE: used for tuning)", "yellow", color)}; tuned on ${r.tunedOn.join(", ") || "nothing"}`);
  for (const reason of r.reasons) out.push(paint(`  ! ${reason}`, r.state === "calibrated" ? "dim" : "yellow", color));
  out.push("");
  out.push(...metricLines(r));
  if (r.efficiency) out.push(...efficiencyLines(r.efficiency, r.reportSplit, color));
  out.push("");
  out.push(confusionTable(r, color));
  if (r.inSample) {
    out.push("");
    out.push(paint(`in-sample (${r.inSample.splits.join(", ")}; diagnostic only): n=${r.inSample.n}, agreement ${pct(r.inSample.agreement)}, κ ${fixed(r.inSample.kappa)}`, "dim", color));
  }
  const ex = r.excluded;
  const exParts = [
    ex.tied ? `${ex.tied} tied human vote(s)` : "",
    ex.noVerdict ? `${ex.noVerdict} labelled but unjudged` : "",
    ex.noLabel ? `${ex.noLabel} judged but unlabelled` : "",
    ex.noSplit ? `${ex.noSplit} without a split` : "",
  ].filter(Boolean);
  if (exParts.length) out.push(paint(`excluded: ${exParts.join(", ")}`, "dim", color));
  if (r.injection) {
    out.push("");
    out.push(paint(formatInjection(r.injection), r.injection.flips ? "red" : "dim", color));
    if (r.injection.flips) out.push(paint("  ! the judge follows instructions planted in the judged output: harden its prompt before trusting its verdicts", "red", color));
  }
  if (r.noisy.length) {
    out.push("");
    out.push(`${paint("relabel", "bold", color)} ${r.noisy.length} case(s) with noisy labels`);
    out.push(
      table(
        [{ header: "case" }, { header: "split" }, { header: "issue" }, { header: "detail" }],
        r.noisy.slice(0, limit).map((n) => [n.caseId, n.split ?? "—", n.kind, truncate(n.detail, 80)]),
        { color },
      ),
    );
    if (r.noisy.length > limit) out.push(paint(`… ${r.noisy.length - limit} more (use --json for all)`, "dim", color));
  }
  return out.join("\n");
}
