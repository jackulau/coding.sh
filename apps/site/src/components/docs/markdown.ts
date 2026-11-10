// Renders a page from docs/*.md at build time, so the repo docs and the site
// pages are one source. Handles the subset those files use: ## headings,
// paragraphs, lists, tables, fenced code, `code`, **bold** and [links].
// Code blocks are returned separately so the page can render them with <Code>.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MdBlock = { kind: "html"; html: string } | { kind: "code"; code: string; title: string };

const REPO_DOCS = join(process.cwd(), "..", "..", "docs");
const GITHUB_REPO = "https://github.com/jackulau/coding.sh/blob/main/";
const GITHUB_DOCS = `${GITHUB_REPO}docs/`;

/** Repo doc → site page. Anything else under docs/ links to GitHub. */
const SITE_PAGES: Record<string, string> = {
  "concepts.md": "/docs/concepts",
  "troubleshooting.md": "/docs/troubleshooting",
  "reference/config.md": "/docs/config",
  "reference/cli.md": "/docs/cli",
  "reference/sdk.md": "/docs/sdk",
  "guides/benchmarks.md": "/docs/benchmarks",
  "guides/workflows.md": "/docs/workflows",
  "reference/api.md": "/docs/api",
  "how-to/trace-your-agent.md": "/docs/how-to/trace-your-agent",
  "how-to/trace-durable-workflow.md": "/docs/how-to/trace-durable-workflow",
  "how-to/capture-with-proxy.md": "/docs/how-to/capture-with-proxy",
  "how-to/compare-agents.md": "/docs/how-to/compare-agents",
  "how-to/test-agents-md-change.md": "/docs/how-to/test-agents-md-change",
  "how-to/ci-regressions.md": "/docs/how-to/ci-regressions",
  "how-to/expensive-sessions.md": "/docs/how-to/expensive-sessions",
  "how-to/session-to-eval.md": "/docs/how-to/session-to-eval",
  "how-to/self-host-team.md": "/docs/how-to/self-host-team",
  "how-to/attribute-commits.md": "/docs/how-to/attribute-commits",
  "how-to/evaluate-a-skill.md": "/docs/how-to/evaluate-a-skill",
  "how-to/does-this-plugin-help.md": "/docs/how-to/does-this-plugin-help",
  "guides/terse-mode.md": "/docs/terse-mode",
  "perf.md": "/docs/perf",
  "use-cases/claude-code-cost.md": "/docs/use-cases/claude-code-cost",
  "use-cases/replay-agent-session.md": "/docs/use-cases/replay-agent-session",
  "use-cases/test-agent-instructions.md": "/docs/use-cases/test-agent-instructions",
  "use-cases/evals-from-failures.md": "/docs/use-cases/evals-from-failures",
  "use-cases/self-hosted-observability.md": "/docs/use-cases/self-hosted-observability",
  "use-cases/proxy-model-calls.md": "/docs/use-cases/proxy-model-calls",
  "use-cases/t3-code.md": "/docs/use-cases/t3-code",
  "use-cases/pi.md": "/docs/use-cases/pi",
  "compare/README.md": "/docs/compare",
  "compare/langfuse.md": "/docs/compare/langfuse",
  "compare/langsmith.md": "/docs/compare/langsmith",
  "compare/braintrust.md": "/docs/compare/braintrust",
  "compare/agentops.md": "/docs/compare/agentops",
  "compare/laminar.md": "/docs/compare/laminar",
  "compare/ccusage.md": "/docs/compare/ccusage",
};

/**
 * A doc too long for one page continues on others: the heading line each
 * later page starts at. A link to a heading in it, from this doc or another,
 * goes to the page that has that heading.
 */
