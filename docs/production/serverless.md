# Serverless (Vercel Functions)

**Short version:** apps on Vercel send to coding.sh fine. The ingest routes can also run as a
Function, with `createFetchHandler()` from `coding.sh/server` and a Postgres store. The viewer,
retention and `/metrics` still need `coding.sh serve` somewhere.

## Sending from Vercel works

- **SDK in a Function.** `@codingdotsh/sdk` batches in memory. A Function can freeze as soon as it
  responds, so flush before it does:

  ```ts
  import { waitUntil } from "@vercel/functions";
  import { flush, observe } from "@codingdotsh/sdk";

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

## Ingest as a Function

`createFetchHandler()` turns serve's ingest routes into one WHATWG `Request` → `Response` function:
`/v1/traces`, `/v1/logs`, `/v1/metrics` (OTLP/HTTP), `/v1/ingest` (the SDKs), `/healthz` and
`/readyz`. It runs the same code as serve: auth, body limits, validation, project scoping,
redaction, the cost estimate, the write and the session rebuild, then the answer. A 200 still means
the batch is committed.

```sh
npm install coding.sh coding.sh-store-postgres
```

```ts
// app/api/coding-sh/[...path]/route.ts
import { waitUntil } from "@vercel/functions";
import { createFetchHandler } from "coding.sh/server";

const handler = createFetchHandler({ basePath: "/api/coding-sh", waitUntil });
export { handler as GET, handler as POST, handler as OPTIONS };
```

- **Config** comes from the environment, the same as serve: `DATABASE_URL` or
  `CODING_SH_STORE_URL` (a `postgres://` URL), `CODING_SH_BLOB_URL`, `CODING_SH_INGEST_KEYS`,
  `CODING_SH_CAPTURE_MODE`, `CODING_SH_FORWARD_URL` and the rest of the
  [`[serve]` reference](../reference/config.md#serve). Pass `config` (from `resolveServeConfig`)
  or `stores: { index, blobs }` to set them in code.
- **Keys.** Every request counts as remote. With no ingest keys every ingest request gets 401 and
  `/readyz` answers 503, unless `CODING_SH_INSECURE=1`.
- **`basePath`** is the mount point stripped from the path, so senders use
  `https://app.example.com/api/coding-sh` as their endpoint.
- **`waitUntil`** keeps the forward and sink flush running after the response. On Cloudflare
  Workers (with `nodejs_compat`) the handler finds `ctx.waitUntil` on its own:
  `export default { fetch: handler }`. With Deno or Bun: `Deno.serve(handler)`, then
  `await handler.close()` on shutdown.
- The stores open on the first request. If that fails, the request gets 503 with `Retry-After: 2`
  and the next request tries again.

### Several instances, one session

After each batch the handler rebuilds the touched sessions' stats with a read-modify-write. With
several instances, two can rebuild the same session at once. `coding.sh-store-postgres` takes
`pg_advisory_xact_lock` on the session id and does the read, the build and the upsert in one
transaction, so the later rebuild waits and then sees every committed event. Concurrent writers to
one session end with the same stats as serial writes. The lock lasts one transaction, so a
transaction-mode pooler (PgBouncer, Supabase, Neon) works.

The SQLite and memory stores have no such lock. Use one instance with them, or run serve.

### Limits

- OTLP mapping keeps some per-instance state (the span tree and the trace-to-session map, partly
  persisted to the store). Spans of one trace that land on different instances can map less well
  than on one serve, for example a tool span that arrives before its parent.
- Each instance opens its own database connection. Use a pooler when many instances run at once.
- No viewer, `/api/*`, `/metrics`, proxy or retention. Run `coding.sh serve --role viewer` against
  the same database for the viewer.
- Tested on Node. Deno, Bun and Workers use the same code through `node:` built-ins but are not
  tested here.

If you only want an always-on server: the [Fly](fly.md) recipe is one machine with SQLite, and
[Render](render.md) is one Blueprint.
