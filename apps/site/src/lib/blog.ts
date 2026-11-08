// Blog posts from the `blog` content collection (src/content.config.ts), newest
// first, shared by /blog, /blog/<slug> and /blog.xml.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCollection } from "astro:content";
import { renderMarkdown, type MdBlock } from "../components/docs/markdown";

export interface Post {
  slug: string;
  path: string;
  title: string;
  description: string;
  /** ISO timestamps for meta tags and the feed. */
  published: string;
  modified?: string;
  dateLabel: string;
  /** Title card from scripts/gen-og.mjs (npm run og), or the blog card until it is generated. */
  image: string;
  blocks: MdBlock[];
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
const label = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const card = (name: string) => (existsSync(join(process.cwd(), "public", "og", `${name}.png`)) ? `/og/${name}.png` : "/og-image.png");

/** The blog index card. */
export const BLOG_IMAGE = card("blog");

export async function getPosts(): Promise<Post[]> {
  const entries = await getCollection("blog");
  return entries
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id))
    .map((e) => {
      const image = card(`blog-${e.id}`);
      return {
        slug: e.id,
        path: `/blog/${e.id}`,
        title: e.data.title,
        description: e.data.description,
        published: iso(e.data.date),
        modified: e.data.updated && iso(e.data.updated),
        dateLabel: label(e.data.date),
        image: image === "/og-image.png" ? BLOG_IMAGE : image,
        // Relative links resolve as if the post sat in docs/blog/.
        blocks: renderMarkdown(e.body ?? "", `blog/${e.id}.md`),
      };
    });
}
