// Checks every built page for what search engines and link previews read, and
// fails the build on a problem: a <title> over 60 characters, a meta
// description over 155 or under 50, a title or description another page
// already uses, a canonical URL that isn't the page's own, an og:image that
// isn't in dist, more or fewer than one <h1>, JSON-LD that doesn't parse, and
// internal links to pages that don't exist.
//
// Named checks (the name is in each message):
//   [version]     softwareVersion, the footer and the head of llms.txt match packages/coding.sh/package.json
//   [hidden-text] no element that is both sr-only and aria-hidden="true" holds text
//   [markdown]    no raw Markdown link ([text](url)) in a page's text outside code
//   [github-doc]  no link to a doc on GitHub that has a page on the site
//   [fragment]    every internal #fragment link points at an id on its page
//   [og-url]      og:url equals the canonical URL
//   [jsonld-id]   every JSON-LD {"@id"} reference is defined on the page or carries its own @type
//   [headline]    a BlogPosting headline equals the page's <h1>
//   [sitemap]     every indexable page is in the sitemap, and every sitemap URL is an indexable page
//   [twin]        every sitemap URL has a Markdown twin (<page>.md, /index.md for the home page)
//   [twin-date]   a twin's updated: date is the date of its sitemap <lastmod>
//   [llms]        llms.txt links every sitemap URL outside /changelog/v* and /docs/cli/*
//
// Run by `npm run build` after astro build and the agent text;
// `node scripts/seo-check.mjs [--dist <dir>]` checks an existing dist/ (or a copy).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentExcluded } from "../src/lib/agent-routes.mjs";

