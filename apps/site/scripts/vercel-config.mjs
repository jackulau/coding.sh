// Writes dist/vercel.json: the Vercel version of what worker/index.ts and
// public/_headers do on Cloudflare. Run after `npm run build`; deploy dist with
// `vercel deploy --cwd dist --prod` (.github/workflows/site.yml).
//
// From the same sources, so the two hosts agree:
//   - worker/moved.ts: a moved page and its Markdown copy 301 to the new path;
//   - public/_headers: every rule becomes a `headers` entry.
// And what the worker does by hand: www to apex, /sitemap.xml to the sitemap
// index, /docs/how-to and /docs/use-cases to /docs, HTML cached for 5 minutes of
// stale-while-revalidate, noindex on other hosts, llms-full.txt and the
// installer, and a canonical Link on each page's Markdown copy.
//
// Not carried over: the 301 from a missing changelog page number to the
// release (Vercel cannot redirect only on a 404), and /404 itself answers 200.
// A trailing slash or .html redirects with Vercel's 308, not 301.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOVED } from "../worker/moved.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");
const APEX = "coding.sh";

// public/_headers, read the way headers.test.mjs reads it: a * matches any run
// of characters, slashes too.
function headerRules(text) {
  const out = [];
  let rule;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rule = { source: line.trim().replaceAll("*", "(.*)"), headers: [] };
      out.push(rule);
    } else {
      const at = line.indexOf(":");
      rule.headers.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
    }
  }
  return out;
}

const r301 = (source, destination, extra = {}) => ({ source, destination, statusCode: 301, ...extra });

// `built(path)` says whether dist holds a page at that path.
export function vercelConfig({ headersText, built }) {
  const redirects = [
    r301("/:path*", `https://${APEX}/:path*`, { has: [{ type: "host", value: `www.${APEX}` }] }),
    r301("/sitemap.xml", "/sitemap-index.xml"),
    ...Object.entries(MOVED).flatMap(([from, to]) => [r301(from, to), r301(`${from}.md`, `${to}.md`)]),
  ];
  // Folders that hold pages but are not pages; a page added there later wins.
  for (const dir of ["/docs/how-to", "/docs/use-cases"]) {
    if (!built(dir)) redirects.push(r301(dir, "/docs"));
  }

  const noindex = [{ key: "X-Robots-Tag", value: "noindex" }];
  const headers = [
    // A page (a path with no dot, other than the installer) may be shown from the
    // browser cache for 5 minutes while it is fetched again in the background.
    { source: "/((?!install$)(?!.*\\.).*)", headers: [{ key: "Cache-Control", value: "public, max-age=0, stale-while-revalidate=300" }] },
    ...headerRules(headersText),
    { source: "/(.*)", missing: [{ type: "host", value: APEX }], headers: noindex },
    { source: "/llms-full.txt", headers: noindex },
    { source: "/install", headers: noindex },
    { source: "/install.sh", headers: noindex },
    // A page's Markdown copy names the page as canonical. /agents.md and /skill.md have no page.
    { source: "/index.md", headers: [{ key: "Link", value: `<https://${APEX}/>; rel="canonical"` }] },
    {
      source: "/:page((?!(?:agents|skill|index)\\.md$).+)\\.md",
      headers: [{ key: "Link", value: `<https://${APEX}/:page>; rel="canonical"` }],
    },
  ];

  return { $schema: "https://openapi.vercel.sh/vercel.json", cleanUrls: true, trailingSlash: false, redirects, headers };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("vercel-config: no dist/index.html; run `npm run build` first");
    process.exit(1);
  }
  const config = vercelConfig({
    headersText: readFileSync(join(SITE, "public/_headers"), "utf8"),
    built: (path) => existsSync(join(DIST, `${path}.html`)) || existsSync(join(DIST, path, "index.html")),
  });
  // Vercel would serve _headers as a plain file; its rules are in vercel.json now.
  rmSync(join(DIST, "_headers"), { force: true });
  writeFileSync(join(DIST, "vercel.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(`vercel-config: dist/vercel.json, ${config.redirects.length} redirects, ${config.headers.length} header rules`);
}
