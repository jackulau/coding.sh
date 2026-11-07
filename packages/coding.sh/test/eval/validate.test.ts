import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { formatValidation, runVerifier, validateTask, type ValidateOpts } from "../../src/eval/validate.ts";
import { commandEnv } from "../../src/runner/exec.ts";
import { BUGGY, FIXED, FakeSnapshots, HIDDEN_TEST, MemBlobs, MemIndex, tempDir, type Tree } from "../helpers-eval.ts";

const dirs: string[] = [];
// Pass-to-pass runs the toy repo's `npm test`: keep npm's cache and logs out of the real home.
const fakeHome = mkdtempSync(join(tmpdir(), "csh-validate-home-"));
dirs.push(fakeHome);
process.env.HOME = fakeHome;
process.env.npm_config_cache = join(fakeHome, ".npm");
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(opts: { start?: Tree; end?: Tree; hidden?: string; verifier?: string; instruction?: string; reference?: boolean } = {}) {
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("start", opts.start ?? BUGGY).add("end", opts.end ?? FIXED);
  const patch = (await git.diffSnapshots("/r", "start", "end")).patch;
  const task: EvalTask = {
    id: "t1",
    name: "toy",
    status: "draft",
    start: { repoRoot: "/r", snapshot: "start", head: "h" },
    instruction: opts.instruction ?? "add() and mul() are broken; fix them",
    setup: [],
    verifier: { command: opts.verifier ?? "node test/add.test.js", hiddenFiles: { "test/add.test.js": await blobs.put(opts.hidden ?? HIDDEN_TEST) }, timeoutMs: 30_000 },
    referencePatch: opts.reference === false ? undefined : await blobs.put(patch),
    tags: [],
    createdAt: 0,
  };
  const workRoot = await tempDir("csh-validate-");
  dirs.push(workRoot);
  return { blobs, git, task, workRoot, patch };
}

