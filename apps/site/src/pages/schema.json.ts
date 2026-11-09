// /schema.json: the coding.sh/trace JSON Schema (its $id), read at build time from the
// file packages/coding.sh/scripts/json-schema.ts generates, so it can't drift from the package.
import type { APIRoute } from "astro";
import schema from "../../../../packages/coding.sh/src/schema/trace.schema.json?raw";

export const GET: APIRoute = () =>
  new Response(schema, { headers: { "Content-Type": "application/schema+json; charset=utf-8" } });
