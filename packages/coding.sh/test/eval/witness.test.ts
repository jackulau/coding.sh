// AA-11: witness tests and replay audits of passing runs (TestJack, arXiv 2610.10619).
// Fixture: "add(a, b) must handle negative numbers" with a positives-only verifier.
// Run A is correct; run B special-cases positives and still passes the verifier.
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { exportTaskDir, importTaskDir } from "../../src/eval/task.ts";
import { runVerifier, taskWorlds } from "../../src/eval/validate.ts";
import {
  auditArms,
  confirmWitness,
  formatAudit,
  promoteWitnesses,
  replayWitnesses,
  taskAudit,
  taskWitnesses,
  withAudit,
  withWitnesses,
  witnessId,
  type Witness,
} from "../../src/eval/witness.ts";
import { commandEnv } from "../../src/runner/exec.ts";
import { FakeSnapshots, MemBlobs, MemIndex, tempDir, type Tree } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const START: Tree = { "package.json": '{"name":"adder"}\n', "src/add.js": "module.exports = (a, b) => 0;\n" };
const CORRECT: Tree = { ...START, "src/add.js": "module.exports = (a, b) => a + b;\n" };
const POSITIVES: Tree = { ...START, "src/add.js": "module.exports = (a, b) => (a >= 0 && b >= 0 ? a + b : 0);\n" };
const HIDDEN = "const add = require('../src/add.js');\nif (add(2, 3) !== 5) { console.error('add(2, 3) is ' + add(2, 3)); process.exit(1); }\n";
const NEG = "const add = require('../src/add.js');\nif (add(-2, -3) !== -5) { console.error('add(-2, -3) is ' + add(-2, -3) + ', want -5'); process.exit(1); }\n";

async function world(opts: { verifier?: string } = {}) {
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("start", START).add("correct", CORRECT).add("positives", POSITIVES);
  const diff = async (to: string) => blobs.put((await git.diffSnapshots("/r", "start", to)).patch);
  const task: EvalTask = {
    id: "t-add",
    name: "add-negatives",
    status: "validated",
    start: { repoRoot: "/r", snapshot: "start", head: "h" },
    instruction: "add(a, b) must return the sum, and must handle negative numbers",
    setup: [],
    verifier: { command: opts.verifier ?? "node test/add.test.js", hiddenFiles: { "test/add.test.js": await blobs.put(HIDDEN) }, timeoutMs: 30_000 },
    referencePatch: await diff("correct"),
    validation: { noopFails: true, referencePasses: { passed: 5, of: 5 }, nearMissesFail: { failed: 0, of: 0 }, leakage: [], ok: true, ts: 0 },
    tags: [],
    createdAt: 0,
  };
  const workRoot = await tempDir("csh-witness-");
  dirs.push(workRoot);
  let n = 0;
  const run = (bundleId: string, extra: Partial<RunResult> = {}): RunResult => ({
    id: `run_${bundleId}_${++n}`,
    experimentId: "exp1",
    taskId: task.id,
    bundleId,
    attempt: n,
    pass: true,
    verifierExit: 0,
    agent: { exitCode: 0, timedOut: false, durationMs: 1 } as RunResult["agent"],
    startedAt: n,
    endedAt: n,
    ...extra,
  });
  const witness = async (content: string, command: string, path = "test/neg.test.js"): Promise<Witness> => ({
    id: witnessId(path, content, command),
    path,
    blob: await blobs.put(content),
    command,
    requirement: "handle negative numbers",
    quote: "must handle negative numbers",
    source: "manual",
    status: "confirmed",
    createdAt: 1,
  });
  return { blobs, git, task, workRoot, run, witness, correct: await diff("correct"), positives: await diff("positives") };
}