describe("validateTask", () => {
  it("validates a sound task: no-op fails, reference k/k, both near-misses fail, no leakage", async () => {
    const { blobs, git, task, workRoot } = await setup();
    const index = new MemIndex();
    const o = await validateTask({ task, blobs, git, workRoot, k: 3, index });
    assert.deepEqual(o.errors, []);
    assert.equal(o.report.noopFails, true);
    assert.deepEqual(o.report.referencePasses, { passed: 3, of: 3 });
    assert.deepEqual(o.report.nearMissesFail, { failed: 2, of: 2 });
    assert.deepEqual(o.report.leakage, []);
    assert.equal(o.report.ok, true);
    assert.equal(o.task.status, "validated");
    assert.equal((await index.getTask("t1"))?.status, "validated");
    assert.equal(o.steps.filter((s) => s.kind === "reference").length, 3);
    assert.deepEqual(await readdir(workRoot), [], "step dirs are cleaned up");
    assert.match(formatValidation(o), /→ validated/);
  });

  // EXP-2: Ctrl-C reaches the running verifier, nothing further runs, dirs are removed, the task is not written.
  it("an abort kills the running verifier, stops, cleans up and leaves the task unwritten", async () => {
    const pidDir = await tempDir("csh-validate-pid-");
    dirs.push(pidDir);
    const pidFile = join(pidDir, "pid");
    const { blobs, git, task, workRoot } = await setup({ verifier: `echo $$ >> ${pidFile}; sleep 30` });
    const index = new MemIndex();
    const ac = new AbortController();
    const steps: string[] = [];
    // Abort once the verifier is running (its pid is on disk), not after a fixed delay: on a
    // loaded machine materializing the step dir can take longer than any delay, and an abort
    // before the spawn leaves no verifier to kill. The 20 s fallback only keeps a broken run
    // from hanging; the pid checks below then fail.
    let abortedAt = 0;
    const abort = () => {
      clearInterval(poll);
      clearTimeout(fallback);
      abortedAt = Date.now();
      ac.abort();
    };
    const poll = setInterval(() => {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").includes("\n")) abort();
    }, 10);
    const fallback = setTimeout(abort, 20_000);
    try {
      await assert.rejects(validateTask({ task, blobs, git, workRoot, k: 3, index, passToPass: false, signal: ac.signal, onStep: (st) => steps.push(st.label) }), { name: "AbortError" });
    } finally {
      clearInterval(poll);
      clearTimeout(fallback);
    }
    assert.ok(Date.now() - abortedAt < 5000, `stopped ${Date.now() - abortedAt}ms after the abort`);
    assert.deepEqual(steps, [], "the killed no-op step is not recorded as a result");
    assert.deepEqual(await readdir(workRoot), [], "step dirs are cleaned up");
    assert.equal(await index.getTask("t1"), undefined, "task status not written");
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 1, "no step after the abort");
    let alive = true;
    try {
      process.kill(pids[0]!, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "verifier killed");
  });

  it("catches a verifier that accepts an incomplete fix (near-miss passes)", async () => {
    const weak = 'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nassert.equal(add(2, 3), 5);\n';
    const { blobs, git, task, workRoot } = await setup({ hidden: weak });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.ok, false);
    assert.deepEqual(o.report.nearMissesFail, { failed: 1, of: 2 });
    const passed = o.nearMisses.filter((n) => n.passed);
    assert.equal(passed.length, 1);
    assert.match(passed[0]?.label ?? "", /src\/mul\.js/);
    assert.equal(o.task.status, "draft");
  });

  it("catches a verifier that passes without any change", async () => {
    const { blobs, git, task, workRoot } = await setup({ verifier: "true" });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.noopFails, false);
    assert.equal(o.report.ok, false);
  });

  it("catches flaky verifiers (reference must pass k/k)", async () => {
    const { blobs, git, task, workRoot } = await setup();
    const counter = join(workRoot, "..", `flaky-${process.pid}-${Date.now()}`);
    dirs.push(counter);
    // Passes on every other invocation once the real test passes.
    task.verifier.command = `node test/add.test.js && n=$(cat "$FLAKY" 2>/dev/null || echo 0) && echo $((n+1)) > "$FLAKY" && [ $((n % 2)) -eq 0 ]`;
    const o = await validateTask({ task, blobs, git, workRoot, k: 4, env: { FLAKY: counter } });
    assert.deepEqual(o.report.referencePasses, { passed: 2, of: 4 });
    assert.equal(o.report.ok, false);
    assert.ok(o.notes.some((n) => /flaky/.test(n)));
  });

  it("flags hidden tests visible in the start tree", async () => {
    const { blobs, git, task, workRoot } = await setup({ start: { ...BUGGY, "test/add.test.js": HIDDEN_TEST } });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.ok(o.report.leakage.some((l) => /visible to the agent/.test(l)), o.report.leakage.join("\n"));
    assert.equal(o.report.ok, false);
  });

  it("flags a start tree that already contains the solution", async () => {
    const { blobs, git, task, workRoot } = await setup();
    git.add("start", FIXED); // now start == end state; reference reverse-applies
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.ok(o.report.leakage.some((l) => /already contains the reference/.test(l)), o.report.leakage.join("\n"));
  });

  it("flags future history reachable from refs", async () => {
    const { blobs, git, task, workRoot } = await setup();
    git.extraCommits.set("start", FIXED);
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.ok(o.report.leakage.some((l) => /not from HEAD/.test(l)), o.report.leakage.join("\n"));
    assert.ok(o.report.leakage.some((l) => /history contains reference code/.test(l)), o.report.leakage.join("\n"));
  });

  it("flags an instruction that pastes the solution, not one that describes the bug", async () => {
    const add = "export function add(a, b) {\n  const sum = Number(a) + Number(b);\n  return sum;\n}\n";
    const end = { ...FIXED, "src/add.js": add };
    const clean = await setup({ end });
    const ok = await validateTask({ task: clean.task, blobs: clean.blobs, git: clean.git, workRoot: clean.workRoot, k: 1 });
    assert.deepEqual(ok.report.leakage, []);
    const { blobs, git, task, workRoot } = await setup({ end });
    task.instruction = `Fix it. Use exactly:\n${add}\n${FIXED["src/mul.js"]}`;
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.ok(o.report.leakage.some((l) => /instruction contains/.test(l)), o.report.leakage.join("\n"));
  });

  it("reports missing verifier / reference as errors and keeps the draft", async () => {
    const { blobs, git, task, workRoot } = await setup({ reference: false });
    task.verifier.command = "";
    const o = await validateTask({ task, blobs, git, workRoot, k: 2 });
    assert.equal(o.report.ok, false);
    assert.equal(o.errors.length, 2);
    assert.deepEqual(o.report.referencePasses, { passed: 0, of: 0 });
    assert.equal(o.task.status, "draft");
  });

  it("explicit near-misses replace auto-generated ones; non-applying ones are skipped", async () => {
    const { blobs, git, task, workRoot } = await setup();
    const o = await validateTask({
      task,
      blobs,
      git,
      workRoot,
      k: 1,
      nearMisses: [{ label: "garbage", patch: "--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n" }, "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# toy\n+# toy!\n"],
    });
    assert.deepEqual(o.report.nearMissesFail, { failed: 1, of: 1 });
    assert.equal(o.nearMisses.find((n) => n.label === "garbage")?.applied, false);
    assert.equal(o.report.ok, true);
  });

  it("failing setup is an error, not a pass", async () => {
    const { blobs, git, task, workRoot } = await setup();
    task.setup = ["exit 3"];
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.ok, false);
    assert.ok(o.errors.some((e) => /setup `exit 3` exited 3/.test(e)));
  });
});

