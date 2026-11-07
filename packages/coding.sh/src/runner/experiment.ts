// A/B experiments over harness bundles: run every (task, bundle, attempt),
// then compare two arms with paired statistics and honest wording.
import { availableParallelism } from "node:os";
import { sortableId } from "../core/ids.ts";
import type { Adapter, AgentEvent, BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult, Session } from "../core/types.ts";
import { pairedPower, type PowerAnalysis } from "../experiments/power.ts";
import { pairedBootstrap, wilson, type BootstrapResult, type Interval } from "../stats/interval.ts";
import { mean } from "../stats/summary.ts";
import { mcnemar, type McNemarResult } from "../stats/tests.ts";
import { diffBundles, formatBundleDiff, type BundleDiff } from "./bundle.ts";
import { firstDivergence, type Divergence } from "./divergence.ts";
import type { SnapshotOps } from "./git.ts";
import { runTask, type AgentRoute } from "./run.ts";

// ------------------------------------------------------------ running

export interface ExperimentProgress {
  done: number;
  total: number;
  result: RunResult;
  task: EvalTask;
  bundle: HarnessBundle;
}

export interface RunExperimentOpts {
  tasks: EvalTask[];
  bundles: HarnessBundle[];
  adapterFor: (bundle: HarnessBundle) => Adapter;
  blobs: BlobStore;
  index: IndexStore;
  /** Attempts per (task, bundle). Default 1. */
  k?: number;
  /** Parallel runs. Default min(4, cpus/2). */
  concurrency?: number;
  timeoutMs?: number;
  experimentId?: string;
  onProgress?: (p: ExperimentProgress) => void;
  keep?: boolean;
  env?: Record<string, string>;
  git?: SnapshotOps;
  runsDir?: string;
  /** Extra test globs for each run's tamper check. */
  testGlobs?: string[];
  /** Agent-only routing per arm (see RunTaskOpts.route). */
  route?: AgentRoute;
}

export interface Job {
  task: EvalTask;
  bundle: HarnessBundle;
  attempt: number;
}

/**
 * Job order: per task, attempts interleaved across arms (A1, B1, A2, B2, …),
 * so slow drift (API latency, rate limits, model updates) hits both arms alike.
 */
