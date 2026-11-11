// The site explains coding.sh by what it does, never by comparing it with other
// products ("a local LangSmith", "like Braintrust, but on your machine", "an
// alternative to Langfuse"). Other products' names appear only on the compare
// pages, in internal design and research notes, and where they are an
// integration the reader uses (an OTel exporter, a reporter, a status line).
// It also never leads with stacked category words ("open-source, local-first
// observability and evals for any AI agent. Coding agents first-class."): a reader
// learns what it records and what they do with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT = new Set([".astro", ".ts", ".mjs", ".js", ".md", ".mdx", ".html", ".txt", ".xml", ".json", ".jsonc", ".svg", ".toml", ".yml", ".yaml", ""]);

const NAMES = ["langsmith", "braintrust", "judgment ?labs", "langfuse", "laminar", "agentops", "ccusage", "arize", "phoenix", "weave", "galileo", "honeyhive", "helicone", "datadog"];
const NAME = `(?:${NAMES.join("|")})`;
// A sentence that sets coding.sh against, or explains it through, another product.
const PITCH = new RegExp(
  [
    `\\bthink of (?:it as )?(?:a|an)\\b`,
    `\\b(?:a|an) (?:local|open[- ]source|self[- ]hosted|offline) ${NAME}`,
    `\\blike ${NAME}`,
    `\\b${NAME}[^.\\n]{0,40}\\bbut (?:local|on your (?:machine|disk|laptop))`,
    `\\balternative (?:to|for) ${NAME}`,
    `\\b(?:different|differs) from ${NAME}`,
    `\\bhow (?:it|coding\\.sh) compares with`,
  ].join("|"),
  "i",
);
// Competitor names in the site's words: allowed only in these places, each for a reason.
const NAMED = new RegExp(`\\b(?:langsmith|braintrust|judgment ?labs|langfuse|laminar|agentops|ccusage)\\b`, "i");
const ALLOW = [
  [/^docs\/compare\//, "the compare pages"],
  [/^apps\/site\/src\/pages\/docs\/compare/, "the compare pages"],
  [/^apps\/site\/src\/data\/compare\.ts$/, "the compare pages' data"],
  [/^docs\/(?:research|design)\//, "internal research and design notes, with sources"],
  [/^apps\/site\/src\/pages\/docs\/otel\.astro$/, "LangSmith's OTel exporter is a way to send traces in"],
  [/^docs\/how-to\/trace-durable-workflow\.md$/, "LangSmith's OTel-only mode is a way to send traces in"],
  [/^docs\/integrations\/eve\.md$/, "eve's Braintrust reporter names its scores"],
  [/^docs\/troubleshooting\.md$/, "an existing ccusage status line the installer keeps"],
];
// A line that only links or labels a compare page.
const COMPARE_LINK = /\/docs\/compare|compare\/(?:langfuse|langsmith|braintrust|agentops|laminar|ccusage)|"vs [A-Z]|label: "vs /;

function walk(dir, { skipDist = true } = {}) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, e.name).split("\\").join("/");
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "pagefind" || (skipDist && e.name === "dist")) continue;
      out.push(...walk(rel, { skipDist }));
    } else if (TEXT.has(extname(e.name))) out.push(rel);
  }
  return out;
}

function lines(files, match) {
  const out = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => {
      if (match(f, l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
    });
  }
  return out;
}

const SITE_WORDS = () => [
  ...walk("apps/site/src"),
  ...walk("apps/site/public"),
  ...walk("docs"),
  "CHANGELOG.md",
  "README.md",
  ...["packages/coding.sh", "packages/sdk", "packages/sdk-python", "packages/store-postgres", "packages/store-clickhouse", "packages/blob-s3"].flatMap((p) => [`${p}/README.md`, `${p}/package.json`]),
  "packages/coding.sh/src/cli/registry.ts",
  "packages/coding.sh/src/cli/main.ts",
].filter((f) => existsSync(join(ROOT, f)));

