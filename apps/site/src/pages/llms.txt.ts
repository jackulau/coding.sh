// /llms.txt: the agent-facing index of this site (built in src/lib/llms.ts).
import type { APIRoute } from "astro";
import { llmsText } from "../lib/llms";

export const GET: APIRoute = () =>
  new Response(llmsText(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
