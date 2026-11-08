// J3 (docs/PRODUCTION.md §7): AI SDK telemetry into coding.sh, two ways.
//
//   CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=csh_ik_... node app.mjs
//
// (a) Plain OpenTelemetry, no coding.sh SDK: @ai-sdk/otel's OpenTelemetry integration on the
//     global tracer, exported by @opentelemetry/sdk-node over OTLP/protobuf to /v1/traces.
//     Session "j3", from gen_ai.conversation.id.
// (b) The coding.sh SDK: the same integration with `tracer: aiSdkTracer()`, session "j3-sdk".
//
// The model defaults to the shared mock LLM (examples/production/mock-llm, port 9999).
// AI SDK 6 instead: experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer(), metadata: { sessionId } }.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { aiSdkTracer, flush, withSession } from "@codingdotsh/sdk";

const url = (process.env.CODING_SH_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
const key = process.env.CODING_SH_INGEST_KEY;
const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:9999/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "mock",
});
const model = openai.chat(process.env.OPENAI_MODEL ?? "mock-gpt");

// (a) plain OpenTelemetry
const otel = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "j3-otel",
  traceExporter: new OTLPTraceExporter({ url: `${url}/v1/traces`, headers: key ? { Authorization: `Bearer ${key}` } : {} }),
});
otel.start();
const plain = await generateText({
  model,
  prompt: "ping",
  telemetry: {
    functionId: "j3",
    integrations: new OpenTelemetry({ enrichSpan: () => ({ "gen_ai.conversation.id": "j3" }) }),
  },
});
console.log(plain.text);
await otel.shutdown(); // exports the spans

// (b) coding.sh SDK
const viaSdk = await withSession("j3-sdk", () =>
  generateText({ model, prompt: "ping", telemetry: { functionId: "j3", integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) } }),
);
console.log(viaSdk.text);
await flush();
