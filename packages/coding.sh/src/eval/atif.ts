// A captured session as an ATIF trajectory (Agent Trajectory Interchange
// Format, ATIF-v1.8: Harbor RFC 0001, harbor-framework/harbor
// src/harbor/models/trajectories). `coding.sh eval export --format atif` writes
// one, and `--format harbor` puts one in solution/trajectory.json.
//
// Mapping:
//   user.message          → step source "user"
//   llm.call              → step source "agent": model_name, metrics (prompt_tokens counts
//                           cached and cache-write tokens, as ATIF defines it), llm_call_count 1,
//                           message = the assistant.message with the same messageId
//   tool.start / tool.end → tool_calls and observation.results on the agent step that made them
//                           (the last model call before the tool started)
//   subagent.start        → the Agent tool call's observation gets a subagent_trajectory_ref, and
//                           the child session is embedded in subagent_trajectories (depth ≤ 3)
//   context.compact       → step source "system"
//   assistant.message with no model call (agents that don't record llm.call) → an agent step
// Everything coding.sh knows that ATIF has no field for goes under extra.coding_sh.
// Strings go through the secrets redactor (src/core/redact.ts); `mode: "metadata"`
// drops text, tool input and output as capture.mode="metadata" does.
import { createRedactor, toMetadata, type Redactor } from "../core/redact.ts";
import type { AgentEvent, Session } from "../core/types.ts";

export const ATIF_VERSION = "ATIF-v1.8";
/** Subagents nested deeper than this are referenced, not embedded. */
export const ATIF_MAX_DEPTH = 3;
const OBS_MAX = 16_000;

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifSubagentRef {
  trajectory_id?: string;
  session_id?: string;
  trajectory_path?: string;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string;
  subagent_trajectory_ref?: AtifSubagentRef[];
  extra?: Record<string, unknown>;
}

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  message: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifMetrics;
  llm_call_count?: number;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_VERSION;
  session_id?: string;
  trajectory_id?: string;
  agent: { name: string; version: string; model_name?: string; extra?: Record<string, unknown> };
  steps: AtifStep[];
  notes?: string;
  final_metrics?: { total_prompt_tokens?: number; total_completion_tokens?: number; total_cached_tokens?: number; total_cost_usd?: number; total_steps?: number; extra?: Record<string, unknown> };
  extra?: Record<string, unknown>;
  subagent_trajectories?: AtifTrajectory[];
}

export interface AtifOpts {
  /** "full" (default): text kept, secrets redacted. "metadata": no text, tool input or output. */
  mode?: "full" | "metadata";
  /** Child sessions by id, for subagents (Session.parent or a subagent.end childSessionId). */
  children?: ReadonlyMap<string, { session: Session; events: readonly AgentEvent[] }>;
  redactor?: Redactor;
  /** Internal: how deep this trajectory is (root 0). */
  depth?: number;
}

const iso = (ts: number): string => new Date(ts).toISOString();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const clip = (s: string, n = OBS_MAX): string => (s.length > n ? `${s.slice(0, n)}\n[cut at ${n} chars]` : s);

/** Drops undefined values so the JSON has no null-for-missing fields. */
function compact<T extends object>(o: T): T {
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return o;
}

function metricsOf(e: AgentEvent): AtifMetrics | undefined {
  const u = e.usage;
  if (!u) return undefined;
  const cached = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const hasPrompt = u.inputTokens !== undefined || u.cacheReadTokens !== undefined || u.cacheWriteTokens !== undefined;
  const m = compact<AtifMetrics>({
    prompt_tokens: hasPrompt ? (u.inputTokens ?? 0) + cached + write : undefined,
    completion_tokens: u.outputTokens,
    cached_tokens: u.cacheReadTokens !== undefined ? cached : undefined,
    cost_usd: u.costUsd,
    extra: write ? { coding_sh: { cache_write_tokens: write } } : undefined,
  });
  return Object.keys(m).length ? m : undefined;
}

function argumentsOf(input: unknown): Record<string, unknown> {
  if (isObj(input)) return input;
  if (input === undefined || input === null) return {};
  return { input };
}

function outputOf(e: AgentEvent | undefined): string | undefined {
  if (!e) return undefined;
  const o = e.payload.output ?? e.payload.result ?? e.payload.error;
  if (o === undefined || o === null) return undefined;
  return clip(typeof o === "string" ? o : JSON.stringify(o));
}

/** Events in time order; ties keep their stored order. */
function ordered(events: readonly AgentEvent[]): AgentEvent[] {
  return events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
}

