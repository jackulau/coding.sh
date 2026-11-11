// Stats and report shape: paired comparisons with Holm, places, power
// planning, history selection and segments, the paired series against a
// reference, and a report that is safe to publish.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { buildReport, renderReportHtml, scrubPaths } from "../../src/bench/report.ts";
import { runBench } from "../../src/bench/run.ts";
import { assignPlaces, comparePairs, countedCells, powerPlan, summarizeContender } from "../../src/bench/stats.ts";
import { historyRuns, listRuns, series, vsSeries } from "../../src/bench/store.ts";
import type { BenchRun, Cell } from "../../src/bench/types.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const cell = (caseId: string, contender: string, pass: boolean, extra: Partial<Cell> = {}): Cell => ({ caseId, contender, trial: 1, position: 0, pass, score: pass ? 1 : 0, latencyMs: 10, ...extra });

describe("bench stats", () => {
  test("pairs read leader − other, are Holm-adjusted, and places are shared when not significant", () => {
    const cells: Cell[] = [];
    for (let i = 0; i < 60; i++) {
      cells.push(cell(`c${i}`, "strong", true, { latencyMs: 20 }));
      cells.push(cell(`c${i}`, "weak", i % 2 === 0, { latencyMs: 10 }));
      cells.push(cell(`c${i}`, "twin", i !== 3, { latencyMs: 20 }));
    }
    const pairs = comparePairs(cells, ["weak", "strong", "twin"], { trials: 1, dataset: { id: "d", version: "v" }, graders: [], iters: 500 });
    const sw = pairs.find((p) => p.a === "strong" && p.b === "weak")!;
    assert.ok(sw.diff.mean > 0.4);
    assert.equal(sw.verdict, "a");
    assert.ok(sw.pAdj >= sw.p);
    assert.equal(Math.round(sw.latencyRatio! * 100) / 100, 2);
    const st = pairs.find((p) => (p.a === "strong" && p.b === "twin") || (p.a === "twin" && p.b === "strong"))!;
    assert.equal(st.verdict, "tie");
    const places = assignPlaces(["strong", "weak", "twin"].map((n) => summarizeContender(cells, { name: n, kind: "command", ref: n })), pairs);
    assert.deepEqual(places.map((s) => [s.contender, s.place]), [["strong", 1], ["twin", 1], ["weak", 3]]);
  });

  test("noVerdict marks every pair no-verdict, never a winner", () => {
    const cells = Array.from({ length: 40 }, (_, i) => [cell(`c${i}`, "a", true), cell(`c${i}`, "b", false)]).flat();
    const [p] = comparePairs(cells, ["a", "b"], { trials: 1, dataset: { id: "d", version: "v" }, graders: [], noVerdict: true, iters: 200 });
    assert.equal(p!.verdict, "no-verdict");
  });

  test("excluded or unfinished cases drop for everyone", () => {
    const cells = [cell("x", "a", true), cell("x", "b", false, { excluded: "quota" }), cell("y", "a", true), cell("y", "b", true), cell("z", "a", true)];
    const { cells: kept, dropped } = countedCells(cells, ["a", "b"], 1);
    assert.deepEqual([...dropped].sort(), ["x", "z"]);
    assert.deepEqual(kept.map((c) => c.caseId), ["y", "y"]);
  });

  test("CI: cluster bootstrap over cases with trials, Wilson with one", () => {
    const cells: Cell[] = [];
    for (let i = 0; i < 20; i++) for (let t = 1; t <= 3; t++) cells.push({ ...cell(`c${i}`, "a", i < 10), trial: t });
    const s3 = summarizeContender(cells, { name: "a", kind: "command", ref: "a" }, 3);
    assert.equal(s3.ciMethod, "cluster-bootstrap");
    // 20 clusters, not 60 independent trials: the interval is wider than Wilson over 60.
    assert.ok(s3.passRate.hi - s3.passRate.lo > 0.3);
    assert.equal(summarizeContender(cells.filter((c) => c.trial === 1), { name: "a", kind: "command", ref: "a" }, 1).ciMethod, "wilson");
  });

  test("powerPlan: MDE shrinks with n; Connor n for 10 points", () => {
    const small = powerPlan(50, 2);
    const big = powerPlan(400, 2);
    assert.ok(small.mde > big.mde);
    assert.ok(small.mde > 0.2 && small.mde < 0.3, `mde ${small.mde}`);
    assert.ok(small.nFor10 > 200 && small.nFor10 < 260, `n ${small.nFor10}`);
    assert.ok(powerPlan(50, 3).alpha < 0.05, "three pairs: Holm's worst case");
  });
});

