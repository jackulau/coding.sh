// CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) as a gateway source:
// `coding.sh gateway enrich --gateway cliproxyapi` drains its usage queue and
// joins each record to the llm.call it describes.
//
// The queue is the management API's GET /v8/management/observability/usage/queue
// (v0: GET /v0/management/usage-queue), with the management key as a Bearer
// token. A read pops what it returns: records are gone for every other reader
// (Usage Keeper, tokenlayer, a second coding.sh), and CLIProxyAPI drops records
// nobody read after its retention (60-3600 s). So the drain is opt-in, and every
// record it pops is kept, whitelisted and redacted, in the index (kv
// `gateway:cliproxyapi:pending`) before anything else happens. A record that
// does not join yet (its transcript is not ingested) stays there for the next
// run, up to PENDING_TTL_MS.
//
// A record joins an llm.call:
// 1. by session id: CLIProxyAPI normalizes the client's session id to a UUID
//    (Claude Code's session id, Codex's thread id), which is the coding.sh
//    session id (subagent sessions are `<id>:sub:<agent>`). The nearest
//    unlinked call within SESSION_JOIN_MS of the request, whose model matches
//    when both are known, gets it.
// 2. else by time and model: the only unlinked call with the same model within
//    TIME_JOIN_MS of the request, across the sessions being enriched.
//
// Each joined call gets the same companion span as other gateways (enrich.ts):
// kind "span", source "gateway", parentId = the call, an id derived from the
// call, so a second run writes nothing new. payload.gateway = "cliproxyapi"
// tags the session `gateway:cliproxyapi`. It carries reasoning effort, service
// tier, speed, time to first token, compaction and fork marks, tokens, the
// upstream cost when the upstream reported one, and the account as CLIProxyAPI's
// credential index (16 hex characters, already a hash; anything else is hashed
// here). Never stored: the client API key, IP addresses, user agent, response
// headers and error bodies.
import { hashParts } from "../../core/ids.ts";
import type { Redactor } from "../../core/redact.ts";
import { buildSession } from "../../core/sessions.ts";
import type { IndexStore } from "../../core/types.ts";
import type { AgentEvent, Session } from "../../schema/index.ts";
import { ENRICH_SOURCE, generationSpanName, SESSION_JOIN_MS } from "./enrich.ts";
import { BASE_URL_VARS, GATEWAY_AGENT } from "./ids.ts";
import { gatewayForUrl, GATEWAYS } from "./providers.ts";

export const CLIPROXYAPI = "cliproxyapi";
export const CLIPROXYAPI_PORT = 8317;
export const USAGE_QUEUE_PATH = "/v8/management/observability/usage/queue";
export const USAGE_QUEUE_PATH_V0 = "/v0/management/usage-queue";
/** kv key holding drained records that have not joined a call yet. */
export const PENDING_KEY = "gateway:cliproxyapi:pending";
/** How long an unjoined record is kept for a later run. */
export const PENDING_TTL_MS = 24 * 3_600_000;
export const PENDING_MAX = 5000;
/** Max distance between a request and a call joined by time and model alone. */
export const TIME_JOIN_MS = 30_000;
/** Records asked for per read, and reads per drain. */
export const DRAIN_BATCH = 500;
export const DRAIN_MAX_READS = 200;

/** One usage record, reduced to what coding.sh keeps. Absent fields were empty or zero. */
export interface CliProxyUsage {
  /** Request start (ms). */
  ts: number;
  latencyMs?: number;
  ttftMs?: number;
  sessionId?: string;
  parentSessionId?: string;
  requestId?: string;
  executionId?: string;
  traceId?: string;
  provider?: string;
  executorType?: string;
  model?: string;
  alias?: string;
  responseModel?: string;
  endpoint?: string;
  authType?: string;
  /** CLIProxyAPI's credential index (the upstream account), hashed. */
  accountHash?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  effectiveServiceTier?: string;
  responseServiceTier?: string;
  upstreamServiceTier?: string;
  speed?: string;
  inferenceGeo?: string;
  isCompaction?: boolean;
  isFork?: boolean;
  nodeKind?: string;
  stream?: boolean;
  failed?: boolean;
  statusCode?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  /** Upstream-reported cost (cost_details.cost, e.g. from OpenRouter), USD. */
  costUsd?: number;
  isByok?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v.trim() !== "unknown" ? v.trim() : undefined);
