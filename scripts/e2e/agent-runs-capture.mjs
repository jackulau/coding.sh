#!/usr/bin/env node
// Records the OpenTelemetry spans that Agent Runs tracing exports, the way
// durable-harness's `agentRuns()` sets it up, and writes them as one OTLP/JSON
// request: the fixture for coding.sh's Agent Runs tee
// (packages/coding.sh/test/fixtures/otel/agent-runs/).
//
//   node scripts/e2e/agent-runs-capture.mjs [--out <file>] [--receiver <url>]
//
// It installs the pinned packages into a temp dir (Node 24, network needed),
// then runs one agent turn with two steps: a model call that asks for a tool,
// the tool call, and a model call that answers. The provider matches
// durable-harness 0.0.2: resource service.name and agent.framework.name
// "durable-harness", tracer "eve.agent", AgentSpanIdGenerator.
//
// --receiver <url> also tees the spans to a running coding.sh collector with
// the documented snippet, a BatchSpanProcessor around an OTLPTraceExporter
// (url like http://127.0.0.1:4318/v1/traces).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(flag("--out") ?? "packages/coding.sh/test/fixtures/otel/agent-runs/turn.json");
const receiver = flag("--receiver");

const PINS = {
  "@vercel/agent-runs": "0.0.1",
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/sdk-trace-base": "2.2.0",
  "@opentelemetry/resources": "2.2.0",
  "@opentelemetry/otlp-transformer": "0.208.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.208.0",
  "@opentelemetry/context-async-hooks": "2.2.0",
};

// The runner lives in the temp dir so its imports resolve to the pinned packages.
const RUNNER = String.raw`
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createAgentRun, otelTelemetry, AgentSpanIdGenerator } from "@vercel/agent-runs";

const [out, receiver] = process.argv.slice(2);
const memory = new InMemorySpanExporter();
const spanProcessors = [new SimpleSpanProcessor(memory)];
// The tee from docs/how-to/agent-runs.md.
if (receiver) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: receiver })));

const idGenerator = new AgentSpanIdGenerator();
const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "durable-harness", "agent.framework.name": "durable-harness" }),
  idGenerator,
  spanProcessors,
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const telemetry = otelTelemetry({ provider, idGenerator, tracerName: "eve.agent", tracerVersion: "0.0.2" });
const run = createAgentRun({ telemetry });
const capture = { emit: true, recordInputs: true, recordOutputs: true };
const identity = { conversationId: "wrun_demo", runId: "wrun_demo", turnId: "sub_demo_1" };
const prompt = "What is the weather in Paris?";
const turn = await run.turn({
  identity,
  agentName: "weather",
  sequence: 0,
  framework: { name: "durable-harness", version: "0.0.2" },
  capture,
  channel: { kind: "http", origin: "channel" },
  attributes: { "agent.channel.audience": "debug", "agent.session.title": prompt },
});
const user = [{ role: "user", content: [{ type: "text", text: prompt }] }];
const tools = [{ type: "function", name: "get_weather", description: "Current weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }];

await turn.attempt({ stepIndex: 0, attempt: 0 }, async (step) => {
  await step.modelCall({ provider: "anthropic", modelId: "claude-sonnet-4-5", messages: user, instructions: "You are a weather agent.", tools }, async () => ({
    result: undefined,
    finishReason: "tool-calls",
    responseId: "msg_demo_1",
    responseModelId: "claude-sonnet-4-5",
    usage: { inputTokens: 1200, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 0 } },
    content: [{ type: "tool-call", callId: "toolu_demo_1", toolName: "get_weather", input: { city: "Paris" } }],
  }));
  await step.tool({ callId: "toolu_demo_1", name: "get_weather", arguments: { city: "Paris" } }, async (tool) => {
    const output = { city: "Paris", tempC: 18, sky: "clear" };
    await tool.complete({ outcome: "completed", output });
    return output;
  });
});
await turn.attempt({ stepIndex: 1, attempt: 0 }, async (step) => {
  await step.modelCall({ provider: "anthropic", modelId: "claude-sonnet-4-5", messages: user, instructions: "You are a weather agent.", tools }, async () => ({
    result: undefined,
    finishReason: "stop",
    responseId: "msg_demo_2",
    responseModelId: "claude-sonnet-4-5",
    usage: { inputTokens: 1300, outputTokens: 25, inputTokenDetails: { cacheReadTokens: 1100, cacheWriteTokens: 150 } },
    content: [{ type: "text", text: "It is 18 C and clear in Paris." }],
  }));
});
await turn.complete({ outcome: "completed" });
await run.forceFlush();
await provider.forceFlush();

const spans = memory.getFinishedSpans();
const body = JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(body, null, 1) + "\n");
console.log(out + ": " + spans.length + " spans (" + spans.map((s) => s.name).join(", ") + ")" + (receiver ? ", sent to " + receiver : ""));
await provider.shutdown();
`;

const dir = mkdtempSync(join(tmpdir(), "agent-runs-capture-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "capture", private: true, type: "module", dependencies: PINS }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: dir, stdio: "inherit" });
  writeFileSync(join(dir, "run.mjs"), RUNNER);
  execFileSync(process.execPath, ["run.mjs", out, receiver ?? ""], { cwd: dir, stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
