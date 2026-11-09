# Generated from packages/coding.sh/src/integrations/gateway/providers.ts. Do not edit:
# change the registry, then run `node packages/coding.sh/scripts/sdk-gateways.ts`.
#
# One dict per gateway: id, hosts (exact, or a parent domain when it starts with "."), url_env
# (env vars naming a self-hosted gateway's URL), id_pattern (request id shape), id_headers
# (response headers carrying the request id `gateway enrich` looks up), mark_headers (other
# response headers only this gateway sets).

import re
from typing import Any, Dict, Tuple

GATEWAY_TABLE: Tuple[Dict[str, Any], ...] = (
    {
        "id": "vercel",
        "hosts": ("ai-gateway.vercel.sh",),
        "url_env": (),
        "id_pattern": re.compile("^gen_[0-9A-HJKMNP-TV-Z]{26}$", re.IGNORECASE),
        "id_headers": ("x-generation-id",),
        "mark_headers": (),
    },
    {
        "id": "openrouter",
        "hosts": ("openrouter.ai",),
        "url_env": (),
        "id_pattern": re.compile("^gen-[0-9A-Za-z][0-9A-Za-z-]{11,}$"),
        "id_headers": ("x-generation-id",),
        "mark_headers": (),
    },
    {
        "id": "litellm",
        "hosts": (),
        "url_env": ("LITELLM_PROXY_API_BASE", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"),
        "id_pattern": None,
        "id_headers": ("x-litellm-call-id",),
        "mark_headers": ("x-litellm-response-cost", "x-litellm-model-api-base"),
    },
    {
        "id": "cloudflare",
        "hosts": ("gateway.ai.cloudflare.com",),
        "url_env": (),
        "id_pattern": None,
        "id_headers": ("cf-aig-log-id",),
        "mark_headers": (),
    },
    {
        "id": "portkey",
        "hosts": ("api.portkey.ai",),
        "url_env": ("PORTKEY_GATEWAY_URL",),
        "id_pattern": None,
        "id_headers": ("x-portkey-trace-id",),
        "mark_headers": (),
    },
    {
        "id": "helicone",
        "hosts": (".helicone.ai",),
        "url_env": (),
        "id_pattern": None,
        "id_headers": ("helicone-id",),
        "mark_headers": (),
    },
    {
        "id": "requesty",
        "hosts": ("router.requesty.ai", "router.eu.requesty.ai"),
        "url_env": (),
        "id_pattern": re.compile("^rqsty-[A-Za-z0-9-]{8,}$"),
        "id_headers": (),
        "mark_headers": (),
    },
    {
        "id": "ramp",
        "hosts": ("api.router.com",),
        "url_env": ("RAMP_ROUTER_BASE_URL",),
        "id_pattern": None,
        "id_headers": (),
        "mark_headers": ("x-router-provider",),
    },
    {
        "id": "truefoundry",
        "hosts": (".truefoundry.ai", ".truefoundry.com", ".truefoundry.cloud"),
        "url_env": ("TFY_GATEWAY_URL",),
        "id_pattern": None,
        "id_headers": (),
        "mark_headers": (),
    },
    {
        "id": "kong",
        "hosts": (),
        "url_env": ("KONG_PROXY_URL",),
        "id_pattern": None,
        "id_headers": ("x-kong-request-id",),
        "mark_headers": ("x-kong-llm-model",),
    },
    {
        "id": "bifrost",
        "hosts": (),
        "url_env": ("BIFROST_URL", "BIFROST_BASE_URL"),
        "id_pattern": None,
        "id_headers": (),
        "mark_headers": (),
    },
    {
        "id": "martian",
        "hosts": ("withmartian.com",),
        "url_env": (),
        "id_pattern": None,
        "id_headers": (),
        "mark_headers": (),
    },
    {
        "id": "cliproxyapi",
        "hosts": (),
        "url_env": ("CLIPROXYAPI_URL",),
        "id_pattern": None,
        "id_headers": (),
        "mark_headers": (),
    },
)
