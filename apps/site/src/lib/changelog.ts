// The repository's CHANGELOG.md, parsed at build time for /changelog,
// /changelog/<version> and /changelog.xml, so none of them can disagree with
// the file. Keep a Changelog:
//   ## [version] - date     a release
//   plain paragraph(s)      the release summary, shown as its abstract
//   ### Added               a group (Added, Changed, Fixed, ...)
//   - **Area.** text        an entry; the bold lead is its area
import raw from "../../../../CHANGELOG.md?raw";
import { docHref } from "../components/docs/markdown";
import { REPO_URL } from "../data/site";

export interface Entry {
  /** Anchor id, unique within its release. */
  id: string;
  area: string;
  /** The Keep a Changelog group it was listed under. */
  kind: string;
  html: string;
}
export interface Area {
  name: string;
  id: string;
  entries: Entry[];
  /** Which page of the release's notes holds it, from 1. */
  page: number;
  /** /changelog/<slug>[/<page>]#<id> */
  href: string;
}
export interface Release {
  version: string;
  /** /changelog/<slug> and #<slug> on the index. */
  slug: string;
  /** As written: an ISO date or "Unreleased". */
  date: string;
  /** "Nov 6, 2026", or the raw value when it is not a date. */
  dateLabel: string;
  summary: string[];
  /** The summary as plain text, for meta descriptions. */
  summaryText: string;
  groups: { name: string; entries: Entry[] }[];
  /** Entries by area, in the order each area first appears. */
  areas: Area[];
  count: number;
  /** Pages the notes are split over; see PAGE_CHARS. */
  pages: number;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const REPO_FILES = `${REPO_URL}/blob/main/`;
// A repo doc, linked as docs/<doc> or on GitHub, goes to its site page when it
// has one (docHref); any other repo path goes to the file on GitHub.
const link = (url: string) => {
  const path = url.startsWith(REPO_FILES) ? url.slice(REPO_FILES.length) : /^(https?:|#|\/)/.test(url) ? "" : url.replace(/^(\.\.?\/)+/, "");
  if (!path) return url;
  return path.startsWith("docs/") ? docHref(path.slice("docs/".length)) : `${REPO_FILES}${path}`;
};
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => `<a class="inline-link" href="${link(url)}">${text}</a>`);
const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();

export const slug = (v: string) => `v${v.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
/** Page 1 of a release's notes is /changelog/<slug>; later pages add /<n>. */
export const releasePath = (slug: string, page = 1) => `/changelog/${slug}${page > 1 ? `/${page}` : ""}`;

// A long release (the unreleased one collects every change until it ships) is
// split into pages of whole areas, each holding about this much entry HTML, so
// a page stays inside its HTML budget (scripts/perf-budget.mjs). An area is
// never split, so one larger than this gets a page to itself.
const PAGE_CHARS = 24_000;
const idOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (date: string) => {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : date;
};

interface Draft {
  version: string;
  date: string;
  paras: string[][];
  groups: { name: string; items: string[] }[];
}
const drafts: Draft[] = [];
let cur: Draft | undefined;
let gap = true;
for (const line of raw.split("\n")) {
  const rel = line.match(/^## \[([^\]]+)\](?:\s*-\s*(.+))?/);
  if (rel) {
    cur = { version: rel[1], date: (rel[2] ?? "").trim(), paras: [], groups: [] };
    drafts.push(cur);
    gap = true;
    continue;
  }
  if (!cur) continue;
  const grp = line.match(/^### (.+)/);
  if (grp) {
    cur.groups.push({ name: grp[1].trim(), items: [] });
    continue;
  }
  const item = line.match(/^- (.+)/);
  if (item && cur.groups.length) {
    cur.groups[cur.groups.length - 1].items.push(item[1]);
    continue;
  }
  // Prose before the first group is the summary; wrapped lines join into one paragraph.
  if (cur.groups.length || /^\[[^\]]+\]:/.test(line)) continue;
  if (!line.trim()) {
    gap = true;
    continue;
  }
  if (gap) cur.paras.push([]);
  cur.paras[cur.paras.length - 1].push(line.trim());
  gap = false;
}

export const releases: Release[] = drafts.map((d) => {
  const areas: Area[] = [];
  const groups = d.groups.map((g) => ({
    name: g.name,
    entries: g.items.map((text) => {
      const lead = text.match(/^\*\*([^*]+?)\.?\*\*\s*(.*)$/);
      const name = lead ? lead[1] : g.name;
      let area = areas.find((a) => a.name === name);
      if (!area) areas.push((area = { name, id: idOf(name) || "changes", entries: [], page: 1, href: "" }));
      const entry: Entry = { id: `${area.id}-${area.entries.length + 1}`, area: name, kind: g.name, html: inline(lead ? lead[2] : text) };
      area.entries.push(entry);
      return entry;
    }),
  }));
  let page = 1;
  let chars = 0;
  for (const a of areas) {
    const size = a.entries.reduce((n, e) => n + e.html.length, 0);
    if (chars && chars + size > PAGE_CHARS) [page, chars] = [page + 1, 0];
    chars += size;
    a.page = page;
    a.href = `${releasePath(slug(d.version), page)}#${a.id}`;
  }
  const summary = d.paras.map((p) => p.join(" "));
  return {
    version: d.version,
    slug: slug(d.version),
    date: d.date,
    dateLabel: label(d.date),
    summary: summary.map(inline),
    summaryText: summary.map(plain).join(" "),
    groups,
    areas,
    count: groups.reduce((n, g) => n + g.entries.length, 0),
    pages: page,
  };
});
