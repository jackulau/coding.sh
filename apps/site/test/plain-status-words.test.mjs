// An adapter's status is said in plain words. "Not run live" tells a reader
// what is true; the test-jargon label it replaced did not. Checked in the
// READMEs, docs/, CHANGELOG.md, the issue forms, the site source, and the
// built site in dist/ when a build exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

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

/** "file:line: text" for each line that uses the label. Paths are relative to root. */
function hits(files, root = ROOT) {
  const out = [];
  for (const f of files) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((l, i) => {
      if (BANNED.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
    });
  }
  return out;
}

const fail = (found) => `${found.length} line(s) use the test-jargon label; say "Not run live" or what is true:\n${found.join("\n")}`;

/** Every packages/<name>/README.md. */
const packageReadmes = () => readdirSync(join(ROOT, "packages")).map((d) => join("packages", d, "README.md")).filter((p) => existsSync(join(ROOT, p)));

/** The CLI's own help text: the registry, every command-spec file and the commands that print adapter status. */
function cliFiles() {
  const src = "packages/coding.sh/src";
  const specs = walk(src).filter((f) => f.endsWith("cli-spec.ts"));
  const status = ["agents", "doctor", "status"].map((n) => `${src}/cli/commands/${n}.ts`).filter((p) => existsSync(join(ROOT, p)));
  return [`${src}/cli/registry.ts`, ...specs, ...status];
}

test("the READMEs, docs, changelog, issue forms and site scripts say an adapter's status in plain words", () => {
  const found = hits([
    "README.md",
    ...packageReadmes(),
    "CHANGELOG.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ...walk("docs"),
    ...walk(".github/ISSUE_TEMPLATE"),
    ...walk("apps/site/scripts"),
  ].filter((p) => existsSync(join(ROOT, p))));
  assert.deepEqual(found, [], fail(found));
});

test("the CLI's help and status text says an adapter's status in plain words", () => {
  const found = hits(cliFiles());
  assert.deepEqual(found, [], fail(found));
});

test("a file that uses the label is reported (seeded)", () => {
  const dir = mkdtempSync(join(tmpdir(), "psw-"));
  writeFileSync(join(dir, "help.ts"), `const x = "ok";\nconst s = "${["fixture", "tested"].join("-")}";\n`);
  assert.equal(hits(["help.ts"], dir).length, 1);
  assert.match(hits(["help.ts"], dir)[0], /help\.ts:2:/);
});

test("the site source says an adapter's status in plain words", () => {
  const found = hits([...walk("apps/site/src"), ...walk("apps/site/public")]);
  assert.deepEqual(found, [], fail(found));
});

test("the built site says an adapter's status in plain words", distOpts(join(ROOT, "apps/site/dist")), () => {
  needDist(join(ROOT, "apps/site/dist"));
  const found = hits(walk("apps/site/dist", { skipDist: false }));
  assert.deepEqual(found, [], fail(found));
});
