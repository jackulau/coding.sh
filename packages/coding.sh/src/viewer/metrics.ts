// Time-bucketed metrics over sessions: sessions, failures, cost, tokens, tool
// calls and errors, model calls and latency, per day or week, split by agent,
// model, repo or flag. One engine behind GET /api/metrics, the viewer's
// Metrics page and `coding.sh stats`.
//
// Both store paths reduce each session to a MetricRow first (SQLite reads only
// those numbers with json_extract; other stores map listSessions rows), and the
// sums happen here, so the two paths agree to the last digit.
import type { IndexStore, MetricRow, SessionFilter } from "../core/types.ts";
import { sessionMatcher } from "../query/run.ts";
import { repoName, type Query } from "../query/where.ts";
import type { Session } from "../schema/index.ts";

export const METRIC_GROUPS = ["agent", "model", "repo", "flag"] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];
export const METRIC_BUCKETS = ["day", "week"] as const;
export type MetricBucket = (typeof METRIC_BUCKETS)[number];

/** Per-bucket measures, in the order `coding.sh stats` lists them. */
export const METRIC_MEASURES = ["sessions", "failures", "failure-rate", "cost", "tokens", "tool-calls", "tool-errors", "tool-error-rate", "llm-calls", "llm-p95", "ttft-p50"] as const;
export type MetricMeasure = (typeof METRIC_MEASURES)[number];

export const DAY_MS = 86_400_000;
/** Most buckets one query returns (a bit over a year of days). */
export const MAX_BUCKETS = 400;
/** Most series a split returns; the rest add up in "other". */
export const MAX_GROUPS = 6;
/** Most sessions the scan fallback reads. */
export const METRICS_SCAN_CAP = 100_000;
export const OTHER = "other";
export const NONE = "(none)";

export class MetricsError extends Error {
  readonly reason = "invalid_params";
  constructor(message: string) {
    super(message);
    this.name = "MetricsError";
  }
}

export interface MetricsSpec {
  /** Start of the range, ms (inclusive). Rounded down to its bucket. */
  since: number;
  /** End of the range, ms (exclusive). */
  until: number;
  bucket: MetricBucket;
  by?: MetricGroup;
  /** Minutes to add to local time to get UTC (Date#getTimezoneOffset): buckets start at local midnight. Default 0 (UTC). */
  tzOffsetMin?: number;
  /** Sessions must match this query too. */
  where?: Query;
  /** project, top-level only (parentSessionId: null), …; since/until come from the spec. */
  filter?: Omit<SessionFilter, "limit" | "offset" | "since" | "until">;
  maxGroups?: number;
}

/** Sums over a set of sessions. Rates and percentiles are absent when there is nothing to divide or rank. */
export interface MetricTotals {
  sessions: number;
  /** Sessions with a failure flag (one with no colon; `flag:x:y` tags are not failures). */
  failures: number;
  failureRate?: number;
  /** Reported or estimated cost of the priced sessions. */
  costUsd: number;
  /** The part of costUsd estimated from list prices. */
  estimatedCostUsd: number;
  pricedSessions: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  toolErrors: number;
  toolErrorRate?: number;
  llmCalls: number;
  llmErrors: number;
  /** 95th percentile of the sessions' own p95 model-call latency. */
  llmP95Ms?: number;
  /** Median of the sessions' own median time to first token. */
  ttftP50Ms?: number;
}

/** One series: a group's value in every bucket (arrays line up with MetricSeries.buckets). */
export interface MetricLine {
  key: string;
  totals: MetricTotals;
  sessions: number[];
  failures: number[];
  costUsd: number[];
  tokens: number[];
  toolCalls: number[];
  toolErrors: number[];
  llmCalls: number[];
  llmP95Ms: (number | null)[];
  ttftP50Ms: (number | null)[];
}

export interface MetricSeries {
  bucket: MetricBucket;
  by: MetricGroup | null;
  since: number;
  until: number;
  tzOffsetMin: number;
  /** Bucket start times, ms. */
  buckets: number[];
  /** Every matching session in the range, whatever its group. */
  totals: MetricTotals;
  /** The whole range per bucket. */
  all: MetricLine;
  /** With `by`: the largest groups by sessions, then "other". A session with several flags counts in each. */
  series: MetricLine[];
  /** The scan fallback stopped at METRICS_SCAN_CAP sessions. */
  truncated?: boolean;
}

