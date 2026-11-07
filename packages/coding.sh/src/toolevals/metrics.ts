// Per-trial metrics (§6), computed only from captured events (trial session
// plus its child sessions) and the tap. Pure: no I/O.
import { latencyStats, percentile } from "../core/sessions.ts";
import type { AgentRunOutput, Session } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import { matchAny } from "../runner/glob.ts";
import { classifyToolStart, shellUse } from "./classify.ts";
import type { Budget, Prices, TapRecord, Target, ToolMetrics, ToolTask } from "./types.ts";
import { estimateCost } from "../core/pricing.ts";

export { estimateCost };

export interface MetricsInput {
  task: ToolTask;
  target: Target;
  tap: TapRecord[];
  events: AgentEvent[];
  sessions: Session[];
  run: AgentRunOutput;
  checksPass: boolean;
  prices?: Prices;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function addUsage(sum: Usage, u: Usage | undefined): void {
  if (!u) return;
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) sum[k] = (sum[k] ?? 0) + v;
  }
}

export const totalTokens = (u: Usage): number => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

/** Identity used for retries: CLI subcommand path, MCP tool, HTTP method + template. */
export function callIdentity(r: TapRecord): string {
  if (r.target === "cli") {
    const lead: string[] = [];
    for (const a of r.argv ?? []) {
      if (a.startsWith("-")) break;
      lead.push(a);
    }
    return `cli:${lead.join(" ")}`;
  }
  if (r.target === "mcp") return `mcp:${r.tool ?? r.method ?? ""}`;
  return `http:${r.httpMethod ?? ""} ${r.pathTemplate ?? ""}`;
}

interface Span {
  start: number;
  end: number;
  agentKey: string;
  subagent: boolean;
}

/**
 * Who made each tap call: the innermost enclosing tool call (by tool.start /
 * tool.end time) names the session or subagent; otherwise a call inside a
 * subagent.start … subagent.end window with no parent call in flight goes to
 * that subagent (attribution "window"); otherwise the main agent.
 */
export function attributeTap(tap: readonly TapRecord[], events: readonly AgentEvent[], rootId: string | undefined): { agentKey: string; subagent: boolean; attribution: "tool" | "window" | "none" }[] {
  const starts = new Map<string, AgentEvent>();
  const spans: Span[] = [];
  const windows: Span[] = [];
  const subStart = new Map<string, number>();
  const lastTs = events.reduce((m, e) => Math.max(m, e.ts + (e.durationMs ?? 0)), 0);
  for (const e of events) {
    const key = (id: string) => `${e.sessionId}#${id}`;
    if (e.kind === "tool.start" && typeof e.payload.toolUseId === "string") starts.set(key(e.payload.toolUseId), e);
    else if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") {
      const s = starts.get(key(e.payload.toolUseId));
      if (!s) continue;
      starts.delete(key(e.payload.toolUseId));
      if (classifyToolStart(s).category === "subagent") continue; // spans the whole subagent: not "in flight"
      const child = rootId !== undefined && s.sessionId !== rootId;
      const sub = s.subagentId ?? (child ? s.sessionId : undefined);
      spans.push({ start: s.ts, end: Math.max(e.ts, s.ts + (num(e.durationMs) ?? num(e.payload.durationMs) ?? 0)), agentKey: sub ? `sub:${sub}` : "main", subagent: !!sub });
    } else if (e.kind === "subagent.start") {
      const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
      if (id) subStart.set(id, e.ts);
    } else if (e.kind === "subagent.end") {
      const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
      const st = id ? subStart.get(id) : undefined;
      if (id && st !== undefined) {
        windows.push({ start: st, end: e.ts, agentKey: `sub:${id}`, subagent: true });
        subStart.delete(id);
      }
    }
  }
  // Unfinished calls / subagents run to the end of the trace.
  for (const s of starts.values()) {
    if (classifyToolStart(s).category === "subagent") continue;
    const child = rootId !== undefined && s.sessionId !== rootId;
    const sub = s.subagentId ?? (child ? s.sessionId : undefined);
    spans.push({ start: s.ts, end: lastTs, agentKey: sub ? `sub:${sub}` : "main", subagent: !!sub });
  }
  for (const [id, st] of subStart) windows.push({ start: st, end: lastTs, agentKey: `sub:${id}`, subagent: true });

  return tap.map((r) => {
    let best: Span | undefined;
    for (const s of spans) if (r.ts >= s.start && r.ts <= s.end && (!best || s.start >= best.start)) best = s;
    if (best) return { agentKey: best.agentKey, subagent: best.subagent, attribution: "tool" as const };
    const w = windows.find((x) => r.ts >= x.start && r.ts <= x.end);
    if (w) return { agentKey: w.agentKey, subagent: true, attribution: "window" as const };
    return { agentKey: "main", subagent: false, attribution: "none" as const };
  });
}

