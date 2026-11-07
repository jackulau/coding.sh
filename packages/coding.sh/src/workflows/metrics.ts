// Workflow metrics (docs/design/workflows.md §4). Pure: nodes in, numbers out.
// Times are ms. "Agents" are nodes of kind agent or step that ran
// (status ≠ cached), unless noted.
import type { AgentEvent, Usage } from "../schema/index.ts";
import { coveredMs, criticalPath, lostIntervals, timedAgents, waitIntervals } from "./critical-path.ts";
import type { AgentMetric, PhaseMetric, WorkflowNode, WorkflowRun, WorkflowStats } from "./types.ts";

const AGENTISH = new Set<WorkflowNode["kind"]>(["agent", "step", "subagent"]);

export const isAgentNode = (n: WorkflowNode): boolean => n.kind === "agent" || n.kind === "step";

/** A durable step attempt that a later attempt of the same step followed. */
export const superseded = (n: WorkflowNode): boolean => n.attempt !== undefined && n.attempts !== undefined && n.attempt < n.attempts;

/** Events stamped at their start (ts + durationMs is their end); the rest are stamped at their end. */
const START_STAMPED = new Set(["llm.call", "span"]);

/** When an event's activity ended: ts + durationMs for start-stamped kinds, ts otherwise. */
export function eventEnd(e: Pick<AgentEvent, "kind" | "ts" | "durationMs">): number {
  return START_STAMPED.has(e.kind) ? e.ts + (e.durationMs ?? 0) : e.ts;
}

/** When an event's activity began: ts − durationMs for end-stamped kinds that carry a duration. */
export function eventStart(e: Pick<AgentEvent, "kind" | "ts" | "durationMs">): number {
  return START_STAMPED.has(e.kind) ? e.ts : e.ts - (e.durationMs ?? 0);
}

export function addUsage(into: Usage, u: Usage | undefined): void {
  if (!u) return;
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) into[k] = (into[k] ?? 0) + v;
  }
}

export function totalTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/**
 * Nodes whose usage is summed for run totals: agent/step/subagent nodes
 * (each carries its own usage, excluding nested subagents), plus llm nodes
 * with no agent-like ancestor. Summing both an agent and its llm children
 * would double count.
 */
export function usageRoots(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasAgentAncestor = (n: WorkflowNode): boolean => {
    const seen = new Set<string>();
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      if (AGENTISH.has(p.kind)) return true;
    }
    return false;
  };
  return nodes.filter((n) => AGENTISH.has(n.kind) || (n.kind === "llm" && !hasAgentAncestor(n)));
}

/** Sweep line over [start, end) intervals: running count after each change point. */
export function concurrencySeries(intervals: readonly { start: number; end: number }[]): { t: number; running: number }[] {
  const pts: [number, number][] = [];
  for (const i of intervals) {
    if (!(i.end > i.start)) continue;
    pts.push([i.start, 1], [i.end, -1]);
  }
  // Ends before starts at the same instant: back-to-back agents never overlap.
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: { t: number; running: number }[] = [];
  let running = 0;
  for (const [t, d] of pts) {
    running += d;
    const last = out[out.length - 1];
    if (last && last.t === t) last.running = running;
    else out.push({ t, running });
  }
  return out;
}

function integrate(series: readonly { t: number; running: number }[]): number {
  let s = 0;
  for (let i = 1; i < series.length; i++) s += series[i - 1]!.running * (series[i]!.t - series[i - 1]!.t);
  return s;
}

/** Groups with barrier semantics: parallel() or an inferred concurrent group. */
function barrierGroups(nodes: readonly WorkflowNode[]): Map<string, (WorkflowNode & { startedAt: number; endedAt: number })[]> {
  const out = new Map<string, (WorkflowNode & { startedAt: number; endedAt: number })[]>();
  for (const a of timedAgents(nodes)) {
    if (!a.groupId || a.groupKind === "pipeline") continue;
    out.set(a.groupId, [...(out.get(a.groupId) ?? []), a]);
  }
  return out;
}

