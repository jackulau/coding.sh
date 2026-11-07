// Vercel AI Gateway (ai-gateway.vercel.sh): pure helpers to spot gateway
// traffic in captured events. No I/O, so core/sessions.ts can use them.
//
// Signals, strongest first (docs: vercel.com/docs/ai-gateway):
// - a generation id `gen_<ulid>`: the `id` of every chat completion the gateway
//   returns, `providerMetadata.gateway.generationId` in the AI SDK, and
//   `vercel.ai_gateway.generation.id` on trace-drain spans;
// - the hook saw a gateway base URL in the agent's env (SpoolLine.gateway,
//   stamped on events as payload.gateway);
// - a gateway provider name (Codex `model_provider = "vercel"`, OpenCode's
//   `vercel` provider, the AI SDK's `gateway` provider, Pi's
//   `vercel-ai-gateway`) or a gateway-only model id (`claude-code/…`, `vmc/…`).
import type { AgentEvent } from "../../schema/index.ts";

export const GATEWAY_HOST = "ai-gateway.vercel.sh";
export const GATEWAY_API_BASE = `https://${GATEWAY_HOST}/v1`;
/** Session flag (Session.flags) for sessions with gateway-routed model calls. */
export const GATEWAY_FLAG = "gateway:vercel";
/** payload.gateway value stamped on events captured while a gateway base URL was set. */
export const GATEWAY_ID = "vercel";
/** Agent id for sessions built from the gateway's own trace-drain spans. */
export const GATEWAY_AGENT = "ai-gateway";

/** `gen_` + a 26-char Crockford base32 ULID, e.g. gen_01ARZ3NDEKTSV4RRFFQ69G5FAV. */
export const GENERATION_ID = /^gen_[0-9A-HJKMNP-TV-Z]{26}$/i;

const PROVIDERS = new Set(["vercel", "vercel-ai-gateway", "vercel-gateway", "ai-gateway", "gateway", "vercel.ai_gateway"]);
const GATEWAY_MODEL = /^(claude-code|vmc)\//;

/** `vmc/<slug>` for a virtual-model id, with or without Claude Code's `claude-code/` prefix. */
export function virtualModelId(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const m = /^(?:claude-code\/)?(vmc\/[^\s/[\]]+)(?:\[1m\])?$/.exec(model);
  return m?.[1];
}

/** Env vars agents read a model API base URL from. */
export const BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"] as const;

export function isGatewayUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === GATEWAY_HOST || host.endsWith(`.${GATEWAY_HOST}`);
  } catch {
    return false;
  }
}

/** "vercel" when any base-URL env var points at the gateway, else undefined. Reads names, never key values. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv): typeof GATEWAY_ID | undefined {
  return BASE_URL_VARS.some((k) => isGatewayUrl(env[k])) ? GATEWAY_ID : undefined;
}

export const isGenerationId = (v: unknown): v is string => typeof v === "string" && GENERATION_ID.test(v);

export const isGatewayProvider = (v: unknown): boolean => typeof v === "string" && PROVIDERS.has(v.toLowerCase());

/** The gateway generation id an event carries, if any (explicit field first, then ids that happen to be one). */
export function generationIdOf(e: Pick<AgentEvent, "payload">): string | undefined {
  const p = e.payload;
  for (const k of ["gatewayGenerationId", "generationId", "responseId", "messageId", "requestId", "id"]) {
    if (isGenerationId(p[k])) return p[k] as string;
  }
  return undefined;
}

/** True when this event shows a model call (or capture) that went through the gateway. */
export function isGatewayEvent(e: AgentEvent): boolean {
  if (e.agent === GATEWAY_AGENT) return true;
  const p = e.payload;
  if (p.gateway === GATEWAY_ID || p.gateway === true) return true;
  if (e.kind !== "llm.call" && e.kind !== "session.start") return false;
  if (generationIdOf(e)) return true;
  if (typeof p.gatewaySessionId === "string" && p.gatewaySessionId) return true;
  if (isGatewayProvider(p.provider)) return true;
  return [e.model, p.requestModel, p.responseModel].some((m) => typeof m === "string" && GATEWAY_MODEL.test(m));
}
