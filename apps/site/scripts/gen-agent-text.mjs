// Post-build: emit plain-text copies of every rendered page for LLM agents.
//
// For each dist/**/index.html we write a sibling <route>.md holding the page's
// <main> content as Markdown, then concatenate all of them into llms-full.txt.
// Deriving from the built HTML (rather than a parallel source of truth) means
// the text can never disagree with what a browser renders.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentExcluded } from "../src/lib/agent-routes.mjs";
import { pageLastmod } from "../src/lib/lastmod.mjs";
import { TRANSLATED_PATHS } from "../src/i18n/locales.mjs";

// `--dist <dir>` writes into another copy of dist.
const distArg = process.argv.indexOf("--dist");
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]) : fileURLToPath(new URL("../dist", import.meta.url));
const SITE = "https://coding.sh";

// Per-version changelog pages and per-command CLI pages stay out of llms-full.txt:
// each has its own twin, and /changelog and /docs/cli link them. So do the front page's
// translations (/zh, /ja, ...): the English home page is in it, and each has its own twin.
const NOT_IN_FULL = [/^\/changelog\/v/, /^\/docs\/cli\//, ...TRANSLATED_PATHS.map((p) => new RegExp(`^${p}$`))];

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  times: "×", deg: "°", copy: "©", reg: "®", trade: "™",
};

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

const inline = (html) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// Any tag that starts a new line of prose. Everything else (span, strong, em,
// code, a, time, ...) is inline and folds into the surrounding line — which is
// what keeps "Software Engineering Intern @ Claimable" one sentence instead of
// three orphaned fragments.
const BLOCK_TAGS =
  "address|article|aside|blockquote|details|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul";

const SEP = "\u0000";

