// Turns one proxied call into an llm.call event and writes it, off the request
// path: the client already has every byte by the time this runs, and a store
// failure is reported, never thrown at the client.
//
// What is stored (capture.mode "full"): the request body, redacted, with its
// system prompt and tool definitions in blobs of their own (shared by every call
// that sends the same ones) and its messages as content-addressed blocks
// (blocks.ts: shared with the calls before it), the rebuilt response, an allowlist of headers
// (never Authorization, x-api-key, cookies or account ids), timings, usage and
// rate-limit numbers. In "metadata" mode: no content at all, only counts, names,
// timings, usage and short hashes of the system prompt and tools.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { errorClass, isObj, str } from "../adapters/_shared/normalize.ts";
import { hashParts, sha256Hex } from "../core/ids.ts";
import { type Prices, priceEvent } from "../core/pricing.ts";
import { type Redactor, toMetadata } from "../core/redact.ts";
import { buildSession } from "../core/sessions.ts";
import type { BlobStore, IndexStore } from "../core/types.ts";
import { type AgentEvent, SCHEMA_VERSION } from "../schema/index.ts";
import { messagesKey, putMessages, RecentBlobs } from "./blocks.ts";
import { accountHash, callLineage, type Client, detectClient, type Headers, type Lineage, type Link, linkCall, ResponseSessions, upstreamAuth } from "./link.ts";
import { type CallResult, compacted, parseRequest, type RequestInfo, type Route } from "./wire.ts";

export interface CapturedCall {
  route: Route;
  method: string;
  /** Path and query the client sent. */
  path: string;
  /** Upstream origin the call went to (no credentials, no path). */
  upstream: string;
  reqHeaders: Headers;
  /** Request body, or undefined when it was larger than the capture limit. */
  reqBody?: Buffer;
  reqBytes: number;
  status?: number;
  resHeaders?: IncomingHttpHeaders;
  result?: CallResult;
  resBytes: number;
  /** Response was an event stream. */
  stream: boolean;
  startedAt: number;
  /** Upstream response headers arrived. */
  headersAt?: number;
  /** First response body byte. */
  firstByteAt?: number;
  endedAt: number;
  /** The upstream could not be reached (or broke mid-response). */
  networkError?: string;
  /** The client went away before the response finished. */
  aborted?: boolean;
}

export interface RecorderOptions {
  blobs: BlobStore;
  redactor: Redactor;
  /** capture.mode = "metadata": store no content. */
  metadata: boolean;
  prices: Prices;
  /** Writes a batch of events (and rebuilds their sessions). Called one batch at a time. */
  write: (events: AgentEvent[]) => Promise<void>;
  /** Set on every event (serve). */
  project?: string;
  /** false: store each request body whole (format 1) instead of in message blocks; for benchmarks. */
  blocks?: boolean;
  onError?: (err: Error) => void;
  /** Called with each event after it is written. */
  onEvent?: (e: AgentEvent) => void;
}

export interface Recorder {
  /** Records a call in the background (a promise: the response may still be decoding). Never throws. */
  record(call: CapturedCall | Promise<CapturedCall | undefined>): void;
  /** Resolves once every recorded call is written (or has failed). */
  flush(): Promise<void>;
  /** Calls written, and calls whose write failed. */
  readonly stats: { written: number; failed: number };
}

const REQUEST_HEADERS = /^(?:anthropic-version|anthropic-beta|content-type|user-agent|x-app|x-stainless-[\w-]+|originator|openai-beta|openai-organization|openai-project|x-claude-code-session-id|session-id|session_id|thread-id|x-client-request-id|x-coding-sh-session)$/;
const RESPONSE_HEADERS = /^(?:content-type|request-id|x-request-id|openai-processing-ms|openai-version|retry-after|retry-after-ms|x-should-retry|anthropic-ratelimit-[\w-]+|x-ratelimit-[\w-]+|cf-ray)$/;

