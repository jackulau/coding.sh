# Durable workflow engines: what their telemetry says about a run

Research date: 2026-11-07. Sources: engine source at the pinned commits below, the official docs, and two real runs (Temporal, Vercel Workflow) captured on a local machine against `coding.sh collector`. Anything neither read in source nor seen in a run is marked **unverified**.

The question: a durable run can cross processes, crashes, deploys and days. What do the engines emit so coding.sh can show it as one session, with each step's attempts, sleeps as waiting, replays not counted twice, and the points where it resumed?

## Summary

Trace id is not a run key. Vercel starts a new trace per queue delivery by default, Inngest does not parent its span on the incoming traceparent, and LangGraph starts a trace per graph invocation. coding.sh groups by the engine's run id and falls back to the trace only when no run id is present.

| Engine | Run key | Step | Attempt on spans | Sleep / wait | Replay on spans | How coding.sh was checked |
|---|---|---|---|---|---|---|
| Vercel Workflow 5.4 | `workflow.run.id` (`wrun_…`) | `step.execute <name>`: `step.name`, `step.id` | `step.attempt`, failed attempts only | `world.events.create wait_created` / `wait_completed` spans | `workflow.run` `workflow.execution.mode=replay` | real run, linked and continuous trace modes |
| Temporal TS 1.25 | `temporalWorkflowId` + `run_id` | `StartActivity:<type>` (schedule) → `RunActivity:<type>` (attempt) | none | none (a timer is a gap) | not exported | real run, plugin and activity-interceptor setups |
| Inngest 4.26 | `sdk.run.id` | `inngest.step.id` | `inngest.step.attempt` (from 0) | server-side only | n/a | source only |
| Restate 1.x | `restate.invocation.id` | SDK `run (<name>)`, `restate.run.name` | none (one `invocation-attempt` span each) | journal command event | SDK skips replayed `run` | source only |
| DBOS | `dbos.operation.workflow_id` / `operationUUID` | span with `operationType=step` | span events `Step attempt N failed` | Python `sleep` span | `cached: true` | source only |
| LangGraph 1.2 | `thread_id` (`langsmith.metadata.thread_id`, `session.id`) | `langgraph_node`, `langgraph_step` | none | none (interrupts are new invocations) | n/a | source only |
| Cloudflare Workflows | none built in | none | none | none | none | docs only; needs the manual attributes below |

An engine with no integration, Cloudflare Workflows included, can set `workflow.run.id`, `step.name`, `step.id` and `step.attempt` on its own spans. coding.sh reads those as a generic durable run.

Where the process and version come from: `service.instance.id` (else `faas.instance`, else host and pid) and `deployment.id` / `service.version`. A version change between two steps is a deploy.

## Vercel Workflow SDK

