// Metric experiments (XR-4): A/B over continuous numbers (ms, bytes, counts)
// instead of pass/fail. Each arm is a task whose output is a JSON object of
// numbers, e.g. a Lighthouse run printing {"fcp_ms": 812, "js_bytes": 48211}.
//
// The arms run in interleaved pairs, one pair after another and never two runs
// at once (they would compete for CPU and network). Within a pair the arm order
// is balanced and shuffled by the seed: half the pairs run A first, half B
// first, so a warm disk cache or a CPU that heats up over the run lands on both
// arms alike. Per metric the report gives each arm's median, the median paired
// delta (B − A) with a 95% paired bootstrap CI, and a verdict.
//
// The verdict needs two things: the bootstrap CI excludes 0, and an exact sign
// test on the paired deltas is significant after a Holm correction across the
// metrics. The bootstrap alone is too optimistic at the usual 11 pairs (its
// tails are thin), and a page run reports dozens of metrics, so without the
// correction an A/A run would flag a few of them by chance. A metric whose
// deltas are all the same (a byte count of a fixed build) has no noise to test
// against: a non-zero delta is a change, a zero delta is no change.
import { sortableId } from "../core/ids.ts";
import type { TaskInfo } from "../datasets/types.ts";
import { pairedBootstrapMedian } from "../stats/interval.ts";
import { mulberry32 } from "../stats/prng.ts";
import { median } from "../stats/summary.ts";
import { holm, signTest, type SignTestResult } from "../stats/tests.ts";
import { pairedPower } from "./power.ts";
import { resolveTask, type TaskSpec } from "./task.ts";
import { paint, table, type RenderOpts } from "./text.ts";

export interface MetricArm {
  name: string;
  task: TaskSpec;
}

export type MetricVerdict = "better" | "worse" | "inconclusive";
export type MetricUnit = "ms" | "bytes" | "count";

export interface MetricRun {
  /** 1-based pair number; 0 for a warm-up run. */
  pair: number;
  /** 0 = A (baseline), 1 = B (candidate). */
  arm: 0 | 1;
  warmup?: boolean;
  startedAt: number;
  durationMs: number;
  /** Flattened numbers the task printed ("mobile.home.lcp_ms": 2310). */
  metrics?: Record<string, number>;
  error?: string;
}

export interface MetricStat {
  name: string;
  unit: MetricUnit;
  better: "lower" | "higher";
  /** Pairs where both runs reported the metric. */
  n: number;
  a: { median: number; n: number };
  b: { median: number; n: number };
  /** Median paired delta (B − A) and its paired bootstrap CI. */
  delta: { median: number; lo: number; hi: number };
  /** delta.median / a.median (NaN when A's median is 0). */
  relative: number;
  sign: SignTestResult;
  /** Holm-adjusted sign-test p over the noisy metrics (= sign.p with correction "none"); NaN for a deterministic metric. */
  pAdjusted: number;
  /** Every paired delta was the same: no noise, so no test. */
  deterministic: boolean;
  /** Smallest true mean shift this many pairs detect (80% power, normal approximation). NaN without spread. */
  mde: number;
  verdict: MetricVerdict;
}

export interface MetricExpResult {
  id: string;
  name: string;
  status: "completed" | "cancelled";
  createdAt: number;
  finishedAt: number;
  seed: number;
  /** Pairs asked for. */
  pairs: number;
  warmup: number;
  arms: [{ name: string; task: TaskInfo }, { name: string; task: TaskInfo }];
  /** Arm order of each pair, by pair number − 1. */
  order: ("AB" | "BA")[];
  runs: MetricRun[];
  alpha: number;
  correction: "holm" | "none";
  metrics: MetricStat[];
  /** `same`: metrics with no spread that did not move (an exit code of 0 on both arms); `inconclusive` leaves them out. */
  summary: { better: number; worse: number; same: number; inconclusive: number; pairsComplete: number; failedRuns: number };
  notes: string[];
}

export interface RunMetricsOpts {
  name?: string;
  arms: readonly [MetricArm, MetricArm];
  /** Interleaved pairs. Default 11. */
  pairs?: number;
  /** Runs of each arm before the pairs, thrown away. Default 0. */
  warmup?: number;
  /** Seed for the arm order within pairs. Default random (recorded). */
  seed?: number;
  /** Metric names (`*` wildcards) where higher is better. Lower is better otherwise. */
  higher?: readonly string[];
  /** Keep only these metrics (`*` wildcards). Default all. */
  only?: readonly string[];
  /** Holm across metrics (default) or none. */
  correction?: "holm" | "none";
  alpha?: number;
  iters?: number;
  signal?: AbortSignal;
  onRun?: (run: MetricRun, done: number, total: number) => void;
}

