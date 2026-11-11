# SDK reference

The TypeScript and Python SDKs send model calls, traces and tool spans from your app to a coding.sh server. This page is generated from the SDK source.

Site version: [coding.sh/docs/sdk](https://coding.sh/docs/sdk).

<!-- Generated from packages/sdk and packages/sdk-python by packages/coding.sh/scripts/sdk-reference.ts. Do not edit by hand. -->

Both SDKs send to a server you run with `coding.sh serve` ([production guide](https://coding.sh/docs/production), [serverless apps](https://coding.sh/docs/deploy)). Without `CODING_SH_URL` they do nothing. They never change return values, errors or stream behavior, and never throw into your app. The SDKs do not price calls; the server does.

## Environment variables

Both SDKs read the same variables. Options passed to `init()` win over them. Every other variable coding.sh reads is in the [configuration reference](https://coding.sh/docs/config).

| Variable | TypeScript | Python | Meaning |
|---|---|---|---|
| `CODING_SH_URL` | yes | yes | Base URL of your coding.sh server, e.g. `http://127.0.0.1:4318`. Unset: the SDK does nothing. |
| `CODING_SH_INGEST_KEY` | yes | yes | Ingest key (`csh_ik_...`), sent as a Bearer token. The key decides the project. Optional on a loopback server with no keys. |
| `CODING_SH_SERVICE` | yes | yes | Service name. The server turns it into the session's agent id, e.g. `support-agent`. |
| `OTEL_SERVICE_NAME` | yes | yes | Used as the service name when `CODING_SH_SERVICE` is unset. |
| `CODING_SH_CAPTURE_MODE` | yes | yes | `full` (default) or `metadata`. `metadata` drops message text and tool inputs and outputs before they leave the process. |
| `CODING_SH_DISABLED` | yes | yes | `1` (or `true`, `yes`, `on`) turns the SDK off. |
| `CODING_SH_DEBUG` | yes | yes | `1` (or `true`, `yes`, `on`) logs transport details to stderr. Keys and bodies are never logged. |

## TypeScript: `@codingdotsh/sdk`

### Install

```sh
npm install @codingdotsh/sdk
export CODING_SH_URL=http://127.0.0.1:4318   # where coding.sh serve listens
export CODING_SH_SERVICE=support-agent
```

Node `>=18`. No runtime dependencies. Add `CODING_SH_INGEST_KEY` when your server requires ingest keys.

### Minimal use

```ts
import OpenAI from "openai";
import { observe } from "@codingdotsh/sdk";

const openai = observe(new OpenAI());
const reply = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Where is my order?" }] });
```

`observe()` also takes an Anthropic client. Each model call becomes one session with its tokens, model, latency, time to first token, stop reason and tool calls. The server prices it.

### Traces, tools and conversations

```ts
import { span, trace } from "@codingdotsh/sdk";

const answer = await trace(
  "support-reply",
  async () => {
    const order = await span("tool", "lookup_order", () => orders.get(42), { input: { id: 42 } });
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `${question} Order status: ${order.status}` }],
    });
    return res.choices[0].message.content;
  },
  { sessionId: conversationId, userId: "user-17", input: question },
);
```

Each top-level `trace()` is its own session unless you pass `sessionId`, which makes each trace one turn of that conversation. A string returned from the traced function becomes the turn's output. Context follows `AsyncLocalStorage`, so it crosses `await`.

### Short-lived processes

Events are sent in the background in batches. The SDK flushes on `beforeExit`, which does not fire on `process.exit()`, and a serverless function can freeze as soon as it responds:

```ts
import { flush, shutdown } from "@codingdotsh/sdk";

await flush(); // serverless: waitUntil(flush())
await shutdown(); // before process.exit()
```

### AI SDK

```ts
import { openai } from "@ai-sdk/openai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText } from "ai";
import { aiSdkTracer } from "@codingdotsh/sdk";

const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Summarize this ticket.",
  telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) },
});
```

That is AI SDK 7. On AI SDK 6 and older, pass `experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() }` instead.

### Exports

| Name | Kind |
|---|---|
| [`init`](#initopts) | function |
| [`flush`](#flushtimeoutms) | function |
| [`shutdown`](#shutdowntimeoutms) | function |
| [`stats`](#stats) | function |
| [`InitOptions`](#initoptions) | interface |
| [`CaptureMode`](#capturemode) | type |
| [`observe`](#observeclient) | function |
| [`observeFetch`](#observefetchf) | function |
| [`trace`](#tracename-fn-opts) | function |
| [`span`](#spankind-name-fn-opts) | function |
| [`withSession`](#withsessionid-fn) | function |
| [`TraceOptions`](#traceoptions) | interface |
| [`TraceHandle`](#tracehandle) | interface |
| [`SpanOptions`](#spanoptions) | interface |
| [`aiSdkTracer`](#aisdktraceropts) | function |
| [`AiSdkTracer`](#aisdktracer) | interface |
| [`AiSdkTracerOptions`](#aisdktraceroptions) | interface |
| [`TransportStats`](#transportstats) | interface |

### `init(opts?)`

Configures the SDK. Called implicitly (from env) on first use; call it to override env.

```ts
function init(opts?: InitOptions): void
```

| Parameter | Type | Default |
|---|---|---|
| `opts` | [`InitOptions`](#initoptions) | optional |

### `flush(timeoutMs?)`

Waits until everything recorded so far is sent, or timeoutMs passes. Serverless: `waitUntil(flush())`. Resolves true when the queue drained.

```ts
function flush(timeoutMs = 5000): Promise<boolean>
```

| Parameter | Type | Default |
|---|---|---|
| `timeoutMs` | `number` | `5000` |

### `shutdown(timeoutMs?)`

Final flush, then stop sending. Apps that call process.exit should `await shutdown()` first.

```ts
function shutdown(timeoutMs = 5000): Promise<boolean>
```

| Parameter | Type | Default |
|---|---|---|
| `timeoutMs` | `number` | `5000` |

### `stats()`

Counts of events queued, sent, dropped and failed in this process. Counts from a transport replaced by a later `init()` are kept.

```ts
function stats(): TransportStats
```

### `observe(client)`

Wraps an OpenAI or Anthropic client so its model calls are recorded. Unknown objects are returned untouched; wrapping twice is a no-op.

```ts
function observe<T>(client: T): T
```

| Parameter | Type | Default |
|---|---|---|
| `client` | `T` | required |

### `observeFetch(f?)`

Returns a fetch that records LLM API calls. Pass the fetch to wrap (default: the global fetch at the time of the call to observeFetch).

```ts
function observeFetch(f?: typeof fetch): typeof fetch
```

| Parameter | Type | Default |
|---|---|---|
| `f` | `typeof fetch` | optional |

### `trace(name, fn, opts?)`

Runs fn as one traced turn. Model calls, tools and steps inside it join the trace. A trace nested inside another trace is recorded as a step span.

```ts
function trace<T>(name: string, fn: (t: TraceHandle) => T, opts: TraceOptions = {}): T
```

| Parameter | Type | Default |
|---|---|---|
| `name` | `string` | required |
| `fn` | `(t: TraceHandle) => T` | required |
| `opts` | [`TraceOptions`](#traceoptions) | `{}` |

### `span(kind, name, fn, opts?)`

Runs fn as a tool call (tool.start/tool.end) or a step (span) inside the current trace. Outside a trace it becomes its own one-span trace.

```ts
function span<T>(kind: "tool" | "step", name: string, fn: () => T, opts: SpanOptions = {}): T
```

| Parameter | Type | Default |
|---|---|---|
| `kind` | `"tool" \| "step"` | required |
| `name` | `string` | required |
| `fn` | `() => T` | required |
| `opts` | [`SpanOptions`](#spanoptions) | `{}` |

### `withSession(id, fn)`

Runs fn with every trace and untraced call inside it recorded into session `id`.

```ts
function withSession<T>(id: string, fn: () => T): T
```

| Parameter | Type | Default |
|---|---|---|
| `id` | `string` | required |
| `fn` | `() => T` | required |

### `aiSdkTracer(opts?)`

An OpenTelemetry Tracer-shaped object that sends AI SDK spans to coding.sh.

```ts
function aiSdkTracer(opts: AiSdkTracerOptions = {}): AiSdkTracer
```

| Parameter | Type | Default |
|---|---|---|
| `opts` | [`AiSdkTracerOptions`](#aisdktraceroptions) | `{}` |

### `InitOptions`

```ts
interface InitOptions {
  url?: string;
  key?: string;
  service?: string;
  capture?: CaptureMode;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  disabled?: boolean;
  debug?: boolean;
  fetch?: typeof fetch;
}
```

| Field | Type | Default | Env | Description |
|---|---|---|---|---|
| `url` | `string` |  | `CODING_SH_URL` | Base URL of the coding.sh server, e.g. https://obs.example.com. |
| `key` | `string` |  | `CODING_SH_INGEST_KEY` | Ingest key (csh_ik_…). |
| `service` | `string` |  | `CODING_SH_SERVICE`, `OTEL_SERVICE_NAME` | Service name; the server turns it into the agent id. |
| `capture` | [`CaptureMode`](#capturemode) | `"full"` | `CODING_SH_CAPTURE_MODE` | "metadata" drops message text and tool inputs/outputs before they leave the process. |
| `flushIntervalMs` | `number` | `1000` |  | How often queued events are sent, in milliseconds. |
| `maxBatch` | `number` | `500` |  | Events per request (at most 500). |
| `maxQueue` | `number` | `10000` |  | Events held in memory; newer events are dropped (and counted) when full. |
| `disabled` | `boolean` | `false` | `CODING_SH_DISABLED` | Turn the SDK off. |
| `debug` | `boolean` | `false` | `CODING_SH_DEBUG` | Log transport details to stderr (never keys or bodies). |
| `fetch` | `typeof fetch` |  |  | fetch used to talk to the server (defaults to the global fetch, never an observed one). |

### `CaptureMode`

```ts
type CaptureMode = "full" | "metadata";
```

### `TraceOptions`

```ts
interface TraceOptions {
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
}
```

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Groups the turns of one conversation into one session. Default: the trace is its own session. |
| `userId` | `string` | Your user's id, recorded on the turn's session.start event. |
| `metadata` | `Record<string, unknown>` | Any JSON object, recorded on the turn's session.start event. |
| `input` | `unknown` | The turn's input (a prompt string, or any JSON value); becomes the session's user.message. |

### `TraceHandle`

Passed to the function given to `trace()`. The ids of the trace and the session it records into.

```ts
interface TraceHandle {
  traceId: string;
  spanId: string;
  sessionId: string;
}
```

| Field | Type | Description |
|---|---|---|
| `traceId` | `string` | Id of this trace. |
| `spanId` | `string` | Id of the trace's root span. |
| `sessionId` | `string` | Session the trace records into: `sessionId` when given, else the trace id. |

### `SpanOptions`

```ts
interface SpanOptions {
  input?: unknown;
}
```

| Field | Type | Description |
|---|---|---|
| `input` | `unknown` | Tool arguments (tool spans) or step input. |

### `AiSdkTracer`

What `aiSdkTracer()` returns: the subset of the OpenTelemetry `Tracer` interface the AI SDK calls.

```ts
interface AiSdkTracer {
  startSpan(name: string, options?: SpanOptionsLike, context?: unknown): SdkSpan;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, options: SpanOptionsLike, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: SdkSpan) => unknown>(name: string, options: SpanOptionsLike, context: unknown, fn: F): ReturnType<F>;
}
```

### `AiSdkTracerOptions`

```ts
interface AiSdkTracerOptions {
  sessionId?: string;
}
```

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Session for every span this tracer makes (overrides withSession/trace). |

### `TransportStats`

What `stats()` returns.

```ts
interface TransportStats {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
}
```

| Field | Type | Description |
|---|---|---|
| `queued` | `number` | Events waiting to be sent. |
| `sent` | `number` | Events the server accepted. |
| `dropped` | `number` | Events dropped before sending: the queue was full, or the event was too large or not serializable. |
| `failed` | `number` | Events the server rejected, or that were still unsent when retries or `shutdown()` gave up. |

## Python: `coding-sh`

Import it as `coding_sh`.

### Install

```sh
pip install coding-sh
export CODING_SH_URL=http://127.0.0.1:4318   # where coding.sh serve listens
export CODING_SH_SERVICE=billing-agent
```

Python `>=3.9`. Standard library only. Extras: `coding-sh[openai]`, `coding-sh[anthropic]`, `coding-sh[otel]`. Add `CODING_SH_INGEST_KEY` when your server requires ingest keys.

### Minimal use

```python
import coding_sh
from openai import OpenAI

client = coding_sh.observe(OpenAI())
reply = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Where is my order?"}])
```

`observe()` also takes `AsyncOpenAI`, `Anthropic` and `AsyncAnthropic` clients, sync, async and streaming.

### Traces, tools and conversations

```python
with coding_sh.trace("billing-reply", session_id=conversation_id, user_id="user-17", input=question) as t:
    with coding_sh.span("tool", "lookup_invoice", input={"id": 42}) as s:
        s.set_output(invoices.get(42))
    reply = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": question}])
    t.set_output(reply.choices[0].message.content)

@coding_sh.span("tool", "refund")
def refund(invoice_id: int) -> dict:
    return invoices.refund(invoice_id)

coding_sh.flush(timeout=5)  # end of a script, a job or a serverless handler
```

`trace` and `span` work as context managers (`with` and `async with`) and as decorators. A decorated tool span records the call's arguments as input and the return value as output. Context follows `contextvars`, so it crosses `await` and asyncio tasks. Work handed to a thread pool starts untraced unless you run it with `contextvars.copy_context().run`.

### Public names

Everything in `coding_sh.__all__`:

| Name | Kind |
|---|---|
| [`coding_sh.__version__`](#coding_sh__version__) | constant |
| [`coding_sh.init`](#coding_shinit) | function |
| [`coding_sh.observe`](#coding_shobserveclient) | function |
| [`coding_sh.trace`](#coding_shtrace) | function |
| [`coding_sh.span`](#coding_shspankind-name-) | function |
| [`coding_sh.with_session`](#coding_shwith_sessionsession_id) | function |
| [`coding_sh.current_session_id`](#coding_shcurrent_session_id) | function |
| [`coding_sh.flush`](#coding_shflush) | function |
| [`coding_sh.shutdown`](#coding_shshutdown) | function |
| [`coding_sh.stats`](#coding_shstats) | function |
| [`coding_sh.weights_edit`](#coding_shweights_edittensor-shape-changed-l2-max_abs-base_sha256-edited_sha256-) | function |
| [`coding_sh.weights_delta`](#coding_shweights_deltabase-edited) | function |

### `coding_sh.__version__`

The package version, a string.

### `coding_sh.init(...)`

Configure the SDK. Optional: the first event configures it from env vars.

Env: CODING_SH_URL, CODING_SH_INGEST_KEY, CODING_SH_SERVICE (or OTEL_SERVICE_NAME), CODING_SH_CAPTURE_MODE (full|metadata), CODING_SH_DISABLED, CODING_SH_DEBUG. Without a URL the SDK does nothing.

```python
def init(
    url: Optional[str] = None,
    key: Optional[str] = None,
    service: Optional[str] = None,
    capture: Optional[str] = None,
    flush_interval_ms: Optional[float] = None,
    max_batch: Optional[int] = None,
    max_queue: Optional[int] = None,
    disabled: Optional[bool] = None,
    debug: Optional[bool] = None,
) -> None
```

| Parameter | Type | Default when unset | Env |
|---|---|---|---|
| `url` | `Optional[str]` |  | `CODING_SH_URL` |
| `key` | `Optional[str]` |  | `CODING_SH_INGEST_KEY` |
| `service` | `Optional[str]` |  | `CODING_SH_SERVICE`, `OTEL_SERVICE_NAME` |
| `capture` | `Optional[str]` | `"full"` | `CODING_SH_CAPTURE_MODE` |
| `flush_interval_ms` | `Optional[float]` | `1000` |  |
| `max_batch` | `Optional[int]` | `500` |  |
| `max_queue` | `Optional[int]` | `10000` |  |
| `disabled` | `Optional[bool]` | `False` | `CODING_SH_DISABLED` |
| `debug` | `Optional[bool]` | `False` | `CODING_SH_DEBUG` |

### `coding_sh.observe(client)`

Record every model call made through `client`. Returns the same client.

Supports openai.OpenAI / AsyncOpenAI (and Azure variants) and anthropic.Anthropic / AsyncAnthropic (and Bedrock/Vertex variants). Anything else is returned untouched.

```python
def observe(client: Any) -> Any
```

| Parameter | Type | Default |
|---|---|---|
| `client` | `Any` | required |

### `coding_sh.trace(...)`

A unit of work: `with coding_sh.trace("checkout", session_id=conv_id, input=prompt) as t:`.

user_id and metadata are recorded on the trace's session.start event.

Also a decorator (sync or async). The yielded object has set_input(), set_output(), session_id and trace_id. A decorated function's return value becomes the output, and its arguments the input (a single argument as it is, several by name) unless input= is given.

```python
def trace(
    name: str = "trace",
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    input: Any = None,
) -> _ScopeCM[_Trace]
```

| Parameter | Type | Default |
|---|---|---|
| `name` | `str` | `"trace"` |
| `session_id` | `Optional[str]` | `None` |
| `user_id` | `Optional[str]` | `None` |
| `metadata` | `Optional[Dict[str, Any]]` | `None` |
| `input` | `Any` | `None` |

### `coding_sh.span(kind, name, ...)`

A tool call (`span("tool", "lookup_order")`) or a step (`span("step", "rerank")`).

Context manager or decorator; as a decorator, the call's arguments become the input and its return value the output.

```python
def span(kind: str, name: str, input: Any = None) -> _ScopeCM[_Span]
```

| Parameter | Type | Default |
|---|---|---|
| `kind` | `str` | required |
| `name` | `str` | required |
| `input` | `Any` | `None` |

### `coding_sh.with_session(session_id)`

Group traces and untraced calls into one conversation session (context manager or decorator).

```python
def with_session(session_id: str) -> _SessionCM
```

| Parameter | Type | Default |
|---|---|---|
| `session_id` | `str` | required |

### `coding_sh.current_session_id()`

The session the next event would go to, if one is set.

```python
def current_session_id() -> Optional[str]
```

### `coding_sh.flush(...)`

Send everything queued so far. Returns True when the queue drained in time.

```python
def flush(timeout: Optional[float] = None) -> bool
```

| Parameter | Type | Default |
|---|---|---|
| `timeout` | `Optional[float]` | `None` |

### `coding_sh.shutdown(...)`

Flush, then stop accepting events.

```python
def shutdown(timeout: Optional[float] = 2.0) -> bool
```

| Parameter | Type | Default |
|---|---|---|
| `timeout` | `Optional[float]` | `2.0` |

### `coding_sh.stats()`

{queued, sent, dropped, failed} event counts for this process.

```python
def stats() -> Dict[str, int]
```

### `coding_sh.weights_edit(tensor, shape, changed, l2, max_abs, base_sha256, edited_sha256, ...)`

Record one weight edit as a `notification` event with `payload.kind` "weights.edit".

tensor: the tensor's name. shape: its dimensions. changed: how many weights differ. l2, max_abs: the L2 norm and the largest absolute value of the change (edited minus base). base_sha256, edited_sha256: 64-hex hashes of the tensor before and after. note: free text, kept only in full capture mode.

Returns True only when the event was queued. Returns False when a value is invalid, with one warning per process. Returns False without a warning when the SDK is off or shut down or the queue is full. Never raises.

A note that is not a string is dropped with one warning; the edit is still recorded. Outside trace() and with_session() the edit gets a session of its own, so group a run of edits inside one.

```python
def weights_edit(
    tensor: str,
    shape: Sequence[int],
    changed: int,
    l2: float,
    max_abs: float,
    base_sha256: str,
    edited_sha256: str,
    note: Optional[str] = None,
) -> bool
```

| Parameter | Type | Default |
|---|---|---|
| `tensor` | `str` | required |
| `shape` | `Sequence[int]` | required |
| `changed` | `int` | required |
| `l2` | `float` | required |
| `max_abs` | `float` | required |
| `base_sha256` | `str` | required |
| `edited_sha256` | `str` | required |
| `note` | `Optional[str]` | `None` |

### `coding_sh.weights_delta(base, edited)`

{shape, changed, l2, max_abs} for two array-likes of the same shape, in pure Python.

Takes nested lists, tuples, ranges, or anything with `.tolist()` (numpy, torch), up to 16 levels deep, holding finite numbers. Generators are not accepted. It is slow on large tensors: compute big ones with your own library and pass the numbers to weights_edit().

A pure helper you call on purpose, unlike the never-raise weights_edit(): it raises ValueError on bad input (a shape mismatch, ragged or too deep nesting, a non-number, None, NaN or inf, or an argument that is not a sequence or array).

```python
def weights_delta(base: Sequence[Any], edited: Sequence[Any]) -> Dict[str, Any]
```

| Parameter | Type | Default |
|---|---|---|
| `base` | `Sequence[Any]` | required |
| `edited` | `Sequence[Any]` | required |

### `coding_sh.otel`

For apps that already emit OpenTelemetry gen_ai spans. Needs `pip install coding-sh[otel]`. `configure()` picks the endpoint from its `url` argument, then `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, then `CODING_SH_URL` with `CODING_SH_INGEST_KEY`. See [OpenTelemetry](https://coding.sh/docs/otel).

| Name | Kind |
|---|---|
| [`coding_sh.otel.configure`](#coding_shotelconfigure) | function |
| [`coding_sh.otel.otel_env`](#coding_shotelotel_env) | function |
| [`coding_sh.otel.ConversationSpanProcessor`](#coding_shotelconversationspanprocessor) | class |
| [`coding_sh.otel.CONVERSATION_ATTR`](#coding_shotelconversation_attr) | constant |

### `coding_sh.otel.configure(...)`

Build (and by default install) a TracerProvider that exports to coding.sh.

Returns the provider, or None when OpenTelemetry is not installed or no endpoint is known. Call provider.shutdown() (or rely on the SDK's atexit hook) to flush on exit.

```python
def configure(
    service: Optional[str] = None,
    url: Optional[str] = None,
    key: Optional[str] = None,
    set_global: bool = True,
    batch: bool = True,
) -> Any
```

| Parameter | Type | Default |
|---|---|---|
| `service` | `Optional[str]` | `None` |
| `url` | `Optional[str]` | `None` |
| `key` | `Optional[str]` | `None` |
| `set_global` | `bool` | `True` |
| `batch` | `bool` | `True` |

### `coding_sh.otel.otel_env(...)`

OTEL_* exporter env vars that point any OTel SDK at a coding.sh server.

Defaults come from CODING_SH_URL, CODING_SH_INGEST_KEY and CODING_SH_SERVICE. The result holds the ingest key: pass it to a child process, never log it.

```python
def otel_env(
    url: Optional[str] = None,
    key: Optional[str] = None,
    service: Optional[str] = None,
) -> Dict[str, str]
```

| Parameter | Type | Default |
|---|---|---|
| `url` | `Optional[str]` | `None` |
| `key` | `Optional[str]` | `None` |
| `service` | `Optional[str]` | `None` |

### `coding_sh.otel.ConversationSpanProcessor`

Sets gen_ai.conversation.id from the current coding.sh session on every new span.

```python
class ConversationSpanProcessor:
    def on_start(self, span: Any, parent_context: Any = None) -> None: ...
    def on_end(self, span: Any) -> None: ...
    def shutdown(self) -> None: ...
    def force_flush(self, timeout_millis: int = 30000) -> bool: ...
```

### `coding_sh.otel.CONVERSATION_ATTR`

A constant: `"gen_ai.conversation.id"`.

## Differences between the SDKs

- `flush()` waits at most `5000` ms by default in TypeScript. In Python, `flush()` with `timeout=None` waits until the queue is sent or the sender gives up on it.
- `shutdown()` waits at most `5000` ms in TypeScript and `2.0` s in Python. Without a call, Python flushes at exit for at most `2.0` s, and TypeScript flushes on `beforeExit` for at most `5000` ms.
- TypeScript times are in milliseconds (`timeoutMs`, `flushIntervalMs`). Python timeouts are in seconds; only `flush_interval_ms` is in milliseconds.
- In TypeScript, `trace()`, `span()` and `withSession()` take the function to run. In Python, they are context managers and decorators.
- `aiSdkTracer()` and `observeFetch()` are TypeScript only. `coding_sh.otel` is Python only.
