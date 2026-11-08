// Last-modified dates for pages, from git: the newest commit that touched a
// page's source. Used for the sitemap <lastmod> (astro.config.mjs) and the
// TechArticle dateModified on docs pages. Plain .mjs so the Astro config can
// import it.
//
// A source with uncommitted edits, or no git history, falls back to the build
// time. A shallow checkout would date every file at HEAD, so the site workflow
// fetches full history.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SITE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPO_DIR = join(SITE_DIR, "../..");
const POSTS_DIR = join(SITE_DIR, "src/content/blog");
const BUILD_TIME = new Date().toISOString();
const cache = new Map();

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** ISO date of the last commit touching `file` (absolute path), or the build time. */
function fileLastmod(file) {
  if (cache.has(file)) return cache.get(file);
  let date = BUILD_TIME;
  if (!git(["status", "--porcelain", "--", file])) {
    const committed = git(["log", "-1", "--format=%cI", "--", file]);
    if (committed) date = new Date(committed).toISOString();
  }
  cache.set(file, date);
  return date;
}

/** Source files that make up the page at `pathname`: the route file, plus any repo doc or post it renders. */
function pageSources(pathname) {
  const route = pathname.replace(/^\/+|\/+$/g, "");
  if (/^changelog\/[^/]+$/.test(route)) return [join(REPO_DIR, "CHANGELOG.md")];
  // A blog post is its Markdown file; /blog lists every post, so each one dates it.
  if (/^blog\/[^/]+$/.test(route)) return [join(POSTS_DIR, `${route.slice("blog/".length)}.md`)].filter(existsSync);
  const posts = route === "blog" && existsSync(POSTS_DIR) ? readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md")).map((f) => join(POSTS_DIR, f)) : [];
  const pages = join(SITE_DIR, "src/pages");
  const base = route === "" ? join(pages, "index") : join(pages, route);
  const file = [`${base}.astro`, join(base, "index.astro"), `${base}.md`, `${base}.mdx`].find(existsSync);
  if (!file) return [];
  // Docs pages whose body is a repo doc: <MdDoc file="concepts.md" /> renders docs/concepts.md.
  const docs = [...readFileSync(file, "utf8").matchAll(/<MdDoc\s[^>]*file="([^"]+)"/g)]
    .map((m) => join(REPO_DIR, "docs", m[1]))
    .filter(existsSync);
  return [file, ...docs, ...posts];
}

/** ISO lastmod for a page path such as "/docs/quickstart". */
export function pageLastmod(pathname) {
  const dates = pageSources(pathname).map(fileLastmod);
  return dates.length ? dates.sort().at(-1) : BUILD_TIME;
}
