# Durable workflow engines: what their telemetry says about a run

Research date: 2026-11-07. Sources: engine source at the pinned commits below, the official docs, and a real run of every engine on this page, captured on a Linux machine against `coding.sh collector`. Each run is the same scenario: a four-step agent whose `search` step fails once and is retried, a worker killed with `kill -9` in the middle of `read`, a durable sleep (for LangGraph, a human-in-the-loop interrupt), and a restart on version 2 during it. The model is a local stub. The captures are CI fixtures in `packages/coding.sh/test/fixtures/otel/durable/`. Anything neither read in source nor seen in a run is marked **unverified**.

The question: a durable run can cross processes, crashes, deploys and days. What do the engines emit so coding.sh can show it as one session, with each step's attempts, sleeps as waiting, replays not counted twice, and the points where it resumed?

## Summary

Trace id is not a run key. Vercel starts a new trace per queue delivery by default, Inngest does not parent its span on the incoming traceparent, and LangGraph starts a trace per graph invocation. coding.sh groups by the engine's run id and falls back to the trace only when no run id is present.

| Engine | Run key | Step | Attempt on spans | Sleep / wait | Replay on spans | How coding.sh was checked |
|---|---|---|---|---|---|---|
| Vercel Workflow 5.4 | `workflow.run.id` (`wrun_…`) | `step.execute <name>`: `step.name`, `step.id` | `step.attempt`, failed attempts only | `world.events.create wait_created` / `wait_completed` spans | `workflow.run` `workflow.execution.mode=replay` | real run, linked and continuous trace modes |
| Temporal TS 1.25 | `temporalWorkflowId` + `run_id` | `StartActivity:<type>` (schedule) → `RunActivity:<type>` (attempt) | none | none (a timer is a gap) | not exported | real run, plugin and activity-interceptor setups |
| Temporal Python 1.35 | `temporalWorkflowID` + `temporalRunID` (the client's start span has no run id) | as TS | none | none | not exported | real run, `OpenTelemetryPlugin` and the legacy `TracingInterceptor` |
| Inngest 4.26 | `sdk.run.id` | your spans inside a step carry `inngest.step.id` | `inngest.step.attempt` (from 0) | none exported | none | real run, Dev Server 1.51 |
| Restate 1.8 | `restate.invocation.id`; one invocation is one trace | SDK `run (<name>)`, with only `restate.run.name` | none (one server `invocation-attempt` span each) | `Command/Sleep` event on `invocation-attempt` | none; replayed `run` closures emit nothing | real run, server 1.8.1 and TS SDK 1.18 |
| Restate Python 1.4 | as above | none: journal events on `invocation-attempt` | none | as above | none | real run, server 1.8.1 and `restate-sdk` 1.4.2 |
| DBOS TS 5.4 | `operationUUID` / `dbos.operation.workflow_id` | span with `operationType=step` | span events `Step attempt N failed` | none in TS | `cached: true` | real run, Postgres 16 |
| DBOS Python 3.4 | as TS | as TS | span events `Step attempt N failed` (N from 0) | a `sleep` span as the sleep starts | none | real run, Postgres 16 |
| LangGraph 1.2 | `thread_id` (`langsmith.metadata.thread_id`, `session.id`) | `langgraph_node` | none | `GraphInterrupt` exception on the node span | n/a | real run, SQLite checkpointer, OpenInference and LangSmith tracers |
| Cloudflare Workflows | none built in | none | none (`ctx.attempt` in code) | none | none | real run under `wrangler dev` 4.158, with the attributes below set by the Worker |

An engine with no integration, Cloudflare Workflows included, can set `workflow.run.id`, `workflow.name`, `step.name`, `step.id` and `step.attempt` on its own spans, with status ERROR on a failed attempt, and mark a sleep with a span that has `workflow.wait.name` (or is named `sleep <name>`). coding.sh reads those as a generic durable run.

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

The `_tracer-data` header lives in workflow history, so every later worker continues the same trace: one execution is one trace id across days. Workflow spans leave the sandbox through a sink that is not called during replay, so replays are not exported. `info.attempt` exists on the activity context but is not written to the span. History (`handle.fetchHistory()`, `temporal workflow show --output json`) has the attempt numbers and the timers. Python (`temporalio.contrib.opentelemetry`) uses the same span names with `temporalWorkflowID` / `temporalRunID` keys ([_interceptor.py](https://github.com/temporalio/sdk-python/blob/72406f85e259e81ce165fc686f60e19a28b5c667/temporalio/contrib/opentelemetry/_interceptor.py)); see [Temporal (Python)](#temporal-python).

Export: `new OpenTelemetryPlugin({ resource, spanProcessor })` on both the Client and the Worker, with an OTLP/HTTP exporter.

**What the real run showed** (TS SDK 1.25, local dev server, same scenario, worker killed with `-9` during `read`, a second worker stopped during the sleep, a third on `service.version` 2):

- The interceptor package is built on the OTel JS SDK 1.x; the capture pinned `sdk-trace-node` 1.30.1, `api` 1.9.0 and `exporter-trace-otlp-http` 0.57.2. With SDK 2, use `@temporalio/interceptors-opentelemetry-v2` (not run).
- With the plugin on client and worker, the whole run is one trace. With only the activity interceptors, each activity is its own trace; the run id still joins them.
- No span says which attempt an activity is. A retry is a second `RunActivity` under the same `StartActivity`.
- The killed attempt's `RunActivity` span never arrives. What remains is a `StartActivity` that opens 14 s before its only reported attempt, which runs on a different worker. coding.sh reads a lead of 2 s or more on a new worker as an attempt lost with its process.
- `workflow.sleep` is a gap between activities; nothing marks it as a timer. A workflow outbound interceptor (`startTimer`) can wrap every sleep in a span with `workflow.wait.name`; the worker copies the workflow info onto it, and coding.sh reads it as a wait. Checked with a real run: the span starts with the workflow task where the sleep began and ends with the one after `TimerFired`, exported by the version-2 worker that woke it.

## Temporal (Python)

**What the real run showed** (`temporalio` 1.35.0, Temporal CLI 1.10.0 dev server, OTel Python 1.45.2, Python 3.12, the same scenario):

- The SDK README calls `OpenTelemetryPlugin` the recommended path. It needs the global provider from `create_tracer_provider()` (else ValueError) and goes on the client only; the worker inherits it, and adding it to both duplicates spans. `add_temporal_spans` defaults to `False`, and then no Temporal span is made and no context is propagated: each model call is its own trace, five unrelated sessions and no run.
- With `add_temporal_spans=True` the run is one trace with the TS span names, keyed `temporalWorkflowID`, `temporalRunID` and `temporalActivityID`. There is no attempt number and no activity type attribute; a retry is a second `RunActivity` under the same `StartActivity`, and the failed attempt has status ERROR `RuntimeError: search API returned 503`.
- `RunWorkflow` is sent once, by the worker that finishes the run, with its real start from workflow time. Replayed spans are never sent.
- The client's `StartWorkflow` has `temporalWorkflowID` only. coding.sh gives it its trace's run; when the client's batch arrives before any worker's, the trace id keys the session, so two runs of one workflow id don't merge.
- The killed attempt left no `RunActivity`; its `StartActivity` opened 6.8 s before the next attempt, on a new worker. coding.sh's TS rule applies unchanged: read lost, then a crash and a deploy resume.
- The legacy `TracingInterceptor` gives the same steps; its workflow spans have no duration. Resources carry only `service.*` and `telemetry.sdk.*`.
- No timer interceptor exists in Python (`WorkflowOutboundInterceptor` has none). A span the workflow opens around `workflow.sleep`, with the run's ids and `workflow.wait.name`, is replay-safe: it started on the worker that began the sleep and was exported by the version-2 worker that woke it, 6045 ms for a 6 s timer. The legacy `completed_span()` makes an instant, which coding.sh closes at the next step.

## Inngest

Pinned: inngest/inngest-js @ `5b7f23d6` (`inngest` 4.26.2). Sources: [otel/consts.ts](https://github.com/inngest/inngest-js/blob/5b7f23d695c7459edbbae9d570edd75e343f9b4b/packages/inngest/src/components/execution/otel/consts.ts), [otel/processor.ts](https://github.com/inngest/inngest-js/blob/5b7f23d695c7459edbbae9d570edd75e343f9b4b/packages/inngest/src/components/execution/otel/processor.ts).

The SDK makes one `inngest.execution` span per request from the executor; `InngestSpanProcessor` tags spans with `sdk.run.id`, `sys.function.id`, `inngest.step.id` and `inngest.step.attempt` (0-based). Step and sleep spans are made by the Inngest server and not exported to you. Each step is a separate request, and the SDK span is not parented on the incoming traceparent (kept as `inngest.traceparent`), so key on `sdk.run.id`. Export with `extendedTracesMiddleware({ behaviour: "extendProvider" })` on top of your own OTLP provider.

**What the real run showed** (`inngest` 4.26.2, `inngest-cli` 1.51.0 Dev Server, OTel JS SDK 2.12; checkpointing on, the v4 default, and again with it off):

- Only two kinds of span reach your exporter: `inngest.execution`, one per request and each a new root, and your own spans made inside a step. Every span has status UNSET, the attempt that threw included.
- `inngest.step.id` and `inngest.step.attempt` are only on your spans inside a step, never on `inngest.execution`. `inngest.step.parentSpanId` is on the direct children only, so coding.sh takes those as the step's attempt and merges a step's spans with the same attempt number. A step with no instrumented code inside sends nothing.
- Inngest only reruns a step after a failure or a lost attempt, so coding.sh marks an attempt followed by a higher number as failed. The error text is not exported.
- `sys.function.id` is an internal UUID, not the function's name, so the session is titled `inngest run <run id>`.
- The killed attempt left no span. The next attempt is numbered 1, on a new process: coding.sh shows attempt 0 as lost there.
- No sleep, retry or recovery is exported; the sleep is idle time.
- Inngest copies its resource detectors onto every `inngest.execution` span: `host.name`, `os.*`, `process.owner`, `process.command`. coding.sh reads the process from the resource, but those attributes are stored with the span.
- Setup: npm installs a second `@opentelemetry/api` (1.10) under `inngest`, which then ignores your provider without an error; pin one copy with `"overrides": { "@opentelemetry/api": "1.9.0" }`. Register the provider before calling `extendedTracesMiddleware()`.

## Restate

Pinned: restatedev/restate @ `211a106f`, restatedev/sdk-typescript @ `492920de`. Sources: [tracing-instrumentation/lib.rs](https://github.com/restatedev/restate/blob/211a106fa1741059bb803d772156c0fc81c24ebf/crates/tracing-instrumentation/src/lib.rs), [exporter.rs](https://github.com/restatedev/restate/blob/211a106fa1741059bb803d772156c0fc81c24ebf/crates/tracing-instrumentation/src/exporter.rs).

Server spans `ingress <target>`, `invocation-start`, one `invocation-attempt <target>` per attempt (no attempt number), `invocation-end`, all with `restate.invocation.id` and `restate.invocation.target`. The SDK's `openTelemetryHook` adds `attempt <target>` and `run (<name>)` with `restate.run.name`, created only when the closure really runs, so replays are skipped. The span context is stored in the journal: one invocation is one trace id. Export with the server's `tracing-endpoint` (`otlp+json+http://…/v1/traces` for JSON).

**What the real run showed** (restate-server 1.8.1, `@restatedev/restate-sdk` and `@restatedev/restate-sdk-opentelemetry` 1.18.3, OTel JS SDK 2.12, a workflow with `inactivityTimeout: 1000` so the sleep suspends):

- The whole invocation, across 4 attempts, 3 processes and the deploy, is one trace.
- `run (<name>)` spans carry only `restate.run.name`, no invocation id. coding.sh takes the run from the trace. The hook's `additionalRunAttributes: (h) => ({ "restate.invocation.id": h.request.id })` puts it on the span too.
- Server spans come from a resource with `service.namespace=Restate` and the node as `service.instance.id`. coding.sh takes the process and version only from your service's spans. `restate.deployment.id` did not change across the deploy (the new version listens on the same endpoint, as it must, because an invocation is pinned to its deployment); `service.version` did.
- `invocation-attempt` has events `restate.invocation.lifecycle.new_command` (`Command/Run`, `Command/Sleep` with its name), `run_ended` and `suspended`. The sleep is exact from them: from `Command/Sleep` to the next attempt.
- The killed attempt's SDK spans never arrived, but its server `invocation-attempt` did: it ends with "transient failure" and its last event is `new_command Run read` with no `run_ended`. coding.sh shows that as the lost attempt of `read`, seen from that event to the attempt's end.
- The server only says "transient failure"; the error text is on the SDK `attempt` and `run` spans.
- The client's own span is the root of the trace and carries no invocation id. coding.sh keys a Restate session by trace id, so it joins the run.
- Workflow invocation ids are deterministic per workflow and key: three runs of the same key on fresh servers got the same id. Each run is its own trace, so each is its own session.

**What the Python run showed** (`restate-sdk` 1.4.2 on hypercorn 0.18, restate-server 1.8.1, OTel Python 1.45.2):

- The SDK makes no spans. `RestateTracerProvider` (`restate.ext.tracing`) parents your spans on the server's `invocation-attempt`, flat, and returns no-op spans while the handler replays. There is no `run` span and no SDK attempt span.
- The steps are in the server's journal events: each `new_command Command/Run <name>` opens a run, and `run_ended` closes it. A run that failed and was retried shows only `run_ended` at the start of the next attempt. coding.sh builds the steps from these events and takes each attempt's process from the spans under it.
- The killed attempt ended with `run read` open, and the next attempt ran on another process: coding.sh shows it as lost with that process. Both failed attempts say "transient failure", the thrown error and the broken pipe alike; the error text appears nowhere in OTLP.
- Your model spans reached the collector about 5 s before the server's own; the trace keys the session, so they join the run.
- Five attempts, three processes, the deploy and the sleep (exact from `Command/Sleep` to the next attempt) all came out as with the TS SDK.
- Setup: the tracing endpoint needs the `/v1/traces` path (without it the server posts to `/`), and plain `http://` means gRPC. The hook needs `@opentelemetry/core` 2.6 or later. `sys_invocation.retry_count` was empty on the completed run; `sys_journal_events` has the errors.

## DBOS

Pinned: dbos-transact-ts @ `306b7324`, dbos-transact-py @ `236142bd`. Sources: [traces.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/306b7324a050d3fc661aec4c4eef774c8bd38336/src/telemetry/traces.ts), [_tracer.py](https://github.com/dbos-inc/dbos-transact-py/blob/236142bd7a99ff77d04becf5f405a60d6f330591/dbos/_tracer.py).

Tracer `dbos-tracer`; spans are named after the function. Keys: `operationUUID` / `dbos.operation.workflow_id`, `operationType` (`workflow`, `step`, `transaction`), `operationName`, `executorID`, `applicationVersion`. Retries stay inside one step span as events `Step attempt N failed`. A step answered from the system database on recovery has `cached: true` in TS.

**What the real run showed** (`@dbos-inc/dbos-sdk` 5.4.0, TypeScript, Postgres 16, OTel JS SDK 2.12):

- DBOS's own export (`enableOTLP`) sends only DBOS spans: model calls inside steps are dropped, and the resource is only `service.name`. Register your own provider with `service.instance.id` and `service.version`, and set `tracingEnabled: true` and `enableOTLP: false`.
- `executorID` is `local` in every process, so it says nothing about the process; coding.sh ignores it.
- A retried step is one span. Each failure is an event (`Step attempt 2 failed` for the first one: the number is one ahead) with `error` and `retryIntervalSeconds`. coding.sh splits the span into attempts at the events.
- Each process is a new trace; TS keeps no trace context in the database. Replayed steps (`cached: true`, 1 to 3 ms) carry no function id, so coding.sh matches them by name and order under their workflow span.
- `DBOS.sleep` has no span in TS; the sleep is idle time. A span made in a step after the sleep, started at a checkpointed `DBOS.now()` and carrying `dbos.operation.workflow_id` and `workflow.wait.name`, shows it as a wait (checked with a real run; the version-2 process made it). DBOS's own exporter drops it, like every user span.
- Nothing is exported for the killed attempt, and nothing tells it from a graceful stop: the next process replays and runs the step, which shows as a resume after a restart.
- At launch DBOS emits a `probe` span (scope `otel-bootstrap-check`); coding.sh skips it. The workflow span keeps the attribute `status: "PENDING"` from its start; the span status is the outcome.
- Setup: DBOS loads OTel and `winston-transport` without declaring them. Recovery only picks up workflows with the same executor id and `applicationVersion`; the version-2 process took the run over with `cancelWorkflow` and `rewindWorkflow(id, { startStep, applicationVersion: "2" })`, which keeps the workflow id.

**What the Python run showed** (`dbos` 3.4.0, Python 3.12, Postgres 16, OTel Python 1.45.2):

- DBOS makes spans only with `enable_otlp: True`. With no `otlp_traces_endpoints` it uses your global provider, so your spans and resource come along; with endpoints it builds its own exporter, which loses the resource and your spans.
- Step spans as in TS. The retried search is one span with the event `Step attempt 0 failed`: Python counts from 0.
- Replayed steps carry no `cached` attribute (2 to 6 ms each). DBOS never runs a finished step again, so coding.sh reads a later span of a step that already succeeded as a replay.
- `DBOS.sleep` makes a `sleep` span of a few ms: the checkpoint write as the sleep begins, from the process that started it, and a 2 ms one when a recovered run enters it again. coding.sh reads the first as the start of a wait that lasts until the run next does work.
- That marker also tells a kill from a stop: the process killed during `read` was last seen after `search`, not entering a sleep, so its `read` is lost and the resume is a crash. The process stopped during the sleep was last seen entering it.
- Each process starts a new trace unless the workflow is started inside `SetWorkflowID` with `PropagateOtelContext()`; then the caller's span becomes the root of the run's first trace only.
- The `sleep_start` step and the span after `DBOS.sleep` in the how-to give a named wait (`cool-down`) covering the whole sleep, from the process that woke up.

## LangGraph

Pinned: langgraph @ `e5e37b5d` (1.2.20), langsmith-sdk @ `290f06a6`, openinference @ `6be7118f`. Sources: [pregel/_algo.py](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/langgraph/pregel/_algo.py#L655), [LangSmith OTel exporter](https://github.com/langchain-ai/langsmith-sdk/blob/290f06a628dffb2ca690e389dc48b629f5623312/python/langsmith/_internal/otel/_otel_exporter.py), [OpenInference tracer](https://github.com/Arize-ai/openinference/blob/6be7118f789c9cd3c71b3375810fe9250050fe31/python/instrumentation/openinference-instrumentation-langchain/src/openinference/instrumentation/langchain/_tracer.py#L1456).

LangGraph emits no spans itself; tracers turn its metadata into attributes. LangSmith OTel writes `langsmith.metadata.thread_id`, `langsmith.metadata.langgraph_node` and `langsmith.metadata.langgraph_step`; OpenInference writes `session.id` and a JSON `metadata` attribute. A resumed thread (after an interrupt, or days later, through a checkpointer) is a new trace with the same `thread_id`, which is the run key. History: `graph.get_state_history({"configurable": {"thread_id": …}})`.

**What the real run showed** (langgraph 1.2.20, langgraph-checkpoint-sqlite 3.1.3, openinference-instrumentation-langchain 0.1.82, langsmith 0.14.17 in OTel-only mode, OTel Python 1.45; a `RetryPolicy` on `search`, `invoke(None)` after the kill, and a `review` node that calls `interrupt()`, resumed with `Command(resume=…)` by a version-2 process):

- Each invocation is a trace whose root is the graph (named after it, `ls_integration=langgraph`, no node). Every attempt of a node has the same metadata, task id included: there is no attempt number.
- The kill loses the invocation's root and the node in flight. The next invocation's input is `null` (OpenInference `input.value`, LangSmith `{"input":null}`): coding.sh reads that as a recovery, and the step it reruns first as having lost an attempt.
- The interrupt is an exception event on the node span, typed `langgraph.errors.GraphInterrupt` (OpenInference) or `Exception` with a `GraphInterrupt(` message (LangSmith). coding.sh shows it as a wait until the invocation whose input has `resume`.
- LangSmith sets a span's status when it creates it, so a failed node can arrive OK with only an `exception` event, and its end time is the export time. coding.sh takes the failure from the event.
- LangSmith's own provider has no `service.instance.id` or version and batches for 5 s; with it, the kill lost all of the first process's spans and no resume can be found. Register your own provider first; LangSmith reuses it.

## Cloudflare Workflows

Sources: [Workers spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), [OTel export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/), [instance events](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/), [step context](https://developers.cloudflare.com/workflows/build/step-context/).

Workers tracing documents no instance id, workflow name, step name or attempt. Set them yourself: `tracing.getActiveSpan()?.setAttributes({ "workflow.run.id": instanceId, "step.name": ctx.step.name, "step.attempt": ctx.attempt })` from `cloudflare:workers`. Export is OTLP/HTTP JSON to a dashboard destination (`observability.traces.destinations`). Instance events (`attempt_started`, `attempt_errored`, `sleep_started`, `sleep_completed`, …) are the richer source.

**What the real run showed** (wrangler 4.158.0, workerd 1.20261104.1, local state kept with `--persist-to`):

- `wrangler dev` exports no traces: with a destination configured and `OTEL_EXPORTER_OTLP_ENDPOINT` set, nothing was sent. It keeps its own spans locally (SQL at `/cdn-cgi/local/explorer/api/local/observability/query`), but they don't mark a failed attempt and carry no process or version. So the Worker sent its own spans: one per step attempt with `workflow.run.id`, `workflow.name`, `step.name`, `step.id` (`<name>-<count>`, the form of the events' `stepName`) and `step.attempt` from `ctx.attempt`, and one `sleep <name>` span with `workflow.wait.name`, written by the step after the sleep, since a sleep runs no code.
- The step context (`ctx.step`, `ctx.attempt`) and `instance.subscribe()` work locally.
- The local engine does not pick an instance up by itself after a kill or a restart: it has no alarm, and sleeps and retry delays are in-memory timers. Each time, `pause()` then `resume()` restarted it, about 30 s later. That is why the run's 6 s sleep lasted 37 s, and why the lost `read` attempt shows 36 s of downtime.
- The engine counts the killed attempt: the rerun is `ctx.attempt` 2, and coding.sh shows attempt 1 as lost.

## A killed attempt

No engine exports the attempt that died with its process. coding.sh finds it from what the engine does report: a schedule with no attempt on its process (Temporal), a skipped attempt number on a new process (Inngest, Cloudflare), a recovery span (Vercel), a server attempt that ended inside a run (Restate), a recovered invocation (LangGraph), or a recovery whose old process was last seen outside a sleep (DBOS Python). It is drawn from where it started to where its process was last seen: that process's last export, or for Restate the end of the server's attempt. Only that part counts as busy time. The rest, until the next attempt, is time lost to the crash: `workflows stats` shows it on its own row and leaves it out of agent time and orchestration overhead.

## Gaps

1. Temporal: no attempt number and no timer on spans. Attempts come from the `StartActivity` → `RunActivity` structure, and the lost one is inferred from timing.
2. A killed attempt's real length is unknown everywhere but Restate; coding.sh counts only what its process was seen doing.
3. Temporal, Inngest and DBOS TS export no sleep; it shows as idle time unless the user adds a span with `workflow.wait.name` (Temporal TS through a `startTimer` interceptor; the others with a few lines in the workflow).
4. DBOS TS: a kill shows as a restart, not a crash. DBOS Python's `sleep` span lets coding.sh tell the two apart.
5. Restate: the error text of a failed attempt is only on SDK spans; the Python SDK has none, so it reads "transient failure".
6. Every capture used a recorder that forwarded each OTLP request to the collector before replying. Spans buffered in a process when it was killed are lost either way; the kill tests may have lost a little more than a real exporter would.
7. Temporal and Restate replays are never exported; the replay path was checked with Vercel's `workflow.execution.mode=replay` and DBOS's replayed steps (`cached` in TS, inferred in Python).
8. Only Temporal, Restate and DBOS were run in Python. LangGraph was run in Python only.
