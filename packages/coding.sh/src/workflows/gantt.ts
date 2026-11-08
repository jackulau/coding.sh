// Gantt data for the viewer route /workflows/:runId and the TSV fallback
// (`workflows show --gantt`), docs/design/workflows.md §8.
import { criticalPath, timedAgents } from "./critical-path.ts";
import { barrierIdle, concurrencySeries, isAgentNode, phasesByStart } from "./metrics.ts";
import type { GanttData, GanttRow, WorkflowNode, WorkflowRun } from "./types.ts";

/** Row label: a durable step that ran more than once gets its attempt number ("search #2"). */
const labelOf = (n: WorkflowNode): string => (n.attempt !== undefined && (n.attempts ?? 1) > 1 ? `${n.name} #${n.attempt}` : n.name);

export function buildGantt(run: WorkflowRun, nodes: WorkflowNode[]): GanttData {
  const byStart = (a: WorkflowNode, b: WorkflowNode) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
  // Durable runs: sleeps and waits get rows of their own, everything in time order.
  const rowsOf = nodes.filter((n) => isAgentNode(n) || n.kind === "wait");
  const durable = rowsOf.some((n) => n.kind === "wait" || n.attempt !== undefined);
  rowsOf.sort(durable ? (a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) : byStart);
  const critical = new Set(run.stats?.criticalPath ?? criticalPath(nodes).path);
  const idle = barrierIdle(nodes);
  const order = phasesByStart(rowsOf, run.phases);
  const phases: GanttData["phases"] = [];
  for (const p of order) {
    const rows: GanttRow[] = [];
    for (const a of rowsOf) {
      if ((a.phase ?? "") !== p) continue;
      // Cached agents did not run in this run: a zero-width bar at run start.
      const start = a.startedAt ?? run.startedAt;
      const row: GanttRow = { nodeId: a.id, label: labelOf(a), start, status: a.status, critical: critical.has(a.id) };
      if (a.endedAt !== undefined) row.end = a.endedAt;
      else if (a.status === "cached") row.end = start;
      const i = idle.get(a.id);
      if (i !== undefined && i > 0) row.idleAfterMs = i;
      if (a.sessionId) row.sessionId = a.sessionId;
      if (a.usage?.costUsd !== undefined) row.costUsd = a.usage.costUsd;
      if (a.kind === "wait") row.wait = true;
      if (a.lost) row.lost = true;
      if (a.attempt !== undefined) row.attempt = a.attempt;
      if (a.attempts !== undefined) row.attempts = a.attempts;
      if (a.resume) row.resume = a.resume;
      rows.push(row);
    }
    if (rows.length) phases.push({ name: p, rows });
  }
  const g: GanttData = {
    runId: run.id,
    startedAt: run.startedAt,
    phases,
    concurrency: concurrencySeries(timedAgents(nodes).map((a) => ({ start: a.startedAt, end: a.endedAt }))),
  };
  if (run.endedAt !== undefined) g.endedAt = run.endedAt;
  if (run.concurrencyCap !== undefined) g.cap = run.concurrencyCap;
  return g;
}

/**
 * Tab-separated timeline: one row per agent, offsets in ms from run start.
 * Durable runs add a row per wait and two columns: kind (attempt | lost | wait) and resume.
 */
export function ganttTsv(g: GanttData): string {
  const durable = g.phases.some((p) => p.rows.some((r) => r.wait || r.attempt !== undefined));
  const head = ["phase", "label", "status", "start_ms", "end_ms", "duration_ms", "critical", "idle_after_ms", "cost_usd", "session"];
  const lines = [(durable ? [...head, "kind", "resume"] : head).join("\t")];
  const clean = (x: string) => x.replace(/[\t\r\n]+/g, " ");
  const ms = (x: number) => String(Math.round(x));
  for (const p of g.phases) {
    for (const r of p.rows) {
      lines.push(
        [
          clean(p.name),
          clean(r.label),
          r.status,
          ms(r.start - g.startedAt),
          r.end !== undefined ? ms(r.end - g.startedAt) : "",
          r.end !== undefined ? ms(r.end - r.start) : "",
          r.critical ? "yes" : "",
          r.idleAfterMs !== undefined ? ms(r.idleAfterMs) : "",
          r.costUsd !== undefined ? r.costUsd.toFixed(4) : "",
          r.sessionId ?? "",
          ...(durable ? [r.wait ? "wait" : r.lost ? "lost" : r.attempt !== undefined ? "attempt" : "", r.resume ?? ""] : []),
        ].join("\t"),
      );
    }
  }
  return lines.join("\n") + "\n";
}
