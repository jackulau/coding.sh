// Content collections. blog: one Markdown file per post under src/content/blog;
// the file name is the URL slug (/blog/<slug>). Bodies are rendered by the docs
// renderer (src/lib/blog.ts), so code blocks and tables match the docs.
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    /** One sentence: the index line, meta description and feed summary. */
    description: z.string(),
    /** Publish date, YYYY-MM-DD. */
    date: z.coerce.date(),
    /** Last meaningful edit, YYYY-MM-DD. */
    updated: z.coerce.date().optional(),
  }),
});

export const collections = { blog };
