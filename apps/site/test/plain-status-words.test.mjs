// An adapter's status is said in plain words. "Not run live" tells a reader
// what is true; the test-jargon label it replaced did not. Checked in the
// READMEs, docs/, CHANGELOG.md, the issue forms, the site source, and the
// built site in dist/ when a build exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BANNED = new RegExp(["fixture", "tested"].join("[- ]"), "i");
const TEXT = new Set([".astro", ".ts", ".mjs", ".js", ".md", ".mdx", ".html", ".txt", ".xml", ".json", ".yml", ".yaml"]);

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

/** "file:line: text" for each line that uses the label. */
function hits(files) {
  const out = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => {
      if (BANNED.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
    });
  }
  return out;
}

const fail = (found) => `${found.length} line(s) use the test-jargon label; say "Not run live" or what is true:\n${found.join("\n")}`;

test("the READMEs, docs, changelog and issue forms say an adapter's status in plain words", () => {
  const found = hits(["README.md", "packages/coding.sh/README.md", "CHANGELOG.md", ...walk("docs"), ...walk(".github/ISSUE_TEMPLATE")]);
  assert.deepEqual(found, [], fail(found));
});

test("the site source says an adapter's status in plain words", () => {
  const found = hits([...walk("apps/site/src"), ...walk("apps/site/public")]);
  assert.deepEqual(found, [], fail(found));
});

test("the built site says an adapter's status in plain words", { skip: !existsSync(join(ROOT, "apps/site/dist")) && "no build in apps/site/dist" }, () => {
  const found = hits(walk("apps/site/dist", { skipDist: false }));
  assert.deepEqual(found, [], fail(found));
});
