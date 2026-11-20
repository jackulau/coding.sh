// wrangler.jsonc run_worker_first: which paths run the edge Worker before the
// static assets, read the way Cloudflare reads the list. A * matches any run of
// characters, slashes too, and a path runs the Worker when an entry matches it
// and no ! entry does, in any order. Pages and text run it; the files a page
// loads skip it, since every request the Worker runs on counts toward the
// plan's daily limit and an asset request does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MOVED } from "../worker/moved.ts";
import { distOpts, needDist } from "./_dist.mjs";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");

// JSON with comments. A string can hold // (a URL), so each string is kept whole.
const config = JSON.parse(readFileSync(join(SITE, "wrangler.jsonc"), "utf8").replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s) => s ?? ""));
const LIST = config.assets.run_worker_first;
// The entries, or none when the setting is not a list (the first test fails then).
const ENTRIES = Array.isArray(LIST) ? LIST : [];

const glob = (p) => new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const RUN = ENTRIES.filter((p) => !p.startsWith("!")).map(glob);
const SKIP = ENTRIES.filter((p) => p.startsWith("!")).map((p) => glob(p.slice(1)));
const runsWorker = (path) => LIST === true || (RUN.some((re) => re.test(path)) && !SKIP.some((re) => re.test(path)));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = (dir) => walk(dir).map((f) => "/" + relative(dir, f).split(sep).join("/"));

test("run_worker_first is a list Cloudflare takes, and only its ! entries skip the Worker", () => {
  assert.ok(Array.isArray(LIST), "a list: with true, every request runs the Worker, icons and scripts too");
  assert.ok(LIST.length <= 100, `${LIST.length} entries; Cloudflare takes at most 100`);
  for (const p of LIST) assert.match(p, /^!?\//, `${p} starts with / or !/`);
  assert.equal(new Set(LIST).size, LIST.length, "no entry twice");
  assert.deepEqual(LIST.filter((p) => !p.startsWith("!")), ["/*"], "every path runs the Worker unless a ! entry names it");
});

// The paths worker/index.ts acts on. test/worker.test.mjs covers what it does on each.
const ACTS_ON = [
  "/", "/index.html", "/docs", "/docs/", "/docs/quickstart", "/docs/quickstart/", "/docs/quickstart.html",
  "/docs/quickstart.md", "/index.md", "/agents.md", "/skill.md", "/llms.txt", "/llms-full.txt",
  "/install", "/install.sh", "/sitemap.xml", "/404", "/404.html", "/docs/how-to", "/docs/use-cases/",
  "/changelog/v0-1-2/4", "/changelog/v0-1-2/4.md",
];

test("every path the Worker acts on runs it, a moved page and its Markdown copy too", () => {
  for (const path of ACTS_ON) assert.ok(runsWorker(path), path);
  for (const from of Object.keys(MOVED)) {
    for (const path of [from, `${from}/`, `${from}.md`]) assert.ok(runsWorker(path), `moved: ${path}`);
  }
});

test("each ! entry without a * names a file in public/", () => {
  const pub = new Set(files(join(SITE, "public")));
  for (const p of ENTRIES.filter((p) => p.startsWith("!") && !p.includes("*"))) assert.ok(pub.has(p.slice(1)), `${p}: no such file in public/`);
});

/**
 * The local paths a page loads: scripts, styles, preloads, icons, the manifest, images, its
 * social card, the fonts its CSS names and the scripts it imports later (search).
 */
function loads(html) {
  const out = [];
  for (const m of html.matchAll(/\burl\((\/(?!\/)[^)"'\s]+)\)|\bimport\(["'](\/(?!\/)[^"']+)["']\)/g)) out.push((m[1] ?? m[2]).replace(/[?#].*$/, ""));
  for (const [tag] of html.matchAll(/<(?:script|img|source|link|meta)\b[^>]*>/gi)) {
    if (/^<link/i.test(tag) && !/\brel="(?:[^"]*\s)?(?:stylesheet|icon|apple-touch-icon|manifest|preload|modulepreload)(?:\s[^"]*)?"/i.test(tag)) continue;
    const meta = /^<meta/i.test(tag);
    if (meta && !/\b(?:property|name)="(?:og|twitter):image"/i.test(tag)) continue;
    for (const [, attr, value] of tag.matchAll(/\s(src|srcset|href|content)="([^"]*)"/gi)) {
      if (meta !== (attr.toLowerCase() === "content")) continue;
      for (const part of value.split(",")) {
        const url = part.trim().split(/\s+/)[0].replace(/^https:\/\/coding\.sh(?=\/)/, "");
        if (url.startsWith("/") && !url.startsWith("//")) out.push(url.replace(/[?#].*$/, ""));
      }
    }
  }
  return out;
}

test("in the build, every page and Markdown copy runs the Worker and every file a page loads skips it", distOpts(DIST), () => {
  needDist(DIST);
  const built = files(DIST);
  const pages = built.filter((f) => f.endsWith(".html"));
  for (const f of pages) {
    const path = f === "/index.html" ? "/" : f.replace(/(\/index)?\.html$/, "");
    assert.ok(runsWorker(path), `page ${path}`);
    // html_handling answers the .html path with a redirect, which the Worker makes a 301.
    assert.ok(runsWorker(f), f);
  }
  for (const f of built.filter((f) => f.endsWith(".md"))) assert.ok(runsWorker(f), `Markdown copy ${f}`);
  const loaded = new Set(pages.flatMap((f) => loads(readFileSync(join(DIST, f), "utf8"))));
  for (const icon of JSON.parse(readFileSync(join(DIST, "site.webmanifest"), "utf8")).icons) loaded.add(icon.src);
  for (const path of ["/pagefind/pagefind.js", "/og-image.png", "/favicon.ico"]) assert.ok(loaded.has(path), `the pages load ${path}`);
  assert.ok([...loaded].some((p) => p.endsWith(".woff2")), "the pages load their fonts");
  for (const path of loaded) assert.ok(!runsWorker(path), `a page loads ${path} and it runs the Worker: add a ! entry`);
  for (const f of built.filter((f) => /^\/(?:_astro|pagefind|og)\//.test(f))) assert.ok(!runsWorker(f), f);
  for (const p of ENTRIES.filter((p) => p.startsWith("!"))) assert.ok(built.some((f) => glob(p.slice(1)).test(f)), `${p} matches no built file`);
});
