# LLM gateways: what coding.sh can read from each

Checked November 2026, from official docs. The code that uses this is
`packages/coding.sh/src/integrations/gateway/` (`providers.ts` holds the table).
"Unverified" means the docs do not say.

## Summary

| Gateway | OpenAI-compatible base | Per-request cost | Lookup by id | OTel export | Key env |
| --- | --- | --- | --- | --- | --- |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | trace drain, `providerMetadata.gateway.cost` | `GET /v1/generation?id=gen_…` | trace drains | `AI_GATEWAY_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `usage.cost` in every response | `GET /api/v1/generation?id=gen-…` | Broadcast (OTLP JSON) | `OPENROUTER_API_KEY` |
| Ramp Router (router.com) | `https://api.router.com/v1` | `usage.cost` | none | none | `RAMP_ROUTER_API_KEY` |
| LiteLLM proxy | self-hosted, e.g. `http://localhost:4000` | `x-litellm-response-cost` header | `GET /spend/logs?request_id=` | `callbacks: ["otel"]` | `LITELLM_PROXY_API_KEY` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` | via logs API | `GET …/ai-gateway/gateways/{g}/logs/{id}` | OTLP exporter | `CLOUDFLARE_API_TOKEN` |
| Portkey | `https://api.portkey.ai/v1` | via logs (cents) | `GET /v1/logs/{id}` | Enterprise only | `PORTKEY_API_KEY` |
| Helicone | `https://ai-gateway.helicone.ai` | via request API | `GET /v1/request/{id}` | unverified | `HELICONE_API_KEY` |
| Requesty | `https://router.requesty.ai/v1` | `usage.cost` | none | none | `REQUESTY_API_KEY` |
| Kong AI Gateway | self-hosted | log plugin, metric | none | yes, no cost attribute | n/a |
| TrueFoundry | `https://gateway.truefoundry.ai` (unverified) | none documented | none | UI-configured | `TFY_API_KEY` |
| Bifrost | self-hosted, e.g. `http://localhost:8080/openai` | OTel `gen_ai.usage.cost` | none | `otel` plugin | n/a |
| Martian | `https://route.withmartian.com/api/openai/v1` | none documented | none | none | `MARTIAN_API_KEY` |
| Not Diamond | not a proxy | n/a | n/a | n/a | n/a |

## Notes per gateway

