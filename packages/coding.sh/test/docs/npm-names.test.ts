// No page, prompt, doc, skill or CLI hint may send a reader to an npm package we don't publish. The
// package is coding.sh; codingsh is its second bin, not a package. A Windows rule that renames
// coding.sh to codingsh ("type codingsh for coding.sh") turns `npx coding.sh` into `npx codingsh`,
// so each such rule also gives npx's form, `npx -p coding.sh codingsh` (docs/guides/install.md#windows).
//
// It reads the site (apps/site/src and apps/site/public), docs, README.md, CHANGELOG.md, each
// package's README.md, and the skills and src of packages/coding.sh, whose strings are what the
// CLI, the viewer and the MCP server print. The commands the CLI builds are checked for each
// platform and shell.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandsForShell } from "../../src/cli/commands/eval.ts";
import { cliCommand, nextStepBin, runCommand } from "../../src/cli/next-steps.ts";
import { NPM_NAME } from "../../src/update/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Folders read whole, and single files, relative to the repository root. */
const DIRS = ["apps/site/src", "apps/site/public", "docs", "packages/coding.sh/skills", "packages/coding.sh/src"];
const PACKAGES = ["coding.sh", "sdk", "sdk-python", "store-postgres", "store-clickhouse", "blob-s3"];
const FILES = ["README.md", "CHANGELOG.md", ...PACKAGES.map((p) => `packages/${p}/README.md`)];
const TEXT = /\.(?:ts|mts|mjs|js|md|mdx|astro|html|json|txt|ya?ml|toml|py|webmanifest)$|\/_headers$/;

/** npm names that are not ours: codingsh, coding-sh and coding_sh, with any suffix or version, and those scopes. */
const NAME = String.raw`(?:@(?:codingsh|coding-sh|coding_sh)\/[\w.-]+|(?:codingsh|coding-sh|coding_sh)(?!\w)(?:[-_.][\w.-]*)?)(?:@\S*)?`;
/** A flag before the package: -y, --yes, -g, --registry=<url>, a bare --. Not -p or --package, which name the package. */
const FLAG = String.raw`-(?!-?p(?:ackage)?\b)-?(?:[A-Za-z][\w-]*(?:=\S*)?)?`;
/** Commands that fetch the package they name and run it, and commands that install it. */
const RUNNER = String.raw`npx|pnpx|bunx|bun\s+x|npm\s+(?:exec|x)|(?:pnpm|yarn)\s+dlx`;
const INSTALLER = String.raw`npm\s+(?:i|in|install|add)|pnpm\s+(?:add|i|install)|yarn\s+(?:global\s+)?add|bun\s+(?:add|i|install)`;
const FORBIDDEN = String.raw`\b(?:(?:${RUNNER})(?:\s+${FLAG})*\s+(?:(?:-p|--package)(?:=|\s+))?|(?:${INSTALLER})(?:\s+${FLAG})*\s+|npm:)${NAME}`;

/**
 * Rules that rename the CLI as a whole, which a reader applies to `npx coding.sh` too. A line about
 * one command ("type codingsh uninstall for coding.sh uninstall") is not a rule.
 */
const RULES = [
  String.raw`\bcodingsh\s+(?:instead\s+of|in\s+place\s+of|rather\s+than)\s+coding\.sh\b`,
  String.raw`\bcodingsh\s+for\s+(?:an?\s+installed\s+|the\s+|each\s+|every\s+|any\s+)?coding\.sh\b`,
  String.raw`\bcodingsh\s+wherever\b`,
  String.raw`\bcoding\.sh\s+or\s+codingsh\b`,
  String.raw`\bcodingsh\s+or\s+coding\.sh\b`,
  String.raw`\breplace\s+coding\.sh\s+with\s+codingsh\b`,
];
/** npx's form of the codingsh bin. A page may give it as {INSTALL_CMD_WIN} (apps/site/src/data/site.ts). */
const NPX_FORM = /\bnpx (?:-y )?-p coding\.sh(?:@\S+)? codingsh\b|\{INSTALL_CMD_WIN\}/;
/** How close, in characters, a rule's npx form must be. */
const NEAR = 200;

