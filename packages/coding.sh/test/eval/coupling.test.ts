import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { goldCandidates, goldOnlyCoupling, startTreeLookup, type StartTree } from "../../src/eval/coupling.ts";
import { formatValidation, validateTask } from "../../src/eval/validate.ts";
import { FakeSnapshots, MemBlobs, MemIndex, tempDir, type Tree } from "../helpers-eval.ts";

const dirs: string[] = [];
const fakeHome = mkdtempSync(join(tmpdir(), "csh-coupling-home-"));
dirs.push(fakeHome);
process.env.HOME = fakeHome;
process.env.npm_config_cache = join(fakeHome, ".npm");
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A start tree that has exactly these names and paths. */
const tree = (names: string[] = [], paths: string[] = []): StartTree => ({ has: (n) => names.includes(n), exists: (p) => paths.includes(p) });

const TS_REF = [
  "diff --git a/src/acl.ts b/src/acl.ts",
  "--- a/src/acl.ts",
  "+++ b/src/acl.ts",
  "@@ -1,3 +1,6 @@",
  " export function allow(ip: string, list: string[]): boolean {",
  "   return list.includes(ip);",
  " }",
  "+export function _parseCidr(s: string): [string, number] {",
  "+  return [s.split('/')[0]!, Number(s.split('/')[1])];",
  "+}",
  "diff --git a/src/acl/util.ts b/src/acl/util.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/acl/util.ts",
  "@@ -0,0 +1,1 @@",
  "+export const MAX = 32;",
  "",
].join("\n");

const TS_TEST = {
  path: "test/acl.test.ts",
  text: ['import { _parseCidr } from "../src/acl";', 'import * as util from "../src/acl/util";', 'assert.deepEqual(_parseCidr("10.0.0.0/8"), ["10.0.0.0", 8]);', "assert.ok(util);"].join("\n"),
};

describe("goldCandidates", () => {
  it("collects names defined on added non-test lines and the new files", () => {
    const { names, paths } = goldCandidates(TS_REF);
    assert.equal(names.get("_parseCidr"), "src/acl.ts");
    assert.equal(names.has("MAX"), false, "names of 3 letters or less are skipped");
    assert.deepEqual(paths, ["src/acl/util.ts"]);
  });
});

describe("goldOnlyCoupling", () => {
  it("flags a helper and a new file only the reference introduces (TypeScript)", () => {
    const c = goldOnlyCoupling({ testFiles: [TS_TEST], refPatch: TS_REF, startTree: tree(["allow"], ["src/acl.ts"]), instruction: "Let the ACL allow list take CIDR ranges." });
    assert.deepEqual(
      c.map((x) => [x.kind, x.symbol, x.line, x.definedIn]),
      [
        ["identifier", "_parseCidr", 1, "src/acl.ts"],
        ["path", "src/acl/util.ts", 2, "src/acl/util.ts"],
      ],
    );
  });

  it("is empty when the instruction names the symbol and the file", () => {
    const c = goldOnlyCoupling({ testFiles: [TS_TEST], refPatch: TS_REF, startTree: tree(), instruction: "Add parseCidr to src/acl.ts and put shared constants in src/acl/util.ts." });
    assert.deepEqual(c, []);
  });

  it("is empty when the start tree already has the symbol and the file", () => {
    const c = goldOnlyCoupling({ testFiles: [TS_TEST], refPatch: TS_REF, startTree: tree(["_parseCidr"], ["src/acl/util.ts"]), instruction: "Support CIDR ranges." });
    assert.deepEqual(c, []);
  });

  it("skips names of 3 letters or less and stop-listed names", () => {
    const ref = ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js", "@@ -1,1 +1,3 @@", " //", "+function cut() {}", "+function main() {}", ""].join("\n");
    const c = goldOnlyCoupling({ testFiles: [{ path: "t.test.js", text: "cut(); main();" }], refPatch: ref, startTree: tree(), instruction: "x" });
    assert.deepEqual(c, []);
  });

  it("ignores test files in the reference and names it only uses", () => {
    const ref = ["diff --git a/test/h.test.js b/test/h.test.js", "--- a/test/h.test.js", "+++ b/test/h.test.js", "@@ -1,1 +1,2 @@", " //", "+function helperForTests() {}", ""].join("\n");
    assert.deepEqual(goldOnlyCoupling({ testFiles: [{ path: "test/h.test.js", text: "helperForTests()" }], refPatch: ref, startTree: tree(), instruction: "x" }), []);
  });

  it("finds Python defs and module imports", () => {
    const ref = [
      "diff --git a/pkg/rates.py b/pkg/rates.py",
      "--- a/pkg/rates.py",
      "+++ b/pkg/rates.py",
      "@@ -1,2 +1,4 @@",
      " def rate(x):",
      "     return x",
      "+def _bucket_for(x):",
      "+    return x // 10",
      "diff --git a/pkg/limits.py b/pkg/limits.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/limits.py",
      "@@ -0,0 +1,1 @@",
      "+CAP = 3",
      "",
    ].join("\n");
    const test = { path: "tests/test_rates.py", text: "from pkg.rates import _bucket_for\nimport pkg.limits\n\ndef test_bucket():\n    assert _bucket_for(25) == 2\n" };
    const c = goldOnlyCoupling({ testFiles: [test], refPatch: ref, startTree: tree(["rate"], ["pkg/rates.py"]), instruction: "Bucket rates by tens." });
    assert.deepEqual(
      c.map((x) => [x.kind, x.symbol, x.line]),
      [
        ["identifier", "_bucket_for", 1],
        ["path", "pkg/limits.py", 2],
      ],
    );
  });

  it("finds Go funcs, methods and types", () => {
    const ref = [
      "diff --git a/acl/acl.go b/acl/acl.go",
      "--- a/acl/acl.go",
      "+++ b/acl/acl.go",
      "@@ -1,1 +1,4 @@",
      " package acl",
      "+type cidrRange struct{ bits int }",
      "+func (r cidrRange) contains(ip string) bool { return false }",
      "+func parseRange(s string) cidrRange { return cidrRange{} }",
      "",
    ].join("\n");
    const test = { path: "acl/acl_test.go", text: 'func TestRange(t *testing.T) {\n\tr := parseRange("10.0.0.0/8")\n\t_ = r.contains("10.1.1.1")\n}\n' };
    const c = goldOnlyCoupling({ testFiles: [test], refPatch: ref, startTree: tree(), instruction: "Support CIDR ranges in the ACL." });
    assert.deepEqual(
      c.map((x) => [x.symbol, x.line]),
      [
        ["parseRange", 2],
        ["contains", 3],
      ],
    );
  });

  it("does not match a same-named file in another directory", () => {
    const test = { path: "test/x.test.ts", text: 'import { a } from "../src/other/util";' };
    const c = goldOnlyCoupling({ testFiles: [test], refPatch: TS_REF, startTree: tree(), instruction: "x" });
    assert.deepEqual(c, []);
  });
});