export class MetricRunError extends Error {
  readonly arm: string;
  constructor(arm: string, message: string) {
    super(message);
    this.name = "MetricRunError";
    this.arm = arm;
  }
}

/**
 * The finite numbers in a task's output, keyed by dotted path:
 * {"mobile": {"lcp_ms": 2310}} → {"mobile.lcp_ms": 2310}. Strings, booleans,
 * nulls and arrays are skipped. Throws when the output is not a JSON object.
 */
export function flattenMetrics(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    const shown = typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v);
    throw new Error(`a metric command must print a JSON object of numbers, like {"lcp_ms": 2310}; got ${shown}`);
  }
  const out: Record<string, number> = {};
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, x] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof x === "number" && Number.isFinite(x)) out[key] = x;
      else if (x && typeof x === "object" && !Array.isArray(x)) walk(x as Record<string, unknown>, key);
    }
  };
  walk(v as Record<string, unknown>, "");
  return out;
}

/** `*` matches any run of characters; everything else is literal. */
export function metricMatches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name));
}

/** Unit from the name's suffix: _ms → ms, _bytes / _kb → bytes, anything else is a count or score. */
export function metricUnit(name: string): MetricUnit {
  if (/(_|\b)ms$/.test(name)) return "ms";
  if (/(_|\b)bytes$/.test(name)) return "bytes";
  return "count";
}