/**
 * Per member of each barrier group followed by later work: max end in the
 * group − the member's end. Keyed by node id.
 */
export function barrierIdle(nodes: readonly WorkflowNode[]): Map<string, number> {
  const agents = timedAgents(nodes);
  const out = new Map<string, number>();
  for (const members of barrierGroups(nodes).values()) {
    if (members.length < 2) continue;
    const maxEnd = Math.max(...members.map((m) => m.endedAt));
    const ids = new Set(members.map((m) => m.id));
    const later = agents.some((a) => !ids.has(a.id) && a.startedAt >= maxEnd);
    if (!later) continue;
    for (const m of members) out.set(m.id, maxEnd - m.endedAt);
  }
  return out;
}

/** List-schedule jobs (in order) on `cap` slots; returns the makespan. */
export function makespan(jobs: readonly number[], cap: number): number {
  const slots = new Array<number>(Math.max(1, Math.min(cap, jobs.length || 1))).fill(0);
  for (const j of jobs) {
    let k = 0;
    for (let i = 1; i < slots.length; i++) if (slots[i]! < slots[k]!) k = i;
    slots[k]! += j;
  }
  return Math.max(0, ...slots);
}

/**
 * For each barrier group whose next group maps items one-to-one (same item
 * indices): the group pair's actual span minus the simulated span had every
 * item run its two-stage chain without the barrier, under the same cap.
 * undefined when no group pair has a known item mapping.
 */
export function pipelineSavings(nodes: readonly WorkflowNode[], cap?: number): number | undefined {
  const groups = [...barrierGroups(nodes).entries()]
    .map(([id, members]) => ({ id, members, start: Math.min(...members.map((m) => m.startedAt)), end: Math.max(...members.map((m) => m.endedAt)) }))
    .filter((g) => g.members.length >= 2)
    .sort((a, b) => a.start - b.start);
  let total: number | undefined;
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i]!;
    const b = groups[i + 1]!;
    if (b.start < a.end) continue;
    const itemsA = new Map(a.members.map((m) => [m.item, m]));
    const itemsB = new Map(b.members.map((m) => [m.item, m]));
    if (a.members.some((m) => m.item === undefined) || b.members.some((m) => m.item === undefined)) continue;
    if (itemsA.size !== a.members.length || itemsB.size !== b.members.length || itemsA.size !== itemsB.size) continue;
    if (![...itemsA.keys()].every((k) => itemsB.has(k))) continue;
    const keys = [...itemsA.keys()].sort((x, y) => (x as number) - (y as number));
    const chains = keys.map((k) => itemsA.get(k)!.endedAt - itemsA.get(k)!.startedAt + (itemsB.get(k)!.endedAt - itemsB.get(k)!.startedAt));
    const simulated = makespan(chains, cap ?? chains.length);
    const actual = b.end - a.start;
    total = (total ?? 0) + Math.max(0, actual - simulated);
  }
  return total;
}

const percentile = (xs: number[], p: number): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * (s[Math.ceil(h)]! - s[lo]!);
};

function agentMetric(n: WorkflowNode, nodes: readonly WorkflowNode[]): AgentMetric {
  // When an agent has llm children (OTel), their durations give the percentiles
  // if the node has no latency stats of its own.
  let lat = n.latency;
  if (!lat?.llmP50Ms) {
    const calls = nodes.filter((c) => c.parentId === n.id && c.kind === "llm" && c.startedAt !== undefined && c.endedAt !== undefined).map((c) => c.endedAt! - c.startedAt!);
    if (calls.length) lat = { ...lat, llmP50Ms: percentile(calls, 0.5), llmP95Ms: percentile(calls, 0.95) };
  }
  const m: AgentMetric = { nodeId: n.id, label: n.name, status: n.status };
  if (n.phase !== undefined) m.phase = n.phase;
  if (n.startedAt !== undefined && n.endedAt !== undefined) m.durationMs = Math.max(0, n.endedAt - n.startedAt);
  if (n.usage) m.tokens = totalTokens(n.usage);
  if (n.usage?.costUsd !== undefined) m.costUsd = n.usage.costUsd;
  if (lat?.llmP50Ms !== undefined) m.llmP50Ms = lat.llmP50Ms;
  if (lat?.llmP95Ms !== undefined) m.llmP95Ms = lat.llmP95Ms;
  if (lat?.ttftP50Ms !== undefined) m.ttftP50Ms = lat.ttftP50Ms;
  if (n.toolCalls !== undefined) m.toolCalls = n.toolCalls;
  if (n.toolErrors !== undefined) m.toolErrors = n.toolErrors;
  if (n.turns !== undefined) m.turns = n.turns;
  if (n.model) m.model = n.model;
  if (n.effort) m.effort = n.effort;
  return m;
}

