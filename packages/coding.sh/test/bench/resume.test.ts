// `bench run --resume`: an incomplete run (interrupt or budget stop) continues
// from its record with the same seed, cases and job order; finished calls are
// kept, and the record keeps its id.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { resumeBench, resumeTarget, runBench } from "../../src/bench/run.ts";
import { historyRuns, listRuns } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const run = (o: Parameters<typeof runBench>[0]) => runBench(o) as Promise<BenchRun>;

describe("bench run --resume", () => {
  test("after an interrupt: same id, seed and cases, finished cells kept, then it counts", async () => {
    const p = project();
    const def = p.def();
    const ac = new AbortController();
    await assert.rejects(
      runBench({ def, env: p.env, now: day("2026-11-04"), signal: ac.signal, onProgress: (done, _t, phase) => phase === "run" && done >= 6 && ac.abort() }),
      /interrupted; the partial run is saved as (\S+)/,
    );
    const [partial] = await listRuns("arith", p.env);
    assert.equal(partial!.status, "incomplete");
    assert.equal(partial!.stopReason, "interrupted");
    assert.ok(partial!.cells.length < 24);
    assert.equal(historyRuns([partial!]).length, 0);
    assert.equal(resumeTarget([partial!])!.id, partial!.id);

    const done = await resumeBench({ def, env: p.env, now: day("2026-11-04") + 600e3 });
    assert.equal(done.id, partial!.id);
    assert.equal(done.status, "complete");
    assert.equal(done.stopReason, undefined);
    assert.equal(done.seed, partial!.seed);
    assert.deepEqual(done.cases, partial!.cases);
    assert.equal(done.dataset.sha256, partial!.dataset.sha256);
    assert.equal(done.cells.length, 24);
    assert.deepEqual(done.cells.map((x) => x.position).sort((a, b) => a - b), [...Array(24).keys()], "positions follow the original job order");
    // Every cell that finished before the interrupt is carried over untouched.
    const kept = partial!.cells.filter((x) => x.excluded !== "aborted");
    for (const k of kept) assert.deepEqual(done.cells.find((x) => x.caseId === k.caseId && x.contender === k.contender && x.trial === k.trial), k);
    assert.equal(done.resumed!.length, 1);
    assert.equal(done.resumed![0]!.calls, 24 - kept.length);
    assert.ok(!done.warnings.some((w) => /interrupted/.test(w)));
    // One record, overwritten, and now counted for its date.
    const all = await listRuns("arith", p.env);
    assert.equal(all.length, 1);
    assert.deepEqual(historyRuns(all).map((r) => r.id), [done.id]);
    assert.equal(done.mode, "scheduled");
    await assert.rejects(resumeBench({ def, env: p.env }), /no incomplete run/);
    await assert.rejects(resumeBench({ def, env: p.env, run: done.id }), /is complete; nothing to resume/);
  });

  test("after a budget stop: refuses until budget_usd is raised, then finishes the same sample", async () => {
    const p = project();
    const r = await run({ def: p.def("budget_usd = 0.005"), env: p.env, now: day("2026-11-04") });
    assert.equal(r.stopReason, "budget");
    assert.match(r.warnings.join("\n"), /--resume continues it/);
    await assert.rejects(resumeBench({ def: p.def("budget_usd = 0.005"), env: p.env }), /raise budget_usd/);
    // budget_usd isn't part of the protocol, so raising it keeps the run resumable.
    const done = await resumeBench({ def: p.def("budget_usd = 1"), env: p.env, run: r.date });
    assert.equal(done.id, r.id);
    assert.equal(done.status, "complete");
    assert.equal(done.cells.length, 24);
    assert.deepEqual(done.cases, r.cases);
    assert.ok(done.budget!.spentUsd > r.budget!.spentUsd, "spend continues from the stored total");
    assert.equal(done.budget!.capUsd, 1);
  });

  test("refuses when the protocol or a contender changed, and goes adhoc if another run took the date", async () => {
    const p = project();
    const ac = new AbortController();
    await assert.rejects(runBench({ def: p.def(), env: p.env, now: day("2026-11-04"), signal: ac.signal, onProgress: (d, _t, ph) => ph === "run" && d >= 3 && ac.abort() }), /interrupted/);
    await assert.rejects(resumeBench({ def: p.def("trials = 2"), env: p.env }), /protocol changed/);
    p.def(); // p.def(extra) rewrites the file; put the original back
    // Contender definitions are hashed from the table, not the script, so edit the table.
    const text = (await import("node:fs")).readFileSync(p.file, "utf8").replace('command = "node bad.cjs"', 'command = "node bad.cjs --v2"');
    const { parseDefinition } = await import("../../src/bench/define.ts");
    await assert.rejects(resumeBench({ def: parseDefinition(text, p.file), env: p.env }), /contender bad changed/);
    // Meanwhile a fresh run completes for the same date and counts; the resumed one can't count too.
    const other = await run({ def: p.def(), env: p.env, now: day("2026-11-04") + 3600e3 });
    assert.equal(other.mode, "scheduled");
    const resumed = await resumeBench({ def: p.def(), env: p.env });
    assert.equal(resumed.mode, "adhoc");
    assert.match(resumed.warnings[0]!, /another run now counts for 2026-11-04/);
    assert.deepEqual(historyRuns(await listRuns("arith", p.env)).map((x) => x.id), [other.id]);
  });
  test("CLI: --resume continues the stored run; it refuses flags that would change the sample", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const p = project();
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", main, ...args], { cwd: p.root, env: { ...p.env, NO_COLOR: "1", CODING_SH_BENCH_NOW: "2026-11-04T06:15:00Z" }, encoding: "utf8" });
    const stopped = await run({ def: p.def("budget_usd = 0.005"), env: p.env, now: day("2026-11-04") });
    assert.equal(cli(["bench", "run", "arith", "--resume", "--seed", "x"]).status, 2);
    assert.match(cli(["bench", "run", "arith", "--run", stopped.id]).stderr, /add --resume/);
    p.def("budget_usd = 1");
    const r = cli(["bench", "run", "arith", "--resume", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.outcome, "completed");
    assert.equal(j.run.id, stopped.id);
    assert.equal(j.run.resumed.length, 1);
  });
});
