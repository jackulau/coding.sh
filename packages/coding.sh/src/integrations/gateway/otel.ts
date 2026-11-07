// OTLP enrichment for AI Gateway traffic (a SpanEnricher, see src/otel/map.ts).
//
// Two span sources:
//
// 1. The gateway's own traces, forwarded by a Vercel trace drain
//    (vercel.com/docs/ai-gateway/observability-and-spend/trace-drains):
//    resource service.name "ai-gateway" / service.namespace "vercel", one trace
//    per request. The root span `<operation> <model>` carries gen_ai.* usage plus
//    vercel.ai_gateway.* cost, provider and generation id; child spans are
//    routing, model attempts and one `<model> (<provider>)` span per upstream
//    call. Mapped as: root → one llm.call; every other span → a plain "span"
//    (a failover must not count as extra model calls). Requests have no
//    conversation id, so they are grouped into one session per UTC day
//    (`ai-gateway-YYYY-MM-DD`, agent "ai-gateway"). The drain mirrors calls an
//    agent capture may also record, so its tokens and cost go in
//    payload.reportedUsage (not summed); `coding.sh gateway enrich` copies the
//    billed cost onto the agent's own llm.call instead.
//
// 2. App spans from the AI SDK (`ai.*.doGenerate|doStream`) whose model
//    provider is the `gateway` provider, or any GenAI span whose response id is
//    a gateway generation id: the llm.call is tagged payload.gateway = "vercel"
//    and payload.gatewayGenerationId, and a cost from providerMetadata.gateway
//    fills usage.costUsd when the span reported none.
//
// 3. Other gateways (providers.ts), from their own OTel export or from app
//    spans that called them. Recognized by resource service.name (portkey,
//    bifrost, tfy-llm-gateway, litellm), gateway attribute prefixes
//    (litellm.*, portkey.*, tfy.*, span.metadata.openrouter_*), Cloudflare's
//    gen_ai.prompt_json / gen_ai.completion_json, an AI SDK provider
//    (`openrouter.chat`), a response id with a gateway's shape, or a
//    server.address on a gateway host. The llm.call gets payload.gateway, the
//    request id `gateway enrich` can look up, the serving provider and the
//    gateway's cost (gen_ai.cost.total_cost, gen_ai.usage.cost_usd,
//    providerMetadata.openrouter.usage.cost).
import type { OtelSpan, OtelValue } from "../../otel/model.ts";
import type { SpanEnrichInfo } from "../../otel/map.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import { GATEWAY_AGENT, GATEWAY_ID, isGatewayProvider, isGenerationId, virtualModelId } from "./ids.ts";
import { gatewayForId, gatewayForProvider, gatewayForUrl, GATEWAYS, type GatewayId } from "./providers.ts";

type Attrs = Record<string, OtelValue>;

