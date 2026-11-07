# Serverless (Vercel Functions)

**Short version:** apps on Vercel send to coding.sh fine. The coding.sh *server* does not run as a
Function in v1. Run `coding.sh serve` as a long-running service (Fly, Railway, Render, or any
container) and point your Vercel apps at it.

## Sending from Vercel works

- **SDK in a Function.** `@coding.sh/sdk` batches in memory. A Function can freeze as soon as it
  responds, so flush before it does:

  ```ts
  import { waitUntil } from "@vercel/functions";
  import { flush, observe } from "@coding.sh/sdk";

  const openai = observe(new OpenAI());

  export async function POST(req: Request) {
    const res = await openai.chat.completions.create({ /* … */ });
    waitUntil(flush());
    return Response.json(res);
  }
  ```

- **AI SDK telemetry.** Use `experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() }`, or
  the plain OTel exporter with `OTEL_EXPORTER_OTLP_ENDPOINT` and the Bearer header. Flush the same way.
- **AI Gateway.** Point the Gateway's trace drain at `https://<your server>/v1/traces` with the ingest
  key as a Bearer header. No code in your app.
- **Edge runtime** is best-effort for the SDK.

## Why the server is not a Function

1. **Session stats need one writer.** After each batch, serve rebuilds the touched sessions' stats
   with a read-modify-write. One process guarantees one writer. Concurrent Function instances would
   overwrite each other with stale stats.
2. **OTLP mapping keeps per-process state.** The span tree and the trace-to-session map are only
   partly persisted, so spans of one trace landing on different instances would map worse.
3. **Batching and backpressure need a process that outlives a request.** Per-request Functions turn
   every exporter flush into a new database connection. That needs a pooler, and poolers in
   transaction mode break the session advisory lock that keeps one writer.

## What would change it

The ingest core (decode, map, scope, write) does not depend on the transport. A `createFetchHandler()`
adapter becomes small once the Postgres store takes a per-session `pg_advisory_xact_lock` around each
rebuild. That is planned, not shipped.

If you only have Vercel today: run serve on a small always-on container next to it. The
[Fly](fly.md) recipe is one machine with SQLite, and [Render](render.md) is one Blueprint.