// ---------------------------------------------------------------- buckets

/** Start of the bucket holding `t`: local midnight (day) or local Monday midnight (week). */
export function bucketStart(t: number, bucket: MetricBucket, tzOffsetMin = 0): number {
  const off = tzOffsetMin * 60_000;
  const day = Math.floor((t - off) / DAY_MS);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is days since Monday.
  const start = bucket === "week" ? day - (((day + 3) % 7) + 7) % 7 : day;
  return start * DAY_MS + off;
}

function nextBucket(t: number, bucket: MetricBucket, tzOffsetMin: number): number {
  // Whole days in local time; DST is ignored (tzOffsetMin is fixed for the query).
  return bucketStart(t + (bucket === "week" ? 7 : 1) * DAY_MS + DAY_MS / 2, bucket, tzOffsetMin);
}

/** The bucket starts covering [since, until). Throws MetricsError past MAX_BUCKETS. */
export function bucketTimes(since: number, until: number, bucket: MetricBucket, tzOffsetMin = 0): number[] {
  if (!(since < until)) throw new MetricsError("since must be before until");
  const out: number[] = [];
  for (let t = bucketStart(since, bucket, tzOffsetMin); t < until; t = nextBucket(t, bucket, tzOffsetMin)) {
    out.push(t);
    if (out.length > MAX_BUCKETS) throw new MetricsError(`the range needs more than ${MAX_BUCKETS} ${bucket} buckets${bucket === "day" ? "; use bucket=week" : "; narrow since/until"}`);
  }
  return out;
}

// ---------------------------------------------------------------- rows

/** A session as metrics read it: the same fields SqliteIndexStore.metricRows selects. */
export function metricRow(s: Session): MetricRow {
  const m: MetricRow = { startedAt: s.startedAt, agent: s.agent, flags: s.flags ?? [], toolCalls: s.stats.toolCalls ?? 0, toolErrors: s.stats.toolErrors ?? 0 };
  if (s.model !== undefined) m.model = s.model;
  const dir = s.repo?.root ?? s.cwd;
  if (dir !== undefined) m.dir = dir;
  const u = s.stats.usage;
  const put = (k: keyof MetricRow, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) (m as unknown as Record<string, number>)[k] = v;
  };
  put("inputTokens", u?.inputTokens);
  put("outputTokens", u?.outputTokens);
  put("cacheReadTokens", u?.cacheReadTokens);
  put("cacheWriteTokens", u?.cacheWriteTokens);
  put("costUsd", u?.costUsd);
  put("estimatedCostUsd", u?.estimatedCostUsd);
  put("llmCalls", s.stats.latency?.llmCalls);
  put("llmErrors", s.stats.llmErrors?.count);
  put("llmP95Ms", s.stats.latency?.llmP95Ms);
  put("ttftP50Ms", s.stats.latency?.ttftP50Ms);
  return m;
}

/** Every matching session in [since, until) as a MetricRow: the store's own path, else a scan. */
export async function loadMetricRows(index: IndexStore, spec: Pick<MetricsSpec, "since" | "until" | "where" | "filter">, opts: { scan?: boolean } = {}): Promise<{ rows: MetricRow[]; truncated?: boolean }> {
  const filter: Omit<SessionFilter, "limit" | "offset"> = { ...spec.filter, since: spec.since, until: spec.until };
  const q: Query = spec.where ?? {};
  if (index.metricRows && !opts.scan) return { rows: await index.metricRows({ root: q.root }, { filter }) };
  const match = sessionMatcher(index, q.root);
  const rows: MetricRow[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    if (offset >= METRICS_SCAN_CAP) return { rows, truncated: true };
    const batch = await index.listSessions({ ...filter, limit: page, offset });
    for (const s of batch) if (await match(s)) rows.push(metricRow(s));
    if (batch.length < page) return { rows };
  }
}

// ---------------------------------------------------------------- sums

