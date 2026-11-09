// X-26: exp run checkpoint/resume, --retry-errors, case selection and the regression-to-the-mean guard.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { isCheckpoint, renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import { ResumeMismatchError, runExperiment } from "../../src/experiments/run.ts";
import { selectionWarning, selectRunCases } from "../../src/experiments/select.ts";
import { exactGrader, jsonPathGrader } from "../../src/graders/builtin.ts";

const ds = createDataset({ name: "ten", createdAt: 1, cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: i, expected: i })) });
const echo = (x: unknown) => x;

describe("checkpoint and resume (resumeFrom)", () => {
  let dir = "";
  let store: FileEvalStore;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "csh-x26-"));
    store = new FileEvalStore({ env: { CODING_SH_HOME: dir } });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("aborting at 4 of 10 stores a partial, and resume makes 6 calls", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    let atFifth!: () => void;
    const fifth = new Promise<void>((r) => (atFifth = r));
    const task = async (x: unknown, ctx: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 5) {
        atFifth();
        await new Promise<void>((_r, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("killed")), { once: true }));
      }
      return x;
    };
    const running = runExperiment({ name: "ck", dataset: ds, task, graders: [exactGrader()], concurrency: 1, store, signal: ctrl.signal, checkpointMs: 0 });
    await fifth;
    // While the 5th case runs, the stored record is a checkpoint of the 4 that finished.
    let mid: ExperimentResult | undefined;
    for (let i = 0; i < 200 && mid?.runs.length !== 4; i++) {
      await new Promise((r) => setTimeout(r, 10));
      [mid] = await store.listExperiments({ name: "ck" });
    }
    assert.ok(mid && isCheckpoint(mid));
    assert.equal(mid.status, "cancelled");
    assert.equal(mid.runs.length, 4);
    assert.deepEqual({ done: (mid.metadata!.checkpoint as { done: number }).done, total: (mid.metadata!.checkpoint as { total: number }).total }, { done: 4, total: 10 });
    assert.match(renderExperiment(mid, { color: false }), /^partial: 4 of 10 case runs/m);
    ctrl.abort();
    release();
    const cut = await running;
    assert.equal(cut.status, "cancelled");
    assert.equal(cut.runs.length, 4);
    const stored = (await store.getExperiment(cut.id))!;
    assert.equal(stored.runs.length, 4);
    assert.equal(isCheckpoint(stored), false, "the final record replaces the checkpoint");

    let resumed = 0;
    const again = async (x: unknown) => (resumed++, x);
    Object.defineProperty(again, "name", { value: "task" });
    const r = await runExperiment({ name: "ck", dataset: ds, task: again, graders: [exactGrader()], store, resumeFrom: stored });
    assert.equal(resumed, 6);
    assert.equal(r.id, cut.id);
    assert.equal(r.createdAt, cut.createdAt);
    assert.equal(r.status, "completed");
    assert.equal(r.runs.length, 10);
    assert.equal(r.summary.passed, 10);
    assert.equal((await store.getExperiment(cut.id))!.status, "completed");
  });

  it("--retry-errors runs the task-errored case again, and that fixes it; without it errors are kept", async () => {
    // One task (the same ref); it throws on case 3 until the outage is over.
    let outage = true;
    let calls = 0;
    const agent = (x: unknown) => {
      calls++;
      if (outage && x === 3) throw new Error("boom");
      return x;
    };
    const first = await runExperiment({ name: "retry", dataset: ds, task: agent, graders: [exactGrader()], store });
    assert.equal(first.summary.errors, 1);
    outage = false;
    calls = 0;
    const counting = agent;
    const kept = await runExperiment({ name: "retry", dataset: ds, task: counting, graders: [exactGrader()], resumeFrom: first });
    assert.equal(calls, 0);
    assert.equal(kept.summary.errors, 1);
    const fixed = await runExperiment({ name: "retry", dataset: ds, task: counting, graders: [exactGrader()], resumeFrom: first, retryErrors: true });
    assert.equal(calls, 1);
    assert.equal(fixed.id, first.id);
    assert.equal(fixed.summary.errors, 0);
    assert.equal(fixed.summary.passed, 10);
  });

  it("grader drift throws and names graders", async () => {
    const prev = await runExperiment({ name: "drift", dataset: ds, task: echo, graders: [exactGrader()] });
    await assert.rejects(
      runExperiment({ name: "drift", dataset: ds, task: echo, graders: [jsonPathGrader({ path: "$" })], resumeFrom: prev }),
      (e: unknown) => e instanceof ResumeMismatchError && e.fields.join() === "graders" && /graders changed/.test(e.message),
    );
    await assert.rejects(runExperiment({ name: "drift", dataset: ds, task: echo, graders: [exactGrader()], trials: 2, resumeFrom: prev }), (e: unknown) => e instanceof ResumeMismatchError && e.fields.join() === "trials");
    await assert.rejects(
      runExperiment({ name: "drift", dataset: ds, task: echo, graders: [exactGrader()], selection: { firstN: 3 }, resumeFrom: prev }),
      (e: unknown) => e instanceof ResumeMismatchError && e.fields.join() === "selection",
    );
  });

  it("without the new options nothing changes: no selection, no checkpoint, one write", async () => {
    let puts = 0;
    const spy = new FileEvalStore({ env: { CODING_SH_HOME: dir } });
    const put = spy.putExperiment.bind(spy);
    spy.putExperiment = async (r: ExperimentResult) => {
      puts++;
      return put(r);
    };
    const r = await runExperiment({ name: "plain", dataset: ds, task: echo, graders: [exactGrader()], store: spy });
    assert.equal(puts, 1);
    assert.equal(r.metadata, undefined);
  });
});