const str = (a: Attrs, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;
};
const num = (v: unknown): number | undefined => {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for spans exported by the gateway itself (a trace drain). */
export function isGatewayDrainSpan(resource: Attrs): boolean {
  const service = str(resource, "service.name");
  const ns = str(resource, "service.namespace");
  return service === "ai-gateway" && (ns === undefined || ns === "vercel");
}

/** Session id for a drained request: one per UTC day. */
export const drainSessionId = (ts: number): string => `${GATEWAY_AGENT}-${new Date(ts).toISOString().slice(0, 10)}`;

const DRAIN_DROP = new Set(["session.start", "session.end", "turn.end", "user.message"]);

function usd(a: Attrs, costKey: string, currencyKey: string): number | undefined {
  const cur = str(a, currencyKey);
  if (cur && cur.toUpperCase() !== "USD") return undefined;
  return num(a[costKey]);
}

function drainLlmPayload(a: Attrs, e: AgentEvent): void {
  const p = e.payload;
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== "") p[k] = v;
  };
  set("gateway", GATEWAY_ID);
  set("gatewayGenerationId", str(a, "vercel.ai_gateway.generation.id"));
  set("gatewayRequestId", str(a, "vercel.ai_gateway.request.id"));
  set("servedProvider", str(a, "vercel.ai_gateway.provider"));
  set("apiFormat", str(a, "vercel.ai_gateway.api_format"));
  set("credentialType", str(a, "vercel.ai_gateway.credential.type"));
  set("serviceTier", str(a, "vercel.ai_gateway.service_tier"));
  set("region", str(a, "vercel.ai_gateway.region"));
  set("tags", str(a, "vercel.ai_gateway.tags"));
  set("apiKeyName", str(a, "vercel.ai_gateway.api_key.name"));
  set("reasoningTokens", num(a["gen_ai.usage.reasoning.output_tokens"]));
  // gen_ai.request.model is the slug the client asked for, gen_ai.response.model the resolved model.
  const virtual = virtualModelId(str(a, "gen_ai.request.model"));
  set("virtualModel", virtual);
  set("resolvedModel", virtual ? str(a, "gen_ai.response.model") : undefined);
  // Client session id, should the drain carry one (`session.id`; not in the Nov 2026 attribute list).
  set("gatewaySessionId", str(a, "session.id") ?? str(a, "vercel.ai_gateway.session.id"));
  set("status", num(a["http.response.status_code"]));
  const billed = usd(a, "vercel.ai_gateway.cost.total", "vercel.ai_gateway.cost.currency");
  const market = usd(a, "vercel.ai_gateway.cost.market", "vercel.ai_gateway.cost.market_currency");
  set("billedCostUsd", billed);
  set("marketCostUsd", market);
  // A mirror of a call the agent's own capture may also record: report, don't sum.
  const reported: Usage = { ...(e.usage ?? {}) };
  if (billed !== undefined) reported.costUsd = billed;
  if (Object.keys(reported).length) p.reportedUsage = reported;
  delete e.usage;
}

function drainSpanPayload(a: Attrs, span: OtelSpan, e: AgentEvent): AgentEvent {
  const keep = (k: string, v: unknown, into: Record<string, unknown>) => {
    if (v !== undefined && v !== "") into[k] = v;
  };
  const p: Record<string, unknown> = { name: span.name, gateway: GATEWAY_ID };
  const success = a["vercel.ai_gateway.attempt.success"] ?? a["vercel.ai_gateway.model_attempt.success"];
  keep("ok", success === false ? false : e.payload.ok, p);
  keep("error", e.payload.error ?? str(a, "error.type"), p);
  keep("provider", str(a, "gen_ai.provider.name"), p);
  keep("requestModel", str(a, "gen_ai.request.model"), p);
  keep("status", num(a["http.response.status_code"]), p);
  keep("attemptId", str(a, "vercel.ai_gateway.attempt.id"), p);
  keep("attemptNumber", num(a["vercel.ai_gateway.attempt.number"]), p);
  keep("isFinal", a["vercel.ai_gateway.attempt.is_final"], p);
  keep("success", success, p);
  keep("providerRequestId", str(a, "vercel.ai_gateway.attempt.provider_request_id"), p);
  keep("providerResponseId", str(a, "vercel.ai_gateway.attempt.provider_response_id"), p);
  keep("providerTimeout", a["vercel.ai_gateway.attempt.provider_timeout"], p);
  if (e.kind === "span" && isObj(e.payload.attributes)) p.attributes = e.payload.attributes;
  const out: AgentEvent = { ...e, kind: "span", payload: p };
  delete out.usage;
  delete out.model;
  return out;
}

function enrichDrain(span: OtelSpan, events: AgentEvent[]): AgentEvent[] {
  const a = span.attributes;
  const out: AgentEvent[] = [];
  for (const ev of events) {
    if (DRAIN_DROP.has(ev.kind)) continue;
    const e: AgentEvent = { ...ev, payload: { ...ev.payload }, agent: GATEWAY_AGENT, sessionId: drainSessionId(ev.ts) };
    delete e.turnId;
    // Only the root span is the request; attempts and routing are detail.
    if (e.kind === "llm.call" && !span.parentSpanId) {
      drainLlmPayload(a, e);
      out.push(e);
    } else if (e.kind === "llm.call" || e.kind === "span") out.push(drainSpanPayload(a, span, e));
    else out.push(e); // error events from span exceptions
  }
  return out;
}

