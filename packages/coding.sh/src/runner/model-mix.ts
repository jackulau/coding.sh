// Which model answered each run. A bundle asks for one model, but the agent can
// answer from another: after a refusal Claude Code retries on an older model and
// carries on there. A run that did is a result for that model, not the one the
// arm asked for, so compare counts those runs per arm and says so. A session's
// stats.modelSwitch sees a hand-over inside one session; this also catches a run
// whose every call the other model answered.
import type { AgentEvent, HarnessBundle, RunResult } from "../core/types.ts";
import { modelOf } from "../core/models.ts";

export interface ModelMix {
  /** The model each arm's bundle asks for. */
  requested: { baseline?: string; candidate?: string };
  /** Runs per arm with at least one model call answered by another model. */
  off: { baseline: number; candidate: number };
  /** Those runs' own model calls (not a subagent's) per answering model, the requested one left out. */
  models: Record<string, number>;
  /** Tasks with such a run, in either arm. */
  tasks: number;
}

/** A model id without its provider prefix, date suffix, Bedrock version or `[1m]` context tag. */
export function modelKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z0-9-]+[./])+(?=claude|gpt|gemini|o\d)/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

/** The models that answered a run's own model calls, one entry per call; subagents' calls are left out. */
export function answeredBy(events: readonly AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "llm.call" || e.subagentId) continue;
    const m = modelOf(e);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Runs per arm whose own model calls were answered by a model other than the
 * bundle's. An arm counts only when its bundle names a model and at least one of
 * its calls was answered by that model, so an alias (`sonnet`) or a gateway's
 * naming never reads as a fallback. Undefined when no arm can be checked.
 */
export function modelMix(A: readonly RunResult[], B: readonly RunResult[], events: ReadonlyMap<string, readonly AgentEvent[]> | undefined, bundles: { baseline?: HarnessBundle; candidate?: HarnessBundle } = {}): ModelMix | undefined {
  if (!events?.size) return undefined;
  const models: Record<string, number> = {};
  const tasks = new Set<string>();
  const arm = (rs: readonly RunResult[], requested: string | undefined): number | undefined => {
    if (!requested) return undefined;
    const want = modelKey(requested);
    let matched = false;
    const off: { taskId: string; others: string[] }[] = [];
    for (const r of rs) {
      const answered = answeredBy(events.get(r.id) ?? []);
      if (answered.some((m) => modelKey(m) === want)) matched = true;
      const others = answered.filter((m) => modelKey(m) !== want);
      if (others.length) off.push({ taskId: r.taskId, others });
    }
    if (!matched) return undefined;
    for (const o of off) {
      tasks.add(o.taskId);
      for (const m of o.others) models[m] = (models[m] ?? 0) + 1;
    }
    return off.length;
  };
  const baseline = arm(A, bundles.baseline?.model);
  const candidate = arm(B, bundles.candidate?.model);
  if (baseline === undefined && candidate === undefined) return undefined;
  return {
    requested: { ...(bundles.baseline?.model ? { baseline: bundles.baseline.model } : {}), ...(bundles.candidate?.model ? { candidate: bundles.candidate.model } : {}) },
    off: { baseline: baseline ?? 0, candidate: candidate ?? 0 },
    models: Object.fromEntries(Object.entries(models).sort(([x, a], [y, b]) => b - a || x.localeCompare(y))),
    tasks: tasks.size,
  };
}

/** The report note when some runs were answered by another model; undefined otherwise. */
export function modelNote(m: ModelMix | undefined): string | undefined {
  if (!m || !(m.off.baseline + m.off.candidate)) return undefined;
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  const arms = [m.off.baseline ? `${runs(m.off.baseline)} of baseline` : "", m.off.candidate ? `${runs(m.off.candidate)} of candidate` : ""].filter(Boolean).join(" and ");
  const asked = m.requested.baseline && m.requested.candidate && m.requested.baseline !== m.requested.candidate ? "the model its arm asked for" : (m.requested.baseline ?? m.requested.candidate);
  const by = Object.entries(m.models)
    .map(([id, n]) => `${id} (${n} call${n === 1 ? "" : "s"})`)
    .join(", ");
  return (
    `${arms}, over ${m.tasks} task${m.tasks === 1 ? "" : "s"}, had model calls answered by ${by}, not ${asked}: ` +
    `the agent fell back to another model (Claude Code retries on an older model after a refusal). ` +
    `Those runs measure the other model; leave them out or rerun those tasks`
  );
}
