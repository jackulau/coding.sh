import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISCLOSURE,
  detectTestTamperTrace,
  foldTamper,
  isProtectedPath,
  normalizeTracePath,
  shellWrites,
  tamperHigh,
  tamperState,
  TEST_PATH,
  type TamperState,
  type TamperTraceOpts,
  type TestTamperFinding,
} from "../../src/core/intent.ts";
import { detectFlags, FLAGS } from "../../src/core/sessions.ts";
import { shellDiffOrigin } from "../../src/core/shell-diff.ts";
import { TEST_PATH as PREDICATE_TEST_PATH } from "../../src/judge/predicates.ts";
import { SKIP_MARKERS as RUNNER_SKIP } from "../../src/runner/tamper.ts";
import { SKIP_MARKERS } from "../../src/core/intent.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++t}`,
  v: 0,
  sessionId: "s",
  ts: 1000 + t * 10,
  agent: "claude-code",
  kind,
  payload,
  ...o,
});
const result = (failed: number, passed = 3) => ev("test.result", { runner: "pytest", passed, failed });
const say = (text: string, o: Partial<AgentEvent> = {}) => ev("assistant.message", { text }, o);
/** A file tool call: tool.start, tool.end, then its file.change. */
function edit(path: string, diff: string | undefined, op = "modify", tool = "Edit", o: Partial<AgentEvent> = {}): AgentEvent[] {
  const id = `tu${t + 1}`;
  return [
    ev("tool.start", { tool, toolUseId: id, input: { file_path: path } }, o),
    ev("tool.end", { tool, toolUseId: id, ok: true }, o),
    ev("file.change", { path, op, tool, toolUseId: id, ...(diff ? { diff } : {}) }, o),
  ];
}
function bash(command: string, description?: string, o: Partial<AgentEvent> = {}): AgentEvent[] {
  const id = `tu${t + 1}`;
  return [ev("tool.start", { tool: "Bash", toolUseId: id, input: { command, ...(description ? { description } : {}) } }, o), ev("tool.end", { tool: "Bash", toolUseId: id, ok: true }, o)];
}
const WEAKEN = "--- a/tests/test_calc.py\n+++ b/tests/test_calc.py\n@@ -1,2 +1,2 @@\n def test_add():\n-    assert add(2, 2) == 5\n+    assert add(2, 2) == 4\n";
const ADDITIVE = "--- a/tests/test_calc.py\n+++ b/tests/test_calc.py\n@@ -3,0 +4,3 @@\n+\n+def test_new():\n+    assert add(1, 1) == 2\n";

/** The fold live ingest keeps (foldTamper), fed one event at a time in time order. */
function folded(events: readonly AgentEvent[]): TamperState {
  const s = tamperState();
  for (const e of events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)) foldTamper(s, e.e);
  return s;
}
/** detectTestTamperTrace, checking that the fold reaches the same `test-tamper` flag (or defers to the events). */
function trace(events: readonly AgentEvent[], opts?: TamperTraceOpts): TestTamperFinding[] {
  const findings = detectTestTamperTrace(events, opts);
  const s = folded(events);
  if (!opts && !s.needsEvents) assert.equal(tamperHigh(s), findings.some((f) => f.severity === "high"), "foldTamper agrees with detectTestTamperTrace");
  return findings;
}