describe("witness audit", () => {
  it("confirms a witness 3/3, leaves the correct run clean, refutes the positives-only run, and stores the report", async () => {
    const w = await world();
    const neg = await w.witness(NEG, "node test/neg.test.js");
    const c = await confirmWitness({ task: w.task, witness: neg, blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.deepEqual({ ok: c.ok, refPassed: c.refPassed, k: c.k, noopFails: c.noopFails }, { ok: true, refPassed: 3, k: 3, noopFails: true });
    const a = w.run("A", { diffBlob: w.correct });
    const b = w.run("B", { diffBlob: w.positives });
    const task = withWitnesses(w.task, [neg]);
    const report = await replayWitnesses({ task, runs: [a, b], witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot, experimentId: "exp1" });
    assert.deepEqual(
      report.runs.map((r) => [r.runId, r.status, r.witnessId, r.countsAsRefuted]),
      [
        [a.id, "clean", undefined, undefined],
        [b.id, "refuted", neg.id, true],
      ],
    );
    assert.match(report.runs[1]?.tail ?? "", /add\(-2, -3\) is 0, want -5/);
    assert.deepEqual(report.ambiguous, []);
    assert.deepEqual(report.witnesses, [neg.id]);
    const index = new MemIndex();
    await index.putTask(withAudit(task, "exp1", report));
    const stored = await index.getTask(task.id);
    assert.deepEqual(taskAudit(stored!, "exp1"), report);
    assert.deepEqual(taskWitnesses(stored!), [neg]);
    assert.deepEqual(
      auditArms(report, [a, b]).map((x) => [x.bundleId, x.passes, x.refuted, x.auditedPasses]),
      [
        ["A", 1, 0, 1],
        ["B", 1, 1, 0],
      ],
    );
    const text = formatAudit(report, [a, b], [neg]);
    assert.match(text, /^B: passes 1\/1, refuted 1, audited pass rate 0% \(0\/1\), replayed 1\/1$/m);
    assert.match(text, new RegExp(`refuted ${b.id} \\(B\\) by test/neg\\.test\\.js: handle negative numbers\\n  add\\(-2, -3\\) is 0, want -5`));
    assert.deepEqual(await readdir(w.workRoot), [], "replay dirs are cleaned up");
  });

  it("rejects a witness that fails on the reference, or that sits on a hidden verifier file", async () => {
    const w = await world();
    const wrong = await w.witness("const add = require('../src/add.js');\nprocess.exit(add(2, 2) === 5 ? 0 : 1);\n", "node test/neg.test.js");
    const c = await confirmWitness({ task: w.task, witness: wrong, blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.equal(c.ok, false);
    assert.equal(c.refPassed, 0);
    assert.match(c.error ?? "", /fails on the reference \(0\/3\): it asserts something the reference does not do/);
    const clash = await w.witness(NEG, "node test/add.test.js", "test/add.test.js");
    const d = await confirmWitness({ task: w.task, witness: clash, blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.match(d.error ?? "", /test\/add\.test\.js is a hidden verifier file/);
  });

  it("a witness that fails once and then passes leaves the run clean with a flaky note", async () => {
    const w = await world();
    const flaky = await w.witness(
      "const fs = require('fs');\nif (fs.readFileSync('src/add.js', 'utf8').includes('>= 0') && !fs.existsSync('.flaked')) { fs.writeFileSync('.flaked', ''); process.exit(1); }\n",
      "node test/flaky.test.js",
      "test/flaky.test.js",
    );
    const b = w.run("B", { diffBlob: w.positives });
    const report = await replayWitnesses({ task: w.task, runs: [b], witnesses: [flaky], blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.equal(report.runs[0]?.status, "clean");
    assert.deepEqual(report.runs[0]?.notes, ["flaky witness test/flaky.test.js: failed, then passed"]);
  });

  it("replays only passing, finished runs with a diff; a diff that won't apply is unreplayable; a verifier that no longer passes is a replay mismatch", async () => {
    const w = await world({ verifier: 'test "$TOKEN" = yes && node test/add.test.js' });
    const neg = await w.witness(NEG, "node test/neg.test.js");
    const runs = [
      w.run("A", { diffBlob: w.correct, pass: false, verifierExit: 1 }),
      w.run("A", { diffBlob: w.correct, cancelled: true }),
      w.run("A"),
      w.run("A", { diffBlob: w.correct, superseded: true }),
      w.run("B", { diffBlob: await w.blobs.put("--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-x\n+y\n") }),
      w.run("B", { diffBlob: "f".repeat(64) }),
      w.run("B", { diffBlob: w.positives }),
    ];
    const report = await replayWitnesses({ task: w.task, runs, witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.deepEqual(
      report.runs.map((r) => [r.runId, r.status]),
      [
        [runs[4]!.id, "unreplayable"],
        [runs[5]!.id, "unreplayable"],
        [runs[6]!.id, "replay-mismatch"],
      ],
    );
    assert.match(report.runs[0]?.tail ?? "", /patch did not apply/);
    assert.match(report.runs[1]?.tail ?? "", /not found/);
    assert.match(report.runs[2]?.tail ?? "", /the verifier fails on replay/);
    // With the env the runs had, B replays faithfully and is refuted.
    const again = await replayWitnesses({ task: w.task, runs: [runs[6]!], witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot, env: { TOKEN: "yes" } });
    assert.equal(again.runs[0]?.status, "refuted");
    const arm = auditArms(report, runs).find((x) => x.bundleId === "B");
    assert.deepEqual(arm, { bundleId: "B", runs: 3, passes: 3, replayed: 0, refuted: 0, unreplayable: 2, replayMismatch: 1, auditedPasses: 3 });
  });

  it("a witness refuting 3 of 4 passing runs is ambiguous and not counted unless asked", async () => {
    const w = await world();
    const neg = await w.witness(NEG, "node test/neg.test.js");
    const runs = [w.run("A", { diffBlob: w.correct }), w.run("B", { diffBlob: w.positives }), w.run("B", { diffBlob: w.positives }), w.run("A", { diffBlob: w.positives })];
    const report = await replayWitnesses({ task: w.task, runs, witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot, concurrency: 4 });
    assert.deepEqual(report.ambiguous, [{ witnessId: neg.id, refuted: 3, of: 4, note: "refutes 3 of 4 passing runs: check the instruction actually states this" }]);
    assert.deepEqual(
      report.runs.map((r) => r.countsAsRefuted),
      [undefined, false, false, false],
    );
    assert.deepEqual(
      auditArms(report, runs).map((x) => x.refuted),
      [0, 0],
    );
    assert.match(formatAudit(report, runs, [neg]), /ambiguous: test\/neg\.test\.js refutes 3 of 4 passing runs: check the instruction actually states this \(not counted; --count-ambiguous counts it\)/);
    const counted = await replayWitnesses({ task: w.task, runs, witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot, countAmbiguous: true });
    assert.deepEqual(
      auditArms(counted, runs).map((x) => x.refuted),
      [1, 2],
    );
  });

  it("questionable witnesses never replay", async () => {
    const w = await world();
    const neg = { ...(await w.witness(NEG, "node test/neg.test.js")), status: "questionable" as const };
    const report = await replayWitnesses({ task: w.task, runs: [w.run("B", { diffBlob: w.positives })], witnesses: [neg], blobs: w.blobs, git: w.git, workRoot: w.workRoot });
    assert.deepEqual(report.witnesses, []);
    assert.equal(report.runs[0]?.status, "clean");
  });

  it("export and import round-trip witnesses byte for byte", async () => {
    const w = await world();
    const neg = await w.witness(NEG, "node test/neg.test.js");
    const other = await w.witness("process.exit(0);\n", "node test/neg.test.js");
    const task = withAudit(withWitnesses(w.task, [neg, other]), "exp1", { taskId: w.task.id, method: "manual", witnesses: [neg.id], runs: [], ambiguous: [], ts: 5 });
    const dir = await tempDir("csh-witness-export-");
    dirs.push(dir);
    await exportTaskDir(task, dir, w.blobs);
    const json = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as { meta?: Record<string, unknown> };
    assert.deepEqual(Object.keys(json.meta ?? {}), ["audits"], "witnesses live in witnesses/, not task.json");
    assert.equal(await readFile(join(dir, "witnesses", "files", neg.id.slice(0, 12), "test/neg.test.js"), "utf8"), NEG);
    const fresh = new MemBlobs();
    const back = await importTaskDir(dir, fresh);
    assert.deepEqual(taskWitnesses(back), [neg, other]);
    assert.deepEqual(back.meta?.audits, task.meta?.audits);
    assert.ok(Buffer.from((await fresh.get(neg.blob))!).equals(Buffer.from((await w.blobs.get(neg.blob))!)));
  });

  it("promote adds the witness to the verifier: B's diff then fails it, and the task needs validating again", async () => {
    const w = await world();
    const neg = await w.witness(NEG, "node test/neg.test.js");
    const { task, notes } = promoteWitnesses(withWitnesses(w.task, [neg]), [neg.id]);
    assert.equal(task.verifier.command, "node test/add.test.js && node test/neg.test.js");
    assert.equal(task.verifier.hiddenFiles["test/neg.test.js"], neg.blob);
    assert.equal(task.status, "draft");
    assert.equal(task.validation, undefined);
    assert.match(notes[0] ?? "", /runs before this used the old verifier/);
    const env = commandEnv();
    const { prepare, cleanup } = taskWorlds({ task, workRoot: w.workRoot, ops: w.git, env });
    for (const [diff, pass] of [
      [w.positives, false],
      [w.correct, true],
    ] as const) {
      const p = await prepare("promoted", (await w.blobs.getText(diff))!, { afterSetup: true });
      try {
        const r = await runVerifier(p.dir, task, w.blobs, env);
        assert.equal(r.exitCode === 0, pass);
      } finally {
        await cleanup(p.dir);
      }
    }
  });
});