function latencySourceOf(llm: AgentEvent[]): ToolMetrics["latencySource"] {
  if (!llm.length) return "none";
  const sources = new Set(llm.map((e) => e.source ?? ""));
  if (sources.has("model-driver")) return "model-driver";
  if (sources.has("otel-span")) return "otel-trace";
  if (sources.has("otel-log")) return "otel-log";
  if (sources.has("hook")) return "hooks";
  return "approx";
}

function firstExceeded(b: Budget, m: { turns: number; tokens: number; wallMs: number; costUsd: number | null; timedOut: boolean }): keyof Budget | undefined {
  if (b.turns !== undefined && m.turns > b.turns) return "turns";
  if (b.tokens !== undefined && m.tokens > b.tokens) return "tokens";
  if ((b.wallMs !== undefined && m.wallMs > b.wallMs) || m.timedOut) return "wallMs";
  if (b.costUsd !== undefined && m.costUsd !== null && m.costUsd > b.costUsd) return "costUsd";
  return undefined;
}

export function computeMetrics(i: MetricsInput): ToolMetrics {
  const { task, target } = i;
  const events = [...i.events].sort((a, b) => a.ts - b.ts);
  const tap = [...i.tap].sort((a, b) => a.ts - b.ts);
  const root = i.sessions.find((s) => !s.parent || !i.sessions.some((p) => p.id === s.parent!.sessionId));
  const childIds = new Set(i.sessions.filter((s) => s !== root).map((s) => s.id));

  // ---- turns
  const llm = events.filter((e) => e.kind === "llm.call" && e.payload.ok !== false);
  let turns: number;
  let turnsSource: ToolMetrics["turnsSource"];
  if (llm.length) {
    turns = llm.length;
    turnsSource = "llm.call";
  } else {
    const msgs = new Set(events.filter((e) => e.kind === "assistant.message").map((e) => (typeof e.payload.messageId === "string" ? e.payload.messageId : e.id)));
    if (msgs.size) {
      turns = msgs.size;
      turnsSource = "messages";
    } else {
      turns = i.sessions.reduce((n, s) => n + (s.stats.turns ?? 0), 0);
      turnsSource = "adapter";
    }
  }

  // ---- tap counts
  const calls = tap.filter((r) => r.class !== "meta");
  const invalid = calls.filter((r) => r.class === "invalid");
  const invalidKinds: Record<string, number> = {};
  for (const r of invalid) invalidKinds[r.reason ?? "other"] = (invalidKinds[r.reason ?? "other"] ?? 0) + 1;
  const failedCalls = calls.filter((r) => r.class === "failed").length;

  // ---- events around the tool
  const toolStarts = events.filter((e) => e.kind === "tool.start");
  const ends = new Map<string, AgentEvent>();
  for (const e of events) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(`${e.sessionId}#${e.payload.toolUseId}`, e);
  const outBytes = (start: AgentEvent): number => {
    const end = typeof start.payload.toolUseId === "string" ? ends.get(`${start.sessionId}#${start.payload.toolUseId}`) : undefined;
    if (!end) return 0;
    const ob = num(end.payload.outputBytes);
    if (ob !== undefined) return ob;
    return typeof end.payload.output === "string" ? Buffer.byteLength(end.payload.output, "utf8") : 0;
  };
  let shellInvocations = 0;
  let shellHelp = 0;
  let shellBinHelp = 0;
  let docReads = 0;
  let docBytes = 0;
  let webDocs = 0;
  const docHosts = (target.docsUrls ?? []).map((u) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  });
  for (const e of toolStarts) {
    const c = classifyToolStart(e);
    if (c.category === "shell" && c.command && target.kind === "cli") {
      const u = shellUse(c.command, target.bin);
      shellInvocations += u.invocations;
      shellHelp += u.helpLookups - u.binHelp;
      shellBinHelp += u.binHelp;
    } else if (c.category === "read" && c.path && target.docs?.length) {
      const cwd = e.cwd ?? "";
      const rel = cwd && c.path.startsWith(cwd + "/") ? c.path.slice(cwd.length + 1) : c.path.replace(/^\.\//, "");
      if (matchAny(rel, target.docs)) {
        docReads++;
        docBytes += outBytes(e);
      }
    } else if (c.category === "web" && c.url && docHosts.length) {
      let host = "";
      try {
        host = new URL(c.url).host;
      } catch {
        host = "";
      }
      if (host && docHosts.includes(host)) webDocs++;
    }
  }
  const tapHelp = calls.filter((r) => r.class === "help");
  const helpLookups = Math.max(tapHelp.length, shellBinHelp) + shellHelp + docReads + webDocs;
  const helpBytesRead = tapHelp.reduce((n, r) => n + (r.stdoutBytes ?? r.responseBytes ?? 0), 0) + docBytes;

  // ---- attribution, retries, recovery
  const who = attributeTap(tap, events, root?.id);
  const lastClass = new Map<string, string>();
  const bad = new Set<string>();
  const recovered = new Set<string>();
  let retries = 0;
  let selfCorrections = 0;
  let subagentTargetCalls = 0;
  tap.forEach((r, idx) => {
    if (r.class === "meta") return;
    const a = who[idx]!;
    if (a.subagent) subagentTargetCalls++;
    if (r.class === "help") return;
    const id = `${a.agentKey}|${callIdentity(r)}`;
    const prev = lastClass.get(id);
    if (prev === "invalid" || prev === "failed") {
      retries++;
      if (r.class === "ok") selfCorrections++;
    }
    if (r.class === "invalid" || r.class === "failed") bad.add(id);
    else if (r.class === "ok" && bad.has(id)) recovered.add(id);
    lastClass.set(id, r.class);
  });

  const nonHelp = calls.filter((r) => r.class !== "help");
  const firstOkIdx = calls.findIndex((r) => r.class === "ok");
  const firstEventTs = events[0]?.ts;
  const firstOk = firstOkIdx >= 0 ? calls[firstOkIdx] : undefined;

  // ---- usage and cost
  const usage: Usage = {};
  for (const e of llm) addUsage(usage, e.usage);
  for (const e of events) if (e.kind === "llm.call" && e.payload.ok === false) addUsage(usage, e.usage);
  if (!Object.keys(usage).length) {
    for (const s of i.sessions) addUsage(usage, s.stats.usage);
    if (!Object.keys(usage).length) addUsage(usage, i.run.usage);
  }
  let costUsd: number | null = null;
  let costSource: ToolMetrics["costSource"] = "none";
  if (typeof usage.costUsd === "number") {
    costUsd = usage.costUsd;
    costSource = "reported";
  } else {
    let total = 0;
    let priced = false;
    const byModel = new Map<string, Usage>();
    const source = llm.length ? llm : events.filter((e) => e.usage);
    for (const e of source) {
      const m = e.model ?? root?.model ?? "";
      const u = byModel.get(m) ?? {};
      addUsage(u, e.usage);
      byModel.set(m, u);
    }
    if (!byModel.size && root?.model) byModel.set(root.model, usage);
    for (const [m, u] of byModel) {
      const c = estimateCost(u, m, i.prices);
      if (c !== undefined) {
        total += c;
        priced = true;
      }
    }
    if (priced) {
      costUsd = total;
      costSource = "estimated";
    }
  }
  const tokens = totalTokens(usage);

  // ---- latency
  const llmMs = llm.map((e) => num(e.durationMs)).filter((x): x is number => x !== undefined);
  const ttft = llm.map((e) => num(e.payload.ttftMs)).filter((x): x is number => x !== undefined);
  const targetMs = calls.map((r) => r.durationMs).filter((x) => Number.isFinite(x));
  const lat = latencyStats(events);

  // ---- subagents
  const subIds = new Set<string>();
  let anonymous = 0;
  for (const e of events) {
    if (e.kind !== "subagent.start") continue;
    const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
    if (id) subIds.add(id);
    else anonymous++;
  }
  let subagents = subIds.size + anonymous;
  for (const s of i.sessions) if (s !== root && !(s.parent?.subagentId && subIds.has(s.parent.subagentId))) subagents++;
  const childUsage: Usage = {};
  for (const e of events) if (childIds.has(e.sessionId) || (e.subagentId && e.sessionId === root?.id)) addUsage(childUsage, e.usage);
  const allEventTokens = totalTokens(events.reduce((u, e) => (addUsage(u, e.usage), u), {} as Usage));
  const subagentTokenShare = allEventTokens > 0 ? totalTokens(childUsage) / allEventTokens : null;

  const timedOut = i.run.timedOut;
  const wallMs = i.run.durationMs;
  const budgetExceeded = firstExceeded(task.budget, { turns, tokens, wallMs, costUsd, timedOut });

  const m: ToolMetrics = {
    success: i.checksPass && !budgetExceeded,
    turns,
    turnsSource,
    toolCalls: toolStarts.length,
    targetCalls: calls.length,
    invalidCalls: invalid.length,
    invalidRate: calls.length ? invalid.length / calls.length : 0,
    invalidKinds,
    failedCalls,
    helpLookups,
    helpBytesRead,
    retries,
    selfCorrections,
    recoveryRate: bad.size ? recovered.size / bad.size : null,
    firstCallCorrect: nonHelp.length ? nonHelp[0]!.class === "ok" : null,
    callsToFirstCorrect: firstOkIdx >= 0 ? firstOkIdx + 1 : null,
    timeToFirstCorrectMs: firstOk && firstEventTs !== undefined ? Math.max(0, firstOk.ts - firstEventTs) : null,
    efficiency: task.expect?.minTargetCalls ? calls.length / task.expect.minTargetCalls : null,
    usage,
    costUsd,
    costSource,
    wallMs,
    latencySource: latencySourceOf(llm),
    subagents,
    subagentTargetCalls,
    subagentTokenShare,
    tapCoverage: target.kind === "cli" && shellInvocations > 0 ? tap.length / shellInvocations : null,
  };
  if (budgetExceeded) m.budgetExceeded = budgetExceeded;
  const set = (k: "llmP50Ms" | "llmP95Ms" | "ttftP50Ms" | "ttftP95Ms" | "targetLatencyP50Ms" | "targetLatencyP95Ms" | "toolLatencyP95Ms", v: number | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  set("llmP50Ms", percentile(llmMs, 50));
  set("llmP95Ms", percentile(llmMs, 95));
  set("ttftP50Ms", percentile(ttft, 50));
  set("ttftP95Ms", percentile(ttft, 95));
  set("targetLatencyP50Ms", percentile(targetMs, 50));
  set("targetLatencyP95Ms", percentile(targetMs, 95));
  set("toolLatencyP95Ms", lat.toolP95Ms);
  return m;
}
