// Every `coding.sh <command>` in a docs code block names a command in
// packages/coding.sh/src/cli/registry.ts (or one of its aliases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Command names and aliases from the registry. */
async function registryNames() {
  const { COMMANDS } = await import(new URL("../../../packages/coding.sh/src/cli/registry.ts", import.meta.url).href);
  return new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
}

/** The command word of each `coding.sh <word>` call in the lines of fenced shell code blocks. */
export function commandWords(markdown) {
  const out = [];
  let fence = null;
  markdown.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*```(\w*)/);
    if (m) {
      fence = fence === null ? m[1] : null;
      return;
    }
    if (fence === null || !["sh", "bash", "shell", "console", "zsh", ""].includes(fence)) return;
    for (const part of line.replace(/#.*$/, "").split(/&&|\|\||\||;/)) {
      const c = part.match(/^\s*(?:\$ )?(?:[A-Z_]+=\S*\s+)*(?:npx (?:-y )?|npm exec )?(?:coding\.sh|codingsh) +([^\s<>"'$|]+)/);
      if (c && !c[1].startsWith("-") && /^[a-z]/.test(c[1])) out.push({ line: i + 1, word: c[1] });
    }
  });
  return out;
}

function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "research"].includes(e.name) ? [] : walk(rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

test("commandWords finds the seeded npx coding.sh view", () => {
  const md = "```sh\nnpx coding.sh sessions\nnpx coding.sh view\ncoding.sh ui --port 1 && coding.sh doctor\n```\nnpx coding.sh nope";
  assert.deepEqual(commandWords(md).map((c) => c.word), ["sessions", "view", "ui", "doctor"]);
});

test("every coding.sh command in a docs code block exists", async () => {
  const names = await registryNames();
  assert.ok(names.has("ui") && names.has("sessions"), "registry not read");
  const problems = [];
  for (const file of [...walk("docs"), "README.md", ...walk("packages").filter((p) => /\/README\.md$/.test(p) && p.split("/").length === 3)]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (/^Status: design\b/m.test(text)) continue; // a design page may show a command that does not exist yet
    for (const c of commandWords(text)) {
      if (!names.has(c.word)) problems.push(`${file}:${c.line}: coding.sh ${c.word}`);
    }
  }
  assert.deepEqual(problems, [], "These commands are not in src/cli/registry.ts");
});
