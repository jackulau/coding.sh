// What an alert measures, over its window, with the engine behind `coding.sh stats`
// (viewer/metrics.ts): the same session rows (top-level sessions, each with its
// subagents' spend rolled in), the same failure definition and the same cost sums.
import type { IndexStore, MetricRow } from "../core/types.ts";
import { parseWhere } from "../query/where.ts";
import { loadMetricRows, totalsOf } from "../viewer/metrics.ts";
import { ALERT_WINDOWS, type AlertDef } from "./store.ts";

export const ALERT_MEASURES = ["failure-rate", "cost", "sessions"] as const;
export type AlertMeasure = { kind: (typeof ALERT_MEASURES)[number] } | { kind: "flag"; flag: string };

/** failure-rate, cost, sessions or flag:<flag>; undefined for anything else. */
export function parseMeasure(s: string): AlertMeasure | undefined {
  if ((ALERT_MEASURES as readonly string[]).includes(s)) return { kind: s as (typeof ALERT_MEASURES)[number] };
  const m = /^flag:(.+)$/.exec(s);
  return m && m[1]!.trim() ? { kind: "flag", flag: m[1]!.trim() } : undefined;
}

/**
 * The measure over a set of sessions; null when there is nothing to measure: no
 * sessions, or (cost) no session with a price.
 */
export function measureRows(m: AlertMeasure, rows: readonly MetricRow[]): number | null {
  if (!rows.length) return null;
  if (m.kind === "flag") return rows.filter((r) => r.flags.includes(m.flag)).length;
  const t = totalsOf(rows);
  if (m.kind === "failure-rate") return t.failureRate ?? null;
  if (m.kind === "cost") return t.pricedSessions ? t.costUsd : null;
  return t.sessions;
}

export interface Reading {
  /** By group: "" for the whole window, else the agent. A group with no sessions is absent (with by: agent) or null. */
  values: Map<string, number | null>;
  truncated?: boolean;
}

/** The alert's measure over the sessions that started in [now - window, now). */
export async function readMeasure(index: IndexStore, def: AlertDef, now = Date.now()): Promise<Reading> {
  const m = parseMeasure(def.measure);
  if (!m) throw new Error(`unknown measure ${JSON.stringify(def.measure)}`);
  const since = now - ALERT_WINDOWS[def.window];
  const where = def.where ? parseWhere(def.where) : undefined;
  const query: Parameters<typeof loadMetricRows>[1] = { since, until: now, filter: { parentSessionId: null } };
  if (where) query.where = where;
  const loaded = await loadMetricRows(index, query);
  const rows = loaded.rows.filter((r) => r.startedAt >= since && r.startedAt < now);
  const values = new Map<string, number | null>();
  if (def.by === "agent") {
    const groups = new Map<string, MetricRow[]>();
    for (const r of rows) (groups.get(r.agent) ?? groups.set(r.agent, []).get(r.agent)!).push(r);
    for (const [k, rs] of groups) values.set(k, measureRows(m, rs));
  } else values.set("", measureRows(m, rows));
  return loaded.truncated ? { values, truncated: true } : { values };
}
