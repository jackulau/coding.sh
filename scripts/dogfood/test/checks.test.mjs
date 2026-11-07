import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutput, classify, firstJson, jsonPath, leakage, tapMetrics, template } from "../cli-suite.mjs";
import { judge } from "../cli-guidelines.mjs";

test("output checks", () => {
  assert.equal(checkOutput({ contains: ["Bash"], number: 47.3, tolerance: 0.05 }, "slowest: bash took 47.31 s").pass, true);
  assert.equal(checkOutput({ number: 47.3, tolerance: 0.05 }, "took 47.4 s").pass, false);
  assert.equal(checkOutput({ absent: ["y2"] }, "session Y2").pass, false);
  assert.equal(checkOutput({ anyNumber: [5200, 5.2] }, "p95 is 5.2 s").pass, true);
  assert.equal(checkOutput({ json: { a: 1 } }, "here:\n```json\n{\"a\": 1}\n```").pass, true);
  assert.equal(checkOutput({ regex: "^ok$" }, "x\nOK\ny").pass, true);
  assert.equal(checkOutput({ number: 1234 }, "1,234 tokens").pass, true);
});

test("firstJson skips braces inside strings and invalid prefixes", () => {
  assert.deepEqual(firstJson('{bad} then {"s":"}{"}').value, { s: "}{" });
  assert.equal(firstJson("none").ok, false);
});

test("template keeps types for whole placeholders and fails loudly", () => {
  const vars = { answers: { n: 3, ids: ["a", "b"], o: { k: "v" } } };
  assert.equal(template("${answers.n}", vars), 3);
  assert.equal(template("n=${answers.n}", vars), "n=3");
  assert.equal(template("${answers.ids.length}", vars), 2);
  assert.equal(template("${answers.ids.1}", vars), "b");
  assert.deepEqual(template({ x: ["${answers.o}"] }, vars), { x: [{ k: "v" }] });
  assert.throws(() => template("${answers.nope}", vars), /unresolved placeholder/);
});

test("jsonPath", () => {
  const d = { a: [{ b: 1 }, { b: 2 }], c: { d: "x" } };
  assert.deepEqual(jsonPath(d, "$.a[*].b"), [1, 2]);
  assert.equal(jsonPath(d, "$.a[1].b"), 2);
  assert.equal(jsonPath(d, "$.c.d"), "x");
  assert.equal(jsonPath(d, "$.z.y"), undefined);
});

test("leakage flags expected values in the instruction", () => {
  assert.equal(leakage("Which tool was slowest?", [{ kind: "output", contains: ["Bash"] }]).length, 0);
  assert.equal(leakage("Was Bash the slowest?", [{ kind: "output", contains: ["Bash"] }]).length, 1);
  assert.equal(leakage("Was Bash the slowest?", [{ kind: "output", contains: ["Bash"], leakOk: true }]).length, 0);
});

test("tap classification and metrics", () => {
  assert.equal(classify({ argv: ["--help"], exit: 0 }).cls, "help");
  assert.equal(classify({ argv: ["sesions"], exit: 2, stderrHead: 'Unknown command "sesions"\nDid you mean coding.sh sessions?' }).reason, "unknown-command");
  assert.equal(classify({ argv: ["show", "x"], exit: 1, stderrHead: "Session not found" }).cls, "failed");
  const m = tapMetrics([
    { argv: ["sessions", "--bogus"], exit: 2, stderrHead: "Unknown option --bogus" },
    { argv: ["sessions", "--help"], exit: 0 },
    { argv: ["sessions", "--since", "7d"], exit: 0 },
  ]);
  assert.equal(m.targetCalls, 3);
  assert.equal(m.invalidCalls, 1);
  assert.equal(m.helpLookups, 1);
  assert.equal(m.recoveryRate, 1);
});

test("guideline judge catches color, words, JSON and exit codes", () => {
  const piped = { env: {} };
  const ok = { code: 0, stdout: "rows\n", stderr: "", ms: 50 };
  assert.deepEqual(judge(ok, {}, piped), []);
  assert.match(judge({ ...ok, stdout: "\x1b[31mred\x1b[0m" }, {}, piped)[0], /ANSI/);
  assert.deepEqual(judge({ ...ok, stdout: "\x1b[31mred\x1b[0m" }, {}, { env: {}, tty: true }), []);
  assert.match(judge({ ...ok, stdout: "\x1b[31mred\x1b[0m" }, {}, { env: { NO_COLOR: "1" }, tty: true })[0], /ANSI/);
  assert.match(judge({ ...ok, stderr: "Installed successfully" }, {}, piped)[0], /successfully/);
  assert.deepEqual(judge({ ...ok, stdout: "user prompt: just do it" }, { data: true }, piped), []);
  assert.match(judge({ ...ok, code: 3 }, {}, piped)[0], /exit 3/);
  assert.match(judge({ ...ok, stdout: "{}{}" }, {}, { env: {}, json: true })[0], /not one JSON/);
  assert.deepEqual(judge({ code: 2, stdout: "", stderr: '{"status":"error","reason":"confirmation_required"}', ms: 1 }, { expect: 2, confirm: true }, { env: {}, json: true }), []);
  assert.match(judge({ ...ok, stderr: "Did you mean a?\nDid you mean b?" }, {}, piped)[0], /did you mean/);
});