/** providerMetadata.<key> from an AI SDK span (JSON string or object attribute). */
function providerMetadata(a: Attrs, key = "gateway"): Record<string, unknown> | undefined {
  const raw = a["ai.response.providerMetadata"];
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return isObj(v) && isObj(v[key]) ? v[key] : undefined;
}

/** resource service.name values gateways export under. */
const SERVICE_NAMES: Record<string, GatewayId> = { portkey: "portkey", bifrost: "bifrost", "tfy-llm-gateway": "truefoundry", litellm: "litellm", "litellm-proxy": "litellm" };
/** Attribute prefixes only one gateway writes. */
const ATTR_PREFIXES: [string, GatewayId][] = [
  ["litellm.", "litellm"],
  ["portkey.", "portkey"],
  ["tfy.", "truefoundry"],
  ["span.metadata.openrouter_", "openrouter"],
];

/** The non-Vercel gateway a span belongs to, and whether the gateway itself exported it. */
function otherGateway(a: Attrs, resource: Attrs): { id: GatewayId; exported: boolean } | undefined {
  const service = str(resource, "service.name")?.toLowerCase();
  if (service && SERVICE_NAMES[service]) return { id: SERVICE_NAMES[service], exported: true };
  if (service && /cloudflare/.test(service)) return { id: "cloudflare", exported: true };
  const keys = Object.keys(a);
  for (const [prefix, id] of ATTR_PREFIXES) if (keys.some((k) => k.startsWith(prefix))) return { id, exported: true };
  // Cloudflare's exporter writes prompt and completion as *_json attributes.
  if (a["gen_ai.prompt_json"] !== undefined || a["gen_ai.completion_json"] !== undefined) return { id: "cloudflare", exported: true };
  const viaProvider = gatewayForProvider(str(a, "ai.model.provider")) ?? gatewayForProvider(str(a, "gen_ai.provider.name")) ?? gatewayForProvider(str(a, "gen_ai.system"));
  if (viaProvider && viaProvider !== GATEWAY_ID) return { id: viaProvider, exported: false };
  const byId = gatewayForId(str(a, "gen_ai.response.id") ?? str(a, "ai.response.id"));
  if (byId && byId !== GATEWAY_ID) return { id: byId, exported: false };
  const host = str(a, "server.address");
  const byUrl = gatewayForUrl(host ? `https://${host}` : (str(a, "url.full") ?? str(a, "http.url")));
  if (byUrl && byUrl !== GATEWAY_ID) return { id: byUrl, exported: false };
  return undefined;
}

function enrichOther(span: OtelSpan, events: AgentEvent[], resource: Attrs): AgentEvent[] {
  const a = span.attributes;
  const gw = otherGateway(a, resource);
  if (!gw) return events;
  const responseId = str(a, "gen_ai.response.id") ?? str(a, "ai.response.id");
  // The id the gateway's lookup API takes: LiteLLM's call id, or a response id with the gateway's shape.
  const requestId = gw.id === "litellm" ? str(a, "litellm.call_id") : responseId && gatewayForId(responseId) === gw.id ? responseId : undefined;
  const sdk = gw.id === "openrouter" ? providerMetadata(a, "openrouter") : undefined;
  const sdkUsage = isObj(sdk?.usage) ? sdk.usage : undefined;
  const gatewayNames = new Set(GATEWAYS[gw.id].providers);
  const upstream = [typeof sdk?.provider === "string" ? sdk.provider : undefined, gw.exported ? (str(a, "gen_ai.provider.name") ?? str(a, "gen_ai.model.provider") ?? str(a, "gen_ai.system")) : undefined].find(
    (x): x is string => typeof x === "string" && x !== "" && !gatewayNames.has(x.toLowerCase()),
  );
  const cost = num(a["gen_ai.cost.total_cost"]) ?? num(a["gen_ai.usage.cost_usd"]) ?? num(sdkUsage?.cost) ?? num(a["gen_ai.usage.cost"]);
  // Portkey's own cost attribute: kept as reported, its unit is not documented for OTel.
  const portkeyCost = num(a["portkey.usage.cost"]);
  for (const e of events) {
    if (e.kind !== "llm.call") continue;
    e.payload.gateway = gw.id;
    if (requestId) e.payload.gatewayGenerationId = requestId;
    if (upstream) e.payload.servedProvider = upstream;
    if (portkeyCost !== undefined) {
      e.payload.gatewayCost = portkeyCost;
      const cur = str(a, "portkey.usage.cost_currency");
      if (cur) e.payload.gatewayCostCurrency = cur;
    }
    if (cost !== undefined) {
      e.payload.billedCostUsd = cost;
      if (e.usage?.costUsd === undefined) e.usage = { ...(e.usage ?? {}), costUsd: cost };
    }
  }
  return events;
}