/**
 * Text as a reader sees it: tags and backticks dropped (a tag keeps its newlines, so line numbers
 * hold), a `\n` escape in code read as a space, and runs of spaces and tabs as one space.
 */
function plain(text: string): string {
  return text
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>/g, (tag) => tag.replace(/[^\n]/g, ""))
    .replace(/\\n/g, " ")
    .replace(/\\?`/g, "")
    .replace(/[ \t]+/g, " ");
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split("\n").length;

/** Each place in text that names an npm package we don't publish. */
function forbidden(text: string): { line: number; form: string }[] {
  const p = plain(text);
  return [...p.matchAll(new RegExp(FORBIDDEN, "g"))].map((m) => ({ line: lineOf(p, m.index), form: m[0].replace(/\s+/g, " ") }));
}

/** Each rule in text that renames coding.sh to codingsh with no npx form within NEAR characters. */
function rulesWithoutNpx(text: string): { line: number; rule: string }[] {
  const p = plain(text);
  const out: { line: number; rule: string }[] = [];
  for (const re of RULES) {
    for (const m of p.matchAll(new RegExp(re, "g"))) {
      const near = p.slice(Math.max(0, m.index - NEAR), m.index + m[0].length + NEAR).replace(/\s+/g, " ");
      if (!NPX_FORM.test(near)) out.push({ line: lineOf(p, m.index), rule: m[0].replace(/\s+/g, " ") });
    }
  }
  return out;
}

/** The files the scans read, relative to the repository root, with forward slashes. */
function files(): string[] {
  const out = [...FILES];
  for (const dir of DIRS) {
    for (const e of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      const rel = relative(ROOT, join(e.parentPath, e.name)).replaceAll("\\", "/");
      if (e.isFile() && TEXT.test(rel)) out.push(rel);
    }
  }
  return out;
}

let corpus: { file: string; text: string }[] | undefined;
const read = () => (corpus ??= files().map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") })));

describe("npm names a reader is sent to", () => {
  it("the checks catch each form that names a package we don't publish, and each rule without npx's form", () => {
    const bad = [
      "npx codingsh init",
      "npx coding-sh",
      "npx coding_sh ui",
      "npx -y codingsh@latest init",
      "npx --yes coding-sh",
      "npx -p codingsh codingsh init",
      "npx --package=coding-sh codingsh",
      "npx --registry=https://example.com codingsh",
      "bunx codingsh",
      "bun x codingsh",
      "pnpx codingsh",
      "pnpm dlx codingsh",
      "yarn dlx coding-sh",
      "npm exec codingsh",
      "npm exec -- coding-sh init",
      "npm x codingsh",
      "npm i -g codingsh",
      "npm install codingsh",
      "npm install --global coding-sh",
      "npm add coding_sh",
      "pnpm add -g codingsh",
      "yarn global add codingsh",
      "yarn add coding-sh",
      "bun add -g codingsh",
      "bun install -g coding-sh",
      "npm install coding-sh-store-postgres",
      "npx @codingsh/cli",
      "npm i @coding-sh/sdk",
      "deno run -A npm:codingsh",
      "run `npx codingsh init`",
      "<code>npx</code> <code>codingsh</code>",
      "npx\n  codingsh init",
    ];
    for (const s of bad) assert.equal(forbidden(s).length, 1, s);
    const good = [
      "npx coding.sh init",
      "npx -p coding.sh codingsh init",
      "npx -y -p coding.sh@0.1.7 codingsh --version",
      "npm exec --package=coding.sh -- codingsh init",
      "npm install -g coding.sh",
      "npm i -g coding.sh@0.1.7",
      "npm install -g coding.sh, then codingsh init",
      "pnpm dlx coding.sh init",
      "bunx coding.sh",
      "npm install @codingdotsh/sdk",
      "npm install coding.sh-store-postgres",
      "pip install coding-sh",
      "codingsh alert list --json | ConvertFrom-Json",
      "where.exe codingsh.cmd",
      "codingsh://latest",
      "npx coding-shell",
    ];
    for (const s of good) assert.deepEqual(forbidden(s), [], s);

    // The Windows lines this test was written for: each renamed coding.sh and gave no npx form.
    const rules = [
      "On Windows, in PowerShell or cmd, run codingsh instead of coding.sh.",
      "install with `npm install -g coding.sh` and run\n`codingsh` wherever this page says `coding.sh`",
      "the CLI runs as `coding.sh` or `codingsh`. One tool.",
      "In PowerShell and cmd, type <code>codingsh</code> for <code>coding.sh</code>.",
      "In PowerShell or cmd, the command is `codingsh` instead of `coding.sh`.",
    ];
    for (const s of rules) assert.equal(rulesWithoutNpx(s).length, 1, s);
    const kept = [
      "On Windows, type `npx -p coding.sh codingsh` for `npx coding.sh`, and in PowerShell and cmd, `codingsh` for an installed `coding.sh`.",
      "In PowerShell, type `codingsh uninstall` for `coding.sh uninstall`.",
      "Or {INSTALL_CMD_WIN} on Windows. In PowerShell, type <code>codingsh</code> instead of <code>coding.sh</code>.",
    ];
    for (const s of kept) assert.deepEqual(rulesWithoutNpx(s), [], s);
    assert.equal(rulesWithoutNpx(`npx -p coding.sh codingsh init\n${"word ".repeat(60)}\nIn cmd, type codingsh instead of coding.sh.`).length, 1, "an npx form far from the rule does not count");
  });

  it("no page, doc, README, skill or CLI string names an npm package we don't publish", () => {
    const hits = read().flatMap(({ file, text }) => forbidden(text).map((h) => `${file}:${h.line}: ${h.form}`));
    assert.deepEqual(hits, [], "the npm package is coding.sh; npx runs its codingsh bin as npx -p coding.sh codingsh");
  });

  it("each rule that renames coding.sh to codingsh gives npx's form, npx -p coding.sh codingsh, next to it", () => {
    const hits = read().flatMap(({ file, text }) => rulesWithoutNpx(text).map((h) => `${file}:${h.line}: ${h.rule}`));
    assert.deepEqual(hits, [], `name npx -p coding.sh codingsh within ${NEAR} characters of each rule, or a reader turns npx coding.sh into npx codingsh`);
  });

  it("the commands the CLI builds name the package coding.sh, in every shell", () => {
    assert.equal(NPM_NAME, "coding.sh");
    const note = "then coding.sh eval validate <task>, or npx coding.sh init, npx -p coding.sh init and pnpm dlx coding.sh doctor";
    const envs: NodeJS.ProcessEnv[] = [{}, { npm_command: "exec" }, { MSYSTEM: "MINGW64" }, { SHELL: "/usr/bin/bash" }, { npm_command: "exec", MSYSTEM: "MINGW64" }];
    for (const platform of ["win32", "linux", "darwin"] as const) {
      for (const env of envs) {
        const where = `${platform} ${JSON.stringify(env)}`;
        for (const line of [nextStepBin(env, platform), cliCommand(env, ["init", "--yes"], platform), runCommand(env, "claude", platform), commandsForShell(note, env, platform)]) {
          assert.deepEqual(forbidden(line), [], `${where}: ${line}`);
        }
        if (env.npm_command === "exec") assert.equal(nextStepBin(env, platform), platform === "win32" ? "npx -p coding.sh codingsh" : "npx coding.sh", where);
      }
    }
  });
});
