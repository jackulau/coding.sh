// Minimal client for the Vercel AI Gateway REST API (other gateways: lookups.ts)
// (vercel.com/docs/ai-gateway/sdks-and-apis/rest-api):
//   GET /v1/generation?id=gen_…  → cost, provider, latency, tokens of one generation
//   GET /v1/credits               → { balance, total_used }
// The key goes only into the Authorization header; errors are scrubbed of it.
import { fetchJson, HttpError, type FetchLike, type RetryOpts } from "../../judge/http.ts";

/** The subset of a generation record coding.sh keeps (whitelisted: nothing else from the response is stored). */
export interface GenerationInfo {
  id: string;
  /** USD debited from the gateway balance, surcharges included; 0 for BYOK inference. */
  totalCostUsd?: number;
  /** List price of the inference. */
  marketCostUsd?: number;
  /** BYOK only: what the provider would charge at list price. */
  upstreamCostUsd?: number;
  isByok?: boolean;
  /** Provider that served the generation (e.g. "anthropic", "bedrock", "vertex"). */
  provider?: string;
  model?: string;
  createdAt?: string;
  streamed?: boolean;
  finishReason?: string;
  /** Time to first token, ms. */
  latencyMs?: number;
  /** Total generation time, ms. */
  generationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
}

export type GenerationLookup = { status: "ok"; info: GenerationInfo } | { status: "pending" };

export interface Credits {
  balanceUsd?: number;
  totalUsedUsd?: number;
}

export interface GatewayClient {
  readonly baseUrl: string;
  /** "pending" when the gateway has no record yet (usage is ingested asynchronously) or never will. */
  generation(id: string, signal?: AbortSignal): Promise<GenerationLookup>;
  /** Credit balance, for gateways that have one (Vercel, OpenRouter). */
  credits?(signal?: AbortSignal): Promise<Credits>;
}

export interface GatewayClientOpts {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  retry?: RetryOpts;
}

const n = (v: unknown): number | undefined => {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Normalizes a /v1/generation `data` object (snake_case) to GenerationInfo. */
export function parseGeneration(d: Record<string, unknown>): GenerationInfo | undefined {
  const id = s(d.id);
  if (!id) return undefined;
  const out: GenerationInfo = { id };
  const set = <K extends keyof GenerationInfo>(k: K, v: GenerationInfo[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("totalCostUsd", n(d.total_cost) ?? n(d.gateway_cost) ?? n(d.usage));
  set("marketCostUsd", n(d.market_cost));
  set("upstreamCostUsd", n(d.upstream_inference_cost));
  set("isByok", typeof d.is_byok === "boolean" ? d.is_byok : undefined);
  set("provider", s(d.provider_name));
  set("model", s(d.model));
  set("createdAt", s(d.created_at));
  set("streamed", typeof d.streamed === "boolean" ? d.streamed : undefined);
  set("finishReason", s(d.finish_reason));
  set("latencyMs", n(d.latency));
  set("generationMs", n(d.generation_time));
  set("promptTokens", n(d.native_tokens_prompt) ?? n(d.tokens_prompt));
  set("completionTokens", n(d.native_tokens_completion) ?? n(d.tokens_completion));
  set("reasoningTokens", n(d.native_tokens_reasoning));
  set("cachedTokens", n(d.native_tokens_cached));
  set("cacheCreationTokens", n(d.native_tokens_cache_creation));
  return out;
}

/** What the call cost the user: gateway debit plus, for BYOK, the provider's own charge. */
export function billedCostUsd(g: GenerationInfo): number | undefined {
  if (g.totalCostUsd === undefined && g.upstreamCostUsd === undefined) return undefined;
  return (g.totalCostUsd ?? 0) + (g.isByok ? (g.upstreamCostUsd ?? 0) : 0);
}

export function createGatewayClient(o: GatewayClientOpts): Required<GatewayClient> {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const get = (path: string, signal?: AbortSignal) =>
    fetchJson(
      `${baseUrl}${path}`,
      { method: "GET", headers: { authorization: `Bearer ${o.apiKey}`, accept: "application/json" } },
      { ...o.retry, ...(o.fetch ? { fetch: o.fetch } : {}), ...(signal ? { signal } : {}), secrets: [o.apiKey], label: "ai-gateway" },
    );
  return {
    baseUrl,
    async generation(id, signal) {
      let json: unknown;
      try {
        json = await get(`/generation?id=${encodeURIComponent(id)}`, signal);
      } catch (e) {
        // Not ingested yet ("Usage event not found") or unknown: retry on a later run.
        if (e instanceof HttpError && e.status === 404) return { status: "pending" };
        throw e;
      }
      const data = (json as { data?: unknown })?.data;
      const info = data && typeof data === "object" ? parseGeneration(data as Record<string, unknown>) : undefined;
      return info ? { status: "ok", info } : { status: "pending" };
    },
    async credits(signal) {
      const j = (await get("/credits", signal)) as Record<string, unknown>;
      const c: Credits = {};
      const b = n(j?.balance);
      const u = n(j?.total_used);
      if (b !== undefined) c.balanceUsd = b;
      if (u !== undefined) c.totalUsedUsd = u;
      return c;
    },
  };
}
