// The harness A/B report from stored runs: the captured sessions and events of
// each run, the one-item gate's exposure when B adds or removes one item, then
// compare(). Shared by `coding.sh compare` and the MCP harness_compare tool.
import { harnessItem, itemExposure, type ExposureState } from "../core/exposure.ts";
import type { BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult } from "../core/types.ts";
import { diffBundles } from "./bundle.ts";
import { compare, loadRunEvents, loadRunSessions, type CompareOpts, type CompareReport } from "./experiment.ts";
import { singleItemChange } from "./gate-item.ts";

export type ItemChange = { mode: "add" | "remove"; path: string };

/** B is A plus (or minus) exactly one instruction item, and nothing else differs. */
export function bundleItemChange(A: HarnessBundle, B: HarnessBundle): ItemChange | undefined {
  const d = diffBundles(A, B);
  const other =
    !!d.agent || !!d.model || !!d.flags || d.files.changed.length > 0 || d.env.added.length + d.env.removed.length + d.env.changed.length > 0 || d.remove.added.length + d.remove.removed.length > 0;
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

export type HarnessReportOpts = Omit<CompareOpts, "baseline" | "candidate" | "sessions" | "events" | "bundles" | "itemGate"> & {
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
      const agentVersions = new Map(results.map((r) => [r.id, sessions.get(r.id)?.agentVersion]));
      itemGate = { mode: change.mode, exposure, agentVersions, item: { path: item.path, kind: item.kind, tier: item.tier } };
    }
  }
  return compare(results, { ...rest, baseline: A.id, candidate: B.id, sessions, events, bundles: { baseline: A, candidate: B }, ...(itemGate ? { itemGate } : {}) });
}