describe("bench history and report", () => {
  async function threeDays(): Promise<{ runs: BenchRun[]; env: NodeJS.ProcessEnv }> {
    const p = project();
    for (const d of ["2026-11-04", "2026-11-05"]) await runBench({ def: p.def(), env: p.env, now: day(d) });
    await runBench({ def: p.def(), env: p.env, now: day("2026-11-05") + 3600e3 }); // rerun: adhoc
    await runBench({ def: p.def("trials = 1\nmaxPerHost = 5"), env: p.env, now: day("2026-11-06") }); // protocol change
    return { runs: await listRuns("arith", p.env), env: p.env };
  }

  test("series break at protocol changes; vsSeries is paired against the reference", async () => {
    const { runs } = await threeDays();
    const counted = historyRuns(runs);
    assert.equal(counted.length, 3);
    const s = series(counted, "pass");
    assert.deepEqual(s.good!.map((p) => p.segment), [0, 0, 1]);
    const vs = vsSeries(counted, "good");
    assert.deepEqual(Object.keys(vs), ["bad"]);
    assert.ok(vs.bad!.every((p) => p.value !== null && p.value <= 0 && p.lo! <= p.value && p.value <= p.hi!));
  });

  test("report: counted runs charted, others listed, private contents hidden, no local paths", async () => {
    const { runs } = await threeDays();
    const r = buildReport(runs, { now: day("2026-11-06") });
    assert.equal(r.runs.length, 3);
    assert.equal(r.otherRuns.length, 1);
    assert.equal(r.otherRuns[0]!.mode, "adhoc");
    assert.deepEqual(r.protocolBreaks, [2]);
    assert.equal(r.visibility, "private");
    assert.ok(r.redactedPrivate);
    assert.ok(r.cases.every((c) => c.input === "(private)"));
    assert.ok(Object.values(r.failures).flat().every((f) => f.input === "(private)" && !f.sessionUrl));
    const html = renderReportHtml(r);
    const json = JSON.stringify(r);
    for (const text of [html, json]) {
      assert.ok(!text.includes("/csh-bench-"), "no temp/project paths");
      assert.ok(!/\/(Users|home|private|var)\//.test(text), "no absolute paths");
    }
    for (const id of ["leaderboard", "trend", "head-to-head", "failures", "method"]) assert.match(html, new RegExp(`<section id="${id}"`));
    assert.match(html, /<svg class="trend lg" data-metric="pass"/);
    assert.match(html, /<svg class="trend sm" data-metric="gap"/);
    assert.match(html, /class="brk"/);
    assert.match(html, /95% CI, unadjusted/);
    assert.doesNotMatch(html, /<script|https?:\/\/(?!127\.0\.0\.1)[^"]*\.(css|js)/);
    const open = buildReport(runs, { includePrivate: true, now: day("2026-11-06") });
    assert.ok(open.cases.some((c) => typeof c.input === "object"));
  });

  test("scrubPaths keeps file names only", () => {
    assert.equal(scrubPaths("node /Users/me/proj/gen.mjs --x"), "node gen.mjs --x");
    assert.equal(scrubPaths("cd ~/work/a && run"), "cd a && run");
    assert.equal(scrubPaths('POST https://api.example.com/v1'), "POST https://api.example.com/v1");
  });
});
