// Prose does not use a spaced em dash as a flourish. Use a period, a comma or
// a colon. Table cells that are only a dash, code and comments are left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A word, number or closing mark, a spaced em dash, then more text. */
const FLOURISH = /[\p{L}\p{N}`)”"'.,;:*_] — \S/u;
/** The dash the CLI prints for a value that is not there, in pasted output: `area — → d7a4…`, `cost — (none)`. */
const NO_VALUE = / — (?=→|\(none\))/g;

/** Lines of prose in text that use a spaced em dash. */
export function findEmDashes(text) {
  const found = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    const t = line.trim();
    if (fence || t.startsWith("|") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return;
    if (FLOURISH.test(line.replace(NO_VALUE, " "))) found.push({ line: i + 1, text: t });
  });
  return found;
}

function walk(dir, ext) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "research"].includes(e.name) ? [] : walk(rel, ext);
    return ext.test(e.name) ? [rel] : [];
  });
}

test("findEmDashes catches the seeded flourish and leaves table dashes", () => {
  assert.equal(findEmDashes("“coding shell” — the .sh is a shell script.").length, 1);
  assert.equal(findEmDashes("runs tests, stages a commit, starts a server — all of it").length, 1);
  assert.equal(findEmDashes("| Aider | None | — | — |").length, 0);
  assert.equal(findEmDashes("```\na — b\n```").length, 0);
  assert.equal(findEmDashes("grader  area — → d7a4f11c4da2 (new)").length, 0, "the CLI's dash for no value");
  assert.equal(findEmDashes("tokens 450 · cost — (none) · wall 5.7s").length, 0, "the CLI's dash for no value");
  assert.equal(findEmDashes("it costs nothing — (almost) all of it runs locally").length, 1);
});

test("site copy, the README and the docs guides have no spaced em dash", () => {
  const files = [
    ...walk("apps/site/src", /\.(astro|ts|md|mdx)$/),
    "README.md",
    ...walk("packages", /^README\.md$/).filter((p) => p.split("/").length === 3),
    ...walk("docs/guides", /\.md$/),
    ...walk("docs/how-to", /\.md$/),
    ...walk("docs/use-cases", /\.md$/),
  ].filter((p) => existsSync(join(ROOT, p)));
  const problems = files.flatMap((f) => findEmDashes(readFileSync(join(ROOT, f), "utf8")).map((m) => `${f}:${m.line}: ${m.text.slice(0, 120)}`));
  assert.deepEqual(problems, []);
});
