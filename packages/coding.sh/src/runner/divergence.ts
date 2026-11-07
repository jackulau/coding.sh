// First point where two traces take different actions. Compares the ordered
// sequence of tool calls (name + normalized input); assistant prose is ignored
// because it differs between any two runs and says little about behaviour.
import type { AgentEvent } from "../core/types.ts";

export interface Step {
  /** Position in the tool-call sequence (0-based). */
  index: number;
  tool: string;
  /** Normalized input, canonical JSON. */
  input: string;
  eventId: string;
  ts: number;
}

export interface Divergence {
  /** Index of the first differing step (= length of the common prefix). */
  index: number;
  a?: Step;
  b?: Step;
  /** Same tool, different input (vs. a different tool or one trace ending). */
  sameTool: boolean;
  description: string;
}

export interface DivergenceOpts {
  /** Input keys that never matter (descriptions, ids, timeouts). */
  ignoreKeys?: string[];
  /** Max chars of input shown in descriptions. */
  preview?: number;
}

const DEFAULT_IGNORE = ["description", "toolUseId", "tool_use_id", "id", "timeout", "timeout_ms", "run_in_background"];

function normalizeValue(v: unknown, cwd: string | undefined, ignore: ReadonlySet<string>): unknown {
  if (typeof v === "string") {
    let s = v;
    if (cwd) s = s.split(`${cwd}/`).join("").split(cwd).join(".");
    s = s.replace(/\/[^\s"']*\/runs\/run_[0-9A-Za-z]+\/(work|home)/g, "<$1>");
    return s.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x, cwd, ignore));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (ignore.has(k)) continue;
      o[k] = normalizeValue((v as Record<string, unknown>)[k], cwd, ignore);
    }
    return o;
  }
  return v;
}

/** Tool-call steps of a trace in time order (subagent calls included, flattened). */
export function toolSteps(events: readonly AgentEvent[], opts: DivergenceOpts = {}): Step[] {
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignoreKeys ?? [])]);
  return events
    .filter((e) => e.kind === "tool.start")
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.ts - y.e.ts || x.i - y.i)
    .map(({ e }, index) => ({
      index,
      tool: String(e.payload.tool ?? "?"),
      input: JSON.stringify(normalizeValue(e.payload.input ?? null, e.cwd ?? e.repo?.root, ignore)) ?? "null",
      eventId: e.id,
      ts: e.ts,
    }));
}

function show(s: Step, max: number): string {
  const inp = s.input.length > max ? `${s.input.slice(0, max - 1)}…` : s.input;
  return `${s.tool} ${inp}`;
}

/** undefined when both traces make the same tool calls in the same order. */
export function firstDivergence(eventsA: readonly AgentEvent[], eventsB: readonly AgentEvent[], opts: DivergenceOpts = {}): Divergence | undefined {
  const a = toolSteps(eventsA, opts);
  const b = toolSteps(eventsB, opts);
  const max = opts.preview ?? 80;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as Step;
    const y = b[i] as Step;
    if (x.tool === y.tool && x.input === y.input) continue;
    const sameTool = x.tool === y.tool;
    const description = sameTool
      ? `step ${i + 1}: both call ${x.tool} with different input — A: ${show(x, max)} | B: ${show(y, max)}`
      : `step ${i + 1}: A calls ${show(x, max)}; B calls ${show(y, max)}`;
    return { index: i, a: x, b: y, sameTool, description };
  }
  if (a.length === b.length) return undefined;
  const longer = a.length > b.length ? "A" : "B";
  const next = (a.length > b.length ? a[n] : b[n]) as Step;
  const shorter = longer === "A" ? "B" : "A";
  return {
    index: n,
    a: a[n],
    b: b[n],
    sameTool: false,
    description: `step ${n + 1}: ${shorter} stops after ${n} tool call(s); ${longer} continues with ${show(next, max)}`,
  };
}