function pick(h: Headers | IncomingHttpHeaders | undefined, allow: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    if (v === undefined || !allow.test(key)) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

const RATE_LIMITS: Record<string, string> = {
  "anthropic-ratelimit-requests-limit": "rlRequestsLimit",
  "anthropic-ratelimit-requests-remaining": "rlRequestsRemaining",
  "anthropic-ratelimit-tokens-limit": "rlTokensLimit",
  "anthropic-ratelimit-tokens-remaining": "rlTokensRemaining",
  "anthropic-ratelimit-input-tokens-remaining": "rlInputTokensRemaining",
  "anthropic-ratelimit-output-tokens-remaining": "rlOutputTokensRemaining",
  "anthropic-ratelimit-unified-5h-utilization": "rlUnified5hUtilization",
  "anthropic-ratelimit-unified-7d-utilization": "rlUnified7dUtilization",
  "x-ratelimit-limit-requests": "rlRequestsLimit",
  "x-ratelimit-remaining-requests": "rlRequestsRemaining",
  "x-ratelimit-limit-tokens": "rlTokensLimit",
  "x-ratelimit-remaining-tokens": "rlTokensRemaining",
};

/** Rate-limit numbers from response headers, flattened for the payload. */
export function rateLimits(h: IncomingHttpHeaders | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!h) return out;
  for (const [header, key] of Object.entries(RATE_LIMITS)) {
    const v = Number(h[header]);
    if (h[header] !== undefined && Number.isFinite(v)) out[key] = v;
  }
  const ms = Number(h["retry-after-ms"]);
  const s = Number(h["retry-after"]);
  if (h["retry-after-ms"] !== undefined && Number.isFinite(ms)) out.retryAfterMs = ms;
  else if (h["retry-after"] !== undefined && Number.isFinite(s)) out.retryAfterMs = s * 1000;
  return out;
}

/** Coarse error class of a failed call, for filters and charts (shared with the adapters). */
export { errorClass };

const MAX_TOOL_NAMES = 64;
const PROMPT_PREVIEW = 280;

const parseJson = (b: Buffer | undefined): unknown => {
  if (!b?.length) return undefined;
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return undefined;
  }
};

/** A short hash for comparing system prompts and tool sets (metadata mode keeps it). */
export const shortHash = (sha: string): string => sha.slice(0, 16);

interface Content {
  systemSha?: string;
  toolsSha?: string;
  requestRef?: string;
  responseRef?: string;
  /** The request's messages went to blocks (format 2). */
  paged?: boolean;
}

/**
 * Claude Code's metadata.user_id names the account (`account_uuid`): it is
 * stored as `hash:` and the payload's accountHash, never as sent.
 */
function hashAccount(body: Record<string, unknown>): void {
  const md = body.metadata;
  if (!isObj(md) || typeof md.user_id !== "string" || !md.user_id.startsWith("{")) return;
  try {
    const u = JSON.parse(md.user_id) as Record<string, unknown>;
    if (typeof u.account_uuid !== "string" || !u.account_uuid || u.account_uuid.startsWith("hash:")) return;
    u.account_uuid = `hash:${accountHash(u.account_uuid)}`;
    body.metadata = { ...md, user_id: JSON.stringify(u) };
  } catch {
    // Not JSON: left as the redactor left it.
  }
}

/** Field of the request body that holds the system prompt, per API (chat keeps it in messages). */
const systemField = (api: string): string | undefined => (api === "messages" || api === "count_tokens" ? "system" : api === "responses" ? "instructions" : undefined);

/**
 * The stored form of a request: its body with the system prompt and tools
 * replaced by `{ "$blob": ref }` when they went to blobs of their own, and its
 * messages by pages of message blocks (blocks.ts). `loadCall` (calls.ts) puts
 * them back.
 */
