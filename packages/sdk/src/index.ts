// @codingdotsh/sdk: production observability for apps that call LLM APIs.
//
//   import { observe } from "@codingdotsh/sdk";
//   const openai = observe(new OpenAI());      // or new Anthropic()
//
// Set CODING_SH_URL (and CODING_SH_INGEST_KEY) and every model call is sent to
// your coding.sh server. Without a URL the SDK does nothing. It never changes
// return values, errors or stream semantics, and never throws into the app.
// The one exception is weightsDelta(), a pure helper you call on purpose: it
// throws on bad input.
// Contract: docs/PRODUCTION.md §4 in the coding.sh repo.
export { init, flush, shutdown, stats } from "./client.ts";
export type { InitOptions, CaptureMode } from "./config.ts";
export { observe } from "./observe.ts";
export { observeFetch } from "./fetch.ts";
export { trace, span, withSession } from "./context.ts";
export type { TraceOptions, TraceHandle, SpanOptions } from "./context.ts";
export { weightsEdit, weightsCheckpoint, weightsDelta } from "./weights.ts";
export type { WeightsEdit, WeightsCheckpoint, WeightsDelta, WeightsArray } from "./weights.ts";
export { aiSdkTracer } from "./ai-sdk.ts";
export type { AiSdkTracer, AiSdkTracerOptions } from "./ai-sdk.ts";
export type { TransportStats } from "./transport.ts";
