// Workflow runs behind the viewer (docs/design/workflows.md §8):
//
//   GET /api/workflows[?limit=&name=&framework=]  → { runs: RunSummary[] }   (as `workflows list --json`)
//   GET /api/workflows/:runId                       → { run, nodes }           (as `workflows show --json`)
//   GET /api/workflows/:runId/gantt                 → GanttData                (as `workflows show --gantt --json`)
//
// The viewer renders these documents and computes nothing: the CLI and the page show the same
// numbers. The page lives at #/workflows/:runId in src/viewer/ui/index.html.
import { buildGantt } from "./gantt.ts";
import { totalTokens } from "./metrics.ts";
import type { GanttData, WorkflowFramework, WorkflowNode, WorkflowRun } from "./types.ts";

/** Where the viewer reads workflow runs from (WorkflowStore fits). */
export interface WorkflowViewSource {
  listRuns(f: { framework?: WorkflowFramework; name?: string; limit?: number }): Promise<WorkflowRun[]>;
  getRun(id: string): Promise<{ run: WorkflowRun; nodes: WorkflowNode[] } | undefined>;
}

/** One run as `workflows list --json` and /api/workflows print it. */
export function runSummary(run: WorkflowRun): Record<string, unknown> {
  return {
    id: run.id,
    framework: run.framework,
    name: run.name,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt !== undefined ? new Date(run.endedAt).toISOString() : null,
    wallMs: run.stats.wallMs ?? (run.endedAt !== undefined ? run.endedAt - run.startedAt : null),
    agents: run.stats.agents,
    costUsd: run.stats.costUsd ?? null,
    tokens: totalTokens(run.stats.tokens),
    variant: run.variant ?? null,
    experimentId: run.experimentId ?? null,
    caseId: run.caseId ?? null,
    resumedFrom: run.resumedFrom ?? null,
    hostSessionId: run.hostSessionId ?? null,
    tags: run.tags,
  };
}

/** Node kinds `workflows show` leaves out without --tree. */
export const DETAIL_KINDS = new Set<WorkflowNode["kind"]>(["subagent", "tool", "llm"]);

export class WorkflowApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const FRAMEWORK_RE = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Answers one /api/workflows request. `id` and `sub` are the decoded path parts after
 * /api/workflows. Throws WorkflowApiError (404 for an unknown run or path, 400 for a bad query).
 */
export async function workflowsApi(src: WorkflowViewSource, id: string | undefined, sub: string | undefined, q: URLSearchParams): Promise<{ runs: Record<string, unknown>[] } | { run: Record<string, unknown>; nodes: WorkflowNode[] } | GanttData> {
  if (id === undefined || id === "") {
    if (sub !== undefined) throw new WorkflowApiError(404, "not found");
    const raw = q.get("limit");
    const limit = raw === null ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new WorkflowApiError(400, "limit must be an integer from 1 to 500");
    const framework = q.get("framework") || undefined;
    if (framework !== undefined && !FRAMEWORK_RE.test(framework)) throw new WorkflowApiError(400, "bad framework");
    const name = q.get("name") || undefined;
    const runs = await src.listRuns({ limit, ...(framework ? { framework: framework as WorkflowFramework } : {}), ...(name ? { name } : {}) });
    return { runs: runs.map(runSummary) };
  }
  if (sub !== undefined && sub !== "gantt") throw new WorkflowApiError(404, "not found");
  if (id.length > 256 || /[\u0000-\u001f]/.test(id)) throw new WorkflowApiError(400, "bad run id");
  const got = await src.getRun(id);
  if (!got) throw new WorkflowApiError(404, `no workflow run ${JSON.stringify(id)}`);
  if (sub === "gantt") return buildGantt(got.run, got.nodes);
  return { run: { ...runSummary(got.run), stats: got.run.stats, ...(got.run.concurrencyCap !== undefined ? { concurrencyCap: got.run.concurrencyCap } : {}) }, nodes: got.nodes.filter((n) => !DETAIL_KINDS.has(n.kind)) };
}
