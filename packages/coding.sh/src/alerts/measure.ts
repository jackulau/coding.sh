// What an alert measures, over its window, with the engine behind `coding.sh stats`
// (viewer/metrics.ts): the same session rows (top-level sessions, each with its
// subagents' spend rolled in), the same failure definition and the same cost sums.
// score:<name> is the mean of that score on those sessions (src/scores).
import type { IndexStore, MetricRow } from "../core/types.ts";
import { parseWhere } from "../query/where.ts";
import { scoreNumber } from "../scores/scores.ts";
import { loadMetricRows, totalsOf } from "../viewer/metrics.ts";
import { ALERT_WINDOWS, type AlertDef } from "./store.ts";

export { scoreNumber };

export const ALERT_MEASURES = ["failure-rate", "cost", "sessions"] as const;
export type AlertMeasure = { kind: (typeof ALERT_MEASURES)[number] } | { kind: "flag"; flag: string } | { kind: "score"; name: string };

/** failure-rate, cost, sessions, flag:<flag> or score:<name>; undefined for anything else. */
export function parseMeasure(s: string): AlertMeasure | undefined {
  if ((ALERT_MEASURES as readonly string[]).includes(s)) return { kind: s as (typeof ALERT_MEASURES)[number] };
  const m = /^(flag|score):(.+)$/.exec(s);
  const v = m?.[2]!.trim();
  if (!m || !v) return undefined;
  return m[1] === "flag" ? { kind: "flag", flag: v } : { kind: "score", name: v };
}

/** The mean of the numbers the sessions' scores give; null when none has one. */
export function meanScore(rows: readonly MetricRow[], scores: ReadonlyMap<string, readonly number[]>): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    for (const v of (r.id !== undefined && scores.get(r.id)) || []) {
      sum += v;
      n++;
    }
  }
  return n ? Math.round((sum / n) * 1e6) / 1e6 : null;
}

/**
 * The measure over a set of sessions; null when there is nothing to measure: no
 * sessions, or (cost) no session with a price.
 */
export function measureRows(m: AlertMeasure, rows: readonly MetricRow[], scores: ReadonlyMap<string, readonly number[]> = new Map()): number | null {
  if (!rows.length) return null;
  if (m.kind === "score") return meanScore(rows, scores);
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
  const scores = m.kind === "score" ? await sessionScores(index, m.name, since, rows) : undefined;
  const values = new Map<string, number | null>();
  if (def.by === "agent") {
    const groups = new Map<string, MetricRow[]>();
    for (const r of rows) (groups.get(r.agent) ?? groups.set(r.agent, []).get(r.agent)!).push(r);
    for (const [k, rs] of groups) values.set(k, measureRows(m, rs, scores));
  } else values.set("", measureRows(m, rows, scores));
  return loaded.truncated ? { values, truncated: true } : { values };
}

/**
 * The numbers of the session scores named `name` given since `since` (a session in the
 * window is scored after it starts), by session id, for the rows only.
 */
async function sessionScores(index: IndexStore, name: string, since: number, rows: readonly MetricRow[]): Promise<Map<string, number[]>> {
  if (!index.listScores) throw new Error(`this ${index.kind} store keeps no scores, so score:${name} can't be read`);
  const ids = new Set<string>();
  for (const r of rows) if (r.id !== undefined) ids.add(r.id);
  const out = new Map<string, number[]>();
  if (!ids.size) return out;
  for (const s of await index.listScores({ target: "session", name, since })) {
    const v = scoreNumber(s);
    if (v === undefined || !ids.has(s.targetId)) continue;
    (out.get(s.targetId) ?? out.set(s.targetId, []).get(s.targetId)!).push(v);
  }
  return out;
}