const isFailure = (r: MetricRow): boolean => r.flags.some((f) => !f.includes(":"));
const tokensOf = (r: MetricRow): number => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
/** Sums in a fixed order and rounded, so two paths that list sessions differently agree exactly. */
const round = (x: number, places = 9): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

/** Nearest-rank percentile of `vals` (sorted in place). */
function percentile(vals: number[], p: number): number | undefined {
  if (!vals.length) return undefined;
  vals.sort((a, b) => a - b);
  return vals[Math.max(0, Math.ceil(p * vals.length) - 1)];
}

/** The rows' totals. */
export function totalsOf(rows: readonly MetricRow[]): MetricTotals {
  const t: MetricTotals = {
    sessions: rows.length, failures: 0, costUsd: 0, estimatedCostUsd: 0, pricedSessions: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, toolErrors: 0, llmCalls: 0, llmErrors: 0,
  };
  const p95: number[] = [];
  const ttft: number[] = [];
  for (const r of rows) {
    if (isFailure(r)) t.failures++;
    if (r.costUsd !== undefined) {
      t.costUsd += r.costUsd;
      t.estimatedCostUsd += r.estimatedCostUsd ?? 0;
      t.pricedSessions++;
    }
    t.inputTokens += r.inputTokens ?? 0;
    t.outputTokens += r.outputTokens ?? 0;
    t.cacheReadTokens += r.cacheReadTokens ?? 0;
    t.cacheWriteTokens += r.cacheWriteTokens ?? 0;
    t.toolCalls += r.toolCalls;
    t.toolErrors += r.toolErrors;
    t.llmCalls += r.llmCalls ?? 0;
    t.llmErrors += r.llmErrors ?? 0;
    if (r.llmP95Ms !== undefined) p95.push(r.llmP95Ms);
    if (r.ttftP50Ms !== undefined) ttft.push(r.ttftP50Ms);
  }
  t.tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  t.costUsd = round(t.costUsd);
  t.estimatedCostUsd = round(t.estimatedCostUsd);
  if (t.sessions) t.failureRate = round(t.failures / t.sessions, 6);
  if (t.toolCalls) t.toolErrorRate = round(t.toolErrors / t.toolCalls, 6);
  const lp = percentile(p95, 0.95);
  if (lp !== undefined) t.llmP95Ms = lp;
  const tp = percentile(ttft, 0.5);
  if (tp !== undefined) t.ttftP50Ms = tp;
  return t;
}

function lineOf(key: string, rows: readonly MetricRow[], buckets: readonly number[], spec: Pick<MetricsSpec, "bucket" | "tzOffsetMin">): MetricLine {
  const at = new Map(buckets.map((t, i) => [t, i]));
  const per: MetricRow[][] = buckets.map(() => []);
  for (const r of rows) {
    const i = at.get(bucketStart(r.startedAt, spec.bucket, spec.tzOffsetMin ?? 0));
    if (i !== undefined) per[i]!.push(r);
  }
  const sums = per.map((b) => totalsOf(b));
  return {
    key,
    totals: totalsOf(rows),
    sessions: sums.map((s) => s.sessions),
    failures: sums.map((s) => s.failures),
    costUsd: sums.map((s) => s.costUsd),
    tokens: sums.map((s) => s.tokens),
    toolCalls: sums.map((s) => s.toolCalls),
    toolErrors: sums.map((s) => s.toolErrors),
    llmCalls: sums.map((s) => s.llmCalls),
    llmP95Ms: sums.map((s) => s.llmP95Ms ?? null),
    ttftP50Ms: sums.map((s) => s.ttftP50Ms ?? null),
  };
}

/** The values a row has for a split (several for flags). */
export function groupKeys(r: MetricRow, by: MetricGroup): string[] {
  if (by === "agent") return [r.agent];
  if (by === "model") return [r.model || NONE];
  if (by === "repo") return [repoName(r.dir) || NONE];
  return r.flags.length ? [...new Set(r.flags)] : [NONE];
}

