# coding-sh (Python SDK)

Send LLM calls, traces and tool spans from any Python service to a
[coding.sh](https://coding.sh) server (`coding.sh serve`). Stdlib only, Python 3.9+.

```sh
pip install coding-sh
export CODING_SH_URL=https://obs.example.com CODING_SH_INGEST_KEY=csh_ik_...
```

```python
import coding_sh
from openai import OpenAI

client = coding_sh.observe(OpenAI())   # also AsyncOpenAI, Anthropic, AsyncAnthropic
```

That's it: every `chat.completions.create`, `responses.create` and `messages.create` /
`messages.stream` call (sync, async and streaming) becomes an `llm.call` with tokens, model,
latency, time to first token, stop reason and tool calls. The server prices it.

Without `CODING_SH_URL` the SDK does nothing. It never changes return values, errors or stream
semantics, and never raises into your app.

## Traces, tools and conversations

```python
with coding_sh.trace("support-reply", session_id=conversation_id, user_id=user.id, input=question) as t:
    with coding_sh.span("tool", "lookup_order", input={"id": 42}) as s:
        s.set_output(orders.get(42))
    reply = client.chat.completions.create(model="gpt-4o-mini", messages=msgs)
    t.set_output(reply.choices[0].message.content)
```

- Each top-level `trace()` (or untraced call) is its own session. Pass `session_id` (or wrap code
  in `coding_sh.with_session(id)`) to make each trace a turn of one conversation.
- `trace` and `span` are context managers (`with` / `async with`) and decorators. A decorated
  `span("tool", ...)` records the call's arguments as input and its return value as output.
- `span("step", name)` records a generic step.
- Context follows `contextvars`, so it crosses `await` and asyncio tasks. Work handed to a thread
  pool starts untraced unless you run it with `contextvars.copy_context().run`.

## Delivery

One daemon thread sends batches (up to 500 events or 4 MiB, gzip) to `POST /v1/ingest`. It retries
429, 5xx and network errors (honoring `Retry-After`, else 1, 2, 4 ... s, at most 5 attempts) with
stable event ids, so retries never duplicate. 400/401/403 drop the batch with one warning. A full
queue drops new events and counts them. An `atexit` flush is bounded to 2 s.

```python
coding_sh.flush(timeout=5)     # e.g. at the end of a script, a job or a serverless handler
coding_sh.shutdown()           # flush, then stop
coding_sh.stats()              # {"queued", "sent", "dropped", "failed"}
```

## Config

`coding_sh.init(url=, key=, service=, capture=, flush_interval_ms=1000, max_batch=500, max_queue=10000, disabled=, debug=)`
is optional; arguments override env vars.

| Env | Meaning |
|---|---|
| `CODING_SH_URL` | Server base URL. Unset = SDK off. |
| `CODING_SH_INGEST_KEY` | `csh_ik_...` ingest key. It decides the project. |
| `CODING_SH_SERVICE` (or `OTEL_SERVICE_NAME`) | Service name; becomes the session's agent id. |
| `CODING_SH_CAPTURE_MODE` | `full` (default) or `metadata` (no message text or tool I/O). |
| `CODING_SH_DISABLED=1` | Turn the SDK off. |
| `CODING_SH_DEBUG=1` | Log transport details (never keys or bodies). |

## OpenTelemetry

Already emitting gen_ai spans? Point OTel at the server instead (no SDK needed), or let the
helper do the setup:

```python
from coding_sh.otel import configure, otel_env
configure(service="checkout-api")   # TracerProvider + OTLP/HTTP exporter + Bearer key
env = otel_env()                    # OTEL_EXPORTER_OTLP_* vars for a subprocess
```

`pip install 'coding-sh[otel]'`. `configure()` uses the standard `OTEL_EXPORTER_OTLP_*` env vars
when set, else `CODING_SH_URL` / `CODING_SH_INGEST_KEY`, and stamps `gen_ai.conversation.id` from
the current `with_session` / `trace(session_id=...)`.

## Tests

```sh
python3 -m unittest discover -s tests -t tests
```

The provider tests use fake clients and always run. Tests against the real `openai`, `anthropic`
and OpenTelemetry packages run when those are installed.