/** One session as an ATIF-v1.8 trajectory. Pure apart from reading `opts.children`. */
export function toAtif(session: Session, events: readonly AgentEvent[], opts: AtifOpts = {}): AtifTrajectory {
  const mode = opts.mode ?? "full";
  const depth = opts.depth ?? 0;
  const redactor = opts.redactor ?? createRedactor();
  const r = <T>(v: T): T => (mode === "metadata" ? v : redactor.value(v));
  const evs = ordered(events.filter((e) => e.sessionId === session.id)).map((e) => (mode === "metadata" ? toMetadata(e) : e));

  const ends = new Map<string, AgentEvent>();
  for (const e of evs) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(e.payload.toolUseId, e);
  const replies = new Map<string, AgentEvent>();
  for (const e of evs) if (e.kind === "assistant.message" && typeof e.payload.messageId === "string") replies.set(e.payload.messageId, e);
  // Agent tool calls that started a subagent: toolUseId → child session id.
  const spawned = new Map<string, { child?: string; subagentId?: string; type?: string }>();
  for (const e of evs) {
    if (e.kind !== "subagent.start" && e.kind !== "subagent.end") continue;
    const id = str(e.payload.toolUseId) ?? [...spawned.entries()].find(([, v]) => v.subagentId && v.subagentId === e.payload.subagentId)?.[0];
    if (!id) continue;
    const prev = spawned.get(id) ?? {};
    spawned.set(id, compact({ child: prev.child ?? str(e.payload.childSessionId), subagentId: prev.subagentId ?? str(e.payload.subagentId), type: prev.type ?? str(e.payload.type) }));
  }

  const steps: AtifStep[] = [];
  const usedReplies = new Set<string>();
  let agentStep: AtifStep | undefined;
  const subs: AtifTrajectory[] = [];
  const subIds = new Set<string>();

  const newAgentStep = (e: AgentEvent, fromCall: boolean): AtifStep => {
    const step: AtifStep = compact({
      step_id: steps.length + 1,
      timestamp: iso(e.ts),
      source: "agent" as const,
      model_name: str(e.payload.responseModel) ?? str(e.payload.requestModel) ?? e.model,
      message: "",
      metrics: fromCall ? metricsOf(e) : undefined,
      llm_call_count: fromCall ? 1 : undefined,
    });
    const extra: Record<string, unknown> = { event_id: e.id };
    if (fromCall) {
      for (const k of ["provider", "stopReason", "ttftMs", "tokensPerSec", "ok", "error"] as const) if (e.payload[k] !== undefined) extra[k] = e.payload[k];
      if (e.durationMs !== undefined) extra.durationMs = e.durationMs;
      const id = str(e.payload.messageId);
      const reply = id ? replies.get(id) : undefined;
      if (reply) {
        step.message = r(str(reply.payload.text) ?? "");
        usedReplies.add(reply.id);
      }
    }
    step.extra = { coding_sh: extra };
    steps.push(step);
    return step;
  };

  for (const e of evs) {
    switch (e.kind) {
      case "user.message": {
        agentStep = undefined;
        steps.push({ step_id: steps.length + 1, timestamp: iso(e.ts), source: "user", message: r(str(e.payload.text) ?? ""), extra: { coding_sh: { event_id: e.id } } });
        break;
      }
      case "llm.call":
        agentStep = newAgentStep(e, true);
        break;
      case "assistant.message": {
        if (usedReplies.has(e.id)) break;
        const id = str(e.payload.messageId);
        // Its model call comes later in the stream (stamped at the call's start): the call takes it then.
        if (id && evs.some((x) => x.kind === "llm.call" && x.payload.messageId === id)) break;
        if (agentStep && !agentStep.message && !agentStep.tool_calls) {
          agentStep.message = r(str(e.payload.text) ?? "");
          break;
        }
        agentStep = newAgentStep(e, false);
        agentStep.message = r(str(e.payload.text) ?? "");
        break;
      }
      case "tool.start": {
        if (e.payload.wrapper === true) break;
        const id = str(e.payload.toolUseId) ?? e.id;
        if (!agentStep) agentStep = newAgentStep(e, false);
        const end = ends.get(id);
        const call: AtifToolCall = compact({
          tool_call_id: id,
          function_name: str(e.payload.tool) ?? "tool",
          arguments: r(argumentsOf(e.payload.input)),
          extra: compact({ coding_sh: compact({ event_id: e.id, server: e.payload.server, ok: end?.payload.ok, durationMs: (end?.payload.durationMs as number | undefined) ?? end?.durationMs }) }),
        });
        (agentStep.tool_calls ??= []).push(call);
        const result: AtifObservationResult = compact({ source_call_id: id, content: end ? r(outputOf(end)) : undefined, extra: end ? undefined : { coding_sh: { no_result: true } } });
        const sp = spawned.get(id);
        if (sp?.child) {
          result.subagent_trajectory_ref = [compact({ trajectory_id: sp.child, session_id: sp.child, extra: compact({ coding_sh: compact({ subagent_id: sp.subagentId, type: sp.type }) }) })];
          const child = opts.children?.get(sp.child);
          if (child && depth + 1 <= ATIF_MAX_DEPTH && !subIds.has(sp.child)) {
            subIds.add(sp.child);
            subs.push(toAtif(child.session, child.events, { ...opts, redactor, depth: depth + 1 }));
          }
        }
        (agentStep.observation ??= { results: [] }).results.push(result);
        break;
      }
      case "context.compact": {
        agentStep = undefined;
        const before = e.payload.tokensBefore;
        steps.push({
          step_id: steps.length + 1,
          timestamp: iso(e.ts),
          source: "system",
          message: `Context compacted (${str(e.payload.trigger) ?? "auto"}${typeof before === "number" ? `, ${before} tokens before` : ""})`,
          extra: { coding_sh: compact({ event_id: e.id, kind: "context.compact", trigger: e.payload.trigger, tokensBefore: before, tokensAfter: e.payload.tokensAfter }) },
        });
        break;
      }
      default:
        break;
    }
  }
  if (!steps.length) steps.push({ step_id: 1, source: "system", message: "The session recorded no messages or model calls", extra: { coding_sh: { empty: true } } });

  // Totals over this trajectory's steps, plus every embedded subagent's cost.
  const sum = (f: (m: AtifMetrics) => number | undefined): number | undefined => {
    let any = false;
    let t = 0;
    for (const s of steps) {
      const v = s.metrics ? f(s.metrics) : undefined;
      if (v !== undefined) {
        any = true;
        t += v;
      }
    }
    return any ? t : undefined;
  };
  const ownCost = sum((m) => m.cost_usd) ?? session.stats.usage?.costUsd;
  const subCost = subs.reduce((t, s) => t + (s.final_metrics?.total_cost_usd ?? 0), 0);
  const cost = ownCost !== undefined || subCost ? (ownCost ?? 0) + subCost : undefined;
  const models = [...new Set(steps.map((s) => s.model_name).filter((m): m is string => !!m))];
  const out = compact<AtifTrajectory>({
    schema_version: ATIF_VERSION,
    session_id: session.id,
    trajectory_id: session.id,
    agent: compact({ name: session.agent, version: session.agentVersion ?? evs.find((e) => e.agentVersion)?.agentVersion ?? "unknown", model_name: session.model ?? models[0] }),
    steps,
    final_metrics: compact({
      total_prompt_tokens: sum((m) => m.prompt_tokens),
      total_completion_tokens: sum((m) => m.completion_tokens),
      total_cached_tokens: sum((m) => m.cached_tokens),
      total_cost_usd: cost,
      total_steps: steps.length,
    }),
    extra: {
      coding_sh: compact({
        session_id: session.id,
        agent: session.agent,
        provider: session.provider,
        started_at: iso(session.startedAt),
        ended_at: session.endedAt !== undefined ? iso(session.endedAt) : undefined,
        flags: session.flags,
        repo: session.repo && mode !== "metadata" ? compact({ root: session.repo.root, head: session.repo.head, snapshot: session.repo.snapshot, branch: session.repo.branch }) : undefined,
        end_snapshot: session.endSnapshot,
        parent_session_id: session.parent?.sessionId,
        stats: compact({ turns: session.stats.turns, tool_calls: session.stats.toolCalls, tool_errors: session.stats.toolErrors, files_changed: session.stats.filesChanged, tests_passed: session.stats.testsPassed, tests_failed: session.stats.testsFailed }),
        mode,
      }),
    },
    subagent_trajectories: subs.length ? subs : undefined,
  });
  return out;
}

/** Load a session, its events and its subagents (to ATIF_MAX_DEPTH) from the store, then convert. */
export async function atifFromStore(
  index: { getSession(id: string): Promise<Session | undefined>; listEvents(sessionId: string): Promise<AgentEvent[]> },
  sessionId: string,
  opts: Omit<AtifOpts, "children" | "depth"> = {},
): Promise<AtifTrajectory> {
  const session = await index.getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const events = await index.listEvents(sessionId);
  const children = new Map<string, { session: Session; events: AgentEvent[] }>();
  const walk = async (evs: readonly AgentEvent[], depth: number): Promise<void> => {
    if (depth > ATIF_MAX_DEPTH) return;
    for (const e of evs) {
      const child = (e.kind === "subagent.start" || e.kind === "subagent.end") && typeof e.payload.childSessionId === "string" ? e.payload.childSessionId : undefined;
      if (!child || children.has(child)) continue;
      const s = await index.getSession(child);
      if (!s) continue;
      const ce = await index.listEvents(child);
      children.set(child, { session: s, events: ce });
      await walk(ce, depth + 1);
    }
  };
  await walk(events, 1);
  return toAtif(session, events, { ...opts, children });
}
