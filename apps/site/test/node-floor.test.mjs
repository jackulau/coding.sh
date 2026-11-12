// The Node version the docs and the site ask for is the floor the code needs.
// Node 22.15's SQLite has no FTS5, so the floor is 22.16.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const NODE_FLOOR = "22.16";

/** Node 22.x versions that text asks for, with their lines. */
export function nodeVersions(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(?:\bNode(?:\.js)?\s*(?:>=\s*)?|node-%3E%3D|>=|\b(?=22\.\d+ or newer))(22\.\d+)\+?/g)) found.push({ line: i + 1, version: m[1] });
  });
  return found;
}

function walk(dir, ext) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "research", ".astro"].includes(e.name) ? [] : walk(rel, ext);
    return ext.test(e.name) ? [rel] : [];
  });
}

test("nodeVersions finds the seeded old floor", () => {
  assert.deepEqual(nodeVersions("coding.sh needs Node 22.15 or newer.").map((v) => v.version), ["22.15"]);
  assert.deepEqual(nodeVersions("badge/node-%3E%3D22.15-brightgreen").map((v) => v.version), ["22.15"]);
  assert.deepEqual(nodeVersions("checks Node 22.16+ and Node.js 22.16 or newer").map((v) => v.version), ["22.16", "22.16"]);
});

test("docs, READMEs and the site ask for Node 22.16", () => {
  // ease.md and perf.md report the Node a measurement ran on.
  const measured = ["docs/ease.md", "docs/perf.md"];
  const files = [
    "README.md",
    ...walk("packages", /^README\.md$/).filter((p) => p.split("/").length === 3),
    ...walk("docs", /\.md$/),
    ...walk("apps/site/src", /\.(astro|ts|md|mdx)$/),
  ].filter((f) => !measured.includes(f));
  const problems = files.flatMap((f) => nodeVersions(readFileSync(join(ROOT, f), "utf8")).filter((v) => v.version !== NODE_FLOOR).map((v) => `${f}:${v.line}: Node ${v.version}`));
  assert.deepEqual(problems, []);
});

test("the floor matches engines in packages/coding.sh/package.json", () => {
  const engines = JSON.parse(readFileSync(join(ROOT, "packages/coding.sh/package.json"), "utf8")).engines.node;
  assert.equal(engines, `>=${NODE_FLOOR}`, "release-1 (engines, install.sh, action.yml) is another area's change; this fails until it lands");
});
