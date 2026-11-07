// The LLM gateways coding.sh knows: how to spot their traffic and where their
// lookup APIs live. Pure data plus tiny helpers (no I/O), so the hook and
// core/sessions.ts can import it. Sources: docs/research/gateways.md.
//
// Vercel AI Gateway keeps its own richer code paths (trace drains, session
// joins, compare routes for four agents); the rest share the generic ones.

export const GATEWAY_IDS = ["vercel", "openrouter", "litellm", "cloudflare", "portkey", "helicone", "requesty", "ramp", "truefoundry", "kong", "bifrost", "martian"] as const;
export type GatewayId = (typeof GATEWAY_IDS)[number];

export interface GatewayDef {
  id: GatewayId;
  /** Display name. */
  name: string;
  /** Inference hostnames (exact, or a parent domain when it starts with "."). Empty for self-hosted gateways. */
  hosts: readonly string[];
  /** Env vars that name a self-hosted gateway's URL: a base URL on the same host counts as routed through it. */
  urlEnv: readonly string[];
  /** Default lookup API base (no trailing slash); undefined when there is no lookup API or it is self-hosted. */
  apiBase?: string;
  /** Env var the API key is read from. */
  keyEnv: string;
  /** Other env vars tried, in order, when keyEnv is unset. */
  keyEnvFallbacks?: readonly string[];
  /** Other names `--gateway` accepts. */
  aliases?: readonly string[];
  /** Shape of the per-request id the gateway hands out, when it is distinctive enough to detect on its own. */
  idPattern?: RegExp;
  /** Provider names agents and SDKs use for this gateway (Codex model_provider, OpenCode / AI SDK provider). */
  providers: readonly string[];
  /** What `gateway enrich` can fetch per request. */
  lookup?: "generation" | "spend-log" | "log" | "request";
  /** Credit balance endpoint. */
  credits?: boolean;
  /** Documentation link. */
  docs: string;
}

export const GATEWAYS: Record<GatewayId, GatewayDef> = {
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    hosts: ["ai-gateway.vercel.sh"],
    urlEnv: [],
    apiBase: "https://ai-gateway.vercel.sh/v1",
    keyEnv: "AI_GATEWAY_API_KEY",
    // gen_ + a 26-char Crockford base32 ULID.
    idPattern: /^gen_[0-9A-HJKMNP-TV-Z]{26}$/i,
    providers: ["vercel", "vercel-ai-gateway", "vercel-gateway", "ai-gateway", "gateway", "vercel.ai_gateway"],
    lookup: "generation",
    credits: true,
    docs: "https://vercel.com/docs/ai-gateway",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    hosts: ["openrouter.ai"],
    urlEnv: [],
    apiBase: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    // gen-<random>, e.g. gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG or gen-1752093120-tTzfXhWtSBRkaSlY2c8b.
    idPattern: /^gen-[0-9A-Za-z][0-9A-Za-z-]{11,}$/,
    providers: ["openrouter"],
    lookup: "generation",
    credits: true,
    docs: "https://openrouter.ai/docs/api-reference/get-a-generation",
  },
  litellm: {
    id: "litellm",
    name: "LiteLLM proxy",
    hosts: [],
    urlEnv: ["LITELLM_PROXY_API_BASE", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"],
    keyEnv: "LITELLM_PROXY_API_KEY",
    keyEnvFallbacks: ["LITELLM_API_KEY", "LITELLM_MASTER_KEY"],
    providers: ["litellm", "litellm_proxy", "litellm-proxy"],
    lookup: "spend-log",
    docs: "https://docs.litellm.ai/docs/proxy/cost_tracking",
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare AI Gateway",
    hosts: ["gateway.ai.cloudflare.com"],
    urlEnv: [],
    apiBase: "https://api.cloudflare.com/client/v4",
    keyEnv: "CLOUDFLARE_API_TOKEN",
    aliases: ["cf"],
    providers: ["cloudflare-ai-gateway", "cloudflare_ai_gateway", "ai-gateway-provider"],
    lookup: "log",
    docs: "https://developers.cloudflare.com/ai-gateway/",
  },
  portkey: {
    id: "portkey",
    name: "Portkey",
    hosts: ["api.portkey.ai"],
    urlEnv: ["PORTKEY_GATEWAY_URL"],
    apiBase: "https://api.portkey.ai/v1",
    keyEnv: "PORTKEY_API_KEY",
    providers: ["portkey"],
    lookup: "log",
    docs: "https://portkey.ai/docs",
  },
  helicone: {
    id: "helicone",
    name: "Helicone",
    hosts: [".helicone.ai"],
    urlEnv: [],
    apiBase: "https://api.helicone.ai",
    keyEnv: "HELICONE_API_KEY",
    providers: ["helicone"],
    lookup: "request",
    docs: "https://docs.helicone.ai",
  },
  requesty: {
    id: "requesty",
    name: "Requesty",
    hosts: ["router.requesty.ai", "router.eu.requesty.ai"],
    urlEnv: [],
    keyEnv: "REQUESTY_API_KEY",
    // rqsty-cmpl-<uuid>
    idPattern: /^rqsty-[A-Za-z0-9-]{8,}$/,
    providers: ["requesty"],
    docs: "https://docs.requesty.ai",
  },
  ramp: {
    id: "ramp",
    name: "Ramp Router (router.com)",
    hosts: ["api.router.com"],
    urlEnv: ["RAMP_ROUTER_BASE_URL"],
    keyEnv: "RAMP_ROUTER_API_KEY",
    aliases: ["router", "router.com", "ramp-router"],
    providers: ["ramp", "ramp-router", "router.com"],
    docs: "https://docs.router.com",
  },
  truefoundry: {
    id: "truefoundry",
    name: "TrueFoundry AI Gateway",
    hosts: [".truefoundry.ai", ".truefoundry.com", ".truefoundry.cloud"],
    urlEnv: ["TFY_GATEWAY_URL"],
    keyEnv: "TFY_API_KEY",
    providers: ["truefoundry"],
    docs: "https://docs.truefoundry.com/gateway/intro-to-llm-gateway",
  },
  kong: {
    id: "kong",
    name: "Kong AI Gateway",
    hosts: [],
    urlEnv: ["KONG_PROXY_URL"],
    keyEnv: "KONG_API_KEY",
    providers: ["kong"],
    docs: "https://developer.konghq.com/ai-gateway/",
  },
  bifrost: {
    id: "bifrost",
    name: "Bifrost",
    hosts: [],
    urlEnv: ["BIFROST_URL", "BIFROST_BASE_URL"],
    keyEnv: "BIFROST_API_KEY",
    providers: ["bifrost"],
    docs: "https://docs.getbifrost.ai",
  },
  martian: {
    id: "martian",
    name: "Martian",
    hosts: ["withmartian.com"],
    urlEnv: [],
    keyEnv: "MARTIAN_API_KEY",
    providers: ["martian"],
    docs: "https://docs.withmartian.com",
  },
};