export function scheduleJobs(tasks: readonly EvalTask[], bundles: readonly HarnessBundle[], k: number): Job[] {
  const jobs: Job[] = [];
  for (const task of tasks) for (let attempt = 1; attempt <= k; attempt++) for (const bundle of bundles) jobs.push({ task, bundle, attempt });
  return jobs;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

export async function runExperiment(o: RunExperimentOpts): Promise<{ experimentId: string; results: RunResult[] }> {
  const experimentId = o.experimentId ?? sortableId("exp_");
  const jobs = scheduleJobs(o.tasks, o.bundles, Math.max(1, o.k ?? 1));
  let done = 0;
  const results = await pool(jobs, o.concurrency ?? defaultConcurrency(), async (job) => {
    let result: RunResult;
    try {
      result = await runTask({
        task: job.task,
        bundle: job.bundle,
        adapter: o.adapterFor(job.bundle),
        blobs: o.blobs,
        index: o.index,
        attempt: job.attempt,
        experimentId,
        timeoutMs: o.timeoutMs,
        keep: o.keep,
        env: o.env,
        route: o.route,
        git: o.git,
        runsDir: o.runsDir,
        testGlobs: o.testGlobs,
      });
    } catch (e) {
      // runTask should not throw; if adapterFor does, record and move on.
      const now = Date.now();
      result = {
        id: sortableId("run_"),
        experimentId,
        taskId: job.task.id,
        bundleId: job.bundle.id,
        attempt: job.attempt,
        pass: false,
        verifierExit: null,
        agent: { exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: "" },
        startedAt: now,
        endedAt: now,
        error: e instanceof Error ? e.message : String(e),
      };
      await o.index.putRun(result).catch(() => {});
    }
    done++;
    o.onProgress?.({ done, total: jobs.length, result, task: job.task, bundle: job.bundle });
    return result;
  });
  return { experimentId, results };
}

/** Sessions captured for runs (via hooks, tagged with CODING_SH_RUN_ID), keyed by run id. */
export async function loadRunSessions(index: IndexStore, results: readonly RunResult[]): Promise<Map<string, Session>> {
  const out = new Map<string, Session>();
  for (const r of results) {
    let s = r.sessionId ? await index.getSession(r.sessionId) : undefined;
    if (!s) s = (await index.listSessions({ runId: r.id, limit: 1 }))[0];
    if (s) out.set(r.id, s);
  }
  return out;
}

/** Events per run id, for trace divergence. */
export async function loadRunEvents(index: IndexStore, sessions: Map<string, Session>): Promise<Map<string, AgentEvent[]>> {
  const out = new Map<string, AgentEvent[]>();
  for (const [runId, s] of sessions) out.set(runId, await index.listEvents(s.id));
  return out;
}

// ------------------------------------------------------------ comparing

export type MetricKey = "cost" | "tokens" | "turns" | "wall" | "agentTime" | "llmTime" | "llmP50" | "llmP95" | "ttftP50";

export interface MetricDelta {
  key: MetricKey;
  label: string;
  unit: "usd" | "ms" | "count";
  /** Mean per run over runs where the metric is known. */
  baseline: number;
  candidate: number;
  /** candidate − baseline. */
  delta: number;
  /** delta / baseline (NaN when baseline is 0 or unknown). */
  relative: number;
  n: { baseline: number; candidate: number };
}

export interface ArmSummary {
  bundleId: string;
  name?: string;
  runs: number;
  passes: number;
  passRate: Interval;
  errors: number;
  /** Runs that carry a tamper check (older runs have none). */
  tamperChecked: number;
  /** Checked runs whose diff edited, deleted or skipped tests. */
  tampered: number;
  /** tampered / tamperChecked; NaN when no run was checked. */
  tamperRate: number;
  /** Tampered runs that still passed: passes that may not be earned. */
  tamperedPasses: number;
}

export interface TaskOutcome {
  taskId: string;
  baseline: { passes: number; runs: number };
  candidate: { passes: number; runs: number };
  /** candidate rate − baseline rate. */
  diff: number;
  divergence?: Divergence;
}

export type VerdictKind = "better" | "worse" | "no-difference" | "inconclusive";

export interface CompareReport {
  baseline: ArmSummary;
  candidate: ArmSummary;
  tasks: TaskOutcome[];
  /** Tasks with at least one run in each arm. */
  pairedTasks: number;
  /** Tasks present in only one arm (excluded from paired stats). */
  unpairedTasks: string[];
  /** Max attempts seen for any (task, arm). */
  k: number;
  /** Paired bootstrap over tasks of the per-task pass-rate difference. */
  diff: BootstrapResult;
  /**
   * Exact McNemar over per-task majority outcomes (pass when the task's pass
   * rate is >= 0.5), one pair per paired task. Attempts are not separate pairs.
   */
  mcnemar: McNemarResult;
  /**
   * Minimum detectable effect and power warnings over the per-task pass-rate
   * differences (the task is the cluster), same analysis as `exp compare`.
   */
  power: PowerAnalysis;
  metrics: MetricDelta[];
  verdict: { kind: VerdictKind; text: string };
  notes: string[];
  bundleDiff?: BundleDiff;
  alpha: number;
}

export interface CompareOpts {
  /** Bundle ids of the two arms. */
  baseline: string;
  candidate: string;
  /** Captured sessions keyed by run id (turns, latency, usage fallback). */
  sessions?: Map<string, Session>;
  /** Events keyed by run id (first trace divergence per task). */
  events?: Map<string, AgentEvent[]>;
  bundles?: { baseline?: HarnessBundle; candidate?: HarnessBundle };
  alpha?: number;
  iters?: number;
  seed?: number;
}

type Extract = (r: RunResult, s: Session | undefined) => number | undefined;

const METRICS: { key: MetricKey; label: string; unit: MetricDelta["unit"]; get: Extract }[] = [
  { key: "cost", label: "cost / run", unit: "usd", get: (r, s) => r.agent.usage?.costUsd ?? s?.stats.usage?.costUsd },
  {
    key: "tokens",
    label: "tokens / run",
    unit: "count",
    get: (r, s) => {
      const u = r.agent.usage ?? s?.stats.usage;
      if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return undefined;
      return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    },
  },
  { key: "turns", label: "turns / run", unit: "count", get: (_r, s) => s?.stats.turns },
  { key: "wall", label: "wall time / run", unit: "ms", get: (r) => r.endedAt - r.startedAt },
  { key: "agentTime", label: "agent time / run", unit: "ms", get: (r) => (r.agent.durationMs > 0 ? r.agent.durationMs : undefined) },
  { key: "llmTime", label: "LLM time / run", unit: "ms", get: (_r, s) => s?.stats.latency?.llmMs },
  { key: "llmP50", label: "LLM call p50", unit: "ms", get: (_r, s) => s?.stats.latency?.llmP50Ms },
  { key: "llmP95", label: "LLM call p95", unit: "ms", get: (_r, s) => s?.stats.latency?.llmP95Ms },
  { key: "ttftP50", label: "TTFT p50", unit: "ms", get: (_r, s) => s?.stats.latency?.ttftP50Ms },
];

function arm(results: readonly RunResult[], bundleId: string, name?: string): ArmSummary {
  const passes = results.filter((r) => r.pass).length;
  const checked = results.filter((r) => r.tamper);
  const tampered = checked.filter((r) => r.tamper?.flagged);
  return {
    bundleId,
    name,
    runs: results.length,
    passes,
    passRate: wilson(passes, results.length),
    errors: results.filter((r) => r.error).length,
    tamperChecked: checked.length,
    tampered: tampered.length,
    tamperRate: checked.length ? tampered.length / checked.length : NaN,
    tamperedPasses: tampered.filter((r) => r.pass).length,
  };
}

export function compare(results: readonly RunResult[], opts: CompareOpts): CompareReport {
  const alpha = opts.alpha ?? 0.05;
  const A = results.filter((r) => r.bundleId === opts.baseline);
  const B = results.filter((r) => r.bundleId === opts.candidate);
  const byTask = (rs: readonly RunResult[]) => {
    const m = new Map<string, RunResult[]>();
    for (const r of rs) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
    for (const v of m.values()) v.sort((x, y) => x.attempt - y.attempt);
    return m;
  };
  const ta = byTask(A);
  const tb = byTask(B);
  const taskIds = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  const tasks: TaskOutcome[] = [];
  const unpaired: string[] = [];
  const diffs: number[] = [];
  let mb = 0;
  let mc = 0;
  let k = 0;
  for (const id of taskIds) {
    const ra = ta.get(id) ?? [];
    const rb = tb.get(id) ?? [];
    k = Math.max(k, ra.length, rb.length);
    const pa = ra.filter((r) => r.pass).length;
    const pb = rb.filter((r) => r.pass).length;
    if (!ra.length || !rb.length) {
      unpaired.push(id);
      continue;
    }
    const diff = pb / rb.length - pa / ra.length;
    diffs.push(diff);
    // One McNemar pair per task (the cluster), on its majority outcome: attempts
    // of one task are correlated, so counting them as separate pairs would
    // overstate the evidence. Same rule as experiments/compare.ts (rate >= 0.5
    // counts as a pass).
    const x = pa / ra.length >= 0.5;
    const y = pb / rb.length >= 0.5;
    if (x && !y) mb++;
    else if (!x && y) mc++;
    let divergence: Divergence | undefined;
    const ea = opts.events?.get((ra[0] as RunResult).id);
    const eb = opts.events?.get((rb[0] as RunResult).id);
    if (ea && eb) divergence = firstDivergence(ea, eb);
    tasks.push({ taskId: id, baseline: { passes: pa, runs: ra.length }, candidate: { passes: pb, runs: rb.length }, diff, divergence });
  }

  const boot = pairedBootstrap(diffs, { iters: opts.iters, seed: opts.seed, alpha });
  const mcn = mcnemar(mb, mc);

  const metrics: MetricDelta[] = [];
  for (const m of METRICS) {
    const va = A.map((r) => m.get(r, opts.sessions?.get(r.id))).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const vb = B.map((r) => m.get(r, opts.sessions?.get(r.id))).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (!va.length && !vb.length) continue;
    const a = mean(va);
    const b = mean(vb);
    metrics.push({ key: m.key, label: m.label, unit: m.unit, baseline: a, candidate: b, delta: b - a, relative: a ? (b - a) / a : NaN, n: { baseline: va.length, candidate: vb.length } });
  }

  const notes: string[] = [];
  if (k > 1) notes.push(`pass-rate intervals (Wilson) treat the ${k} runs per task as independent and are optimistic; the bootstrap CI resamples tasks and is the one to trust`);
  if (unpaired.length) notes.push(`${unpaired.length} task(s) ran in only one arm and are excluded from paired stats`);
  const sa = arm(A, opts.baseline, opts.bundles?.baseline?.name);
  const sb = arm(B, opts.candidate, opts.bundles?.candidate?.name);
  const errs = sa.errors + sb.errors;
  if (errs) notes.push(`${errs} run(s) recorded an error (setup, agent or verifier); they count as failures`);
  const tampered = sa.tampered + sb.tampered;
  if (tampered) {
    const tp = sa.tamperedPasses + sb.tamperedPasses;
    notes.push(
      `${tampered} run(s) edited, deleted or skipped tests (baseline ${sa.tampered}, candidate ${sb.tampered}); ${tp} of them passed and still count as passes, so inspect their diffs before trusting the pass rate`,
    );
  }

  const verdict = decide(diffs.length, boot, mcn, alpha, metrics);
  if (verdict.extra) notes.push(verdict.extra);
  return {
    baseline: sa,
    candidate: sb,
    tasks,
    pairedTasks: diffs.length,
    unpairedTasks: unpaired,
    k,
    diff: boot,
    mcnemar: mcn,
    power: pairedPower(diffs, { alpha }),
    metrics,
    verdict: { kind: verdict.kind, text: verdict.text },
    notes,
    bundleDiff: opts.bundles?.baseline && opts.bundles.candidate ? diffBundles(opts.bundles.baseline, opts.bundles.candidate) : undefined,
    alpha,
  };
}

const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;
const pval = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function decide(
  paired: number,
  boot: BootstrapResult,
  mcn: McNemarResult,
  alpha: number,
  metrics: MetricDelta[],
): { kind: VerdictKind; text: string; extra?: string } {
  if (paired === 0) return { kind: "inconclusive", text: "inconclusive: no task ran in both arms" };
  const level = `${Math.round((1 - alpha) * 100)}%`;
  const ci = `${level} CI [${pp(boot.lo)}, ${pp(boot.hi)}]`;
  const bootSig = boot.lo > 0 || boot.hi < 0;
  const mcSig = mcn.p < alpha;
  const small = paired < 10 ? ` (only ${paired} task${paired === 1 ? "" : "s"}; underpowered)` : "";
  const cost = metrics.find((m) => m.key === "cost");
  const costNote =
    cost && Number.isFinite(cost.relative) && Math.abs(cost.relative) >= 0.05
      ? `pass rates aside, candidate is ${Math.abs(cost.relative * 100).toFixed(0)}% ${cost.relative < 0 ? "cheaper" : "more expensive"} per run`
      : undefined;
  if (bootSig && mcSig) {
    const better = boot.mean > 0;
    return { kind: better ? "better" : "worse", text: `candidate ${better ? "better" : "worse"}: ${pp(boot.mean)} pass rate, ${ci}, McNemar ${pval(mcn.p)}`, extra: costNote };
  }
  if (!bootSig && !mcSig) {
    return { kind: "no-difference", text: `no significant difference: ${pp(boot.mean)} pass rate, ${ci} includes 0, McNemar ${pval(mcn.p)}${small}`, extra: costNote };
  }
  return {
    kind: "inconclusive",
    text: `inconclusive: ${pp(boot.mean)} pass rate; ${bootSig ? `bootstrap ${ci} excludes 0 but McNemar ${pval(mcn.p)}` : `McNemar ${pval(mcn.p)} but bootstrap ${ci} includes 0`}${small}; run more tasks or attempts`,
    extra: costNote,
  };
}

// ------------------------------------------------------------ formatting

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const neg = ms < 0 ? "-" : "";
  const a = Math.abs(ms);
  if (a < 1000) return `${neg}${Math.round(a)}ms`;
  if (a < 60_000) return `${neg}${(a / 1000).toFixed(1)}s`;
  const m = Math.floor(a / 60_000);
  const s = Math.round((a % 60_000) / 1000);
  return `${neg}${m}m${String(s).padStart(2, "0")}s`;
}