const distArg = process.argv.indexOf("--dist");
if (distArg !== -1 && !process.argv[distArg + 1]) {
  console.error("seo-check: --dist needs a directory");
  process.exit(2);
}
const DIST = distArg !== -1 ? resolve(process.argv[distArg + 1]) + sep : fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(DIST)) {
  console.error(`seo-check: ${DIST} does not exist`);
  process.exit(2);
}
const SITE = "https://coding.sh";
const TITLE_MAX = 60;
const DESC_MIN = 50;
const DESC_MAX = 155;
const VERSION = JSON.parse(readFileSync(new URL("../../../packages/coding.sh/package.json", import.meta.url), "utf8")).version;
// Pages left out of llms.txt on purpose: /changelog and /docs/cli link them.
const NOT_IN_LLMS = [/^\/changelog\/v/, /^\/docs\/cli\//];
// Repo docs that have a site page, read from the map the docs renderer uses.
const GITHUB_DOC = /^https:\/\/github\.com\/jackulau\/coding\.sh\/(?:blob|tree)\/main\/docs\/([^#?]+)(?:[?#](.*))?$/;
const SITE_DOCS = new Map(
  [...(readFileSync(new URL("../src/components/docs/markdown.ts", import.meta.url), "utf8").match(/const SITE_PAGES\b[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "").matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "pagefind" || name === "_astro" ? [] : htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** /docs/quickstart for dist/docs/quickstart/index.html or dist/docs/quickstart.html. */
function routeOf(file) {
  const rel = relative(DIST, file).split(sep).join("/");
  const route = "/" + rel.replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "");
  return route.length > 1 ? route.replace(/\/$/, "") : "/";
}

const unescape = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The dist file a path serves, or undefined. */
function fileFor(pathname) {
  const p = unescape(pathname).replace(/\/$/, "");
  return [`${p}/index.html`, `${p}.html`, p]
    .filter(Boolean)
    .map((c) => join(DIST, c))
    .find((f) => existsSync(f) && statSync(f).isFile());
}
const exists = (pathname) => pathname.replace(/\/$/, "") === "" || fileFor(pathname) !== undefined;

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (html, re) => decode(html.match(re)?.[1] ?? "");
const text = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** /docs/x for https://coding.sh/docs/x/ or /docs/x#y; "/" for the home page. */
const norm = (url) => {
  const p = url.replace(/^https:\/\/coding\.sh/, "").replace(/[?#].*$/, "") || "/";
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

/** The HTML inside the element whose opening tag starts at `start`. */
function innerOf(html, start, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  let open = start;
  for (let t; (t = re.exec(html)); ) {
    if (t[1] === "/") {
      if (--depth === 0) return html.slice(open, t.index);
    } else if (t[2] !== "/") {
      if (depth++ === 0) open = t.index + t[0].length;
    } else if (depth === 0) return "";
  }
  return html.slice(open);
}

const ids = new Map();
/** Every id="" in a dist file. */
function idsOf(file) {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1]))));
  return ids.get(file);
}

/** Every object in a JSON-LD value, nested ones included. */
function nodesOf(value, out = []) {
  if (Array.isArray(value)) for (const v of value) nodesOf(v, out);
  else if (value && typeof value === "object") {
    out.push(value);
    for (const v of Object.values(value)) nodesOf(v, out);
  }
  return out;
}

const problems = [];
const titles = new Map();
const descriptions = new Map();
const indexable = new Set();
let pages = 0;

if (!SITE_DOCS.size) problems.push("seo-check: [github-doc] found no SITE_PAGES map in src/components/docs/markdown.ts");

for (const file of htmlFiles(DIST)) {
  const route = routeOf(file);
  const html = readFileSync(file, "utf8");
  const bad = (msg) => problems.push(`${route}: ${msg}`);
  // Internal links are checked on every page, the 404 page included.
  // Absolute links to this site (https://coding.sh/…, as CHANGELOG.md writes them) count too.
  for (const [, href] of html.matchAll(/<a\s[^>]*href="(?:https:\/\/coding\.sh)?(\/[^"#?]*)[^"]*"/g)) {
    if (!href.startsWith("//") && !exists(href)) bad(`links to ${href}, which is not in dist`);
  }
  for (const [, raw] of html.matchAll(/<a\s[^>]*href="([^"]*)"/g)) {
    const href = decode(raw);
    const doc = href.match(GITHUB_DOC);
    // reference/cli.md#<heading> stays on GitHub when the CLI pages have no place for that heading.
    if (doc && SITE_DOCS.has(doc[1]) && !(doc[1] === "reference/cli.md" && doc[2]))
      bad(`[github-doc] links to ${href}; that doc is on the site at ${SITE_DOCS.get(doc[1])}`);
    const local = href.replace(/^https:\/\/coding\.sh(?=\/|#)/, "");
    const hash = local.indexOf("#");
    if (hash === -1 || hash === local.length - 1 || !(local.startsWith("#") || (local.startsWith("/") && !local.startsWith("//")))) continue;
    const path = local.slice(0, hash).replace(/\?.*$/, "");
    const target = path ? fileFor(path) : file;
    if (!target) continue; // reported above as a missing page
    const id = unescape(local.slice(hash + 1));
    if (!idsOf(target).has(id)) bad(`[fragment] links to ${href}, but ${path ? norm(path) : "this page"} has no id "${id}"`);
  }
  if (/<meta name="robots" content="noindex/.test(html)) continue;
  pages++;
  indexable.add(route);

  const title = decode(html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "");
  const description = attr(html, /<meta name="description" content="([^"]*)"/);
  const canonical = attr(html, /<link rel="canonical" href="([^"]*)"/);
  const ogImage = attr(html, /<meta property="og:image" content="([^"]*)"/);
  const ogUrl = attr(html, /<meta property="og:url" content="([^"]*)"/);

  if (!title) bad("no <title>");
  else if (title.length > TITLE_MAX) bad(`<title> is ${title.length} characters (max ${TITLE_MAX}): ${title}`);
  if (!description) bad("no meta description");
  else if (description.length > DESC_MAX || description.length < DESC_MIN)
    bad(`description is ${description.length} characters (${DESC_MIN}-${DESC_MAX}): ${description}`);
  if (titles.has(title)) bad(`same <title> as ${titles.get(title)}`);
  else titles.set(title, route);
  if (descriptions.has(description)) bad(`same description as ${descriptions.get(description)}`);
  else descriptions.set(description, route);

  const expected = route === "/" ? `${SITE}/` : `${SITE}${route}`;
  if (canonical !== expected) bad(`canonical is ${canonical || "missing"}, expected ${expected}`);
  if (ogUrl !== canonical) bad(`[og-url] og:url is ${ogUrl || "missing"}, the canonical is ${canonical || "missing"}`);
  if (!ogImage.startsWith(SITE) || !existsSync(join(DIST, ogImage.slice(SITE.length)))) bad(`og:image ${ogImage || "missing"} is not in dist`);

  const h1s = [...html.matchAll(/<h1[\s>]/g)];
  if (h1s.length !== 1) bad(`${h1s.length} <h1> elements`);
  const h1 = h1s.length ? text(innerOf(html, h1s[0].index, "h1")) : "";

  const nodes = [];
  const roots = []; // the page's own nodes: each script's top level, or its @graph
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const value = JSON.parse(json);
      nodesOf(value, nodes);
      for (const n of [value].flat()) roots.push(...(Array.isArray(n?.["@graph"]) ? n["@graph"] : [n]));
    } catch {
      bad("JSON-LD does not parse");
    }
  }
  const typed = new Set(nodes.filter((n) => n["@id"] && n["@type"]).map((n) => n["@id"]));
  for (const n of nodes) {
    if (n["@id"] && !n["@type"] && !typed.has(n["@id"])) bad(`[jsonld-id] ${n["@id"]} is referenced but not defined on the page, and the reference has no @type`);
    if ("softwareVersion" in n && n.softwareVersion !== VERSION) bad(`[version] softwareVersion is ${n.softwareVersion}, package.json is ${VERSION}`);
  }
  for (const n of roots) {
    if ([n?.["@type"]].flat().includes("BlogPosting") && n.headline !== h1) bad(`[headline] BlogPosting headline "${n.headline}" is not the <h1> "${h1}"`);
  }

  const footer = html.match(/<footer\b[^>]*\bsite-footer\b[\s\S]*?<\/footer>/)?.[0] ?? "";
  for (const [, v] of text(footer).matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) if (v !== VERSION) bad(`[version] the footer says v${v}, package.json is ${VERSION}`);

  for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (VOID.has(m[1].toLowerCase()) || !/\baria-hidden="true"/.test(m[2]) || !/\bclass="[^"]*\bsr-only\b/.test(m[2])) continue;
    const words = text(innerOf(html, m.index, m[1]));
    if (words) bad(`[hidden-text] a <${m[1]}> that is sr-only and aria-hidden holds text: "${words.slice(0, 60)}"`);
  }

  // Text a reader sees: code, scripts and styles out, tags dropped.
  const body = (html.match(/<body\b[\s\S]*<\/body>/)?.[0] ?? "").replace(/<(pre|code|script|style|template)\b[\s\S]*?<\/\1>/gi, " ");
  const md = text(body).match(/\[[^\]\n]{1,200}\]\([^)\s]+\)/);
  if (md) bad(`[markdown] raw Markdown link in the text: ${md[0].slice(0, 100)}`);
}

