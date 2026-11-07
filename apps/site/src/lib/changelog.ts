// The repository's CHANGELOG.md, parsed at build time for /changelog and
// /changelog.xml, so neither can disagree with the file. Keep a Changelog:
//   ## [version] - date     a release
//   ### Added               a group
//   - **Area.** text        an entry; the bold lead becomes its tag
import raw from "../../../../CHANGELOG.md?raw";

export interface Entry {
  tag?: string;
  html: string;
}
export interface Release {
  version: string;
  date: string;
  summary: string[];
  groups: { name: string; entries: Entry[] }[];
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="inline-link" href="$2">$1</a>');

export const releases: Release[] = [];
let cur: Release | undefined;
for (const line of raw.split("\n")) {
  const rel = line.match(/^## \[([^\]]+)\](?:\s*-\s*(.+))?/);
  if (rel) {
    cur = { version: rel[1], date: (rel[2] ?? "").trim(), summary: [], groups: [] };
    releases.push(cur);
    continue;
  }
  if (!cur) continue;
  const grp = line.match(/^### (.+)/);
  if (grp) {
    cur.groups.push({ name: grp[1].trim(), entries: [] });
    continue;
  }
  const item = line.match(/^- (.+)/);
  if (item && cur.groups.length) {
    const lead = item[1].match(/^\*\*([^*]+?)\.?\*\*\s*(.*)$/);
    cur.groups[cur.groups.length - 1].entries.push(lead ? { tag: lead[1], html: inline(lead[2]) } : { html: inline(item[1]) });
    continue;
  }
  if (line.trim() && !/^\[[^\]]+\]:/.test(line) && !cur.groups.length) cur.summary.push(inline(line.trim()));
}

export const slug = (v: string) => `v${v.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
