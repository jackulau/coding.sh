# Trace your own agent

Record the agent you built (OpenAI Agents SDK, LangGraph, Vercel AI SDK, Claude Agent SDK, or plain
Python or TypeScript) on your machine, then turn its runs into evals and compare two versions.
Site version: [coding.sh/docs/how-to/trace-your-agent](https://coding.sh/docs/how-to/trace-your-agent).

There are two ways in:

| Your agent | Send with | Local receiver |
|---|---|---|
| Already uses OpenTelemetry, or a framework with an OTel instrumentation | its OTLP exporter | `coding.sh collector` |
| Plain TypeScript or Python | the coding.sh SDK | `coding.sh serve` |

Both write to the same local store as your coding-agent sessions, so `coding.sh sessions`, `show`,
`search`, `ui`, datasets and experiments work on them the same way.

## Option 1: OpenTelemetry into the collector

Start the receiver. It prints the environment an exporter needs and listens on `127.0.0.1:4318`:

```sh
coding.sh collector
```

Point your exporter at it. In Python:

```sh
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=support-agent
```

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

Then turn on your framework's instrumentation. The setup for the OpenAI Agents SDK, LangChain and
LangGraph, the Vercel AI SDK and the Claude Agent SDK is on
[OpenTelemetry](https://coding.sh/docs/otel). The collector reads the GenAI semantic conventions
(`gen_ai.*`), OpenInference and the AI SDK's `ai.*` attributes.

One trace becomes one session. Spans with the same `gen_ai.conversation.id` or `session.id` become
turns of one session. Model-call spans become model calls with tokens and latency; tool spans
become tool calls.

In Node, set the service name on the resource. A bare `NodeTracerProvider` ignores
`OTEL_SERVICE_NAME`, and the session is then recorded under the agent name `otel`:

```js
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "support-agent" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
provider.register();
// ... your agent ...
await provider.shutdown(); // flushes spans before a short script exits
```

To check the collector without an agent, post one OTLP JSON file to it:

```sh
curl -fsSL -o genai-semconv.json \
  https://raw.githubusercontent.com/jackulau/coding.sh/main/packages/coding.sh/test/fixtures/otel/genai-semconv.json
curl -s -X POST -H 'content-type: application/json' --data @genai-semconv.json \
  http://127.0.0.1:4318/v1/traces
coding.sh sessions
```

```text
ID                                AGENT        STARTED                   DURATION  TURNS  TOOLS         TITLE
5b8efff798038103d269b633813fc60c  weather-bot  2026-01-01T00:00:00.000Z  5.0s      1      2 (1 failed)  What's the weather in Paris?
```

## Option 2: the SDK into a local serve

The SDKs send to `coding.sh serve`, which takes both the SDK's format and OTLP on one port. On
your machine it binds to `127.0.0.1:4318` and needs no keys. Stop the collector first if it is
running; they use the same port.

```sh
coding.sh serve
```

The SDKs are in the coding.sh repository and not on npm or PyPI yet. Install them from a checkout:

```sh
git clone https://github.com/jackulau/coding.sh ~/src/coding.sh
(cd ~/src/coding.sh && npm ci && npm run build -w @coding.sh/sdk && cd packages/sdk && npm pack)
npm install ~/src/coding.sh/packages/sdk/coding.sh-sdk-0.0.1.tgz   # in your agent's folder
pip install ~/src/coding.sh/packages/sdk-python                    # Python
```

Tell the SDK where to send. Without `CODING_SH_URL` it does nothing.

```sh
export CODING_SH_URL=http://127.0.0.1:4318
export CODING_SH_SERVICE=support-agent    # the agent name in sessions
```

### TypeScript

`agent.mjs`. The two stand-in functions are where your tool and model call go. It takes a question
on the command line, or a case on stdin when `coding.sh exp run` calls it (used below).

```js
import { readFileSync } from "node:fs";
import { flush, span, trace } from "@coding.sh/sdk";

// Stand-ins for your tool and model call.
const lookupOrder = async (id) => ({ id, status: "shipped" });
const answer = async (question, order) => (order ? `Order ${order.id} is ${order.status}.` : "Let me check on that.");

// A question from the command line, or a case from `coding.sh exp run` on stdin (as JSON).
const question = process.argv[2] ?? JSON.parse(readFileSync(0, "utf8"));
const useTools = process.env.USE_TOOLS !== "0";

const reply = await trace(
  "support-reply",
  async () => {
    const id = Number(question.match(/\d+/)?.[0]);
    const order = useTools && id ? await span("tool", "lookup_order", () => lookupOrder(id), { input: { id } }) : undefined;
    return answer(question, order);
  },
  { input: question },
);
console.log(reply);
await flush();
```

```sh
node agent.mjs "Where is order 42?"
node agent.mjs "Has order 7 shipped yet?"
```

With a real model client, wrap it once and every call is recorded with model, tokens and latency:
`const openai = observe(new OpenAI())` (or `new Anthropic()`). For the Vercel AI SDK, pass
`aiSdkTracer()` as the tracer. See the [SDK reference](../reference/sdk.md).

### Python

`agent.py`:

```python
import sys
import coding_sh

# Stand-ins for your tool and model call.
def lookup_order(order_id):
    return {"id": order_id, "status": "shipped"}

def answer(question, order):
    return f"Order {order['id']} is {order['status']}."

question = sys.argv[1] if len(sys.argv) > 1 else "Where is order 42?"
with coding_sh.trace("support-reply", session_id="chat-456", input=question) as t:
    with coding_sh.span("tool", "lookup_order", input={"id": 42}) as s:
        order = lookup_order(42)
        s.set_output(order)
    reply = answer(question, order)
    t.set_output(reply)
print(reply)
coding_sh.flush(timeout=5)
```

`session_id` makes every trace with that id a turn of one conversation; leave it out and each trace
is its own session. With a real client: `client = coding_sh.observe(OpenAI())`, which also works
with `AsyncOpenAI`, `Anthropic` and `AsyncAnthropic`.

### Look at the runs

```sh
coding.sh sessions --agent support-agent
coding.sh show chat-456
coding.sh ui                                # the same sessions in the viewer
```

```text
Where is order 42?
  Session       chat-456
  Agent         support-agent
  Turns         1, 1 tool calls, 0 files changed

    +0ms  session.start
    +0ms  user        Where is order 42?
    +1ms  tool        lookup_order   ok 0ms
    +1ms  turn.end
```

## Turn the runs into an eval

Each session's first input becomes a case:

```sh
coding.sh dataset add support --session <session-id> --session <session-id>
coding.sh dataset list
```

A case made from a session has no expected answer, so grade it with a check you can state. Here the
reply must say whether the order shipped:

```sh
coding.sh exp run --dataset support --name with-tools \
  --task '{"kind":"command","command":"node","args":["agent.mjs"]}' \
  --grader '{"kind":"contains","value":["shipped"]}'
```

`exp run` sends each case's input to the command as JSON on stdin and grades what it prints. For an
agent behind HTTP, use `{"kind":"http","url":"http://127.0.0.1:3000/api/agent","responsePath":"$.output"}`.
For open-ended answers, use an LLM judge:
`{"kind":"llm","name":"helpful","rubric":"Pass if the reply answers the question."}` with
`ANTHROPIC_API_KEY` set. See [Evals](https://coding.sh/docs/evals).

## Compare two versions

Change the agent (a prompt, a model, a tool), run the same dataset again, and compare case by case.
Here the second version skips the tool:

```sh
USE_TOOLS=0 coding.sh exp run --dataset support --name no-tools \
  --task '{"kind":"command","command":"node","args":["agent.mjs"]}' \
  --grader '{"kind":"contains","value":["shipped"]}'
coding.sh exp compare with-tools no-tools
```

```text
A with-tools exp_01M6T953P384HSAZNNEY1H3PJ6  pass 100.0%
B no-tools exp_01M6T953ZKX40TWB5MFZRMJBVN  pass 0.0%

B − A   -100.0pp [-100.0pp, -100.0pp] (2 paired cases, 95% paired bootstrap)
mcnemar p=0.500  2 regressed, 0 improved
verdict B is worse
```

With two cases the result is only a smoke test; `exp compare` says so. Add cases, or `"trials": 3`
in an experiment file, before you trust a small difference. To run this on every pull request, see
[Catch a regression in CI](ci-regressions.md).

The agent keeps tracing while `exp run` calls it, so each eval run is also a session you can open
with `coding.sh show`.

## In production

Run `coding.sh serve` on a server with keys and a database, and set `CODING_SH_URL` and
`CODING_SH_INGEST_KEY` in your app. See [Self-host for a team](self-host-team.md),
[Production](https://coding.sh/docs/production) and the [REST API reference](../reference/api.md).
