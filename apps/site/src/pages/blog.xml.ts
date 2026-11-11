// /blog.xml: an Atom feed of blog posts, from the same collection as /blog.
// Each entry links to the post and carries its description and full text.
import type { APIRoute } from "astro";
import { esc } from "../lib/changelog";
import { getPosts } from "../lib/blog";
import { SITE_URL } from "../data/site";
import type { MdBlock } from "../components/docs/markdown";

// Site-relative links (/docs/...) become absolute, since feed readers have no base URL.
const absolute = (html: string) => html.replace(/(href=")\//g, `$1${SITE_URL}/`);
const pre = (code: string) => `<pre><code>${esc(code)}</code></pre>`;
const toHtml = (blocks: MdBlock[]): string =>
  blocks
    .map((b) =>
      b.kind === "code" ? pre(b.code)
      : b.kind === "tabs" ? b.tabs.map((t) => pre(t.code)).join("")
      : b.kind === "more" ? `<details><summary>${b.summary}</summary>${toHtml(b.blocks)}</details>`
      : b.kind === "note" ? toHtml(b.blocks)
      : b.kind === "shot" ? ""
      : absolute(b.html),
    )
    .join("");

export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const entries = posts.map((p) => {
    const url = `${SITE_URL}${p.path}`;
    const html = toHtml(p.blocks);
    return `  <entry>
    <title>${esc(p.title)}</title>
    <id>${url}</id>
    <link href="${url}"/>
    <published>${p.published}</published>
    <updated>${p.modified ?? p.published}</updated>
    <summary>${esc(p.description)}</summary>
    <content type="html">${esc(html)}</content>
  </entry>`;
  });
  const updated = posts.map((p) => p.modified ?? p.published).sort().at(-1) ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>coding.sh blog</title>
  <id>${SITE_URL}/blog</id>
  <link href="${SITE_URL}/blog"/>
  <link rel="self" href="${SITE_URL}/blog.xml"/>
  <updated>${updated}</updated>
  <author><name>coding.sh</name></author>
${entries.join("\n")}
</feed>
`;
  return new Response(body, { headers: { "Content-Type": "application/atom+xml; charset=utf-8" } });
};
