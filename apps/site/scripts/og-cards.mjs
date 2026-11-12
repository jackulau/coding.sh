// The Open Graph cards the site has, and what is printed on each: the site
// card, the changelog, the blog, every blog post and every docs page. gen-og.mjs
// draws them and writes public/og/manifest.json; test/og-fresh.test.mjs checks
// that manifest against this list, so a changed title cannot keep its old card.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = new URL("../", import.meta.url).pathname;

/** Bump when svg() in gen-og.mjs changes how a card looks, so every card is drawn again. */
export const TEMPLATE_VERSION = 1;

// The kicker names the section: comparisons are found from search as often as
// from the docs; every other docs page is "docs", whatever its path.
const kicker = (path) => (path === "/docs/compare" || path.startsWith("/docs/compare/") ? "compare" : "docs");

/** Blog posts: src/content/blog/<slug>.md, title from the front matter. */
export function blogPosts() {
  const dir = join(SITE, "src/content/blog");
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const front = readFileSync(join(dir, f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const title = front.match(/^title:\s*(.+)$/m)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
      if (!title) throw new Error(`og-cards: no title in ${f}`);
      return { slug: f.slice(0, -3), title };
    });
}

/** Every card as { name, kicker, title, sub }; name is the PNG's path under public/ without .png. */
export function cards(docPages, posts = blogPosts()) {
  return [
    { name: "og-image", title: "Traces and evals for AI agents.", sub: "Open source, local-first, MIT licensed." },
    { name: "og/changelog", kicker: "changelog", title: "Changelog", sub: "Every release, newest first." },
    { name: "og/blog", kicker: "blog", title: "Blog", sub: "Notes on how coding.sh works and why." },
    ...posts.map((p) => ({ name: `og/blog-${p.slug}`, kicker: "blog", title: p.title, sub: "coding.sh blog" })),
    ...docPages.map((p) => {
      const slug = p.path === "/docs" ? "docs" : `docs-${p.path.slice("/docs/".length).replace(/\//g, "-")}`;
      return { name: `og/${slug}`, kicker: kicker(p.path), title: p.title, sub: "coding.sh docs" };
    }),
  ];
}

/** What the manifest records for a card: its title, and the template (version, kicker, line under the title) it was drawn with. */
export const manifestEntry = (c) => ({ title: c.title, template: `v${TEMPLATE_VERSION}:${c.kicker ?? ""}:${c.sub}` });

/** The manifest for a list of cards, keys sorted so the file is stable. */
export function manifest(list) {
  return Object.fromEntries(list.map((c) => [c.name, manifestEntry(c)]).sort(([a], [b]) => (a < b ? -1 : 1)));
}
