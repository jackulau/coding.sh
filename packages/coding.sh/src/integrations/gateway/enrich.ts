// `coding.sh gateway enrich`: attach what the gateway billed, and which provider
// served it, to captured llm.call events.
//
// Linking an llm.call to a gateway generation:
// 1. by generation id: payload.gatewayGenerationId, or a responseId /
//    messageId / requestId that is a `gen_<ulid>` (the gateway returns the
//    generation id as the chat completion `id`);
// 2. by the provider's own response id: trace-drain attempt spans carry
//    vercel.ai_gateway.attempt.provider_response_id, which is the `msg_…` /
//    `resp_…` id the agent recorded (Claude Code message.id, Codex response_id);
// 3. by client session id (session affinity): a drained request whose session
//    id equals a coding.sh session id (Claude Code sends its session id as
//    x-claude-code-session-id) goes to that session's nearest unlinked call
//    within SESSION_JOIN_MS.
//
// Generation records come from, in order: the kv cache (`gateway:gen:<id>`),
// drained gateway traces already in the index, then GET /v1/generation (only
// when a client is given, i.e. the user opted in with a key). Only whitelisted
// numeric/name fields are cached: no prompt, no key.
//
// Each linked call gets one companion event (kind "span", source "gateway",
// parentId = the llm.call) whose usage.costUsd is the difference between the
// billed cost and the cost the call already reported, so summing usage over a
// session gives what the gateway billed without double counting. Event ids are
// derived from the llm.call id, so re-running is a no-op.
import { hashParts } from "../../core/ids.ts";
import { buildSession } from "../../core/sessions.ts";
import type { IndexStore } from "../../core/types.ts";
import type { AgentEvent, Session } from "../../schema/index.ts";
import { pool } from "../../runner/experiment.ts";
import { billedCostUsd, type GatewayClient, type GenerationInfo } from "./client.ts";
import { GATEWAY_AGENT, GATEWAY_ID, generationIdOf, isGenerationId, virtualModelId } from "./ids.ts";

export const ENRICH_SOURCE = "gateway";
export const GENERATION_SPAN = "vercel.ai_gateway.generation";
export const genCacheKey = (id: string): string => `gateway:gen:${id}`;
/** Max distance between a drained request and an agent call joined by session id. */
export const SESSION_JOIN_MS = 5 * 60_000;
type LinkedBy = "generation-id" | "provider-response-id" | "client-session-id";

