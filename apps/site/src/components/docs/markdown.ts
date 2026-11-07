// Renders a page from docs/*.md at build time, so the repo docs and the site
// pages are one source. Handles the subset those files use: ## headings,
// paragraphs, lists, tables, fenced code, `code`, **bold** and [links].
// Code blocks are returned separately so the page can render them with <Code>.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MdBlock = { kind: "html"; html: string } | { kind: "code"; code: string; title: string };

const REPO_DOCS = join(process.cwd(), "..", "..", "docs");
const GITHUB_DOCS = "https://github.com/jackulau/coding.sh/blob/main/docs/";

/** Repo doc → site page. Anything else under docs/ links to GitHub. */
const SITE_PAGES: Record<string, string> = {
  "concepts.md": "/docs/concepts",
  "troubleshooting.md": "/docs/troubleshooting",
  "reference/config.md": "/docs/config",
  "reference/cli.md": "/docs/cli",
  "reference/sdk.md": "/docs/sdk",
  "guides/benchmarks.md": "/docs/benchmarks",
  "reference/api.md": "/docs/api",
  "how-to/trace-your-agent.md": "/docs/how-to/trace-your-agent",
  "how-to/compare-agents.md": "/docs/how-to/compare-agents",
  "how-to/ci-regressions.md": "/docs/how-to/ci-regressions",
  "how-to/expensive-sessions.md": "/docs/how-to/expensive-sessions",
  "how-to/session-to-eval.md": "/docs/how-to/session-to-eval",
  "how-to/self-host-team.md": "/docs/how-to/self-host-team",
};

const FENCE_TITLES: Record<string, string> = { sh: "shell", text: "output", toml: "config.toml" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchors, so #links work on both GitHub and the site. */
export function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

function href(url: string, from: string): string {
  const site = url.match(/^https:\/\/coding\.sh(\/docs\/.*)$/);
  if (site) return site[1]!;
  if (/^[a-z]+:/.test(url) || url.startsWith("#")) return url;
  const [path, hash] = url.split("#") as [string, string | undefined];
  const parts = [...from.split("/").slice(0, -1), ...path.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  const target = out.join("/");
  const anchor = hash ? `#${hash}` : "";
  return SITE_PAGES[target] ? `${SITE_PAGES[target]}${anchor}` : `${GITHUB_DOCS}${target}${anchor}`;
}

function inline(text: string, from: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${href(u.replace(/&amp;/g, "&"), from)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/** Parse docs/<file>. Drops the # title and the "Site version" pointer; the layout has its own. */
export function renderDoc(file: string): MdBlock[] {
  const lines = readFileSync(join(REPO_DOCS, file), "utf8").split("\n");
  const blocks: MdBlock[] = [];
  let html = "";
  const flush = () => {
    if (html) blocks.push({ kind: "html", html });
    html = "";
  };
  const isTable = (i: number) => lines[i]?.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? "");
  const listItem = /^(\s*)(-|\d+\.) (.*)$/;
  const seen = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base; // GitHub's rule for repeated headings
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim() || line.startsWith("<!--")) {
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      i++;
      flush();
      blocks.push({ kind: "code", code: body.join("\n"), title: FENCE_TITLES[fence[1]!] ?? (fence[1] || "shell") });
      continue;
    }
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) {
      i++;
      if (h[1] === "#") continue;
      const tag = `h${h[1]!.length}`;
      html += `<${tag} id="${uniqueId(h[2]!)}">${inline(h[2]!, file)}</${tag}>`;
      continue;
    }
    if (isTable(i)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      html +=
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, file)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, file)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`;
      continue;
    }
    const li = line.match(listItem);
    if (li) {
      const tag = /\d/.test(li[2]!) ? "ol" : "ul";
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(listItem);
        if (m) items.push(m[3]!);
        else if (/^\s+\S/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      html += `<${tag}>${items.map((t) => `<li>${inline(t, file)}</li>`).join("")}</${tag}>`;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4} |\s*(-|\d+\.) )/.test(lines[i]!) && !isTable(i)) para.push(lines[i++]!.trim());
    const text = para.join(" ").replace(/\s*Site version:\s*\[[^\]]*\]\([^)]*\)\.?/, "").trim();
    if (text) html += `<p>${inline(text, file)}</p>`;
  }
  flush();
  return blocks;
}
