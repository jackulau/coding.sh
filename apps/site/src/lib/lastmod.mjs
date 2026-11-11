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
import { dirname, join } from "node:path";

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

const CHANGELOG = join(REPO_DIR, "CHANGELOG.md");
// The CLI pages (/docs/cli, /docs/cli/<command>) print the CLI's --help, which comes from here.
const CLI_REGISTRY = join(REPO_DIR, "packages/coding.sh/src/cli/registry.ts");
// The release slug in /changelog/<slug>, as src/lib/changelog.ts makes it.
const releaseSlug = (v) => `v${v.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/**
 * ISO lastmod for a released version's notes (/changelog/<slug>[/<n>]): the
 * newest commit among the lines of its section in CHANGELOG.md (the build time
 * if one is uncommitted), or its release date without git. Undefined for any
 * other page, and for the unreleased version, which follows the whole file.
 */
function releaseLastmod(route) {
  const m = route.match(/^changelog\/([^/]+)(?:\/\d+)?$/);
  if (!m || !existsSync(CHANGELOG)) return undefined;
  const key = `release:${m[1]}`;
  if (cache.has(key)) return cache.get(key);
  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const start = lines.findIndex((l) => releaseSlug(l.match(/^## \[([^\]]+)\]/)?.[1] ?? "") === m[1]);
  const released = start >= 0 && lines[start].match(/\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/)?.[1];
  let date;
  if (released) {
    const next = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
    const end = next < 0 ? lines.length : next;
    const blame = git(["blame", "--line-porcelain", "-L", `${start + 1},${end}`, "--", CHANGELOG]);
    const times = [...blame.matchAll(/^committer-time (\d+)$/gm)].map((t) => Number(t[1]));
    // An uncommitted line (blame's all-zero commit) dates the page at the build time, as fileLastmod does.
    if (/^0{40} /m.test(blame)) date = BUILD_TIME;
    else date = times.length ? new Date(Math.max(...times) * 1000).toISOString() : new Date(`${released}T00:00:00Z`).toISOString();
  }
  cache.set(key, date);
  return date;
}

/** Source files that make up the page at `pathname`: the route file, plus any repo doc or post it renders. */
export function pageSources(pathname) {
  const route = pathname.replace(/^\/+|\/+$/g, "");
  if (/^changelog\/[^/]+(\/\d+)?$/.test(route)) return [CHANGELOG];
  // A blog post is its Markdown file; /blog lists every post, so each one dates it.
  if (/^blog\/[^/]+$/.test(route)) return [join(POSTS_DIR, `${route.slice("blog/".length)}.md`)].filter(existsSync);
  const posts = route === "blog" && existsSync(POSTS_DIR) ? readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md")).map((f) => join(POSTS_DIR, f)) : [];
  const pages = join(SITE_DIR, "src/pages");
  const base = route === "" ? join(pages, "index") : join(pages, route);
  // A generated page (docs/cli/<command>) comes from its folder's [param].astro route.
  const dynamic = existsSync(dirname(base)) ? readdirSync(dirname(base)).find((f) => /^\[[^.\]]+\]\.astro$/.test(f)) : undefined;
  const file = [`${base}.astro`, join(base, "index.astro"), `${base}.md`, `${base}.mdx`, ...(dynamic ? [join(dirname(base), dynamic)] : [])].find(existsSync);
  if (!file) return [];
  // Docs pages whose body is a repo doc: <MdDoc file="concepts.md" /> renders docs/concepts.md.
  const docs = [...readFileSync(file, "utf8").matchAll(/<MdDoc\s[^>]*file="([^"]+)"/g)]
    .map((m) => join(REPO_DIR, "docs", m[1]))
    .filter(existsSync);
  // /changelog lists every release from CHANGELOG.md; the CLI pages show registry.ts's help.
  const data = [route === "changelog" && CHANGELOG, /^docs\/cli(\/|$)/.test(route) && CLI_REGISTRY].filter((f) => f && existsSync(f));
  return [file, ...docs, ...posts, ...data];
}

/** ISO lastmod for a page path such as "/docs/quickstart". */
export function pageLastmod(pathname) {
  const release = releaseLastmod(pathname.replace(/^\/+|\/+$/g, ""));
  if (release) return release;
  const dates = pageSources(pathname).map(fileLastmod);
  return dates.length ? dates.sort().at(-1) : BUILD_TIME;
}