describe("selectRunCases", () => {
  const prev = { id: "exp_prev", runs: ds.cases.map((c, i) => ({ caseId: c.id, trial: 1, latencyMs: 1, startedAt: 0, grades: [], pass: i % 3 !== 0, ...(i === 4 ? { error: "boom", pass: false } : {}) })) };

  it("failing, errors, patterns, then sample, then first N", () => {
    assert.deepEqual(selectRunCases(ds.cases, { fromFailing: prev }).cases.map((c) => c.id), ["c0", "c3", "c4", "c6", "c9"]);
    assert.deepEqual(selectRunCases(ds.cases, { fromErrors: prev }).cases.map((c) => c.id), ["c4"]);
    assert.deepEqual(selectRunCases(ds.cases, { cases: ["c1", "c?"], firstN: 3 }).cases.map((c) => c.id), ["c0", "c1", "c2"]);
    const s = selectRunCases(ds.cases, { fromFailing: prev, cases: ["c*"], sample: 2, seed: 5, firstN: 1 });
    assert.equal(s.cases.length, 1);
    assert.deepEqual({ ...s.selection, cases: undefined }, { from: { kind: "failing", experiment: "exp_prev" }, cases: undefined, sample: 2, seed: 5, firstN: 1, selected: 1, of: 10 });
  });

  it("sampling is deterministic, by case id not position, and a share rounds", () => {
    const a = selectRunCases(ds.cases, { sample: 4, seed: 11 }).cases.map((c) => c.id);
    const b = selectRunCases([...ds.cases].reverse(), { sample: 4, seed: 11 }).cases.map((c) => c.id);
    assert.equal(a.length, 4);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.deepEqual(selectRunCases(ds.cases, { sample: 4, seed: 11 }).cases.map((c) => c.id), a);
    const others = new Set([1, 2, 3, 4, 5].map((seed) => selectRunCases(ds.cases, { sample: 4, seed }).cases.map((c) => c.id).join()));
    assert.ok(others.size > 1);
    assert.equal(selectRunCases(ds.cases, { sample: 0.25 }).cases.length, 3);
  });

  it("no options: every case, no selection; an empty pick throws", () => {
    const r = selectRunCases(ds.cases, {});
    assert.equal(r.cases.length, 10);
    assert.equal(r.selection, undefined);
    assert.throws(() => selectRunCases(ds.cases, { cases: ["zz*"] }), RangeError);
    assert.throws(() => selectRunCases(ds.cases, { sample: 1.5 }), RangeError);
  });
});

describe("the regression-to-the-mean guard", () => {
  // 40 cases; the baseline task is flaky (fails a seeded 30%); the candidate is the same task.
  const big = createDataset({ name: "rtm", createdAt: 1, cases: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, input: i, expected: i })) });
  let n = 0;
  const flaky = (x: unknown) => ((n = (n * 1103515245 + 12345) % 2147483648), n % 10 < 3 ? -1 : x);

  it("B on A's failures is inconclusive and holds; the fair re-run (both from A's failures) is not flagged", async () => {
    const a = await runExperiment({ name: "a", dataset: big, task: flaky, graders: [exactGrader()], concurrency: 1 });
    assert.ok(a.summary.passed < 40);
    const b = await runExperiment({ name: "b", dataset: big, task: flaky, graders: [exactGrader()], concurrency: 1, selection: { fromFailing: a } });
    const cmp = compareExperiments(a, b, { iters: 500, gate: { lambda: 1, alpha: 1, tau: 1 } });
    assert.ok(cmp.selectionWarning);
    assert.match(cmp.selectionWarning, /B ran only on the cases A failed \(--failing exp_/);
    assert.equal(cmp.verdict, "inconclusive");
    assert.ok(cmp.diff.mean > 0, "B looks better on A's failures");
    assert.equal(cmp.gate?.verdict, "hold");
    assert.equal(cmp.gate?.decision, "abstain");
    assert.match(renderComparison(cmp, { color: false, a, b }), /inconclusive \(one side ran only on the other's failures\)/);
    // Swapped sides name A.
    assert.match(compareExperiments(b, a, { iters: 200 }).selectionWarning!, /^A ran only on the cases B failed/);
    // The fair re-run: the baseline config on the same cases.
    const a2 = await runExperiment({ name: "a2", dataset: big, task: flaky, graders: [exactGrader()], concurrency: 1, selection: { fromFailing: a } });
    const fair = compareExperiments(a2, b, { iters: 500 });
    assert.equal(fair.selectionWarning, undefined);
    assert.equal(selectionWarning(a2, b), undefined);
    // Unrelated runs: no warning, and no field.
    const c = await runExperiment({ name: "c", dataset: big, task: (x: unknown) => x, graders: [exactGrader()] });
    assert.equal("selectionWarning" in compareExperiments(a, c, { iters: 200 }), false);
  });
});
