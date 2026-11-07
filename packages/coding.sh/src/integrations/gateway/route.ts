// Route a headless agent run through Vercel AI Gateway (`coding.sh compare
// --gateway`): env, CLI flags and model id per agent, so each arm of an
// experiment can use a different model with one gateway key.
//
// Endpoints (vercel.com/docs/ai-gateway/coding-agents):
// - Claude Code: ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh/claude-code,
//   key in ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY empty. Non-Anthropic models
//   are named `claude-code/<creator>/<model>`.
// - Codex: a `vercel` model provider at /codex/v1 (Responses API), key from
//   $AI_GATEWAY_API_KEY, set with `-c` overrides so no config file is written.
// - OpenCode: the built-in `vercel` provider, model `vercel/<creator>/<model>`.
// - Pi: the built-in `vercel-ai-gateway` provider.
//
// Other gateways (routeVia): the same four shapes where the gateway documents
// the endpoint. Claude Code needs an Anthropic Messages endpoint and Codex a
// Responses endpoint, so not every gateway can route every agent.
// - OpenRouter: Anthropic-compatible https://openrouter.ai/api, Responses at
//   /api/v1, OpenCode's and Pi's built-in `openrouter` provider.
// - LiteLLM proxy: /v1/messages and /v1/responses on the proxy URL.
// - Ramp Router (router.com): /v1/messages and /v1/responses.
import { DEFAULT_KEY_ENV, type GatewayConfig } from "./config.ts";
import { GATEWAY_HOST } from "./ids.ts";
import { GATEWAYS, type GatewayId } from "./providers.ts";

export interface GatewayRoute {
  env: Record<string, string>;
  flags: string[];
  /** Model id to run with, rewritten to the gateway's `<creator>/<model>` form where the agent needs it. */
  model?: string;
}

export const ROUTABLE_AGENTS = ["claude-code", "codex", "opencode", "pi"] as const;

const ORIGIN = `https://${GATEWAY_HOST}`;

/** `<creator>/<model>` for a bare model id ("gpt-5" → "openai/gpt-5"); unchanged when it has a slash or no known creator. */
export function gatewayModelId(model: string): string {
  if (model.includes("/")) return model;
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return `anthropic/${model}`;
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return `openai/${model}`;
  if (m.startsWith("gemini") || m.startsWith("gemma")) return `google/${model}`;
  if (m.startsWith("grok")) return `xai/${model}`;
  return model;
}

const toml = (s: string) => JSON.stringify(s);

/**
 * Env, flags and model for running `agent` through the gateway.
 * Throws for agents with no known gateway setup.
 */
export function gatewayRoute(agent: string, model: string | undefined, apiKey: string): GatewayRoute {
  switch (agent) {
    case "claude-code": {
      const r: GatewayRoute = { env: { ANTHROPIC_BASE_URL: `${ORIGIN}/claude-code`, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: "" }, flags: [] };
      // Anthropic ids pass through; other creators go by claude-code/<creator>/<model>.
      if (model) r.model = model.includes("/") && !model.startsWith("claude-code/") && !model.startsWith("anthropic/") ? `claude-code/${model}` : model;
      return r;
    }
    case "codex": {
      const flags = [
        "-c",
        'model_provider="vercel"',
        "-c",
        'model_providers.vercel.name="Vercel AI Gateway"',
        "-c",
        `model_providers.vercel.base_url=${toml(`${ORIGIN}/codex/v1`)}`,
        "-c",
        `model_providers.vercel.env_key=${toml(DEFAULT_KEY_ENV)}`,
        "-c",
        'model_providers.vercel.wire_api="responses"',
      ];
      return { env: { [DEFAULT_KEY_ENV]: apiKey }, flags, ...(model ? { model: gatewayModelId(model) } : {}) };
    }
    case "opencode":
      return { env: { [DEFAULT_KEY_ENV]: apiKey }, flags: [], ...(model ? { model: model.startsWith("vercel/") ? model : `vercel/${gatewayModelId(model)}` } : {}) };
    case "pi":
      return { env: { [DEFAULT_KEY_ENV]: apiKey }, flags: ["--provider", "vercel-ai-gateway"], ...(model ? { model: gatewayModelId(model) } : {}) };
    default:
      throw new Error(`no AI Gateway route for agent ${JSON.stringify(agent)} (supported: ${ROUTABLE_AGENTS.join(", ")})`);
  }
}

