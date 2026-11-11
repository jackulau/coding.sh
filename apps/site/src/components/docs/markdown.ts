// Renders a page from docs/*.md at build time, so the repo docs and the site
// pages are one source. Handles the subset those files use: ## headings,
// paragraphs, lists, tables, fenced code, `code`, **bold** and [links], plus a
// few site blocks (each also reads fine on GitHub):
//
//   ```ts tab=TypeScript title=triage.mjs     consecutive tab= fences become one
//   ```py tab=Python title=triage.py          CodeTabs; group= (default "lang")
//                                             keeps the pick in sync on the page
//   :::more Summary text  …  :::              a <details class="more"> disclosure
//   :::note  …  :::                           a <div class="note"> aside
//   ![alt](shot:docs/name "caption")          a DocShot (src/assets/<name>.webp)
//   ![alt](diagram:name "caption")            src/assets/docs/diagrams/<name>.svg inline
//
// The first paragraph under the # title is the GitHub lede. The site skips it,
// because the layout prints the nav summary there (a paragraph that ends in a
// colon introduces what follows, so it stays).
// Code, tabs, shots and containers are returned as blocks so MdDoc.astro can
// render them with the site components.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MOVED } from "../../../worker/moved.ts";

export interface CodeTab {
  label: string;
  code: string;
  title: string;
}

export type MdBlock =
  | { kind: "html"; html: string }
  | { kind: "code"; code: string; title: string }
  | { kind: "tabs"; group: string; tabs: CodeTab[] }
  | { kind: "more"; summary: string; blocks: MdBlock[] }
  | { kind: "note"; blocks: MdBlock[] }
  | { kind: "shot"; name: string; alt: string; caption?: string }
  | { kind: "diagram"; html: string };

const REPO_DOCS = join(process.cwd(), "..", "..", "docs");
const DIAGRAMS = join(process.cwd(), "src", "assets", "docs", "diagrams");
const GITHUB_REPO = "https://github.com/jackulau/coding.sh/blob/main/";
const GITHUB_DOCS = `${GITHUB_REPO}docs/`;

/** Repo doc → site page. Anything else under docs/ links to GitHub. */
const SITE_PAGES: Record<string, string> = {
  "concepts.md": "/docs/concepts",
  "troubleshooting.md": "/docs/troubleshooting",
  "reference/config.md": "/docs/config",
  "reference/cli.md": "/docs/cli",
  "reference/sdk.md": "/docs/sdk",
  "reference/query.md": "/docs/query",
  "reference/stores.md": "/docs/stores",
  "reference/eval-methods.md": "/docs/eval-methods",
  "reference/api.md": "/docs/api",
  "guides/explore.md": "/docs/explore",
  "guides/improve.md": "/docs/improve",
  "guides/privacy.md": "/docs/privacy",
  "guides/benchmarks.md": "/docs/benchmarks",
  "guides/workflows.md": "/docs/workflows",
  "guides/terse-mode.md": "/docs/terse-mode",
  "how-to/trace-your-agent.md": "/docs/how-to/trace-your-agent",
  "how-to/trace-durable-workflow.md": "/docs/how-to/trace-durable-workflow",
  "how-to/capture-with-proxy.md": "/docs/how-to/capture-with-proxy",
  "how-to/track-cost.md": "/docs/cost",
  "how-to/compare-agents.md": "/docs/how-to/compare-agents",
  "how-to/replay-llm-calls.md": "/docs/how-to/replay-llm-calls",
  "how-to/test-agents-md-change.md": "/docs/how-to/test-agents-md-change",
  "how-to/ci-regressions.md": "/docs/how-to/ci-regressions",
  "how-to/session-to-eval.md": "/docs/how-to/session-to-eval",
  "how-to/self-host-team.md": "/docs/how-to/self-host-team",
  "how-to/attribute-commits.md": "/docs/how-to/attribute-commits",
  "how-to/evaluate-a-skill.md": "/docs/how-to/evaluate-a-skill",
  "how-to/does-this-plugin-help.md": "/docs/how-to/does-this-plugin-help",
  "production/deploy.md": "/docs/deploy",
  "use-cases/replay-agent-session.md": "/docs/use-cases/replay-agent-session",
  "compare/README.md": "/docs/compare",
  "compare/langfuse.md": "/docs/compare/langfuse",
  "compare/langsmith.md": "/docs/compare/langsmith",
  "compare/braintrust.md": "/docs/compare/braintrust",
  "compare/agentops.md": "/docs/compare/agentops",
  "compare/laminar.md": "/docs/compare/laminar",
  "compare/ccusage.md": "/docs/compare/ccusage",
};

