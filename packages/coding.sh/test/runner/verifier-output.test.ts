import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/core/redact.ts";
import type { RunResult } from "../../src/core/types.ts";
import { cleanStream, failedRuns, outputExcerpt, renderFailedRuns, VERIFIER_OUTPUT_CHARS, verifierOutput } from "../../src/runner/verifier-output.ts";

const KEY = ["sk-ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("");
const r = createRedactor();

describe("verifier output", () => {
  it("drops colour codes and progress redraws, and trailing blank lines", () => {
    const s = "\x1b[1m\x1b[31mFAIL\x1b[0m test/add.test.js\r\n  ✕ adds \x1b]8;;file:///x\x07link\x1b]8;;\x07\n10%\r50%\r100%\r\n\n\n";
    assert.equal(cleanStream(s, r), "FAIL test/add.test.js\n  ✕ adds link\n100%");
  });

  it("redacts secrets before it trims, so a key cut by the trim is not left half-visible", () => {
    // One long line: the trim cuts into the key, and no line start is near the cut.
    const body = `token ${KEY} ` + "x".repeat(VERIFIER_OUTPUT_CHARS - 20);
    const out = cleanStream(body, r);
    assert.doesNotMatch(out, /sk-ant|0123456789/);
    assert.ok(out.length <= VERIFIER_OUTPUT_CHARS + 2);
    const short = cleanStream(`expected 5, got -1\nAPI key ${KEY}`, r);
    assert.equal(short, "expected 5, got -1\nAPI key [redacted:anthropic-key]");
  });

  it("keeps the end of a long stream and starts it on a whole line", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const out = cleanStream(lines, r);
    assert.ok(out.length <= VERIFIER_OUTPUT_CHARS + 2, String(out.length));
    assert.match(out, /^…\nline \d+\n/);
    assert.match(out, /line 1999$/);
  });

  it("drops the first line of a tail that filled exec's buffer, where a secret may have been cut in two", () => {
    // Multi-byte text: 8 KB of it is fewer than 4096 characters, so the cut line would survive the trim.
    const cut = KEY.slice(12) + " leaked?\n" + "€".repeat(2800) + "\nFAIL";
    assert.ok(Buffer.byteLength(cut) >= 8192);
    const o = verifierOutput({ stdoutTail: cut, stderrTail: "" });
    assert.doesNotMatch(o?.stdout ?? "", /0123456789|leaked/);
    assert.match(o?.stdout ?? "", /\nFAIL$/);
    assert.equal(verifierOutput({ stdoutTail: `${KEY.slice(12)} short`, stderrTail: "" })?.stdout, `${KEY.slice(12)} short`, "a tail under the buffer size is whole");
  });

  it("uses the capture redactor's own patterns", () => {
    const custom = createRedactor({ redact: ["secrets"], patterns: ["ACME-\\d{6}"] });
    assert.equal(verifierOutput({ stdoutTail: "order ACME-123456 failed", stderrTail: "" }, custom)?.stdout, "order [redacted:pattern] failed");
  });

  it("is absent when the verifier printed nothing, and keeps only the streams that have text", () => {
    assert.equal(verifierOutput({ stdoutTail: "", stderrTail: " \n\x1b[0m\n" }), undefined);
    assert.deepEqual(verifierOutput({ stdoutTail: "", stderrTail: "boom\n" }), { stderr: "boom" });
  });

  it("lists failed runs with their output, leaving out cancelled, superseded and infrastructure failures", () => {
    const base = { bundleId: "b1", agent: {} as RunResult["agent"], endedAt: 0 };
    const runs: RunResult[] = [
      { ...base, id: "r1", taskId: "t1", attempt: 1, pass: true, verifierExit: 0, startedAt: 1 },
      { ...base, id: "r2", taskId: "t1", attempt: 2, pass: false, verifierExit: 1, startedAt: 2, verifierOutput: { stdout: "a\nb\nc", stderr: "AssertionError: 4 !== 5" } },
      { ...base, id: "r3", taskId: "t2", attempt: 1, pass: false, verifierExit: null, startedAt: 3, cancelled: true },
      { ...base, id: "r4", taskId: "t2", attempt: 1, pass: false, verifierExit: null, startedAt: 4, infra: "rate-limit" },
      { ...base, id: "r5", taskId: "t2", attempt: 1, pass: false, verifierExit: 1, startedAt: 5, error: "agent timed out" },
    ];
    const f = failedRuns(runs);
    assert.deepEqual(f.map((x) => x.runId), ["r2", "r5"]);
    assert.deepEqual(f[0]!.verifierOutput, { stdout: "a\nb\nc", stderr: "AssertionError: 4 !== 5" });
    assert.equal(f[1]!.error, "agent timed out");
    assert.equal(f[1]!.verifierOutput, undefined);
    assert.deepEqual(outputExcerpt(f[0]!.verifierOutput, 2), { lines: ["c", "AssertionError: 4 !== 5"], fromFailure: false });
    const text = renderFailedRuns(f, { names: (id) => (id === "t1" ? "adds" : id), lines: 2 }).join("\n");
    assert.match(text, /^Verifier output of failed runs \(last 2 lines\):\n {2}adds · attempt 2 {2}exit 1 · r2\n {4}│ c\n {4}│ AssertionError: 4 !== 5$/);
    assert.deepEqual(renderFailedRuns([f[1]!]), [], "no block when no failed run kept output");
  });

  it("says why the agent failed when it exited non-zero or timed out, with the end of its stderr, redacted", () => {
    const agent = (a: Partial<RunResult["agent"]>): RunResult["agent"] => ({ exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "", ...a });
    const base = { bundleId: "b1", endedAt: 0, pass: false, verifierExit: 1, attempt: 1 };
    const runs: RunResult[] = [
      { ...base, id: "r1", taskId: "t1", startedAt: 1, agent: agent({ exitCode: 1, stderrTail: "\x1b[31mError:\x1b[0m --dangerously-skip-permissions cannot be used with root\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n" }) },
      { ...base, id: "r2", taskId: "t1", startedAt: 2, agent: agent({ exitCode: null, timedOut: true }) },
      { ...base, id: "r3", taskId: "t1", startedAt: 3, agent: agent({ exitCode: 0, stderrTail: "warning: noisy but fine" }) },
      { ...base, id: "r4", taskId: "t1", startedAt: 4, agent: agent({ exitCode: null }) },
    ];
    const f = failedRuns(runs);
    assert.equal(f[0]!.agent?.exitCode, 1);
    assert.match(f[0]!.agent!.stderr!, /^Error: --dangerously-skip-permissions cannot be used with root\nkey /);
    assert.doesNotMatch(f[0]!.agent!.stderr!, /sk-ant-api03/, "stderr is redacted");
    assert.deepEqual(f[1]!.agent, { exitCode: null, timedOut: true });
    assert.equal(f[2]!.agent, undefined, "an agent that exited 0 failed nothing");
    assert.equal(f[3]!.agent, undefined, "an agent that never ran has no exit to report");
    const text = renderFailedRuns(f, { lines: 2 }).join("\n");
    assert.match(text, /^Failed runs:\n {2}t1 · attempt 1 {2}exit 1 · r1\n {4}the agent exited 1, its stderr ends:\n {4}! Error: --dangerously-skip-permissions cannot be used with root\n {4}! key \S+\n {2}t1 · attempt 1 {2}exit 1 · r2\n {4}the agent timed out$/);
  });
});