export interface EnrichOptions {
  index: IndexStore;
  /** Sessions to enrich (gateway drain sessions are skipped). */
  sessions: Session[];
  /** REST client; omit to use only the cache and drained traces (no network). */
  client?: GatewayClient;
  /** Parallel lookups. Default 4. */
  concurrency?: number;
  /** Cap on REST lookups per run. Default 1000. */
  maxLookups?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface EnrichReport {
  sessions: number;
  /** llm.call events looked at. */
  calls: number;
  /** Calls with a generation id or a drained provider response id. */
  linkable: number;
  /** Companion events written (or that would be, with dryRun). */
  enriched: number;
  alreadyEnriched: number;
  fromCache: number;
  fromDrain: number;
  fetched: number;
  /** The gateway had no record yet (usage is ingested asynchronously): run again later. */
  pending: number;
  /** Linkable calls left alone because no key was given and nothing local had the record. */
  needKey: number;
  /** Sum of billed cost over newly enriched calls. */
  billedUsd: number;
  /** Provider that served each newly enriched call → count. */
  providers: Record<string, number>;
  touchedSessions: string[];
  errors: string[];
}

/** Drained gateway traces in the index: generation id → record, provider response id → generation id. */
interface DrainIndex {
  byGen: Map<string, GenerationInfo>;
  byResponseId: Map<string, string>;
  /** Client session id → drained requests in that session (ts order). */
  bySession: Map<string, { gen: string; ts: number; model?: string }[]>;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A GenerationInfo from a drained root llm.call (see otel.ts drainLlmPayload). */
function fromDrainEvent(e: AgentEvent): GenerationInfo | undefined {
  const p = e.payload;
  const id = s(p.gatewayGenerationId);
  if (!id) return undefined;
  const g: GenerationInfo = { id };
  const set = <K extends keyof GenerationInfo>(k: K, v: GenerationInfo[K] | undefined) => {
    if (v !== undefined) g[k] = v;
  };
  set("totalCostUsd", num(p.billedCostUsd));
  set("marketCostUsd", num(p.marketCostUsd));
  set("isByok", p.credentialType === "byok" ? true : p.credentialType === "system" ? false : undefined);
  set("provider", s(p.servedProvider) ?? s(p.provider));
  set("model", s(p.responseModel) ?? s(p.requestModel) ?? e.model);
  set("finishReason", s(p.stopReason));
  set("latencyMs", num(p.ttftMs));
  set("generationMs", num(e.durationMs));
  return g;
}

async function loadDrain(index: IndexStore, since: number | undefined): Promise<DrainIndex> {
  const byGen = new Map<string, GenerationInfo>();
  const byResponseId = new Map<string, string>();
  const bySession = new Map<string, { gen: string; ts: number; model?: string }[]>();
  const days = await index.listSessions({ agent: GATEWAY_AGENT, ...(since !== undefined ? { since: since - 86_400_000 } : {}), limit: 400 });
  const evs: AgentEvent[] = [];
  for (const d of days) evs.push(...(await index.listEvents(d.id, { kinds: ["llm.call", "span"] })));
  // A request's spans can straddle midnight (two day sessions): join on traceId across all of them.
  const genOfTrace = new Map<string, string>();
  for (const e of evs) {
    if (e.kind !== "llm.call") continue;
    const g = fromDrainEvent(e);
    if (!g) continue;
    byGen.set(g.id, g);
    if (e.traceId) genOfTrace.set(e.traceId, g.id);
    const sid = s(e.payload.gatewaySessionId);
    if (sid) {
      const list = bySession.get(sid) ?? [];
      list.push({ gen: g.id, ts: e.ts, ...(g.model ? { model: g.model } : {}) });
      bySession.set(sid, list);
    }
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
  for (const e of evs) {
    const rid = s(e.payload.providerResponseId);
    const gen = e.traceId ? genOfTrace.get(e.traceId) : undefined;
    // A failed attempt's response id is not the call the agent saw.
    if (rid && gen && e.payload.success !== false) byResponseId.set(rid, gen);
  }
  return { byGen, byResponseId, bySession };
}

function emptyReport(): EnrichReport {
  return { sessions: 0, calls: 0, linkable: 0, enriched: 0, alreadyEnriched: 0, fromCache: 0, fromDrain: 0, fetched: 0, pending: 0, needKey: 0, billedUsd: 0, providers: {}, touchedSessions: [], errors: [] };
}

/** The companion event for one linked llm.call. */
export function generationEvent(call: AgentEvent, g: GenerationInfo, linkedBy: LinkedBy): AgentEvent {
  const billed = billedCostUsd(g);
  const p: Record<string, unknown> = { name: GENERATION_SPAN, gateway: GATEWAY_ID, generationId: g.id, llmEventId: call.id, linkedBy };
  const set = (k: string, v: unknown) => {
    if (v !== undefined) p[k] = v;
  };
  set("provider", g.provider);
  set("model", g.model);
  // A `vmc/` call: the gateway's record names the model the virtual model resolved to.
  const virtual = [call.payload.virtualModel, call.payload.requestModel, call.model, call.payload.responseModel].map(virtualModelId).find(Boolean);
  set("virtualModel", virtual);
  set("resolvedModel", virtual && g.model && !virtualModelId(g.model) ? g.model : undefined);
  set("billedCostUsd", billed);
  set("totalCostUsd", g.totalCostUsd);
  set("marketCostUsd", g.marketCostUsd);
  set("upstreamCostUsd", g.isByok ? g.upstreamCostUsd : undefined);
  set("isByok", g.isByok);
  set("ttftMs", g.latencyMs);
  set("generationMs", g.generationMs);
  set("finishReason", g.finishReason);
  set("promptTokens", g.promptTokens);
  set("completionTokens", g.completionTokens);
  set("reasoningTokens", g.reasoningTokens);
  set("cachedTokens", g.cachedTokens);
  set("cacheCreationTokens", g.cacheCreationTokens);
  const reported = call.usage?.costUsd;
  if (reported !== undefined) set("reportedCostUsd", reported);
  const e: AgentEvent = {
    id: hashParts("gateway-generation", call.sessionId, call.id),
    v: 0,
    sessionId: call.sessionId,
    ts: call.ts,
    agent: call.agent,
    kind: "span",
    source: ENRICH_SOURCE,
    parentId: call.id,
    payload: p,
  };
  if (call.turnId) e.turnId = call.turnId;
  if (call.subagentId) e.subagentId = call.subagentId;
  if (call.runId) e.runId = call.runId;
  if (call.traceId) e.traceId = call.traceId;
  // Correction so the session total equals the billed cost (see the file header).
  const delta = billed !== undefined ? Math.round((billed - (reported ?? 0)) * 1e10) / 1e10 : 0;
  if (delta !== 0) e.usage = { costUsd: delta };
  return e;
}

export async function enrichSessions(o: EnrichOptions): Promise<EnrichReport> {
  const { index } = o;
  const r = emptyReport();
  const sessions = o.sessions.filter((x) => x.agent !== GATEWAY_AGENT);
  r.sessions = sessions.length;
  if (!sessions.length) return r;
  const since = Math.min(...sessions.map((x) => x.startedAt));
  const drain = await loadDrain(index, since);

  // 1. Link calls.
  interface Pending {
    call: AgentEvent;
    gen: string;
    linkedBy: LinkedBy;
  }
  const todo: Pending[] = [];
  for (const sess of sessions) {
    const evs = await index.listEvents(sess.id, { kinds: ["llm.call", "span"] });
    const done = new Set(evs.filter((e) => e.source === ENRICH_SOURCE).map((e) => e.parentId));
    const takenGens = new Set(evs.filter((e) => e.source === ENRICH_SOURCE).map((e) => s(e.payload.generationId)));
    const unlinked: AgentEvent[] = [];
    for (const call of evs) {
      if (call.kind !== "llm.call") continue;
      r.calls++;
      let gen = generationIdOf(call);
      let linkedBy: LinkedBy = "generation-id";
      if (!gen) {
        for (const k of ["messageId", "responseId", "requestId"]) {
          const v = s(call.payload[k]);
          const hit = v ? drain.byResponseId.get(v) : undefined;
          if (hit) {
            gen = hit;
            linkedBy = "provider-response-id";
            break;
          }
        }
      }
      if (!gen || !isGenerationId(gen)) {
        if (!done.has(call.id)) unlinked.push(call);
        else {
          // Linked on an earlier run by client session id.
          r.linkable++;
          r.alreadyEnriched++;
        }
        continue;
      }
      r.linkable++;
      takenGens.add(gen);
      if (done.has(call.id)) {
        r.alreadyEnriched++;
        continue;
      }
      todo.push({ call, gen, linkedBy });
    }
    // Session affinity join: drained requests in this session (by client session id), each to the
    // nearest unlinked call within SESSION_JOIN_MS. The call's own gatewaySessionId, when the agent
    // recorded one, names the session too.
    const sids = new Set([sess.id, ...unlinked.map((c) => s(c.payload.gatewaySessionId)).filter((x): x is string => !!x)]);
    const reqs = [...sids].flatMap((sid) => drain.bySession.get(sid) ?? []).filter((q) => !takenGens.has(q.gen));
    for (const q of reqs) {
      let best: AgentEvent | undefined;
      for (const c of unlinked) {
        const d = Math.abs(c.ts - q.ts);
        if (d <= SESSION_JOIN_MS && (!best || d < Math.abs(best.ts - q.ts))) best = c;
      }
      if (!best) continue;
      unlinked.splice(unlinked.indexOf(best), 1);
      takenGens.add(q.gen);
      r.linkable++;
      todo.push({ call: best, gen: q.gen, linkedBy: "client-session-id" });
    }
  }

  // 2. Resolve generation records: cache → drain → REST.
  const records = new Map<string, GenerationInfo>();
  const toFetch: string[] = [];
  for (const id of new Set(todo.map((t) => t.gen))) {
    const cached = index.kvGet ? await index.kvGet(genCacheKey(id)) : undefined;
    if (cached) {
      try {
        records.set(id, JSON.parse(cached) as GenerationInfo);
        r.fromCache++;
        continue;
      } catch {
        // corrupt entry: refetch
      }
    }
    const d = drain.byGen.get(id);
    if (d) {
      records.set(id, d);
      r.fromDrain++;
      if (!o.dryRun && index.kvSet) await index.kvSet(genCacheKey(id), JSON.stringify(d));
      continue;
    }
    toFetch.push(id);
  }
  if (o.client) {
    const client = o.client;
    const capped = toFetch.slice(0, o.maxLookups ?? 1000);
    r.pending += toFetch.length - capped.length;
    await pool(capped, o.concurrency ?? 4, async (id) => {
      if (o.signal?.aborted) return;
      try {
        const res = await client.generation(id, o.signal);
        if (res.status === "pending") {
          r.pending++;
          return;
        }
        records.set(id, res.info);
        r.fetched++;
        if (!o.dryRun && index.kvSet) await index.kvSet(genCacheKey(id), JSON.stringify(res.info));
      } catch (e) {
        if (r.errors.length < 5) r.errors.push(e instanceof Error ? e.message : String(e));
      }
    });
  } else r.needKey += toFetch.length;

  // 3. Write companion events and rebuild touched sessions.
  const out: AgentEvent[] = [];
  for (const t of todo) {
    const g = records.get(t.gen);
    if (!g) continue;
    const e = generationEvent(t.call, g, t.linkedBy);
    out.push(e);
    const billed = num(e.payload.billedCostUsd);
    if (billed !== undefined) r.billedUsd += billed;
    if (g.provider) r.providers[g.provider] = (r.providers[g.provider] ?? 0) + 1;
  }
  r.enriched = out.length;
  r.billedUsd = Math.round(r.billedUsd * 1e6) / 1e6;
  const touched = [...new Set(out.map((e) => e.sessionId))];
  r.touchedSessions = touched;
  if (o.dryRun || !out.length) return r;
  await index.putEvents(out);
  for (const id of touched) {
    const all = await index.listEvents(id);
    if (all.length) await index.upsertSession(buildSession(all, await index.getSession(id)));
  }
  return r;
}