**OpenRouter.** Every response carries `usage.cost` and `cost_details.upstream_inference_cost` (BYOK). The old
`usage: {include: true}` flag is deprecated and does nothing. `GET /api/v1/generation?id=` returns
`{data: {id, total_cost, upstream_inference_cost, is_byok, provider_name, model, latency, generation_time,
native_tokens_*}}`, the same shape Vercel copied. Ids look like `gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG`.
`GET /api/v1/credits` returns `{data: {total_credits, total_usage}}`. Broadcast sends OTLP JSON with
`span.metadata.openrouter_generation.*` and `span.metadata.openrouter_cost_allocation.*` attributes.
Sources: [usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting),
[get a generation](https://openrouter.ai/docs/api-reference/get-a-generation),
[Broadcast to OTel](https://openrouter.ai/docs/guides/features/broadcast/otel-collector).

**router.com.** It exists and is an LLM gateway: Ramp Router. Endpoints `/v1/chat/completions`, `/v1/responses`,
`/v1/messages`. Cost is `usage.cost` in USD (left out when unpriced, not on `/v1/messages`). The serving provider
is in the body's `provider` field and the `X-Router-Provider` header. No lookup API or OTel is documented.
Env vars `RAMP_ROUTER_BASE_URL`, `RAMP_ROUTER_API_KEY`. Sources: [router.com](https://router.com),
[docs](https://docs.router.com), [responses and messages](https://docs.router.com/api/responses-and-messages).

**LiteLLM proxy.** Response headers `x-litellm-response-cost`, `x-litellm-call-id`, `x-litellm-model-api-base`.
`GET /spend/logs?request_id=<id>` returns a list of rows with `request_id`, `spend` (USD), `model`,
`model_group`, `prompt_tokens`, `completion_tokens`, `startTime`, `endTime`. OTel spans
(`litellm_request`, `raw_gen_ai_request`) carry `litellm.call_id`, `gen_ai.provider.name` and
`gen_ai.cost.total_cost`. Client env: `LITELLM_PROXY_API_BASE`, `LITELLM_PROXY_API_KEY`; the server key is
`LITELLM_MASTER_KEY`. Sources: [response headers](https://docs.litellm.ai/docs/proxy/response_headers),
[cost tracking](https://docs.litellm.ai/docs/proxy/cost_tracking),
[OpenTelemetry](https://docs.litellm.ai/docs/observability/opentelemetry_integration),
[LiteLLM proxy provider](https://docs.litellm.ai/docs/providers/litellm_proxy).

**Cloudflare AI Gateway.** Response header `cf-aig-log-id` (UUIDv7, older ones ULID). No cost header.
`GET /client/v4/accounts/{account}/ai-gateway/gateways/{gateway}/logs/{id}` with a Bearer API token returns
`{result: {id, provider, model, tokens_in, tokens_out, cost, custom_cost, duration, created_at}, success}`.
The OTLP exporter writes `gen_ai.model.provider`, `gen_ai.usage.cost`, `gen_ai.prompt_json`,
`gen_ai.completion_json`. Sources: [glossary](https://developers.cloudflare.com/ai-gateway/glossary/),
[logs API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/),
[OTel](https://developers.cloudflare.com/ai-gateway/observability/otel-integration/).

**Portkey.** Auth header `x-portkey-api-key`. Response header `x-portkey-trace-id`, no cost header.
`GET /v1/logs/{id}` exists but its response is not documented; the logs export lists `id`, `ai_org`,
`ai_model`, `req_units`, `res_units`, `cost` (cents), `cost_currency`, `response_time`. The OTel export
(Enterprise, experimental) uses `service.name=portkey` and `portkey.usage.cost`, with no unit stated.
Sources: [headers](https://portkey.ai/docs/api-reference/inference-api/headers),
[logs export](https://portkey.ai/docs/product/observability/logs-export),
[OTel](https://portkey.ai/docs/product/enterprise-offering/otel/complete-logs).

**Helicone.** Response header `helicone-id`; clients can preset it with `Helicone-Request-Id`.
`GET https://api.helicone.ai/v1/request/{id}?includeBody=false` returns `{data: {request_id, provider, model,
response_model, prompt_tokens, completion_tokens, costUSD, cost, delay_ms}, error}`. coding.sh reads
`costUSD`; the raw `cost` may be scaled. Sources: [get request](https://docs.helicone.ai/rest/request/get-v1request),
[gateway](https://docs.helicone.ai/gateway/overview).

**Requesty.** `usage.cost` in USD, ids like `rqsty-cmpl-…`, only aggregate usage APIs.
Source: [docs](https://docs.requesty.ai).

**Kong AI Gateway.** `X-Kong-LLM-Model` header. OTel spans have `gen_ai.*` tokens but no cost; cost is the
metric `kong.gen_ai.llm.cost`. Source: [LLM OpenTelemetry](https://developer.konghq.com/ai-gateway/llm-open-telemetry/).

**TrueFoundry.** No cost or id response header. OTel export is configured in the UI; a blog post (not the docs)
names `service.name=tfy-llm-gateway` and `gen_ai.usage.cost_usd`.
Source: [request headers](https://www.truefoundry.com/docs/ai-gateway/request-headers).

**Bifrost.** `otel` plugin, spans `gen_ai.chat` with `gen_ai.usage.cost`, `service.name` defaults to `bifrost`.
Source: [OTel](https://docs.getbifrost.ai/features/observability/otel).

**Martian.** The docs disagree on the base URL and document no cost, id or OTel.
Source: [API reference](https://docs.withmartian.com/api-reference).

**Not Diamond.** A model recommender, not a proxy: `POST /v2/modelRouter/modelSelect` returns a model and you call
the provider yourself. There is nothing to capture.
Source: [model select](https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post).

## What coding.sh does with this

- Detect: base URL host (or a self-hosted gateway's URL env var), request id shape (`gen_…` Vercel, `gen-…`
  OpenRouter, `rqsty-…` Requesty), provider name, OTel service name and attribute prefixes.
- Enrich: lookups for Vercel, OpenRouter, LiteLLM, Cloudflare, Portkey and Helicone. Ramp Router and Requesty
  return cost in the response, so a captured cost is used as is.
- Route `compare --gateway`: Vercel, OpenRouter, LiteLLM and Ramp Router, the ones that document Anthropic
  Messages and OpenAI Responses endpoints.
- Not done: reading response headers (agents and the SDKs do not keep them), Portkey's OTel cost (unit unknown),
  Kong cost (metric only).
