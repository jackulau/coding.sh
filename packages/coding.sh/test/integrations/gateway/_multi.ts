// Response fixtures for gateways other than Vercel, shaped after their docs
// (see docs/research/gateways.md). Synthetic values; no real data.
import type { FetchLike } from "../../../src/judge/http.ts";

export const OR_GEN = "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG";
export const OR_GEN_2 = "gen-1752093120-tTzfXhWtSBRkaSlY2c8b";
export const LITELLM_CALL = "8b6c2f4e-1f0a-4c7e-9d0b-3a2e5f6d7c81";
export const CF_LOG = "01963a3b-7c4d-7e8f-9a0b-1c2d3e4f5a6b";
export const HELICONE_REQ = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
export const PORTKEY_LOG = "pk-log-7f3e2a";
export const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";

/** openrouter.ai/docs/api-reference/get-a-generation (`data` wrapper). */
export const openRouterGeneration = (id = OR_GEN, over: Record<string, unknown> = {}) => ({
  data: {
    id,
    total_cost: 0.0015,
    usage: 0.0015,
    upstream_inference_cost: 0.0012,
    cache_discount: null,
    created_at: "2026-11-06T10:00:00.000Z",
    model: "sao10k/l3-stheno-8b",
    router: "openrouter/auto",
    provider_name: "Infermatic",
    api_type: "completions",
    streamed: true,
    cancelled: false,
    is_byok: false,
    latency: 320,
    generation_time: 1100,
    finish_reason: "stop",
    native_finish_reason: "stop",
    tokens_prompt: 10,
    tokens_completion: 25,
    native_tokens_prompt: 10,
    native_tokens_completion: 25,
    native_tokens_reasoning: 0,
    native_tokens_cached: 0,
    upstream_id: "chatcmpl-upstream-1",
    ...over,
  },
});

/** openrouter.ai/docs/api-reference/get-credits */
export const openRouterCredits = { data: { total_credits: 50, total_usage: 12.5 } };

/** docs.litellm.ai/docs/proxy/cost_tracking: GET /spend/logs?request_id= returns a list. */
export const liteLLMSpendLogs = (id = LITELLM_CALL, over: Record<string, unknown> = {}) => [
  {
    request_id: id,
    call_type: "acompletion",
    api_key: "88dc28d0f030c55ed4ab77ed8faf098196cb1c05df778539800c9f1243fe6b4b",
    spend: 0.0042,
    total_tokens: 1300,
    prompt_tokens: 1200,
    completion_tokens: 100,
    startTime: "2026-11-06T10:00:00.000Z",
    endTime: "2026-11-06T10:00:02.500Z",
    model: "anthropic/claude-sonnet-4-5",
    model_group: "claude-sonnet",
    api_base: "https://api.anthropic.com",
    user: "",
    metadata: { user_api_key_alias: "ci" },
    cache_hit: "False",
    request_tags: [],
    ...over,
  },
];

/** developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/ */
export const cloudflareLog = (id = CF_LOG, over: Record<string, unknown> = {}) => ({
  result: {
    id,
    cached: false,
    created_at: "2026-11-06T10:00:00Z",
    duration: 1800,
    model: "gpt-5-mini",
    path: "openai/chat/completions",
    provider: "openai",
    success: true,
    tokens_in: 500,
    tokens_out: 80,
    cost: 0.00031,
    status_code: 200,
    step: 0,
    metadata: "{}",
    ...over,
  },
  success: true,
  errors: [],
  messages: [],
});

/** docs.helicone.ai/rest/request/get-v1request */
export const heliconeRequest = (id = HELICONE_REQ, over: Record<string, unknown> = {}) => ({
  data: {
    request_id: id,
    response_id: "resp-1",
    request_created_at: "2026-11-06T10:00:00.000Z",
    provider: "OPENAI",
    model: "gpt-5",
    request_model: "gpt-5",
    response_model: "gpt-5-2025-08-07",
    prompt_tokens: 900,
    completion_tokens: 120,
    total_tokens: 1020,
    reasoning_tokens: 64,
    prompt_cache_read_tokens: 512,
    prompt_cache_write_tokens: 0,
    delay_ms: 2100,
    costUSD: 0.0021,
    cost: 2100000,
    ...over,
  },
  error: null,
});

/** portkey.ai/docs/product/observability/logs-export field list (cost in cents). */
export const portkeyLog = (id = PORTKEY_LOG, over: Record<string, unknown> = {}) => ({
  id,
  trace_id: "trace-abc",
  created_at: "2026-11-06T10:00:00.000Z",
  ai_org: "anthropic",
  ai_model: "claude-sonnet-4-5",
  req_units: 700,
  res_units: 90,
  total_units: 790,
  cost: 0.35,
  cost_currency: "USD",
  response_time: 1900,
  response_status_code: 200,
  metadata: {},
  ...over,
});

export interface Stub {
  fetch: FetchLike;
  calls: { url: string; headers: Record<string, string> }[];
}

/** A FetchLike answering from a path → [status, body] map. Never touches the network. */
export function stubFetch(routes: Record<string, [number, unknown]>): Stub {
  const calls: Stub["calls"] = [];
  const fetch: FetchLike = async (url, init) => {
    const h: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (h[k] = v));
    calls.push({ url, headers: h });
    const u = new URL(url);
    const hit = routes[u.pathname + u.search] ?? routes[u.pathname];
    const [status, body] = hit ?? [404, { error: { message: "not found" } }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
