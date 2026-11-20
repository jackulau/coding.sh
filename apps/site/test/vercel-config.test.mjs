// scripts/vercel-config.mjs: the Vercel config carries every moved page and
// every _headers rule, so coding.sh behaves on Vercel as it did on the worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vercelConfig } from "../scripts/vercel-config.mjs";
import { MOVED } from "../worker/moved.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const headersText = readFileSync(join(SITE, "public/_headers"), "utf8");
const config = vercelConfig({ headersText, built: () => false });
const redirect = (source) => config.redirects.find((r) => r.source === source && !r.has);

test("every moved page and its Markdown copy 301 to the new path", () => {
  for (const [from, to] of Object.entries(MOVED)) {
    assert.deepEqual([redirect(from)?.destination, redirect(from)?.statusCode], [to, 301], from);
    assert.equal(redirect(`${from}.md`)?.destination, `${to}.md`, `${from}.md`);
  }
});

test("www goes to the apex, and the sitemap to the sitemap index", () => {
  const www = config.redirects.find((r) => r.has?.[0]?.value === "www.coding.sh");
  assert.equal(www?.destination, "https://coding.sh/:path*");
  assert.equal(redirect("/sitemap.xml")?.destination, "/sitemap-index.xml");
});

test("a folder that holds pages redirects to /docs only while it has no page", () => {
  assert.equal(redirect("/docs/how-to")?.destination, "/docs");
  const built = vercelConfig({ headersText, built: (p) => p === "/docs/how-to" });
  assert.equal(built.redirects.find((r) => r.source === "/docs/how-to"), undefined);
});

test("every _headers rule is carried over, with * as a Vercel wildcard", () => {
  const paths = headersText
    .split("\n")
    .filter((l) => l.trim() && !/^\s/.test(l) && !l.startsWith("#"))
    .map((l) => l.trim().replaceAll("*", "(.*)"));
  const sources = config.headers.map((h) => h.source);
  assert.ok(paths.length > 10);
  for (const p of paths) assert.ok(sources.includes(p), p);
});

test("other hosts, llms-full.txt and the installer are noindex", () => {
  const robots = (h) => h.headers.some((x) => x.key === "X-Robots-Tag" && x.value === "noindex");
  assert.ok(config.headers.some((h) => h.missing?.[0]?.value === "coding.sh" && robots(h)));
  for (const p of ["/llms-full.txt", "/install", "/install.sh"]) {
    assert.ok(config.headers.some((h) => h.source === p && robots(h)), p);
  }
});
