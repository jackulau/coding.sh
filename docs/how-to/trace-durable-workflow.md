# Trace a durable workflow

A durable workflow keeps going when its process doesn't: a step is retried, another server picks up
a killed run, a sleep lasts a day, a deploy lands in between. coding.sh records such a run as one
session, however many processes and deploys it crosses, with each step's attempts, the waits, and
the points where the run resumed.
Site version: [coding.sh/docs/how-to/trace-durable-workflow](https://coding.sh/docs/how-to/trace-durable-workflow).

This is a real Vercel Workflow run in `coding.sh show <id>`: `search` failed once and was retried,
the server was killed while `read` was running, the workflow slept for six seconds, and `write` ran
on a new release:

```text
  Workflow      vercel-workflow researchAgent (run wrun_01M6VR4652F71REEM5KNF4TQ95): 4 steps, 2 retries, 1 wait, 3 processes
  Time          wall 11s: busy 1.2s, waiting 6.4s, idle 2.9s
  Resumed       after a crash at read, 1.9s later; after a deploy (1 → 2) at write, 2.3s later

Steps
     +22ms  plan    ok      #1 ok 166ms
    +204ms  search  ok      #1 failed 162ms (search API returned 503) → #2 ok 163ms
     +1.5s  read    ok      1 lost (its process stopped; seen 0ms, then down 2.0s) → #2 ok 375ms
     +3.9s  (wait)  done    wait 6.4s
      +10s  write   ok      #1 ok 176ms
```

The Vercel Workflow SDK, Temporal, Inngest, Restate, DBOS, LangGraph and Cloudflare Workflows
each send OpenTelemetry to the local collector, in TypeScript and, for Temporal, Restate and DBOS,
in Python. Nothing else is needed on the coding.sh side. Every engine was checked with a real
run: a step that fails once, a worker killed mid-step, a sleep, and a restart on a new version.

## Before you start

- coding.sh is installed: `npm i -g coding.sh`.
- Your workflow runs on one of the engines in the table under step 2.

## 1. Start the collector

```sh
coding.sh collector
```

It listens on `127.0.0.1:4318` and takes OTLP over HTTP, as JSON or protobuf.

## 2. Trace your engine

In every engine, register a tracer provider in each process with its own `service.instance.id`
and a `service.version` for the release. That is how coding.sh tells a crash from a deploy.

| Engine | Steps are | Session id | Sleeps |
| --- | --- | --- | --- |
| Vercel Workflow SDK | `"use step"` functions | the run id (`wrun_…`) | exported |
| Temporal | activities | `temporal:<workflow id>:<run id>` | add an interceptor (below) |
| Inngest | spans made inside steps | `inngest:<run id>` | add a step after the sleep |
| Restate | `ctx.run` closures | the invocation's trace id | from the server's journal |
| DBOS | step functions | `dbos:<workflow id>` | add a step after the sleep |
| LangGraph | nodes | the `thread_id` | an `interrupt()` is a wait |
| Cloudflare Workflows | spans you make per `step.do` | the `workflow.run.id` you set | a span with `workflow.wait.name` |

### Vercel Workflow SDK

The Workflow SDK traces itself when `@opentelemetry/api` is installed and a tracer provider is
registered before your code loads. Install the SDK packages next to `workflow`:

```sh
npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http
```

Register the provider in a file you preload, for example `otel.mjs`:

```js
import { randomUUID } from "node:crypto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "service.name": "research-app",
    "service.version": process.env.APP_VERSION ?? "1",
    "service.instance.id": randomUUID(),
  }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }))],
});
provider.register();
process.once("SIGTERM", () => provider.shutdown().finally(() => process.exit(0)));
```

Start the server with it: `node --import ./otel.mjs .output/server/index.mjs`. Model calls made
with the AI SDK inside a step show up under that step when telemetry is on. In AI SDK 7,
`new OpenTelemetry()` from `@ai-sdk/otel` uses the provider you registered:

```js
import { OpenTelemetry } from "@ai-sdk/otel";

export async function search(outline) {
  "use step";
  const { text } = await generateText({ model, prompt: outline, telemetry: { integrations: new OpenTelemetry() } });
  return text;
}
```

In AI SDK 6, pass `experimental_telemetry: { isEnabled: true }` instead.

Both `WORKFLOW_TRACE_MODE=linked` (the default) and `continuous` work. On the local world, a run
recovers after a crash only if something calls the world's `start()` at startup. With Nitro, a
plugin does it:

```ts
import { definePlugin } from "nitro";

export default definePlugin(async () => {
  const { getWorld } = await import("workflow/runtime");
  await (await getWorld()).start?.();
});
```

### Temporal

Add the OpenTelemetry plugin to both the client and the worker. Then the trace context is stored
in the workflow's history, and every later worker continues the same trace.

```sh
npm install @temporalio/interceptors-opentelemetry @opentelemetry/api@1.9.0 @opentelemetry/sdk-trace-node@1 @opentelemetry/resources@1 @opentelemetry/exporter-trace-otlp-http@0.57
```

The plugin is built on version 1 of the OpenTelemetry JS SDK. For version 2, use
`@temporalio/interceptors-opentelemetry-v2`.

```js
import { randomUUID } from "node:crypto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";

const resource = new Resource({
  "service.name": "research-worker",
  "service.version": process.env.APP_VERSION ?? "1",
  "service.instance.id": randomUUID(),
});
const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }));
new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] }).register();

const plugin = new OpenTelemetryPlugin({ resource, spanProcessor });
// Worker.create({ connection, taskQueue, workflowsPath, activities, plugins: [plugin] })
// new Client({ connection, plugins: [plugin] })
```

With only the activity interceptors, each activity is its own trace, and the run is still one
session.

**Python.** Build the global provider with `create_tracer_provider()` from
`temporalio.contrib.opentelemetry`, then pass `OpenTelemetryPlugin(add_temporal_spans=True)` to
`Client.connect` only; the worker inherits it. Without `add_temporal_spans=True` the plugin emits
no Temporal spans, and each model call becomes an unrelated trace.

**Sleeps.** Temporal exports no timer span. In TypeScript, a workflow interceptor wraps every
`sleep()` in one; register the module with `interceptors: { workflowModules: [...] }` on the
worker:

```js
// sleep-spans.mjs
import { trace } from "@opentelemetry/api";
export const interceptors = () => ({ outbound: [{ async startTimer(input, next) {
  const name = input.options?.summary ?? "sleep";
  const span = trace.getTracer("workflow-sleep").startSpan(`sleep ${name}`, { startTime: Date.now(), attributes: { "workflow.wait.name": name, "workflow.wait.duration": input.durationMs } });
  try { return await next(input); } finally { span.end(Date.now()); }
} }] });
```

Python has no timer interceptor, so wrap the sleep and name the run yourself:

```python
info = workflow.info()
with opentelemetry.trace.get_tracer(__name__).start_as_current_span("sleep pause", attributes={"workflow.wait.name": "pause", "temporalWorkflowID": info.workflow_id, "temporalRunID": info.run_id}):
    await workflow.sleep(timedelta(seconds=6))
```

### Other engines

**Inngest.** Add `extendedTracesMiddleware()` from `inngest/experimental` to the client, after your
provider is registered. Pin one copy of the OpenTelemetry API, or Inngest's own copy silently
ignores your provider:

```json
"overrides": { "@opentelemetry/api": "1.9.0" }
```

Inngest exports no sleep. To show one as a wait, keep its start time in a step and make the span in
a step after it:

```js
const t0 = await step.run("pause:start", () => Date.now());
await step.sleep("pause", "6s");
await step.run("pause:woke", () => trace.getTracer("app").startSpan("sleep pause", { startTime: t0, attributes: { "workflow.wait.name": "pause" } }).end());
```

**Restate.** Point the server at the collector:
`RESTATE_TRACING_ENDPOINT=otlp+json+http://127.0.0.1:4318/v1/traces`. In the service, add the
SDK's hook, which needs version 2 of the OpenTelemetry JS SDK:

```js
import { openTelemetryHook } from "@restatedev/restate-sdk-opentelemetry";
// restate.workflow({ name, handlers, options: { hooks: [openTelemetryHook({ tracer })] } })
```

`coding.sh show` names the invocation id. In Python the SDK makes no spans: wrap your provider in
`RestateTracerProvider` from `restate.ext.tracing` and make model calls through its tracer.

**DBOS.** Register your own provider and set `tracingEnabled: true` and `enableOTLP: false` in
`DBOS.setConfig`; DBOS's own exporter drops your spans, model calls among them. In Python, set your
provider as the global one and pass `enable_otlp: True` with no `otlp_traces_endpoints`.

DBOS TypeScript exports no sleep. Take a checkpointed start time, so a recovered run keeps the
first one, and make the span in a step after the sleep:

```js
const t0 = await DBOS.now();
await DBOS.sleep(6000);
await DBOS.runStep(async () => trace.getTracer("app").startSpan("sleep cooldown", { startTime: t0, attributes: { "workflow.wait.name": "cooldown", "dbos.operation.workflow_id": DBOS.workflowID } }).end(), { name: "cooldown:woke" });
```

The same in Python:

```python
t0 = DBOS.run_step({"name": "sleep_start"}, time.time_ns)
DBOS.sleep(6)
trace.get_tracer("app").start_span("sleep cool-down", start_time=t0, attributes={"workflow.wait.name": "cool-down", "dbos.operation.workflow_id": DBOS.workflow_id}).end()
```

**LangGraph.** Use a checkpointer and a tracer: OpenInference
(`LangChainInstrumentor().instrument(tracer_provider=provider)`) or LangSmith in
OpenTelemetry-only mode (`LANGSMITH_TRACING=true`, `LANGSMITH_OTEL_ENABLED=true`,
`LANGSMITH_OTEL_ONLY=true`, no API key needed). For LangSmith, set your provider as the global one
first; its built-in provider has no process id.

**Cloudflare Workflows** and engines without tracing: put `workflow.run.id`, `workflow.name`,
`step.name`, `step.id` and `step.attempt` on a span per step attempt, with status ERROR when it
fails. In a Workflow, `ctx.step.name`, `ctx.step.count` and `ctx.attempt` come with each `step.do`
callback. `wrangler dev` exports no traces, so post OTLP/HTTP JSON to the collector yourself.

## 3. Read the run

`coding.sh sessions` lists the run once, titled with the workflow's name, and `coding.sh show <id>`
prints it as at the top of this page.

| Where | What it shows |
| --- | --- |
| `Time` line | busy (something ran), waiting (sleeps), idle (backoff, queueing, no process held the run) |
| a lost attempt | an attempt whose process died; busy only while that process was still seen |
| flags | `step-retried` when a step needed a second attempt; `resumed` after a crash, deploy or restart |
| `coding.sh workflows show <id>` | the run as a tree, one line per attempt |
| `coding.sh workflows stats <id>` | waits and retries next to the critical path; crash downtime is its own row |
| `coding.sh ui` | a lane per step, a bar per attempt (failed red, lost hatched), and resume ticks |

Durable engines re-run the workflow function from its history. coding.sh leaves model calls made
during those replays out of the session's tokens and cost, so a resumed run isn't billed twice.

## Limits

- No engine exports an attempt killed with its process. coding.sh infers it.
- Without the snippets above, a sleep in Temporal, Inngest or DBOS TypeScript shows as idle time,
  not a wait.
- Temporal, Restate and LangGraph put no attempt number on spans; coding.sh numbers attempts by
  order.
- Inngest exports no error text for a failed step, and titles sessions by run id. The Restate
  server records only "transient failure".
- A DBOS TypeScript process killed mid-step looks like a clean stop, so the run shows a restart,
  not a crash. DBOS Python tells the two apart.
- A local Cloudflare Workflow is not picked up again after `wrangler dev` restarts until you call
  `pause()` and `resume()`, so that wait shows as downtime.

## Next steps

- [Trace a framework with OpenTelemetry](https://coding.sh/docs/otel): agent frameworks, sent to the
  same collector.
- [Workflows](https://coding.sh/docs/workflows): every `coding.sh workflows` command.
- [Evals](https://coding.sh/docs/evals): turn a run that went wrong into a case.