/**
 * Repo docs whose content is on a site page that is not rendered from them:
 * merged into another page (2026-11-11), or written as .astro. A link to one
 * goes to that page, never to GitHub. Its #anchor is dropped: the heading may
 * not exist there.
 */
const ON_SITE: Record<string, string> = {
  "guides/install.md": "/docs/install",
  "guides/agents.md": "/docs/agents",
  "ADAPTERS.md": "/docs/agents",
  "how-to/status-line.md": "/docs/agents",
  "guides/evals.md": "/docs/evals",
  "TOOL-EVALS.md": "/docs/tool-evals",
  "guides/team.md": "/docs/how-to/self-host-team",
  "PRODUCTION.md": "/docs/production",
  "production/README.md": "/docs/production",
  "production/compose.md": "/docs/deploy",
  "production/fly.md": "/docs/deploy",
  "production/railway.md": "/docs/deploy",
  "production/render.md": "/docs/deploy",
  "production/serverless.md": "/docs/deploy",
  "integrations/ai-gateway.md": "/docs/ai-gateway",
  "integrations/eve.md": "/docs/otel",
  "how-to/tee-agent-runs.md": "/docs/otel",
  "use-cases/claude-code-cost.md": "/docs/cost",
  "how-to/expensive-sessions.md": "/docs/cost",
  "use-cases/test-agent-instructions.md": "/docs/how-to/test-agents-md-change",
  "use-cases/evals-from-failures.md": "/docs/how-to/session-to-eval",
  "use-cases/self-hosted-observability.md": "/docs/production",
  "use-cases/t3-code.md": "/docs/agents",
  "use-cases/pi.md": "/docs/agents",
  "use-cases/proxy-model-calls.md": "/docs/how-to/capture-with-proxy",
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
const FENCE = /^```([\w+-]*)[ \t]*(.*)$/;
const OPEN = /^:::(more|note)\b[ \t]*(.*)$/;
const CLOSE = /^:::\s*$/;
const PICTURE = /^!\[([^\]]*)\]\((shot|diagram):([\w./-]+)(?:\s+"([^"]*)")?\)\s*$/;
const splitAt = (file: string, line: string) => SPLITS[file]?.find((s) => line === s.heading)?.path;

/** `tab=TypeScript title="my file.ts" group=lang` → { tab, title, group }. */
function fenceAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) out[m[1]!] = m[2] ?? m[3]!;
  return out;
}

/**
 * A diagram from src/assets/docs/diagrams/<name>.svg, inlined so its strokes
 * and text take the page's colours (currentColor). Throws when the file is
 * missing, so a page never ships without its picture. Pages written as
 * .astro use it with <Fragment set:html={diagram(...)} />.
 */
export function diagram(name: string, alt: string, caption?: string): string {
  const file = join(DIAGRAMS, `${name}.svg`);
  if (!existsSync(file)) throw new Error(`docs: diagram ${name} is missing (src/assets/docs/diagrams/${name}.svg)`);
  const svg = readFileSync(file, "utf8")
    .replace(/<\?xml[\s\S]*?\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace(/<svg\b/, `<svg role="img" aria-label="${esc(alt)}" focusable="false"`)
    .trim();
  return `<figure class="diagram" data-agent-text="${esc(caption ? `${alt} ${caption}` : alt)}">${svg}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
}

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