// Code keeps its whitespace; a fence longer than any backtick run inside it.
const fence = (code, lang = "text") => {
  const text = code.replace(/^\n/, "").replace(/\s+$/, "");
  const ticks = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((m) => m.length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

// A code block's title bar names a shell, a language or a file. The fence gets
// the language; a title that is only a language word is not repeated as a line.
const LANGS = {
  shell: "sh", sh: "sh", bash: "sh", output: "text", text: "text",
  typescript: "ts", ts: "ts", javascript: "js", js: "js", mjs: "js", json: "json",
  python: "python", py: "python", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", markdown: "markdown", md: "markdown",
};
function codeLang(title) {
  const t = title.trim().toLowerCase();
  if (LANGS[t]) return { lang: LANGS[t], caption: "" };
  const ext = [...t.matchAll(/\.([a-z]+)\b/g)].map((m) => m[1]).reverse().find((e) => LANGS[e]);
  return { lang: LANGS[ext] ?? "text", caption: title.trim() };
}

// A <table> as a Markdown table: first row is the header.
function table(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => inline(c[2]).replace(/\|/g, "\\|")),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/**
 * Replace every element whose opening tag matches `open` (including its
 * children) with `replace(openingTag)`. Regex can't match balanced tags, so
 * walk forward counting same-name opens and closes until the subtree closes.
 */
function replaceSubtrees(html, open, replace) {
  let s = html;
  for (let match, from = 0; (match = s.slice(from).match(open)); ) {
    const tag = match[1];
    const start = from + match.index;
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
    tagRe.lastIndex = start;
    let depth = 0;
    let end = s.length;
    for (let t; (t = tagRe.exec(s)); ) {
      if (t[1] === "/") {
        if (--depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      } else if (t[2] !== "/") {
        depth++;
      } else if (depth === 0) {
        end = t.index + t[0].length; // self-closing root
        break;
      }
    }
    const out = replace(match[0]);
    s = s.slice(0, start) + out + s.slice(end);
    from = start + out.length;
  }
  return s;
}

/** Remove every element marked `data-agent-skip`, including its children. */
const dropSkipped = (html) => replaceSubtrees(html, /<([a-z][\w-]*)\b[^>]*\bdata-agent-skip\b[^>]*>/i, () => "");

/**
 * A Steps list (<ol class="steps">, Steps.astro) draws its numbers with a CSS
 * counter, so the text has none: write each step's number into the heading
 * that opens it ("### 1. Install").
 */
function numberSteps(html) {
  const lists = [];
  let n = 0;
  return html.replace(/<(\/?)(ol|ul|li|h[2-6])\b[^>]*>/gi, (tag, close, name) => {
    name = name.toLowerCase();
    if (name === "ol" || name === "ul") {
      if (close) lists.pop();
      else lists.push({ steps: name === "ol" && /\bclass="[^"]*\bsteps\b/.test(tag), n: 0 });
      n = 0;
    } else if (name === "li") {
      const list = lists[lists.length - 1];
      n = !close && list?.steps ? ++list.n : 0;
    } else if (!close && n) {
      tag += `${n}. `;
      n = 0;
    }
    return tag;
  });
}

/** Turn a rendered <main> into Markdown-ish plain text. */
function htmlToMarkdown(html) {
  let s = numberSteps(dropSkipped(html));
  // A visual whose words don't read in order (a big "64 → 79" score) can say
  // what it means with data-agent-text; that text replaces the whole element.
  s = replaceSubtrees(s, /<([a-z][\w-]*)\b[^>]*\bdata-agent-text="([^"]*)"[^>]*>/i, (tag) =>
    ` ${tag.match(/\bdata-agent-text="([^"]*)"/i)[1]} `,
  );

  // <pre> and <table> would not survive the whitespace collapse below, so lift
  // them out as placeholders and put them back as Markdown at the end.
  const kept = [];
  const keep = (md) => (md ? `${SEP}\u0001${kept.push(md) - 1}\u0001${SEP}` : SEP);
  // A Code block's title bar (its button and status are data-agent-skip) sits
  // right before its <pre>; a terminal or a bare <pre> is plain text.
  const codeBlock = /(?:<span\b[^>]*\bclass="[^"]*\bcode__title\b[^"]*"[^>]*>([^<]*)<\/span>((?:\s|<\/div>)*))?<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
  s = s.replace(codeBlock, (_, title, between, code) => {
    const { lang, caption } = title === undefined ? { lang: "text", caption: "" } : codeLang(decode(title));
    const text = code
      .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/gi, "") // decorative prompts
      .replace(/<(?:span|div)\b[^>]*class="[^"]*__line\b[^"]*"[^>]*>/gi, "\n") // one element per line
      .replace(/<[^>]+>/g, "");
    // The caption stays HTML until the final decode, like the text around it.
    return `${caption ? title : ""}${between ?? ""}${keep(fence(decode(text), lang))}`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code.replace(/<[^>]+>/g, "")}\``);

  // Drop anything that carries no readable prose.
  s = s.replace(/<(script|style|svg|canvas|template|noscript)\b[\s\S]*?<\/\1>/gi, "");
  // Balanced, so a hidden <div> with nested <div>s goes whole, not up to its
  // first inner </div>.
  s = replaceSubtrees(s, /<([a-z][\w-]*)\b[^>]*\baria-hidden="true"[^>]*>/i, () => "");

  // Heading self-links (#id) are navigation, not content.
  s = s.replace(/<a\b[^>]*class="h-anchor"[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // Absolutise links before tags are stripped, so agents get followable URLs.
  s = s.replace(/<a\b([^>]*)href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, attrs, href, text) => {
    const label = inline(text);
    if (!label) return "";
    const url = href.startsWith("/") ? SITE + href : href;
    // A card (Cards.astro) is a title and a line about it: "[Title](url): body".
    if (/\bclass="card"/.test(attrs + _)) {
      const title = inline(text.match(/<span\b[^>]*class="card__title"[^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*class="card__body"/i)?.[1] ?? "");
      const body = inline(text.match(/<span\b[^>]*class="card__body"[^>]*>([\s\S]*)<\/span>/i)?.[1] ?? "");
      if (title) return `[${title}](${url})${body ? `: ${body}` : ""}`;
    }
    const md = /^(https?:|mailto:)/.test(url) ? `[${label}](${url})` : label;
    // An anchor wrapping block content (a card, a list row) is its own line;
    // an anchor inside a sentence stays inline.
    return new RegExp(`<(?:${BLOCK_TAGS})\\b`, "i").test(text) ? `${SEP}${md}${SEP}` : md;
  });

  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => keep(table(t)));

  // An image with its URL, so the Markdown is valid and the picture can be fetched.
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = decode(tag.match(/\balt="([^"]*)"/i)?.[1] ?? "").trim();
    const src = tag.match(/\bsrc="([^"]+)"/i)?.[1];
    if (!alt) return " ";
    return src ? ` ![${alt}](${src.startsWith("/") ? SITE + src : src}) ` : ` Screenshot: ${alt} `;
  });
  s = s.replace(/<br\s*\/?>/gi, `${SEP}`);

  // Mark the blocks that carry a Markdown prefix, then treat every other block
  // element as a plain line break.
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `${SEP}${"#".repeat(Number(n))} `);
  s = s.replace(/<li\b[^>]*>/gi, `${SEP}- `);
  s = s.replace(/<blockquote\b[^>]*>/gi, `${SEP}> `);
  s = s.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), `${SEP}`);
  s = s.replace(/<[^>]+>/g, "");

  const lines = [];
  for (const raw of decode(s).split(SEP)) {
    const text = raw.replace(/\s+/g, " ").trim();
    const held = text.match(/^\u0001(\d+)\u0001$/);
    if (held) {
      lines.push(kept[Number(held[1])]);
      continue;
    }
    if (!text || text === "-" || /^#+$/.test(text) || text === ">") continue;
    // Repeated labels (hover twins, duplicated card faces) add nothing.
    if (lines[lines.length - 1] === text) continue;
    lines.push(text);
  }
  // Consecutive list items form one tight list.
  return lines.reduce((md, line, i) => md + (i === 0 ? "" : line.startsWith("- ") && lines[i - 1].startsWith("- ") ? "\n" : "\n\n") + line, "");
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === "index.html") yield full;
  }
}

