# coding-sh (Python SDK)

<p align="center">
  <a href="https://pypi.org/project/coding-sh/"><img src="https://img.shields.io/pypi/v/coding-sh?label=PyPI" alt="PyPI version"></a>
  <a href="https://github.com/jackulau/coding.sh/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml"><img src="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
</p>

<p align="center">
  <a href="https://coding.sh">coding.sh</a> ·
  <a href="https://coding.sh/docs">Docs</a> ·
  <a href="https://github.com/jackulau/coding.sh/blob/main/docs/production/README.md">Production guide</a> ·
  <a href="https://github.com/jackulau/coding.sh/tree/main/packages/sdk-python">Source</a>
</p>

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
semantics, and never raises into your app. The one exception is `coding_sh.weights_delta()`, a pure
helper you call on purpose: it raises `ValueError` on bad input.

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

## LLM gateways

Point the client at a gateway and each call records which one it went through, and the request id
the gateway's lookup API takes, so `coding.sh gateway enrich` can add the billed cost and
`coding.sh sessions --flag gateway:<name>` finds the sessions. Detected: Vercel AI Gateway,
OpenRouter, LiteLLM, Cloudflare AI Gateway, Portkey, Helicone, Requesty, Ramp Router (router.com),
TrueFoundry, Kong, Bifrost and Martian, by base URL (a self-hosted gateway by its URL env var, e.g.
`LITELLM_PROXY_API_BASE`), by response header (`cf-aig-log-id`, `helicone-id`, `x-litellm-call-id`,
`x-portkey-trace-id`, …) or by response id (`gen_…`, `gen-…`, `rqsty-…`).
`observe()` adds a response hook to the client's HTTP client that reads headers only, and only for
calls it records. [Details](https://github.com/jackulau/coding.sh/blob/main/docs/integrations/ai-gateway.md#from-the-sdks).

```python
client = coding_sh.observe(OpenAI(base_url="https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat"))
```

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
and OpenTelemetry packages, and the mypy typing check, run when those are installed
(`pip install '.[otel,openai,anthropic]' mypy`). With `CODING_SH_SDK_REQUIRE_ALL=1`, as in CI and
`npm run gate`, they fail instead of skipping when a package is missing.