export const isGatewayId = (v: unknown): v is GatewayId => typeof v === "string" && (GATEWAY_IDS as readonly string[]).includes(v);

/** A gateway id from a name or alias ("openrouter", "router.com", "cf"), case-insensitive. */
export function resolveGatewayName(name: string): GatewayId | undefined {
  const n = name.trim().toLowerCase();
  return GATEWAY_IDS.find((id) => id === n || GATEWAYS[id].aliases?.includes(n));
}

/** Session flag for sessions with model calls through gateway `id`, e.g. "gateway:openrouter". */
export const gatewayFlag = (id: GatewayId): string => `gateway:${id}`;

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const hostMatches = (host: string, pattern: string): boolean => (pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern || host.endsWith(`.${pattern}`));

/**
 * The gateway a base URL points at. Hosted gateways match by hostname;
 * self-hosted ones (LiteLLM, Kong, ...) when `env` names their URL in one of
 * their urlEnv vars and the host is the same. Reads URLs only.
 */
export function gatewayForUrl(url: unknown, env: NodeJS.ProcessEnv = {}): GatewayId | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  for (const id of GATEWAY_IDS) {
    const g = GATEWAYS[id];
    if (g.hosts.some((h) => hostMatches(host, h))) return id;
    if (g.urlEnv.some((k) => hostOf(env[k]) === host)) return id;
  }
  return undefined;
}

/** The gateway whose request id has this shape (Vercel `gen_…`, OpenRouter `gen-…`). */
export function gatewayForId(id: unknown): GatewayId | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return GATEWAY_IDS.find((g) => GATEWAYS[g].idPattern?.test(id));
}

/** The gateway a provider name refers to ("openrouter", "vercel", "litellm", or "openrouter.chat" from the AI SDK). */
export function gatewayForProvider(name: unknown): GatewayId | undefined {
  if (typeof name !== "string" || !name) return undefined;
  const n = name.toLowerCase();
  const head = n.split(".")[0]!;
  return GATEWAY_IDS.find((g) => GATEWAYS[g].providers.includes(n) || GATEWAYS[g].providers.includes(head));
}