describe("startTreeLookup", () => {
  it("finds names by word and checks paths", async () => {
    const dir = await tempDir("csh-coupling-tree-");
    dirs.push(dir);
    for (const [rel, text] of Object.entries({ "src/a.js": "export function allowIp() {}\n", "node_modules/x/i.js": "function parseCidr() {}\n" })) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    const t = await startTreeLookup(dir, ["allowIp", "allow", "parseCidr"]);
    assert.equal(t.has("allowIp"), true);
    assert.equal(t.has("allow"), false, "a word match, not a substring");
    assert.equal(t.has("parseCidr"), false, "node_modules is skipped");
    assert.equal(t.exists("src/a.js"), true);
    assert.equal(t.exists("src/b.js"), false);
    assert.equal(t.exists("../etc/passwd"), false);
  });
});

// The acceptance fixture through validateTask: the reference adds `_parseCidr` to src/acl.js and a new
// src/acl/util.js; the hidden test imports both and the instruction names neither.
const PKG = JSON.stringify({ name: "acl", version: "1.0.0", type: "module" }) + "\n";
const START: Tree = {
  "package.json": PKG,
  "src/acl.js": "export function allow(ip, list) {\n  return list.includes(ip);\n}\n",
};
const END: Tree = {
  ...START,
  "src/acl.js": START["src/acl.js"] + "export function _parseCidr(s) {\n  const [ip, bits] = s.split('/');\n  return [ip, Number(bits)];\n}\n",
  "src/acl/util.js": "export const MASK_BITS = 32;\n",
};
const HIDDEN = [
  'import assert from "node:assert/strict";',
  'import { _parseCidr } from "../src/acl.js";',
  'import * as util from "../src/acl/util.js";',
  'assert.deepEqual(_parseCidr("10.0.0.0/8"), ["10.0.0.0", 8]);',
  "assert.ok(util);",
  "",
].join("\n");

async function fixture(instruction: string) {
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("start", START).add("end", END);
  const patch = (await git.diffSnapshots("/r", "start", "end")).patch;
  const task: EvalTask = {
    id: "acl",
    name: "acl",
    status: "draft",
    start: { repoRoot: "/r", snapshot: "start", head: "h" },
    instruction,
    setup: [],
    verifier: { command: "node test/acl.test.js", hiddenFiles: { "test/acl.test.js": await blobs.put(HIDDEN) }, timeoutMs: 30_000 },
    referencePatch: await blobs.put(patch),
    tags: [],
    createdAt: 0,
  };
  const workRoot = await tempDir("csh-coupling-");
  dirs.push(workRoot);
  return { blobs, git, task, workRoot };
}

describe("validateTask gold-only coupling", () => {
  it("reports 2 couplings without blocking, and blocks with strictCoupling", async () => {
    const f = await fixture("The ACL allow list should accept CIDR ranges such as 10.0.0.0/8.");
    const o = await validateTask({ ...f, k: 1, index: new MemIndex() });
    assert.deepEqual(o.errors, []);
    assert.deepEqual(
      o.report.coupling?.map((c) => [c.kind, c.symbol, c.line]),
      [
        ["identifier", "_parseCidr", 2],
        ["path", "src/acl/util.js", 3],
      ],
    );
    assert.equal(o.report.ok, true, "non-blocking by default");
    assert.ok(o.notes.some((n) => /test\/acl\.test\.js:2 uses `_parseCidr`/.test(n)));
    assert.match(formatValidation(o), /warn 2 hidden-test reference\(s\) to names only the reference introduces/);

    const g = await fixture("The ACL allow list should accept CIDR ranges such as 10.0.0.0/8.");
    const strict = await validateTask({ ...g, k: 1, index: new MemIndex(), strictCoupling: true });
    assert.equal(strict.report.coupling?.length, 2);
    assert.equal(strict.report.ok, false);
  });

  it("leaves coupling out of the report when there is none", async () => {
    const f = await fixture("Add `_parseCidr(s)` to src/acl.js and a MASK_BITS constant in src/acl/util.js so the allow list takes CIDR ranges.");
    const o = await validateTask({ ...f, k: 1, index: new MemIndex(), strictCoupling: true });
    assert.equal("coupling" in o.report, false);
  });
});
