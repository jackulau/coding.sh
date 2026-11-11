// The site says AGENTS.md, never Claude Code's own instructions file name.
// Checked where the site's words come from: its source, the docs/ files it
// renders (all of docs/, so nothing leaks in later), CHANGELOG.md, the CLI
// help specs the /docs/cli pages print, and the built site in dist/ when a
// build exists. A sentence that needs the idea says AGENTS.md, or "the
// agent's instructions file" when AGENTS.md would be untrue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BANNED = new RegExp(["claude", "md"].join("\\."), "i");
const TEXT = new Set([".astro", ".ts", ".mjs", ".js", ".md", ".mdx", ".css", ".html", ".txt", ".xml", ".json", ".jsonc", ".svg", ".toml", ".yml", ".yaml", ""]);

/** Text files under dir (relative to the repo root), skipping node_modules and the pagefind index. */
function walk(dir, { skipDist = true } = {}) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "pagefind" || (skipDist && e.name === "dist")) continue;
      out.push(...walk(rel, { skipDist }));
    } else if (TEXT.has(extname(e.name))) out.push(rel);
  }
  return out;
}

/** "file:line: text" for each line that names the banned file. */
function hits(files) {
  const out = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (BANNED.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
    });
  }
  return out;
}

const fail = (where, found) => `${found.length} line(s) in ${where} name Claude Code's instructions file; say AGENTS.md:\n${found.join("\n")}`;

test("the site source says AGENTS.md only", () => {
  const found = hits([...walk("apps/site/src"), ...walk("apps/site/public"), ...walk("apps/site/scripts"), ...walk("apps/site/worker")]);
  assert.deepEqual(found, [], fail("apps/site", found));
});

test("the docs the site renders say AGENTS.md only", () => {
  const found = hits(walk("docs"));
  assert.deepEqual(found, [], fail("docs/", found));
});

test("the changelog says AGENTS.md only", () => {
  const found = hits(["CHANGELOG.md"]);
  assert.deepEqual(found, [], fail("CHANGELOG.md", found));
});

test("the CLI help the /docs/cli pages print says AGENTS.md only", () => {
  const specs = ["packages/coding.sh/src/cli/registry.ts", ...walk("packages/coding.sh/src").filter((f) => f.endsWith("cli-spec.ts"))];
  const found = hits(specs.filter((f) => existsSync(join(ROOT, f))));
  assert.deepEqual(found, [], fail("the CLI help specs", found));
});

test("the built site says AGENTS.md only", distOpts(join(ROOT, "apps/site/dist")), () => {
  needDist(join(ROOT, "apps/site/dist"));
  const found = hits(walk("apps/site/dist", { skipDist: false }));
  assert.deepEqual(found, [], fail("apps/site/dist", found));
});
