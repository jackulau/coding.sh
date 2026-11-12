// Copy says what coding.sh records. It never describes the product as "a
// local X", "a local CLI for coding agents" or "like X". Comparison pages
// (docs/compare) and integration pages may name other products.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Phrases that pitch coding.sh by category or by another product. */
export const BANNED = [
  /\ba local (?:CLI|tool|app|platform|tracer|observability)\b/i,
  /\bCLI for coding agents\b/i,
  /\b(?:think of|like|alternative to|but local)\b[^.\n]{0,20}\b(?:a local )?(?:LangSmith|Langfuse|Braintrust|Judgment Labs|AgentOps|Laminar)\b/i,
  /\ba local (?:LangSmith|Langfuse|Braintrust|Judgment Labs)\b/i,
];

/** Lines that may match. Each must still match a file, so a stale entry fails. */
export const ALLOW = [
  // { file, text, reason }
];

/** Banned phrases in text, with their line numbers. */
export function findPitch(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    if (BANNED.some((re) => re.test(line))) found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

function walk(dir, keep) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "dist", "research", "compare", "integrations"].includes(e.name)) out.push(...walk(rel, keep));
    } else if (keep(rel)) out.push(rel);
  }
  return out;
}

/** Site copy, the READMEs and the docs, except the comparison and integration pages. */
function files() {
  const site = walk("apps/site/src", (p) => /\.(astro|ts|md)$/.test(p));
  const docs = walk("docs", (p) => p.endsWith(".md"));
  const readmes = ["README.md", ...readdirSync(join(ROOT, "packages")).map((d) => join("packages", d, "README.md"))];
  return [...site, ...docs, ...readmes].filter((p) => existsSync(join(ROOT, p)));
}

test("findPitch catches the seeded strings from the finding", () => {
  assert.equal(findPitch("coding.sh is a local CLI for coding agents and evals.").length, 1);
  assert.equal(findPitch("Think of a local LangSmith, Braintrust or Judgment Labs").length, 1);
  assert.equal(findPitch("coding.sh records prompts, model calls, tool calls, file changes and cost on your machine.").length, 0);
});

test("no copy pitches coding.sh as a local X or a CLI for coding agents", () => {
  const problems = [];
  for (const file of files()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of findPitch(text)) {
      if (ALLOW.some((a) => a.file === file && m.text.includes(a.text))) continue;
      problems.push(`${relative(ROOT, join(ROOT, file))}:${m.line}: ${m.text.slice(0, 140)}`);
    }
  }
  assert.deepEqual(problems, [], `Say what coding.sh records instead:\n${problems.join("\n")}`);
});

test("every ALLOW entry still matches a line", () => {
  for (const a of ALLOW) {
    const text = existsSync(join(ROOT, a.file)) ? readFileSync(join(ROOT, a.file), "utf8") : "";
    assert.ok(findPitch(text).some((m) => m.text.includes(a.text)), `stale allow: ${a.file}: ${a.text} (${a.reason})`);
  }
});
