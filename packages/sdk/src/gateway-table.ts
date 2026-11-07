// Generated from packages/coding.sh/src/integrations/gateway/providers.ts. Do not edit:
// change the registry, then run `node packages/coding.sh/scripts/sdk-gateways.ts`.

export interface GatewayRow {
  /** Gateway name, as payload.gateway and the `gateway:<name>` session flag use it. */
  id: string;
  /** Inference hostnames (exact, or a parent domain when it starts with "."). */
  hosts: readonly string[];
  /** Env vars naming a self-hosted gateway's URL: a base URL on that host is routed through it. */
  urlEnv: readonly string[];
  /** Shape of the gateway's request id. */
  idPattern?: RegExp;
  /** Response headers carrying the request id `gateway enrich` looks up. */
  idHeaders: readonly string[];
  /** Other response headers only this gateway sets. */
  markHeaders: readonly string[];
}

export const GATEWAY_TABLE: readonly GatewayRow[] = [
  { id: "vercel", hosts: ["ai-gateway.vercel.sh"], urlEnv: [], idPattern: /^gen_[0-9A-HJKMNP-TV-Z]{26}$/i, idHeaders: ["x-generation-id"], markHeaders: [] },
  { id: "openrouter", hosts: ["openrouter.ai"], urlEnv: [], idPattern: /^gen-[0-9A-Za-z][0-9A-Za-z-]{11,}$/, idHeaders: ["x-generation-id"], markHeaders: [] },
  { id: "litellm", hosts: [], urlEnv: ["LITELLM_PROXY_API_BASE", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"], idHeaders: ["x-litellm-call-id"], markHeaders: ["x-litellm-response-cost", "x-litellm-model-api-base"] },
  { id: "cloudflare", hosts: ["gateway.ai.cloudflare.com"], urlEnv: [], idHeaders: ["cf-aig-log-id"], markHeaders: [] },
  { id: "portkey", hosts: ["api.portkey.ai"], urlEnv: ["PORTKEY_GATEWAY_URL"], idHeaders: ["x-portkey-trace-id"], markHeaders: [] },
  { id: "helicone", hosts: [".helicone.ai"], urlEnv: [], idHeaders: ["helicone-id"], markHeaders: [] },
  { id: "requesty", hosts: ["router.requesty.ai", "router.eu.requesty.ai"], urlEnv: [], idPattern: /^rqsty-[A-Za-z0-9-]{8,}$/, idHeaders: [], markHeaders: [] },
  { id: "ramp", hosts: ["api.router.com"], urlEnv: ["RAMP_ROUTER_BASE_URL"], idHeaders: [], markHeaders: ["x-router-provider"] },
  { id: "truefoundry", hosts: [".truefoundry.ai", ".truefoundry.com", ".truefoundry.cloud"], urlEnv: ["TFY_GATEWAY_URL"], idHeaders: [], markHeaders: [] },
  { id: "kong", hosts: [], urlEnv: ["KONG_PROXY_URL"], idHeaders: ["x-kong-request-id"], markHeaders: ["x-kong-llm-model"] },
  { id: "bifrost", hosts: [], urlEnv: ["BIFROST_URL", "BIFROST_BASE_URL"], idHeaders: [], markHeaders: [] },
  { id: "martian", hosts: ["withmartian.com"], urlEnv: [], idHeaders: [], markHeaders: [] },
];
