// Plain-text rendering of tool-eval results (stdout of the CLI without --json).
import { formatDuration } from "../runner/experiment.ts";
import type { CompressReport, ContinuousMetric, SurfaceReport, TapRecord, ToolArmSummary, ToolCompareReport, TrialResult } from "./types.ts";

export interface FormatOpts {
  color?: boolean;
  maxRows?: number;
}

function painter(color: boolean | undefined) {
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { good: (s: string) => paint("32", s), bad: (s: string) => paint("31", s), dim: (s: string) => paint("2", s), bold: (s: string) => paint("1", s) };
}

const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
const table = (rows: string[][], widths?: number[]) => {
  const w = widths ?? rows.reduce<number[]>((acc, r) => r.map((c, i) => Math.max(acc[i] ?? 0, vis(c) + 2)), []);
  return rows.map((r) => r.map((c, i) => pad(c, w[i] ?? 10)).join("").trimEnd());
};
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp` : "—");
const pval = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);
const kb = (n: number) => (n >= 10_240 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const signedRel = (r: number) => (Number.isFinite(r) ? `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%` : "");

const METRIC_LABEL: Record<ContinuousMetric, { label: string; unit: "count" | "usd" | "ms" | "rate" }> = {
  turns: { label: "turns", unit: "count" },
  tokens: { label: "tokens", unit: "count" },
  costUsd: { label: "cost", unit: "usd" },
  wallMs: { label: "wall time", unit: "ms" },
  invalidRate: { label: "invalid rate", unit: "rate" },
  helpLookups: { label: "help lookups", unit: "count" },
  llmP95Ms: { label: "llm.call p95", unit: "ms" },
  targetLatencyP95Ms: { label: "tool latency p95", unit: "ms" },
};

function fmt(v: number, unit: "count" | "usd" | "ms" | "rate"): string {
  if (!Number.isFinite(v)) return "—";
  if (unit === "usd") return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`;
  if (unit === "ms") return formatDuration(v);
  if (unit === "rate") return pct(v);
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1).replace(/\.0$/, "");
}

/** Task errors, then the trials lost to infrastructure (left out of the rates). */
function errorsCell(a: ToolArmSummary, p: ReturnType<typeof painter>): string {
  return `${a.errors ? p.bad(String(a.errors)) : "0"}${a.infra ? p.dim(` +${a.infra} infra`) : ""}`;
}

/** The line under an arm table when trials failed on infrastructure. */
function infraLine(arms: readonly ToolArmSummary[], p: ReturnType<typeof painter>): string {
  const n = arms.reduce((s, a) => s + (a.infra ?? 0), 0);
  return n ? `${p.dim(`infra: ${n} trial(s) failed on infrastructure (a refused login, a failed setup, rate limits) after their retries: outcome unknown, left out of the counts and rates`)}\n` : "";
}

export function formatArms(arms: readonly ToolArmSummary[], o: FormatOpts = {}): string {
  const p = painter(o.color);
  if (arms.some((a) => a.verdicts)) {
    // Adaptive sampling: per-task verdicts, no CI (the trial count depends on the outcomes).
    const rows = [["arm", "tasks passed", "trials", "tie-breaks", "errors"].map(p.dim)];
    for (const a of arms) {
      const v = a.verdicts ?? { passed: 0, failed: 0, tieBreaks: 0 };
      rows.push([a.arm, `${v.passed}/${v.passed + v.failed}`, String(a.trials), String(v.tieBreaks), errorsCell(a, p)]);
    }
    return `${table(rows).join("\n")}\n${p.dim("adaptive, no CI: 2 trials per task, a 3rd when they disagree; a task fails at half or more failing")}\n${infraLine(arms, p)}`;
  }
  const rows = [["arm", "passes", "success (95% CI)", "pass^k", "pass@k", "errors"].map(p.dim)];
  for (const a of arms) {
    rows.push([a.arm, `${a.passes}/${a.trials}`, `${pct(a.passRate.p)} [${pct(a.passRate.lo)}, ${pct(a.passRate.hi)}]`, String(a.passAllK), String(a.passAnyK), errorsCell(a, p)]);
  }
  return `${table(rows).join("\n")}\n${infraLine(arms, p)}`;
}