/** Balanced arm order: ⌈n/2⌉ pairs A-first and ⌊n/2⌋ B-first, shuffled by the seed. */
export function pairOrder(pairs: number, seed: number): ("AB" | "BA")[] {
  const order: ("AB" | "BA")[] = Array.from({ length: pairs }, (_, i) => (i < Math.ceil(pairs / 2) ? "AB" : "BA"));
  const rand = mulberry32(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export async function runMetrics(opts: RunMetricsOpts): Promise<MetricExpResult> {
  const pairs = opts.pairs ?? 11;
  const warmup = opts.warmup ?? 0;
  if (!(Number.isInteger(pairs) && pairs >= 1)) throw new RangeError(`pairs must be a positive integer (got ${pairs})`);
  if (!(Number.isInteger(warmup) && warmup >= 0)) throw new RangeError(`warmup must be a non-negative integer (got ${warmup})`);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  const id = sortableId("mexp_");
  const createdAt = Date.now();
  const tasks = [resolveTask(opts.arms[0].task), resolveTask(opts.arms[1].task)] as const;
  const order = pairOrder(pairs, seed);
  const jobs: { pair: number; arm: 0 | 1 }[] = [];
  for (let w = 0; w < warmup; w++) jobs.push({ pair: 0, arm: 0 }, { pair: 0, arm: 1 });
  for (const [i, o] of order.entries()) {
    const first: 0 | 1 = o === "AB" ? 0 : 1;
    jobs.push({ pair: i + 1, arm: first }, { pair: i + 1, arm: first === 0 ? 1 : 0 });
  }
  const runs: MetricRun[] = [];
  const firstSeen = new Set<number>();
  for (const job of jobs) {
    if (opts.signal?.aborted) break;
    const arm = opts.arms[job.arm];
    const startedAt = Date.now();
    const run: MetricRun = { pair: job.pair, arm: job.arm, startedAt, durationMs: 0 };
    if (job.pair === 0) run.warmup = true;
    try {
      const out = await tasks[job.arm].run(
        { arm: arm.name, pair: job.pair, warmup: job.pair === 0 },
        { runId: id, caseId: arm.name, trial: job.pair, metadata: { arm: arm.name, pair: job.pair }, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      run.metrics = flattenMetrics(out);
      if (!Object.keys(run.metrics).length) throw new Error(`printed no numbers: ${JSON.stringify(out).slice(0, 200)}`);
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
    }
    run.durationMs = Date.now() - startedAt;
    // A run cut short by the interrupt says nothing about either arm.
    if (opts.signal?.aborted) break;
    runs.push(run);
    opts.onRun?.(run, runs.length, jobs.length);
    // An arm whose first run fails is almost always misconfigured: stop before spending the whole budget.
    if (!firstSeen.has(job.arm)) {
      firstSeen.add(job.arm);
      if (run.error !== undefined) throw new MetricRunError(arm.name, `arm ${arm.name}: the first run failed: ${run.error}`);
    }
  }
  const status = opts.signal?.aborted ? "cancelled" : "completed";
  const correction = opts.correction ?? "holm";
  const alpha = opts.alpha ?? 0.05;
  const analysis = analyzeMetrics(runs, {
    higher: opts.higher ?? [],
    ...(opts.only ? { only: opts.only } : {}),
    correction,
    alpha,
    iters: opts.iters ?? 10_000,
    seed,
  });
  const failedRuns = runs.filter((r) => !r.warmup && r.error !== undefined).length;
  const notes = [...analysis.notes];
  if (failedRuns) notes.unshift(`${failedRuns} run(s) failed; their pairs are left out of every metric`);
  if (status === "cancelled") notes.unshift(`cancelled after ${analysis.pairsComplete} of ${pairs} pairs; this result is partial`);
  return {
    id,
    name: opts.name ?? `${opts.arms[0].name}-vs-${opts.arms[1].name}`,
    status,
    createdAt,
    finishedAt: Date.now(),
    seed,
    pairs,
    warmup,
    arms: [
      { name: opts.arms[0].name, task: tasks[0].info },
      { name: opts.arms[1].name, task: tasks[1].info },
    ],
    order,
    runs,
    alpha,
    correction,
    metrics: analysis.metrics,
    summary: {
      better: analysis.metrics.filter((m) => m.verdict === "better").length,
      worse: analysis.metrics.filter((m) => m.verdict === "worse").length,
      same: analysis.metrics.filter(isSame).length,
      inconclusive: analysis.metrics.filter((m) => m.verdict === "inconclusive" && !isSame(m)).length,
      pairsComplete: analysis.pairsComplete,
      failedRuns,
    },
    notes,
  };
}

/** A metric with no spread on either arm and no change: "same", not inconclusive. */
const isSame = (m: MetricStat) => m.verdict === "inconclusive" && m.deterministic && m.delta.median === 0;

export interface AnalyzeOpts {
  higher?: readonly string[];
  only?: readonly string[];
  correction?: "holm" | "none";
  alpha?: number;
  iters?: number;
  seed?: number;
}

/** Per-metric statistics over the pairs where both runs succeeded. Warm-up runs are ignored. */
export function analyzeMetrics(runs: readonly MetricRun[], opts: AnalyzeOpts = {}): { metrics: MetricStat[]; pairsComplete: number; notes: string[] } {
  const alpha = opts.alpha ?? 0.05;
  const byPair = new Map<number, [MetricRun | undefined, MetricRun | undefined]>();
  for (const r of runs) {
    if (r.warmup || r.pair < 1) continue;
    const slot = byPair.get(r.pair) ?? [undefined, undefined];
    slot[r.arm] = r;
    byPair.set(r.pair, slot);
  }
  const complete = [...byPair.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, v]) => v)
    .filter((v): v is [MetricRun, MetricRun] => !!v[0]?.metrics && !!v[1]?.metrics);
  const names = new Set<string>();
  for (const [a, b] of complete) for (const k of [...Object.keys(a.metrics!), ...Object.keys(b.metrics!)]) names.add(k);
  const wanted = [...names].filter((n) => !opts.only?.length || metricMatches(n, opts.only));
  const notes: string[] = [];
  const stats: MetricStat[] = wanted.map((name) => {
    const va: number[] = [];
    const vb: number[] = [];
    const diffs: number[] = [];
    for (const [a, b] of complete) {
      const x = a.metrics![name];
      const y = b.metrics![name];
      if (x !== undefined) va.push(x);
      if (y !== undefined) vb.push(y);
      if (x !== undefined && y !== undefined) diffs.push(y - x);
    }
    const boot = pairedBootstrapMedian(diffs, { iters: opts.iters ?? 10_000, seed: opts.seed ?? 0x5eed, alpha });
    const deterministic = diffs.length >= 3 && diffs.every((d) => d === diffs[0]);
    const aMed = median(va);
    return {
      name,
      unit: metricUnit(name),
      better: metricMatches(name, opts.higher ?? []) ? "higher" : "lower",
      n: diffs.length,
      a: { median: aMed, n: va.length },
      b: { median: median(vb), n: vb.length },
      delta: { median: boot.median, lo: boot.lo, hi: boot.hi },
      relative: aMed ? boot.median / aMed : NaN,
      sign: signTest(diffs),
      pAdjusted: NaN,
      deterministic,
      mde: pairedPower(diffs, { alpha }).mde,
      verdict: "inconclusive" as MetricVerdict,
    };
  });
  // Holm over the metrics that have noise to test; deterministic ones are decided by their (fixed) delta.
  const noisy = stats.filter((m) => !m.deterministic && m.n >= 1);
  const adj = opts.correction === "none" ? noisy.map((m) => m.sign.p) : holm(noisy.map((m) => m.sign.p));
  for (const [i, m] of noisy.entries()) m.pAdjusted = adj[i]!;
  for (const m of stats) {
    let dir = 0;
    if (m.deterministic) dir = Math.sign(m.delta.median);
    else if (m.n >= 1 && m.pAdjusted < alpha && (m.delta.lo > 0 || m.delta.hi < 0)) dir = m.delta.lo > 0 ? 1 : -1;
    if (dir !== 0) m.verdict = (dir < 0) === (m.better === "lower") ? "better" : "worse";
    if (m.n < complete.length) notes.push(`${m.name} is missing from ${complete.length - m.n} pair(s)`);
  }
  if (complete.length && complete.length < 6) notes.push(`only ${complete.length} complete pairs: the sign test needs 6 pairs that all agree to reach p < 0.05, so nothing noisy can be called yet`);
  if (noisy.length > 1 && opts.correction !== "none" && complete.length >= 6) {
    notes.push(`sign-test p-values are Holm-adjusted across ${noisy.length} noisy metrics; a metric needs most of its ${complete.length} pairs to agree`);
  }
  stats.sort((x, y) => x.name.localeCompare(y.name));
  return { metrics: stats, pairsComplete: complete.length, notes };
}

// ------------------------------------------------------------ rendering

function fmt(v: number, unit: MetricUnit, signed = false): string {
  if (!Number.isFinite(v)) return "—";
  const sign = signed && v > 0 ? "+" : signed && v < 0 ? "-" : "";
  const a = signed ? Math.abs(v) : v;
  if (unit === "ms") return `${sign}${a < 10 ? a.toFixed(1) : Math.round(a)}ms`;
  if (unit === "bytes") {
    if (Math.abs(a) >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(2)}MB`;
    if (Math.abs(a) >= 1000) return `${sign}${(a / 1000).toFixed(1)}kB`;
    return `${sign}${Math.round(a)}B`;
  }
  if (Number.isInteger(a)) return `${sign}${a}`;
  if (Math.abs(a) >= 1) return `${sign}${a.toFixed(1)}`;
  // Below 1: three decimals, or two significant digits where three decimals would read as zero
  // (a gain per edited weight of 0.0001 is not 0.000).
  const fixed = a.toFixed(3);
  return `${sign}${Number(fixed) === 0 ? String(Number(a.toPrecision(2))) : fixed}`;
}

export function renderMetrics(r: MetricExpResult, opts: RenderOpts): string {
  const color = opts.color;
  const [A, B] = r.arms;
  const out: string[] = [];
  out.push(`${paint(r.name, "bold", color)}  ${paint(r.id, "dim", color)}`);
  out.push(`A ${A.name}: ${A.task.ref}`);
  out.push(`B ${B.name}: ${B.task.ref}`);
  out.push(
    paint(
      `${r.summary.pairsComplete}/${r.pairs} pairs, interleaved (arm order balanced, seed ${r.seed})${r.warmup ? `, ${r.warmup} warm-up round(s)` : ""} · Δ = B − A, median of paired deltas, 95% paired bootstrap CI`,
      "dim",
      color,
    ),
  );
  if (r.metrics.length) {
    out.push("");
    const verdictCell = (m: MetricStat) => {
      const text = isSame(m) ? "same" : m.verdict;
      return m.verdict === "better" ? paint(text, "green", color) : m.verdict === "worse" ? paint(text, "red", color) : paint(text, "dim", color);
    };
    out.push(
      table(
        [
          { header: "metric" },
          { header: A.name, align: "right" },
          { header: B.name, align: "right" },
          { header: "Δ", align: "right" },
          { header: "95% CI" },
          { header: "p (adj)", align: "right" },
          { header: "verdict" },
        ],
        r.metrics.map((m) => {
          const rel = Number.isFinite(m.relative) && m.delta.median !== 0 ? ` (${m.relative > 0 ? "+" : ""}${(m.relative * 100).toFixed(1)}%)` : "";
          const ci = m.deterministic ? "fixed" : Number.isFinite(m.delta.lo) ? `[${fmt(m.delta.lo, m.unit, true)}, ${fmt(m.delta.hi, m.unit, true)}]` : "—";
          const p = Number.isFinite(m.pAdjusted) ? (m.pAdjusted < 0.001 ? "<0.001" : m.pAdjusted.toFixed(3)) : "—";
          return [`${m.name}${m.better === "higher" ? " ↑" : ""}`, fmt(m.a.median, m.unit), fmt(m.b.median, m.unit), `${fmt(m.delta.median, m.unit, true)}${rel}`, ci, p, verdictCell(m)];
        }),
        { color },
      ),
    );
  }
  out.push("");
  const s = r.summary;
  const tally = `${s.better} better · ${s.worse} worse${s.same ? ` · ${s.same} same` : ""} · ${s.inconclusive} inconclusive`;
  out.push(`verdict: ${s.worse ? paint(tally, "red", color) : s.better ? paint(tally, "green", color) : paint(tally, "bold", color)}`);
  for (const n of r.notes) out.push(paint(`note: ${n}`, "dim", color));
  const failed = r.runs.filter((x) => x.error !== undefined);
  for (const f of failed.slice(0, opts.limit ?? 5)) out.push(paint(`failed: pair ${f.pair} ${r.arms[f.arm].name}: ${f.error}`, "yellow", color));
  return out.join("\n");
}
