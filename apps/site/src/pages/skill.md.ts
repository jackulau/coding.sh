// /skill.md, from src/lib/agent-docs.ts.
import type { APIRoute } from "astro";
import { skillMd } from "../lib/agent-docs";

export const GET: APIRoute = () =>
  new Response(skillMd(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