describe("verifier output of a failed test run", () => {
  const run = (id: string, stdout: string, stderr = ""): RunResult => ({ id, taskId: "t1", bundleId: "b1", attempt: 1, pass: false, verifierExit: 1, startedAt: 1, endedAt: 2, agent: {} as RunResult["agent"], verifierOutput: verifierOutput({ stdoutTail: stdout, stderrTail: stderr }) });
  /** The lines the report shows for one failed run, without the block's heading and the run's line. */
  const shown = (stdout: string, stderr = "") => renderFailedRuns(failedRuns([run("r1", stdout, stderr)])).slice(2).map((l) => l.replace(/^ {4}│ /, ""));

  // Real output, paths scrubbed: Node 24, `node --test` piped, as a verifier runs it. The spec reporter lists failures after the summary.
  const SPEC = ["✔ adds (0.7953ms)", "✖ subtracts (0.8264ms)", "ℹ tests 2", "ℹ suites 0", "ℹ pass 1", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 82.8318", "", "✖ failing tests:", "", "test at test/math.test.js:4:1", "✖ subtracts (0.8264ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "  ", "  2 !== 1", "  ", "      at TestContext.<anonymous> (/work/demo/test/math.test.js:4:34)", "      at Test.runInAsyncScope (node:async_hooks:227:14)", "      at Test.run (node:internal/test_runner/test:1397:25)", "      at Test.processPendingSubtests (node:internal/test_runner/test:969:18)", "      at Test.postRun (node:internal/test_runner/test:1537:19)", "      at Test.run (node:internal/test_runner/test:1462:12)", "      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {", "    generatedMessage: true,", "    code: 'ERR_ASSERTION',", "    actual: 2,", "    expected: 1,", "    operator: 'strictEqual',", "    diff: 'simple'", "  }"].join("\n");
  const NPM_NOTICE = ["npm notice", "npm notice New major version of npm available! 11.19.0 -> 12.2.3", "npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.3", "npm notice To update run: npm install -g npm@12.2.3", "npm notice"].join("\n");
  // Real output: Node 24, `node --test --test-reporter=tap`. Its last 8 lines are the summary.
  const TAP = ["TAP version 13", "# Subtest: adds", "ok 1 - adds", "  ---", "  duration_ms: 0.8639", "  type: 'test'", "  ...", "# Subtest: subtracts", "not ok 2 - subtracts", "  ---", "  duration_ms: 0.9478", "  type: 'test'", "  location: '/work/demo/test/math.test.js:4:1'", "  failureType: 'testCodeFailure'", "  error: |-", "    Expected values to be strictly equal:", "    ", "    2 !== 1", "    ", "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", "  expected: 1", "  actual: 2", "  operator: 'strictEqual'", "  stack: |-", "    TestContext.<anonymous> (/work/demo/test/math.test.js:4:34)", "    Test.runInAsyncScope (node:async_hooks:227:14)", "  ...", "1..2", "# tests 2", "# suites 0", "# pass 1", "# fail 1", "# cancelled 0", "# skipped 0", "# todo 0", "# duration_ms 106.6198"].join("\n");
  // Real output: cargo test. The compile lines on stderr come after the panic.
  const CARGO_OUT = ["", "running 2 tests", "test tests::adds ... ok", "test tests::subtracts ... FAILED", "", "failures:", "", "---- tests::subtracts stdout ----", "", "thread 'tests::subtracts' (58948) panicked at src/lib.rs:8:22:", "assertion `left == right` failed", "  left: 2", " right: 1", "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace", "", "", "failures:", "    tests::subtracts", "", "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s", ""].join("\n");
  const CARGO_ERR = ["   Compiling m v0.1.0 (/work/demo)", "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.82s", "     Running unittests src/lib.rs (target/debug/deps/m-1a2b3c)", "error: test failed, to rerun pass `--lib`"].join("\n");
  // Real output: pytest 9.1, go test, and go test -v, which prints what a test logged before its FAIL line.
  const GO_V = ["=== RUN   TestAdd", "--- PASS: TestAdd (0.00s)", "=== RUN   TestSub", "    m_test.go:13: got 2, want 1", "--- FAIL: TestSub (0.00s)", "FAIL", "FAIL\texample.com/m\t0.051s", "FAIL"].join("\n");
  const PYTEST = ["============================= test session starts =============================", "platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.6.0", "rootdir: /work/demo", "collected 2 items", "", "test_math.py .F                                                          [100%]", "", "================================== FAILURES ===================================", "________________________________ test_subtract ________________________________", "", "    def test_subtract():", ">       assert 3 - 1 == 1", "E       assert (3 - 1) == 1", "", "test_math.py:5: AssertionError", "=========================== short test summary info ===========================", "FAILED test_math.py::test_subtract - assert (3 - 1) == 1", "========================= 1 failed, 1 passed in 0.12s ========================="].join("\n");
  const GO = ["--- FAIL: TestSub (0.00s)", "    m_test.go:13: got 2, want 1", "FAIL", "FAIL\texample.com/m\t0.050s", "FAIL"].join("\n");
  // Jest (on stderr) and mocha, in the shape they print.
  const JEST = ["FAIL ./math.test.js", "  math", "    ✓ adds (2 ms)", "    ✓ multiplies (1 ms)", "    ✓ divides (1 ms)", "    ✕ subtracts (3 ms)", "", "  ● math › subtracts", "", "    expect(received).toBe(expected) // Object.is equality", "", "    Expected: 1", "    Received: 2", "", '      5 |   test("subtracts", () => {', "    > 6 |     expect(3 - 1).toBe(1);", "        |                   ^", "      7 |   });", "", "      at Object.toBe (math.test.js:6:19)", "", "Test Suites: 1 failed, 1 total", "Tests:       1 failed, 3 passed, 4 total", "Snapshots:   0 total", "Time:        0.312 s", "Ran all test suites."].join("\n");
  const MOCHA = ["", "", "  math", "    ✔ adds", "    1) subtracts", "", "", "  1 passing (5ms)", "  1 failing", "", "  1) math", "       subtracts:", "", "      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "2 !== 1", "", "      + expected - actual", "", "      -2", "      +1", "      ", "      at Context.<anonymous> (test/math.test.js:6:12)", "      at process.processImmediate (node:internal/timers:483:21)", ""].join("\n");

  it("starts at the first failing test the runner reports, so the lines name it and its error", () => {
    assert.deepEqual(shown(SPEC, NPM_NOTICE).slice(0, 5), ["test at test/math.test.js:4:1", "✖ subtracts (0.8264ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "  2 !== 1", "      at TestContext.<anonymous> (/work/demo/test/math.test.js:4:34)"]);
    assert.equal(shown(SPEC, NPM_NOTICE).length, 8);
    assert.deepEqual(shown(TAP), ["not ok 2 - subtracts", "  duration_ms: 0.9478", "  type: 'test'", "  location: '/work/demo/test/math.test.js:4:1'", "  failureType: 'testCodeFailure'", "  error: |-", "    Expected values to be strictly equal:", "    2 !== 1"]);
    assert.deepEqual(shown(CARGO_OUT, CARGO_ERR), ["---- tests::subtracts stdout ----", "thread 'tests::subtracts' (58948) panicked at src/lib.rs:8:22:", "assertion `left == right` failed", "  left: 2", " right: 1", "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace", "failures:", "    tests::subtracts"]);
    assert.deepEqual(shown(PYTEST), ["________________________________ test_subtract ________________________________", "    def test_subtract():", ">       assert 3 - 1 == 1", "E       assert (3 - 1) == 1", "test_math.py:5: AssertionError", "=========================== short test summary info ===========================", "FAILED test_math.py::test_subtract - assert (3 - 1) == 1", "========================= 1 failed, 1 passed in 0.12s ========================="]);
    assert.deepEqual(shown(GO), GO.split("\n"));
    assert.deepEqual(shown(GO_V), GO_V.split("\n").slice(2));
    assert.deepEqual(shown("", JEST), ["  ● math › subtracts", "    expect(received).toBe(expected) // Object.is equality", "    Expected: 1", "    Received: 2", '      5 |   test("subtracts", () => {', "    > 6 |     expect(3 - 1).toBe(1);", "      7 |   });", "      at Object.toBe (math.test.js:6:19)"]);
    assert.deepEqual(shown(MOCHA).slice(0, 4), ["  1) math", "       subtracts:", "      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "2 !== 1"]);
    assert.deepEqual(shown("not ok 1 - parses dates # TODO\nnot ok 2 - adds\n  ---\n  error: 'boom'\n1..2\n# fail 1").slice(0, 2), ["not ok 2 - adds", "  error: 'boom'"], "a TAP to-do is not a failure");
  });

  it("keeps the last lines of other output, and its heading says which lines it shows", () => {
    assert.deepEqual(shown("building\n\nexpected 5, got -1\n---"), ["building", "expected 5, got -1"], "blank lines and lines of only symbols are left out");
    assert.deepEqual(shown("running 1 test\nfailures:\n"), ["running 1 test", "failures:"], "a failure heading with nothing under it");
    const heading = (...runs: RunResult[]) => renderFailedRuns(failedRuns(runs), { lines: 2 })[0];
    assert.equal(heading(run("r1", "expected 5, got -1")), "Verifier output of failed runs (last 2 lines):");
    assert.equal(heading(run("r1", GO)), "Verifier output of failed runs (2 lines from the first failing test):");
    assert.equal(heading(run("r1", GO), run("r2", "expected 5, got -1")), "Verifier output of failed runs (2 lines from the first failing test, or the last 2):");
  });
});
