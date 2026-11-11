# Trace your agent with the SDK

Wrap your OpenAI or Anthropic client, mark tool calls and conversations, and see each run in the
viewer. TypeScript and Python.
Site version: [coding.sh/docs/how-to/trace-your-agent](https://coding.sh/docs/how-to/trace-your-agent).

The SDK sends each run of your agent to `coding.sh serve` on your machine. A run is a session: the
prompt, every model call with its tokens, latency and cost, every tool call, and the answer. The
example here is an agent that picks labels for coding.sh's own GitHub issues.

## Record your first run

Install coding.sh and the SDK, and start the local server:

```sh tab=TypeScript title=shell
npm install -g coding.sh
npm install @codingdotsh/sdk openai
```

```sh tab=Python title=shell
npm install -g coding.sh
pip install coding-sh openai
```

```sh
coding.sh serve
```

It logs two JSON lines (`store opened`, then `listening`), prints `http://127.0.0.1:4318` and keeps
running. It takes traces from the SDK and from
OpenTelemetry, keeps them in `~/.coding.sh`, and serves the viewer on the same address. In another
terminal, tell the SDK where to send:

```sh
export CODING_SH_URL=http://127.0.0.1:4318
export CODING_SH_SERVICE=coding-sh-triage    # the agent name in the session list
```

Without `CODING_SH_URL` the SDK does nothing, so the same code is safe to ship. Wrap the client
once. Every call through it is recorded:

```js tab=TypeScript title=triage.mjs
import OpenAI from "openai";
import { observe } from "@codingdotsh/sdk";

const openai = observe(new OpenAI()); // records every call: prompt, answer, tokens, latency, cost

const issue = process.argv[2] ?? "Viewer search misses tool output";
const res = await openai.chat.completions.create({
  model: "gpt-5-mini",
  messages: [
    { role: "system", content: "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only." },
    { role: "user", content: issue },
  ],
});
console.log(res.choices[0].message.content);
```

```python tab=Python title=triage.py
import sys
import coding_sh
from openai import OpenAI

client = coding_sh.observe(OpenAI())  # records every call: prompt, answer, tokens, latency, cost

issue = sys.argv[1] if len(sys.argv) > 1 else "Viewer search misses tool output"
res = client.chat.completions.create(
    model="gpt-5-mini",
    messages=[
        {"role": "system", "content": "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only."},
        {"role": "user", "content": issue},
    ],
)
print(res.choices[0].message.content)
coding_sh.flush()  # send before the script exits
```

`observe()` also takes an Anthropic client: see [Use Anthropic](#use-anthropic). In Python it takes
`AsyncOpenAI` and `AsyncAnthropic` too. Run the agent, then list the sessions:

```sh tab=TypeScript title=shell
node triage.mjs "Viewer search misses tool output"
coding.sh sessions
```

```sh tab=Python title=shell
python triage.py "Viewer search misses tool output"
coding.sh sessions
```

```text
bug, viewer
ID                                AGENT             STARTED  DURATION  TURNS  TOOLS  TITLE
2fe7283ac26adbe28d51840412f44206  coding-sh-triage  3s ago   2.1s      1      0      Viewer search misses tool output
```

Open `http://127.0.0.1:4318` and click the row to see the run step by step.

![The coding.sh viewer showing one coding-sh-triage run titled "Viewer search misses tool output": the gpt-5-mini call from OpenAI selected, with 34 input and 195 output tokens, its duration and cost, and the answer "bug, viewer".](shot:docs/sdk-session "One run in the viewer.")

`coding.sh show <id>` prints the same run in the terminal:

```text
Viewer search misses tool output
  Session       2fe7283ac26adbe28d51840412f44206
  Agent         coding-sh-triage  gpt-5-mini
  Repo          -
  Started       Nov 11 08:52 (4s ago)
  Duration      2.1s
  Turns         1, 0 tool calls, 0 files changed
  Tokens        in 34  out 195  cache -  $0.0004 (estimated)
  Latency       1 llm calls, p50 2.1s, p95 2.1s

    +0ms  session.start
    +0ms  user        Viewer search misses tool output
    +0ms  llm         gpt-5-mini 2.1s in 34 out 195 $0.0004 est
   +2.1s  assistant   bug, viewer
   +2.1s  turn.end
   +2.1s  session.end completed
```

## Use Anthropic

Wrap `new Anthropic()` the same way. The call takes `system` and `max_tokens` as their own fields,
and the answer is in `content[0].text`:

```sh tab=TypeScript title=shell
npm install @codingdotsh/sdk @anthropic-ai/sdk
```

```sh tab=Python title=shell
pip install coding-sh anthropic
```

```js tab=TypeScript title=triage.mjs
import Anthropic from "@anthropic-ai/sdk";
import { observe } from "@codingdotsh/sdk";

// observe() records each call: the messages, the answer, tokens, latency and cost.
const anthropic = observe(new Anthropic());

const issue = process.argv[2] ?? "Viewer search misses tool output";
const res = await anthropic.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  system: "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.",
  messages: [{ role: "user", content: issue }],
});
console.log(res.content[0].text);
```

```python tab=Python title=triage.py
import sys

import coding_sh
from anthropic import Anthropic

# observe() records each call: the messages, the answer, tokens, latency and cost.
client = coding_sh.observe(Anthropic())

issue = sys.argv[1] if len(sys.argv) > 1 else "Viewer search misses tool output"
res = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1024,
    system="Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.",
    messages=[{"role": "user", "content": issue}],
)
print(res.content[0].text)
coding_sh.flush()  # send before the script exits
```

With `ANTHROPIC_API_KEY` set, `node triage.mjs` prints `bug, viewer`, and `coding.sh show latest`
prints:

```text
Viewer search misses tool output
  Session       9089cc9c3411d2bfff80f5ba2dac60de
  Agent         coding-sh-triage  claude-sonnet-5-5
  Repo          -
  Started       Nov 11 08:52 (2s ago)
  Duration      1.2s
  Turns         1, 0 tool calls, 0 files changed
  Tokens        in 32  out 5  cache -  $0.0001 (estimated)
  Latency       1 llm calls, p50 1.2s, p95 1.2s

    +0ms  session.start
    +0ms  user        Viewer search misses tool output
    +0ms  llm         claude-sonnet-5-5 1.2s in 32 out 5 $0.0001 est
   +1.2s  assistant   bug, viewer
   +1.2s  turn.end
   +1.2s  session.end completed
```

## Record tool calls

Put the agent's turn in `trace()` and each tool run in `span("tool", name, ...)`. The model calls
inside join the same session, in order:

```js tab=TypeScript title=agent.mjs
import OpenAI from "openai";
import { observe, span, trace } from "@codingdotsh/sdk";

const openai = observe(new OpenAI());
const tools = [{ type: "function", function: { name: "list_labels", description: "The repo's labels", parameters: { type: "object", properties: {} } } }];
const listLabels = async () => ["bug", "cli", "docs", "sdk", "viewer"]; // your real tool goes here

const issue = process.argv[2] ?? "Viewer search misses tool output";
const labels = await trace("triage", async () => {
  const messages = [
    { role: "system", content: "Pick labels for this GitHub issue. Call list_labels first. Answer with the labels only." },
    { role: "user", content: issue },
  ];
  for (;;) {
    const { choices } = await openai.chat.completions.create({ model: "gpt-5-mini", messages, tools });
    const msg = choices[0].message;
    if (!msg.tool_calls) return msg.content; // the answer ends the turn
    messages.push(msg);
    for (const call of msg.tool_calls) {
      const out = await span("tool", call.function.name, listLabels); // one tool call in the session
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
    }
  }
}, { input: issue });
console.log(labels);
```

```python tab=Python title=agent.py
import json
import sys
import coding_sh
from openai import OpenAI

client = coding_sh.observe(OpenAI())
tools = [{"type": "function", "function": {"name": "list_labels", "description": "The repo's labels", "parameters": {"type": "object", "properties": {}}}}]

def list_labels():  # your real tool goes here
    return ["bug", "cli", "docs", "sdk", "viewer"]

issue = sys.argv[1] if len(sys.argv) > 1 else "Viewer search misses tool output"
with coding_sh.trace("triage", input=issue) as t:
    messages = [
        {"role": "system", "content": "Pick labels for this GitHub issue. Call list_labels first. Answer with the labels only."},
        {"role": "user", "content": issue},
    ]
    while True:
        msg = client.chat.completions.create(model="gpt-5-mini", messages=messages, tools=tools).choices[0].message
        if not msg.tool_calls:
            break  # the answer ends the turn
        messages.append(msg)
        for call in msg.tool_calls:
            with coding_sh.span("tool", call.function.name) as s:  # one tool call in the session
                out = list_labels()
                s.set_output(out)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(out)})
    t.set_output(msg.content)
print(msg.content)
coding_sh.flush()
```

`coding.sh show latest`:

```text
Viewer search misses tool output
  Session       cb5c85ec9f30cff3d8f6c85fd548b978
  Agent         coding-sh-triage  gpt-5-mini
  Repo          -
  Started       Nov 11 08:52 (4s ago)
  Duration      4.0s
  Turns         1, 1 tool calls, 0 files changed
  Tokens        in 201  out 370  cache -  $0.0008 (estimated)
  Latency       2 llm calls, p50 1.9s, p95 2.1s; tools 0ms (p95 0ms)

    +0ms  session.start
    +0ms  user        Viewer search misses tool output
    +2ms  llm         gpt-5-mini 2.1s in 94 out 184 $0.0004 est
   +2.1s  tool        list_labels   ok 0ms
   +2.1s  llm         gpt-5-mini 1.9s in 107 out 186 $0.0004 est
   +4.0s  assistant   bug, viewer
   +4.0s  turn.end
   +4.0s  session.end completed
```

A failed tool, one that throws, is marked failed with its error, and the error still reaches your
code. Use `span("step", name, ...)` for a step that is not a tool, such as a rerank.

## Record a conversation

Each `trace()` is its own session. Give the traces of one conversation the same session id, and
each becomes a turn of one session:

```js tab=TypeScript title=chat.mjs
import OpenAI from "openai";
import { observe, trace } from "@codingdotsh/sdk";

const openai = observe(new OpenAI());
const messages = [{ role: "system", content: "You help triage coding.sh issues. Be brief." }];

for (const question of ["Viewer search misses tool output", "Which labels fit?"]) {
  // Every trace with the same sessionId is one turn of one session.
  await trace("chat", async () => {
    messages.push({ role: "user", content: question });
    const { choices } = await openai.chat.completions.create({ model: "gpt-5-mini", messages });
    messages.push(choices[0].message);
    return choices[0].message.content;
  }, { sessionId: "issue-640", input: question });
}
```

```python tab=Python title=chat.py
import coding_sh
from openai import OpenAI

client = coding_sh.observe(OpenAI())
messages = [{"role": "system", "content": "You help triage coding.sh issues. Be brief."}]

for question in ["Viewer search misses tool output", "Which labels fit?"]:
    # Every trace with the same session_id is one turn of one session.
    with coding_sh.trace("chat", session_id="issue-640", input=question) as t:
        messages.append({"role": "user", "content": question})
        res = client.chat.completions.create(model="gpt-5-mini", messages=messages)
        answer = res.choices[0].message.content
        messages.append({"role": "assistant", "content": answer})
        t.set_output(answer)

coding_sh.flush()
```

`coding.sh show issue-640`:

```text
Viewer search misses tool output
  Session       issue-640
  Agent         coding-sh-triage  gpt-5-mini
  Repo          -
  Started       Nov 11 08:52 (4s ago)
  Duration      3.2s
  Turns         2, 0 tool calls, 0 files changed
  Tokens        in 83  out 304  cache -  $0.0006 (estimated)
  Latency       2 llm calls, p50 1.4s, p95 1.7s
  Phases        2 (1 resume)

    +0ms  session.start
    +0ms  user        Viewer search misses tool output
   +40ms  llm         gpt-5-mini 1.7s in 32 out 165 $0.0003 est
   +1.8s  assistant   A viewer bug: search skips the output of tool calls.
   +1.8s  turn.end
   +1.8s  session.start
   +1.8s  user        Which labels fit?
   +1.8s  llm         gpt-5-mini 1.4s in 51 out 139 $0.0003 est
   +3.2s  assistant   bug, viewer
   +3.2s  turn.end
```

In a web app, use your conversation or chat id. `withSession(id, fn)` in TypeScript and
`coding_sh.with_session(id)` in Python do the same for code you don't wrap in `trace()`.

## Trace the Vercel AI SDK

`aiSdkTracer()` turns the AI SDK's telemetry into a session. It needs no OpenTelemetry packages.

```sh
npm install @codingdotsh/sdk ai @ai-sdk/openai @ai-sdk/otel
```

```js title=ai-sdk.mjs
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { aiSdkTracer, flush } from "@codingdotsh/sdk";

const issue = process.argv[2] ?? "Viewer search misses tool output";
const { text } = await generateText({
  model: openai("gpt-5-mini"),
  system: "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.",
  prompt: issue,
  telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) }, // sends the AI SDK's spans to coding.sh
});
console.log(text);
await flush();
```

With `coding.sh serve` or `coding.sh collector` running, set the address in the terminal where you
run the script. Without `CODING_SH_URL` nothing is recorded, and no error is printed.

```sh
export CODING_SH_URL=http://127.0.0.1:4318
export CODING_SH_SERVICE=coding-sh-triage    # the agent name in the output below
node ai-sdk.mjs "Add a --json flag to coding.sh usage"
coding.sh show latest
```

```text
enhancement, cli
Add a --json flag to coding.sh usage
  Session       96da5cf3d55982ad3a64d454a97e80fb
  Agent         coding-sh-triage  gpt-5-mini
  Repo          -
  Started       Nov 11 08:52 (3s ago)
  Duration      1.9s
  Turns         1, 0 tool calls, 0 files changed
  Tokens        in 56  out 184  cache -  $0.0004 (estimated)
  Latency       1 llm calls, p50 1.9s, p95 1.9s

    +0ms  session.start
    +0ms  user        Add a --json flag to coding.sh usage
   +12ms  span        step 1
   +13ms  llm         gpt-5-mini 1.9s in 56 out 184 $0.0004 est
   +1.9s  assistant   enhancement, cli
   +1.9s  turn.end
   +1.9s  session.end completed
```

This is AI SDK 7. On AI SDK 6 and earlier, pass the tracer per call instead:
`experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() }`.

Inside a `trace()` or `withSession()`, the AI SDK's calls join that session. `aiSdkTracer({
sessionId })` sets one for every call.

## Already on OpenTelemetry?

If your agent already exports OpenTelemetry, or runs on the OpenAI Agents SDK, LangGraph or the
Claude Agent SDK, send its traces to coding.sh instead. See
[Trace a framework with OpenTelemetry](https://coding.sh/docs/otel).

:::more coding.sh serve or coding.sh collector?
Both take OpenTelemetry traces on `127.0.0.1:4318` and write to the same local store, so run one at
a time. A second one on the same port stops with "port 4318 is in use"; `--port 0` picks a free
port.

| | `coding.sh serve` | `coding.sh collector` |
|---|---|---|
| Takes | the SDK and OTLP | OTLP |
| Viewer | on the same address | run `coding.sh ui` (port 4319) |
| Ingest keys and Postgres | yes | no |

Use `serve` for the SDK. The collector prints the `OTEL_*` exports an exporter needs, which is
handy for frameworks.
:::

## Turn runs into evals

Each session can become an eval case, and two versions of your agent can be compared on the same
cases. See [Evals](https://coding.sh/docs/evals).

## Next steps

- [Evals](https://coding.sh/docs/evals): score your agent on a set of cases.
- [Trace a framework with OpenTelemetry](https://coding.sh/docs/otel): the OpenAI Agents SDK,
  LangGraph and the Claude Agent SDK.
- [Trace an app in production](https://coding.sh/docs/production): `serve` with keys and a database.
- [SDK reference](../reference/sdk.md): every export and option.