/** Usage of an agent node plus its subagent descendants (for per-phase cost). */
function subtreeUsage(n: WorkflowNode, children: Map<string, WorkflowNode[]>): Usage {
  const u: Usage = {};
  const stack = [n];
  const seen = new Set<string>();
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    if (AGENTISH.has(x.kind)) addUsage(u, x.usage);
    for (const c of children.get(x.id) ?? []) if (c.kind === "subagent" || c.kind === "agent") stack.push(c);
  }
  return u;
}

export function workflowStats(run: WorkflowRun, nodes: WorkflowNode[], base?: { run: WorkflowRun; nodes: WorkflowNode[] }): WorkflowStats {
  const allAgents = nodes.filter(isAgentNode);
  const ran = allAgents.filter((n) => n.status !== "cached");
  const timed = timedAgents(nodes);

  let start = run.startedAt;
  let end = run.endedAt;
  if (!(start > 0) && timed.length) start = Math.min(...timed.map((a) => a.startedAt));
  if (end === undefined && run.status !== "running" && timed.length) end = Math.max(...timed.map((a) => a.endedAt));
  const wallMs = end !== undefined && start > 0 ? Math.max(0, end - start) : undefined;

  const agentMs = timed.reduce((s, a) => s + Math.max(0, a.endedAt - a.startedAt), 0);
  const series = concurrencySeries(timed.map((a) => ({ start: a.startedAt, end: a.endedAt })));
  const peakConcurrency = series.reduce((m, p) => Math.max(m, p.running), 0);
  const cp = criticalPath(nodes);
  const idle = barrierIdle(nodes);

  const children = new Map<string, WorkflowNode[]>();
  for (const n of nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

  const tokens: Usage = {};
  for (const n of usageRoots(nodes)) addUsage(tokens, n.usage);

  const stats: WorkflowStats = {
    agentMs,
    peakConcurrency,
    criticalPathExact: cp.exact,
    barrierIdleMs: [...idle.values()].reduce((a, b) => a + b, 0),
    agents: ran.length,
    nullAgents: allAgents.filter((n) => n.status === "null" || n.status === "skipped").length,
    // A failed durable step attempt that a later attempt retried is a retry, not a failure.
    failedAgents: allAgents.filter((n) => n.status === "failed" && !superseded(n)).length,
    apiRetries: nodes.reduce((s, n) => s + (n.apiRetries ?? 0), 0),
    schemaFailures: allAgents.reduce((s, n) => s + (n.schema?.failures ?? 0), 0),
    schemaFinalInvalid: allAgents.filter((n) => n.schema?.finalValid === false).length,
    cacheHits: allAgents.filter((n) => n.status === "cached").length,
    tokens,
  };
  if (allAgents.length) {
    stats.nullRate = stats.nullAgents / allAgents.length;
    stats.failRate = stats.failedAgents / allAgents.length;
  }
  if (wallMs !== undefined) {
    stats.wallMs = wallMs;
    if (wallMs > 0) stats.parallelism = agentMs / wallMs;
    if (run.concurrencyCap && wallMs > 0) stats.utilization = integrate(series) / (run.concurrencyCap * wallMs);
  }
  if (cp.path.length) {
    stats.criticalPathMs = cp.ms;
    stats.criticalPath = cp.path;
    stats.orchestrationGapMs = cp.gaps.reduce((s, g) => s + Math.max(0, g.ms - (g.waitMs ?? 0) - (g.lostMs ?? 0)), 0);
  }
  const waitSpans = waitIntervals(nodes);
  if (waitSpans.length) stats.waitMs = coveredMs(-Infinity, Infinity, waitSpans);
  const lostSpans = lostIntervals(nodes);
  if (lostSpans.length) stats.lostMs = coveredMs(-Infinity, Infinity, lostSpans);
  if (allAgents.some((n) => n.attempt !== undefined)) stats.stepRetries = allAgents.filter((n) => (n.attempt ?? 1) > 1 && n.status !== "cached").length;
  const savings = pipelineSavings(nodes, run.concurrencyCap);
  if (savings !== undefined) stats.pipelineSavingsMs = savings;
  const waits = timed.filter((a) => a.issuedAt !== undefined).map((a) => Math.max(0, a.startedAt - a.issuedAt!));
  if (waits.length) stats.queueWaitMs = waits.reduce((a, b) => a + b, 0);
  if (tokens.costUsd !== undefined) stats.costUsd = tokens.costUsd;

  if (run.resumedFrom || stats.cacheHits > 0) {
    if (allAgents.length) stats.cacheHitRate = stats.cacheHits / allAgents.length;
    if (base && stats.cacheHits > 0) {
      const byOrdinal = new Map(base.nodes.filter(isAgentNode).filter((n) => n.ordinal !== undefined).map((n) => [n.ordinal!, n]));
      let ms = 0;
      let usd: number | undefined;
      for (const n of allAgents) {
        if (n.status !== "cached" || n.ordinal === undefined) continue;
        const o = byOrdinal.get(n.ordinal);
        if (!o) continue;
        if (o.startedAt !== undefined && o.endedAt !== undefined) ms += Math.max(0, o.endedAt - o.startedAt);
        const c = o.usage?.costUsd;
        if (c !== undefined) usd = (usd ?? 0) + c;
      }
      stats.resumeSavedMs = ms;
      if (usd !== undefined) stats.resumeSavedUsd = usd;
    }
  }

  stats.perAgent = allAgents.map((n) => agentMetric(n, nodes));

  // Per phase. Agents without a phase are grouped under "".
  const phases = new Map<string, WorkflowNode[]>();
  for (const n of allAgents) phases.set(n.phase ?? "", [...(phases.get(n.phase ?? "") ?? []), n]);
  const order = [...(run.phases ?? [])];
  for (const p of phases.keys()) if (!order.includes(p)) order.push(p);
  const perPhase: PhaseMetric[] = [];
  for (const p of order) {
    const members = phases.get(p);
    if (!members) continue;
    const t = members.filter((m) => m.status !== "cached" && m.startedAt !== undefined && m.endedAt !== undefined);
    const u: Usage = {};
    for (const m of members) addUsage(u, subtreeUsage(m, children));
    const pm: PhaseMetric = {
      phase: p,
      agents: members.filter((m) => m.status !== "cached").length,
      agentMs: t.reduce((s, m) => s + Math.max(0, m.endedAt! - m.startedAt!), 0),
      tokens: totalTokens(u),
      failures: members.filter((m) => (m.status === "failed" && !superseded(m)) || m.status === "null").length,
    };
    if (t.length) {
      pm.startedAt = Math.min(...t.map((m) => m.startedAt!));
      pm.endedAt = Math.max(...t.map((m) => m.endedAt!));
      pm.wallMs = pm.endedAt - pm.startedAt;
    }
    if (u.costUsd !== undefined) pm.costUsd = u.costUsd;
    perPhase.push(pm);
  }
  stats.perPhase = perPhase;
  if (stats.costUsd !== undefined && stats.costUsd > 0) {
    const share: Record<string, number> = {};
    for (const p of perPhase) if (p.costUsd !== undefined) share[p.phase] = p.costUsd / stats.costUsd;
    stats.costShareByPhase = share;
  }
  return stats;
}
