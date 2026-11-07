// coding.sh edge worker. Runs before the static assets (run_worker_first in
// wrangler.jsonc) and does only what static files cannot:
//   - one canonical origin: www.coding.sh and plain http 301 to https://coding.sh,
//     path and query kept;
//   - /sitemap.xml 301s to the sitemap index Astro writes;
//   - /404 itself answers with a 404 status, not 200;
//   - the assets' trailing-slash redirect (/docs/ to /docs) becomes a 301;
//   - any other host (workers.dev, preview URLs) is served but marked noindex.
// Everything else is env.ASSETS.fetch, so public/_headers still applies.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const APEX = "coding.sh";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === `www.${APEX}` || (url.hostname === APEX && url.protocol === "http:")) {
      url.protocol = "https:";
      url.hostname = APEX;
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/sitemap.xml") {
      return Response.redirect(new URL("/sitemap-index.xml", url).toString(), 301);
    }

    const response = await env.ASSETS.fetch(request);

    // html_handling answers /docs/ with a 307 to /docs. That move is permanent.
    if (response.status === 307) {
      const location = response.headers.get("Location");
      if (location && new URL(location, url).pathname === url.pathname.replace(/\/+$/, "")) {
        return Response.redirect(new URL(location, url).toString(), 301);
      }
    }

    const isNotFoundPage = /^\/404(\.html)?\/?$/.test(url.pathname) && response.status === 200;
    const offApex = url.hostname !== APEX;
    if (!isNotFoundPage && !offApex) return response;

    const headers = new Headers(response.headers);
    if (offApex) headers.set("X-Robots-Tag", "noindex");
    return new Response(response.body, {
      status: isNotFoundPage ? 404 : response.status,
      statusText: isNotFoundPage ? "Not Found" : response.statusText,
      headers,
    });
  },
};
