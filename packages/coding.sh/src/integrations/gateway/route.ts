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
import { DEFAULT_KEY_ENV } from "./config.ts";
import { GATEWAY_HOST } from "./ids.ts";

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
