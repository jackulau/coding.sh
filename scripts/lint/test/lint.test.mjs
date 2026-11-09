import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegExp, lintFiles, parseAllowlist, siteDocs, updatedAllowlist } from "../lib/lint.mjs";
import { RULE_IDS } from "../lib/rules.mjs";
import { main } from "../slop.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BAD = "declare const raw: string;\nexport const a = raw as unknown as number;\n";
const BAD2 = `${BAD}export const b = raw as unknown as boolean;\n`;
const CLEAN = "export const a = 1;\n";

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A throwaway git repo; git reads no global or system config. */
function repo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slop-lint-")));
  temps.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  sh(root, ["init", "-q"]);
  return root;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: tmpdir() };
function sh(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Runs the CLI in-process against `root`; returns its exit code and output. */
function run(root, argv) {
  let stdout = "";
  let stderr = "";
  const code = main([...argv, "--root", root], { stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) }, cwd: root });
  return { code, stdout, stderr };
}

const read = (files) => (p) => files[p];
const allow = (entries) => parseAllowlist({ entries }, RULE_IDS);

// ---------------------------------------------------------------- allowlist

test("a counted allowlist entry covers up to max findings in its file", () => {
  const files = { "src/a.ts": BAD2 };
  const ok = lintFiles(Object.keys(files), { read: read(files), allowlist: allow([{ rule: "chained-as", path: "src/a.ts", max: 2, reason: "r" }]) });
  assert.equal(ok.findings.length, 2);
  assert.ok(ok.findings.every((f) => f.allowed));
  const over = lintFiles(Object.keys(files), { read: read(files), allowlist: allow([{ rule: "chained-as", path: "src/a.ts", max: 1, reason: "r" }]) });
  assert.ok(over.findings.every((f) => !f.allowed));
  assert.deepEqual(over.findings[0].over, { allowed: 1, found: 2 });
});

test("a stale count is reported so it can be lowered", () => {
  const files = { "src/a.ts": BAD };
  const r = lintFiles(Object.keys(files), { read: read(files), allowlist: allow([{ rule: "chained-as", path: "src/a.ts", max: 3, reason: "r" }]) });
  assert.deepEqual(r.stale, [{ rule: "chained-as", path: "src/a.ts", max: 3, found: 1 }]);
});

test("a glob entry without max covers every matching file", () => {
  const files = { "test/a.test.ts": BAD2, "test/deep/b.test.ts": BAD, "src/c.ts": BAD };
  const r = lintFiles(Object.keys(files), { read: read(files), allowlist: allow([{ rule: "chained-as", path: "test/**", reason: "test doubles" }]) });
  assert.deepEqual(r.findings.filter((f) => !f.allowed).map((f) => f.path), ["src/c.ts"]);
});

test("an inline slop-allow needs the rule and a reason", () => {
  const cases = [
    ["export const a = b as unknown as C; // slop-allow chained-as: generated types disagree\n", 0],
    ["// slop-allow chained-as -- the SDK types lag the API\nexport const a = b as unknown as C;\n", 0],
    ["export const a = b as unknown as C; // slop-allow chained-as\n", 1],
    ["export const a = b as unknown as C; // slop-allow unknown-param: wrong rule\n", 1],
  ];
  for (const [src, n] of cases) {
    const r = lintFiles(["src/a.ts"], { read: () => src });
    assert.equal(r.findings.filter((f) => !f.allowed).length, n, src);
  }
});

test("parseAllowlist rejects unknown rules, missing reasons and bad counts", () => {
  assert.throws(() => allow([{ rule: "nope", path: "a", reason: "r" }]), /unknown rule "nope"/);
  assert.throws(() => allow([{ rule: "chained-as", path: "a" }]), /"reason"/);
  assert.throws(() => allow([{ rule: "chained-as", path: "a", reason: "r", max: 0 }]), /"max"/);
  assert.throws(() => allow([{ rule: "chained-as", reason: "r" }]), /"path"/);
});

