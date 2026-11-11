// coding.sh edge worker. Runs before the static assets (run_worker_first in
// wrangler.jsonc) and does only what static files cannot:
//   - one canonical origin: www.coding.sh and plain http 301 to https://coding.sh,
//     path and query kept;
//   - /sitemap.xml 301s to the sitemap index Astro writes;
//   - a page that moved 301s to its new path (moved.ts), and so does its Markdown copy;
//   - /404 itself answers with a 404 status, not 200;
//   - the assets' trailing-slash redirect (/docs/ to /docs) becomes a 301;
//   - a changelog page number that no longer exists 301s to the release;
//   - any other host (workers.dev, preview URLs) is served but marked noindex.
// Everything else is env.ASSETS.fetch, so public/_headers still applies.

import { MOVED } from "./moved.ts";

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

    // A moved page, with or without a trailing slash, and its Markdown copy (<page>.md).
    const [, page, md = ""] = /^(.*?)\/?(\.md)?$/.exec(url.pathname) ?? [];
    const moved = page ? MOVED[page] : undefined;
    if (moved) {
      url.pathname = moved + md;
      return Response.redirect(url.toString(), 301);
    }

    const response = await env.ASSETS.fetch(request);

    // html_handling answers /docs/ with a 307 to /docs, /docs/quickstart.html
    // to /docs/quickstart and /index.html to /. Every one of those moves is
    // permanent, so a GET or HEAD gets a 301. Other methods keep the 307, which
    // keeps the method.
    if (response.status === 307 && (request.method === "GET" || request.method === "HEAD")) {
      const location = response.headers.get("Location");
      if (location) return Response.redirect(new URL(location, url).toString(), 301);
    }

    // /docs/how-to and /docs/use-cases hold pages but are not pages. A 404 there
    // becomes a 301 to /docs; it is decided after the assets answer, so a page
    // added at either path later is served.
    if (response.status === 404 && /^\/docs\/(how-to|use-cases)\/?$/.test(url.pathname)) {
      return Response.redirect(new URL("/docs", url).toString(), 301);
    }

    // A release's changelog splits into pages by length, so a page number can
    // stop existing when the text changes. A 404 on /changelog/<version>/<n>
    // (or its .md copy) becomes a 301 to the release's first page.
    const pageNo = response.status === 404 && /^\/changelog\/([^/]+)\/\d+(\.md)?\/?$/.exec(url.pathname);
    if (pageNo) {
      return Response.redirect(new URL(`/changelog/${pageNo[1]}${pageNo[2] ?? ""}`, url).toString(), 301);
    }

    const isNotFoundPage = /^\/404(\.html)?\/?$/.test(url.pathname) && response.status === 200;
    const status = isNotFoundPage ? 404 : response.status;
    const headers = new Headers(response.headers);
    let changed = isNotFoundPage;
    const set = (name: string, value: string) => {
      headers.set(name, value);
      changed = true;
    };

    if (url.hostname !== APEX) set("X-Robots-Tag", "noindex");
    // The whole site as one file: agents read it, search engines index the pages.
    if (url.pathname === "/llms-full.txt") set("X-Robots-Tag", "noindex");
    // A 404 body is the HTML 404 page, also for a missing .txt or .md path,
    // whose _headers rule names a text type.
    if (status === 404) set("Content-Type", "text/html; charset=utf-8");
    if (status === 200) {
      // A page may be shown from the browser cache for 5 minutes while it is
      // fetched again in the background, so the page the router prefetched on
      // hover is the one a click shows, with no second download.
      if (/^text\/html\b/i.test(response.headers.get("Content-Type") ?? "")) {
        set("Cache-Control", "public, max-age=0, stale-while-revalidate=300");
      }
      // A page's Markdown copy (/docs/quickstart.md, /index.md for /) names the
      // page as canonical. /agents.md and /skill.md have no page.
      const md = /^(\/.*)\.md$/.exec(url.pathname);
      if (md && url.pathname !== "/agents.md" && url.pathname !== "/skill.md") {
        set("Link", `<https://${APEX}${md[1] === "/index" ? "/" : md[1]}>; rel="canonical"`);
      }
    }
    if (!changed) return response;

    return new Response(response.body, {
      status,
      statusText: isNotFoundPage ? "Not Found" : response.statusText,
      headers,
    });
  },
};
