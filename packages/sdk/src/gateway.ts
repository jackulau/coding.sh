// Which LLM gateway a model call went through, and the request id the
// gateway's lookup API takes (what `coding.sh gateway enrich` fetches billed
// cost by). The table is generated from the server's gateway registry
// (gateway-table.ts), so the SDK spots the same gateways the server does.
//
// Signals, strongest first:
// 1. the base URL (or request URL): a gateway host, or a self-hosted gateway
//    whose URL env var (LITELLM_PROXY_API_BASE, KONG_PROXY_URL, ...) names the
//    same host;
// 2. a response header only one gateway sets: its request id header
//    (cf-aig-log-id, helicone-id, x-litellm-call-id, x-portkey-trace-id, ...),
//    or a marker header (x-router-provider, x-kong-llm-model, ...);
// 3. a response id with a gateway's shape (Vercel `gen_…`, OpenRouter `gen-…`,
//    Requesty `rqsty-…`).
import { GATEWAY_TABLE, type GatewayRow } from "./gateway-table.ts";

/** Response headers: a fetch Headers object or anything with a case-insensitive get(). */
export interface HeaderGetter {
  get(name: string): string | null | undefined;
}

export interface GatewayHit {
  /** Gateway name: payload.gateway, and the session's `gateway:<name>` flag. */
  gateway: string;
  /** The id the gateway's lookup API takes: payload.gatewayGenerationId. */
  requestId?: string;
}

type Env = Record<string, string | undefined>;

const processEnv = (): Env => {
  try {
    return (typeof process !== "undefined" && process.env) || {};
  } catch {
    return {};
  }
};

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const hostMatches = (host: string, pattern: string): boolean => (pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern || host.endsWith(`.${pattern}`));

/** The gateway a base URL points at: by hostname, or a self-hosted gateway's URL env var on the same host. */
export function gatewayForUrl(url: unknown, env: Env = processEnv()): string | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  for (const g of GATEWAY_TABLE) {
    if (g.hosts.some((h) => hostMatches(host, h))) return g.id;
    if (g.urlEnv.some((k) => hostOf(env[k]) === host)) return g.id;
  }
  return undefined;
}

function header(h: HeaderGetter | undefined, name: string): string | undefined {
  if (!h) return undefined;
  try {
    const v = h.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

const shaped = (g: GatewayRow, v: string | undefined): v is string => !!v && (!g.idPattern || g.idPattern.test(v));

/** The request id gateway `g` gave this call: its id header, else a response id of its shape. */
function requestIdFor(g: GatewayRow, headers: HeaderGetter | undefined, responseId: string | undefined): string | undefined {
  for (const name of g.idHeaders) {
    const v = header(headers, name);
    if (shaped(g, v)) return v;
  }
  return responseId && g.idPattern?.test(responseId) ? responseId : undefined;
}

const hit = (gateway: string, requestId: string | undefined): GatewayHit => (requestId ? { gateway, requestId } : { gateway });

/** The gateway a model call went through, from its URL, response headers and response id. */
export function detectGateway(o: { url?: string; headers?: HeaderGetter; responseId?: string; env?: Env }): GatewayHit | undefined {
  const byUrl = gatewayForUrl(o.url, o.env ?? processEnv());
  if (byUrl) {
    const g = GATEWAY_TABLE.find((r) => r.id === byUrl)!;
    return hit(byUrl, requestIdFor(g, o.headers, o.responseId));
  }
  for (const g of GATEWAY_TABLE) {
    for (const name of g.idHeaders) {
      const v = header(o.headers, name);
      if (shaped(g, v)) return hit(g.id, v);
    }
  }
  for (const g of GATEWAY_TABLE) {
    if (g.markHeaders.some((name) => header(o.headers, name) !== undefined)) return hit(g.id, requestIdFor(g, o.headers, o.responseId));
  }
  for (const g of GATEWAY_TABLE) {
    if (o.responseId && g.idPattern?.test(o.responseId)) return hit(g.id, o.responseId);
  }
  return undefined;
}