function fmtValue(v: number, unit: MetricDelta["unit"]): string {
  if (!Number.isFinite(v)) return "—";
  if (unit === "usd") return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 3 : 2)}`;
  if (unit === "ms") return formatDuration(v);
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1).replace(/\.0$/, "");
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");

export interface FormatOpts {
  color?: boolean;
  /** Max per-task rows (default 20). */
  maxTasks?: number;
}

export function formatCompare(r: CompareReport, opts: FormatOpts = {}): string {
  const c = opts.color ?? false;
  const paint = (code: string, s: string) => (c ? `\x1b[${code}m${s}\x1b[0m` : s);
  const good = (s: string) => paint("32", s);
  const bad = (s: string) => paint("31", s);
  const dim = (s: string) => paint("2", s);
  const bold = (s: string) => paint("1", s);
  // Pad by visible width so ANSI codes don't break alignment.
  const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
  const W = [18, 22, 22, 26];
  // A cell that fills (or overflows) its column still gets one space, so
  // adjacent cells never run together.
  const row = (cells: string[]) =>
    cells
      .map((x, i) => {
        const w = W[i] ?? 10;
        return vis(x) >= w ? `${x} ` : pad(x, w);
      })
      .join("")
      .trimEnd();
  const signed = (delta: number, lowerIsBetter: boolean, text: string) =>
    !Number.isFinite(delta) || delta === 0 ? text : (delta < 0) === lowerIsBetter ? good(text) : bad(text);

  const name = (a: ArmSummary) => `${a.name ? `${a.name} ` : ""}(${a.bundleId.slice(0, 8)})`;
  const out: string[] = [];
  out.push(bold("coding.sh compare"));
  out.push(`baseline   ${name(r.baseline)}`);
  out.push(`candidate  ${name(r.candidate)}`);
  out.push(dim(`${r.pairedTasks} paired task(s) · k=${r.k} · ${r.baseline.runs} vs ${r.candidate.runs} runs`));
  out.push("");
  out.push(dim(row(["", "baseline", "candidate", "delta"])));
  const rate = (a: ArmSummary) => `${pct(a.passRate.p)} [${pct(a.passRate.lo).replace("%", "")}–${pct(a.passRate.hi)}]`;
  const dtext = `${pp(r.diff.mean)} [${pp(r.diff.lo).replace(" pp", "")}, ${pp(r.diff.hi)}]`;
  out.push(row(["pass rate", rate(r.baseline), rate(r.candidate), signed(r.diff.mean, false, dtext)]));
  out.push(row(["passes", `${r.baseline.passes}/${r.baseline.runs}`, `${r.candidate.passes}/${r.candidate.runs}`, `McNemar ${pval(r.mcnemar.p)}`]));
  if (r.baseline.tamperChecked || r.candidate.tamperChecked) {
    const tr = (a: ArmSummary) => (a.tamperChecked ? `${pct(a.tamperRate)} (${a.tampered}/${a.tamperChecked})` : "—");
    const td = r.candidate.tamperRate - r.baseline.tamperRate;
    out.push(row(["tamper rate", tr(r.baseline), tr(r.candidate), Number.isFinite(td) ? signed(td, true, pp(td)) : "—"]));
  }
  for (const m of r.metrics) {
    const rel = Number.isFinite(m.relative) ? ` (${m.relative >= 0 ? "+" : ""}${(m.relative * 100).toFixed(0)}%)` : "";
    const d = `${m.delta >= 0 && Number.isFinite(m.delta) ? "+" : ""}${fmtValue(m.delta, m.unit)}${rel}`;
    out.push(row([m.label, fmtValue(m.baseline, m.unit), fmtValue(m.candidate, m.unit), signed(m.delta, true, d)]));
  }
  if (r.tasks.length) {
    out.push("");
    out.push(dim(row(["task", "baseline", "candidate", "first divergence"])));
    const max = opts.maxTasks ?? 20;
    for (const t of [...r.tasks].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, max)) {
      const mark = t.diff > 0 ? good("▲") : t.diff < 0 ? bad("▼") : " ";
      const div = t.divergence ? `step ${t.divergence.index + 1}: ${t.divergence.a?.tool ?? "(end)"} vs ${t.divergence.b?.tool ?? "(end)"}` : "";
      // "▲ " + id must leave at least one space in the first column.
      const idW = (W[0] as number) - 3;
      const id = t.taskId.length > idW ? `${t.taskId.slice(0, idW - 1)}…` : t.taskId;
      out.push(row([`${mark} ${id}`, `${t.baseline.passes}/${t.baseline.runs}`, `${t.candidate.passes}/${t.candidate.runs}`, div]));
    }
    if (r.tasks.length > max) out.push(dim(`… ${r.tasks.length - max} more`));
  }
  if (r.bundleDiff) {
    out.push("");
    out.push(dim("harness changes"));
    for (const l of formatBundleDiff(r.bundleDiff)) out.push(`  ${l}`);
  }
  out.push("");
  const v = r.verdict;
  const vtext = v.kind === "better" ? good(v.text) : v.kind === "worse" ? bad(v.text) : bold(v.text);
  out.push(`verdict: ${vtext}`);
  const p = r.power;
  out.push(
    `power   MDE ${Number.isFinite(p.mde) ? `${(p.mde * 100).toFixed(1)}pp` : "—"} ` +
      dim(`(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? p.sd.toFixed(2) : "—"})`),
  );
  for (const w of p.warnings) out.push(paint("33", `! ${w.message}`));
  for (const n of r.notes) out.push(dim(`note: ${n}`));
  return `${out.join("\n")}\n`;
}