const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The credential index as a 16-hex hash: kept when it already is one (as the proxy stores it), else hashed. */
export function accountHashOf(authIndex: string): string {
  return /^[0-9a-f]{16}$/i.test(authIndex) ? authIndex.toLowerCase() : hashParts("cliproxyapi-account", authIndex).slice(0, 16);
}

/** A queue record (internal/redisqueue/plugin.go requestDetail) reduced to CliProxyUsage; undefined when it has no usable timestamp. */
export function usageRecordOf(raw: unknown): CliProxyUsage | undefined {
  if (!isObj(raw)) return undefined;
  const ts = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : typeof raw.timestamp === "number" ? raw.timestamp : NaN;
  if (!Number.isFinite(ts)) return undefined;
  const u: CliProxyUsage = { ts };
  const set = <K extends keyof CliProxyUsage>(k: K, v: CliProxyUsage[K] | undefined) => {
    if (v !== undefined) u[k] = v;
  };
  set("latencyMs", pos(raw.latency_ms));
  set("ttftMs", pos(raw.ttft_ms));
  const sid = str(raw.session_id);
  set("sessionId", sid && UUID.test(sid) ? sid.toLowerCase() : sid);
  set("parentSessionId", str(raw.parent_session_id)?.toLowerCase());
  set("requestId", str(raw.request_id));
  set("executionId", str(raw.execution_id));
  set("traceId", str(raw.trace_id));
  set("provider", str(raw.provider));
  set("executorType", str(raw.executor_type));
  set("model", str(raw.model));
  const alias = str(raw.alias);
  set("alias", alias && alias !== u.model ? alias : undefined);
  set("responseModel", str(raw.response_model));
  set("endpoint", str(raw.endpoint));
  set("authType", str(raw.auth_type));
  const auth = str(raw.auth_index);
  set("accountHash", auth ? accountHashOf(auth) : undefined);
  set("reasoningEffort", str(raw.reasoning_effort));
  set("serviceTier", str(raw.service_tier));
  set("effectiveServiceTier", str(raw.effective_service_tier));
  set("responseServiceTier", str(raw.response_service_tier));
  set("upstreamServiceTier", str(raw.upstream_service_tier));
  set("speed", str(raw.speed));
  set("inferenceGeo", str(raw.inference_geo));
  if (raw.is_compaction === true) u.isCompaction = true;
  if (raw.is_fork === true) u.isFork = true;
  set("nodeKind", str(raw.node_kind));
  if (raw.stream === true) u.stream = true;
  if (raw.failed === true) {
    u.failed = true;
    set("statusCode", isObj(raw.fail) ? pos(raw.fail.status_code) : undefined);
  }
  const t = isObj(raw.tokens) ? raw.tokens : {};
  set("inputTokens", pos(t.input_tokens));
  set("outputTokens", pos(t.output_tokens));
  set("reasoningTokens", pos(t.reasoning_tokens));
  set("cacheReadTokens", pos(t.cache_read_tokens) ?? pos(t.cached_tokens));
  set("cacheCreationTokens", pos(t.cache_creation_tokens));
  set("totalTokens", pos(t.total_tokens));
  const cost = isObj(raw.cost_details) ? raw.cost_details : undefined;
  if (cost && typeof cost.cost === "number" && Number.isFinite(cost.cost) && cost.cost >= 0) u.costUsd = cost.cost;
  if (cost && typeof cost.is_byok === "boolean") u.isByok = cost.is_byok;
  return u;
}

export class CliProxyApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CliProxyApiError";
    if (status !== undefined) this.status = status;
  }
}

export interface DrainOptions {
  /** Server base URL, e.g. http://127.0.0.1:8317 (any path is dropped). */
  baseUrl: string;
  /** The management key. */
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  batch?: number;
  maxReads?: number;
  /** Called with each read's records as soon as they arrive, so a later failure loses nothing already popped. */
  onRecords?: (records: unknown[]) => Promise<void> | void;
}

/**
 * Where CLIProxyAPI runs: [gateway.cliproxyapi] baseUrl or $CLIPROXYAPI_URL
 * (`configured`, from gatewayConfig), else an agent base URL env var that
 * points at it, else http://127.0.0.1:8317.
 */
export function cliProxyBaseUrl(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  const def = GATEWAYS.cliproxyapi.apiBase!;
  if (configured && configured !== def) return configured;
  const fromAgent = BASE_URL_VARS.map((k) => env[k]?.trim()).find((v) => v && gatewayForUrl(v, env) === CLIPROXYAPI);
  return fromAgent ?? def;
}

