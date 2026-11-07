// Gantt data for the viewer route /workflows/:runId and the TSV fallback
// (`workflows show --gantt`), docs/design/workflows.md §8.
import { criticalPath, timedAgents } from "./critical-path.ts";
import { barrierIdle, concurrencySeries, isAgentNode } from "./metrics.ts";
import type { GanttData, GanttRow, WorkflowNode, WorkflowRun } from "./types.ts";

export function buildGantt(run: WorkflowRun, nodes: WorkflowNode[]): GanttData {
  const agents = nodes.filter(isAgentNode).sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  const critical = new Set(run.stats?.criticalPath ?? criticalPath(nodes).path);
  const idle = barrierIdle(nodes);
  const order = [...(run.phases ?? [])];
  for (const a of agents) if (!order.includes(a.phase ?? "")) order.push(a.phase ?? "");
  const phases: GanttData["phases"] = [];
  for (const p of order) {
    const rows: GanttRow[] = [];
    for (const a of agents) {
      if ((a.phase ?? "") !== p) continue;
      // Cached agents did not run in this run: a zero-width bar at run start.
      const start = a.startedAt ?? run.startedAt;
      const row: GanttRow = { nodeId: a.id, label: a.name, start, status: a.status, critical: critical.has(a.id) };
      if (a.endedAt !== undefined) row.end = a.endedAt;
      else if (a.status === "cached") row.end = start;
      const i = idle.get(a.id);
      if (i !== undefined && i > 0) row.idleAfterMs = i;
      if (a.sessionId) row.sessionId = a.sessionId;
      if (a.usage?.costUsd !== undefined) row.costUsd = a.usage.costUsd;
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

/** Tab-separated timeline: one row per agent, offsets in ms from run start. */
export function ganttTsv(g: GanttData): string {
  const lines = [["phase", "label", "status", "start_ms", "end_ms", "duration_ms", "critical", "idle_after_ms", "cost_usd", "session"].join("\t")];
  const clean = (x: string) => x.replace(/[\t\r\n]+/g, " ");
  for (const p of g.phases) {
    for (const r of p.rows) {
      lines.push(
        [
          clean(p.name),
          clean(r.label),
          r.status,
          String(r.start - g.startedAt),
          r.end !== undefined ? String(r.end - g.startedAt) : "",
          r.end !== undefined ? String(r.end - r.start) : "",
          r.critical ? "yes" : "",
          r.idleAfterMs !== undefined ? String(r.idleAfterMs) : "",
          r.costUsd !== undefined ? r.costUsd.toFixed(4) : "",
          r.sessionId ?? "",
        ].join("\t"),
      );
    }
  }
  return lines.join("\n") + "\n";
}
