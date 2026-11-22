// In PowerShell and cmd, `coding.sh` opens npm's sh script of that name instead of running the
// CLI, and npx runs its command through cmd from any shell (docs/guides/install.md#windows). So a
// page that gives `npx coding.sh` also names `npx -p coding.sh codingsh`, and a page that deletes
// the data folder with rm -rf also gives the PowerShell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** The files under dir, as paths from the repo root, research notes left out. */
const files = (dir) =>
  readdirSync(join(ROOT, dir), { recursive: true })
    .map((f) => `${dir}/${f.replaceAll("\\", "/")}`)
    .filter((f) => !f.includes("/research/"));

/** The docs, the READMEs and the site's pages: where a reader copies a command from. */
const PAGES = [
  ...files("docs").filter((f) => f.endsWith(".md")),
  "README.md",
  ...readdirSync(join(ROOT, "packages"))
    .map((p) => `packages/${p}/README.md`)
    .filter((f) => existsSync(join(ROOT, f))),
  ...files("apps/site/src/pages").filter((f) => f.endsWith(".astro")),
];

const NPX = /\bnpx (-y )?coding\.sh(?![\w.-])/;
const WIN = /\bnpx (-y )?-p coding\.sh(@\S+)? codingsh\b|\{INSTALL_CMD_WIN\}/;

/** The lines of markdown's code blocks, shell comments left out, as [line number, text]. */
function codeLines(md) {
  let inside = false;
  return md.split("\n").flatMap((line, i) => {
    if (/^\s*```/.test(line)) return (inside = !inside), [];
    return inside ? [[i + 1, line.replace(/#.*$/, "")]] : [];
  });
}

/**
 * The line numbers where a page runs `npx coding.sh`: in markdown, the lines of its code blocks;
 * in an .astro page, any line, as its samples sit in strings and props.
 */
export function npxLines(path, text) {
  const lines = path.endsWith(".md") ? codeLines(text) : text.split("\n").map((l, i) => [i + 1, l]);
  return lines.filter(([, l]) => NPX.test(l)).map(([n]) => n);
}

test("npxLines finds npx coding.sh in code, not in prose, a comment or the Windows form", () => {
  const md = [
    "Run `npx coding.sh` first.",
    "```sh",
    "npx coding.sh collector   # Windows: npx -p coding.sh codingsh collector",
    "npx -y coding.sh@1.2.3 --version",
    "npx -p coding.sh codingsh ui",
    "# npx coding.sh sessions",
    "```",
  ].join("\n");
  assert.deepEqual(npxLines("a.md", md), [3, 4]);
  assert.deepEqual(npxLines("a.astro", 'const a = { code: "npx coding.sh init" };\nconst b = "npx -p coding.sh codingsh init";'), [1]);
  assert.ok(WIN.test("npx -y -p coding.sh@1.2.3 codingsh --version") && !WIN.test("npx coding.sh ui"));
});

test("a page that runs npx coding.sh names the Windows form, npx -p coding.sh codingsh", () => {
  assert.ok(PAGES.includes("docs/guides/install.md") && PAGES.includes("apps/site/src/pages/docs/install.astro"), "pages not read");
  const missing = PAGES.flatMap((f) => {
    const text = read(f);
    return WIN.test(text) ? [] : npxLines(f, text).map((n) => `${f}:${n}`);
  });
  assert.deepEqual(missing, []);
});

test("a page that deletes the data folder with rm -rf gives the PowerShell line too", () => {
  const rm = /rm -rf ~\/\.coding\.sh(?![\w./-])/;
  const pages = PAGES.filter((f) => rm.test(read(f)));
  assert.ok(pages.includes("docs/guides/install.md"), "the install guide no longer deletes ~/.coding.sh");
  assert.deepEqual(pages.filter((f) => !read(f).includes("Remove-Item -Recurse -Force ~\\.coding.sh")), []);
});