async function storeContent(call: CapturedCall, body: unknown, info: RequestInfo | undefined, o: RecorderOptions, recent: RecentBlobs): Promise<Content> {
  const red = o.redactor;
  const out: Content = {};
  const sysField = systemField(call.route.api);
  const rawSystem = info?.systemRaw;
  const sysText = rawSystem !== undefined ? JSON.stringify(red.value(rawSystem)) : undefined;
  const toolsText = info?.tools.length ? JSON.stringify(red.value(info.tools)) : undefined;
  if (sysText) out.systemSha = sha256Hex(sysText);
  if (toolsText) out.toolsSha = sha256Hex(toolsText);
  if (o.metadata) return out;
  if (sysText && sysField) await o.blobs.put(sysText);
  if (toolsText) await o.blobs.put(toolsText);
  if (body !== undefined) {
    const stored: Record<string, unknown> = { ...(red.value(body) as Record<string, unknown>) };
    hashAccount(stored);
    if (sysText && sysField && stored[sysField] !== undefined) stored[sysField] = { $blob: out.systemSha };
    if (toolsText && stored.tools !== undefined) stored.tools = { $blob: out.toolsSha };
    const key = o.blocks === false ? undefined : messagesKey(call.route.api, stored);
    if (key) {
      stored[key] = await putMessages(o.blobs, stored[key] as unknown[], recent);
      out.paged = true;
    }
    const doc = { v: key ? 2 : 1, provider: call.route.provider, api: call.route.api, method: call.method, path: call.path.split("?")[0], headers: pick(call.reqHeaders, REQUEST_HEADERS), body: stored };
    out.requestRef = await o.blobs.put(JSON.stringify(doc));
  }
  if (call.result?.body !== undefined || call.status !== undefined) {
    const doc = { v: 1, status: call.status, headers: pick(call.resHeaders, RESPONSE_HEADERS), body: call.result?.body !== undefined ? red.value(call.result.body) : undefined };
    out.responseRef = await o.blobs.put(JSON.stringify(doc));
  }
  return out;
}

