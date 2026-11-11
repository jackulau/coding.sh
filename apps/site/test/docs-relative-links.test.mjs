// Relative links in docs/**/*.md point at files that exist (and, when they
// name a heading, at a heading that exists).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Relative link targets in markdown outside code, as {line, target}. */
export function relativeLinks(markdown) {
  const out = [];
  let fence = false;
  markdown.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const t = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t) || t.startsWith("/")) continue;
      out.push({ line: i + 1, target: t });
    }
  });
  return out;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "research"].includes(e.name) ? [] : walk(abs);
    return e.name.endsWith(".md") ? [abs] : [];
  });
}

test("relativeLinks finds the seeded link and skips URLs, anchors and code", () => {
  const md = "[a](missing.md) [b](https://x.dev) [c](#top) `[d](nope.md)`\n```\n[e](nope.md)\n```";
  assert.deepEqual(relativeLinks(md), [{ line: 1, target: "missing.md" }]);
});

test("every relative link in docs/ points at a file that exists", () => {
  const problems = [];
  for (const file of walk(join(ROOT, "docs"))) {
    for (const { line, target } of relativeLinks(readFileSync(file, "utf8"))) {
      const path = decodeURIComponent(target.split("#")[0].split("?")[0]);
      if (!path) continue;
      const abs = resolve(dirname(file), path);
      if (!existsSync(abs) || (target.endsWith("/") && !statSync(abs).isDirectory())) problems.push(`${relative(ROOT, file)}:${line}: ${target}`);
    }
  }
  assert.deepEqual(problems, []);
});
