# Tee Agent Runs to coding.sh

Agent Runs tracing (`@vercel/agent-runs`) records each agent turn as OpenTelemetry spans for Vercel
Agent Runs. eve and durable-harness use it. You can send the same spans to the coding.sh receiver
as well, so each run is also a local coding.sh session with its turns, model calls, tool calls,
usage and cost. Vercel Agent Runs keeps getting its copy.

## 1. Start the receiver

```sh
npx coding.sh collector
```

It listens on `127.0.0.1:4318` and takes OTLP over HTTP, as JSON or protobuf.

## 2. Add a span processor

### durable-harness

`agentRuns()` from `durable-harness/instrumentation/otel` takes `spanProcessors`: more
destinations that get the same spans as Agent Runs. Add a batch processor around an OTLP
exporter that points at the receiver:

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

Install the exporter next to the tracing peers durable-harness already needs
(`@opentelemetry/sdk-trace-base`, `@opentelemetry/resources`, `@vercel/agent-runs`). Tracing needs
Node.js 24.

A session's `traceAudience` decides what the spans record, for coding.sh as for Agent Runs. With
the default capture, `private` and `unknown` sessions record models, tools, timing and usage but
no prompts or replies. Pass `capture` to `agentRuns()` to change that.

### eve

eve sets up Agent Runs itself. Add the receiver as another destination in its own file under
`agent/instrumentation/`:

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
npx coding.sh sessions
npx coding.sh ui
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
