import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseSuite, resolveSuites, SuiteError, suiteKind, taskDirs, loadSuite } from "../../src/eval/suite-spec.ts";
import { tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const CASES = { cases: "cases.jsonl", task: { kind: "command", command: "node app.mjs" }, graders: [{ kind: "exact" }] };

describe("parseSuite", () => {
  it("takes the name from the dir and defaults purpose to capability", () => {
    const s = parseSuite(JSON.stringify(CASES), "/p/evals/triage/suite.json");
    assert.equal(s.name, "triage");
    assert.equal(s.purpose, "capability");
    assert.equal(suiteKind(s), "cases");
  });
  it("tells the three kinds apart and wants exactly one", () => {
    assert.equal(suiteKind({ tasks: "tasks" }), "tasks");
    assert.equal(suiteKind({ skill: "../../skills/pdf" }), "triggers");
    assert.throws(() => parseSuite(JSON.stringify({ tasks: "tasks", skill: "x" }), "s.json"), /exactly one of/);
    assert.throws(() => parseSuite("{}", "s.json"), /exactly one of/);
  });
  it("checks a cases suite has a task and graders, and the other fields' types", () => {
    assert.throws(() => parseSuite(JSON.stringify({ cases: "c.jsonl", graders: [{ kind: "exact" }] }), "s.json"), /needs "task"/);
    assert.throws(() => parseSuite(JSON.stringify({ cases: "c.jsonl", task: {} }), "s.json"), /needs "graders"/);
    assert.throws(() => parseSuite(JSON.stringify({ ...CASES, purpose: "smoke" }), "s.json"), /"purpose" must be/);
    assert.throws(() => parseSuite(JSON.stringify({ ...CASES, trials: 0 }), "s.json"), /"trials" must be/);
    assert.throws(() => parseSuite("{nope", "s.json"), SuiteError);
  });
});

describe("resolveSuites", () => {
  it("finds suites by name under evals/, by path, or all of them", async () => {
    const root = await tempDir();
    dirs.push(root);
    for (const n of ["b", "a"]) {
      await mkdir(join(root, "evals", n), { recursive: true });
      await writeFile(join(root, "evals", n, "suite.json"), JSON.stringify(CASES));
    }
    await mkdir(join(root, "evals", "not-a-suite"));
    assert.deepEqual((await resolveSuites([], root, root)).map((s) => s.spec.name), ["a", "b"]);
    assert.deepEqual((await resolveSuites(["b"], root, root)).map((s) => s.spec.name), ["b"]);
    assert.deepEqual((await resolveSuites(["evals/a"], root, root)).map((s) => s.spec.name), ["a"]);
    assert.deepEqual((await resolveSuites(["evals/a/suite.json"], root, root)).map((s) => s.spec.name), ["a"]);
    await assert.rejects(resolveSuites(["c"], root, root), /No suite "c" \(suites here: a, b\)/);
    const empty = await tempDir();
    dirs.push(empty);
    await assert.rejects(resolveSuites([], empty, empty), /No suites in/);
  });
  it("lists a tasks suite's task dirs", async () => {
    const root = await tempDir();
    dirs.push(root);
    const d = join(root, "evals", "f");
    for (const t of ["t2", "t1", "junk"]) await mkdir(join(d, "tasks", t), { recursive: true });
    for (const t of ["t1", "t2"]) await writeFile(join(d, "tasks", t, "task.json"), "{}");
    await writeFile(join(d, "suite.json"), JSON.stringify({ tasks: "tasks" }));
    assert.deepEqual(taskDirs(await loadSuite(d)).map((x) => x.slice(d.length + 1)), [join("tasks", "t1"), join("tasks", "t2")]);
  });
});