export function formatToolCompare(r: ToolCompareReport, o: FormatOpts = {}): string {
  const p = painter(o.color);
  const out: string[] = [p.bold("coding.sh toolevals compare")];
  out.push(`baseline   ${r.baseline.arm}`);
  out.push(`candidate  ${r.candidate.arm}`);
  out.push(p.dim(`comparing ${r.comparing} · ${r.pairedTasks} paired task(s) · k=${r.k} · ${r.baseline.trials} vs ${r.candidate.trials} trials`));
  out.push("");
  const rows: string[][] = [["", "baseline", "candidate", "delta (95% CI)"].map(p.dim)];
  const rate = (a: ToolArmSummary) => `${pct(a.passRate.p)} (${a.passes}/${a.trials})`;
  const color = (verdict: string, s: string) => (verdict === "better" ? p.good(s) : verdict === "worse" ? p.bad(s) : s);
  rows.push(["success", rate(r.baseline), rate(r.candidate), color(r.verdict.kind, `${pp(r.diff.mean)} [${pp(r.diff.lo)}, ${pp(r.diff.hi)}]`)]);
  rows.push(["", "", "", p.dim(`McNemar ${pval(r.mcnemar.p)} (${r.mcnemar.b}↓ ${r.mcnemar.c}↑)${r.permutation ? ` · p (perm) ${pval(r.permutation.p).replace(/^p /, "")}` : ""}`)]);
  for (const [k, m] of Object.entries(r.metrics) as [ContinuousMetric, NonNullable<ToolCompareReport["metrics"][ContinuousMetric]>][]) {
    const { label, unit } = METRIC_LABEL[k];
    const d = unit === "rate" ? pp(m.diff.mean) : `${m.diff.mean >= 0 ? "+" : ""}${fmt(m.diff.mean, unit)}`;
    const ci = unit === "rate" ? `[${pp(m.diff.lo)}, ${pp(m.diff.hi)}]` : `[${fmt(m.diff.lo, unit)}, ${fmt(m.diff.hi, unit)}]`;
    rows.push([label, fmt(m.baseline, unit), fmt(m.candidate, unit), color(m.verdict, `${d} ${ci} ${signedRel(m.relative)}`.trim())]);
  }
  if (r.surface) {
    const s = r.surface;
    rows.push(["surface", kb(s.baseline.surfaceBytes), kb(s.candidate.surfaceBytes), `${s.surfaceBytes.delta >= 0 ? "+" : ""}${s.surfaceBytes.delta} B ${signedRel(s.surfaceBytes.relative)}`]);
    rows.push(["descriptions", kb(s.baseline.descriptionBytes), kb(s.candidate.descriptionBytes), `${s.descriptionBytes.delta >= 0 ? "+" : ""}${s.descriptionBytes.delta} B ${signedRel(s.descriptionBytes.relative)}`]);
    rows.push([`tokens${s.candidate.tokensEstimated ? " (est.)" : ""}`, String(s.baseline.surfaceTokens), String(s.candidate.surfaceTokens), `${s.surfaceTokens.delta >= 0 ? "+" : ""}${s.surfaceTokens.delta} ${signedRel(s.surfaceTokens.relative)}`]);
  }
  out.push(...table(rows, [20, 22, 22, 30]));
  if (r.regressions.length) {
    out.push("");
    out.push(p.bad(`regressions (${r.regressions.length})`));
    for (const g of r.regressions.slice(0, o.maxRows ?? 20)) {
      const sess = (ts: { id: string; sessionId?: string }[]) => ts.map((t) => t.sessionId ?? t.id)[0] ?? "—";
      const div = g.firstDivergence ? ` · diverges at step ${g.firstDivergence.index + 1}: ${g.firstDivergence.description}` : "";
      out.push(`  ${g.taskId}  ${g.kind === "metric" ? `${g.metric}: ` : ""}${g.detail}  (${sess(g.baselineTrials)} vs ${sess(g.candidateTrials)})${div}`);
    }
  }
  out.push("");
  out.push(`verdict: ${r.verdict.kind === "better" ? p.good(r.verdict.text) : r.verdict.kind === "worse" ? p.bad(r.verdict.text) : p.bold(r.verdict.text)}`);
  for (const n of r.notes) out.push(p.dim(`note: ${n}`));
  return `${out.join("\n")}\n`;
}

export function formatSurface(s: SurfaceReport, o: FormatOpts = {}): string {
  const p = painter(o.color);
  const out = [`${p.bold(s.target)} (${s.variant}): ${kb(s.surfaceBytes)} surface, ${kb(s.descriptionBytes)} descriptions, ${s.surfaceTokens} tokens${s.tokensEstimated ? " (estimated)" : ""}`];
  if (s.items.length) {
    out.push("");
    const rows = [["item", "bytes", "description bytes"].map(p.dim)];
    for (const i of [...s.items].sort((a, b) => b.bytes - a.bytes)) rows.push([i.name, String(i.bytes), String(i.descriptionBytes)]);
    out.push(...table(rows));
  }
  return `${out.join("\n")}\n`;
}

