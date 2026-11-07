# Trace a durable workflow

A durable workflow keeps going when its process doesn't. A step fails and is retried, a server is
killed in the middle of a step and another one picks the run up, a sleep lasts a day, and a deploy
lands in between. coding.sh records such a run as one session, however many processes, traces and
deploys it crosses, and shows each step with its attempts, the waits as waiting rather than work,
and the points where the run resumed.
Site version: [coding.sh/docs/how-to/trace-durable-workflow](https://coding.sh/docs/how-to/trace-durable-workflow).

This page sets it up for the Vercel Workflow SDK and Temporal, then for Inngest, Restate, DBOS,
LangGraph and Cloudflare Workflows, in TypeScript and, for Temporal, Restate and DBOS, in Python.
Each sends OpenTelemetry to the local collector; nothing else is needed on the coding.sh side.
Every engine here was checked with a real run: a step that fails once, a worker killed in the
middle of a step, a sleep, and a restart on a new version.

## Start the collector

```sh
coding.sh collector
```

It listens on `127.0.0.1:4318` and takes OTLP over HTTP, as JSON or protobuf.

## Vercel Workflow SDK

The Workflow SDK traces itself when `@opentelemetry/api` is installed and a tracer provider is
registered before your code loads. Install the SDK packages next to `workflow`:

```sh
npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http
```

Register the provider in a file you preload, for example `otel.mjs`. Give each process its own
`service.instance.id` and set `service.version` to your release, so coding.sh can tell a crash
from a deploy:

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
with the AI SDK inside a step show up under that step when `experimental_telemetry` is on:

```js
export async function search(outline) {
  "use step";
  const { text } = await generateText({ model, prompt: outline, experimental_telemetry: { isEnabled: true } });
  return text;
}
```

The session id is the run id (`wrun_…`). It doesn't matter whether the SDK starts a new trace per
delivery (the default, `WORKFLOW_TRACE_MODE=linked`) or keeps one (`continuous`).

On the local world, a run only recovers after a crash if something calls the world's `start()` at
startup. With Nitro, a plugin does it:

```ts
import { definePlugin } from "nitro";

export default definePlugin(async () => {
  const { getWorld } = await import("workflow/runtime");
  await (await getWorld()).start?.();
});
```

## Temporal

Add the OpenTelemetry plugin to both the client and the worker. With it on both sides, the
workflow's trace context is stored in its history, and every later worker continues the same trace.

```sh
npm install @temporalio/interceptors-opentelemetry @opentelemetry/api@1.9.0 @opentelemetry/sdk-trace-node@1 @opentelemetry/resources@1 @opentelemetry/exporter-trace-otlp-http@0.57
```

`@temporalio/interceptors-opentelemetry` is built on version 1 of the OpenTelemetry JS SDK. For
version 2, use `@temporalio/interceptors-opentelemetry-v2`.

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

Activities are the steps. The session id is `temporal:<workflow id>:<run id>`. If only the
activity interceptors are installed, each activity is its own trace; the run still comes out as
one session, because every activity span names its workflow.

**Python.** Build the global provider with `create_tracer_provider()` from
`temporalio.contrib.opentelemetry`, then pass `OpenTelemetryPlugin(add_temporal_spans=True)` to
`Client.connect` only; the worker inherits it. `add_temporal_spans` defaults to `False`, and then
the plugin emits no Temporal spans at all, so each model call becomes an unrelated trace. The
Python client's start span names no run id: when it reaches the collector before any worker's
span, the session id is the run's trace id instead.

**Sleeps.** Temporal exports no timer span. A workflow interceptor in TypeScript wraps every
`sleep()` in one; register the module with `interceptors: { workflowModules: [...] }` on the
worker. The worker copies the workflow and run ids onto the span, so it joins the run:

```js
// sleep-spans.mjs
import { trace } from "@opentelemetry/api";
export const interceptors = () => ({ outbound: [{ async startTimer(input, next) {
  const name = input.options?.summary ?? "sleep";
  const span = trace.getTracer("workflow-sleep").startSpan(`sleep ${name}`, { startTime: Date.now(), attributes: { "workflow.wait.name": name, "workflow.wait.duration": input.durationMs } });
  try { return await next(input); } finally { span.end(Date.now()); }
} }] });
```

Python has no timer interceptor, so wrap the sleep and name the run yourself. The span starts at
workflow time when the sleep began, and the worker that wakes it up ends it, even after a deploy:

```python
info = workflow.info()
with opentelemetry.trace.get_tracer(__name__).start_as_current_span("sleep pause", attributes={"workflow.wait.name": "pause", "temporalWorkflowID": info.workflow_id, "temporalRunID": info.run_id}):
    await workflow.sleep(timedelta(seconds=6))
```

## Other engines

Whatever the engine, register a tracer provider in each process with its own `service.instance.id`
and a `service.version` for the release, as in the Vercel example above. That is how coding.sh
tells a crash from a deploy.

**Inngest.** Add `extendedTracesMiddleware()` from `inngest/experimental` to the client, after your
provider is registered. Pin one copy of the OpenTelemetry API, or Inngest's own copy ignores your
provider without saying so:

```json
"overrides": { "@opentelemetry/api": "1.9.0" }
```

Steps show up through the spans made inside them, such as AI SDK model calls. The session id is
`inngest:<run id>`.

Inngest exports no sleep, and its middleware never sees one. To show a sleep as a wait, keep its
start time in a step and make the span in a step after it, which runs in whichever process wakes
up:

```js
const t0 = await step.run("pause:start", () => Date.now());
await step.sleep("pause", "6s");
await step.run("pause:woke", () => trace.getTracer("app").startSpan("sleep pause", { startTime: t0, attributes: { "workflow.wait.name": "pause" } }).end());
```

**Restate.** Point the server at the collector, with the path:
`RESTATE_TRACING_ENDPOINT=otlp+json+http://127.0.0.1:4318/v1/traces`. In the service, add the SDK's
hook, which needs version 2 of the OpenTelemetry JS SDK:

```js
import { openTelemetryHook } from "@restatedev/restate-sdk-opentelemetry";
// restate.workflow({ name, handlers, options: { hooks: [openTelemetryHook({ tracer })] } })
```

`ctx.run` closures are the steps. One invocation is one trace, so the session id is its trace id;
`coding.sh show` names the invocation id. A sleep is a wait, from the server's journal.

In Python, the SDK makes no spans. Wrap your provider in `RestateTracerProvider` from
`restate.ext.tracing` and make model calls through its tracer, so they join the server's trace.
The steps then come from the server's journal: each `ctx.run` that an attempt started and finished.

**DBOS.** Register your own provider and set `tracingEnabled: true` and `enableOTLP: false` in
`DBOS.setConfig`. DBOS's own exporter sends only its spans, so model calls inside steps would be
missing. Steps are the step functions; the session id is `dbos:<workflow id>`. In Python, set your
provider as the global one and pass `enable_otlp: True` with no `otlp_traces_endpoints`; DBOS then
makes its spans on your provider.

DBOS TypeScript exports no sleep (DBOS Python marks where one starts). To show it as a wait, take
a checkpointed start time, so a recovered run keeps the first one, and make the span in a step
after the sleep:

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
`LANGSMITH_OTEL_ONLY=true`, no API key needed). For LangSmith, set your provider as the global
one first; LangSmith's built-in provider has no process id. Nodes are the steps, an
`interrupt()` is a wait, and the session id is the `thread_id`.

