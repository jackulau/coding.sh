import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportProblems } from "../../scripts/report-complete.mjs";

const RUNNER = new URL("../../scripts/test-ci.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function run(files: Record<string, string>, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "test-ci-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const env: NodeJS.ProcessEnv = { ...process.env, SHARD: "", FLAKE_FLAG: join(dir, "flag") };
    delete env.NODE_TEST_CONTEXT; // else the inner node --test reports to this test run instead of its own stdout
    // A hung run is killed after 60 s and reads as a failure, not a stuck test.
    const r = spawnSync(process.execPath, [RUNNER, ...names], { cwd: dir, encoding: "utf8", env, timeout: 60_000 });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FLAKY = `import { it } from "node:test"; import { existsSync, writeFileSync } from "node:fs";
it("fails the first time only", () => { if (!existsSync(process.env.FLAKE_FLAG!)) { writeFileSync(process.env.FLAKE_FLAG!, "1"); throw new Error("under load"); } });`;
const BROKEN = `import { it } from "node:test"; it("always fails", () => { throw new Error("real"); });`;
const GREEN = `import { it } from "node:test"; it("passes", () => {});`;
// A test that passes but leaves a handle open, as a browser's pipe can on Windows.
const LEAKY = `import { it } from "node:test"; it("passes and leaks a timer", () => { setInterval(() => {}, 1000); });`;

// Many tests that take no time: a file like this writes its report faster than the run reads it.
const MANY_FILES = 12;
const MANY_TESTS = 400;
const MANY = `import { it } from "node:test"; for (let i = 0; i < ${MANY_TESTS}; i++) it("quick test number " + i + " with a name long enough to fill the pipe", () => {});`;
const LAST_FAILS = ` it("the last test fails", () => { throw new Error("real"); });`;

// A suite that test files share: its tests are reported under this file, not the file that runs it.
const SHARED = `import { it } from "node:test"; import { existsSync, writeFileSync } from "node:fs";
export function always(): void { it("a shared test that always fails", () => { throw new Error("real"); }); }
export function once(): void { it("a shared test that fails the first time only", () => { if (!existsSync(process.env.FLAKE_FLAG!)) { writeFileSync(process.env.FLAKE_FLAG!, "1"); throw new Error("under load"); } }); }`;
const USES_ALWAYS = `import { always } from "./shared.ts"; always();`;
const USES_ONCE = `import { once } from "./shared.ts"; once();`;

// Passes, then loses the end of its report the way a file that exits too early does: nothing it
// writes after its last test reaches the run, and it still exits 0.
const CUT_SHORT = `import { after, it } from "node:test"; it("passes", () => {}); it("passes too", () => {});
after(() => { process.stdout.write = () => true; });`;

describe("scripts/test-ci.mjs", () => {
  // Rerun alone, the file that defines a shared suite runs no tests and exits 0.
  it("fails when a test of a shared suite fails, and does not rerun the file that defines the suite", () => {
    const r = run({ "shared.ts": SHARED, "s.test.ts": USES_ALWAYS, "c.test.ts": GREEN }, ["s.test.ts", "c.test.ts"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /a shared test that always fails/);
    assert.match(r.out, /A test failed in shared\.ts, which is not a test file of this run/);
    assert.doesNotMatch(r.out, /Rerunning|::warning/);
  });

  it("fails on a shared suite's failure even when it would pass a second time", () => {
    const r = run({ "shared.ts": SHARED, "s.test.ts": USES_ONCE, "a.test.ts": FLAKY }, ["s.test.ts"]);
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, /Rerunning|::warning/);
  });

  it("fails a run in which a passing file lost the end of its report, and names the file", () => {
    const r = run({ "cut.test.ts": CUT_SHORT, "c.test.ts": GREEN }, ["cut.test.ts", "c.test.ts"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The report of this run is incomplete, so the run fails:\n  cut\.test\.ts did not send the end of its report/);
    assert.doesNotMatch(r.out, /c\.test\.ts did not send/);
    assert.doesNotMatch(r.out, /Rerunning/);
  });

  it("says nothing about the report when every file sent all of it", () => {
    const r = run({ "c.test.ts": GREEN, "d.test.ts": GREEN }, ["c.test.ts", "d.test.ts"]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /incomplete/);
  });

  it("checks the report: a summary from every file, and as many results as the files counted", () => {
    const whole = { summaries: { [join(process.cwd(), "a.test.ts")]: 3, [join(process.cwd(), "b.test.ts")]: 2 }, arrived: 5 };
    assert.deepEqual(reportProblems(["a.test.ts", "b.test.ts"], [], whole), []);
    assert.deepEqual(reportProblems(["a.test.ts", "b.test.ts", "c.test.ts"], [], whole), ["c.test.ts did not send the end of its report: results of its tests may be missing."]);
    // A result lost from the middle: every summary is there and the totals differ.
    assert.deepEqual(reportProblems(["a.test.ts", "b.test.ts"], [], { ...whole, arrived: 4 }), ["The test files counted 5 tests and 4 results arrived."]);
    // A file that failed is the caller's, with or without its summary; the totals are not compared then.
    assert.deepEqual(reportProblems(["a.test.ts", "b.test.ts", "c.test.ts"], [join(process.cwd(), "c.test.ts")], { ...whole, arrived: 9 }), []);
    // No list of files (Node picked them): the totals still count.
    assert.deepEqual(reportProblems([], [], { ...whole, arrived: 6 }), ["The test files counted 5 tests and 6 results arrived."]);
    assert.deepEqual(reportProblems(["a.test.ts"], [], undefined), ["The run wrote no record of its report."]);
  });

  it("passes when a failed file passes alone, and says so as a warning", () => {
    const r = run({ "a.test.ts": FLAKY, "c.test.ts": GREEN }, ["a.test.ts", "c.test.ts"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=Passed when run alone::a\.test\.ts/);
  });

  it("fails when a file fails again alone", () => {
    const r = run({ "a.test.ts": FLAKY, "b.test.ts": BROKEN }, ["a.test.ts", "b.test.ts"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Rerunning b\.test\.ts alone/);
    assert.doesNotMatch(r.out, /::warning[^\n]*b\.test\.ts/);
  });

  it("does not rerun anything when every file passes", () => {
    const r = run({ "c.test.ts": GREEN }, ["c.test.ts"]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Rerunning/);
  });
  // A file exits as soon as its tests are done (--test-force-exit). Without blocking writes the
  // end of its report is still queued in its stdout pipe then, and the totals come up short.
  it("reports every test of files that finish with their report still being written", () => {
    const files = Object.fromEntries(Array.from({ length: MANY_FILES }, (_, i) => [`m${i}.test.ts`, MANY]));
    const r = run(files, Object.keys(files));
    assert.equal(r.code, 0, r.out.slice(-2000));
    assert.equal(/^ℹ tests (\d+)$/m.exec(r.out)?.[1], String(MANY_FILES * MANY_TESTS), r.out.slice(-2000));
  });

  it("names the failing test when it is the last line of a long report", () => {
    const r = run({ "z.test.ts": MANY + LAST_FAILS, "y.test.ts": MANY }, ["z.test.ts", "y.test.ts"]);
    assert.equal(r.code, 1, r.out.slice(-2000));
    const firstPass = r.out.split("Rerunning ")[0] ?? "";
    assert.match(firstPass, /the last test fails/);
  });

  it("finishes when a passing file leaves a handle open", () => {
    const r = run({ "l.test.ts": LEAKY }, ["l.test.ts"]);
    assert.equal(r.code, 0, r.out);
  });
});
