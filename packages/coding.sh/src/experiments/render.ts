// Plain-text experiment and comparison reports (stdout = the answer). Scores
// from judges that are not calibrated on held-out human labels are marked
// with "*" wherever they appear, including the overall pass rate they feed.
import type { CalibrationStatus, ExperimentResult } from "../datasets/types.ts";
import { calibrationBadge } from "../judge/render.ts";
import { formatVerifierAudit, verifierCorrected, type VerifierAudit, type VerifierCorrection } from "../judge/verifier.ts";
import type { RoganGladenResult } from "../stats/interval.ts";
import type { SequentialOutcome } from "../stats/sequential.ts";
import type { AaResult } from "./aa.ts";
import { gateDetail, gateHeadline, idList } from "../stats/gate.ts";
import type { ArmAttrition, Comparison, ComparisonGate, ComparisonTurnover } from "./compare.ts";
import type { PairwiseSummary } from "./pairwise.ts";
import type { SweepResult } from "./sweep.ts";
import type { Turnover } from "./turnover.ts";
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

export function renderExperiment(r: ExperimentResult, opts: RenderOpts & { verifiers?: ReadonlyMap<string, VerifierAudit> }): string {
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
  out.push(
    `pass    ${paint(pct(s.passRate.p), rateColor, color)}${star(!anyUntrusted)} ${ci(s.passRate.lo, s.passRate.hi)} ` +
      `${paint(`(${s.passed}/${s.n - (s.ungraded ?? 0)}${r.trials > 1 ? ` over ${s.cases} cases` : ""}, 95% ${s.ciMethod === "wilson" ? "Wilson" : "cluster bootstrap"})`, "dim", color)}`,
  );
  if (r.status === "cancelled") out.push(paint(`cancelled: only ${s.n} case run${s.n === 1 ? "" : "s"} finished before the interrupt; this result is partial`, "yellow", color));
  if (s.errors) out.push(paint(`errors  ${s.errors} task error(s)`, "red", color));
  const graderErrors = (s.ungraded ?? 0) - (s.infra ?? 0);
  if (graderErrors > 0) out.push(paint(`ungraded ${graderErrors} run(s) with a grader error: outcome unknown, left out of the pass rate`, "yellow", color));
  if (s.infra) out.push(paint(`infra ${s.infra} run(s) still hit a rate limit, 5xx or network error after retries: outcome unknown, left out of the pass rate; --resume runs them again`, "yellow", color));
  const retried = r.runs.filter((x) => (x.attempts ?? 1) > 1);
  if (retried.length) out.push(paint(`retried ${retried.length} run(s) after infrastructure errors (${retried.reduce((n, x) => n + (x.attempts ?? 1) - 1, 0)} extra attempts); failures are never retried`, "dim", color));
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

export function renderComparison(c: Comparison, opts: RenderOpts & { a?: ExperimentResult; b?: ExperimentResult; matrix?: boolean }): string {
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
  // With one trial per case, coverage is the pass rate and gained/lost are McNemar's flips.
  const multi = c.passK !== undefined;
  if (multi && c.turnover.paired) out.push(...renderTurnover(c.turnover, color));
  if (c.sequential) out.push(...renderSequential(c.sequential, color));
  if (c.sequentialWarning) out.push(paint(`! ${c.sequentialWarning}`, "yellow", color));
  const why = c.sequential ? (c.verdict === "inconclusive" ? "no boundary crossed" : "group sequential test") : "CI includes 0";
  out.push(`verdict ${paint(c.verdict === "inconclusive" ? `inconclusive (${why})` : `B is ${c.verdict}${c.sequential ? ` (${why})` : ""}`, vColor, color)}`);
  if (c.gate) out.push(...renderGate(c.gate, color));
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
    out.push(
      table(
        [{ header: "case" }, { header: "A", align: "right" }, { header: "B", align: "right" }, { header: "Δ", align: "right" }],
        rows.slice(0, limit).map((x) => [x.caseId, pct(x.a, 0), pct(x.b, 0), paint(signedPct(x.delta, 0), style, color)]),
        { color },
      ),
    );
    if (rows.length > limit) out.push(paint(`… ${rows.length - limit} more (use --json for all)`, "dim", color));
  };
  if (opts.matrix && c.turnover.matrix) out.push("", ...renderMatrix(c.turnover, color));
  if (multi && c.turnover.lost.length) {
    const lost = new Set(c.turnover.lost);
    list("lost coverage", c.regressions.filter((x) => lost.has(x.caseId)), "red");
  }
  list("regressions", c.regressions, "red");
  list("improvements", c.improvements, "green");
  return out.join("\n");
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
  const out = [`gate    ${paint(gateHeadline(g, "case"), GATE_COLOR[g.verdict], color)}`, `        ${paint(gateDetail(g), "dim", color)}`];
  if (g.lostCases.length) out.push(`        lost: ${idList(g.lostCases)}`);
  if (g.note) out.push(paint(`! ${g.note}`, "yellow", color));
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
    out.push(
      `B wins  ${paint(pct(s.winRate.b), vColor, color)} ${ci(s.winRate.lo, s.winRate.hi)} ` +
        paint(`(ties count half, 95% ${s.cluster ? `cluster bootstrap over ${s.cluster.clusters} ${s.cluster.key} clusters` : "paired bootstrap"})`, "dim", color) +
        `  sign test p=${pValue(s.signTest.p)}`,
    );
    const b = s.positionBias;
    out.push(
      `order   answer changed with the order on ${s.inconsistent} of ${s.n} (${pct(b.rate)})` +
        (b.first || b.second ? `: ${b.first} favored the first response, ${b.second} the second` : ""),
    );
    out.push(`verdict ${paint(s.verdict === "inconclusive" ? "inconclusive (CI includes 50%)" : `B is ${s.verdict}`, vColor, color)}`);
  }
  const skipped = s.skipped.noOutput;
  if (skipped) out.push(paint(`${skipped} shared case(s) not judged: no output on one side (task error)`, "dim", color));
  for (const w of s.warnings) out.push(paint(`! ${w}`, "yellow", color));
  return out.join("\n");
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
    const line =
      g.verdict === "ship"
        ? `adopt   ${paint(w.name, "green", color)}: wins ${cases(g.wins)}, loses ${g.losses} on held-out`
        : g.verdict === "dont-ship"
          ? `keep    ${paint(r.start.name, "bold", color)}: ${w.name} breaks ${cases(g.losses)} ${r.start.name} solved`
          : `keep    ${paint(r.start.name, "bold", color)}: not enough evidence that ${w.name} is better (wins ${g.wins}, loses ${g.losses}; needs ${g.minCleanWins}+ wins with no losses)`;
    out.push(line, `        ${paint(gateDetail(g), "dim", color)}`);
    if (g.lostCases.length) out.push(`        lost: ${idList(g.lostCases)}`);
  }
  return out.join("\n");
}