const pages = [];
for await (const file of walk(DIST)) {
  const route = "/" + relative(DIST, dirname(file)).replace(/\\/g, "/");
  const path = route === "/." ? "/" : route;
  if (isAgentExcluded(path)) continue;

  const html = await readFile(file, "utf8");
  const title = inline(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? path);
  const description = decode(
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? "",
  );
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) continue;

  const body = htmlToMarkdown(main);
  if (!body) continue;

  pages.push({ path, title, description, body });
}

// Home first, then shortest paths first — mirrors how a reader would traverse.
pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));

for (const page of pages) {
  const mdPath = page.path === "/" ? "/index.md" : `${page.path}.md`;
  const human = `${SITE}${page.path}`;
  // Same keys as src/lib/agent-docs.ts frontmatter().
  const md = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `canonical: ${human}`,
    `human_url: ${human}`,
    `markdown_url: ${SITE}${mdPath}`,
    `agents_url: ${SITE}/agents.md`,
    `llms_url: ${SITE}/llms.txt`,
    // The sitemap's <lastmod> for the page: the last commit to its sources.
    `updated: ${pageLastmod(page.path).slice(0, 10)}`,
    "---",
    "",
    page.body,
    "",
    `To set coding.sh up for a user, follow the agent workflow at [/agents.md](${SITE}/agents.md).`,
    "",
  ].join("\n");
  const out = join(DIST, mdPath.slice(1));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, md, "utf8");
}

const full = `# coding.sh — full text

Every page of coding.sh as plain text, for LLMs and agents, except one page per changelog version
(/changelog/v*), one per CLI command (/docs/cli/<command>) and the home page's translations
(${TRANSLATED_PATHS.join(", ")}). Each of those has its own Markdown copy at <page>.md; start from
${SITE}/changelog.md and ${SITE}/docs/cli.md.
Index: ${SITE}/llms.txt

${pages
  .filter((p) => !NOT_IN_FULL.some((re) => re.test(p.path)))
  .map((p) => `---\n\n# ${p.title}\nURL: ${SITE}${p.path}\n\n${p.body}`)
  .join("\n\n")}
`;
await writeFile(join(DIST, "llms-full.txt"), full, "utf8");

console.log(`agent text: ${pages.length} markdown pages + llms-full.txt (${Buffer.byteLength(full)} bytes)`);
