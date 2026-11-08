// Z-4 experiment matrices: JSON Pointer axes and variants expand into named
// cells off one base, any difference outside `vary` fails at plan time, and a
// run stores one experiment per cell, interleaved, compared with the baseline
// cell with Holm-adjusted p-values.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { checkOnlyVaried, expandMatrix, getAt, MatrixPlanError, mergeOverrides, parsePointer, planText, setAt, type MatrixSpec } from "../../src/experiments/matrix.ts";
import { checkExpPointers, holmComparisons, planMatrixTrials, runMatrixExperiment, type RunMatrixOpts } from "../../src/experiments/matrix-run.ts";
import { renderMatrixRun } from "../../src/experiments/render.ts";
import { exactGrader } from "../../src/graders/builtin.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const base = { task: { kind: "command", command: "node", args: ["agent.mjs"], env: { MODEL: "a", KEEP: "1" } }, trials: 1 };
const twoByThree: MatrixSpec = {
  matrix: {
    model: { path: "/task/env/MODEL", values: ["a", "b"] },
    prompt: { path: "/task/args", values: [{ x: ["x.mjs"] }, { y: ["y.mjs"] }, { z: ["z.mjs"] }] },
  },
  baseline: { model: "a", prompt: "x" },
};

/** The MatrixPlanError message `fn` throws. */
function planError(fn: () => unknown): MatrixPlanError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MatrixPlanError, `expected MatrixPlanError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected a MatrixPlanError");
}

describe("JSON Pointer", () => {
  it("unescapes ~1 and ~0 and creates missing parents", () => {
    assert.deepEqual(parsePointer("/a~1b/c~0d"), ["a/b", "c~d"]);
    assert.deepEqual(parsePointer("/"), [""]);
    planError(() => parsePointer("task/env"));
    const o: Record<string, unknown> = {};
    setAt(o, ["x", "y", "z"], 1);
    assert.deepEqual(o, { x: { y: { z: 1 } } });
    assert.equal(getAt({ a: [{ b: 2 }] }, ["a", "0", "b"]), 2);
  });

  it("merges: scalars and arrays replace, maps deep-merge, null deletes, base untouched", () => {
    const b = { task: { env: { A: "1", B: "2" }, args: ["x", "y"] } };
    const m = mergeOverrides(b, { "/task/env": { B: null, C: "3" }, "/task/args": ["z"] });
    assert.deepEqual(m, { task: { env: { A: "1", C: "3" }, args: ["z"] } });
    assert.deepEqual(mergeOverrides(b, { "/task/env/A": null }), { task: { env: { B: "2" }, args: ["x", "y"] } });
    assert.deepEqual(b, { task: { env: { A: "1", B: "2" }, args: ["x", "y"] } }, "base is never mutated");
  });

  it("checkOnlyVaried allows equal or parent vary entries on a token boundary", () => {
    const a = { task: { env: { MODEL: "a" }, command: "node" } };
    const b = { task: { env: { MODEL: "b", MODELX: "1" }, command: "deno" } };
    assert.deepEqual(checkOnlyVaried(a, b, ["/task/env/MODEL"]), ["/task/command", "/task/env/MODELX"]);
    assert.deepEqual(checkOnlyVaried(a, b, ["/task"]), []);
    assert.deepEqual(checkOnlyVaried({}, { task: { env: { M: "x" } } }, ["/task/env/M"]), [], "a map missing on one side lists its leaves");
  });
});

describe("expandMatrix", () => {
  it("expands a 2x3 matrix in declaration order, last axis fastest, with one baseline", () => {
    const plan = expandMatrix(base, twoByThree);
    assert.deepEqual(plan.cells.map((c) => c.name), ["model=a,prompt=x", "model=a,prompt=y", "model=a,prompt=z", "model=b,prompt=x", "model=b,prompt=y", "model=b,prompt=z"]);
    assert.equal(plan.baseline, "model=a,prompt=x");
    assert.deepEqual(plan.vary, ["/task/env/MODEL", "/task/args"]);
    const by = plan.cells.find((c) => c.name === "model=b,prompt=y")!;
    assert.deepEqual(by.labels, { model: "b", prompt: "y" });
    assert.deepEqual((by.config.task as { env: unknown }).env, { MODEL: "b", KEEP: "1" });
    assert.deepEqual((by.config.task as { args: unknown }).args, ["y.mjs"]);
    assert.equal(
      planText(plan),
      [
        'model=a,prompt=x  (baseline)',
        'model=a,prompt=y  /task/args=["y.mjs"]',
        'model=a,prompt=z  /task/args=["z.mjs"]',
        'model=b,prompt=x  /task/env/MODEL="b"',
        'model=b,prompt=y  /task/env/MODEL="b" /task/args=["y.mjs"]',
        'model=b,prompt=z  /task/env/MODEL="b" /task/args=["z.mjs"]',
      ].join("\n"),
    );
  });

  it("fails at plan time naming the field", () => {
    const one = planError(() => expandMatrix(base, { matrix: { model: { path: "/task/env/MODEL", values: ["a"] } }, baseline: { model: "a" } }));
    assert.match(one.message, /2 to 256 cells; this one has 1/);
    const values = Array.from({ length: 257 }, (_, i) => `v${i}`);
    assert.match(planError(() => expandMatrix(base, { matrix: { model: { path: "/task/env/MODEL", values } }, baseline: { model: "v0" } })).message, /has 257/);
    const bad = planError(() => expandMatrix(base, { matrix: { "mo del": { path: "/task/env/MODEL", values: ["a", "b"] } }, baseline: { "mo del": "a" } }));
    assert.equal(bad.field, "matrix.mo del");
    assert.match(planError(() => expandMatrix(base, { matrix: { "1": { path: "/task/env/MODEL", values: ["a", "b"] } }, baseline: { "1": "a" } })).message, /purely numeric/);
    assert.match(planError(() => expandMatrix(base, { matrix: { model: { path: "/task/env/MODEL", values: ["a", "a"] } }, baseline: { model: "a" } })).message, /label "a" twice/);
    const miss = planError(() => expandMatrix(base, { ...twoByThree, baseline: { model: "a" } }));
    assert.equal(miss.field, "baseline");
    assert.match(miss.message, /does not name axis prompt/);
    assert.match(planError(() => expandMatrix(base, { ...twoByThree, variants: { a: {}, b: {} } })).message, /exclusive/);
    assert.match(planError(() => expandMatrix(base, { ...twoByThree, vary: ["/task"] })).message, /vary" is derived from matrix axes/);
    assert.match(planError(() => expandMatrix(base, { matrix: { model: { path: "/task/env/MODEL", values: ["A", "a"] } }, baseline: { model: "a" } })).message, /differ only in case/);
  });

  it("refuses a variant that changes something outside vary, before any run", () => {
    const e = planError(() =>
      expandMatrix(base, {
        vary: ["/task/env/MODEL"],
        variants: { base: {}, cand: { "/task/env/MODEL": "b", "/task/command": "deno" } },
        baseline: "base",
      }),
    );
    assert.deepEqual(e.cells, { cand: ["/task/command"] });
    assert.match(e.message, /cand: \/task\/command/);
  });

  it("variants: null deletes an inherited env key and arrays replace", () => {
    const plan = expandMatrix(base, { vary: ["/task/env", "/task/args"], variants: { base: {}, lean: { "/task/env/KEEP": null, "/task/args": ["lean.mjs"] } }, baseline: "base" });
    const lean = plan.cells.find((c) => c.name === "lean")!.config.task as { env: Record<string, string>; args: string[] };
    assert.deepEqual(lean.env, { MODEL: "a" });
    assert.deepEqual(lean.args, ["lean.mjs"]);
    assert.match(planError(() => expandMatrix(base, { variants: { a: {}, b: {} }, baseline: "a" })).message, /needs "vary"/);
    assert.match(planError(() => expandMatrix(base, { vary: ["/task"], variants: { a: {} }, baseline: "a" })).message, /2 to 256 entries/);
  });

  it("exp run accepts only /task and /trials: graders and dataset define the comparison", () => {
    for (const p of ["/graders/0", "/dataset", "/split"]) {
      assert.match(planError(() => checkExpPointers({ vary: [p], variants: { a: {}, b: { [p]: "x" } }, baseline: "a" })).message, /graders and dataset are not overridable/);
    }
    assert.match(planError(() => checkExpPointers({ matrix: { g: { path: "/graders", values: ["a", "b"] } }, baseline: { g: "a" } })).message, /not overridable/);
    const name = expandMatrix(base, { vary: ["/name"], variants: { a: {}, b: { "/name": "x" } }, baseline: "a" });
    assert.match(planError(() => checkExpPointers(name)).message, /only change \/task\/… and \/trials/);
    checkExpPointers(expandMatrix(base, twoByThree));
    checkExpPointers(twoByThree);
    // An index pointer in vary covers just that element when the array keeps its length.
    const idx = expandMatrix(base, { vary: ["/task/args/0"], variants: { a: {}, b: { "/task/args/0": "b.mjs" } }, baseline: "a" });
    assert.equal(idx.cells.length, 2);
  });
});

describe("holmComparisons", () => {
  it("a single comparison keeps its raw p; more are adjusted upward", () => {
    const fake = (b: number, c: number, p: number) => ({ mcnemar: { b, c, n: b + c, p } }) as never;
    const one = holmComparisons({ x: fake(0, 6, 0.03) });
    assert.equal(one.x!.pHolm, 0.03);
    assert.equal(one.x!.holmVerdict, "better");
    const three = holmComparisons({ x: fake(0, 6, 0.03), y: fake(5, 0, 0.04), z: fake(1, 1, 1) });
    assert.equal(three.x!.pHolm, 0.09);
    assert.equal(three.y!.pHolm, 0.09);
    assert.equal(three.x!.holmVerdict, "inconclusive", "0.03 raw is not significant after Holm over 3");
    for (const k of ["x", "y", "z"] as const) assert.ok(three[k]!.pHolm >= ({ x: 0.03, y: 0.04, z: 1 })[k]);
  });
});

describe("runMatrixExperiment", () => {
  // Echoes the input upper-cased, except under MODEL=bad (wrong on every case) and MODEL=half (wrong on "a" and "b").
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const m=process.env.MODEL;const bad=m==="bad"||(m==="half"&&["a","b"].includes(q));process.stdout.write(JSON.stringify(bad?"no":q.toUpperCase()))})';
  const cases = ["a", "b", "c", "d"].map((q) => ({ id: q, input: q, expected: q.toUpperCase() }));
  const ds = createDataset({ name: "upper", createdAt: 1, cases });
  const spec = { task: { kind: "command", command: process.execPath, args: ["-e", script], env: { MODEL: "good" } } };
  const matrix: MatrixSpec = { matrix: { model: { path: "/task/env/MODEL", values: ["good", "half", "bad"] } }, baseline: { model: "good" } };

  it("stores one experiment per cell sharing metadata.matrix, interleaved, compared with the baseline", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-matrix-")));
    dirs.push(root);
    const store = new FileEvalStore({ root });
    const plan = expandMatrix(spec, matrix);
    const r = await runMatrixExperiment({ name: "m", dataset: ds, graders: [exactGrader()], plan, store, seed: 7 });
    assert.equal(r.status, "completed");
    assert.deepEqual(Object.keys(r.experiments), ["model=good", "model=half", "model=bad"]);
    assert.deepEqual(Object.keys(r.comparisons), ["model=half", "model=bad"], "the baseline is not compared with itself");
    const stored = await store.listExperiments({});
    assert.equal(stored.length, 3);
    for (const e of stored) {
      const m = e.metadata?.matrix as { id: string; baseline: string; vary: string[]; cell: string };
      assert.equal(m.id, r.id);
      assert.equal(m.baseline, "model=good");
      assert.deepEqual(m.vary, ["/task/env/MODEL"]);
      assert.equal(e.name, `m/${m.cell}`);
    }
    assert.equal(r.experiments["model=good"]!.summary.passed, 4);
    assert.equal(r.experiments["model=half"]!.summary.passed, 2);
    assert.equal(r.experiments["model=bad"]!.summary.passed, 0);
    const bad = r.comparisons["model=bad"]!;
    assert.equal(bad.mcnemar.b, 4);
    assert.ok(bad.pHolm >= bad.mcnemar.p);
    assert.equal(bad.timing.interleaved, true, "cells of one matrix ran interleaved");
    assert.equal(bad.timing.warning, undefined);
    // The same comparison exp compare gives on the stored cells.
    const again = compareExperiments(r.experiments["model=good"]!, r.experiments["model=bad"]!);
    assert.equal(again.diff.mean, bad.diff.mean);
    assert.equal(again.timing.interleaved, true);
    const text = renderMatrixRun(r, { color: false });
    assert.match(text, /model=bad +0\.0% +-100\.0pp/);
    assert.match(text, /Holm-adjusted over 2 comparisons/);
  });

  it("--cell runs a subset and always the baseline", async () => {
    const plan = expandMatrix(spec, matrix);
    const r = await runMatrixExperiment({ name: "m", dataset: ds, graders: [exactGrader()], plan, only: ["model=bad"], seed: 1 });
    assert.deepEqual(Object.keys(r.experiments), ["model=good", "model=bad"]);
    assert.equal(r.comparisons["model=bad"]!.pHolm, r.comparisons["model=bad"]!.mcnemar.p, "a single comparison: adjusted = raw");
    await assert.rejects(runMatrixExperiment({ name: "m", dataset: ds, graders: [exactGrader()], plan, only: ["nope"] }), /not a cell/);
  });
});

describe("runMatrixExperiment --reuse", () => {
  // Like the script above, and appends the MODEL it ran under to $CALLS, so a test can count task calls per cell.
  const script = 'const fs=require("node:fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const m=process.env.MODEL;fs.appendFileSync(process.env.CALLS,m+"\\n");const bad=m==="bad"||(m==="half"&&["a","b"].includes(q));process.stdout.write(JSON.stringify(bad?"no":q.toUpperCase()))})';
  const cases = ["a", "b", "c", "d"].map((q) => ({ id: q, input: q, expected: q.toUpperCase() }));
  const matrix: MatrixSpec = { matrix: { model: { path: "/task/env/MODEL", values: ["good", "half", "bad"] } }, baseline: { model: "good" } };

  async function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-mxreuse-")));
    dirs.push(root);
    const calls = join(root, "calls.log");
    const store = new FileEvalStore({ root: join(root, "store") });
    const ds = createDataset({ name: "upper", createdAt: 1, cases });
    await store.putDataset(ds);
    const spec = { task: { kind: "command", command: process.execPath, args: ["-e", script], env: { MODEL: "good", CALLS: calls } } };
    const plan = expandMatrix(spec, matrix);
    const count = () => {
      const out: Record<string, number> = {};
      try {
        for (const m of readFileSync(calls, "utf8").split("\n").filter(Boolean)) out[m] = (out[m] ?? 0) + 1;
      } catch {
        // no calls yet
      }
      rmSync(calls, { force: true });
      return out;
    };
    const opts = (o: Partial<RunMatrixOpts> = {}): RunMatrixOpts => ({ name: "m", dataset: ds, graders: [exactGrader()], plan, store, seed: 3, ...o });
    return { root, store, ds, spec, plan, count, opts };
  }

  it("baseline: a second matrix copies the baseline cell and runs the others; the copies are marked and timing is not called interleaved", async () => {
    const s = await setup();
    const first = await runMatrixExperiment(s.opts());
    assert.deepEqual(s.count(), { good: 4, half: 4, bad: 4 });
    assert.equal(first.reused, undefined, "no reuse asked, no reuse field");
    const planned = await planMatrixTrials({ dataset: s.ds, graders: [exactGrader()], cells: s.plan.cells, baseline: s.plan.baseline, store: s.store, reuse: { cells: "baseline" } });
    assert.deepEqual(planned.counts, { "model=good": { reused: 4, toRun: 0 }, "model=half": { reused: 0, toRun: 4 }, "model=bad": { reused: 0, toRun: 4 } });
    const second = await runMatrixExperiment(s.opts({ reuse: { cells: "baseline" } }));
    assert.deepEqual(s.count(), { half: 4, bad: 4 }, "the baseline cell made no task call");
    assert.deepEqual(second.reused, { "model=good": 4, "model=half": 0, "model=bad": 0 });
    const good = second.experiments["model=good"]!;
    assert.equal(good.summary.passed, 4);
    const firstGood = first.experiments["model=good"]!;
    for (const r of good.runs) assert.equal(r.reusedFrom, firstGood.id);
    assert.equal((good.metadata?.matrix as { reused?: number }).reused, 4);
    assert.equal((second.experiments["model=bad"]!.metadata?.matrix as { reused?: number }).reused, undefined, "absent when none were reused");
    const bad = second.comparisons["model=bad"]!;
    assert.equal(bad.mcnemar.b, 4, "the comparison uses the copied baseline");
    assert.equal(bad.timing.interleaved, false);
    assert.match(bad.timing.warning ?? "", /reused case-trials from earlier experiments/);
    const text = renderMatrixRun(second, { color: false });
    assert.match(text, /4 case-trials reused/);
    assert.match(text, /reused case-trials from earlier experiments \(model=good 4\/4\)/);
    // A third run copies the originals, never a copy of a copy.
    const third = await runMatrixExperiment(s.opts({ reuse: { cells: "all" } }));
    assert.deepEqual(s.count(), {});
    assert.deepEqual(third.reused, { "model=good": 4, "model=half": 4, "model=bad": 4 });
    for (const r of third.experiments["model=good"]!.runs) assert.equal(r.reusedFrom, firstGood.id);
    for (const r of third.experiments["model=bad"]!.runs) assert.equal(r.reusedFrom, second.experiments["model=bad"]!.id);
  });

  it("misses on a changed case, a changed task, another grader version, a timeout and an age past the limit", async () => {
    const s = await setup();
    await runMatrixExperiment(s.opts());
    s.count();
    const plan = (o: Partial<Parameters<typeof planMatrixTrials>[0]>) =>
      planMatrixTrials({ dataset: s.ds, graders: [exactGrader()], cells: s.plan.cells, baseline: s.plan.baseline, store: s.store, reuse: { cells: "baseline" }, ...o }).then((p) => p.counts["model=good"]!.reused);
    assert.equal(await plan({}), 4);
    const edited = createDataset({ name: "upper", createdAt: 1, cases: cases.map((c) => (c.id === "a" ? { ...c, expected: "AA" } : c)) });
    assert.equal(await plan({ dataset: { ...edited, id: s.ds.id } }), 3, "one case changed");
    const otherTask = expandMatrix({ task: { ...s.spec.task, args: ["-e", script + ";"] } }, matrix);
    assert.equal(await plan({ cells: otherTask.cells }), 0, "the task changed");
    assert.equal(await plan({ graders: [{ ...exactGrader(), version: "other" }] }), 0, "a grader changed");
    assert.equal(await plan({ timeoutMs: 60_000 }), 0, "a different trial timeout");
    assert.equal(await plan({ reuse: { cells: "baseline", maxAgeMs: 1, now: () => Date.now() + 1000 } }), 0, "older than the limit");
    assert.equal(await plan({ reuse: undefined }), 0, "no reuse");
  });

  it("resume keeps the recorded copies instead of copying again", async () => {
    const s = await setup();
    await runMatrixExperiment(s.opts());
    s.count();
    const recorded = new Map<string, { data?: unknown }>();
    const state = new Map<string, unknown>();
    const scope = (prefix: string): unknown => ({
      prefix,
      job: { setTotal: async () => {}, addRefs: async () => {} },
      done: (key: string) => recorded.get(prefix + key),
      record: async (key: string, line: { data?: unknown }) => void recorded.set(prefix + key, line),
      state: (n: string) => state.get(prefix + n),
      setState: async (n: string, v: unknown) => void state.set(prefix + n, v),
      scope: (p: string) => scope(prefix + p),
    });
    const o = s.opts({ reuse: { cells: "baseline" }, job: scope("") as never });
    const r1 = await runMatrixExperiment(o);
    assert.deepEqual(s.count(), { half: 4, bad: 4 });
    const r2 = await runMatrixExperiment(o);
    assert.deepEqual(s.count(), {}, "everything came from the job");
    assert.equal(r2.experiments["model=good"]!.id, r1.experiments["model=good"]!.id);
    assert.deepEqual(r2.reused, r1.reused);
  });
});
