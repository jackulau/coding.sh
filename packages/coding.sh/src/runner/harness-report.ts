// The harness A/B report from stored runs: the captured sessions and events of
// each run, the one-item gate's exposure when B adds or removes one item, then
// compare(). Shared by `coding.sh compare` and the MCP harness_compare tool.
import { harnessItem, itemExposure, type ExposureState } from "../core/exposure.ts";
import type { BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult } from "../core/types.ts";
import { diffBundles, instructionSurface } from "./bundle.ts";
import { auditStatuses, taskAudit, type AuditReport } from "../eval/witness.ts";
import { compare, loadRunEvents, loadRunSessions, type CompareOpts, type CompareReport, type RunAuditStatus } from "./experiment.ts";
import { singleItemChange } from "./gate-item.ts";
import { runRelease } from "./release.ts";

export type ItemChange = { mode: "add" | "remove"; path: string };

/** B is A plus (or minus) exactly one instruction item, and nothing else differs. */
export function bundleItemChange(A: HarnessBundle, B: HarnessBundle): ItemChange | undefined {
  const d = diffBundles(A, B);
  const other =
    !!d.agent || !!d.model || !!d.flags || !!d.plugins || d.files.changed.length > 0 || d.env.added.length + d.env.removed.length + d.env.changed.length > 0 || d.remove.added.length + d.remove.removed.length > 0;
  return singleItemChange(d.files, other);
}

/**
 * Why `prefix` can't group these tasks (no task has a tag starting with it),
 * listing the prefixes they do have; undefined when it can.
 */
export function tagPrefixProblem(tasks: readonly Pick<EvalTask, "tags">[], prefix: string): string | undefined {
  if (tasks.some((t) => t.tags.some((g) => g.startsWith(prefix)))) return undefined;
  const seen = [...new Set(tasks.flatMap((t) => t.tags.map((g) => (g.includes(":") ? g.slice(0, g.indexOf(":") + 1) : g))))].sort();
  return `no task has a tag starting with it; ${seen.length ? `prefixes seen: ${seen.join(", ")}` : "the tasks have no tags"}`;
}

export type HarnessReportOpts = Omit<CompareOpts, "baseline" | "candidate" | "sessions" | "events" | "bundles" | "itemGate" | "surfaces"> & {
  /** The one item B adds or removes; the report then carries the one-item gate. */
  change?: ItemChange;
};

/** compare() over stored runs of bundles A and B, with sessions, events and the one-item gate filled in. */
export async function harnessReport(stores: { index: IndexStore; blobs: BlobStore }, A: HarnessBundle, B: HarnessBundle, results: readonly RunResult[], o: HarnessReportOpts = {}): Promise<CompareReport> {
  const { change, ...rest } = o;
  const sessions = await loadRunSessions(stores.index, results);
  const events = await loadRunEvents(stores.index, sessions);
  let itemGate: CompareOpts["itemGate"];
  if (change) {
    const holder = change.mode === "add" ? B : A;
    const ref = holder.files[change.path];
    const item = harnessItem(change.path, (ref && (await stores.blobs.getText(ref))) ?? "");
    if (item) {
      const exposure = new Map<string, ExposureState>();
      for (const r of results) {
        if (r.bundleId !== holder.id) continue;
        const s = sessions.get(r.id);
        exposure.set(r.id, s ? itemExposure(item, events.get(r.id) ?? [], { cwd: s.cwd }).state : "unknown");
      }
      const agentVersions = new Map(results.map((r) => [r.id, runRelease(r, sessions.get(r.id))]));
      itemGate = { mode: change.mode, exposure, agentVersions, item: { path: item.path, kind: item.kind, tier: item.tier } };
    }
  }
  const audit = await loadRunAudits(stores.index, results);
  const surfaces = { baseline: await instructionSurface(A, stores.blobs), candidate: await instructionSurface(B, stores.blobs) };
  return compare(results, {
    ...rest,
    baseline: A.id,
    candidate: B.id,
    sessions,
    events,
    bundles: { baseline: A, candidate: B },
    surfaces,
    ...(itemGate ? { itemGate } : {}),
    ...(audit.size ? { audit, auditMethod: "manual" as const } : {}),
  });
}

/** Witness-audit outcome per run, from each task's `meta.audits[<the run's experiment>]` (`eval audit`). */
export async function loadRunAudits(index: IndexStore, results: readonly RunResult[]): Promise<Map<string, RunAuditStatus>> {
  const reports: AuditReport[] = [];
  const byTask = new Map<string, Set<string>>();
  for (const r of results) if (r.experimentId) byTask.set(r.taskId, (byTask.get(r.taskId) ?? new Set()).add(r.experimentId));
  for (const [taskId, exps] of byTask) {
    const task = await index.getTask(taskId);
    if (!task?.meta?.audits) continue;
    for (const e of exps) {
      const rep = taskAudit(task, e);
      if (rep) reports.push(rep);
    }
  }
  return auditStatuses(reports);
}
