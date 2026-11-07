# eve

[eve](https://github.com/vercel/eve) is Vercel's filesystem-first framework for durable agents. coding.sh reads eve agents in three ways and evaluates them with a fourth:

| Path | Source | Code |
| --- | --- | --- |
| Live | eve's OpenTelemetry spans, exported to the coding.sh OTLP receiver | `enrichFromEve` (`src/integrations/eve/map.ts`) |
| Import | eve's local trace store `.eve/traces/v1/`, or `eve traces show --json` output | `importEveRuns` (`import.ts`) |
| Stream | an eve session's NDJSON stream (`/eve/v1/session/:id/stream`) | `mapEveStream` (`stream.ts`) |
| Evals | runs dataset cases against a local agent over HTTP | `eveTask` (`task.ts`) |

Everything here was verified against real `eve dev` output from eve 1.0.0-rc.6 (trace schema v4, stream v27). The test fixtures in `test/integrations/eve/fixtures/` are that output, trimmed and with paths scrubbed. They were produced by `examples/eve-agent` running eve's deterministic mock model. Nothing calls Vercel, and the tests make no network requests beyond localhost.

## What eve emits

eve's tracer (scope `eve.agent`) writes GenAI-convention spans. One root turn is one trace:

```
invoke_agent <agent>         turn: agent.run.type=session|subagent, agent.turn.id/sequence,
                             agent.channel.delivery.input, gen_ai.usage.* (turn total)
  agent.step                 one model step: agent.step.index, agent.usage.*
    chat <model>             provider call: gen_ai.usage.*, finish_reasons, input/output messages
    execute_tool <name>      tool/skill/subagent call: agent.action.kind
                             (tool-call | subagent-call | remote-agent-call), outcome, error.type
      invoke_agent <sub>     a local subagent's first turn joins the caller's trace here
      agent.approval         human-in-the-loop wait
```

Every eve span has these attributes:

| Attribute | Meaning |
| --- | --- |
| `agent.run.id` | The eve session (`wrun_…`). This is the id `POST /eve/v1/session` returns. |
| `gen_ai.conversation.id` | The root session's run id, shared by its children. |
| `agent.trace.schema.version` | Trace schema version: `4` in the version tested. |

Child turns also carry:
- `agent.parent_run.id`
- `agent.parent_call.id` (the caller's `gen_ai.tool.call.id`)
- `agent.subagent.name`

Later turns of a session start new traces.

eve's Workflow runtime also exports infrastructure spans under the `workflow` scope (`workflow.run`, `workflow.stream.read`, `workflow.route.*`, …), many per turn. They carry no agent attributes.

## Mapping

| eve | coding.sh |
| --- | --- |
| `agent.run.id` | `sessionId`. Every eve session is a coding.sh session. |
| `invoke_agent` with turn sequence 0 | `session.start`: `{agentName, runType, channel, conversationId, traceId}` |
| `invoke_agent` (subagent) | `session.start` also gets `{parentSessionId, parentEventId, subagentId, subagentType}`. Ingest sets `Session.parent` from these. |
| `invoke_agent` | `user.message` (the delivery's input, not the whole history), then `turn.end` with `{ok, outcome, output, durationMs, reportedUsage}` |
| `chat <model>` | `llm.call` with `durationMs`, `usage`, `model`, `{provider, stopReason}` |
| `execute_tool <tool>` | `tool.start`/`tool.end` with `durationMs`, `ok`, `errorType`, plus `framework: true` for eve's built-ins (`eve__task_wait`, …) |
| `execute_tool` for subagent-call / remote-agent-call | `tool.start`/`tool.end`, plus `subagent.start` `{subagentId, type, prompt}` and `subagent.end` `{ok, result, reportedUsage}`. `subagentId` is the call id. |
| `agent.step` | `notification` `{type: "eve.step", stepIndex, attempt, model, reportedUsage}` |
| `agent.approval` | `notification` `{type: "eve.approval", kind, outcome, requestId}` |
| exception span events | `error` |
| `workflow` scope spans | dropped (opt in with `keepWorkflowSpans`) |

Usage is counted only on `llm.call`. Turn, step and subagent totals stay in `payload.reportedUsage`, so nothing is counted twice. eve's turn total covers the turn's own model calls; a subagent's tokens belong to the child session.

A turn never emits `session.end`, because an eve session stays open for the next message.

Event ids are deterministic. Each is `spanEventId(traceId, spanId, slot)`, plus slots 20 and 21 for the extra subagent events. So a re-posted span, or an import after live collection, adds nothing.

One timing caveat. On the span path, `subagent.end` is the end of the `execute_tool` dispatch. eve runs subagents as tasks, so that span ends when the task starts, not when the child replies. The child's own `turn.end` has its real duration. On the stream path, the call settles when the child replies, so there `subagent.end` covers the child's whole run and includes `childSessionId`.

## Live: the OTLP receiver hook

`src/otel/map.ts` exposes `MapContext.enrichSpan`. `startReceiver` uses `enrichFromEve` as its default enricher, so `coding.sh collector` maps eve spans with no extra setup. Pass another `SpanEnricher` to replace it, or `enrichSpan: false` for the plain mapping:

```ts
import { startReceiver } from "coding.sh/src/otel/receiver.ts";
import { enrichFromEve } from "coding.sh/src/integrations/eve/index.ts";

await startReceiver({ store, blobs }); // enrichFromEve is the default
await startReceiver({ store, blobs, enrichSpan: (span, events, info) => enrichFromEve(span, events, info, { keepWorkflowSpans: true }) });
await startReceiver({ store, blobs, enrichSpan: false }); // generic mapping only
```

How the hook treats spans:
- It is pure and synchronous.
- Spans from other frameworks pass through unchanged, so it can stay on for every agent.
- It recognizes eve spans by the `eve.agent` scope, by `agent.framework.name = "eve"`, or by schema version plus run id.

Configure the agent to export to the receiver with `agent/instrumentation/*.ts`:

```ts
import { OTLPHttpJsonTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new OTLPHttpJsonTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }),
});
```

`examples/eve-agent/scripts/collector.ts` is a working collector with this hook.

## Import

```ts
for await (const event of importEveRuns("path/to/eve-app")) …            // .eve/traces/v1
for await (const event of importEveRuns("traces.json")) …                // `eve traces show <id> --json`, OTLP/JSON, or JSONL
```

The importer is read-only. Each span file is passed through the same OTLP mapper and `enrichFromEve`.

Options:

| Option | Effect |
| --- | --- |
| `blob` | Store content. Without it, large values are hashed and dropped. |
| `maxInlineBytes` | Size limit for values kept inline. |
| `since` | Only import traces that started after this time. |
| `keepWorkflowSpans` | Keep the Workflow infrastructure spans. |
| `onError` | Called for unreadable files. |

Vercel Agent Runs (`vercel agent-runs trace <runId> --json`, or the Vercel MCP) is not read. Its JSON schema is a Vercel API response we could not verify without user credentials, and fetching it would use them. If a deployed agent exports OTLP to a reachable collector, the live path covers it. Otherwise, run `eve traces show --json` where the traces are and import that file.

## Stream

`mapEveStream(ndjson, { sessionId })` and the incremental `EveStreamMapper` map a session stream's facts:

| Stream fact | coding.sh event |
| --- | --- |
| `delivery.consumed` | `user.message` |
| `model.started`/`settled` + `usage.recorded` | `llm.call` |
| `call.requested`/`settled` | `tool.start`/`end`, plus `subagent.*` with `childSessionId` from `child.opened` |
| `content.completed` | `assistant.message` (with `phase`: reply or narration) |
| `turn.settled` | `turn.end` |
| `session.started`/`ended` | `session.start`/`end` |

Ids are keyed on eve's stream positions (line, index), so heartbeats and reconnects don't change them.

The stream path and the span path describe the same work with different ids, so ingest one per session. Use OTel for capture and the stream for eval traces.

## Evals

`eveTask({ url = "http://127.0.0.1:2000", headers?, timeoutMs?, endSession? })` is a coding.sh `FunctionTask`.

For each case it:
1. Creates a session.
2. Sends each message, as follow-ups after the first.
3. Reads the stream until each delivery settles, reconnecting from its cursor when a lease ends.
4. Returns `withTrace({reply, replies, sessionId, outcome, toolCalls, subagents}, events)`.

Graders therefore get the mapped events as `ctx.trace`. A delivery that settles `awaiting-input` (an approval or question) fails the case with a clear error.

Case input is `"text"`, `{message}` or `{messages: [...]}`.

```ts
await runExperiment({ name: "eve", dataset, graders, task: eveTask({ url: "http://127.0.0.1:2000" }) });
```

For harnesses that run commands, `examples/eve-agent/scripts/ask.mjs` is a stdin-JSON to stdout-JSON command task built on `eve/client`.

### eve evals vs. coding.sh experiments

eve's own evals are `evals/*.eval.ts` files using `defineEval`, run with `eve eval`. They boot a local server, drive it with eve's client, and assert on typed session events: `t.calledTool`, `t.calledAgent`, `t.check`, `t.judge`. They report to the console, to `.eve/evals/`, and to Braintrust or JUnit. They are the right tool for regression gates inside an eve app.

coding.sh experiments run the same kind of cases against a running agent and add what eve leaves out:
- Pass rates with confidence intervals across trials.
- Stored, comparable results across prompt, model and harness versions, with paired comparisons.
- Calibrated LLM judges.
- Datasets built from captured sessions.
- One dataset run across eve and non-eve agents.

The two are complementary. `examples/eve-agent` ships both over the same cases.

## Example

`examples/eve-agent` is a weather agent with one tool and a forecaster subagent. It uses the mock model by default, so it needs no key and no deploy. Its README shows how to:
- run it against the collector
- import its traces
- run both kinds of evals
