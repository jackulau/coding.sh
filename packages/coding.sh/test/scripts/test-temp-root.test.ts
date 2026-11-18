// scripts/test-temp-root.mjs: each test file gets a temp folder of its own, removed when the file
// exits, and scripts/test-ci.mjs prints what a file left in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../../scripts/test-ci.mjs", import.meta.url));
const PRELOAD = new URL("../../scripts/test-temp-root.mjs", import.meta.url).href;

// Leaves a folder behind and writes down which temp folder it was given.
const LEAVES = `import { it } from "node:test"; import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
it("leaves a folder", () => { mkdtempSync(join(tmpdir(), "leak-")); writeFileSync(process.env.WHERE!, tmpdir()); });`;
const CLEAN = `import { it } from "node:test"; import { mkdtempSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
it("removes what it makes", () => { rmSync(mkdtempSync(join(tmpdir(), "tidy-")), { recursive: true }); writeFileSync(process.env.WHERE! + ".clean", tmpdir()); });`;
// Removes its folder in an 'exit' listener, as src/core/children.ts does with its scratch folders.
const ON_EXIT = `import { it } from "node:test"; import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
it("removes a folder when the process exits", () => { const dir = mkdtempSync(join(tmpdir(), "late-")); process.on("exit", () => rmSync(dir, { recursive: true })); });`;
// Launches a process with its own Node flags, as \`coding.sh proxy\` does for its daemon.
const LAUNCHES = `import { it } from "node:test"; import assert from "node:assert/strict"; import { spawnSync } from "node:child_process"; import { existsSync } from "node:fs"; import { tmpdir } from "node:os";
it("a launched process keeps this file's temp folder", () => {
  const r = spawnSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith("--test")), "-e", "console.log(require('node:os').tmpdir())"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), tmpdir());
  assert.ok(existsSync(tmpdir()), "the launched process did not remove the folder");
});`;

/** Run `command` on `files` in a folder of their own, with an empty folder as the machine's temp folder. */
function run(files: Record<string, string>, command: (names: string[]) => string[], extra: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "temp-root-"));
  try {
    const outer = join(dir, "outer");
    const work = join(dir, "work");
    mkdirSync(outer);
    mkdirSync(work);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(work, name), body);
    const where = join(dir, "where.txt");
    const env: NodeJS.ProcessEnv = { ...process.env, SHARD: "", TMPDIR: outer, TMP: outer, TEMP: outer, WHERE: where, ...extra };
    // Else the inner node --test reports to this test run. CODING_SH_TEST_TEMP_ROOT stays as it is:
    // the runner itself must keep its files from taking this file's folder as theirs.
    delete env.NODE_TEST_CONTEXT;
    delete env.CODING_SH_TEST_TEMP;
    const r = spawnSync(process.execPath, command(Object.keys(files).filter((name) => name.endsWith(".test.ts"))), { cwd: work, encoding: "utf8", env, timeout: 60_000 });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const given = read(where);
    return { code: r.status, out: r.stdout + r.stderr, outer, given, givenClean: read(`${where}.clean`), gone: given !== undefined && !existsSync(given), outerLeft: readdirSync(outer) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runner = (names: string[]) => [RUNNER, ...names];
const plain = (names: string[]) => ["--no-warnings", "--import", PRELOAD, "--test", ...names];
// \`npm test\` starts from a shell, where no process has a folder yet.
const FRESH = { CODING_SH_TEST_TEMP_ROOT: "" };

describe("scripts/test-temp-root.mjs under scripts/test-ci.mjs", () => {
  it("gives each test file a temp folder of its own, removes it and prints what the file left", () => {
    const r = run({ "leaves.test.ts": LEAVES, "clean.test.ts": CLEAN }, runner);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.given && r.givenClean, r.out);
    assert.notEqual(r.given, r.givenClean, "one folder per file");
    // <the machine's temp folder>/coding-sh-test-ci-…/tmp/t-…
    for (const given of [r.given, r.givenClean]) {
      assert.match(basename(given), /^t-/);
      assert.equal(basename(dirname(given)), "tmp");
      assert.match(basename(dirname(dirname(given))), /^coding-sh-test-ci-/);
      assert.equal(dirname(dirname(dirname(given))), r.outer);
    }
    assert.ok(r.gone, "the file's folder is removed");
    assert.deepEqual(r.outerLeft, [], "and so is the run's");
    assert.match(r.out, /\nTemp entries left behind by test files: 1 \(test files that left some: 1; a file's temp folder is removed when the file exits\)\n {2}temp left: leaves\.test\.ts: 1 \(leak-\w+\)\n/);
    assert.doesNotMatch(r.out, /clean\.test\.ts: \d/);
  });

  it("prints zero when nothing was left: the line is there on every run", () => {
    const r = run({ "clean.test.ts": CLEAN }, runner);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\nTemp entries left behind by test files: 0\n/);
    assert.deepEqual(r.outerLeft, []);
  });

  it("looks only after the file's own 'exit' listeners have run", () => {
    const r = run({ "late.test.ts": ON_EXIT }, runner);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\nTemp entries left behind by test files: 0\n/);
  });

  it("fails nothing: a file that leaves something still passes", () => {
    assert.equal(run({ "leaves.test.ts": LEAVES }, runner).code, 0);
  });

  it("a process the file launches with the same Node flags keeps the file's folder", () => {
    const r = run({ "launches.test.ts": LAUNCHES }, runner);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.outerLeft, []);
  });
});

describe("scripts/test-temp-root.mjs without the runner (npm test)", () => {
  it("makes the file's folder in the machine's temp folder and removes it", () => {
    const r = run({ "leaves.test.ts": LEAVES }, plain, FRESH);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.given, r.out);
    assert.match(basename(r.given), /^t-/);
    assert.equal(dirname(r.given), r.outer);
    assert.ok(r.gone);
    assert.deepEqual(r.outerLeft, []);
  });
});

// scripts/test-ci.mjs names the folder it made for this run. If Node stopped passing --import on to
// a test file's process, the file would get that folder itself, not one inside it.
it("this run's files each have a folder of their own", { skip: process.env.CODING_SH_TEST_TEMP ? false : "only under scripts/test-ci.mjs, which names the run's folder" }, () => {
  assert.equal(dirname(tmpdir()), process.env.CODING_SH_TEST_TEMP);
  assert.equal(tmpdir(), process.env.CODING_SH_TEST_TEMP_ROOT);
});
