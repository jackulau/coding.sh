// /changelog.xml: an Atom feed of releases, from the same parse as /changelog.
import type { APIRoute } from "astro";
import { releases, slug, esc } from "../lib/changelog";
import { SITE_URL } from "../data/site";

// Unreleased versions have no date yet; they carry the build date until they ship.
const when = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : new Date().toISOString().replace(/\.\d+Z$/, "Z"));

export const GET: APIRoute = () => {
  const entries = releases.map((r) => {
    const url = `${SITE_URL}/changelog#${slug(r.version)}`;
    const html = [
      ...r.summary.map((s) => `<p>${s}</p>`),
      ...r.groups.map((g) => `<h3>${esc(g.name)}</h3><ul>${g.entries.map((e) => `<li>${e.tag ? `<strong>${esc(e.tag)}.</strong> ` : ""}${e.html}</li>`).join("")}</ul>`),
    ].join("");
    return `  <entry>
    <title>coding.sh ${esc(r.version)}${r.date ? ` (${esc(r.date)})` : ""}</title>
    <id>${url}</id>
    <link href="${url}"/>
    <updated>${when(r.date)}</updated>
    <content type="html">${esc(html)}</content>
  </entry>`;
  });
  const updated = releases.length ? when(releases[0].date) : new Date().toISOString();
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>coding.sh changelog</title>
  <id>${SITE_URL}/changelog</id>
  <link href="${SITE_URL}/changelog"/>
  <link rel="self" href="${SITE_URL}/changelog.xml"/>
  <updated>${updated}</updated>
  <author><name>coding.sh</name></author>
${entries.join("\n")}
</feed>
`;
  return new Response(body, { headers: { "Content-Type": "application/atom+xml; charset=utf-8" } });
};