interface RouteSpec {
  /** Anthropic Messages base for Claude Code (ANTHROPIC_BASE_URL). */
  anthropic?: (base: string) => string;
  /** OpenAI Responses base for Codex. */
  responses?: (base: string) => string;
  /** Built-in OpenCode provider id. */
  opencode?: string;
  /** Built-in Pi provider id. */
  pi?: string;
  /** Rewrite bare model ids to `<creator>/<model>`. */
  creatorIds: boolean;
  /** Inference origin for hosted gateways (self-hosted ones use the configured URL). */
  origin?: string;
}

const ROUTES: Partial<Record<GatewayId, RouteSpec>> = {
  openrouter: { origin: "https://openrouter.ai", anthropic: (o) => `${o}/api`, responses: (o) => `${o}/api/v1`, opencode: "openrouter", pi: "openrouter", creatorIds: true },
  litellm: { anthropic: (o) => o, responses: (o) => `${o}/v1`, creatorIds: false },
  ramp: { origin: "https://api.router.com", anthropic: (o) => o, responses: (o) => `${o}/v1`, creatorIds: false },
};

/** Agents `compare --gateway <id>` can route through gateway `id`. */
export function routableAgents(id: GatewayId): string[] {
  if (id === "vercel") return [...ROUTABLE_AGENTS];
  const r = ROUTES[id];
  if (!r) return [];
  return ROUTABLE_AGENTS.filter((a) => (a === "claude-code" ? r.anthropic : a === "codex" ? r.responses : a === "opencode" ? r.opencode : r.pi));
}

/** Gateways with at least one route. */
export const ROUTABLE_GATEWAYS: GatewayId[] = ["vercel", ...(Object.keys(ROUTES) as GatewayId[])];

/** Origin (scheme + host + path prefix, no trailing slash) of a self-hosted gateway's URL, without a trailing /v1. */
const originOf = (url: string): string => url.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * Env, flags and model for running `agent` through gateway `c.id`. Vercel goes
 * through gatewayRoute unchanged. Throws when the gateway can't route the agent.
 */
export function routeVia(c: GatewayConfig, agent: string, model: string | undefined): GatewayRoute {
  if (!c.apiKey) throw new Error(`no key for ${GATEWAYS[c.id].name} (set ${c.apiKeyEnv})`);
  if (c.id === "vercel") return gatewayRoute(agent, model, c.apiKey);
  const spec = ROUTES[c.id];
  const supported = routableAgents(c.id);
  if (!spec || !supported.includes(agent)) throw new Error(`no ${GATEWAYS[c.id].name} route for agent ${JSON.stringify(agent)}${supported.length ? ` (supported: ${supported.join(", ")})` : ""}`);
  const origin = spec.origin ?? (c.baseUrl ? originOf(c.baseUrl) : undefined);
  if (!origin) throw new Error(`${GATEWAYS[c.id].name} needs its URL: set [gateway.${c.id}] baseUrl or ${GATEWAYS[c.id].urlEnv[0]}`);
  const id = (m: string) => (spec.creatorIds ? gatewayModelId(m) : m);
  // The standard var: built-in OpenCode / Pi providers read it by that name.
  const keyEnv = GATEWAYS[c.id].keyEnv;
  switch (agent) {
    case "claude-code":
      return { env: { ANTHROPIC_BASE_URL: spec.anthropic!(origin), ANTHROPIC_AUTH_TOKEN: c.apiKey, ANTHROPIC_API_KEY: "" }, flags: [], ...(model ? { model: id(model) } : {}) };
    case "codex": {
      const p = `model_providers.${c.id}`;
      const flags = ["-c", `model_provider=${toml(c.id)}`, "-c", `${p}.name=${toml(GATEWAYS[c.id].name)}`, "-c", `${p}.base_url=${toml(spec.responses!(origin))}`, "-c", `${p}.env_key=${toml(keyEnv)}`, "-c", `${p}.wire_api="responses"`];
      return { env: { [keyEnv]: c.apiKey }, flags, ...(model ? { model: id(model) } : {}) };
    }
    case "opencode":
      return { env: { [keyEnv]: c.apiKey }, flags: [], ...(model ? { model: model.startsWith(`${spec.opencode}/`) ? model : `${spec.opencode}/${id(model)}` } : {}) };
    default:
      return { env: { [keyEnv]: c.apiKey }, flags: ["--provider", spec.pi!], ...(model ? { model: id(model) } : {}) };
  }
}
