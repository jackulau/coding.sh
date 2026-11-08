// Critical path over a workflow's agent nodes (docs/design/workflows.md §4).
//
// Exact: when the source gives explicit dependencies (node.deps, pipeline
// item chains, or journal-recorded group structure), the path is the longest
// duration-weighted path in that DAG.
// Approximate otherwise: start from the agent that ended last, repeatedly step
// to the agent that ended latest at or before the current one started, stop
// when none exists.
//
// In both cases `ms` is the span from the path's first start to its last end,
// so it is comparable to wallMs, and `gaps` are the stretches between
// consecutive path nodes where no node of the path runs. A gap that a durable
// sleep or wait covers (wait nodes) says so in `waitMs`: the run was told to
// wait there, so that part is not orchestration overhead. Neither is the
// downtime after a lost durable attempt's process was last seen (`lostMs`).
import type { WorkflowNode } from "./types.ts";

export interface CriticalPath {
  path: string[];
  ms: number;
  exact: boolean;
  gaps: { after: string; ms: number; waitMs?: number; lostMs?: number; pausedMs?: number }[];
}

/** Agent-like nodes that occupy a slot: agent and step (cached nodes did not run). */
export function timedAgents(nodes: readonly WorkflowNode[]): (WorkflowNode & { startedAt: number; endedAt: number })[] {
  return nodes.filter(
    (n): n is WorkflowNode & { startedAt: number; endedAt: number } =>
      (n.kind === "agent" || n.kind === "step") && n.status !== "cached" && typeof n.startedAt === "number" && typeof n.endedAt === "number",
  );
}

const dur = (n: { startedAt: number; endedAt: number }) => Math.max(0, n.endedAt - n.startedAt);

/**
 * Explicit DAG edges, or undefined when the nodes do not carry enough
 * structure for an exact answer. Structure counts as explicit when every
 * timed agent has deps, or a non-inferred group (parallel/pipeline), or the
 * run as a whole has deps on at least one node and the rest are sequential
 * by ordinal.
 */
export function explicitEdges(agents: readonly (WorkflowNode & { startedAt: number; endedAt: number })[]): Map<string, string[]> | undefined {
  if (!agents.length) return undefined;
  const ids = new Set(agents.map((a) => a.id));
  const anyDeps = agents.some((a) => a.deps !== undefined);
  const allGrouped = agents.every((a) => a.deps !== undefined || (a.groupId !== undefined && a.groupKind !== undefined && a.groupKind !== "inferred") || a.ordinal !== undefined);
  const anyExplicitGroup = agents.some((a) => a.groupKind === "parallel" || a.groupKind === "pipeline");
  if (!anyDeps && !anyExplicitGroup) return undefined;
  if (!allGrouped) return undefined;
  if (agents.some((a) => a.groupKind === "inferred")) return undefined;

  const edges = new Map<string, string[]>();
  for (const a of agents) edges.set(a.id, a.deps ? a.deps.filter((d) => ids.has(d)) : []);
  if (anyDeps && agents.every((a) => a.deps !== undefined)) return edges;

  // Atoms in call order: a standalone agent, a parallel group, or a pipeline.
  // Each atom waits for the previous one (the script awaits it); inside a
  // pipeline, item i's stage s waits for item i's stage s − 1 only.
  type Atom = { key: string; members: (WorkflowNode & { startedAt: number; endedAt: number })[]; kind: "single" | "parallel" | "pipeline" };
  const atoms: Atom[] = [];
  const byKey = new Map<string, Atom>();
  const ordered = [...agents].sort((x, y) => (x.ordinal ?? Infinity) - (y.ordinal ?? Infinity) || x.startedAt - y.startedAt);
  for (const a of ordered) {
    if (a.deps !== undefined) continue;
    const key = a.groupId ?? `single:${a.id}`;
    let atom = byKey.get(key);
    if (!atom) {
      atom = { key, members: [], kind: a.groupId ? (a.groupKind === "pipeline" ? "pipeline" : "parallel") : "single" };
      byKey.set(key, atom);
      atoms.push(atom);
    }
    atom.members.push(a);
  }
  const sinks = (atom: Atom): string[] => {
    if (atom.kind !== "pipeline") return atom.members.map((m) => m.id);
    // Last stage of each item.
    const last = new Map<number | string, WorkflowNode>();
    for (const m of atom.members) {
      const k = m.item ?? m.id;
      const prev = last.get(k);
      if (!prev || (m.stage ?? 0) >= (prev.stage ?? 0)) last.set(k, m);
    }
    return [...last.values()].map((m) => m.id);
  };
  let prevSinks: string[] = [];
  for (const atom of atoms) {
    if (atom.kind === "pipeline") {
      const chains = new Map<number | string, (WorkflowNode & { startedAt: number; endedAt: number })[]>();
      for (const m of atom.members) {
        const k = m.item ?? m.id;
        chains.set(k, [...(chains.get(k) ?? []), m]);
      }
      for (const chain of chains.values()) {
        chain.sort((x, y) => (x.stage ?? 0) - (y.stage ?? 0) || (x.ordinal ?? 0) - (y.ordinal ?? 0));
        chain.forEach((m, i) => edges.set(m.id, i === 0 ? [...prevSinks] : [chain[i - 1]!.id]));
      }
    } else {
      for (const m of atom.members) edges.set(m.id, [...prevSinks]);
    }
    prevSinks = sinks(atom);
  }
  return edges;
}