export function buildPayload(call: CapturedCall, info: RequestInfo | undefined, client: Client, content: Content, linkedBy: string): Record<string, unknown> {
  const r = call.result;
  const p: Record<string, unknown> = { provider: call.route.provider, api: call.route.api };
  if (info?.model) p.requestModel = info.model;
  if (r?.model) p.responseModel = r.model;
  const status = call.status;
  if (status !== undefined) p.statusCode = status;
  const errType = r?.error?.type;
  const failed = !!call.networkError || (status !== undefined && status >= 400) || (!!r?.error && !call.aborted);
  p.ok = !failed;
  if (failed) {
    const msg = call.networkError ?? r?.error?.message ?? (status ? `HTTP ${status}` : "failed");
    p.error = msg.slice(0, 500);
    const cls = errorClass(status, errType, call.networkError);
    if (cls) p.errorClass = cls;
    if (errType) p.errorType = errType;
  }
  if (call.aborted) p.aborted = true;
  p.stream = call.stream;
  if (r?.firstTokenAt !== undefined) p.ttftMs = Math.max(0, r.firstTokenAt - call.startedAt);
  if (call.firstByteAt !== undefined) p.ttfbMs = Math.max(0, call.firstByteAt - call.startedAt);
  if (r?.stopReason) p.stopReason = r.stopReason;
  const out = r?.usage?.outputTokens;
  const genMs = r?.firstTokenAt !== undefined ? call.endedAt - r.firstTokenAt : call.endedAt - call.startedAt;
  if (out && genMs > 0) p.tokensPerSec = Math.round((out / (genMs / 1000)) * 10) / 10;
  // Anthropic message ids are what Claude Code's transcript calls messageId; Responses/Chat ids are responseId.
  if (r?.id) p[call.route.provider === "anthropic" ? "messageId" : "responseId"] = r.id;
  const requestId = str(call.resHeaders?.["request-id"]) ?? str(call.resHeaders?.["x-request-id"]);
  if (requestId) p.requestId = requestId;
  Object.assign(p, r?.hints ?? {}, rateLimits(call.resHeaders));
  if (content.systemSha) p.systemHash = shortHash(content.systemSha);
  if (content.toolsSha) p.toolsHash = shortHash(content.toolsSha);
  if (info) {
    p.toolCount = info.tools.length;
    if (info.toolNames.length) p.toolNames = info.toolNames.slice(0, MAX_TOOL_NAMES);
    p.messageCount = info.messages.length;
    if (info.prompt) p.prompt = info.prompt.length > PROMPT_PREVIEW ? `${info.prompt.slice(0, PROMPT_PREVIEW - 1)}…` : info.prompt;
    // Anthropic sends effort as output_config.effort, OpenAI as reasoning.effort (Responses) or reasoning_effort (Chat).
    const effort = str((info.params.reasoning as Record<string, unknown> | undefined)?.effort) ?? str(info.params.reasoning_effort) ?? str((info.params.output_config as Record<string, unknown> | undefined)?.effort);
    if (effort) p.reasoningEffort = effort;
    // What the response reports wins; else what the request asked for (kept apart when they differ).
    const askedTier = str(info.params.service_tier);
    if (p.serviceTier === undefined && askedTier) p.serviceTier = askedTier;
    else if (askedTier && askedTier !== p.serviceTier) p.requestedServiceTier = askedTier;
    if (p.speed === undefined && str(info.params.speed)) p.speed = str(info.params.speed);
    const thinking = info.params.thinking as Record<string, unknown> | undefined;
    if (typeof thinking?.budget_tokens === "number") p.thinkingBudget = thinking.budget_tokens;
    const maxTokens = info.params.max_tokens ?? info.params.max_output_tokens ?? info.params.max_completion_tokens;
    if (typeof maxTokens === "number") p.maxTokens = maxTokens;
    if (typeof info.params.temperature === "number") p.temperature = info.params.temperature;
  }
  if (compacted(call.route, r?.body)) p.compaction = true;
  if (call.route.api === "count_tokens") {
    p.name = "count_tokens";
    if (r?.inputTokens !== undefined) p.inputTokens = r.inputTokens;
  }
  if (client.id) p.client = client.id;
  if (client.version) p.clientVersion = client.version;
  p.linkedBy = linkedBy;
  p.upstream = call.upstream;
  p.requestBytes = call.reqBytes;
  p.responseBytes = call.resBytes;
  if (call.reqBody === undefined && call.reqBytes > 0) p.requestTruncated = true;
  if (content.requestRef) p.requestRef = content.requestRef;
  if (content.requestRef && content.paged) p.requestPaged = true;
  if (content.responseRef) p.responseRef = content.responseRef;
  if (content.systemSha && content.requestRef && systemField(call.route.api)) p.systemRef = content.systemSha;
  if (content.toolsSha && content.requestRef) p.toolsRef = content.toolsSha;
  return p;
}

/** Stores events and rebuilds their sessions. A session the proxy creates gets parseVersion 0 (re-parse leaves it alone; ingest stamps it). */
/**
 * Payload fields that place a call among sessions (callLineage, link.ts):
 * `parentSessionId` (the session that spawned this one; for a Claude Code
 * subagent, its parent's), `agentId`, `parentAgentId`, `agentType`,
 * `forkedFromSessionId`, `subagentKind`, `accountHash`, and `upstreamAuth`
 * (CLIProxyAPI's credential index). Each is absent when the client sent nothing.
 */
export function lineagePayload(l: Lineage, link: Link, resHeaders: Headers | undefined): Record<string, string> {
  const p: Record<string, string> = {};
  const parent = link.parentSessionId ?? l.parentSessionId;
  if (parent && parent !== link.sessionId) p.parentSessionId = parent;
  if (l.agentId) p.agentId = l.agentId;
  if (l.parentAgentId) p.parentAgentId = l.parentAgentId;
  if (l.agentType) p.agentType = l.agentType;
  if (l.forkedFromSessionId) p.forkedFromSessionId = l.forkedFromSessionId;
  if (l.subagentKind) p.subagentKind = l.subagentKind;
  if (l.accountHash) p.accountHash = l.accountHash;
  const auth = upstreamAuth(resHeaders);
  if (auth) p.upstreamAuth = auth;
  return p;
}