const SPLITS: Record<string, { heading: string; path: string }[]> = {
  "reference/api.md": [
    { heading: "## Read API", path: "/docs/api/read" },
    { heading: "### `GET /api/search`", path: "/docs/api/read/search" },
  ],
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

/** Ids for a doc's headings in order, with GitHub's rule for repeats (-1, -2, ...). */
function headingIds() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

const HEADING = /^(#{1,4}) (.*)$/;
const splitAt = (file: string, line: string) => SPLITS[file]?.find((s) => line === s.heading)?.path;

/** The site page that shows heading `id` of docs/<file>: one of a split doc's pages. */
const headingPages = new Map<string, Map<string, string>>();
function pageOf(file: string, id: string): string | undefined {
  if (!SPLITS[file]) return undefined;
  if (!headingPages.has(file)) {
    const pages = new Map<string, string>();
    const idOf = headingIds();
    let page = SITE_PAGES[file]!;
    let fenced = false;
    for (const line of readFileSync(join(REPO_DOCS, file), "utf8").split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      const h = !fenced && line.match(HEADING);
      if (!h || h[1] === "#") continue;
      page = splitAt(file, line) ?? page;
      pages.set(idOf(h[2]!), page);
    }
    headingPages.set(file, pages);
  }
  return headingPages.get(file)!.get(id) ?? SITE_PAGES[file];
}

/** Heading ids of a split doc that are not on its first page, by the page that has them. */
export function laterPages(file: string): Record<string, string[]> {
  const first = SITE_PAGES[file]!;
  pageOf(file, "");
  const out: Record<string, string[]> = {};
  for (const [id, page] of headingPages.get(file) ?? []) if (page !== first) (out[page] ??= []).push(id);
  return out;
}

/** `here` is the page being rendered: an anchor on another page of a split doc gets that page's path. */
function href(url: string, from: string, here: string): string {
  const site = url.match(/^https:\/\/coding\.sh(\/docs\/.*)$/);
  if (site) return site[1]!;
  if (url.startsWith("#")) {
    const page = pageOf(from, url.slice(1));
    return page && page !== here ? `${page}${url}` : url;
  }
  if (/^[a-z]+:/.test(url)) return url;
  const [path, hash] = url.split("#") as [string, string | undefined];
  const parts = [...from.split("/").slice(0, -1), ...path.split("/")];
  const out: string[] = [];
  // A path that climbs out of docs/ (../../examples/x) is a repo file, not a doc.
  let outside = false;
  for (const p of parts) {
    if (p === "..") {
      if (out.length) out.pop();
      else outside = true;
    } else if (p && p !== ".") out.push(p);
  }
  const target = out.join("/");
  const anchor = hash ? `#${hash}` : "";
  if (outside) return `${GITHUB_REPO}${target}${anchor}`;
  if (!SITE_PAGES[target]) return `${GITHUB_DOCS}${target}${anchor}`;
  return `${(hash && pageOf(target, hash)) || SITE_PAGES[target]}${anchor}`;
}

function inline(text: string, from: string, here: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${href(u.replace(/&amp;/g, "&"), from, here)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * Parse docs/<file> for the site page `here`. Drops the # title and the "Site
 * version" pointer; the layout has its own. A split doc gives only the part
 * on `here` (see SPLITS).
 */
export function renderDoc(file: string, here: string = SITE_PAGES[file] ?? ""): MdBlock[] {
  return renderMarkdown(readFileSync(join(REPO_DOCS, file), "utf8"), file, here);
}

/** Parse Markdown text. `file` is its path under docs/, which relative links resolve against; `here` as for renderDoc. */
export function renderMarkdown(text: string, file: string, here: string = SITE_PAGES[file] ?? ""): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let html = "";
  let page = SITE_PAGES[file] ?? "";
  const keep = () => !SPLITS[file] || page === here;
  const flush = () => {
    if (html && keep()) blocks.push({ kind: "html", html });
    html = "";
  };
  const isTable = (i: number) => lines[i]?.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? "");
  const listItem = /^(\s*)(-|\d+\.) (.*)$/;
  const uniqueId = headingIds();
  const md = (text: string) => inline(text, file, here);

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
      if (keep()) blocks.push({ kind: "code", code: body.join("\n"), title: FENCE_TITLES[fence[1]!] ?? (fence[1] || "shell") });
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      i++;
      if (h[1] === "#") continue;
      const next = splitAt(file, line);
      if (next) {
        flush();
        page = next;
      }
      const tag = `h${h[1]!.length}`;
      html += `<${tag} id="${uniqueId(h[2]!)}">${md(h[2]!)}</${tag}>`;
      continue;
    }
    if (isTable(i)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      html +=
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${md(c)}</th>`).join("")}</tr></thead><tbody>` +
        // A cell that is one link becomes a full-cell tap target on touch (.cell-link).
        rows.map((r) => `<tr>${r.map((c) => `<td${/^\[[^\]]+\]\([^)\s]+\)$/.test(c) ? ' class="cell-link"' : ""}>${md(c)}</td>`).join("")}</tr>`).join("") +
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
      html += `<${tag}>${items.map((t) => `<li>${md(t)}</li>`).join("")}</${tag}>`;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4} |\s*(-|\d+\.) )/.test(lines[i]!) && !isTable(i)) para.push(lines[i++]!.trim());
    const text = para.join(" ").replace(/\s*Site version:\s*\[[^\]]*\]\([^)]*\)\.?/, "").trim();
    if (text) html += `<p>${md(text)}</p>`;
  }
  flush();
  if (!blocks.length) throw new Error(`docs: nothing in docs/${file} for ${here}; check SPLITS in markdown.ts`);
  return blocks;
}
