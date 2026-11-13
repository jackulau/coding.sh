# @codingdotsh/sdk

<p align="center">
  <a href="https://www.npmjs.com/package/@codingdotsh/sdk"><img src="https://img.shields.io/npm/v/@codingdotsh/sdk?label=npm" alt="npm version"></a>
  <a href="https://github.com/jackulau/coding.sh/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml"><img src="https://github.com/jackulau/coding.sh/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
</p>

<p align="center">
  <a href="https://coding.sh">coding.sh</a> ·
  <a href="https://coding.sh/docs">Docs</a> ·
  <a href="https://github.com/jackulau/coding.sh/blob/main/docs/production/README.md">Production guide</a> ·
  <a href="https://github.com/jackulau/coding.sh/tree/main/packages/sdk">Source</a>
</p>

Records the model calls, tool calls and turns of your production LLM apps and APIs. Wrap your OpenAI or Anthropic client, point two
env vars at a `coding.sh serve` instance (backed by SQLite, or Postgres plus S3), and every call they make
shows up as a session with tokens, cost, latency and errors.

- Zero runtime dependencies, ESM with types, Node ≥ 18 (Vercel's Node runtime too; edge is best effort).
- Never changes your return values, errors or streams, and never throws into your app. The one exception is
  `weightsDelta()`, a pure helper you call on purpose: it throws on bad input.
- Without `CODING_SH_URL` it does nothing at all.

```sh
npm i @codingdotsh/sdk
export CODING_SH_URL=https://obs.example.com     # your coding.sh serve
export CODING_SH_INGEST_KEY=csh_ik_...           # not needed for a loopback serve with no keys
```

```ts
import OpenAI from "openai";
import { observe } from "@codingdotsh/sdk";

const openai = observe(new OpenAI()); // or observe(new Anthropic())
```

That is all. Each call becomes its own session. To group work, use traces:

```ts
import { observe, span, trace } from "@codingdotsh/sdk";

app.post("/chat", async (req, res) => {
  const reply = await trace(
    "POST /chat",
    async () => {
      const order = await span("tool", "lookup_order", () => db.orders.find(req.body.orderId), { input: req.body.orderId });
      const r = await openai.chat.completions.create({ model: "gpt-5-mini", messages: [/* … */] });
      return r.choices[0].message.content;
    },
    { sessionId: req.body.conversationId, userId: req.user.id, input: req.body.message },
  );
  res.json({ reply });
});
```

## API

| Call | What it does |
|---|---|
| `observe(client)` | Records OpenAI `chat.completions.create` and `responses.create`, and Anthropic `messages.create` and `messages.stream`, plain and streaming. It patches the client in place and returns it. Calling it twice is harmless. Unknown objects come back untouched. |
| `observeFetch(fetch?)` | Returns a `fetch` that records LLM calls made over raw HTTP: POSTs to paths ending in `/chat/completions`, `/responses` or `/messages`, on any host, LLM gateways included. Pass it to any client that accepts a custom `fetch`. |
| `trace(name, fn, {sessionId?, userId?, metadata?, input?})` | Runs `fn` as one turn. A top-level trace is its own session. `sessionId` groups the turns of a conversation into one session. A trace inside another trace becomes a step. Works with sync and async `fn`. |
| `span("tool" \| "step", name, fn, {input?})` | A tool call or a named step inside the current trace. |
| `withSession(id, fn)` | Every trace and untraced call inside `fn` goes to session `id`. |
| `aiSdkTracer({sessionId?})` | An OpenTelemetry `Tracer` for the Vercel AI SDK (see below). |
| `weightsEdit({tensor, shape, changed, l2, maxAbs, baseSha256, editedSha256, note?})` | Records one weight edit as a `notification` event with `payload.kind: "weights.edit"`, the same event the Python SDK's `weights_edit()` sends. Returns `true` only when the event was queued. An invalid value drops the event with one warning per process. Inside `trace()` or `span()` it joins that trace; outside it gets a session of its own. |
| `weightsCheckpoint({sha256, baseSha256?, note?})` | Records one saved weights file as a `notification` event with `payload.kind: "weights.checkpoint"`, the same event the Python SDK's `weights_checkpoint()` sends. `sha256` is the hash of the whole file, the value `coding.sh exp run --weights` takes. Returns `true` only when the event was queued. An invalid value drops the event with one warning per process. Record it inside the `trace()` that recorded the edits. |
| `weightsDelta(base, edited)` | Computes `{shape, changed, l2, maxAbs}` for two nested arrays or typed arrays of the same shape, ready to spread into `weightsEdit()`. Throws a `TypeError` or `RangeError` on bad input. |
| `init(opts?)` | Optional. The SDK reads env on first use. Options: `url`, `key`, `service`, `capture: "full" \| "metadata"`, `flushIntervalMs` (1000), `maxBatch` (500), `maxQueue` (10000), `disabled`, `debug`, `fetch`. |
| `flush(timeoutMs?)` / `shutdown(timeoutMs?)` | Send what is queued. `flush` resolves `true` when the queue is drained. `shutdown` also stops the SDK. |
| `stats()` | `{queued, sent, dropped, failed}`. |

**Env vars:**

| Var | Meaning |
|---|---|
| `CODING_SH_URL` | Base URL of the server. |
| `CODING_SH_INGEST_KEY` | Bearer key. |
| `CODING_SH_SERVICE` | Agent name shown in the viewer. Falls back to `OTEL_SERVICE_NAME`. |
| `CODING_SH_CAPTURE_MODE=metadata` | Drops prompt, response and tool text, and keeps models, tokens, timings and errors. |
| `CODING_SH_DISABLED=1` | Turns the SDK off. |
| `CODING_SH_DEBUG=1` | Logs transport problems. |

## Vercel AI SDK

```ts
import { generateText } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { aiSdkTracer, withSession } from "@codingdotsh/sdk";

// AI SDK 7
const telemetry = { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) };
await withSession(conversationId, () => generateText({ model, prompt, telemetry }));

// AI SDK 6
await generateText({
  model,
  prompt,
  experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer(), metadata: { sessionId: conversationId } },
});
```

Spans go to the server as OTLP JSON. `aiSdkTracer({ sessionId })` sets the session for everything that
tracer records. Inside `trace()`, AI SDK spans join that trace.

If you already run OpenTelemetry, you don't need the SDK. Export to `<CODING_SH_URL>/v1/traces` with
`Authorization: Bearer <key>`, and set `gen_ai.conversation.id` (or `session.id`) to group a conversation.

## LLM gateways

Point the client at a gateway and each call records which one it went through, and the request id
the gateway's lookup API takes, so `coding.sh gateway enrich` can add the billed cost and
`coding.sh sessions --flag gateway:<name>` finds the sessions. Detected: Vercel AI Gateway,
OpenRouter, LiteLLM, Cloudflare AI Gateway, Portkey, Helicone, Requesty, Ramp Router (router.com),
TrueFoundry, Kong, Bifrost and Martian, by base URL (a self-hosted gateway by its URL env var, e.g.
`LITELLM_PROXY_API_BASE`), by response header (`cf-aig-log-id`, `helicone-id`, `x-litellm-call-id`,
`x-portkey-trace-id`, …) or by response id (`gen_…`, `gen-…`, `rqsty-…`).
Headers are read from the response the client already has; the body is never read twice.
[Details](https://github.com/jackulau/coding.sh/blob/main/docs/integrations/ai-gateway.md#from-the-sdks).

```ts
const openai = observe(new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }));
```

## Streams

Streams come back unchanged. For an OpenAI chat stream without `stream_options`, the SDK asks for
`include_usage` so tokens get counted, then hides the extra usage-only chunk, so your loop sees
exactly what it would without the SDK. Usage is recorded when the stream ends, or when you stop
reading it.

## Delivery

- Events are batched (≤ 500 events and ≤ 4 MiB per request), gzipped, and sent from the background,
  one request at a time, with timers that never keep the process alive.
- On 429, 5xx and network errors the SDK retries with `Retry-After` or backoff (1, 2, 4… s, capped at
  30 s), up to 5 attempts, reusing the same event ids so the server deduplicates.
- A 400/401/403 drops the batch and warns once. A full queue drops new events and counts them.
- The SDK flushes on `beforeExit`. If you call `process.exit`, `await shutdown()` first. On
  serverless, `waitUntil(flush())` (or `await flush()`) before returning.

## Examples

- [`examples/production/node-openai`](https://github.com/jackulau/coding.sh/tree/main/examples/production/node-openai): a script (`app.mjs`) and
  an HTTP API (`api.mjs`).
- [`examples/production/ai-sdk`](https://github.com/jackulau/coding.sh/tree/main/examples/production/ai-sdk): AI SDK through plain OTel and
  through `aiSdkTracer()`.

## Development

```sh
npm test -w @codingdotsh/sdk        # node:test against a fake server and a mock LLM
npm run typecheck -w @codingdotsh/sdk
npm run build -w @codingdotsh/sdk
```
