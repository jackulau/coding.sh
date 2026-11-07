import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { comparePassToPass, detectSuiteCommand, parseTestResults } from "../../src/eval/suite.ts";
import { tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const obj = (m: Map<string, string>) => Object.fromEntries(m);

describe("parseTestResults", () => {
  it("parses node --test TAP, including nested subtests and SKIP/TODO", () => {
    const tap = [
      "TAP version 13",
      "# Subtest: math",
      "    # Subtest: adds",
      "    ok 1 - adds",
      "    not ok 2 - divides",
      "    ok 3 - later # SKIP not yet",
      "    1..3",
      "not ok 1 - math",
      "ok 2 - todo thing # TODO",
      "  error: 'ok 7 is not a test line without the number'",
      "ok so this is prose",
    ].join("\n");
    assert.deepEqual(obj(parseTestResults(tap)), { adds: "pass", divides: "fail", later: "skip", math: "fail", "todo thing": "skip" });
  });

  it("parses pytest -v / -rA, go test -v, cargo test and spec reporters", () => {
    const out = [
      "tests/test_a.py::test_one PASSED                                  [ 50%]",
      "tests/test_a.py::test_two FAILED                                  [100%]",
      "PASSED tests/test_b.py::test_three",
      "XFAIL tests/test_b.py::test_four - reason",
      "--- PASS: TestAdd (0.00s)",
      "    --- FAIL: TestAdd/negative (0.00s)",
      "test parser::tests::roundtrip ... ok",
      "test parser::tests::slow ... ignored",
      "✔ spec passes (1.2ms)",
      "  ✖ spec fails (0.3ms)",
      "  ✓ jest style (3 ms)",
    ].join("\n");
    assert.deepEqual(obj(parseTestResults(out)), {
      "tests/test_a.py::test_one": "pass",
      "tests/test_a.py::test_two": "fail",
      "tests/test_b.py::test_three": "pass",
      "tests/test_b.py::test_four": "skip",
      TestAdd: "pass",
      "TestAdd/negative": "fail",
      "parser::tests::roundtrip": "pass",
      "parser::tests::slow": "skip",
      "spec passes": "pass",
      "spec fails": "fail",
      "jest style": "pass",
    });
  });

  it("a name seen twice keeps its worst status (spec reporters repeat failures in a summary)", () => {
    assert.equal(parseTestResults("✔ dup (1ms)\n✖ dup (2ms)\n✔ dup (1ms)").get("dup"), "fail");
  });
});

describe("comparePassToPass", () => {
  const run = (output: string, exitCode = 0) => ({ exitCode, timedOut: false, output });

  it("tests that passed before must pass after; failing-before tests do not count; vanished tests are broken", () => {
    const before = run("ok 1 - a\nok 2 - b\nok 3 - c\nnot ok 4 - legacy", 1);
    const after = run("ok 1 - a\nnot ok 2 - b\nnot ok 3 - legacy\nok 4 - new", 1);
    assert.deepEqual(comparePassToPass(before, after), { passed: 1, of: 3, broken: ["b", "c"], missing: ["c"], granularity: "tests" });
    assert.deepEqual(comparePassToPass(before, run("ok 1 - a\nok 2 - b\nok 3 - c")), { passed: 3, of: 3, broken: [], missing: [], granularity: "tests" });
  });

  it("falls back to exit statuses when no per-test results can be parsed", () => {
    assert.deepEqual(comparePassToPass(run("all good"), run("boom", 1)), { passed: 0, of: 1, broken: ["(suite exit status)"], missing: [], granularity: "exit" });
    assert.deepEqual(comparePassToPass(run("all good"), run("still good")), { passed: 1, of: 1, broken: [], missing: [], granularity: "exit" });
    assert.deepEqual(comparePassToPass(run("broken already", 2), run("boom", 1)), { passed: 0, of: 0, broken: [], missing: [], granularity: "exit" });
    assert.deepEqual(comparePassToPass(run(""), { exitCode: null, timedOut: true, output: "" }).passed, 0);
  });
});

describe("detectSuiteCommand", () => {
  const repo = async (files: Record<string, string>) => {
    const d = await tempDir("csh-suite-");
    dirs.push(d);
    for (const [k, v] of Object.entries(files)) await writeFile(join(d, k), v);
    return d;
  };

  it("detects npm/pnpm/yarn test scripts, pytest, go and cargo; ignores npm's placeholder", async () => {
    assert.equal(await detectSuiteCommand(await repo({ "package.json": '{"scripts":{"test":"node --test"}}' })), "npm test");
    assert.equal(await detectSuiteCommand(await repo({ "package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "" })), "pnpm test");
    assert.equal(await detectSuiteCommand(await repo({ "package.json": '{"scripts":{"test":"jest"}}', "yarn.lock": "" })), "yarn test");
    assert.equal(await detectSuiteCommand(await repo({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), undefined);
    assert.equal(await detectSuiteCommand(await repo({ "pyproject.toml": "[tool.pytest.ini_options]\n" })), "python -m pytest -rA");
    assert.equal(await detectSuiteCommand(await repo({ "go.mod": "module x\n" })), "go test -v ./...");
    assert.equal(await detectSuiteCommand(await repo({ "Cargo.toml": "[package]\n" })), "cargo test");
    assert.equal(await detectSuiteCommand(await repo({ "README.md": "# hi\n" })), undefined);
  });
});
