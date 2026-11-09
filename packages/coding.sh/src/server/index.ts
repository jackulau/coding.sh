// `coding.sh/server`: serve's ingest routes for platforms that run a function
// per request. See docs/production/serverless.md.
//
//   import { createFetchHandler } from "coding.sh/server";
//   const handler = createFetchHandler();          // CODING_SH_STORE_URL, CODING_SH_INGEST_KEYS, … from the env
//   export { handler as GET, handler as POST };    // Vercel; Deno.serve(handler); export default { fetch: handler } on Workers
export { createFetchHandler, type FetchHandler, type FetchHandlerOptions } from "./fetch.ts";
export { resolveServeConfig, type ForwardConfig, type ServeConfig } from "./config.ts";
export type { ReadyBody } from "./serve.ts";
