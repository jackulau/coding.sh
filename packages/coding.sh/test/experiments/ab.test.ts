// Interleaved A/B runs (EM-2), early stopping on them (EM-3), and the timing
// note in compare. In-process function tasks only; the CLI path is in aa.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { runAb } from "../../src/experiments/ab.ts";
import { compareExperiments, runTiming } from "../../src/experiments/compare.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";

const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${String(i + 1).padStart(3, "0")}`, input: i }));
const ds = (n: number) => createDataset({ name: `ab${n}`, createdAt: 1, cases: cases(n) });
/** Passes when the task output is true. */
const truthy: Grader = { id: "ok", version: "1", kind: "custom", grade: async (ctx) => ({ score: ctx.output === true ? 1 : 0, pass: ctx.output === true }) };

describe("runAb: interleaving", () => {
  it("runs each case's two arms next to each other, in a seeded random order", async () => {
    const order: string[] = [];
    const arm = (name: string) => ({ name, task: { kind: "function" as const, name, fn: (i: unknown) => (order.push(`${name}:${String(i)}`), true) } });
    const r = await runAb({ name: "x", dataset: ds(30), arms: [arm("a"), arm("b")], graders: [truthy], concurrency: 1, seed: 9 });
    assert.equal(order.length, 60);
    const firsts = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 2) {
      const [x, y] = [order[i]!.split(":"), order[i + 1]!.split(":")];
      assert.equal(x[1], y[1], "the pair of one case runs back to back");
      assert.notEqual(x[0], y[0]);
      firsts.add(x[0]!);
      seen.add(x[1]!);
    }
    assert.equal(seen.size, 30);
    assert.deepEqual([...firsts].sort(), ["a", "b"], "either arm can go first");
    assert.notDeepEqual([...seen], cases(30).map((c) => String(c.input)), "cases run in a shuffled order");
    // Same seed, same schedule.
    const again: string[] = [];
    const arm2 = (name: string) => ({ name, task: { kind: "function" as const, name, fn: (i: unknown) => (again.push(`${name}:${String(i)}`), true) } });
    await runAb({ name: "x", dataset: ds(30), arms: [arm2("a"), arm2("b")], graders: [truthy], concurrency: 1, seed: 9 });
    assert.deepEqual(again, order);
    // Both arms carry the pair; names and ids follow A then B.
    assert.equal(r.a.name, "x-a");
    assert.equal(r.b.name, "x-b");
    assert.deepEqual(r.a.pair, { id: r.pairId, arm: "a", experiments: [r.a.id, r.b.id], seed: 9 });
    assert.equal(r.b.pair?.arm, "b");
    assert.equal(r.sequential, undefined);
  });

  it("cancels drift that would bias two back-to-back runs", async () => {
    // Identical configs; the provider degrades halfway through the work (calls 0..n-1 pass, later ones fail).
    const drifting = (total: number) => {
      let calls = 0;
      return () => calls++ < total / 2;
    };
    const fn = drifting(80);
    const task = { kind: "function" as const, name: "same", fn: () => fn() };
    const r = await runAb({ name: "drift", dataset: ds(40), arms: [{ name: "a", task }, { name: "b", task }], graders: [truthy], concurrency: 1, seed: 3 });
    const inter = compareExperiments(r.a, r.b, { seed: 1, iters: 2000 });
    assert.ok(Math.abs(inter.diff.mean) <= 0.025, `interleaved Δ ${inter.diff.mean}`);
    assert.equal(inter.timing.interleaved, true);
    assert.equal(inter.timing.warning, undefined);

    const fn2 = drifting(80);
    const seqTask = { kind: "function" as const, name: "same", fn: () => fn2() };
    const first = await runExperiment({ name: "s1", dataset: ds(40), task: seqTask, graders: [truthy], concurrency: 1 });
    const second = await runExperiment({ name: "s2", dataset: ds(40), task: seqTask, graders: [truthy], concurrency: 1 });
    const back = compareExperiments(first, second, { seed: 1, iters: 2000 });
    assert.equal(back.diff.mean, -1, "back to back, all of the drift lands on B");
    assert.equal(back.timing.interleaved, false);
    assert.match(back.timing.warning ?? "", /one after the other, not interleaved/);
  });

  it("runs at most --max-cases cases, the same ones in both arms", async () => {
    const r = await runAb({ name: "m", dataset: ds(50), arms: [{ name: "a", task: () => true }, { name: "b", task: () => false }], graders: [truthy], maxCases: 12, seed: 1 });
    assert.equal(r.a.summary.cases, 12);
    assert.deepEqual(new Set(r.a.runs.map((x) => x.caseId)), new Set(r.b.runs.map((x) => x.caseId)));
  });
});

describe("runAb: stopping early", () => {
  it("stops at the first look when B is clearly better and keeps only the cases it saw", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-ab-"));
    try {
      const store = new FileEvalStore({ root });
      const looks: number[] = [];
      const r = await runAb({
        name: "s",
        dataset: ds(200),
        arms: [
          { name: "base", task: () => false },
          { name: "cand", task: () => true },
        ],
        graders: [truthy],
        store,
        seed: 5,
        concurrency: 8,
        stopEarly: true,
        onLook: (l) => looks.push(l.n),
      });
      const s = r.sequential!;
      assert.deepEqual(s.plan.looks, [50, 100, 150, 200]);
      assert.deepEqual(looks, [50]);
      assert.equal(s.reason, "crossed");
      assert.equal(s.verdict, "better");
      assert.equal(s.early, true);
      assert.equal(s.stoppedAt, 50);
      assert.ok(s.diff.lo > 0.9, `repeated CI ${s.diff.lo}..${s.diff.hi}`);
      for (const x of [r.a, r.b]) {
        assert.equal(x.status, "completed");
        assert.equal(x.summary.cases, 50);
        assert.equal(x.runs.length, 50);
        assert.deepEqual(x.pair?.sequential, s);
      }
      // Stored with the pair; no progress log left behind.
      assert.deepEqual((await store.getExperiment(r.b.id))?.pair?.sequential?.stoppedAt, 50);
      assert.deepEqual((await readdir(join(root, "experiments"))).filter((f) => f.endsWith(".jsonl")), []);
      // compare follows the sequential verdict and says the bootstrap is too narrow.
      const c = compareExperiments(r.a, r.b, { seed: 1, iters: 1000 });
      assert.equal(c.verdict, "better");
      assert.equal(c.sequential?.stoppedAt, 50);
      assert.match(c.sequentialWarning ?? "", /stopped early at look 1 of 4/);
      const text = renderComparison(c, { color: false, a: r.a, b: r.b });
      assert.match(text, /^plan {4}group sequential, 4 looks at 50\/100\/150\/200 paired cases/m);
      assert.match(text, /^stopped early, look 1 of 4 at 50 paired cases: B is better/m);
      assert.match(text, /^seq Δ {3}\+100\.0pp \[\+\d+\.\dpp, \+100\.0pp\] \(50 paired cases, 95% repeated CI/m);
      assert.match(text, /^verdict B is better \(group sequential test\)$/m);
      // Swapped, the pair's sequential record does not apply.
      assert.equal(compareExperiments(r.b, r.a, { seed: 1, iters: 500 }).sequential, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the whole budget when nothing differs", async () => {
    const r = await runAb({ name: "n", dataset: ds(80), arms: [{ name: "a", task: (i) => Number(i) % 2 === 0 }, { name: "b", task: (i) => Number(i) % 2 === 0 }], graders: [truthy], seed: 2, stopEarly: { looks: 2 } });
    const s = r.sequential!;
    assert.deepEqual(s.plan.looks, [40, 80]);
    assert.equal(s.reason, "budget");
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.early, false);
    assert.equal(r.a.summary.cases, 80);
  });

  it("never looks before 20 paired cases", async () => {
    const r = await runAb({ name: "t", dataset: ds(30), arms: [{ name: "a", task: () => false }, { name: "b", task: () => true }], graders: [truthy], seed: 2, stopEarly: { looks: 10 } });
    const s = r.sequential!;
    assert.ok(s.plan.looks[0]! >= 20, `first look at ${s.plan.looks[0]}`);
    assert.ok(s.stoppedAt >= 20);
  });

  it("is cancelled, not stopped, when the caller aborts", async () => {
    const ac = new AbortController();
    let n = 0;
    const r = await runAb({
      name: "c",
      dataset: ds(100),
      arms: [
        { name: "a", task: () => (++n === 30 && ac.abort(), true) },
        { name: "b", task: () => true },
      ],
      graders: [truthy],
      signal: ac.signal,
      concurrency: 1,
      seed: 1,
      stopEarly: true,
    });
    assert.equal(r.a.status, "cancelled");
    assert.equal(r.sequential?.reason, "cancelled");
  });
});

describe("compare timing", () => {
  it("says how far apart two runs were when not interleaved", () => {
    const day = 24 * 3600_000;
    assert.deepEqual(runTiming({ createdAt: 0, finishedAt: 10 }, { createdAt: 5, finishedAt: 20 }), { interleaved: false, gapMs: 0 });
    const far = runTiming({ createdAt: 0, finishedAt: 10 }, { createdAt: 3 * day + 10, finishedAt: 3 * day + 20 });
    assert.equal(far.gapMs, 3 * day);
    assert.match(far.warning ?? "", /^A and B ran 3 days apart/);
    assert.match(runTiming({ createdAt: 0, finishedAt: 10 }, { createdAt: 30 * day, finishedAt: 30 * day + 1 }).warning ?? "", /30 days apart/);
    const pair = { id: "pair_1", arm: "a", experiments: ["x", "y"] as [string, string], seed: 1 };
    assert.deepEqual(runTiming({ createdAt: 0, finishedAt: 10, pair }, { createdAt: 0, finishedAt: 10, pair: { ...pair, arm: "b" } }), { interleaved: true, gapMs: 0 });
  });
});