export function formatCompress(r: CompressReport, o: FormatOpts = {}): string {
  const p = painter(o.color);
  const cut = r.bytesBefore ? (1 - r.bytesAfter / r.bytesBefore) * 100 : 0;
  const out = [p.bold("coding.sh toolevals compress")];
  out.push(`description bytes ${r.bytesBefore} → ${r.bytesAfter} (−${cut.toFixed(1)}%) · surface tokens ${r.surfaceTokensBefore} → ${r.surfaceTokensAfter} · ${r.evals} eval(s)`);
  if (r.steps.length) {
    out.push("");
    const rows = [["tool", "bytes", "source", "result"].map(p.dim)];
    for (const s of r.steps) rows.push([s.tool, `${s.fromBytes} → ${s.toBytes}`, s.source, s.accepted ? p.good("accepted") : p.dim(`rejected: ${s.evidence.reason ?? ""}`)]);
    out.push(...table(rows));
  }
  if (r.heldout) {
    out.push("");
    out.push(`held-out: ${r.heldout.verdict.text}${r.overfit ? p.bad(" · overfit (kept the last state that passed)") : ""}`);
    for (const t of r.heldout.tasks) out.push(p.dim(`  ${t.taskId}  ${t.baseline.passes}/${t.baseline.trials} → ${t.candidate.passes}/${t.candidate.trials}`));
  }
  for (const n of r.notes) out.push(p.dim(`note: ${n}`));
  return `${out.join("\n")}\n`;
}

export function formatTrial(t: TrialResult, extra: { tap?: TapRecord[]; sessions?: { id: string; parent?: string; agent?: string; title?: string }[] } = {}, o: FormatOpts = {}): string {
  const p = painter(o.color);
  const m = t.metrics;
  const out = [p.bold(`${t.id}  ${t.pass ? p.good("PASS") : p.bad("FAIL")}`)];
  out.push(`task ${t.taskId} · arm ${t.variant}@${t.driver} · attempt ${t.attempt}${t.sessionId ? ` · session ${t.sessionId}` : ""}`);
  if (t.error) out.push(p.bad(`error: ${t.error}`));
  for (const c of t.checks) out.push(`  ${c.pass ? p.good("✓") : p.bad("✗")} ${c.kind}${c.detail ? p.dim(`  ${c.detail}`) : ""}`);
  if (m) {
    out.push("");
    out.push(`turns ${m.turns} (${m.turnsSource}) · tool calls ${m.toolCalls} · target calls ${m.targetCalls} · invalid ${m.invalidCalls} (${pct(m.invalidRate)}) · failed ${m.failedCalls}`);
    out.push(`help lookups ${m.helpLookups} · retries ${m.retries} · self-corrections ${m.selfCorrections} · recovery ${m.recoveryRate === null ? "—" : pct(m.recoveryRate)}`);
    const tok = (m.usage.inputTokens ?? 0) + (m.usage.outputTokens ?? 0);
    out.push(`tokens ${tok} · cost ${m.costUsd === null ? "—" : fmt(m.costUsd, "usd")} (${m.costSource}) · wall ${formatDuration(m.wallMs)}${m.budgetExceeded ? p.bad(` · budget exceeded: ${m.budgetExceeded}`) : ""}`);
    const lat = [m.llmP50Ms !== undefined ? `llm p50 ${formatDuration(m.llmP50Ms)}` : "", m.llmP95Ms !== undefined ? `p95 ${formatDuration(m.llmP95Ms)}` : "", m.ttftP50Ms !== undefined ? `ttft p50 ${formatDuration(m.ttftP50Ms)}` : "", m.targetLatencyP95Ms !== undefined ? `tool p95 ${formatDuration(m.targetLatencyP95Ms)}` : ""].filter(Boolean);
    out.push(`latency (${m.latencySource}) ${lat.join(" · ") || "—"}`);
    out.push(`subagents ${m.subagents} · subagent target calls ${m.subagentTargetCalls}${m.tapCoverage !== null ? ` · tap coverage ${pct(m.tapCoverage)}` : ""}`);
  }
  if (extra.tap?.length) {
    out.push("");
    out.push(p.dim("tap"));
    for (const r of extra.tap.slice(0, o.maxRows ?? 50)) {
      const what = r.argv ? r.argv.join(" ") : r.tool ? `${r.method ?? "tools/call"} ${r.tool}` : r.method ?? `${r.httpMethod ?? ""} ${r.pathTemplate ?? ""}`;
      out.push(`  ${pad(r.class, 8)} ${pad(formatDuration(r.durationMs), 8)} ${what}${r.reason ? p.dim(`  (${r.reason})`) : ""}`);
    }
  }
  if (extra.sessions?.length) {
    out.push("");
    out.push(p.dim("sessions"));
    for (const s of extra.sessions) out.push(`  ${s.parent ? "  └ " : ""}${s.id}${s.agent ? ` ${s.agent}` : ""}${s.title ? p.dim(`  ${s.title}`) : ""}`);
  }
  return `${out.join("\n")}\n`;
}