/** A site path that moved (worker/moved.ts) is linked at its new path, without the old anchor. */
function current(path: string): string {
  const [p, rest] = path.split(/(?=[#?])/) as [string, string | undefined];
  const to = MOVED[p.replace(/(.)\/+$/, "$1")];
  return to ?? `${p}${rest ?? ""}`;
}

/** `here` is the page being rendered: an anchor on another page of a split doc gets that page's path. */
function href(url: string, from: string, here: string): string {
  const site = url.match(/^https:\/\/coding\.sh(\/docs(?:[/#?].*)?)$/);
  if (site) return current(site[1]!);
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
  return docHref(`${target}${anchor}`);
}

/**
 * A repo doc, as a path under docs/ with any #fragment ("reference/cli.md#sessions"),
 * to its site page with the fragment kept, or to the doc on GitHub when it has no site page.
 */
export function docHref(doc: string): string {
  const [target, hash] = doc.split("#") as [string, string | undefined];
  const anchor = hash ? `#${hash}` : "";
  if (target === CLI_DOC && hash) return cliPage(hash) ?? `${GITHUB_DOCS}${target}${anchor}`;
  if (ON_SITE[target]) return ON_SITE[target];
  if (!SITE_PAGES[target]) return `${GITHUB_DOCS}${target}${anchor}`;
  return `${(hash && pageOf(target, hash)) || SITE_PAGES[target]}${anchor}`;
}

/**
 * docs/reference/cli.md has a heading per command, but the site builds /docs/cli
 * from the CLI's own --help (cli-help.ts): each top-level command has a page, with
 * its sub-actions at #cmd-<name>. A heading the site has no place for stays on GitHub.
 */
const CLI_DOC = "reference/cli.md";
let cliHeadings: Map<string, string> | undefined;
function cliPage(id: string): string | undefined {
  if (!cliHeadings) {
    cliHeadings = new Map([
      ["global-options", "/docs/cli#global"],
      ["commands", "/docs/cli#commands"],
    ]);
    for (const line of readFileSync(join(REPO_DOCS, CLI_DOC), "utf8").split("\n")) {
      const cmd = line.match(/^#{2,3} (`coding\.sh ([a-z][\w-]*)((?: [a-z][\w-]*)*)`)$/);
      if (cmd) cliHeadings.set(slug(cmd[1]!), `/docs/cli/${cmd[2]}${cmd[3] ? `#cmd-${cmd[2]}${cmd[3].replace(/ /g, "-")}` : ""}`);
    }
  }
  return cliHeadings.get(id);
}

function inline(text: string, from: string, here: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${href(u.replace(/&amp;/g, "&"), from, here)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/&lt;kbd&gt;([^&<]{1,12})&lt;\/kbd&gt;/g, "<kbd>$1</kbd>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * Parse docs/<file> for the site page `here`. Drops the # title, the lede
 * under it and the "Site version" pointer; the layout has its own. A split doc
 * gives only the part on `here` (see SPLITS).
 */
export function renderDoc(file: string, here: string = SITE_PAGES[file] ?? ""): MdBlock[] {
  return renderMarkdown(readFileSync(join(REPO_DOCS, file), "utf8"), file, here);
}

/** A block being filled: the page itself, or an open :::more / :::note. */
interface Frame {
  kind: "root" | "more" | "note";
  summary: string;
  blocks: MdBlock[];
  html: string;
  line: number;
}

/** Parse Markdown text. `file` is its path under docs/, which relative links resolve against; `here` as for renderDoc. */
export function renderMarkdown(text: string, file: string, here: string = SITE_PAGES[file] ?? ""): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  const stack: Frame[] = [{ kind: "root", summary: "", blocks, html: "", line: 0 }];
  const top = () => stack[stack.length - 1]!;
  let page = SITE_PAGES[file] ?? "";
  const keep = () => !SPLITS[file] || page === here;
  // Inside a container everything is kept with it; at the top, only this page's part.
  const emit = (b: MdBlock) => {
    if (stack.length > 1) top().blocks.push(b);
    else if (keep()) blocks.push(b);
  };
  const flush = () => {
    const f = top();
    if (f.html) emit({ kind: "html", html: f.html });
    f.html = "";
  };
  const add = (html: string) => (top().html += html);
  const isTable = (i: number) => lines[i]?.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? "");
  const listItem = /^(\s*)(-|\d+\.) (.*)$/;
  const uniqueId = headingIds();
  const md = (text: string) => inline(text, file, here);
  // True between the # title and the first block under it: that block, if a paragraph, is the lede.
  let lede = false;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim() || line.startsWith("<!--")) {
      i++;
      continue;
    }
    const atLede = lede;
    lede = false;

    const fence = line.match(FENCE);
    if (fence) {
      const read = (at: number) => {
        const m = lines[at]!.match(FENCE)!;
        const body: string[] = [];
        let j = at + 1;
        for (; j < lines.length && !lines[j]!.startsWith("```"); j++) body.push(lines[j]!);
        const attrs = fenceAttrs(m[2] ?? "");
        const title = attrs.title ?? FENCE_TITLES[m[1]!] ?? (m[1] || "shell");
        return { attrs, title, code: body.join("\n"), end: j + 1 };
      };
      let f = read(i);
      i = f.end;
      flush();
      if (!f.attrs.tab) {
        emit({ kind: "code", code: f.code, title: f.title });
        continue;
      }
      // Consecutive tab= fences, blank lines between them allowed, are one CodeTabs.
      const group = f.attrs.group ?? "lang";
      const tabs: CodeTab[] = [{ label: f.attrs.tab, code: f.code, title: f.title }];
      for (;;) {
        let j = i;
        while (j < lines.length && !lines[j]!.trim()) j++;
        const next = lines[j]?.match(FENCE);
        if (!next || !fenceAttrs(next[2] ?? "").tab) break;
        f = read(j);
        tabs.push({ label: f.attrs.tab!, code: f.code, title: f.title });
        i = f.end;
      }
      emit({ kind: "tabs", group, tabs });
      continue;
    }

    const open = line.match(OPEN);
    if (open) {
      i++;
      flush();
      stack.push({ kind: open[1] as "more" | "note", summary: md(open[2]!.trim()), blocks: [], html: "", line: i });
      if (open[1] === "more" && !open[2]!.trim()) throw new Error(`docs: :::more needs a summary (docs/${file}:${i})`);
      continue;
    }
    if (CLOSE.test(line)) {
      i++;
      if (stack.length === 1) throw new Error(`docs: ::: closes nothing (docs/${file}:${i})`);
      flush();
      const f = stack.pop()!;
      emit(f.kind === "more" ? { kind: "more", summary: f.summary, blocks: f.blocks } : { kind: "note", blocks: f.blocks });
      continue;
    }

    const pic = line.match(PICTURE);
    if (pic) {
      i++;
      flush();
      const [, alt = "", kind, name = "", caption] = pic;
      emit(kind === "shot" ? { kind: "shot", name, alt, caption } : { kind: "diagram", html: diagram(name, alt, caption) });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      i++;
      if (h[1] === "#") {
        lede = true;
        continue;
      }
      const next = splitAt(file, line);
      if (next) {
        flush();
        page = next;
      }
      const tag = `h${h[1]!.length}`;
      add(`<${tag} id="${uniqueId(h[2]!)}">${md(h[2]!)}</${tag}>`);
      continue;
    }
    if (isTable(i)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      add(
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${md(c)}</th>`).join("")}</tr></thead><tbody>` +
          // A cell that is one link becomes a full-cell tap target on touch (.cell-link).
          rows.map((r) => `<tr>${r.map((c) => `<td${/^\[[^\]]+\]\([^)\s]+\)$/.test(c) ? ' class="cell-link"' : ""}>${md(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`,
      );
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
      add(`<${tag}>${items.map((t) => `<li>${md(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(```|#{1,4} |\s*(-|\d+\.) |:::)/.test(lines[i]!) &&
      !PICTURE.test(lines[i]!) &&
      !isTable(i)
    )
      para.push(lines[i++]!.trim());
    const text = para.join(" ").replace(/\s*Site version:\s*\[[^\]]*\]\([^)]*\)\.?/, "").trim();
    // The GitHub lede: the layout prints the nav summary in its place. A
    // "Site version" line on its own is not the lede; the paragraph after it is.
    if (atLede && !text) lede = true;
    if (atLede && !text.endsWith(":")) continue;
    if (text) add(`<p>${md(text)}</p>`);
  }
  if (stack.length > 1) throw new Error(`docs: :::${top().kind} opened at docs/${file}:${top().line} is never closed`);
  flush();
  if (!blocks.length) throw new Error(`docs: nothing in docs/${file} for ${here}; check SPLITS in markdown.ts`);
  return blocks;
}
