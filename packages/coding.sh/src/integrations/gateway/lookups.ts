// Per-request lookup clients for gateways other than Vercel (client.ts). Each
// maps the gateway's record to the same whitelisted GenerationInfo, so
// enrich.ts treats them alike. Shapes from docs/research/gateways.md:
//
// - OpenRouter  GET {base}/generation?id=gen-…   { data: { total_cost, provider_name, … } }
//               GET {base}/credits                { data: { total_credits, total_usage } }
// - LiteLLM     GET {base}/spend/logs?request_id= [ { request_id, spend, model, … } ]
// - Cloudflare  GET {base}/accounts/{a}/ai-gateway/gateways/{g}/logs/{id}
//                                                 { result: { cost, provider, model, tokens_in, … }, success }
// - Portkey     GET {base}/logs/{id}              (x-portkey-api-key; cost in cents)
// - Helicone    GET {base}/v1/request/{id}?includeBody=false
//                                                 { data: { costUSD, provider, model, … }, error }
//
// Keys go only into the auth header and are scrubbed from errors.
import { fetchJson, HttpError, type FetchLike, type RetryOpts } from "../../judge/http.ts";
import { createGatewayClient, parseGeneration, type Credits, type GatewayClient, type GenerationInfo, type GenerationLookup } from "./client.ts";
import type { GatewayConfig } from "./config.ts";
import { GATEWAYS, type GatewayId } from "./providers.ts";

export interface LookupOpts {
  fetch?: FetchLike;
  retry?: RetryOpts;
}