**Cloudflare Workflows** and engines without tracing: put `workflow.run.id`, `workflow.name`,
`step.name`, `step.id` and `step.attempt` on a span per step attempt, with status ERROR when it
fails, and a span with `workflow.wait.name` for a sleep. In a Workflow, `ctx.step.name`,
`ctx.step.count` and `ctx.attempt` come with each `step.do` callback. `wrangler dev` exports no
traces, so post OTLP/HTTP JSON to the collector from the Worker yourself.

## What you see

`coding.sh sessions` lists the run once, titled with the workflow's name. `coding.sh show <id>`
adds the run's shape to the header and a line per step. This is a real Vercel run: `search`
failed once and was retried, the server was killed while `read` was running, the workflow slept
for six seconds, and `write` ran on a new release:

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

Busy time counts only when something ran. Sleeps are waiting, and the rest (retry backoff,
queueing, the gap while no process held the run) is idle. The killed attempt never reported a
span, so it shows as lost: it starts when its process last reported and runs as long as that
process was still seen (here, not at all), then the run was down until the next attempt.

The session gets two flags, shown in the viewer and in `show --json`: `step-retried` when any step
needed more than one attempt, and `resumed` when the run continued after a crash, a deploy or a
restart.

`coding.sh workflows show <id>` prints the run as a tree, one line per attempt, and
`coding.sh workflows stats <id>` puts the waits and retries next to the critical path. Sleep time
is not counted as orchestration overhead there, and the downtime after a crash is its own row,
"lost to crashes", instead of agent time. In `coding.sh ui`, the session page has a lane per
step with a bar per attempt (failed in red, lost hatched), the waits as hatched gaps, and a tick
where the run resumed. Click a bar to jump to that attempt's span.

## Replays and tokens

Durable engines re-run the workflow function from its history to find where it left off. The
Vercel SDK marks those runs (`workflow.execution.mode=replay`), and coding.sh leaves model calls
made under them out of the session's tokens and cost, so a resumed run isn't billed twice.
DBOS TypeScript marks replayed steps `cached`, and they show as replayed. DBOS Python doesn't, but
it never runs a finished step twice, so a later span of one is read as a replay. Temporal and
Restate don't export replayed spans at all.

## Limits

- No engine exports an attempt killed with its process. coding.sh infers it, and counts as busy
  only the time its process was still seen; the rest is lost to the crash.
- Temporal, Inngest and DBOS TypeScript export no sleep, so without the snippets above a sleep
  shows as idle time, not as a wait. The Inngest and DBOS snippets add a short step after the
  sleep. Temporal, Restate and LangGraph put no attempt number on spans; coding.sh numbers
  attempts by order.
- Inngest exports no error text for a failed step, and its session is titled by run id, since
  spans name the function only by an internal id. The Restate server records no error text
  either, only "transient failure".
- A DBOS TypeScript process killed in the middle of a step looks like one that stopped cleanly,
  so the run shows a resume after a restart, not a crash. DBOS Python's sleep marker tells the two
  apart.
- With DBOS's native exporter (`otlp_traces_endpoints`, or `enableOTLP` in TypeScript), your own
  spans are dropped, the model calls among them.
- A local Cloudflare Workflow doesn't pick a run up again after `wrangler dev` restarts until you
  call `pause()` and `resume()` on the instance, so a local run shows that wait as downtime.

The span names and attributes behind all this, per engine, are in
[research/durable-workflows.md](../research/durable-workflows.md).
