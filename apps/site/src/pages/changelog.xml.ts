// /changelog.xml: an Atom feed of releases, from the same parse as /changelog.
// Each entry links to the release's notes page and carries its summary and the
// full list of changes, grouped by area.
import type { APIRoute } from "astro";
import { releases, esc } from "../lib/changelog";
import { SITE_URL } from "../data/site";

// Unreleased versions have no date yet; they carry the build date until they ship.
const when = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : new Date().toISOString().replace(/\.\d+Z$/, "Z"));

export const GET: APIRoute = () => {
  const entries = releases.map((r) => {
    const url = `${SITE_URL}/changelog/${r.slug}`;
    // Ids predate the notes pages; they stay as they were so readers don't see repeats.
    const id = `${SITE_URL}/changelog#${r.slug}`;
    const kinds = r.groups.length > 1;
    const html = [
      ...r.summary.map((s) => `<p>${s}</p>`),
      ...r.areas.map((a) => `<h3>${esc(a.name)}</h3><ul>${a.entries.map((e) => `<li>${kinds ? `<em>${esc(e.kind)}.</em> ` : ""}${e.html}</li>`).join("")}</ul>`),
    ].join("");
    return `  <entry>
    <title>coding.sh ${esc(r.version)}${r.date ? ` (${esc(r.dateLabel)})` : ""}</title>
    <id>${id}</id>
    <link href="${url}"/>
    <updated>${when(r.date)}</updated>
    <summary>${esc(r.summaryText)}</summary>
    <content type="html">${esc(html)}</content>
  </entry>`;
  });
  const updated = releases.length ? when(releases[0].date) : new Date().toISOString().replace(/\.\d+Z$/, "Z");
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
