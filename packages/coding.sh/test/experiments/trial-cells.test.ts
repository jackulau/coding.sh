// Content keys for exp run matrix case-trials (experiments/trial-cells.ts).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CaseRun } from "../../src/datasets/types.ts";
import { newestTrialByCell, reusableTrial, trialCellKey, trialTaskKey } from "../../src/experiments/trial-cells.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("trialCellKey", () => {
  const taskKey = trialTaskKey({ kind: "command", command: "node", args: ["-e", "1"] })!;
  const base = { datasetId: "ds_1", case: { id: "a", input: "x", expected: "X" }, taskKey, graders: [{ id: "exact", version: "v1" }], trial: 1 };

  it("changes with the case, the task, a grader version, the trial and the timeout, not with grader order", () => {
    const k = trialCellKey(base);
    assert.equal(trialCellKey({ ...base }), k);
    assert.notEqual(trialCellKey({ ...base, datasetId: "ds_2" }), k);
    assert.notEqual(trialCellKey({ ...base, case: { ...base.case, input: "y" } }), k);
    assert.notEqual(trialCellKey({ ...base, case: { ...base.case, expected: "Y" } }), k);
    assert.notEqual(trialCellKey({ ...base, case: { ...base.case, id: "b" } }), k, "same content, another case");
    assert.notEqual(trialCellKey({ ...base, taskKey: trialTaskKey({ kind: "command", command: "node", args: ["-e", "2"] })! }), k);
    assert.notEqual(trialCellKey({ ...base, graders: [{ id: "exact", version: "v2" }] }), k);
    assert.notEqual(trialCellKey({ ...base, trial: 2 }), k);
    assert.notEqual(trialCellKey({ ...base, timeoutMs: 1000 }), k);
    const two = [{ id: "a", version: "1" }, { id: "b", version: "1" }];
    assert.equal(trialCellKey({ ...base, graders: two }), trialCellKey({ ...base, graders: [...two].reverse() }));
  });

  it("a command task's key follows the content of the file it runs; a function task has none", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-trialkey-")));
    dirs.push(dir);
    writeFileSync(join(dir, "agent.mjs"), "console.log(1)");
    const spec = { kind: "command", command: "node", args: ["agent.mjs"] };
    const k1 = trialTaskKey(spec, dir);
    writeFileSync(join(dir, "agent.mjs"), "console.log(2)");
    assert.notEqual(trialTaskKey(spec, dir), k1);
    assert.equal(trialTaskKey({ kind: "function", fn: () => 1 }), undefined);
    assert.equal(trialTaskKey(() => 1), undefined);
  });
});

describe("newestTrialByCell", () => {
  const run = (p: Partial<CaseRun>): CaseRun => ({ caseId: "a", trial: 1, pass: true, score: 1, scores: [], startedAt: 100, durationMs: 1, cellKey: "k", ...p }) as CaseRun;

  it("keeps the newest original with a known outcome inside the age limit, skipping excluded experiments", () => {
    assert.equal(reusableTrial(run({}), 50), true);
    assert.equal(reusableTrial(run({ cellKey: undefined }), 50), false, "unkeyed");
    assert.equal(reusableTrial(run({ reusedFrom: "exp_0" }), 50), false, "a copy is never a source");
    assert.equal(reusableTrial(run({ error: "boom" }), 50), false);
    assert.equal(reusableTrial(run({ ungraded: true }), 50), false);
    assert.equal(reusableTrial(run({ infra: "server" }), 50), false);
    assert.equal(reusableTrial(run({ startedAt: 40 }), 50), false, "too old");
    const m = newestTrialByCell(
      [
        { id: "exp_1", runs: [run({ startedAt: 100 })] },
        { id: "exp_2", runs: [run({ startedAt: 200, pass: false })] },
        { id: "exp_3", runs: [run({ startedAt: 300 })] },
      ],
      0,
      new Set(["exp_3"]),
    );
    assert.equal(m.get("k")?.experimentId, "exp_2");
    assert.equal(m.get("k")?.run.pass, false);
  });
});
