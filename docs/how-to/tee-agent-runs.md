# Tee Agent Runs to coding.sh

Agent Runs tracing (`@vercel/agent-runs`) records each agent turn as OpenTelemetry spans for Vercel
Agent Runs. eve and durable-harness use it. You can send the same spans to the coding.sh receiver
as well, so each run is also a local coding.sh session with its turns, model calls, tool calls,
usage and cost. Vercel Agent Runs keeps getting its copy.

## 1. Start the receiver

```sh
npx coding.sh collector   # Windows: npx -p coding.sh codingsh collector
```

It listens on `127.0.0.1:4318` and takes OTLP over HTTP, as JSON or protobuf.

## 2. Add a span processor

### durable-harness

`agentRuns()` from `durable-harness/instrumentation/otel` takes `spanProcessors`: more
destinations that get the same spans as Agent Runs. Add a batch processor around an OTLP
exporter that points at the receiver. durable-harness is built on version 2 of the OpenTelemetry
JS SDK (it pins `@opentelemetry/api` 1.9.0), so install the 2.x packages, pinned:

```sh
npm install @opentelemetry/sdk-trace-base@2 @opentelemetry/resources@2 @opentelemetry/exporter-trace-otlp-http@0.223
```

An unpinned install gets the 3.x exporter, which needs `@opentelemetry/api` 1.10 and fails with
`ERESOLVE`. The 2.x `BatchSpanProcessor` takes the exporter as its first argument; the 3.x one in
`@opentelemetry/sdk-trace` takes `{ exporter }` instead.

```ts
// instrumentation.ts
import { agentRuns } from "durable-harness/instrumentation/otel";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export const tracing = agentRuns({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }))],
});

export function register() {
  tracing.register();
}
```

These are the tracing peers durable-harness already needs, next to `@vercel/agent-runs`. Tracing
needs Node.js 24.

A session's `traceAudience` decides what the spans record, for coding.sh as for Agent Runs. With
the default capture, `private` and `unknown` sessions record models, tools, timing and usage but
no prompts or replies. Pass `capture` to `agentRuns()` to change that.

### eve

eve sets up Agent Runs itself. Add the receiver as another destination in its own file under
`agent/instrumentation/`. Install the same pinned 2.x packages as for durable-harness:

```sh
npm install @opentelemetry/sdk-trace-base@2 @opentelemetry/resources@2 @opentelemetry/exporter-trace-otlp-http@0.223
```

If your eve app is on OpenTelemetry JS 3.x instead, import `BatchSpanProcessor` from
`@opentelemetry/sdk-trace` and write `new BatchSpanProcessor({ exporter: new OTLPTraceExporter(...) })`.

```ts
// agent/instrumentation/coding-sh.ts
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }))],
});
```

### Your own host

If you call `createAgentRun()` yourself, add the same processor to the tracer provider you pass to
`otelTelemetry({ provider })`.

## 3. Read the sessions

```sh
npx coding.sh sessions   # Windows: npx -p coding.sh codingsh sessions
npx coding.sh ui         # Windows: npx -p coding.sh codingsh ui
```

Each Agent Runs run (`agent.run.id`) is one session:

| Agent Runs span | coding.sh |
| --- | --- |
| `invoke_agent <agent>` | `session.start`, the turn's `user.message`, then `turn.end` |
| `agent.step` | a step notification with its index, attempt and usage |
| `chat <model>` | `llm.call` with the model, usage, stop reason and cost |
| `execute_tool <tool>` | `tool.start` and `tool.end` |

The receiver recognizes these spans by their `eve.agent` instrumentation scope, which Agent Runs
uses for eve, durable-harness and any other host. The mapping is the one in
[integrations/eve.md](../integrations/eve.md).

## Check it

`scripts/e2e/agent-runs-capture.mjs` installs the pinned Agent Runs packages, sets up the tracer
the way durable-harness 0.0.2 does, and runs one turn with a tool call. With
`--receiver http://127.0.0.1:4318/v1/traces` it also sends the spans to a running receiver
through the processor above. The test `test/otel/agent-runs.test.ts` posts the recorded spans to
the receiver and checks the session's turns, tools and usage.