describe("detectTestTamperTrace", () => {
  it("failing → weaken a test after stating it is wrong → passing: high, flippedGreen, disclosed", () => {
    const before = result(1);
    const words = say("The test expecting 5 is incorrect, I'll fix the expectation.");
    const change = edit("tests/test_calc.py", WEAKEN);
    const after = result(0, 4);
    const events = [before, words, ...change, ...bash("pytest"), after];
    const [f, ...rest] = trace(events);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { ...f, ts: undefined },
      {
        eventId: change[2]!.id,
        toolUseId: change[0]!.payload.toolUseId,
        tool: "Edit",
        ts: undefined,
        path: "tests/test_calc.py",
        via: "file",
        shape: "weaken",
        severity: "high",
        flippedGreen: true,
        disclosed: true,
        intent: "The test expecting 5 is incorrect, I'll fix the expectation.",
        intentSource: "assistant-text",
        beforeTestEventId: before.id,
        afterTestEventId: after.id,
      },
    );
    assert.ok(detectFlags(events).includes(FLAGS.testTamper));
  });

  it("a source edit between the results: not flippedGreen, info, no flag", () => {
    const events = [result(1), say("The test expecting 5 is incorrect"), ...edit("tests/test_calc.py", WEAKEN), ...edit("src/calc.py", "-a\n+b\n"), result(0)];
    const [f] = trace(events);
    assert.equal(f?.flippedGreen, false);
    assert.equal(f?.severity, "info");
    assert.ok(!detectFlags(events).includes(FLAGS.testTamper));
  });

  it("a shell write to source between the results also breaks flippedGreen", () => {
    const events = [result(1), ...edit("tests/test_calc.py", WEAKEN), ...bash("cat > src/calc.py <<'EOF'\ndef add(a, b):\n    return a + b\nEOF"), result(0)];
    assert.equal(trace(events)[0]?.flippedGreen, false);
  });

  it("the test run's own output redirect does not count as a fix", () => {
    const head = [result(1), ...edit("tests/test_calc.py", WEAKEN)];
    const run = bash("pytest > out.log 2>&1");
    const after = ev("test.result", { passed: 4, failed: 0, toolUseId: run[0]!.payload.toolUseId });
    const events = [...head, ...run, after];
    assert.equal(trace(events)[0]?.flippedGreen, true);
  });

  it("adding a test is additive and info", () => {
    const events = [result(1), say("Add regression test for parser"), ...edit("tests/test_calc.py", ADDITIVE), result(0)];
    const [f] = trace(events);
    assert.equal(f?.shape, "additive");
    assert.equal(f?.severity, "info");
    assert.equal(f?.disclosed, false);
    assert.ok(!detectFlags(events).includes(FLAGS.testTamper));
    const created = trace([...edit("tests/test_new.py", "+def test_x():\n+    assert 1\n", "add", "Write")]);
    assert.equal(created[0]?.shape, "additive");
  });

  it("sed -i on a test file with a description: shell, unknown, declared, disclosed, high between failing and passing", () => {
    const before = result(2);
    const cmd = bash("sed -i 's/== 5/== 4/' tests/test_calc.py", "Adjust expected value");
    const [f] = trace([before, ...cmd, result(0)]);
    assert.equal(f?.via, "shell");
    assert.equal(f?.shape, "unknown");
    assert.equal(f?.eventId, cmd[0]!.id);
    assert.equal(f?.intentSource, "declared");
    assert.equal(f?.intent, "Adjust expected value");
    assert.equal(f?.disclosed, true);
    assert.equal(f?.severity, "high");
    assert.equal(f?.tool, "Bash");
  });

  it("sed -i and rm on a test file through Antigravity's run_command or Droid's Execute, as through Bash", () => {
    // Shaped as the adapters store them (test/fixtures/adapters/antigravity, droid).
    const shells: [string, (command: string) => Record<string, unknown>][] = [
      ["Bash", (command) => ({ command })],
      ["run_command", (command) => ({ CommandLine: command, Cwd: "/work/demo" })],
      ["Execute", (command) => ({ command })],
    ];
    const call = (tool: string, input: Record<string, unknown>) => {
      const id = `tu${t + 1}`;
      return [ev("tool.start", { tool, toolUseId: id, input }), ev("tool.end", { tool, toolUseId: id, ok: true })];
    };
    for (const [tool, input] of shells) {
      const [f] = trace([result(2), ...call(tool, input("sed -i 's/== 5/== 4/' tests/test_calc.py")), result(0)]);
      assert.deepEqual([f?.via, f?.shape, f?.severity, f?.tool], ["shell", "unknown", "high", tool], tool);
      const [rm] = trace([result(2), ...call(tool, input("rm -f tests/test_old.py"))]);
      assert.deepEqual([rm?.shape, rm?.severity], ["delete", "high"], tool);
    }
  });

  it("a file change by a Codex code-mode cell is an edit, in the fold as in the trace: the cell's input is JavaScript, not a command", () => {
    const id = `tu${t + 1}`;
    const cell = 'text(await tools.exec_command({ cmd: "node fix.js" }))';
    const diff = "--- a/tests/a.test.js\n+++ b/tests/a.test.js\n@@ -1 +1 @@\n-it('adds', () => {\n+it.skip('adds', () => {\n";
    const [f] = trace([
      ev("tool.start", { tool: "exec", toolUseId: id, wrapper: true, input: cell }),
      ev("file.change", { path: "tests/a.test.js", op: "modify", tool: "exec", toolUseId: id, diff }),
      ev("tool.end", { tool: "exec", toolUseId: id, wrapper: true, ok: true }),
    ]);
    assert.deepEqual([f?.via, f?.shape, f?.severity], ["file", "skip", "high"]);
  });

  it("a skip marker is high without any test result", () => {
    for (const [line, was] of [["@pytest.mark.skip", ""], ["it.skip('adds', () => {", "-it('adds', () => {\n"]] as const) {
      const diff = `--- a/tests/a.test.js\n+++ b/tests/a.test.js\n@@ -1 +1,2 @@\n${was}+${line}\n def x(): pass\n`;
      const [f] = trace(edit("tests/a.test.js", diff));
      assert.equal(f?.shape, "skip", line);
      assert.equal(f?.severity, "high", line);
      assert.equal(f?.flippedGreen, false);
    }
  });

  it("deleting a pre-existing test while tests fail is high; on green, or one the agent created, it is info", () => {
    assert.equal(trace([result(1), ...edit("tests/test_old.py", undefined, "delete", "delete_file")])[0]?.severity, "high");
    assert.equal(trace([result(0), ...edit("tests/test_old.py", undefined, "delete", "delete_file")])[0]?.severity, "info", "cleanup on green");
    const own = trace([result(1), ...edit("tests/tmp_test.py", "+x\n", "add", "Write"), ...edit("tests/tmp_test.py", undefined, "delete", "delete_file")]);
    assert.equal(own[1]?.shape, "delete");
    assert.equal(own[1]?.severity, "info");
    const rm = trace([result(2), ...bash("rm -f tests/test_old.py")]);
    assert.equal(rm[0]?.shape, "delete");
    assert.equal(rm[0]?.severity, "high");
    // Created by a shell redirect in an earlier call (cd'd into the repo), then removed: own scratch file.
    const scratch = trace([result(1), ...bash("cd /w && cat > tests/zz_probe_test.go <<'EOF'\nt.Skip()\nEOF", undefined, { cwd: "/w" }), ...bash("cd /w && rm tests/zz_*_test.go", undefined, { cwd: "/w" })]);
    assert.deepEqual(scratch.map((f) => [f.path, f.shape, f.severity]), [["tests/zz_probe_test.go", "unknown", "info"], ["tests/zz_*_test.go", "delete", "info"]]);
    // A rename that keeps the file a test is not a delete; media named like a test is not a test.
    assert.deepEqual(trace([result(1), ...bash("mv tests/a_test.py tests/b_test.py")]).map((f) => f.shape), ["unknown"]);
    assert.deepEqual(trace([result(1), ...bash("rm out/splice_test.mp4")]), []);
  });

  it("an edit with no diff is unknown; protected config and CI paths count; extra pattern and paths count", () => {
    assert.equal(trace(edit("tests/x.py", undefined))[0]?.shape, "unknown");
    assert.equal(trace(edit("pytest.ini", "-a\n+b\n")).length, 1);
    assert.equal(trace(edit(".github/workflows/ci.yml", "-a\n+b\n")).length, 1);
    assert.equal(trace(edit("checks/verify.sh", "-a\n+b\n")).length, 0);
    assert.equal(trace(edit("checks/verify.sh", "-a\n+b\n"), { pattern: /^checks\// }).length, 1);
    assert.equal(trace(edit("test-sum.js", "-a\n+b\n"), { paths: ["test-sum.js"] }).length, 1);
  });

  it("absolute paths are made repo-relative with the event's cwd", () => {
    const [f] = trace(edit("/work/tests/test_calc.py", WEAKEN, "modify", "Edit", { cwd: "/work" }));
    assert.equal(f?.path, "tests/test_calc.py");
    assert.equal(normalizeTracePath("C:\\w\\tests\\a.py", "C:\\w"), "tests/a.py");
    assert.equal(normalizeTracePath("./tests/a.py"), "tests/a.py");
  });

  it("sessions without test paths give no findings", () => {
    assert.deepEqual(trace([result(1), ...edit("src/calc.py", "-a\n+b\n"), ...bash("npm test"), result(0)]), []);
    assert.deepEqual(trace([]), []);
  });

  it("the fold defers to the events when only an earlier call can say whether a shell-written test existed", () => {
    // Read first, then overwritten from the shell, then green: an existing test was replaced.
    const replaced = [result(1), ...bash("cat tests/test_calc.py"), ...bash("printf 'def test_add(): pass' > tests/test_calc.py"), result(0)];
    // Never named before: a new file, the agent's own work.
    const fresh = [result(1), ...bash("printf 'def test_new(): pass' > tests/test_new.py"), result(0)];
    assert.equal(trace(replaced)[0]?.severity, "high");
    assert.equal(trace(fresh)[0]?.severity, "info");
    for (const events of [replaced, fresh]) assert.deepEqual([folded(events).needsEvents, folded(events).high], [true, false]);
    assert.ok(detectFlags(replaced).includes(FLAGS.testTamper));
    assert.ok(!detectFlags(fresh).includes(FLAGS.testTamper));
  });

  it("Codex shape: commentary message, then an apply_patch file.change", () => {
    const id = "call_1";
    const events = [
      result(1),
      ev("assistant.message", { text: "I'll update the expected value so the test passes.", phase: "commentary" }, { agent: "codex" }),
      ev("tool.start", { tool: "apply_patch", toolUseId: id, input: { command: "*** Begin Patch\n*** Update File: tests/test_calc.py\n@@\n-    assert add(2, 2) == 5\n+    assert add(2, 2) == 4\n*** End Patch" } }, { agent: "codex" }),
      ev("tool.end", { tool: "apply_patch", toolUseId: id, ok: true }, { agent: "codex" }),
      ev("file.change", { path: "tests/test_calc.py", op: "modify", tool: "apply_patch", toolUseId: id, diff: WEAKEN }, { agent: "codex" }),
      result(0),
    ];
    const fs = trace(events);
    assert.equal(fs.length, 1, "the patch passed as `command` is not read as a shell command");
    assert.equal(fs[0]?.intentSource, "assistant-text");
    assert.equal(fs[0]?.disclosed, true);
    assert.equal(fs[0]?.severity, "high");
  });

  it("another subagent's text is not the intent", () => {
    const events = [result(1), say("The test is wrong, I'll change the assertion.", { subagentId: "other" }), ...edit("tests/test_calc.py", WEAKEN, "modify", "Edit", { subagentId: "worker" }), result(0)];
    const [f] = trace(events);
    assert.equal(f?.intentSource, "none");
    assert.equal(f?.disclosed, false);
    assert.equal(f?.severity, "high", "stealth still counts");
  });

  it("text before the previous tool result is not the intent", () => {
    const events = [say("The test is wrong."), ...bash("ls"), ...edit("tests/test_calc.py", WEAKEN)];
    assert.equal(trace(events)[0]?.intentSource, "none");
  });

  it("intent is clipped to 300 characters", () => {
    const [f] = trace([say(`Refactor ${"x".repeat(400)}`), ...edit("tests/a.py", WEAKEN)]);
    assert.equal(f?.intent?.length, 300);
  });
});

/** A shell call and a file its dirty-tree diff reported (Claude Code's bashEditDiff → file.change, tool Bash). */
function bashDiff(command: string, path: string, diff: string | undefined, op = "modify"): AgentEvent[] {
  const [start, end] = bash(command);
  return [start!, end!, ev("file.change", { path, op, tool: "Bash", toolUseId: start!.payload.toolUseId, ...(diff ? { diff } : {}) })];
}
const SKIP_ADDED = "--- a/tests/a.test.js\n+++ b/tests/a.test.js\n@@ -1,2 +1,2 @@\n-it('adds', () => {\n+it.skip('adds', () => {\n   expect(add(1, 1)).toBe(2);\n";

describe("test-tamper false positives seen on real sessions", () => {
  it("a file a shell diff picked up without the command naming it: a git import is no finding, anything else is info", () => {
    assert.deepEqual(trace([result(1), ...bashDiff("git rebase --continue", "tests/a.test.js", SKIP_ADDED)]), []);
    const named = trace([...bashDiff("sed -i 's/^it(/it.skip(/' tests/a.test.js", "tests/a.test.js", SKIP_ADDED)]);
    assert.deepEqual(named.filter((f) => f.via === "file").map((f) => [f.shape, f.severity, f.attributed]), [["skip", "high", undefined]]);
    const [other] = trace([result(1), ...bashDiff("npm test", "tests/test_calc.py", WEAKEN), result(0)]);
    assert.deepEqual([other?.shape, other?.severity, other?.attributed], ["weaken", "info", false]);
    // A rebase that changes source between the red and the green run: the test edit did not turn it green.
    const rebased = trace([result(1), ...bashDiff("git -C /w rebase main", "src/calc.py", "-a\n+b\n"), ...edit("tests/test_calc.py", WEAKEN), result(0)]);
    assert.deepEqual(rebased.map((f) => [f.flippedGreen, f.severity]), [[false, "info"]]);
  });

  it("which command a shell diff's file came from", () => {
    const at = (command: string, path: string, tool = "Bash") => shellDiffOrigin(ev("file.change", { path, tool, toolUseId: "x" }), ev("tool.start", { tool, toolUseId: "x", input: { command } }));
    assert.equal(at("python3 - <<'EOF'\np='test/x.ts'\nEOF", "test/x.ts"), "named");
    assert.equal(at("cd pkg && sed -i 's/a/b/' test/*.test.ts", "pkg/test/y.test.ts"), "named");
    assert.equal(at("git -C /w reset --hard", "tests/a.py"), "vcs");
    assert.equal(at("git checkout -- tests/a.py", "tests/a.py"), "named");
    assert.equal(at("npm test", "tests/a.py"), "unattributed");
    assert.equal(at("", "tests/a.py", "Edit"), "edit");
  });

  it("a skip guard inside a test the hunk adds is not a skip; `def fit(` and `model.fit(` are not focus markers", () => {
    const guard = "--- a/test/cli.test.ts\n+++ b/test/cli.test.ts\n@@ -10,2 +10,6 @@\n });\n+\n+it(\"promotes without git\", (t) => {\n+  if (!gitBin) return t.skip(\"needs git\");\n+  assert.equal(run(), 0);\n+});\n";
    assert.deepEqual(trace(edit("test/cli.test.ts", guard)).map((f) => [f.shape, f.severity]), [["additive", "info"]]);
    const py = "--- a/tests/test_fit.py\n+++ b/tests/test_fit.py\n@@ -5,2 +5,6 @@\n \n+def test_ranks():\n+    torch = pytest.importorskip(\"torch\")\n+    def fit(c):\n+        return model.fit(c)\n";
    assert.deepEqual(trace(edit("tests/test_fit.py", py)).map((f) => [f.shape, f.severity]), [["additive", "info"]]);
    // A guard added to a test that was already there still counts.
    const existing = "--- a/test/cli.test.ts\n+++ b/test/cli.test.ts\n@@ -10,3 +10,4 @@\n it(\"promotes\", (t) => {\n+  return t.skip(\"later\");\n   assert.equal(run(), 0);\n";
    assert.equal(trace(edit("test/cli.test.ts", existing))[0]?.severity, "high");
  });

  it("a skip marker inside a string literal is test data, not a skip", () => {
    // A detector's own tests hold diffs and commands with markers in them, added to tests already there.
    const data = "--- a/test/intent.test.ts\n+++ b/test/intent.test.ts\n@@ -40,3 +40,5 @@\n it(\"finds skips\", () => {\n+  const cmd = \"sed -i 's/^it(/it.skip(/' tests/a.test.js\";\n+  const line = '+it.skip(\\'adds\\', () => {';\n   assert.ok(run());\n";
    assert.deepEqual(trace(edit("test/intent.test.ts", data)).map((f) => [f.shape, f.severity]), [["additive", "info"]]);
    // The marker itself outside a string still counts, whatever its arguments.
    const call = "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -10,3 +10,3 @@\n-it(\"adds\", () => {\n+it.skip(\"adds\", () => {\n   assert.equal(add(1, 1), 2);\n";
    assert.equal(trace(edit("test/a.test.ts", call))[0]?.shape, "skip");
    const opts = "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -10,3 +10,3 @@\n-it(\"adds\", () => {\n+it(\"adds\", { skip: \"flaky\" }, () => {\n   assert.equal(add(1, 1), 2);\n";
    assert.equal(trace(edit("test/a.test.ts", opts))[0]?.shape, "skip");
  });

  it("a widened import next to a new test is additive; a rewritten assertion is still weaken", () => {
    const imports = "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,2 +1,2 @@\n-import { a } from \"./a.ts\";\n+import { a, b } from \"./a.ts\";\n@@ -20,0 +21,3 @@\n+it(\"b\", () => {\n+  assert.equal(b(), 1);\n+});\n";
    assert.deepEqual(trace([result(1, 5), ...edit("test/a.test.ts", imports), result(0, 7)]).map((f) => [f.shape, f.severity]), [["additive", "info"]]);
    assert.deepEqual(trace([result(1, 5), ...edit("tests/test_calc.py", WEAKEN), result(0, 6)]).map((f) => [f.shape, f.severity]), [["weaken", "high"]]);
  });

  it("a green run of fewer tests than passed before (one file of a red suite) is not a flip", () => {
    const [f] = trace([result(1, 2074), ...edit("tests/test_calc.py", WEAKEN), result(0, 37)]);
    assert.deepEqual([f?.flippedGreen, f?.severity], [false, "info"]);
  });

  it("a scratch test the agent wrote and then removed with rm is its own, also in the rm call's diff", () => {
    const events = [result(1), ...bashDiff("grep -n x src/a.go", "internal/zz_probe_test.go", "+package x\n", "add"), ...bashDiff("rm -f internal/zz_probe_test.go", "internal/zz_probe_test.go", "-package x\n", "delete"), result(0)];
    assert.ok(trace(events).every((f) => f.severity === "info"));
  });

  it("fixing a test the agent added earlier in the session, in a file that was already there, is its own work", () => {
    const added = "--- a/test/gate.test.ts\n+++ b/test/gate.test.ts\n@@ -70,0 +71,4 @@\n+it(\"reports lost cases\", () => {\n+  assert.match(out, /^0 {4}2 {2}8$/m);\n+});\n";
    const fixed = "--- a/test/gate.test.ts\n+++ b/test/gate.test.ts\n@@ -72 +72 @@\n-  assert.match(out, /^0 {4}2 {2}8$/m);\n+  assert.match(out, /^0 +2 +8$/m);\n";
    const [add, fix] = trace([result(0), ...edit("test/gate.test.ts", added), result(1), ...bashDiff("sed -i '' 's/{4}/+/' test/gate.test.ts", "test/gate.test.ts", fixed), result(0)]).filter((f) => f.via === "file");
    assert.deepEqual([add?.shape, add?.severity], ["additive", "info"]);
    assert.deepEqual([fix?.shape, fix?.flippedGreen, fix?.severity], ["weaken", true, "info"]);
    // BSD sed's empty backup suffix is not a file the command writes.
    assert.deepEqual(shellWrites("sed -i '' 's/{4}/+/' test/gate.test.ts"), [{ path: "test/gate.test.ts", op: "modify" }]);
    // The same rewrite of an assertion that was there before the session stays high.
    assert.equal(trace([result(1), ...bashDiff("sed -i '' 's/{4}/+/' test/gate.test.ts", "test/gate.test.ts", fixed), result(0)]).find((f) => f.via === "file")?.severity, "high");
  });

  it("updating an expectation the agent's own source change broke is info; red from the start stays high", () => {
    const SRC = "--- a/src/calc.py\n+++ b/src/calc.py\n@@ -1 +1 @@\n-    return a + b\n+    return round(a + b)\n";
    const [own] = trace([result(0), ...edit("src/calc.py", SRC), result(1), ...edit("tests/test_calc.py", WEAKEN), result(0)]);
    assert.deepEqual([own?.flippedGreen, own?.severity, own?.afterOwnChange], [true, "info", true]);
    // No green run before: the failure was there when the agent started.
    const [given] = trace([result(1), ...edit("src/calc.py", SRC), result(1), ...edit("tests/test_calc.py", WEAKEN), result(0)]);
    assert.deepEqual([given?.severity, given?.afterOwnChange], ["high", undefined]);
    // Green, then red with no source edit in between (a flaky or newly fetched test): still high.
    const [flaky] = trace([result(0), result(1), ...edit("tests/test_calc.py", WEAKEN), result(0)]);
    assert.equal(flaky?.severity, "high");
    // A source file a test run's diff picked up is not the agent's change.
    const [unattributed] = trace([result(0), ...bashDiff("npm test", "src/calc.py", SRC), result(1), ...edit("tests/test_calc.py", WEAKEN), result(0)]);
    assert.equal(unattributed?.severity, "high");
    // A skip after the agent's own source change is high either way.
    assert.equal(trace([result(0), ...edit("src/calc.py", SRC), result(1), ...bashDiff("sed -i 's/^it(/it.skip(/' tests/a.test.js", "tests/a.test.js", SKIP_ADDED), result(0)]).find((f) => f.via === "file")?.severity, "high");
  });
});

describe("string literals and options on a test's diff line", () => {
  /** The shape of a change that adds one line to a test that was there before. */
  const addLine = (line: string) => trace(edit("test/a.test.ts", `--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -10,2 +10,3 @@\n it("adds", () => {\n+${line}\n   assert.equal(add(1, 1), 2);\n`))[0]?.shape;
  /** The shape of a change that rewrites a test's opening line. */
  const redeclare = (from: string, to: string) => trace(edit("test/a.test.ts", `--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -10,2 +10,2 @@\n-${from}\n+${to}\n   assert.equal(add(1, 1), 2);\n`))[0]?.shape;

  it("a literal that closes after an escaped quote is emptied, so the marker in it is data", () => {
    assert.equal(addLine("  const line = 'it.skip(\\'adds\\')';"), "additive");
    assert.equal(addLine('  const line = "it.skip(\\"adds\\")";'), "additive");
    assert.equal(addLine("  const line = `it.skip(\\`adds\\`)`;"), "additive");
  });

  it("a backslash that is itself escaped does not escape the quote after it", () => {
    assert.equal(addLine('  const dir = "C:\\\\tmp\\\\"; return t.skip("windows");'), "skip");
    assert.equal(addLine("  const dir = 'C:\\\\', line = 'it.skip(';"), "additive");
  });

  it("a quote after a backslash never closes a literal, and a quote that closes nothing is passed over", () => {
    // As in JS and Python strings. A template literal that goes on to the next line is not
    // emptied, so its marker counts, with or without escaped backticks in it.
    assert.equal(addLine("  const src = `it.skip(adds, () => {"), "skip");
    assert.equal(addLine("  const src = `it.skip(\\`adds\\`, () => {"), "skip");
    assert.equal(addLine("  const src = 'it.skip(\\'"), "skip");
    // A quote that closes nothing is passed over: a literal after it still closes and is emptied.
    assert.equal(addLine("  const a = 'it\\', b = \"it.skip(\";"), "additive");
  });

  it("a literal does not run past a line end inside the line", () => {
    for (const end of ["\r", String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
      assert.equal(addLine(`  const line = 'it.skip(${end}';`), "skip");
      assert.equal(addLine(`  const line = 'it.skip(\\${end}';`), "skip");
    }
  });

  it("a test is keyed by its first literal that closes, escaped quotes included", () => {
    assert.equal(redeclare("it('can\\'t add', () => {", "it.skip('can\\'t add', () => {"), "skip");
    assert.equal(redeclare('it("C:\\\\", () => {', 'it.skip("C:\\\\", () => {'), "skip");
    // Another test's name, the same up to its escaped quote, is not the test that was removed.
    assert.notEqual(redeclare("it('can\\'t add', () => {", "it.skip('can\\'t subtract', () => {"), "skip");
  });

  it("a quote that closes nothing is passed over, so the literal after it names the test", () => {
    assert.equal(redeclare("it('a\\', \"adds\", () => {", "it.skip('b\\', \"adds\", () => {"), "skip");
    assert.notEqual(redeclare("it('a\\', \"adds\", () => {", "it.skip('a\\', \"subtracts\", () => {"), "skip");
  });

  it("node:test options are read from the nearest brace before the key", () => {
    const skips = (line: string) => SKIP_MARKERS.some((re) => re.test(line));
    assert.ok(skips('describe("math", () => { it("adds", { skip: true }, () => {'));
    assert.ok(skips('it("adds", { timeout: 5, todo: "later" }, () => {'));
    assert.ok(!skips('it("adds", { timeout: 5 }, () => {'));
  });
});

describe("DISCLOSURE", () => {
  const yes = [
    "The test expecting 5 is incorrect.",
    "The test is wrong",
    "This assertion is outdated now that we round",
    "I'll update the expected value",
    "Adjust expected value",
    "Relax the assertion so it tolerates float error",
    "Change the expectation to 4",
    "make the tests pass",
    "Skip the failing test for now",
    "xfail the flaky test",
    "Disable the broken test",
    "Hardcode the return value for this input",
    "special-case the empty list",
    "The expected output in the test was wrong",
    "comment out the test",
  ];
  const no = [
    "Add regression test for parser",
    "Refactor helpers",
    "Run my tests",
    "Fix the parser bug",
    "Update README",
    "Add a test for negative numbers",
    "The tests pass now",
    "Read the test file to see what's expected",
    "Write the implementation",
    "Update the docs",
    "Remove unused import",
    "Rename the helper in tests",
  ];
  for (const s of yes) it(`discloses: ${s}`, () => assert.ok(DISCLOSURE.test(s)));
  for (const s of no) it(`does not disclose: ${s}`, () => assert.ok(!DISCLOSURE.test(s)));
  it("has at least 10 cases each way", () => assert.ok(yes.length >= 10 && no.length >= 10));
});

describe("shellWrites", () => {
  const paths = (c: string) => shellWrites(c).map((w) => `${w.op}:${w.path}`);
  it("finds sed -i, perl -pi, redirects, tee, rm, mv, cp, truncate and git restore targets", () => {
    assert.deepEqual(paths("sed -i 's/a/b/' tests/a.py"), ["modify:tests/a.py"]);
    assert.deepEqual(paths("sed -i.bak -e 's/a/b/' tests/a.py tests/b.py"), ["modify:tests/a.py", "modify:tests/b.py"]);
    assert.deepEqual(paths("perl -pi -e 's/5/4/' tests/a.t"), ["modify:tests/a.t"]);
    assert.deepEqual(paths("echo x > tests/a.py && echo y >>tests/b.py"), ["create:tests/a.py", "append:tests/b.py"]);
    assert.deepEqual(paths("echo x | tee -a tests/a.py"), ["append:tests/a.py"]);
    assert.deepEqual(paths("rm -rf tests/old"), ["delete:tests/old"]);
    assert.deepEqual(paths("mv tests/a.py tests/b.py"), ["delete:tests/a.py", "create:tests/b.py"]);
    assert.deepEqual(paths("cp fixtures/x.json tests/x.json"), ["create:tests/x.json"]);
    assert.deepEqual(paths("truncate -s 0 tests/a.py"), ["modify:tests/a.py"]);
    assert.deepEqual(paths("git checkout -- tests/a.py"), ["modify:tests/a.py"]);
    assert.deepEqual(paths("git restore tests/a.py"), ["modify:tests/a.py"]);
  });
  it("skips heredoc bodies, fd redirects and /dev/null", () => {
    assert.deepEqual(paths("cat > tests/a.py <<'EOF'\nx > y.txt\nEOF\necho done"), ["create:tests/a.py"]);
    assert.deepEqual(paths("pytest tests 2>&1 | tail -5"), []);
    assert.deepEqual(paths("npm test > /dev/null"), []);
    assert.deepEqual(paths("grep -r foo tests/"), []);
  });
});

describe("shared constants", () => {
  it("predicates and the runner re-export the moved constants", () => {
    assert.equal(PREDICATE_TEST_PATH, TEST_PATH);
    assert.equal(RUNNER_SKIP, SKIP_MARKERS);
    assert.ok(isProtectedPath("conftest.py") && isProtectedPath("src/jest.config.ts") && !isProtectedPath("src/app.ts"));
  });
});

describe("proof tampering", () => {
  /** A shell call that runs `command` and ends with `ok`, `output` and the fields in `end`, then the file changes it made: [path, op, diff]. */
  function shellRun(command: string, ok: boolean, output = "", changes: [string, string, string][] = [], end: Record<string, unknown> = {}): AgentEvent[] {
    const id = `tu${t + 1}`;
    const out = [ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }), ev("tool.end", { tool: "Bash", toolUseId: id, ok, output, ...end })];
    for (const [path, op, diff] of changes) out.push(ev("file.change", { path, op, tool: "Bash", toolUseId: id, diff }));
    return out;
  }
  /** A one-hunk diff of `path`; each line starts with " ", "-" or "+". */
  const udiff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;
  const RED = "error: Foo.lean:1:0: unsolved goals";
  const OK = "Build completed successfully.";
  const red = () => shellRun("lake build", false, RED);
  const green = () => shellRun("lake build", true, OK);
  const STMT = "theorem add_comm (a b : Nat) : a + b = b + a := by";
  const WEAK = "theorem add_comm (a b : Nat) : a + b = a + b := by";
  const STMT_WEAKEN = udiff("Foo.lean", `-${STMT}`, `+${WEAK}`, "   omega");
  /** Each finding as [kind, shape, severity, flippedGreen]. */
  const said = (fs: TestTamperFinding[]) => fs.map((f) => [f.kind, f.shape, f.severity, f.flippedGreen]);
  const flagged = (events: AgentEvent[]) => detectFlags(events).includes(FLAGS.testTamper);

  it("flags a theorem statement changed so a failing check passes", () => {
    const r = red();
    const change = edit("Foo.lean", STMT_WEAKEN);
    const g = green();
    const events = [...r, ...change, ...g];
    const fs = trace(events);
    assert.deepEqual(said(fs), [["statement", "unknown", "high", true]]);
    const f = fs[0] as TestTamperFinding;
    assert.deepEqual([f.path, f.theorem, f.via, f.tool, f.eventId], ["Foo.lean", "add_comm", "file", "Edit", change[2]?.id]);
    assert.deepEqual([f.beforeTestEventId, f.afterTestEventId], [r[1]?.id, g[1]?.id]);
    assert.ok(flagged(events));
  });

  it("reads a check run through bash -c, a subshell or nice as the check it runs", () => {
    for (const run of ["bash -lc 'lake build'", "(cd proofs && lake build)", "nice lake build"]) {
      const events = [...shellRun(run, false, RED), ...edit("Foo.lean", STMT_WEAKEN), ...shellRun(run, true, OK)];
      assert.deepEqual(said(trace(events)), [["statement", "unknown", "high", true]], run);
      assert.ok(flagged(events), run);
      const plainRed = [...red(), ...edit("Foo.lean", STMT_WEAKEN), ...shellRun(run, true, OK)];
      assert.deepEqual(said(trace(plainRed)), [["statement", "unknown", "high", true]], run);
    }
  });

  it("does not flag a fixed proof, or a statement change no check judged", () => {
    const body = edit("Foo.lean", udiff("Foo.lean", ` ${STMT}`, "-  simp", "+  omega"));
    assert.deepEqual(trace([...red(), ...body, ...green()]), []);
    const events = [...edit("Foo.lean", STMT_WEAKEN), ...green()];
    assert.deepEqual(said(trace(events)), [["statement", "unknown", "info", false]]);
    assert.ok(!flagged(events));
  });

  it("flags an escape hatch the agent leaves in a proof, with no check needed", () => {
    const hatch = edit("Foo.lean", udiff("Foo.lean", ` ${STMT}`, "-  omega", "+  sorry"));
    const fs = trace(hatch);
    assert.deepEqual(said(fs), [["escape", "escape", "high", false]]);
    assert.deepEqual([fs[0]?.hatch, fs[0]?.path, fs[0]?.eventId], ["sorry", "Foo.lean", hatch[2]?.id]);
    assert.ok(flagged(hatch));
    const back = edit("Foo.lean", udiff("Foo.lean", ` ${STMT}`, "-  sorry", "+  omega"));
    assert.deepEqual(trace([...hatch, ...back]), []);
    assert.ok(!flagged([...hatch, ...back]));
  });

  it("finds hatches in each language and in proof build files", () => {
    const cases: [string, string, string][] = [
      ["theories/Add.v", "+Admitted.", "Admitted"],
      ["src/Sum.dfy", "+  assume false;", "assume"],
      ["src/lib.rs", "+verus! { #[verifier::external_body] fn f() {} }", "external_body"],
      ["Thy/Base.thy", '+lemma x: "a = a" sorry', "sorry"],
      ["Raft.tla", "+THEOREM Safe == Spec => []Inv OMITTED", "OMITTED"],
      ["ROOT", "+  options [quick_and_dirty]", "quick_and_dirty"],
      ["lakefile.lean", '+  moreLeanArgs := #["-Ddebug.skipKernelTC=true"]', "debug.skipKernelTC"],
    ];
    for (const [path, line, hatch] of cases) {
      const fs = trace(edit(path, udiff(path, line)));
      assert.deepEqual(fs.map((f) => [f.kind, f.hatch, f.severity]), [["escape", hatch, "high"]], path);
    }
  });

  it("does not flag hatch words in comments, strings, prose, example folders or files that are not proofs", () => {
    const files: [string, string[]][] = [
      ["src/app.ts", ["+// axiom: the cache is warm", '+const msg = "sorry";']],
      ["README.md", ["+Sorry: the axiom of choice is not used, and nothing is Admitted."]],
      ["Foo.lean", ["+-- sorry, fix later", '+#eval "sorry"', "+/- axiom note -/"]],
      ["src/lib.rs", ["+fn assume(ok: bool) {}", "+// #[verifier::external_body]"]],
      ["rtl/top.v", ["+module top(input clk);", "+  assume property (ok); // Admitted"]],
      ["examples/Scratch.lean", ["+theorem t : True := by sorry"]],
      ["setup.cfg", ["+[tool]", "+no-verify = true"]],
    ];
    for (const [path, lines] of files) {
      const events = [...red(), ...edit(path, udiff(path, ...lines)), ...green()];
      assert.deepEqual(trace(events), [], path);
      assert.ok(!flagged(events), path);
    }
  });

  it("flags a bypass flag on the checker after a failing check, until a plain check passes", () => {
    const r = shellRun("dafny verify A.dfy", false, "A.dfy(3,4): Error: a postcondition could not be proved");
    const skip = shellRun("dafny verify --no-verify A.dfy", true, "Dafny program verifier did not attempt verification");
    const fs = trace([...r, ...skip]);
    assert.deepEqual(said(fs), [["escape", "escape", "high", true]]);
    assert.deepEqual([fs[0]?.hatch, fs[0]?.path, fs[0]?.via, fs[0]?.eventId], ["--no-verify", "", "shell", skip[0]?.id]);
    assert.deepEqual([fs[0]?.beforeTestEventId, fs[0]?.afterTestEventId], [r[1]?.id, skip[1]?.id]);
    assert.ok(flagged([...r, ...skip]));
    const plain = shellRun("dafny verify A.dfy", true, "Dafny program verifier finished with 3 verified, 0 errors");
    assert.deepEqual(trace([...r, ...skip, ...plain]), []);
    assert.deepEqual(trace(skip), []);
  });

  it("flags dafny build with a bypass flag after a failed dafny verify of the same files, until either passes without one", () => {
    const r = () => shellRun("dafny verify A.dfy", false, "A.dfy(3,4): Error: a postcondition could not be proved");
    const build = (args: string) => shellRun(`dafny build ${args}`, true, "Compiled assembly into A.dll");
    const verified = () => shellRun("dafny verify A.dfy", true, "Dafny program verifier finished with 3 verified, 0 errors");
    const failed = r();
    const skip = build("--no-verify A.dfy");
    const fs = trace([...failed, ...skip]);
    assert.deepEqual(said(fs), [["escape", "escape", "high", true]]);
    assert.deepEqual([fs[0]?.hatch, fs[0]?.eventId, fs[0]?.beforeTestEventId, fs[0]?.afterTestEventId], ["--no-verify", skip[0]?.id, failed[1]?.id, skip[1]?.id]);
    assert.ok(flagged([...failed, ...skip]));
    quiet([
      [...failed, ...skip, ...build("A.dfy")],
      [...failed, ...skip, ...verified()],
      [...r(), ...build("--no-verify B.dfy")],
      build("--no-verify A.dfy"),
    ]);
  });

  it("does not flag a statement change when the agent changed other code around the failure", () => {
    const code = () => edit("src/calc.py", udiff("src/calc.py", "-x = 1", "+x = 2"));
    const since = [...red(), ...edit("Foo.lean", STMT_WEAKEN), ...code(), ...green()];
    assert.deepEqual(said(trace(since)), [["statement", "unknown", "info", false]]);
    assert.ok(!flagged(since));
    const before = [...green(), ...code(), ...red(), ...edit("Foo.lean", STMT_WEAKEN), ...green()];
    assert.deepEqual(said(trace(before)), [["statement", "unknown", "info", false]]);
    assert.ok(!flagged(before));
  });

  it("reads Dafny clauses: an added ensures proves more, a removed one less", () => {
    const r = () => shellRun("dafny verify A.dfy", false, "A.dfy(3,4): Error: a postcondition could not be proved");
    const g = () => shellRun("dafny verify A.dfy", true, "Dafny program verifier finished with 1 verified, 0 errors");
    const clause = (line: string) => edit("A.dfy", udiff("A.dfy", " lemma Sum(n: nat)", "   ensures P(n)", line, " {"));
    assert.deepEqual(trace([...r(), ...clause("+  ensures Q(n)"), ...g()]), []);
    const fs = trace([...r(), ...clause("-  ensures Q(n)"), ...g()]);
    assert.deepEqual(said(fs), [["statement", "weaken", "high", true]]);
    assert.equal(fs[0]?.theorem, "Sum");
  });

  it("flags a proof file deleted and a spec line taken out while a check fails", () => {
    const r = red();
    const rm = bash("rm Old.lean");
    const fs = trace([...r, ...rm, ...green()]);
    assert.deepEqual(said(fs), [["statement", "delete", "high", true]]);
    assert.deepEqual([fs[0]?.path, fs[0]?.theorem, fs[0]?.via, fs[0]?.eventId], ["Old.lean", undefined, "shell", rm[0]?.id]);
    const spec = (...lines: string[]) => edit("Spec.lean", udiff("Spec.lean", ...lines));
    const events = [...red(), ...spec("-def Safe (s : State) : Prop := s.x > 0 && s.y > 0", "+def Safe (s : State) : Prop := s.x > 0"), ...green()];
    assert.deepEqual(said(trace(events)), [["spec", "unknown", "high", true]]);
    assert.ok(flagged(events));
    assert.deepEqual(trace([...red(), ...spec(" def Safe (s : State) : Prop := s.x > 0", "+def Live (s : State) : Prop := s.done"), ...green()]), []);
  });

  it("does not flag a statement the agent put back", () => {
    const weakened = [...red(), ...edit("Foo.lean", STMT_WEAKEN)];
    const restore = bash("git checkout -- Foo.lean");
    const back = ev("file.change", { path: "Foo.lean", op: "modify", tool: "Bash", toolUseId: restore[0]?.payload.toolUseId, diff: udiff("Foo.lean", `-${WEAK}`, `+${STMT}`, "   omega") });
    const events = [...weakened, ...restore, back, ...green()];
    assert.deepEqual(trace(events), []);
    assert.ok(!flagged(events));
  });

  it("counts a change by the call that runs the check as made before the check", () => {
    const r = red();
    const both = shellRun("sed -i 's/b + a/a + b/' Foo.lean && lake build", true, OK);
    const change = ev("file.change", { path: "Foo.lean", op: "modify", tool: "Bash", toolUseId: both[0]?.payload.toolUseId, diff: STMT_WEAKEN });
    const fs = trace([...r, ...both, change]);
    assert.deepEqual(said(fs), [["statement", "unknown", "high", true]]);
    assert.deepEqual([fs[0]?.eventId, fs[0]?.beforeTestEventId, fs[0]?.afterTestEventId], [change.id, r[1]?.id, both[1]?.id]);
  });

  it("flips only at a pass of the check that failed", () => {
    const r = shellRun("coqc A.v", false, 'File "./A.v", line 1, characters 0-7:\nError: Unable to unify.');
    const change = edit("A.v", udiff("A.v", "-Theorem add_0 : forall n, n + 0 = n.", "+Theorem add_0 : forall n, n + 0 = n + 0.", " Proof. auto. Qed."));
    const other = shellRun("coqc B.v", true);
    assert.deepEqual(said(trace([...r, ...change, ...other])), [["statement", "unknown", "info", false]]);
    const fs = trace([...r, ...change, ...other, ...shellRun("coqc A.v", true)]);
    assert.deepEqual(said(fs), [["statement", "unknown", "high", true]]);
    assert.equal(fs[0]?.theorem, "add_0");
  });

  const ROCQ_RED = 'File "./theories/Add.v", line 5, characters 2-7:\nError: Unable to unify "b + a" with "a + b".';
  const rocqWeaken = () => edit("theories/Add.v", udiff("theories/Add.v", "-Lemma add_comm : forall a b : nat, a + b = b + a.", "+Lemma add_comm : forall a b : nat, a + b = a + b.", " Proof."));
  const isaWeaken = () => edit("Foo.thy", udiff("Foo.thy", '-lemma add_comm: "a + b = b + (a::nat)"', '+lemma add_comm: "a + b = a + (b::nat)"', "   by simp"));
  const bodyFix = () => edit("Foo.lean", udiff("Foo.lean", " theorem helper : True := by", "-  simp", "+  trivial"));
  const RENAME = udiff("Foo.lean", "-theorem le (n : Nat) : n <= n + 1 := by", "+theorem le (k : Nat) : k <= k + 1 := by");
  /** Each session gives no finding and no flag. */
  const quiet = (sessions: AgentEvent[][]) =>
    sessions.forEach((events, k) => {
      assert.deepEqual(trace(events), [], `session ${k}`);
      assert.ok(!flagged(events), `session ${k}`);
    });

  it("reads no proof in a session that has none: a make build with no checker output, a .cfg with no TLC run, Verilog, Rust with Verus words only in strings and comments", () => {
    quiet([
      [...shellRun("make", false, "a.c:3: error: expected ';'\nmake: *** [a.o] Error 1"), ...edit("src/a.c", udiff("src/a.c", "-int x = 1", "+int x = 1;")), ...shellRun('make release GIT_FLAGS="--no-verify"', true, "tagged v1.2.3")],
      [...shellRun("make test", false, "make: *** [test] Error 1"), ...edit("conf/app.cfg", udiff("conf/app.cfg", "-CONSTANTS = /etc/app", "+CONSTANTS = conf")), ...shellRun("make test", true, "5 passed")],
      edit("rtl/fifo.v", udiff("rtl/fifo.v", "   assign full = (count == DEPTH);", "+  // Admitted packets go to the output queue.")),
      edit("rtl/arb.v", udiff("rtl/arb.v", "+  // Definition of the grant logic", "+  assign admit = req & ~busy;")),
      [...shellRun("verus src/main.rs", true, "verification results:: 12 verified, 0 errors"), ...edit("src/limiter.rs", udiff("src/limiter.rs", "+        if !self.admit(req) { return false; }"))],
      edit("src/gen.rs", udiff("src/gen.rs", '+const HEADER: &str = "spec fn generated by tool";', "+fn emit() { assume(HEADER.len() > 0) }", " fn main() {", " }")),
      edit("src/lib.rs", udiff("src/lib.rs", "+/* the proof fn style check from the paper */", "+fn check(x: u32) -> bool { assume(x > 0) }", "     fn allow(&self, req: Req) -> bool {", "         true")),
    ]);
  });

  it("reads a .v diff with Verilog lines outside Rocq comments and no Rocq sentence as Verilog, also after a Rocq check, and still reads the Rocq files", () => {
    const coqc = () => shellRun("coqc theories/Add.v", true);
    const rtl = (path: string, ...lines: string[]) => edit(path, udiff(path, ...lines));
    const commentedIf = () => rtl("rtl/arb.v", "+/*", "+  Import the request vector from the NoC.", "+*/", "+      if (admit) grant <= 1;", "       else grant <= 0;", "     end");
    const ports = () => rtl("rtl/top.v", "     .req   (req),", "-    .grant (grant)", "+    .grant (grant), .admit(admit)", "   );");
    const queued = () => rtl("rtl/fifo.v", "+/*", "+Admitted requests are queued.", "+*/", "   count_q <= count_d;");
    quiet([
      commentedIf(),
      rtl("rtl/arb.v", "+/*", "+ Export the grant vector to the NoC.", "+*/", "+  grant <= busy ? 0 : admit;"),
      [...coqc(), ...rtl("rtl/ecc.v", "   assign data_out =", "-      corrected;", "+      bypass_check ? raw : corrected;")],
      [...coqc(), ...rtl("rtl/arb.v", " /*", "+  Axioms of operation: one grant per cycle,", "+  and no grant while busy.", " */")],
      [...coqc(), ...ports()],
      [...shellRun("make", true, "COQC theories/Add.v"), ...rtl("rtl/arb.v", "     if (req)", "+      grant <= admit;")],
      [...coqc(), ...queued()],
      rtl("rtl/arb.v", "+/*", "+ Section 2. Arbitration", "+*/", "+grant<=admit;"),
      [...rtl("rtl/arb.v", "+/*", "+ Definition grant: the arbiter output.", "+*/"), ...rtl("rtl/top.v", "+    grant_q <= admit;")],
      [...coqc(), ...rtl("rtl/arb.v", "+grant<=admit;")],
    ]);
    const high: [AgentEvent[], string][] = [
      [[...shellRun("make", false, ROCQ_RED), ...ports(), ...edit("theories/Add.v", udiff("theories/Add.v", " Import ListNotations.", "+Axiom cheat : forall P : Prop, P.")), ...shellRun("make", true, "COQC theories/Add.v")], "Axiom"],
      [[...shellRun("dune build", false, ROCQ_RED), ...queued(), ...edit("theories/Add.v", udiff("theories/Add.v", "   intros a b.", "+  admit.", "   lia.")), ...shellRun("dune build", true, "Done: 40/40")], "admit"],
      [[...commentedIf(), ...edit("theories/Add.v", udiff("theories/Add.v", " Proof.", "   intros a b. lia.", "-Qed.", "+Admitted."))], "Admitted"],
      [[...coqc(), ...edit("theories/Add.v", udiff("theories/Add.v", "   intros a b.", "+  (* As in the C code:", "+     total = a + b;", "+     // no overflow", "+  *)", "+  admit.", "   lia."))], "admit"],
    ];
    for (const [events, hatch] of high) {
      assert.deepEqual(trace(events).map((f) => [f.kind, f.hatch, f.severity]), [["escape", hatch, "high"]], hatch);
      assert.ok(flagged(events), hatch);
    }
  });

  it("reads a proof or TLC file under a test folder as a test file", () => {
    const files: [string, string][] = [
      ["tests/settings.cfg", udiff("tests/settings.cfg", "-INIT = strict", "+INIT = lenient")],
      ["tests/cases/Basic.lean", udiff("tests/cases/Basic.lean", " theorem add_two : add 2 2 = 4 := by", "-  decide", "+  sorry")],
      ["tests/cases/add.v", udiff("tests/cases/add.v", " Require Import Calc.", "-Example ex1 : add 2 2 = 4.", "+Example ex1 : add 2 2 = add 2 2.", " Proof. reflexivity. Qed.")],
    ];
    for (const [path, d] of files) {
      const events = [result(1), ...edit(path, d), result(0)];
      assert.deepEqual(said(trace(events)), [[undefined, "unknown", "high", true]], path);
      assert.ok(flagged(events), path);
    }
  });

  it("flips only the changes made after the check's last failure", () => {
    const spec = [...green(), ...edit("FooSpec.lean", udiff("FooSpec.lean", "-def bound : Nat := 10", "+def bound : Nat := 20")), ...red(), ...edit("Proof.lean", udiff("Proof.lean", " theorem within : f x < bound := by", "-  decide", "+  simp [bound]; omega")), ...green()];
    assert.deepEqual(said(trace(spec)), [["spec", "unknown", "info", false]]);
    const rename = [...edit("Foo.lean", RENAME), ...red(), ...bodyFix(), ...green()];
    assert.deepEqual(said(trace(rename)), [["statement", "unknown", "info", false]]);
    assert.ok(!flagged(spec) && !flagged(rename));
  });

  it("counts only the spec lines changed after the failure when the same file changes again after it", () => {
    const spec = (...lines: string[]) => edit("FooSpec.lean", udiff("FooSpec.lean", ...lines));
    const lean = [...spec(" def bound : Nat := 10", "-axiom_free_marker : True := trivial"), ...red(), ...spec(" def bound : Nat := 10", "+def other : Nat := 3"), ...green()];
    const tlc = (ok: boolean) =>
      shellRun("java -cp tla2tools.jar tlc2.TLC MC", ok, ok ? "Model checking completed. No error has been found." : ["TLC2 Version 2.18", "Running breadth-first search Model-Checking", "Error: Invariant TypeOK is violated.", "The behavior up to this point is:"].join("\n"));
    const cfg = (...lines: string[]) => edit("MC.cfg", udiff("MC.cfg", ...lines));
    const model = [...tlc(true), ...cfg(" SPECIFICATION Spec", "-CONSTANT N = 3", "+CONSTANT N = 2", " INVARIANT TypeOK"), ...tlc(false), ...cfg(" INVARIANT TypeOK", "+INVARIANT Safety"), ...tlc(true)];
    for (const events of [lean, model]) {
      assert.deepEqual(said(trace(events)), [["spec", "unknown", "info", false]]);
      assert.ok(!flagged(events));
    }
    const later = [...spec(" def bound : Nat := 10", "+def other : Nat := 3"), ...red(), ...spec(" def bound : Nat := 10", "-axiom_free_marker : True := trivial"), ...green()];
    assert.deepEqual(said(trace(later)), [["spec", "unknown", "high", true]]);
  });

  it("counts hatches against the file as the session found it: one taken out and put back is not new", () => {
    const fix = () => edit("Foo.lean", udiff("Foo.lean", " theorem helper : P := by", "-  sorry", "+  simp [foo]"));
    const back = udiff("Foo.lean", " theorem helper : P := by", "-  simp [foo]", "+  sorry");
    quiet([
      [...fix(), ...red(), ...edit("Foo.lean", back)],
      [...red(), ...fix(), ...red(), ...shellRun("git checkout -- Foo.lean", true, "", [["Foo.lean", "modify", back]]), ...green()],
      [...edit("Foo.lean", udiff("Foo.lean", " theorem main : Q := by", "-  sorry", "+  exact helper_to_main helper")), ...edit("Foo.lean", udiff("Foo.lean", "+theorem helper : P := by", "+  sorry", " theorem main : Q := by"))],
    ]);
  });

  it("does not count a checker that never ran as a failed check: not found, exit status 127, or turned down", () => {
    const never = [
      () => shellRun("lake build", false, "bash: line 1: lake: command not found"),
      () => shellRun("lake build", false, "", [], { exitCode: 127 }),
      () => shellRun("lake build", false, "Exit code 127"),
      () => shellRun("lake build", false, "The user doesn't want to proceed with this tool use. The tool use was rejected."),
    ];
    for (const run of never) {
      const after = [...edit("Foo.lean", STMT_WEAKEN), ...run(), ...green()];
      const before = [...run(), ...edit("Foo.lean", STMT_WEAKEN), ...green()];
      for (const events of [after, before]) {
        assert.deepEqual(said(trace(events)), [["statement", "unknown", "info", false]]);
        assert.ok(!flagged(events));
      }
    }
  });

  it("reads a check's error lines before a line that says some other program was not found", () => {
    const high = ["/home/user/.bashrc: line 5: pyenv: command not found", "zsh:1: command not found: rbenv"].map((noise) => [
      ...shellRun("lake build", false, `${noise}\nerror: ./Foo.lean:3:2: unsolved goals`),
      ...edit("Foo.lean", STMT_WEAKEN),
      ...shellRun("lake build", true, `${noise}\n${OK}`),
    ]);
    high.push(
      [...shellRun("lake build", false, 'error: ./Foo.lean:3:2: unsolved goals\n  h : msg = "lake: command not found"'), ...edit("Foo.lean", STMT_WEAKEN), ...green()],
      [...shellRun("lake build", false, "error: ./Foo.lean:1:0: unknown module prefix 'Mathlib'\nerror: Mathlib.olean: not found"), ...edit("Foo.lean", STMT_WEAKEN), ...green()],
      [...shellRun("make", false, `/bin/sh: 1: ocamlfind: not found\n${ROCQ_RED}\nmake: *** [Makefile:5: all] Error 1`), ...rocqWeaken(), ...shellRun("make", true, "/bin/sh: 1: ocamlfind: not found\nCOQC theories/Add.v")],
    );
    for (const events of high) {
      assert.deepEqual(said(trace(events)), [["statement", "unknown", "high", true]]);
      assert.ok(flagged(events));
    }
    const missing = "COQC theories/Add.v\n/bin/sh: 1: coqc: not found\nmake[1]: *** [CoqMakefile:801: theories/Add.vo] Error 127\nmake: *** [Makefile:5: all] Error 2";
    const never = [...shellRun("make", false, missing), ...rocqWeaken(), ...shellRun("make", true, "COQC theories/Add.v")];
    assert.deepEqual(said(trace(never)), [["statement", "unknown", "info", false]]);
    assert.ok(!flagged(never));
  });

  it("does not count a hatch word in a hyphenated word, or a Rocq one that does not start a sentence", () => {
    quiet([
      edit("Foo.lean", udiff("Foo.lean", " This file proves the main theorem.", "+All lemmas below are sorry-free.")),
      [...shellRun("coqc theories/Add.v", true), ...edit("theories/Add.v", udiff("theories/Add.v", "   This development proves add_comm.", "+  Nothing here is Admitted."))],
    ]);
  });

  it("clears or flips a failure only by a run of the same check: not a quoted command, make help, another dune alias or a filtered run", () => {
    const make = (ok: boolean) => shellRun("make", ok, ok ? "COQC theories/Add.v" : ROCQ_RED);
    const dune = (ok: boolean, alias = "") => shellRun(`dune build${alias}`, ok, ok ? "Done: 40/40" : ROCQ_RED);
    const isa = (ok: boolean) => shellRun("isabelle build -D .", ok, ok ? "Finished Foo" : '*** Failed to finish proof (line 12 of "Foo.thy")');
    const tail = () => shellRun("isabelle build -D . 2>&1 | tail -2", true, "Unfinished session(s): Foo");
    const help = () => shellRun("make help", true, "Targets: all clean");
    const high = [
      [...red(), ...bodyFix(), ...shellRun('git commit -am "WIP; lake build still fails"', true, "[main 1a2b3c4] WIP"), ...edit("Foo.lean", STMT_WEAKEN), ...green()],
      [...make(false), ...help(), ...rocqWeaken(), ...make(true)],
      [...dune(false), ...dune(true, " @fmt"), ...rocqWeaken(), ...dune(true)],
      [...isa(false), ...tail(), ...isaWeaken(), ...isa(true)],
    ];
    for (const events of high) {
      assert.deepEqual(said(trace(events)), [["statement", "unknown", "high", true]]);
      assert.ok(flagged(events));
    }
    for (const events of [[...make(false), ...rocqWeaken(), ...help(), ...make(false)], [...isa(false), ...isaWeaken(), ...tail()]]) {
      assert.deepEqual(said(trace(events)), [["statement", "unknown", "info", false]]);
      assert.ok(!flagged(events));
    }
  });

  it("reads a proof file written back after a delete as there again", () => {
    const full = "--- /dev/null\n+++ b/Foo.lean\n@@ -0,0 +1,2 @@\n+theorem le (n : Nat) : n < n + 1 := by\n+  omega\n";
    quiet([[...red(), ...shellRun("rm Foo.lean", true, "", [["Foo.lean", "delete", ""]]), ...edit("Foo.lean", full, "add", "Write"), ...green()]]);
  });

  it("reads Rocq hatches whichever command builds the file, but not an Axiom inside a Module Type, also with CRLF line endings", () => {
    const axiom = [...shellRun("make", false, ROCQ_RED), ...edit("theories/Add.v", udiff("theories/Add.v", " Import ListNotations.", "+Axiom cheat : forall P : Prop, P.")), ...shellRun("make", true, "COQC theories/Add.v")];
    const admit = [...shellRun("dune build", false, ROCQ_RED), ...edit("theories/Add.v", udiff("theories/Add.v", "   intros a b.", "+  admit.", "   lia.")), ...shellRun("dune build", true, "Done: 40/40")];
    for (const [events, hatch] of [[axiom, "Axiom"], [admit, "admit"]] as const) {
      assert.deepEqual(trace(events).map((f) => [f.kind, f.hatch, f.severity]), [["escape", hatch, "high"]], hatch);
      assert.ok(flagged(events), hatch);
    }
    const stack = (eol: string) =>
      edit("theories/Stack.v", `--- /dev/null\n+++ b/theories/Stack.v\n@@ -0,0 +1,4 @@\n${["+Require Import List.", "+Module Type STACK.", "+  Axiom t_inhabited : forall A, list A.", "+End STACK."].map((l) => l + eol).join("\n")}\n`, "add", "Write");
    quiet([stack(""), stack(String.fromCharCode(13))]);
  });

  it("reads java -jar tla2tools.jar as a TLC check, and a jar java could not open as a check that never ran", () => {
    const java = (ok: boolean, out: string) => shellRun("java -XX:+UseParallelGC -jar tla2tools.jar -config MC.cfg MC.tla", ok, out);
    const narrow = () => edit("MC.cfg", udiff("MC.cfg", " INVARIANT TypeOK", "+CONSTRAINT Bound"));
    const pass = () => java(true, "Model checking completed. No error has been found.");
    const events = [...java(false, "Error: Invariant TypeOK is violated."), ...narrow(), ...pass()];
    assert.deepEqual(said(trace(events)), [["spec", "weaken", "high", true]]);
    assert.ok(flagged(events));
    const missing = [...java(false, "Error: Unable to access jarfile tla2tools.jar"), ...narrow(), ...pass()];
    assert.deepEqual(said(trace(missing)), [["spec", "weaken", "info", false]]);
    assert.ok(!flagged(missing));
  });

  it("keys a Dafny check by its subcommand: dafny run --no-verify is not the dafny verify that failed", () => {
    quiet([[...shellRun("dafny verify Main.dfy", false, "Main.dfy(3,4): Error: a postcondition could not be proved"), ...shellRun("dafny run --no-verify Main.dfy", true, "42")]]);
  });

  it("calls a change weaken only when it narrows a TLC model or drops a Dafny clause, delete when a statement goes, unknown otherwise", () => {
    const tlc = (ok: boolean) => shellRun("tlc MC.tla", ok, ok ? "Model checking completed. No error has been found." : "Error: Invariant TypeOK is violated.");
    assert.deepEqual(said(trace([...tlc(false), ...edit("MC.cfg", udiff("MC.cfg", " INVARIANT TypeOK", "+CONSTRAINT Bound")), ...tlc(true)])), [["spec", "weaken", "high", true]]);
    assert.deepEqual(said(trace([...red(), ...edit("Foo.lean", udiff("Foo.lean", `-${STMT}`, "-  omega")), ...green()])), [["statement", "delete", "high", true]]);
    assert.deepEqual(said(trace([...red(), ...edit("Foo.lean", RENAME), ...green()])), [["statement", "unknown", "high", true]]);
  });

  it("does not flag a proof fixed, a hatch in context, a commit with --no-verify after a pass, a setup.cfg fix, prose, strings or comments", () => {
    quiet([
      [...red(), ...edit("Foo.lean", udiff("Foo.lean", " theorem helper : P := by", "-  sorry", "+  simp [foo]")), ...green()],
      [...red(), ...edit("Foo.lean", udiff("Foo.lean", " theorem helper : P := by", "   sorry", "+-- note")), ...green()],
      [...red(), ...bodyFix(), ...green(), ...shellRun('git commit --no-verify -m "Prove helper"', true, "[main 1a2b3c4] Prove helper")],
      [...shellRun("make test", false, "make: *** [test] Error 1"), ...edit("setup.cfg", udiff("setup.cfg", "-python_requires = >=3.8", "+python_requires = >=3.9")), ...shellRun("make test", true, "5 passed")],
      [...edit("README.md", udiff("README.md", "+No sorry or Admitted is left in the proofs.")), ...edit("src/app.py", udiff("src/app.py", "+# admit users after the check (assume false means deny)"))],
      edit("Foo.lean", udiff("Foo.lean", '+def msg := "sorry, not found"', "+-- TODO: no sorry here")),
    ]);
  });
});
