// public/_headers: which rules match a path, read the way Cloudflare reads
// them. A * matches any run of characters, slashes too, and when two matching
// rules set the same header the values are joined with a comma, so no path may
// match two rules that set the same header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));

function rules() {
  const out = [];
  let rule;
  for (const line of readFileSync(join(SITE, "public/_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rule = { path: line.trim(), headers: {} };
      const re = "^" + rule.path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
      rule.re = new RegExp(re);
      out.push(rule);
    } else {
      const at = line.indexOf(":");
      rule.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return out;
}

const RULES = rules();
const header = (path, name) => RULES.filter((r) => r.re.test(path) && r.headers[name] !== undefined).map((r) => r.headers[name]);

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const served = (dir) => (existsSync(dir) ? walk(dir).map((f) => "/" + relative(dir, f).split(sep).join("/")) : []);

// What a build holds, by name: public/ itself, a built dist when there is one,
// and one path of each kind Astro and Pagefind write.
const PATHS = [
  ...served(join(SITE, "public")),
  ...served(join(SITE, "dist")),
  "/_astro/hero-session.Cx_x73Ig_5jj31.webp",
  "/_astro/logo.B1x2y3.svg",
  "/_astro/shot.B1x2y3.png",
  "/_astro/ClientRouter.B1x2y3.js",
  "/_astro/geist-latin.B1x2y3.woff2",
  "/og/docs-quickstart.png",
  "/pagefind/pagefind.js",
  "/pagefind/pagefind-worker.js",
  "/pagefind/wasm.en.pagefind",
  "/pagefind/pagefind-entry.json",
  "/pagefind/pagefind.en_3f2a1b.pf_meta",
  "/pagefind/fragment/en_3f2a1b.pf_fragment",
  "/pagefind/index/en_3f2a1b.pf_index",
  "/docs/quickstart.md",
  "/llms-full.txt",
  "/changelog.xml",
  "/",
  "/docs/quickstart",
];

test("_headers stays under Cloudflare's 100 rules", () => {
  assert.ok(RULES.length > 0 && RULES.length < 100, `${RULES.length} rules`);
});

test("no path gets a header from two rules", () => {
  for (const path of new Set(PATHS)) {
    for (const name of ["cache-control", "content-type", "access-control-allow-origin"]) {
      const values = header(path, name);
      assert.ok(values.length <= 1, `${path} gets ${name} from ${values.length} rules: ${values.join(" | ")}`);
    }
  }
});

test("each kind of file gets the cache lifetime it was given", () => {
  const year = "public, max-age=31536000, immutable";
  const day = "public, max-age=86400, stale-while-revalidate=604800";
  const want = {
    "/_astro/hero-session.Cx_x73Ig_5jj31.webp": year,
    "/_astro/logo.B1x2y3.svg": year,
    "/_astro/shot.B1x2y3.png": year,
    "/pagefind/fragment/en_3f2a1b.pf_fragment": year,
    "/pagefind/index/en_3f2a1b.pf_index": year,
    "/pagefind/pagefind.en_3f2a1b.pf_meta": year,
    "/pagefind/pagefind.js": "public, max-age=3600",
    "/pagefind/pagefind-worker.js": "public, max-age=3600",
    "/pagefind/wasm.en.pagefind": "public, max-age=3600",
    "/favicon.svg": day,
    "/favicon.ico": day,
    "/icon-192.png": day,
    "/apple-touch-icon.png": day,
    "/site.webmanifest": day,
    "/og-image.png": day,
    "/og/docs-quickstart.png": day,
  };
  for (const [path, value] of Object.entries(want)) assert.deepEqual(header(path, "cache-control"), [value], path);
});

test("the changelog feed is served as application/xml, a type the edge compresses", () => {
  assert.deepEqual(header("/changelog.xml", "content-type"), ["application/xml; charset=utf-8"]);
});