const n = (v: unknown): number | undefined => {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function info(id: string, fields: Partial<Omit<GenerationInfo, "id">>): GenerationInfo {
  const out: GenerationInfo = { id };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

/** `anthropic` from `anthropic/claude-sonnet-4-5`. */
const providerOfModel = (model: string | undefined): string | undefined => (model && model.includes("/") ? model.split("/")[0] : undefined);

/** LiteLLM /spend/logs row → GenerationInfo. */
export function parseLiteLLMSpendLog(row: Record<string, unknown>): GenerationInfo | undefined {
  const id = s(row.request_id);
  if (!id) return undefined;
  const model = s(row.model);
  const start = s(row.startTime);
  const end = s(row.endTime);
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  return info(id, {
    totalCostUsd: n(row.spend),
    provider: s(row.custom_llm_provider) ?? providerOfModel(model) ?? providerOfModel(s(row.model_group)),
    model,
    createdAt: start,
    generationMs: Number.isFinite(ms) && ms >= 0 ? ms : undefined,
    promptTokens: n(row.prompt_tokens),
    completionTokens: n(row.completion_tokens),
  });
}

/** Cloudflare AI Gateway log `result` → GenerationInfo. */
export function parseCloudflareLog(r: Record<string, unknown>): GenerationInfo | undefined {
  const id = s(r.id);
  if (!id) return undefined;
  return info(id, {
    // custom_cost is a user-set price that replaces Cloudflare's own.
    totalCostUsd: n(r.custom_cost) ?? n(r.cost),
    provider: s(r.provider),
    model: s(r.model),
    createdAt: s(r.created_at),
    generationMs: n(r.duration),
    promptTokens: n(r.tokens_in),
    completionTokens: n(r.tokens_out),
  });
}

/** Portkey log → GenerationInfo. Field names follow the logs export list; cost is in cents. */
export function parsePortkeyLog(r: Record<string, unknown>): GenerationInfo | undefined {
  const id = s(r.id);
  if (!id) return undefined;
  const cur = s(r.cost_currency);
  const cents = cur && cur.toUpperCase() !== "USD" ? undefined : n(r.cost);
  return info(id, {
    totalCostUsd: cents !== undefined ? Math.round(cents * 1e8) / 1e10 : undefined,
    provider: s(r.ai_org) ?? s(r.ai_provider),
    model: s(r.ai_model),
    createdAt: s(r.created_at),
    generationMs: n(r.response_time),
    promptTokens: n(r.req_units) ?? n(r.request_tokens),
    completionTokens: n(r.res_units) ?? n(r.response_tokens),
  });
}

/** Helicone request → GenerationInfo. Uses costUSD only (the raw `cost` may be scaled). */
export function parseHeliconeRequest(r: Record<string, unknown>): GenerationInfo | undefined {
  const id = s(r.request_id);
  if (!id) return undefined;
  return info(id, {
    totalCostUsd: n(r.costUSD),
    provider: s(r.provider)?.toLowerCase(),
    model: s(r.response_model) ?? s(r.model) ?? s(r.request_model),
    createdAt: s(r.request_created_at),
    generationMs: n(r.delay_ms),
    promptTokens: n(r.prompt_tokens),
    completionTokens: n(r.completion_tokens),
    reasoningTokens: n(r.reasoning_tokens),
    cachedTokens: n(r.prompt_cache_read_tokens),
    cacheCreationTokens: n(r.prompt_cache_write_tokens),
  });
}

interface Getter {
  (path: string, signal?: AbortSignal): Promise<unknown>;
}

function getter(id: GatewayId, baseUrl: string, headers: Record<string, string>, secret: string, o: LookupOpts): Getter {
  return (path, signal) =>
    fetchJson(
      `${baseUrl}${path}`,
      { method: "GET", headers: { ...headers, accept: "application/json" } },
      { ...o.retry, ...(o.fetch ? { fetch: o.fetch } : {}), ...(signal ? { signal } : {}), secrets: [secret], label: id },
    );
}

/** 404 means not ingested yet (or never will be): retry on a later run. */
async function lookup(get: Getter, path: string, pick: (json: unknown) => GenerationInfo | undefined, signal?: AbortSignal): Promise<GenerationLookup> {
  let json: unknown;
  try {
    json = await get(path, signal);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { status: "pending" };
    throw e;
  }
  const g = pick(json);
  return g ? { status: "ok", info: g } : { status: "pending" };
}

const enc = encodeURIComponent;

export function createOpenRouterClient(o: LookupOpts & { baseUrl: string; apiKey: string }): Required<GatewayClient> {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = getter("openrouter", baseUrl, { authorization: `Bearer ${o.apiKey}` }, o.apiKey, o);
  return {
    baseUrl,
    generation: (id, signal) =>
      lookup(get, `/generation?id=${enc(id)}`, (j) => {
        const d = (j as { data?: unknown })?.data;
        return isObj(d) ? parseGeneration(d) : undefined;
      }, signal),
    async credits(signal) {
      const d = ((await get("/credits", signal)) as { data?: Record<string, unknown> })?.data ?? {};
      const total = n(d.total_credits);
      const used = n(d.total_usage);
      const c: Credits = {};
      if (total !== undefined) c.balanceUsd = Math.round((total - (used ?? 0)) * 1e6) / 1e6;
      if (used !== undefined) c.totalUsedUsd = used;
      return c;
    },
  };
}

export function createLiteLLMClient(o: LookupOpts & { baseUrl: string; apiKey: string }): GatewayClient {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = getter("litellm", baseUrl, { authorization: `Bearer ${o.apiKey}` }, o.apiKey, o);
  return {
    baseUrl,
    generation: (id, signal) =>
      lookup(get, `/spend/logs?request_id=${enc(id)}`, (j) => {
        // A list (v1), or { data: [...] } (v2).
        const rows = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.data) ? j.data : [];
        const row = rows.find((r): r is Record<string, unknown> => isObj(r) && r.request_id === id) ?? rows.find(isObj);
        return row ? parseLiteLLMSpendLog(row) : undefined;
      }, signal),
  };
}

export function createCloudflareClient(o: LookupOpts & { baseUrl: string; apiKey: string; accountId: string; gatewayId: string }): GatewayClient {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = getter("cloudflare", baseUrl, { authorization: `Bearer ${o.apiKey}` }, o.apiKey, o);
  const root = `/accounts/${enc(o.accountId)}/ai-gateway/gateways/${enc(o.gatewayId)}/logs`;
  return {
    baseUrl,
    generation: (id, signal) =>
      lookup(get, `${root}/${enc(id)}`, (j) => {
        const r = isObj(j) ? j.result : undefined;
        return isObj(r) ? parseCloudflareLog(r) : undefined;
      }, signal),
  };
}

export function createPortkeyClient(o: LookupOpts & { baseUrl: string; apiKey: string }): GatewayClient {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = getter("portkey", baseUrl, { "x-portkey-api-key": o.apiKey }, o.apiKey, o);
  return {
    baseUrl,
    generation: (id, signal) =>
      lookup(get, `/logs/${enc(id)}`, (j) => {
        const r = isObj(j) && isObj(j.data) ? j.data : j;
        return isObj(r) ? parsePortkeyLog(r) : undefined;
      }, signal),
  };
}

export function createHeliconeClient(o: LookupOpts & { baseUrl: string; apiKey: string }): GatewayClient {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = getter("helicone", baseUrl, { authorization: `Bearer ${o.apiKey}` }, o.apiKey, o);
  return {
    baseUrl,
    generation: (id, signal) =>
      lookup(get, `/v1/request/${enc(id)}?includeBody=false`, (j) => {
        const d = isObj(j) ? j.data : undefined;
        return isObj(d) ? parseHeliconeRequest(d) : undefined;
      }, signal),
  };
}

/**
 * The lookup client for a configured gateway, or why there is none:
 * "key" (no key), "config" (Cloudflare account / gateway id, or a
 * self-hosted URL, missing) or "none" (the gateway has no lookup API).
 */
export function lookupClient(c: GatewayConfig, o: LookupOpts = {}): { client: GatewayClient } | { missing: "key" | "config" | "none"; detail: string } {
  const def = GATEWAYS[c.id];
  if (!def.lookup) return { missing: "none", detail: `${def.name} has no per-request lookup API` };
  if (!c.apiKey) return { missing: "key", detail: `export ${c.apiKeyEnv}=…` };
  if (!c.baseUrl) return { missing: "config", detail: `set [gateway.${c.id}] baseUrl or ${def.urlEnv[0] ?? "its URL"}` };
  const base = { baseUrl: c.baseUrl, apiKey: c.apiKey, ...o };
  switch (c.id) {
    case "vercel":
      return { client: createGatewayClient(base) };
    case "openrouter":
      return { client: createOpenRouterClient(base) };
    case "litellm":
      return { client: createLiteLLMClient(base) };
    case "portkey":
      return { client: createPortkeyClient(base) };
    case "helicone":
      return { client: createHeliconeClient(base) };
    case "cloudflare":
      if (!c.accountId || !c.gatewayId) return { missing: "config", detail: "set CLOUDFLARE_ACCOUNT_ID and [gateway.cloudflare] gatewayId (or point a base URL at gateway.ai.cloudflare.com/v1/<account>/<gateway>)" };
      return { client: createCloudflareClient({ ...base, accountId: c.accountId, gatewayId: c.gatewayId }) };
    default:
      return { missing: "none", detail: `${def.name} has no per-request lookup API` };
  }
}