// The sitemap, the twins and llms.txt.
const sitemap = new Map();
const index = join(DIST, "sitemap-index.xml");
if (!existsSync(index)) problems.push("/sitemap-index.xml: [sitemap] missing");
else {
  for (const [, loc] of readFileSync(index, "utf8").matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)) {
    const part = join(DIST, norm(loc));
    if (!existsSync(part)) {
      problems.push(`${norm(loc)}: [sitemap] listed in sitemap-index.xml but not in dist`);
      continue;
    }
    for (const [, url, lastmod] of readFileSync(part, "utf8").matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) sitemap.set(norm(decode(url)), lastmod);
  }
}
for (const route of indexable) if (!isAgentExcluded(route) && !sitemap.has(route)) problems.push(`${route}: [sitemap] indexable but not in the sitemap`);
const llmsFile = join(DIST, "llms.txt");
const llms = existsSync(llmsFile) ? readFileSync(llmsFile, "utf8") : "";
if (!llms) problems.push("/llms.txt: [llms] missing");
const linked = new Set([...llms.matchAll(/https:\/\/coding\.sh[^\s)\]>"'`]*/g)].map((m) => norm(m[0])));
for (const [route, lastmod] of sitemap) {
  const bad = (msg) => problems.push(`${route}: ${msg}`);
  if (!indexable.has(route)) bad(fileFor(route) ? "[sitemap] in the sitemap but noindex" : "[sitemap] in the sitemap but not in dist");
  if (llms && !NOT_IN_LLMS.some((re) => re.test(route)) && !linked.has(route)) bad("[llms] not linked from /llms.txt");
  if (isAgentExcluded(route)) continue;
  const twin = route === "/" ? "/index.md" : `${route}.md`;
  if (!existsSync(join(DIST, twin))) {
    bad(`[twin] no Markdown twin at ${twin}`);
    continue;
  }
  const updated = readFileSync(join(DIST, twin), "utf8").match(/^updated: (\S+)$/m)?.[1];
  if (!lastmod) bad("[twin-date] the sitemap gives no <lastmod>");
  else if (updated !== lastmod.slice(0, 10)) bad(`[twin-date] ${twin} says updated: ${updated ?? "(none)"}, the sitemap <lastmod> is ${lastmod}`);
}
// The head of llms.txt (before its first section) states the current version.
for (const [, v] of llms.split(/\n## /)[0].matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) if (v !== VERSION) problems.push(`/llms.txt: [version] the head says v${v}, package.json is ${VERSION}`);

// exitCode, not exit(): exit() can cut off a long report written to a pipe.
if (problems.length) {
  console.error(`seo-check: ${problems.length} problem(s) in ${pages} pages\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `seo-check: ${pages} pages ok (titles, descriptions, canonicals, og:image, h1, JSON-LD, internal links; version, hidden-text, markdown, github-doc, fragment, og-url, jsonld-id, headline, sitemap, twin, twin-date, llms)`,
  );
}
