// Checks every built page for what search engines and link previews read, and
// fails the build on a problem: a <title> over 60 characters, a meta
// description over 155 or under 50, a title or description another page
// already uses, a canonical URL that isn't the page's own, an og:image that
// isn't in dist, more or fewer than one <h1>, JSON-LD that doesn't parse, and
// internal links to pages that don't exist. Run by `npm run build` after astro
// build; `node scripts/seo-check.mjs` checks an existing dist/.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const SITE = "https://coding.sh";
const TITLE_MAX = 60;
const DESC_MIN = 50;
const DESC_MAX = 155;

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

function exists(pathname) {
  const p = decodeURIComponent(pathname).replace(/\/$/, "");
  if (p === "") return true;
  return [p, `${p}.html`, `${p}/index.html`].some((c) => existsSync(join(DIST, c)) && statSync(join(DIST, c)).isFile());
}

const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (html, re) => decode(html.match(re)?.[1] ?? "");

const problems = [];
const titles = new Map();
const descriptions = new Map();
let pages = 0;

for (const file of htmlFiles(DIST)) {
  const route = routeOf(file);
  const html = readFileSync(file, "utf8");
  const bad = (msg) => problems.push(`${route}: ${msg}`);
  // Internal links are checked on every page, the 404 page included.
  // Absolute links to this site (https://coding.sh/…, as CHANGELOG.md writes them) count too.
  for (const [, href] of html.matchAll(/<a\s[^>]*href="(?:https:\/\/coding\.sh)?(\/[^"#?]*)[^"]*"/g)) {
    if (!href.startsWith("//") && !exists(href)) bad(`links to ${href}, which is not in dist`);
  }
  if (/<meta name="robots" content="noindex/.test(html)) continue;
  pages++;

  const title = decode(html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "");
  const description = attr(html, /<meta name="description" content="([^"]*)"/);
  const canonical = attr(html, /<link rel="canonical" href="([^"]*)"/);
  const ogImage = attr(html, /<meta property="og:image" content="([^"]*)"/);

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
  if (!ogImage.startsWith(SITE) || !existsSync(join(DIST, ogImage.slice(SITE.length)))) bad(`og:image ${ogImage || "missing"} is not in dist`);

  const h1s = html.match(/<h1[\s>]/g)?.length ?? 0;
  if (h1s !== 1) bad(`${h1s} <h1> elements`);

  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      JSON.parse(json);
    } catch {
      bad("JSON-LD does not parse");
    }
  }
}

if (problems.length) {
  console.error(`seo-check: ${problems.length} problem(s) in ${pages} pages\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`seo-check: ${pages} pages ok (titles, descriptions, canonicals, og:image, h1, JSON-LD, internal links)`);