/** The origin of a CLIProxyAPI URL (the management API lives at its root). */
export function managementOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Pops every record in the usage queue, DRAIN_BATCH at a time, until a read
 * returns fewer than it asked for. Destructive: see the file header.
 */
export async function drainUsageQueue(o: DrainOptions): Promise<{ records: unknown[]; reads: number; path: string }> {
  const origin = managementOrigin(o.baseUrl);
  const doFetch = o.fetch ?? fetch;
  const batch = o.batch ?? DRAIN_BATCH;
  const records: unknown[] = [];
  let path = USAGE_QUEUE_PATH;
  let reads = 0;
  for (; reads < (o.maxReads ?? DRAIN_MAX_READS); ) {
    const url = `${origin}${path}?count=${batch}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { authorization: `Bearer ${o.key}`, accept: "application/json" }, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (e) {
      throw new CliProxyApiError(`could not reach CLIProxyAPI at ${origin} (${e instanceof Error ? e.message : String(e)})`);
    }
    // An older server has only the v0 route.
    if (res.status === 404 && path === USAGE_QUEUE_PATH && reads === 0) {
      await res.body?.cancel();
      path = USAGE_QUEUE_PATH_V0;
      continue;
    }
    reads++;
    if (res.status === 401 || res.status === 403) throw new CliProxyApiError(`CLIProxyAPI refused the management key (${res.status})`, res.status);
    if (res.status === 404) throw new CliProxyApiError(`CLIProxyAPI at ${origin} has no usage queue (404). Turn on remote management and usage statistics`, 404);
    if (!res.ok) throw new CliProxyApiError(`CLIProxyAPI answered ${res.status} for the usage queue`, res.status);
    let page: unknown;
    try {
      page = await res.json();
    } catch {
      throw new CliProxyApiError("CLIProxyAPI's usage queue did not answer JSON");
    }
    const list = Array.isArray(page) ? page : isObj(page) && Array.isArray(page.items) ? page.items : undefined;
    if (!list) throw new CliProxyApiError("CLIProxyAPI's usage queue did not answer a list");
    if (list.length) {
      records.push(...list);
      await o.onRecords?.(list);
    }
    if (list.length < batch) break;
  }
  return { records, reads, path };
}

export interface CliProxyEnrichOptions {
  index: IndexStore;
  /** Sessions to join records to (gateway drain sessions are skipped). A record's own session is also looked up by id. */
  sessions: Session[];
  /**
   * Pops new records (drainUsageQueue). It gets `keep`, which stores what it
   * popped before anything else runs. Omit it to join only what earlier
   * runs kept (--offline, --dry-run).
   */
  drain?: (keep: (records: unknown[]) => Promise<void>) => Promise<unknown>;
  /** Applied to every record before it is stored. */
  redactor?: Redactor;
  dryRun?: boolean;
  now?: number;
}

export interface CliProxyEnrichReport {
  /** Records popped from the queue this run. */
  drained: number;
  /** Records kept from earlier runs. */
  carried: number;
  /** Records joined to a call this run. */
  joined: number;
  bySessionId: number;
  byTimeModel: number;
  /** Records already joined on an earlier run (same execution id). */
  alreadyEnriched: number;
  /** Records kept for a later run (no call yet). */
  kept: number;
  /** Unjoined records older than PENDING_TTL_MS, dropped. */
  expired: number;
  /** Companion spans written (or that would be, with dryRun). */
  enriched: number;
  /** Sum of upstream-reported cost over joined records. */
  billedUsd: number;
  touchedSessions: string[];
  errors: string[];
}

const recordKey = (u: CliProxyUsage): string => u.executionId ?? u.requestId ?? `${u.ts}\u0000${u.sessionId ?? ""}\u0000${u.model ?? ""}\u0000${u.totalTokens ?? 0}`;

async function readPending(index: IndexStore): Promise<CliProxyUsage[]> {
  const raw = index.kvGet ? await index.kvGet(PENDING_KEY) : undefined;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is CliProxyUsage => isObj(x) && typeof x.ts === "number") : [];
  } catch {
    return [];
  }
}

async function writePending(index: IndexStore, list: CliProxyUsage[]): Promise<void> {
  if (!index.kvSet) return;
  const kept = [...list].sort((a, b) => b.ts - a.ts).slice(0, PENDING_MAX);
  await index.kvSet(PENDING_KEY, JSON.stringify(kept));
}

/** Lowercase, without a `provider/` prefix or a `-YYYYMMDD` date suffix. */
const normModel = (m: string): string => m.toLowerCase().replace(/^[a-z0-9_.-]+\//, "").replace(/-\d{8}$/, "");

function recordModels(u: CliProxyUsage): string[] {
  return [u.responseModel, u.model, u.alias].filter((m): m is string => !!m).map(normModel);
}

function callModels(c: AgentEvent): string[] {
  return [c.model, c.payload.requestModel, c.payload.responseModel].filter((m): m is string => typeof m === "string" && !!m).map(normModel);
}

/** "match", "mismatch", or "unknown" when either side names no model. */
function modelFit(u: CliProxyUsage, c: AgentEvent): "match" | "mismatch" | "unknown" {
  const a = recordModels(u);
  const b = callModels(c);
  if (!a.length || !b.length) return "unknown";
  return a.some((x) => b.includes(x)) ? "match" : "mismatch";
}

/** Distance from a call to the request's span [ts, ts + latency]. */
function distance(u: CliProxyUsage, c: AgentEvent): number {
  const end = u.ts + (u.latencyMs ?? 0);
  return c.ts < u.ts ? u.ts - c.ts : c.ts > end ? c.ts - end : 0;
}

/** The companion span for one joined call. */
export function cliProxyEvent(call: AgentEvent, u: CliProxyUsage, linkedBy: "client-session-id" | "time-model"): AgentEvent {
  const p: Record<string, unknown> = { name: generationSpanName(CLIPROXYAPI), gateway: CLIPROXYAPI, llmEventId: call.id, linkedBy };
  const set = (k: string, v: unknown) => {
    if (v !== undefined) p[k] = v;
  };
  set("generationId", u.executionId ?? u.requestId);
  set("requestId", u.requestId);
  set("provider", u.provider);
  set("executorType", u.executorType);
  set("model", u.responseModel ?? u.model);
  set("requestModel", u.model);
  set("alias", u.alias);
  set("endpoint", u.endpoint);
  set("authType", u.authType);
  set("accountHash", u.accountHash);
  set("reasoningEffort", u.reasoningEffort);
  set("serviceTier", u.serviceTier);
  set("effectiveServiceTier", u.effectiveServiceTier);
  set("responseServiceTier", u.responseServiceTier);
  set("upstreamServiceTier", u.upstreamServiceTier);
  set("speed", u.speed);
  set("inferenceGeo", u.inferenceGeo);
  set("ttftMs", u.ttftMs);
  set("latencyMs", u.latencyMs);
  set("isCompaction", u.isCompaction);
  set("isFork", u.isFork);
  set("nodeKind", u.nodeKind);
  set("parentSessionId", u.parentSessionId);
  set("stream", u.stream);
  set("failed", u.failed);
  set("statusCode", u.statusCode);
  set("promptTokens", u.inputTokens);
  set("completionTokens", u.outputTokens);
  set("reasoningTokens", u.reasoningTokens);
  set("cachedTokens", u.cacheReadTokens);
  set("cacheCreationTokens", u.cacheCreationTokens);
  set("totalTokens", u.totalTokens);
  set("billedCostUsd", u.costUsd);
  set("isByok", u.isByok);
  const reported = call.usage?.costUsd;
  if (reported !== undefined && u.costUsd !== undefined) p.reportedCostUsd = reported;
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
  // As enrich.ts: the session total becomes what the upstream billed, without double counting.
  const delta = u.costUsd !== undefined ? Math.round((u.costUsd - (reported ?? 0)) * 1e10) / 1e10 : 0;
  if (delta !== 0) e.usage = { costUsd: delta };
  return e;
}

/** Drain (when asked), keep, join, write. See the file header. */
export async function enrichFromCliProxyApi(o: CliProxyEnrichOptions): Promise<CliProxyEnrichReport> {
  const { index } = o;
  const now = o.now ?? Date.now();
  const r: CliProxyEnrichReport = { drained: 0, carried: 0, joined: 0, bySessionId: 0, byTimeModel: 0, alreadyEnriched: 0, kept: 0, expired: 0, enriched: 0, billedUsd: 0, touchedSessions: [], errors: [] };

  // 1. What earlier runs kept, plus what the queue holds now (kept before anything else).
  const records = new Map<string, CliProxyUsage>();
  for (const u of await readPending(index)) records.set(recordKey(u), u);
  r.carried = records.size;
  if (o.drain && !o.dryRun) {
    const keep = async (raw: unknown[]) => {
      for (const x of raw) {
        const u = usageRecordOf(x);
        if (!u) continue;
        r.drained++;
        records.set(recordKey(u), o.redactor ? o.redactor.value(u) : u);
      }
      await writePending(index, [...records.values()]);
    };
    try {
      await o.drain(keep);
    } catch (e) {
      r.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!records.size) return r;

  // 2. Calls to join to: the sessions given, by session id root (subagents are `<id>:sub:<agent>`).
  const byRoot = new Map<string, AgentEvent[]>();
  const all: AgentEvent[] = [];
  const linked = new Set<string>();
  const linkedGens = new Set<string>();
  const loaded = new Set<string>();
  const load = async (sessionId: string) => {
    if (loaded.has(sessionId)) return;
    loaded.add(sessionId);
    const evs = await index.listEvents(sessionId, { kinds: ["llm.call", "span"] });
    for (const e of evs) {
      if (e.source !== ENRICH_SOURCE || !e.parentId) continue;
      linked.add(e.parentId);
      if (e.payload.gateway === CLIPROXYAPI && typeof e.payload.generationId === "string") linkedGens.add(e.payload.generationId);
    }
    const root = sessionId.split(":")[0]!.toLowerCase();
    const calls = evs.filter((e) => e.kind === "llm.call");
    byRoot.set(root, [...(byRoot.get(root) ?? []), ...calls]);
    all.push(...calls);
  };
  for (const s of o.sessions) if (s.agent !== GATEWAY_AGENT) await load(s.id);

  // 3. Join, oldest request first, each call at most once (calls enriched on an earlier run are taken).
  const taken = linked;
  const out: AgentEvent[] = [];
  const left: CliProxyUsage[] = [];
  for (const u of [...records.values()].sort((a, b) => a.ts - b.ts)) {
    let best: AgentEvent | undefined;
    let linkedBy: "client-session-id" | "time-model" = "client-session-id";
    let known = false;
    if (u.sessionId && !byRoot.has(u.sessionId) && (await index.getSession(u.sessionId))) await load(u.sessionId);
    const gen = u.executionId ?? u.requestId;
    if (gen && linkedGens.has(gen)) {
      r.alreadyEnriched++;
      continue;
    }
    if (u.sessionId) {
      const calls = byRoot.get(u.sessionId);
      known = !!calls;
      let bestFit = "";
      for (const c of calls ?? []) {
        if (taken.has(c.id)) continue;
        const fit = modelFit(u, c);
        const d = distance(u, c);
        if (fit === "mismatch" || d > SESSION_JOIN_MS) continue;
        const better = !best || (fit === "match" && bestFit !== "match") || (fit === bestFit && d < distance(u, best));
        if (better) {
          best = c;
          bestFit = fit;
        }
      }
    }
    if (!best && !known) {
      // No session to go by: the one call with this model at that time, or nothing.
      const near = all.filter((c) => !taken.has(c.id) && modelFit(u, c) === "match" && distance(u, c) <= TIME_JOIN_MS);
      if (near.length === 1) {
        best = near[0];
        linkedBy = "time-model";
      }
    }
    if (!best) {
      if (now - u.ts > PENDING_TTL_MS) r.expired++;
      else left.push(u);
      continue;
    }
    taken.add(best.id);
    r.joined++;
    if (linkedBy === "time-model") r.byTimeModel++;
    else r.bySessionId++;
    if (u.costUsd !== undefined) r.billedUsd += u.costUsd;
    out.push(cliProxyEvent(best, u, linkedBy));
  }
  r.kept = left.length;
  r.enriched = out.length;
  r.billedUsd = Math.round(r.billedUsd * 1e6) / 1e6;
  r.touchedSessions = [...new Set(out.map((e) => e.sessionId))];
  if (o.dryRun) return r;

  // 4. Write, then keep only what is still unjoined.
  if (out.length) {
    await index.putEvents(out);
    for (const id of r.touchedSessions) {
      const evs = await index.listEvents(id);
      if (evs.length) await index.upsertSession(buildSession(evs, await index.getSession(id)));
    }
  }
  await writePending(index, left);
  return r;
}