test("no page explains coding.sh by comparing it with another product", () => {
  const found = lines(SITE_WORDS(), (f, l) => !/^docs\/(?:research|design|compare)\//.test(f) && !/pages\/docs\/compare/.test(f) && !COMPARE_LINK.test(l) && PITCH.test(l));
  assert.deepEqual(found, [], `${found.length} line(s) pitch coding.sh through another product; say what it does instead:\n${found.join("\n")}`);
});

test("other products are named only on the compare pages and where they are an integration", () => {
  const found = lines(SITE_WORDS(), (f, l) => NAMED.test(l) && !COMPARE_LINK.test(l) && !ALLOW.some(([re]) => re.test(f)));
  assert.deepEqual(found, [], `${found.length} line(s) name another product outside the compare pages; describe coding.sh by what it does, or add the file to ALLOW with the reason:\n${found.join("\n")}`);
});

test("the built site pitches nothing through another product", { skip: !existsSync(join(ROOT, "apps/site/dist")) && "no build in apps/site/dist" }, () => {
  const files = walk("apps/site/dist", { skipDist: false }).filter((f) => !/\/docs\/compare/.test(f));
  const found = [];
  for (const f of files) {
    // llms-full.txt joins every page; each starts with a "URL:" line, and the compare pages may name products.
    let page = "";
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => {
      const url = /^URL: (\S+)/.exec(l);
      if (url) page = url[1];
      if (/\/docs\/compare/.test(page)) return;
      // A built page is often one long line: check each block (item, paragraph, row) on its own.
      for (const block of l.split(/<\/?(?:li|p|tr|td|th|h\d|dt|dd|summary|div|nav|footer|header|section|main|body|html|ul|ol|table)\b[^>]*>/)) {
        if (COMPARE_LINK.test(block)) continue;
        if (PITCH.test(block.replace(/<[^>]+>/g, " "))) found.push(`${f}:${i + 1}: ${block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`);
      }
    });
  }
  assert.deepEqual(found, [], `${found.length} built line(s) pitch coding.sh through another product:\n${found.join("\n")}`);
});

// Category words stacked in place of saying what coding.sh does. A page title may keep "observability" as a search label.
const CATEGORY = /local-first (?:observability|traces)|\bfirst-class\b|\b(?:observability|traces) and evals for\b/i;
const TITLE_LINE = /\b(?:title|metaTitle)\s*[=:]|<title>/;

test("no page describes coding.sh with stacked category words", () => {
  const found = lines(SITE_WORDS(), (f, l) => !/^docs\/(?:research|design)\/|^CHANGELOG\.md$/.test(f) && !TITLE_LINE.test(l) && CATEGORY.test(l));
  assert.deepEqual(found, [], `${found.length} line(s) describe coding.sh with category words; say what it records and what the reader does with it:\n${found.join("\n")}`);
});

test("the pitch check catches the sentences it was written for", () => {
  for (const bad of [
    "Think of a local LangSmith, Braintrust or Judgment Labs: traces and evals stay on your disk",
    "Open-source observability and evals for AI agents: like LangSmith, Braintrust or Judgment Labs, but on your machine.",
    "How is this different from LangSmith, Braintrust or Judgment Labs?",
    "How it compares with Langfuse, LangSmith and others",
    "An open-source alternative to Langfuse.",
  ]) assert.ok(PITCH.test(bad), bad);
  for (const bad of [
    "coding.sh is open-source, local-first observability and evals for any AI agent. Coding agents first-class.",
    "Docs for coding.sh, open-source observability and evals for AI agents",
    "Local-first traces and evals for AI agents.",
  ]) assert.ok(CATEGORY.test(bad), bad);
  assert.ok(!CATEGORY.test("coding.sh records what your AI agents do: every prompt, model call, tool call, file change and what it cost."));
  for (const ok of [
    "coding.sh records what your AI agents do: every prompt, model call, tool call, file change and what it cost.",
    "Or use LangSmith's OTel exporter: pip install langsmith[otel]",
  ]) assert.ok(!PITCH.test(ok), ok);
});