describe("validateTask: impossible variant", () => {
  it("builds an impossible variant the reference and the no-op both fail, and stores it", async () => {
    const { blobs, git, task, workRoot } = await setup();
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    const imp = o.report.impossible;
    assert.ok(imp);
    assert.equal(imp.gameable, false);
    assert.equal(imp.tried, 1);
    assert.deepEqual(imp.passedByReference, []);
    assert.equal(imp.variant?.label, "test/add.test.js:4 5→6");
    assert.equal(imp.variant?.noopFails, true);
    const ref = imp.variant?.hiddenFiles?.["test/add.test.js"];
    assert.ok(ref);
    assert.notEqual(ref, task.verifier.hiddenFiles["test/add.test.js"]);
    assert.match((await blobs.getText(ref)) ?? "", /assert\.equal\(add\(2, 3\), 6\);/);
    assert.equal(o.report.ok, true);
    assert.match(formatValidation(o), /ok {3}impossible variant fails the reference \(test\/add\.test\.js:4 5→6\)/);
    assert.equal(o.steps.filter((s) => s.kind === "impossible").length, 2);

    // The stored variant really is unsolvable: the correct end state fails it.
    const dir = await mkdtemp(join(workRoot, "check-"));
    await git.materialize({ root: "/r", head: "end", snapshot: "end" }, dir);
    const variant = { ...task, verifier: { ...task.verifier, hiddenFiles: imp.variant?.hiddenFiles ?? {} } };
    assert.notEqual((await runVerifier(dir, variant, blobs, commandEnv())).exitCode, 0);
    assert.equal((await runVerifier(dir, task, blobs, commandEnv())).exitCode, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("flags a verifier that passes the reference on every impossible variant as gameable", async () => {
    // Fails the no-op, passes the reference, rejects both near-misses, yet never runs the hidden test.
    const { blobs, git, task, workRoot } = await setup({ verifier: "grep -q 'a + b' src/add.js && grep -q 'a \\* b' src/mul.js" });
    const o = await validateTask({ task, blobs, git, workRoot, k: 2 });
    assert.equal(o.report.noopFails, true);
    assert.deepEqual(o.report.referencePasses, { passed: 2, of: 2 });
    assert.deepEqual(o.report.nearMissesFail, { failed: 2, of: 2 });
    assert.deepEqual(o.report.leakage, []);
    assert.deepEqual(o.report.impossible, {
      gameable: true,
      tried: 2,
      passedByReference: ["test/add.test.js:4 5→6", "test/add.test.js:5 6→7"],
    });
    assert.equal(o.report.ok, false, "gameable verifier must not validate");
    assert.equal(o.task.status, "draft");
    assert.ok(o.notes.some((n) => /verifier is gameable/.test(n)), o.notes.join("\n"));
    assert.match(formatValidation(o), /FAIL impossible variants fail the reference 0\/2: the verifier is gameable/);
  });

  it("stops at the first variant the reference fails and respects max", async () => {
    // Only the mul assertion is checked for real (add's result is printed, never compared).
    const hidden =
      'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nimport { mul } from "../src/mul.js";\n' +
      "if (false) assert.equal(add(2, 3), 5);\nassert.equal(mul(2, 3), 6);\n";
    const { blobs, git, task, workRoot } = await setup({ hidden, verifier: "node test/add.test.js && grep -q 'a + b' src/add.js" });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.impossible?.gameable, false);
    assert.equal(o.report.impossible?.tried, 2);
    assert.deepEqual(o.report.impossible?.passedByReference, ["test/add.test.js:4 5→6"]);
    assert.equal(o.report.impossible?.variant?.label, "test/add.test.js:5 6→7");
    const capped = await validateTask({ task, blobs, git, workRoot, k: 1, impossible: { max: 1 } });
    assert.equal(capped.report.impossible?.gameable, true);
    assert.equal(capped.report.impossible?.tried, 1);
  });

  it("mutates a visible test file the verifier names when there are no hidden files", async () => {
    const visible = 'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nassert.equal(add(2, 3), 5);\n';
    const start = { ...BUGGY, "test/visible.test.js": visible };
    const end = { ...FIXED, "test/visible.test.js": visible };
    const { blobs, git, task, workRoot } = await setup({ start, end, verifier: "node test/visible.test.js" });
    task.verifier.hiddenFiles = {};
    const o = await validateTask({ task, blobs, git, workRoot, k: 1, nearMisses: [] });
    const v = o.report.impossible?.variant;
    assert.equal(o.report.impossible?.gameable, false);
    assert.equal(v?.label, "test/visible.test.js:3 5→6");
    const ref = v?.hiddenFiles?.["test/visible.test.js"];
    assert.ok(ref, "variant overrides the visible test at verify time");
    assert.match((await blobs.getText(ref)) ?? "", /add\(2, 3\), 6/);
  });

  it("does not store a variant the no-op attempt passes (it is not impossible)", async () => {
    // Buggy add returns a+b+1 = 6, exactly the flipped expectation.
    const start = { ...BUGGY, "src/add.js": "export function add(a, b) {\n  return a + b + 1;\n}\n", "src/mul.js": FIXED["src/mul.js"] as string };
    const hidden = 'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nassert.equal(add(2, 3), 5);\n';
    const { blobs, git, task, workRoot } = await setup({ start, hidden });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.impossible?.gameable, false);
    assert.equal(o.report.impossible?.variant?.noopFails, false);
    assert.equal(o.report.impossible?.variant?.hiddenFiles, undefined);
    assert.ok(o.notes.some((n) => /passed by the no-op attempt/.test(n)), o.notes.join("\n"));
    assert.equal(o.report.ok, true, "an unsound variant is not the verifier's fault");
  });

  it("notes when no variant can be built, and can be turned off", async () => {
    const hidden =
      'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nimport { mul } from "../src/mul.js";\n' +
      "const two = 2, three = 3, five = 5, six = 6;\nassert.ok(add(two, three) === five);\nassert.ok(mul(two, three) === six);\n";
    const { blobs, git, task, workRoot } = await setup({ hidden });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.impossible, undefined);
    assert.ok(o.notes.some((n) => /no impossible variant/.test(n)), o.notes.join("\n"));
    assert.equal(o.report.ok, true);
    const off = await (async () => {
      const s2 = await setup();
      return validateTask({ task: s2.task, blobs: s2.blobs, git: s2.git, workRoot: s2.workRoot, k: 1, impossible: false });
    })();
    assert.equal(off.report.impossible, undefined);
    assert.equal(off.steps.filter((s) => s.kind === "impossible").length, 0);
  });

  it("skips the impossible check when the reference never passes", async () => {
    const { blobs, git, task, workRoot } = await setup({ verifier: "node test/add.test.js && false" });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.impossible, undefined);
    assert.equal(o.steps.filter((s) => s.kind === "impossible").length, 0);
  });
});