function enrichApp(span: OtelSpan, events: AgentEvent[], resource: Attrs = {}): AgentEvent[] {
  const a = span.attributes;
  const meta = providerMetadata(a);
  const responseId = str(a, "gen_ai.response.id") ?? str(a, "ai.response.id");
  const viaProvider = isGatewayProvider(str(a, "ai.model.provider")?.split(".")[0]);
  const genId = [meta?.generationId, responseId].find(isGenerationId);
  if (!viaProvider && !meta && !genId) return enrichOther(span, events, resource);
  const routing = isObj(meta?.routing) ? meta.routing : undefined;
  const served = [routing?.finalProvider, routing?.resolvedProvider].find((x): x is string => typeof x === "string" && x !== "");
  const cost = num(meta?.cost);
  // Session affinity: the session id the gateway used (x-session-id, providerOptions.gateway.sessionId,
  // x-claude-code-session-id, or a fingerprint) and where it came from.
  const clientSessionId = typeof routing?.clientSessionId === "string" && routing.clientSessionId ? routing.clientSessionId : undefined;
  const clientSessionSource = typeof routing?.clientSessionIdSource === "string" ? routing.clientSessionIdSource : undefined;
  // A `vmc/` virtual model: keep the slug and the model it resolved to.
  const virtual = virtualModelId(str(a, "ai.model.id") ?? str(a, "gen_ai.request.model"));
  const vmc = isObj(meta?.virtualModelConfig) ? meta.virtualModelConfig : undefined;
  const resolved = virtual ? ([vmc?.modelId, str(a, "gen_ai.response.model"), str(a, "ai.response.model")].find((x): x is string => typeof x === "string" && x !== "" && !virtualModelId(x))) : undefined;
  for (const e of events) {
    if (e.kind !== "llm.call") continue;
    e.payload.gateway = GATEWAY_ID;
    if (genId) e.payload.gatewayGenerationId = genId;
    if (served) e.payload.servedProvider = served;
    if (clientSessionId) e.payload.gatewaySessionId = clientSessionId;
    if (clientSessionSource) e.payload.gatewaySessionIdSource = clientSessionSource;
    if (virtual) e.payload.virtualModel = virtual;
    if (resolved) e.payload.resolvedModel = resolved;
    if (cost !== undefined) {
      e.payload.billedCostUsd = cost;
      if (e.usage?.costUsd === undefined) e.usage = { ...(e.usage ?? {}), costUsd: cost };
    }
  }
  return events;
}

/** SpanEnricher for gateway traffic. Returns `events` unchanged for unrelated spans. */
export function enrichGatewaySpan(span: OtelSpan, events: AgentEvent[], info: SpanEnrichInfo): AgentEvent[] {
  if (isGatewayDrainSpan(info.resource)) return enrichDrain(span, events);
  return enrichApp(span, events, info.resource);
}
