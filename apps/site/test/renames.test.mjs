// A renamed product is called by its new name where the copy lists current
// agents. Google replaced Gemini CLI with Antigravity CLI (May 2026); the old
// name may appear only where the line says it is the old one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Old name, the name that replaced it, and the words that mark a line as talking about the old one. */
export const RENAMED = [{ old: /\bGemini CLI\b/, now: "Antigravity CLI", marked: /\b(older|formerly|replaced|replacement|legacy|previous)\b/i }];

/** Lines in text that use a renamed product's old name as if it were current. */
export function findOldNames(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const r of RENAMED) if (r.old.test(line) && !r.marked.test(line)) found.push({ line: i + 1, text: line.trim(), now: r.now });
  });
  return found;
}

function walk(dir, ext) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(rel, ext);
    return ext.test(e.name) ? [rel] : [];
  });
}

test("findOldNames catches the seeded blog line", () => {
  assert.equal(findOldNames("That is the whole install for Claude Code, Codex, Gemini CLI and the rest").length, 1);
  assert.equal(findOldNames("Claude Code, Codex, Antigravity CLI and the rest").length, 0);
  assert.equal(findOldNames("Antigravity CLI replaced Gemini CLI.").length, 0);
});

test("copy that lists current agents says Antigravity CLI, not Gemini CLI", () => {
  const files = [
    ...walk("apps/site/src/content", /\.(md|mdx)$/),
    "apps/site/src/pages/index.astro",
    "README.md",
    ...walk("docs/guides", /\.md$/),
    ...walk("docs/how-to", /\.md$/),
    ...walk("docs/use-cases", /\.md$/),
  ].filter((p) => existsSync(join(ROOT, p)));
  const problems = files.flatMap((f) => findOldNames(readFileSync(join(ROOT, f), "utf8")).map((m) => `${f}:${m.line}: ${m.text.slice(0, 120)} (say ${m.now})`));
  assert.deepEqual(problems, []);
});