Pinned: vercel/workflow @ `4beb5bcc` (`@workflow/core` and `workflow` 5.4.0, `@workflow/world-local` 5.2.1). Sources: [semantic-conventions.ts](https://github.com/vercel/workflow/blob/4beb5bcccdfbe9686ef56df6bbfa745caf993c86/packages/core/src/telemetry/semantic-conventions.ts), [runtime.ts](https://github.com/vercel/workflow/blob/4beb5bcccdfbe9686ef56df6bbfa745caf993c86/packages/core/src/runtime.ts#L528), [step-executor.ts](https://github.com/vercel/workflow/blob/4beb5bcccdfbe9686ef56df6bbfa745caf993c86/packages/core/src/runtime/spec9/step-executor.ts#L426), [tracing.mdx](https://github.com/vercel/workflow/blob/4beb5bcccdfbe9686ef56df6bbfa745caf993c86/docs/content/docs/v5/observability/tracing.mdx), [events.ts](https://github.com/vercel/workflow/blob/4beb5bcccdfbe9686ef56df6bbfa745caf993c86/packages/world/src/events.ts).

Tracer `workflow`; tracing is a no-op without `@opentelemetry/api` installed.

| Span | Meaning | Attributes coding.sh reads |
|---|---|---|
| `workflow.start <name>` | `start()` called | `workflow.run.id`, `workflow.name`, `deployment.id` |
| `workflow.execute <name>` | one queue delivery (one invocation) | `workflow.delivery.attempt`, `workflow.trace.propagated` |
| `workflow.run <name>` | the workflow function replaying its event log | `workflow.execution.mode` (`replay` or `retained`) |
| `step.execute <name>` | one step attempt | `step.name`, `step.id`, `step.attempt`, `step.error.message`, `step.retry.will_retry` |
| `world.events.create <type>` | event log write | `wait_created`, `wait_completed`, `step_retrying` |

Trace modes (`WORKFLOW_TRACE_MODE`): `linked`, the default, starts a new trace per delivery with a span link back; `continuous` keeps one trace id for the run. Either way, query by `workflow.run.id`.

History, as an alternative to traces: `npx workflow inspect events --runId=wrun_… --json --all`, `world.events.list({ runId })`, or `.workflow-data/events/<runId>/*.json` on the local world. Event types include `step_started`, `step_failed`, `step_retrying`, `wait_created`, `wait_completed`.

**What the real run showed** (Nitro, local world, a 4-step agent with one failing step, a killed server, a 6 s sleep and a restart on version 2):

- `workflow.name` and `step.name` are module paths (`workflow//./workflows/research//researchAgent`). The function name is after the last `//`.
- `step.attempt` is set only on failed attempts. A failed attempt's span has status OK; the failure is in `step.error.message` with `step.retry.will_retry=true`. Successful attempts are numbered by order.
- Every delivery has `workflow.delivery.attempt=1`, even the one after a crash. Recovery shows as `workflow.trace.propagated=false` on `workflow.execute`, plus a root `world.events.create step_retrying` span written at startup for the step that was running when the process died. The killed attempt's own span is lost.
- Sleeps are exact: `wait_created` and `wait_completed` spans bracket the wait.
- `deployment.id` is only on `workflow.start`; the restart's version came from `service.version` on the resource.
- In continuous mode, `workflow.execute` links to its HTTP handler's `route.flow` trace, which has no run id. coding.sh follows the link.
- The world's startup scan emits `world.runs.list` roots with no run id.
- Setup gotchas: the local world only recovers runs if a startup plugin calls `(await getWorld()).start?.()`. Bundled by Nitro, world-local looks for its version in a `package.json` next to the bundle; without one, `start()` throws `Invalid version string: "bundled"`, so the capture writes that file. OTel had to be pinned to `@opentelemetry/api` 1.9.0 with `sdk-trace-node` 2.12.0 and `exporter-trace-otlp-http` 0.223.0.

## Temporal (TypeScript)

Pinned: temporalio/sdk-typescript @ `615a684a` (`@temporalio/interceptors-opentelemetry` 1.25.0). Sources: [instrumentation.ts](https://github.com/temporalio/sdk-typescript/blob/615a684ac41a22c881df11157775e326843f7b04/contrib/interceptors-opentelemetry/src/instrumentation.ts), [workflow/definitions.ts](https://github.com/temporalio/sdk-typescript/blob/615a684ac41a22c881df11157775e326843f7b04/contrib/interceptors-opentelemetry/src/workflow/definitions.ts), [worker/index.ts](https://github.com/temporalio/sdk-typescript/blob/615a684ac41a22c881df11157775e326843f7b04/contrib/interceptors-opentelemetry/src/worker/index.ts#L60), [worker/sinks.ts](https://github.com/temporalio/sdk-typescript/blob/615a684ac41a22c881df11157775e326843f7b04/packages/worker/src/sinks.ts#L33).

| Span | Side | Attributes |
|---|---|---|
| `StartWorkflow:<type>` | client | `temporalWorkflowId`, `run_id` |
| `RunWorkflow:<type>` | workflow | every `WorkflowInfo` field merged in: `workflowId`, `runId`, `workflowType`, `attempt` (the workflow's), … |
| `StartActivity:<type>` | workflow | as above; parent of every attempt of that activity |
| `RunActivity:<type>` | activity worker | `temporalActivityId`; `temporalWorkflowId` and `run_id` when run from a workflow |

The `_tracer-data` header lives in workflow history, so every later worker continues the same trace: one execution is one trace id across days. Workflow spans leave the sandbox through a sink that is not called during replay, so replays are not exported. `info.attempt` exists on the activity context but is not written to the span. History (`handle.fetchHistory()`, `temporal workflow show --output json`) has the attempt numbers and the timers. Python (`temporalio.contrib.opentelemetry`) uses the same span names with `temporalWorkflowID` / `temporalRunID` keys ([_interceptor.py](https://github.com/temporalio/sdk-python/blob/72406f85e259e81ce165fc686f60e19a28b5c667/temporalio/contrib/opentelemetry/_interceptor.py)); unverified by a run.

Export: `new OpenTelemetryPlugin({ resource, spanProcessor })` on both the Client and the Worker, with an OTLP/HTTP exporter.

**What the real run showed** (TS SDK 1.25, local dev server, same scenario, worker killed with `-9` during `read`, a second worker stopped during the sleep, a third on `service.version` 2):

- The interceptor package is built on the OTel JS SDK 1.x; the capture pinned `sdk-trace-node` 1.30.1, `api` 1.9.0 and `exporter-trace-otlp-http` 0.57.2. With SDK 2, use `@temporalio/interceptors-opentelemetry-v2` (not run).
- With the plugin on client and worker, the whole run is one trace. With only the activity interceptors, each activity is its own trace; the run id still joins them.
- No span says which attempt an activity is. A retry is a second `RunActivity` under the same `StartActivity`.
- The killed attempt's `RunActivity` span never arrives. What remains is a `StartActivity` that opens 14 s before its only reported attempt, which runs on a different worker. coding.sh reads a lead of 2 s or more on a new worker as an attempt lost with its process.
- `workflow.sleep` is a gap between activities; nothing marks it as a timer.

## Inngest

Pinned: inngest/inngest-js @ `5b7f23d6` (`inngest` 4.26.2). Sources: [otel/consts.ts](https://github.com/inngest/inngest-js/blob/5b7f23d695c7459edbbae9d570edd75e343f9b4b/packages/inngest/src/components/execution/otel/consts.ts), [otel/processor.ts](https://github.com/inngest/inngest-js/blob/5b7f23d695c7459edbbae9d570edd75e343f9b4b/packages/inngest/src/components/execution/otel/processor.ts).

The SDK makes one `inngest.execution` span per request from the executor; `InngestSpanProcessor` tags spans with `sdk.run.id`, `sys.function.id`, `inngest.step.id` and `inngest.step.attempt` (0-based). Step and sleep spans are made by the Inngest server and not exported to you. Each step is a separate request, and the SDK span is not parented on the incoming traceparent (kept as `inngest.traceparent`), so key on `sdk.run.id`. Export with `extendedTracesMiddleware({ behaviour: "extendProvider" })` on top of your own OTLP provider.

## Restate

Pinned: restatedev/restate @ `211a106f`, restatedev/sdk-typescript @ `492920de`. Sources: [tracing-instrumentation/lib.rs](https://github.com/restatedev/restate/blob/211a106fa1741059bb803d772156c0fc81c24ebf/crates/tracing-instrumentation/src/lib.rs), [exporter.rs](https://github.com/restatedev/restate/blob/211a106fa1741059bb803d772156c0fc81c24ebf/crates/tracing-instrumentation/src/exporter.rs).

Server spans `ingress <target>`, `invocation-start`, one `invocation-attempt <target>` per attempt (no attempt number), `invocation-end`, all with `restate.invocation.id` and `restate.invocation.target`. The SDK's `openTelemetryHook` adds `attempt <target>` and `run (<name>)` with `restate.run.name`, created only when the closure really runs, so replays are skipped. The span context is stored in the journal: one invocation is one trace id. Export with the server's `tracing-endpoint` (`otlp+json+http://…/v1/traces` for JSON). `sys_invocation.retry_count` in SQL introspection has retries.

## DBOS

Pinned: dbos-transact-ts @ `306b7324`, dbos-transact-py @ `236142bd`. Sources: [traces.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/306b7324a050d3fc661aec4c4eef774c8bd38336/src/telemetry/traces.ts), [_tracer.py](https://github.com/dbos-inc/dbos-transact-py/blob/236142bd7a99ff77d04becf5f405a60d6f330591/dbos/_tracer.py).

Tracer `dbos-tracer`; spans are named after the function. Keys: `operationUUID` / `dbos.operation.workflow_id`, `operationType` (`workflow`, `step`, `transaction`), `operationName`, `executorID`, `applicationVersion`. Retries stay inside one step span as events `Step attempt N failed`. A step answered from the system database on recovery has `cached: true`. Python keeps the trace context in workflow attributes, so a recovered workflow continues its trace.

## LangGraph

Pinned: langgraph @ `e5e37b5d` (1.2.20), langsmith-sdk @ `290f06a6`, openinference @ `6be7118f`. Sources: [pregel/_algo.py](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/langgraph/pregel/_algo.py#L655), [LangSmith OTel exporter](https://github.com/langchain-ai/langsmith-sdk/blob/290f06a628dffb2ca690e389dc48b629f5623312/python/langsmith/_internal/otel/_otel_exporter.py), [OpenInference tracer](https://github.com/Arize-ai/openinference/blob/6be7118f789c9cd3c71b3375810fe9250050fe31/python/instrumentation/openinference-instrumentation-langchain/src/openinference/instrumentation/langchain/_tracer.py#L1456).

LangGraph emits no spans itself; tracers turn its metadata into attributes. LangSmith OTel writes `langsmith.metadata.thread_id`, `langsmith.metadata.langgraph_node` and `langsmith.metadata.langgraph_step`; OpenInference writes `session.id` and a JSON `metadata` attribute. A resumed thread (after an interrupt, or days later, through a checkpointer) is a new trace with the same `thread_id`, which is the run key. History: `graph.get_state_history({"configurable": {"thread_id": …}})`.

## Cloudflare Workflows

Sources: [Workers spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), [OTel export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/), [instance events](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/), [step context](https://developers.cloudflare.com/workflows/build/step-context/).

Workers tracing documents no instance id, workflow name, step name or attempt. Set them yourself: `tracing.getActiveSpan()?.setAttributes({ "workflow.run.id": instanceId, "step.name": ctx.step.name, "step.attempt": ctx.attempt })` from `cloudflare:workers`. Export is OTLP/HTTP JSON to a dashboard destination (`observability.traces.destinations`). Instance events (`attempt_started`, `attempt_errored`, `sleep_started`, `sleep_completed`, …) are the richer source.

## Gaps

1. Temporal: no attempt number and no timer on spans; a crashed attempt leaves no span. Attempts come from the `StartActivity` → `RunActivity` structure, and the lost one is inferred from timing.
2. Vercel: the killed attempt has no span, so its length is unknown; coding.sh shows it as lost with no duration.
3. Both real captures used a recorder that forwarded each OTLP request to the collector before replying. Spans buffered in a process when it was killed are lost either way; the kill tests may have lost a little more than a real exporter would.
4. Inngest, Restate, DBOS and LangGraph mappings come from reading source; no run was captured. Cloudflare relies on the manual attributes.
5. Temporal replays are never exported, so the replay path was tested with Vercel's `workflow.execution.mode=replay` and synthetic spans only.
