// The repository's CHANGELOG.md, parsed at build time for /changelog,
// /changelog/<version> and /changelog.xml, so none of them can disagree with
// the file. Keep a Changelog:
//   ## [version] - date     a release
//   plain paragraph(s)      the release summary, shown as its abstract
//   ### Added               a group (Added, Changed, Fixed, ...)
//   - **Area.** text        an entry; the bold lead is its area
import raw from "../../../../CHANGELOG.md?raw";

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
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="inline-link" href="$2">$1</a>');
const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();

export const slug = (v: string) => `v${v.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
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
      if (!area) areas.push((area = { name, id: idOf(name) || "changes", entries: [] }));
      const entry: Entry = { id: `${area.id}-${area.entries.length + 1}`, area: name, kind: g.name, html: inline(lead ? lead[2] : text) };
      area.entries.push(entry);
      return entry;
    }),
  }));
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
  };
});