// A repo with its own node:test suite, run by `npm test` (auto-detected from package.json).
const EXISTING_SUITE =
  'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/sub.js";\nimport { readFileSync } from "node:fs";\n' +
  'test("sub works", () => assert.equal(sub(5, 3), 2));\n' +
  'test("readme has a title", () => assert.match(readFileSync("README.md", "utf8"), /^# /));\n' +
  'test("legacy is broken", () => assert.equal(1, 2));\n';
const P2P_START: Tree = { ...BUGGY, "src/sub.js": "export function sub(a, b) {\n  return a - b;\n}\n", "test/existing.test.mjs": EXISTING_SUITE };
const P2P_END: Tree = { ...P2P_START, "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
// Only touches README, so it applies to the start tree and leaves add/mul broken.
const README_NEAR_MISS = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# toy\n+# toy!\n";

describe("validateTask: pass-to-pass", () => {
  it("passes when every pre-existing test that passed before still passes (failing-before tests excluded)", async () => {
    const { blobs, git, task, workRoot } = await setup({ start: P2P_START, end: P2P_END });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1, nearMisses: [README_NEAR_MISS] });
    assert.deepEqual(o.report.passToPass, { command: "npm test", passed: 2, of: 2, broken: [], granularity: "tests" });
    assert.equal(o.report.ok, true, [...o.errors, ...o.notes].join("\n"));
    assert.deepEqual(
      o.steps.filter((s) => s.kind === "pass-to-pass").map((s) => s.label),
      ["suite before reference", "suite after reference"],
    );
    assert.match(formatValidation(o), /ok {3}pass-to-pass 2\/2 `npm test`/);
    const npmLogs = join(fakeHome, ".npm", "_logs");
    assert.deepEqual(existsSync(npmLogs) ? await readdir(npmLogs) : [], [], "npm debug logs go to a throwaway dir, not ~/.npm/_logs");
    assert.deepEqual(await readdir(workRoot), [], "suite dirs and the npm log dir are cleaned up");
  });

  it("fails a reference that breaks a pre-existing passing test the verifier does not cover", async () => {
    const end = { ...P2P_END, "src/sub.js": "export function sub(a, b) {\n  return a + b;\n}\n" };
    const { blobs, git, task, workRoot } = await setup({ start: P2P_START, end });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1, nearMisses: [README_NEAR_MISS] });
    assert.deepEqual(o.report.referencePasses, { passed: 1, of: 1 }, "the verifier alone accepts the reference");
    assert.deepEqual(o.report.passToPass, { command: "npm test", passed: 1, of: 2, broken: ["sub works"], granularity: "tests" });
    assert.equal(o.report.ok, false);
    assert.equal(o.task.status, "draft");
    assert.ok(o.notes.some((n) => /reference breaks 1 pre-existing test\(s\): sub works/.test(n)), o.notes.join("\n"));
    assert.match(formatValidation(o), /FAIL pass-to-pass 1\/2 `npm test`/);
  });

  it("counts a deleted pre-existing test as broken", async () => {
    const end: Tree = { ...P2P_END, "test/existing.test.mjs": EXISTING_SUITE.replace(/test\("readme has a title".*\n/, "") };
    const { blobs, git, task, workRoot } = await setup({ start: P2P_START, end });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1, nearMisses: [README_NEAR_MISS], impossible: false });
    assert.deepEqual(o.report.passToPass?.broken, ["readme has a title"]);
    assert.ok(o.notes.some((n) => /1 no longer run/.test(n)), o.notes.join("\n"));
    assert.equal(o.report.ok, false);
  });

  it("uses an explicit command, then task.meta.suiteCommand, before detection; false disables it", async () => {
    const { blobs, git, task, workRoot } = await setup({ start: P2P_START, end: P2P_END });
    const base: ValidateOpts = { task, blobs, git, workRoot, k: 1, nearMisses: [README_NEAR_MISS], impossible: false };
    const explicit = await validateTask({ ...base, passToPass: "node --test test/existing.test.mjs" });
    assert.equal(explicit.report.passToPass?.command, "node --test test/existing.test.mjs");
    assert.deepEqual([explicit.report.passToPass?.passed, explicit.report.passToPass?.of], [2, 2]);

    const meta = await validateTask({ ...base, task: { ...task, meta: { suiteCommand: "test -f src/sub.js" } } });
    assert.deepEqual(meta.report.passToPass, { command: "test -f src/sub.js", passed: 1, of: 1, broken: [], granularity: "exit" });

    const off = await validateTask({ ...base, passToPass: false });
    assert.equal(off.report.passToPass, undefined);
    assert.equal(off.steps.filter((s) => s.kind === "pass-to-pass").length, 0);
  });

  it("falls back to the suite's exit status when it prints no per-test results", async () => {
    const end = { ...P2P_END };
    delete end["src/sub.js"];
    const { blobs, git, task, workRoot } = await setup({ start: P2P_START, end });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1, nearMisses: [README_NEAR_MISS], impossible: false, passToPass: { command: "test -f src/sub.js" } });
    assert.deepEqual(o.report.passToPass, { command: "test -f src/sub.js", passed: 0, of: 1, broken: ["(suite exit status)"], granularity: "exit" });
    assert.equal(o.report.ok, false);
  });

  it("skips with a note when no suite command can be found", async () => {
    const start = { ...BUGGY, "package.json": '{"name":"toy"}\n' };
    const { blobs, git, task, workRoot } = await setup({ start, end: { ...FIXED, "package.json": '{"name":"toy"}\n' } });
    const o = await validateTask({ task, blobs, git, workRoot, k: 1 });
    assert.equal(o.report.passToPass, undefined);
    assert.ok(o.notes.some((n) => /pass-to-pass skipped: no suite command/.test(n)), o.notes.join("\n"));
    assert.equal(o.report.ok, true);
  });
});