/** Durable sleeps and waits as [start, end) intervals. */
export function waitIntervals(nodes: readonly WorkflowNode[]): [number, number][] {
  return nodes.filter((n) => n.kind === "wait" && n.startedAt !== undefined && n.endedAt !== undefined).map((n) => [n.startedAt!, n.endedAt!]);
}

/** Downtime after lost durable attempts (their process stopped) as [start, end) intervals. */
export function lostIntervals(nodes: readonly WorkflowNode[]): [number, number][] {
  return nodes.filter((n) => n.lostMs !== undefined && n.endedAt !== undefined).map((n) => [n.endedAt!, n.endedAt! + n.lostMs!]);
}

/** How much of [a, b) the intervals cover (overlaps counted once). */
export function coveredMs(a: number, b: number, intervals: readonly [number, number][]): number {
  const xs = intervals.map(([s, e]) => [Math.max(a, s), Math.min(b, e)] as [number, number]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of xs) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
}

function withGaps(
  path: (WorkflowNode & { startedAt: number; endedAt: number })[],
  exact: boolean,
  waits: readonly [number, number][] = [],
  lost: readonly [number, number][] = [],
  paused: readonly [number, number][] = [],
): CriticalPath {
  if (!path.length) return { path: [], ms: 0, exact, gaps: [] };
  const gaps: CriticalPath["gaps"] = [];
  for (let i = 1; i < path.length; i++) {
    const g = path[i]!.startedAt - path[i - 1]!.endedAt;
    if (!(g > 0)) continue;
    const gap: CriticalPath["gaps"][number] = { after: path[i - 1]!.id, ms: g };
    const w = waits.length ? coveredMs(path[i - 1]!.endedAt, path[i]!.startedAt, waits) : 0;
    if (w > 0) gap.waitMs = w;
    const l = lost.length ? coveredMs(path[i - 1]!.endedAt, path[i]!.startedAt, lost) : 0;
    if (l > 0) gap.lostMs = l;
    const p = paused.length ? coveredMs(path[i - 1]!.endedAt, path[i]!.startedAt, paused) : 0;
    if (p > 0) gap.pausedMs = p;
    gaps.push(gap);
  }
  const start = path[0]!.startedAt;
  const end = Math.max(...path.map((p) => p.endedAt));
  return { path: path.map((p) => p.id), ms: Math.max(0, end - start), exact, gaps };
}

/** Exact longest path when edges are given; returns undefined on a cycle. */
export function longestPath(
  agents: readonly (WorkflowNode & { startedAt: number; endedAt: number })[],
  edges: Map<string, string[]>,
): (WorkflowNode & { startedAt: number; endedAt: number })[] | undefined {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const best = new Map<string, { w: number; prev?: string }>();
  const state = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (id: string): number => {
    const s = state.get(id);
    if (s === 2) return best.get(id)!.w;
    if (s === 1) {
      cyclic = true;
      return 0;
    }
    state.set(id, 1);
    const n = byId.get(id)!;
    let w = 0;
    let prev: string | undefined;
    for (const d of edges.get(id) ?? []) {
      if (!byId.has(d)) continue;
      const dw = visit(d);
      // Ties go to the dependency that ended later (it is the one actually waited on).
      if (dw > w || (dw === w && prev !== undefined && byId.get(d)!.endedAt > byId.get(prev)!.endedAt)) {
        w = dw;
        prev = d;
      }
    }
    best.set(id, { w: w + dur(n), prev });
    state.set(id, 2);
    return w + dur(n);
  };
  let top: string | undefined;
  let topW = -1;
  for (const a of agents) {
    const w = visit(a.id);
    if (w > topW || (w === topW && top !== undefined && a.endedAt > byId.get(top)!.endedAt)) {
      topW = w;
      top = a.id;
    }
  }
  if (cyclic || top === undefined) return undefined;
  const path: (WorkflowNode & { startedAt: number; endedAt: number })[] = [];
  for (let cur: string | undefined = top; cur !== undefined; cur = best.get(cur)?.prev) path.unshift(byId.get(cur)!);
  return path;
}

/** Approximation from timing alone. */
export function approximatePath(agents: readonly (WorkflowNode & { startedAt: number; endedAt: number })[]): (WorkflowNode & { startedAt: number; endedAt: number })[] {
  if (!agents.length) return [];
  const byEnd = [...agents].sort((a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const path = [byEnd[0]!];
  const used = new Set([byEnd[0]!.id]);
  for (;;) {
    const cur = path[0]!;
    const prev = byEnd.find((a) => !used.has(a.id) && a.endedAt <= cur.startedAt);
    if (!prev) break;
    path.unshift(prev);
    used.add(prev.id);
  }
  return path;
}

/**
 * `paused`: stretches the run was not running at all (between the segments of a resumed run);
 * a gap they cover says so in `pausedMs`.
 */
export function criticalPath(nodes: WorkflowNode[], paused: readonly [number, number][] = []): CriticalPath {
  // A stopped agent (cancelled, superseded) never returned, so nothing waited on its end.
  const agents = timedAgents(nodes).filter((a) => a.status !== "cancelled" && a.status !== "superseded");
  const waits = waitIntervals(nodes);
  const lost = lostIntervals(nodes);
  const edges = explicitEdges(agents);
  if (edges) {
    const p = longestPath(agents, edges);
    if (p) return withGaps(p, true, waits, lost, paused);
  }
  return withGaps(approximatePath(agents), false, waits, lost, paused);
}
