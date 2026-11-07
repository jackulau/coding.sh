// The installer, served as plain text for `curl -fsSL https://coding.sh/install | sh`.
// Read from the repository's install.sh at build time, so the site can never
// serve a stale copy.
import type { APIRoute } from "astro";
import script from "../../../../install.sh?raw";

export const GET: APIRoute = () =>
  new Response(script, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
