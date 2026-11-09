// R2-10: sequential comparisons. Each arm runs the tasks in a fixed order per
// stream (attempt), carrying the named HOME state from one run to the next, and
// the report shows pass rate by position. A fake agent that keeps a memory file
// in HOME and fixes the bug once it has seen two tasks shows a rising curve
// when its memory is carried and a flat one when it is not.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EvalTask, RunSpec } from "../../src/core/types.ts";
import { compare, formatCompare, runExperiment } from "../../src/runner/experiment.ts";
import { armLearning, carryRel, streamOrders } from "../../src/runner/sequence.ts";
import { cleanupWorlds, FIXED, fakeAdapter, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

/** Counts the tasks it has seen in $HOME/memory/count and fixes the bug from the third one on. */
const learner = () =>
  fakeAdapter({
    act: async (spec: RunSpec) => {
      const home = spec.env.HOME;
      assert.ok(home, "a sequential run gets its own HOME");
      const file = join(home, "memory", "count");
      const seen = existsSync(file) ? Number(await readFile(file, "utf8")) : 0;
      await mkdir(join(home, "memory"), { recursive: true });
      await writeFile(file, String(seen + 1));
      return seen >= 2 ? { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string } : undefined;
    },
  });

async function world(n: number) {
  const w = await toyWorld();
  const tasks: EvalTask[] = Array.from({ length: n }, (_, i) => ({ ...w.task, id: `t${i + 1}` }));
  return { ...w, tasks };
}

describe("compare --sequential", () => {
  it("carried memory gives a rising curve; the arm that carries nothing stays flat", async () => {
    const w = await world(6);
    const memory = await w.mkBundle("memory", "x");
    const amnesiac = await w.mkBundle("amnesiac", "y");
    // Same agent; only the baseline carries its memory dir from task to task.
    const carried = await runExperiment({ tasks: w.tasks, bundles: [memory], adapterFor: learner, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, k: 2, sequence: { carry: ["~/memory"] }, concurrency: 2 });
    const fresh = await runExperiment({ tasks: w.tasks, bundles: [amnesiac], adapterFor: learner, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, k: 2, sequence: { carry: [".nothing-here"] }, concurrency: 2 });
    const all = [...carried.results, ...fresh.results];
    assert.equal(all.length, 24);
    for (const r of all) assert.ok(r.sequence && r.sequence.stream >= 1 && r.sequence.step >= 1);
    const report = compare(all, { baseline: amnesiac.id, candidate: memory.id, iters: 200 });
    const L = report.learning;
    assert.ok(L?.baseline && L.candidate);
    // Positions 1–2 fail and 3–6 pass in both streams of the carrying arm.
    assert.deepEqual(L.candidate.steps.map((s) => s.rate), [0, 0, 1, 1, 1, 1]);
    assert.equal(L.candidate.first.rate, 0);
    assert.equal(L.candidate.last.rate, 1);
    assert.equal(L.candidate.gain, 1);
    assert.deepEqual(L.baseline.steps.map((s) => s.rate), [0, 0, 0, 0, 0, 0]);
    assert.equal(L.baseline.gain, 0);
    assert.equal(L.diff, 1);
    assert.equal(L.third, 2);
    const text = formatCompare(report);
    assert.match(text, /learning \(sequential/);
    assert.match(text, /^curve % +0 0 0 0 0 0 +0 0 100 100 100 100/m);
    assert.match(text, /^first → last +0\.0% → 0\.0% +0\.0% → 100\.0% +gain \+100\.0 pp/m);
    // Finished runs leave no carried state behind.
    assert.equal(existsSync(join(w.runsDir, `${carried.experimentId}.state`)), false);
  });

  it("runs each stream in task order, one run at a time", async () => {
    const w = await world(4);
    const order: string[] = [];
    let live = 0;
    let peak = 0;
    const agent = () =>
      fakeAdapter({
        act: async (spec: RunSpec) => {
          live++;
          peak = Math.max(peak, live);
          order.push(spec.runId);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          return undefined;
        },
      });
    const r = await runExperiment({ tasks: w.tasks, bundles: [await w.mkBundle("a", "x")], adapterFor: agent, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, k: 1, sequence: { carry: ["~"] }, concurrency: 4 });
    assert.equal(peak, 1, "one stream runs one task at a time");
    assert.deepEqual(
      [...r.results].sort((a, b) => a.sequence!.step - b.sequence!.step).map((x) => x.taskId),
      ["t1", "t2", "t3", "t4"],
    );
  });

  it("seeded orders are reproducible and differ per stream", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}` }) as EvalTask);
    const ids = (o: EvalTask[][]) => o.map((s) => s.map((t) => t.id).join(","));
    const a = ids(streamOrders(tasks, 3, { order: "seeded", seed: 7 }));
    assert.deepEqual(a, ids(streamOrders(tasks, 3, { order: "seeded", seed: 7 })));
    assert.notDeepEqual(a, ids(streamOrders(tasks, 3, { order: "seeded", seed: 8 })));
    assert.equal(new Set(a).size, 3);
    assert.deepEqual(ids(streamOrders(tasks, 2)), [tasks.map((t) => t.id).join(","), tasks.map((t) => t.id).join(",")]);
  });

  it("carry paths stay inside HOME", () => {
    assert.equal(carryRel("~"), "");
    assert.equal(carryRel("~/.claude/"), ".claude");
    assert.equal(carryRel("./memory"), "memory");
    for (const bad of ["/etc", "~/../x", "a/../../b", "C:/x"]) assert.throws(() => carryRel(bad), /inside HOME/);
  });

  it("without --sequential: no positions, no learning section, no forced HOME", async () => {
    const w = await world(2);
    const agent = fakeAdapter();
    const [a, b] = [await w.mkBundle("a", "x"), await w.mkBundle("b", "y")];
    const r = await runExperiment({ tasks: w.tasks, bundles: [a, b], adapterFor: () => agent, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    for (const x of r.results) assert.equal(x.sequence, undefined);
    for (const s of agent.specs) assert.equal(s.env.HOME, undefined);
    const rep = compare(r.results, { baseline: a.id, candidate: b.id, iters: 100 });
    assert.equal(rep.learning, undefined);
    assert.doesNotMatch(formatCompare(rep), /learning/);
    assert.equal(armLearning(r.results), undefined);
  });
});
