// /agents.md, from src/lib/agent-docs.ts.
import type { APIRoute } from "astro";
import { agentsMd } from "../lib/agent-docs";

export const GET: APIRoute = () =>
  new Response(agentsMd(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
