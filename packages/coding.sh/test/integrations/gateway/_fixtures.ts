// Synthetic AI Gateway spans, shaped per
// vercel.com/docs/ai-gateway/observability-and-spend/trace-drains (no real data).
import { iAttr, otlpSpan, sAttr } from "../../otel/_encode.ts";

export const GEN_ID = "gen_01JAZ3NDEKTSV4RRFFQ69G5FAV";
export const GEN_ID_2 = "gen_01JAZ3NDEKTSV4RRFFQ69G5FAW";
export const TRACE = "aa000000000000000000000000000001";
const dAttr = (key: string, v: number) => ({ key, value: { doubleValue: v } });
const bAttr = (key: string, v: boolean) => ({ key, value: { boolValue: v } });

/** One drained gateway request: root, routing, a failed attempt on vertex, a good one on anthropic. */
export function drainExport(opts: { traceId?: string; genId?: string; responseId?: string; startMs?: number; requestModel?: string; sessionId?: string } = {}) {
  const t = opts.traceId ?? TRACE;
  const at = opts.startMs ?? 0;
  const root = otlpSpan(t, "1000000000000001", undefined, "chat anthropic/claude-sonnet-4.5", [
    sAttr("gen_ai.operation.name", "chat"),
    sAttr("gen_ai.request.model", opts.requestModel ?? "anthropic/claude-sonnet-4.5"),
    sAttr("gen_ai.response.model", "claude-sonnet-4-5-20250929"),
    ...(opts.sessionId ? [sAttr("session.id", opts.sessionId)] : []),
    sAttr("gen_ai.provider.name", "anthropic"),
    iAttr("gen_ai.usage.input_tokens", 1200),
    iAttr("gen_ai.usage.output_tokens", 300),
    iAttr("http.response.status_code", 200),
    sAttr("vercel.ai_gateway.generation.id", opts.genId ?? GEN_ID),
    sAttr("vercel.ai_gateway.request.id", "req_test_1"),
    sAttr("vercel.ai_gateway.provider", "anthropic"),
    sAttr("vercel.ai_gateway.api_format", "anthropic-messages"),
    sAttr("vercel.ai_gateway.credential.type", "system"),
    sAttr("vercel.ai_gateway.cost.total", "0.0081"),
    sAttr("vercel.ai_gateway.cost.currency", "USD"),
    sAttr("vercel.ai_gateway.cost.market", "0.0081"),
    sAttr("vercel.ai_gateway.api_key.name", "ci"),
  ], at, at + 2400);
  const routing = otlpSpan(t, "1000000000000002", "1000000000000001", "routing", [sAttr("vercel.ai_gateway.routing.strategy", "default")], at + 1, at + 5);
  const failed = otlpSpan(t, "1000000000000003", "1000000000000001", "claude-sonnet-4.5 (vertex)", [
    sAttr("gen_ai.operation.name", "chat"),
    sAttr("gen_ai.provider.name", "vertex"),
    sAttr("gen_ai.request.model", "claude-sonnet-4-5@20250929"),
    iAttr("http.response.status_code", 529),
    iAttr("vercel.ai_gateway.attempt.number", 1),
    bAttr("vercel.ai_gateway.attempt.success", false),
    sAttr("vercel.ai_gateway.attempt.provider_response_id", "msg_vertex_failed"),
  ], at + 6, at + 300);
  const ok = otlpSpan(t, "1000000000000004", "1000000000000001", "claude-sonnet-4.5 (anthropic)", [
    sAttr("gen_ai.operation.name", "chat"),
    sAttr("gen_ai.provider.name", "anthropic"),
    sAttr("gen_ai.request.model", "claude-sonnet-4-5-20250929"),
    iAttr("gen_ai.usage.input_tokens", 1200),
    iAttr("gen_ai.usage.output_tokens", 300),
    iAttr("http.response.status_code", 200),
    iAttr("vercel.ai_gateway.attempt.number", 2),
    bAttr("vercel.ai_gateway.attempt.success", true),
    bAttr("vercel.ai_gateway.attempt.is_final", true),
    sAttr("vercel.ai_gateway.attempt.provider_request_id", "req_provider_1"),
    sAttr("vercel.ai_gateway.attempt.provider_response_id", opts.responseId ?? "msg_01AgentSawThis"),
    dAttr("vercel.ai_gateway.attempt.latency_ms", 2000),
  ], at + 301, at + 2390);
  return {
    resourceSpans: [
      {
        resource: { attributes: [sAttr("service.name", "ai-gateway"), sAttr("service.namespace", "vercel")] },
        scopeSpans: [{ scope: { name: "ai-gateway" }, spans: [root, routing, failed, ok] }],
      },
    ],
  };
}

/** An AI SDK doGenerate span for a call made with the `gateway` provider. */
export function aiSdkExport(opts: { cost?: number } = {}) {
  const t = "bb000000000000000000000000000001";
  const meta = { gateway: { generationId: GEN_ID_2, cost: String(opts.cost ?? 0.0042), routing: { originalModelId: "openai/gpt-5", resolvedProvider: "openai", finalProvider: "azure" } } };
  const root = otlpSpan(t, "2000000000000001", undefined, "ai.generateText", [sAttr("ai.operationId", "ai.generateText"), sAttr("ai.model.provider", "gateway"), sAttr("ai.model.id", "openai/gpt-5"), sAttr("ai.prompt", '{"prompt":"hi"}')], 0, 1500);
  const call = otlpSpan(t, "2000000000000002", "2000000000000001", "ai.generateText.doGenerate", [
    sAttr("ai.operationId", "ai.generateText.doGenerate"),
    sAttr("operation.name", "ai.generateText.doGenerate"),
    sAttr("ai.model.provider", "gateway"),
    sAttr("ai.model.id", "openai/gpt-5"),
    sAttr("gen_ai.system", "gateway"),
    sAttr("gen_ai.request.model", "openai/gpt-5"),
    sAttr("gen_ai.response.model", "gpt-5-2025-08-07"),
    sAttr("ai.response.id", "chatcmpl-abc"),
    iAttr("gen_ai.usage.input_tokens", 10),
    iAttr("gen_ai.usage.output_tokens", 5),
    sAttr("ai.response.providerMetadata", JSON.stringify(meta)),
    sAttr("ai.response.finishReason", "stop"),
  ], 10, 1400);
  return { resourceSpans: [{ resource: { attributes: [sAttr("service.name", "my-app")] }, scopeSpans: [{ scope: { name: "ai" }, spans: [root, call] }] }] };
}
