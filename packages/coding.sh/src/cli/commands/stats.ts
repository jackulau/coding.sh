// coding.sh stats [--measure M] [--by agent|model|repo|flag] [--per day|week] [--since 30d] [--until ...] [--where q] [--all] [--json]
//
// Time-bucketed metrics (src/viewer/metrics.ts, the same engine as GET
// /api/metrics and the viewer's Metrics page). Without --by: one row per day
// or week. With --by: one row per group with its totals and a trend of the
// chosen measure. --json prints the MetricSeries document.
import { computeMetrics, MAX_BUCKETS, METRIC_MEASURES, MetricsError, measureAt, measureOf, type MetricBucket, type MetricGroup, type MetricLine, type MetricMeasure, type MetricTotals } from "../../viewer/metrics.ts";
import { parseSinceWhen, UsageError } from "../args.ts";
import { autoIngest, pendingField, queryCliError, readIngest, str, timeWindow, whereFlag, windowJson, windowNote, withContext } from "../common.ts";
import { noSessionsNext } from "../first-session.ts";
import { duration, plural, tokens, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

const BARS = "▁▂▃▄▅▆▇█";

/** A MetricsError in this command's flags (the engine's text names /api/metrics parameters). */
function metricsErrorText(e: MetricsError): string {
  if (e.tooManyBuckets === "day") return `the range needs more than ${MAX_BUCKETS} days: use --per week, or a shorter --since/--until`;
  if (e.tooManyBuckets === "week") return `the range needs more than ${MAX_BUCKETS} weeks: use a shorter --since/--until`;
  return e.message;
}

/** A one-line trend; blank cells for buckets with nothing to show. */
export function sparkline(vals: readonly (number | null)[]): string {
  const nums = vals.filter((v): v is number => v !== null);
  const max = Math.max(0, ...nums);
  return vals.map((v) => (v === null ? " " : max <= 0 ? BARS[0] : BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))])).join("");
}

const pct = (x: number | undefined | null): string => (x === undefined || x === null ? "-" : `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%`);
const ms = (x: number | undefined | null): string => (x === undefined || x === null ? "-" : duration(x));

/** A measure as a table cell. */
function cell(m: MetricMeasure, v: number | null): string {
  if (v === null) return "-";
  if (m === "cost") return usd(v);
  if (m === "tokens") return tokens(v);
  if (m === "failure-rate" || m === "tool-error-rate") return pct(v);
  if (m === "llm-p95" || m === "ttft-p50") return ms(v);
  return String(v);
}

const header = ["SESSIONS", "FAIL%", "COST", "TOKENS", "TOOLS", "TOOL ERR%", "P95 LLM", "TTFT"];
const totalsCells = (t: MetricTotals): string[] => [
  String(t.sessions),
  pct(t.failureRate),
  t.pricedSessions ? `${t.estimatedCostUsd ? "~" : ""}${usd(t.costUsd)}` : "-",
  tokens(t.tokens),
  String(t.toolCalls),
  pct(t.toolErrorRate),
  ms(t.llmP95Ms),
  ms(t.ttftP50Ms),
];

function bucketLabel(t: number, per: MetricBucket): string {
  const d = new Date(t);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return per === "week" ? `wk ${ymd}` : ymd;
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const measure = (str(c.flags.measure) ?? "sessions") as MetricMeasure;
  if (!(METRIC_MEASURES as readonly string[]).includes(measure)) throw new UsageError(`--measure must be one of ${METRIC_MEASURES.join(", ")}`, { reason: "invalid_argument" });
  const by = str(c.flags.by) as MetricGroup | undefined;
  const per = (str(c.flags.per) ?? "day") as MetricBucket;
  const now = Date.now();
  const untilWhen = str(c.flags.until) !== undefined ? parseSinceWhen(str(c.flags.until)!, now, "until") : { ms: now, zoned: false };
  const sinceWhen = parseSinceWhen(str(c.flags.since) ?? "30d", now);
  const until = untilWhen.ms;
  const since = sinceWhen.ms;
  if (!(since < until)) throw new UsageError("--since must be before --until", { reason: "invalid_argument" });
  const where = whereFlag(c);
  const window = timeWindow({ since: sinceWhen, until: untilWhen }, where);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    let m;
    try {
      m = await computeMetrics(ctx.index, {
        since,
        until,
        bucket: per,
        ...(by ? { by } : {}),
        tzOffsetMin: new Date(now).getTimezoneOffset(),
        ...(where ? { where } : {}),
        filter: c.flags.all === true ? {} : { parentSessionId: null },
      });
    } catch (e) {
      if (e instanceof MetricsError) throw new UsageError(metricsErrorText(e), { reason: e.reason });
      throw queryCliError(e);
    }
    if (out.json) {
      out.data({ ...m, window: windowJson(window), measure, ...pendingField(backlog) });
      return 0;
    }
    windowNote(out, window);
    if (!m.totals.sessions) {
      out.note(`No sessions from ${bucketLabel(m.since, "day")} to ${bucketLabel(until, "day")}${where ? " matching the query" : ""}`);
      if (!(await ctx.index.listSessions({ limit: 1 })).length) {
        // An empty store, not just an empty window: say how the first session gets here.
        const n = noSessionsNext(c.env);
        out.next(n.label, n.command);
      } else if (where) out.next("Drop --where to see every session in the window, or widen it", "coding.sh stats --since 90d --per week");
      else out.next("Widen the window", "coding.sh stats --since 90d --per week");
      return 0;
    }
    const trend = (line: MetricLine) => sparkline(m.buckets.map((_, i) => measureAt(line, measure, i)));
    if (by) {
      out.table([by.toUpperCase(), ...header, `${measure.toUpperCase()} PER ${per.toUpperCase()}`], [
        ...m.series.map((s) => [s.key, ...totalsCells(s.totals), trend(s)]),
        ["total", ...totalsCells(m.totals), trend(m.all)],
      ]);
      if (by === "flag") out.note("A session with several flags counts in each row; the total counts it once.");
    } else {
      // Newest first, like every list in the CLI; empty buckets stay so gaps show.
      const rows = m.buckets.map((t, i) => {
        const day = m.all;
        const one = (k: MetricMeasure) => cell(k, measureAt(day, k, i));
        return [bucketLabel(t, per), one("sessions"), one("failure-rate"), day.costUsd[i] ? usd(day.costUsd[i]) : "-", one("tokens"), one("tool-calls"), one("tool-error-rate"), one("llm-p95"), one("ttft-p50")];
      });
      out.table([per.toUpperCase(), ...header], [...rows.reverse(), ["total", ...totalsCells(m.totals)]]);
      out.note(`${measure}: ${trend(m.all)}  ${cell(measure, measureOf(m.totals, measure))} in all`);
    }
    if (m.totals.pricedSessions && m.totals.pricedSessions < m.totals.sessions) out.note(`COST covers the ${m.totals.pricedSessions} of ${plural(m.totals.sessions, "session")} with a price.`);
    if (m.truncated) out.warn("Stopped after 100,000 sessions: narrow --since or --where.");
    return 0;
  }, { create: false });
}