test("globToRegExp: ** crosses folders, * stays in one", () => {
  assert.ok(globToRegExp("test/**").test("test/a/b.ts"));
  assert.ok(globToRegExp("**/fixtures/**").test("fixtures/a.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(!globToRegExp("src/a.ts").test("src/a-ts"));
});

test("updatedAllowlist lowers counts, drops fixed files, keeps globs and adds new files", () => {
  const entries = allow([
    { rule: "chained-as", path: "src/a.ts", max: 5, reason: "keep me" },
    { rule: "chained-as", path: "src/fixed.ts", max: 2, reason: "gone" },
    { rule: "chained-as", path: "test/**", reason: "test doubles" },
  ]);
  const findings = [
    { rule: "chained-as", path: "src/a.ts" },
    { rule: "chained-as", path: "src/a.ts" },
    { rule: "chained-as", path: "test/x.ts" },
    { rule: "barrel-file", path: "src/index.ts" },
  ];
  assert.deepEqual(updatedAllowlist(entries, findings, "2026-01-02"), [
    { rule: "barrel-file", path: "src/index.ts", max: 1, reason: "baseline 2026-01-02: existing code, do not add more" },
    { rule: "chained-as", path: "src/a.ts", max: 2, reason: "keep me" },
    { rule: "chained-as", path: "test/**", reason: "test doubles" },
  ]);
});

test("siteDocs lists the repo docs the site renders", () => {
  const root = repo({
    "apps/site/src/components/docs/markdown.ts": 'const SITE_PAGES: Record<string, string> = {\n  "concepts.md": "/docs/concepts",\n  "reference/cli.md": "/docs/cli",\n};\n',
    "apps/site/src/lib/changelog.ts": "",
  });
  assert.deepEqual([...siteDocs(root)].sort(), ["CHANGELOG.md", "docs/concepts.md", "docs/reference/cli.md"]);
});

// ---------------------------------------------------------------- CLI

test("cli: exit 1 with path:line findings, exit 0 once clean", () => {
  const root = repo({ "src/a.ts": BAD, "node_modules/x/index.ts": BAD, "test/fixtures/f.ts": BAD, ".worktrees/old/src/a.ts": BAD, ".github/scripts/b.ts": BAD });
  const r = run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^src\/a\.ts:2:22 {2}chained-as {2}/m);
  assert.match(r.stdout, /^\.github\/scripts\/b\.ts:2/m);
  assert.doesNotMatch(r.stdout, /node_modules|fixtures|worktrees/);
  assert.match(r.stderr, /2 findings/);
  writeFileSync(join(root, "src/a.ts"), CLEAN);
  writeFileSync(join(root, ".github/scripts/b.ts"), CLEAN);
  const clean = run(root, []);
  assert.equal(clean.code, 0);
  assert.equal(clean.stdout, "");
});

test("cli: --json prints one document", () => {
  const root = repo({ "src/a.ts": BAD });
  const r = run(root, ["--json"]);
  assert.equal(r.code, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.findings.map((f) => [f.rule, f.path, f.line]), [["chained-as", "src/a.ts", 2]]);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("cli: --staged lints what the commit holds, not the working copy", () => {
  const root = repo({ "src/a.ts": BAD });
  sh(root, ["add", "src/a.ts"]);
  writeFileSync(join(root, "src/a.ts"), CLEAN);
  assert.equal(run(root, ["--staged"]).code, 1);
  sh(root, ["add", "src/a.ts"]);
  writeFileSync(join(root, "src/a.ts"), BAD);
  assert.equal(run(root, ["--staged"]).code, 0);
});

test("cli: --update-allowlist baselines the tree, then a new finding fails", () => {
  const root = repo({ "src/a.ts": BAD });
  assert.equal(run(root, ["--update-allowlist"]).code, 0);
  const list = JSON.parse(readFileSync(join(root, "scripts/lint/allowlist.json"), "utf8"));
  assert.deepEqual(list.entries.map((e) => [e.rule, e.path, e.max]), [["chained-as", "src/a.ts", 1]]);
  assert.equal(run(root, []).code, 0);
  writeFileSync(join(root, "src/a.ts"), BAD2);
  const r = run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /file has 2, allowlist allows 1/);
});

test("cli: usage errors exit 2 and name the next command", () => {
  const root = repo({ "src/a.ts": CLEAN });
  const flag = run(root, ["--jsn"]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /unknown flag --jsn \(did you mean --json\?\)/);
  assert.match(flag.stderr, /^next: /m);
  const rule = run(root, ["--rule", "chained-ass", "--json"]);
  assert.equal(rule.code, 2);
  const doc = JSON.parse(rule.stdout);
  assert.equal(doc.error.reason, "usage");
  assert.match(doc.error.message, /did you mean chained-as/);
  assert.equal(doc.error.retryable, false);
  assert.equal(run(root, ["--update-allowlist", "src"]).code, 2);
  assert.equal(run(root, ["--staged", "src"]).code, 2);
});

test("cli: --help --json describes flags and rules as data", () => {
  const r = run(repo(), ["--help", "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.flags.some((f) => f.name === "--staged"));
  assert.deepEqual(doc.rules.map((x) => x.id), RULE_IDS);
});

// ---------------------------------------------------------------- acceptance

test("the repo passes: every finding is fixed or allowlisted with a reason", () => {
  const r = run(REPO, []);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
});
