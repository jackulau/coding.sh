// What the edge worker changes on the way out of the static assets: statuses,
// redirects and headers. The assets are a stub that answers from a table.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.ts";

const HTML = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" };
const MD = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" };

// path -> [status, headers, body]; anything else is the 404 page.
const ASSETS = {
  "/": [200, HTML, "home"],
  "/docs/quickstart": [200, HTML, "quickstart"],
  "/404": [200, HTML, "not found page"],
  "/_astro/hero.Cx.webp": [200, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" }, "webp"],
  "/docs/quickstart.md": [200, MD, "# Quickstart"],
  "/changelog/v0-1-2/4.md": [200, MD, "# v0.1.2"],
  "/index.md": [200, MD, "# coding.sh"],
  "/agents.md": [200, MD, "# For agents"],
  "/skill.md": [200, MD, "# Skill"],
  "/llms.txt": [200, { "Content-Type": "text/plain; charset=utf-8" }, "llms"],
  "/llms-full.txt": [200, { "Content-Type": "text/plain; charset=utf-8" }, "llms full"],
  "/docs/": [307, { Location: "/docs" }, null],
  "/docs/quickstart.html": [307, { Location: "/docs/quickstart" }, null],
  "/index.html": [307, { Location: "/" }, null],
};

function assets() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      seen.push(pathname);
      const missing = [404, { "Content-Type": /\.(txt|md)$/.test(pathname) ? "text/plain; charset=utf-8" : "text/html; charset=utf-8" }, "not found page"];
      const [status, headers, body] = ASSETS[pathname] ?? missing;
      return new Response(request.method === "HEAD" ? null : body, { status, headers });
    },
  };
}

async function get(path, { method = "GET", host = "coding.sh" } = {}) {
  const env = { ASSETS: assets() };
  const res = await worker.fetch(new Request(`https://${host}${path}`, { method }), env);
  return Object.assign(res, { seen: env.ASSETS.seen });
}

test("a plain 200 passes through with its status, body and headers", async () => {
  const res = await get("/_astro/hero.Cx.webp");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "webp");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("Link"), null);
  assert.equal(res.headers.get("X-Robots-Tag"), null);
});

test("a 200 HTML page may be used for 5 minutes while it revalidates", async () => {
  for (const path of ["/", "/docs/quickstart"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), path === "/" ? "home" : "quickstart", path);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, stale-while-revalidate=300", path);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8", path);
  }
  // Not HTML, not 200: the asset's own Cache-Control stays.
  assert.equal((await get("/docs/quickstart.md")).headers.get("Cache-Control"), MD["Cache-Control"]);
  assert.notEqual((await get("/nope")).headers.get("Cache-Control"), "public, max-age=0, stale-while-revalidate=300");
});

test("every 307 from the assets is a 301 for GET and HEAD, and stays a 307 for POST", async () => {
  for (const [path, to] of [["/docs/", "/docs"], ["/docs/quickstart.html", "/docs/quickstart"], ["/index.html", "/"]]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await get(path, { method });
      assert.equal(res.status, 301, `${method} ${path}`);
      assert.equal(res.headers.get("Location"), `https://coding.sh${to}`, `${method} ${path}`);
    }
    assert.equal((await get(path, { method: "POST" })).status, 307, `POST ${path}`);
  }
});

test("a 404 on /docs/how-to or /docs/use-cases is a 301 to /docs, decided after the assets", async () => {
  for (const path of ["/docs/how-to", "/docs/use-cases"]) {
    const res = await get(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("Location"), "https://coding.sh/docs", path);
    assert.deepEqual(res.seen, [path], `${path}: the assets were asked first`);
  }
  // Other missing paths under them are plain 404s.
  assert.equal((await get("/docs/how-to/nope")).status, 404);
});

test("a 404 on a changelog page number is a 301 to the release, decided after the assets", async () => {
  for (const [path, to] of [["/changelog/v0-1-3/2", "/changelog/v0-1-3"], ["/changelog/v0-1-3/2.md", "/changelog/v0-1-3.md"], ["/changelog/v0-1-3/7/", "/changelog/v0-1-3"]]) {
    const res = await get(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("Location"), `https://coding.sh${to}`, path);
    assert.deepEqual(res.seen, [path], `${path}: the assets were asked first`);
  }
  // A page that exists is served, and other changelog paths stay plain 404s.
  assert.equal((await get("/changelog/v0-1-2/4.md")).status, 200);
  assert.equal((await get("/changelog/v0-1-3/nope")).status, 404);
  assert.equal((await get("/changelog/v0-1-3/2/x")).status, 404);
});

test("a 404 is served as HTML, also for a missing .txt or .md path", async () => {
  for (const path of ["/nope", "/.well-known/security.txt", "/docs/nope.md", "/404"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8", path);
    assert.equal(await res.text(), "not found page", path);
  }
});

test("a page's Markdown copy names the page as canonical", async () => {
  for (const [path, page] of [["/docs/quickstart.md", "/docs/quickstart"], ["/changelog/v0-1-2/4.md", "/changelog/v0-1-2/4"], ["/index.md", "/"]]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("Link"), `<https://coding.sh${page}>; rel="canonical"`, path);
    assert.equal(res.headers.get("Content-Type"), MD["Content-Type"], path);
  }
  for (const path of ["/agents.md", "/skill.md", "/docs/nope.md"]) {
    assert.equal((await get(path)).headers.get("Link"), null, path);
  }
});

test("/llms-full.txt is marked noindex and /llms.txt is not", async () => {
  const full = await get("/llms-full.txt");
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "llms full");
  assert.equal(full.headers.get("X-Robots-Tag"), "noindex");
  assert.equal((await get("/llms.txt")).headers.get("X-Robots-Tag"), null);
});

test("the redirects and rules before the assets still hold", async () => {
  const www = await get("/docs?x=1", { host: "www.coding.sh" });
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("Location"), "https://coding.sh/docs?x=1");
  assert.equal((await get("/sitemap.xml")).headers.get("Location"), "https://coding.sh/sitemap-index.xml");
  const preview = await get("/", { host: "coding-sh-site.example.workers.dev" });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("X-Robots-Tag"), "noindex");
});