/** A stable order, so sums run the same way whatever order the store listed the sessions in. */
function byStart(a: MetricRow, b: MetricRow): number {
  return a.startedAt - b.startedAt || cmp(a.agent, b.agent) || cmp(a.model ?? "", b.model ?? "") || cmp(a.dir ?? "", b.dir ?? "") || (a.costUsd ?? -1) - (b.costUsd ?? -1) || tokensOf(a) - tokensOf(b);
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** MetricSeries over rows already loaded (the engine behind computeMetrics, also for tests). */
export function metricsOf(rows: readonly MetricRow[], spec: MetricsSpec, buckets = bucketTimes(spec.since, spec.until, spec.bucket, spec.tzOffsetMin ?? 0)): MetricSeries {
  const tz = spec.tzOffsetMin ?? 0;
  const inRange = rows.filter((r) => r.startedAt >= spec.since && r.startedAt < spec.until).sort(byStart);
  const all = lineOf("all", inRange, buckets, spec);
  let series: MetricLine[] = [];
  if (spec.by) {
    const groups = new Map<string, MetricRow[]>();
    for (const r of inRange) for (const k of groupKeys(r, spec.by)) (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]));
    const max = spec.maxGroups ?? MAX_GROUPS;
    const top = ranked.slice(0, ranked.length > max ? max : ranked.length);
    series = top.map(([k, rs]) => lineOf(k, rs, buckets, spec));
    if (ranked.length > max) {
      // "other": each session once, even when several of its flags fell outside the top groups.
      const shown = new Set(top.map(([k]) => k));
      const rest = inRange.filter((r) => groupKeys(r, spec.by!).some((k) => !shown.has(k)));
      series.push(lineOf(OTHER, rest, buckets, spec));
    }
  }
  return { bucket: spec.bucket, by: spec.by ?? null, since: spec.since, until: spec.until, tzOffsetMin: tz, buckets, totals: all.totals, all, series };
}

/** Metrics for the spec from the index (store path when it has one). */
export async function computeMetrics(index: IndexStore, spec: MetricsSpec, opts: { scan?: boolean } = {}): Promise<MetricSeries> {
  const buckets = bucketTimes(spec.since, spec.until, spec.bucket, spec.tzOffsetMin ?? 0);
  // Rows from the first bucket's start: a range that starts mid-day still fills its first day.
  const from = buckets[0]!;
  const { rows, truncated } = await loadMetricRows(index, { ...spec, since: from }, opts);
  const out = metricsOf(rows, { ...spec, since: from }, buckets);
  return truncated ? { ...out, truncated } : out;
}

// ---------------------------------------------------------------- measures

/** One measure of a line in bucket i (null: nothing to rank or divide). */
export function measureAt(line: MetricLine, m: MetricMeasure, i: number): number | null {
  switch (m) {
    case "sessions": return line.sessions[i] ?? 0;
    case "failures": return line.failures[i] ?? 0;
    case "failure-rate": return line.sessions[i] ? round(line.failures[i]! / line.sessions[i]!, 6) : null;
    case "cost": return line.costUsd[i] ?? 0;
    case "tokens": return line.tokens[i] ?? 0;
    case "tool-calls": return line.toolCalls[i] ?? 0;
    case "tool-errors": return line.toolErrors[i] ?? 0;
    case "tool-error-rate": return line.toolCalls[i] ? round(line.toolErrors[i]! / line.toolCalls[i]!, 6) : null;
    case "llm-calls": return line.llmCalls[i] ?? 0;
    case "llm-p95": return line.llmP95Ms[i] ?? null;
    case "ttft-p50": return line.ttftP50Ms[i] ?? null;
  }
}

/** One measure of a set of totals. */
export function measureOf(t: MetricTotals, m: MetricMeasure): number | null {
  switch (m) {
    case "sessions": return t.sessions;
    case "failures": return t.failures;
    case "failure-rate": return t.failureRate ?? null;
    case "cost": return t.costUsd;
    case "tokens": return t.tokens;
    case "tool-calls": return t.toolCalls;
    case "tool-errors": return t.toolErrors;
    case "tool-error-rate": return t.toolErrorRate ?? null;
    case "llm-calls": return t.llmCalls;
    case "llm-p95": return t.llmP95Ms ?? null;
    case "ttft-p50": return t.ttftP50Ms ?? null;
  }
}