export function storeWriter(store: IndexStore): (events: AgentEvent[]) => Promise<void> {
  return async (events) => {
    await store.putEvents(events);
    for (const id of new Set(events.map((e) => e.sessionId))) {
      const all = await store.listEvents(id);
      if (!all.length) continue;
      const prev = await store.getSession(id);
      const session = buildSession(all, prev);
      if (!prev) session.parseVersion = 0;
      await store.upsertSession(session);
    }
  };
}

export function createRecorder(o: RecorderOptions): Recorder {
  const responses = new ResponseSessions();
  const recent = new RecentBlobs();
  const pending: AgentEvent[] = [];
  const building = new Set<Promise<void>>();
  // The last recorded call's queueing: each event joins `pending` after the one recorded before it.
  let queued: Promise<void> = Promise.resolve();
  let draining: Promise<void> | undefined;
  let seq = 0;
  const stats = { written: 0, failed: 0 };
  const report = (err: unknown) => {
    try {
      o.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // A failing error handler must not break the proxy either.
    }
  };

  const drain = async () => {
    while (pending.length) {
      const batch = pending.splice(0);
      try {
        await o.write(batch);
        stats.written += batch.length;
        for (const e of batch) o.onEvent?.(e);
      } catch (err) {
        stats.failed += batch.length;
        report(err);
      }
    }
  };

  const kick = (): void => {
    if (draining || !pending.length) return;
    draining = drain().finally(() => {
      draining = undefined;
      kick();
    });
  };

  const build = async (pending: CapturedCall | Promise<CapturedCall | undefined>): Promise<AgentEvent | undefined> => {
    const call = await pending;
    if (!call || call.route.api === "other") return undefined;
    const body = parseJson(call.reqBody);
    const info = body !== undefined ? parseRequest(call.route.api, body) : undefined;
    const client = detectClient(call.reqHeaders);
    const content = await storeContent(call, body, info, o, recent);
    const lineage = callLineage(call.reqHeaders, client, info);
    const link = linkCall(call.reqHeaders, client, info, content.systemSha ? shortHash(content.systemSha) : undefined, responses, lineage);
    if (call.route.api === "responses") responses.set(call.result?.id, link.sessionId);
    const payload = buildPayload(call, info, client, content, link.linkedBy);
    Object.assign(payload, lineagePayload(lineage, link, call.resHeaders));
    const e: AgentEvent = {
      id: hashParts("proxy", link.sessionId, call.startedAt, seq++, randomUUID()),
      v: SCHEMA_VERSION,
      sessionId: link.sessionId,
      ts: call.startedAt,
      durationMs: Math.max(0, call.endedAt - call.startedAt),
      source: "proxy",
      agent: link.agent,
      kind: call.route.api === "count_tokens" ? "span" : "llm.call",
      payload,
    };
    const model = call.result?.model ?? info?.model;
    if (model) e.model = model;
    if (link.agent === client.id && client.version) e.agentVersion = client.version;
    if (client.turnId && link.agent === "codex") e.turnId = client.turnId;
    if (link.subagentId) e.subagentId = link.subagentId;
    if (call.result?.usage && e.kind === "llm.call") e.usage = { ...call.result.usage };
    const refs = [content.requestRef, content.responseRef, payload.systemRef, payload.toolsRef].filter((r): r is string => typeof r === "string");
    if (refs.length) e.blobs = [...new Set(refs)];
    if (o.project) e.project = o.project;
    let ev = o.redactor.event(e);
    if (o.metadata) ev = toMetadata(ev);
    return priceEvent(ev, o.prices);
  };

  return {
    stats,
    record(call) {
      // Builds run side by side, but their events are written in the order the calls were
      // recorded: two calls in the same millisecond have the same ts, and the store keeps
      // those in the order it got them.
      const before = queued;
      const p = build(call)
        .catch((err: unknown) => {
          stats.failed++;
          report(err);
          return undefined;
        })
        .then(async (e) => {
          await before;
          if (!e) return;
          pending.push(e);
          kick();
        })
        .finally(() => building.delete(p));
      queued = p;
      building.add(p);
    },
    async flush() {
      while (building.size || draining) {
        await Promise.all([...building]);
        await draining;
      }
    },
  };
}
