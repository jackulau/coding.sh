// Anchor set (#17): a fixed, versioned subset that runs every day next to the
// fresh cases and is scored apart, so its trend stays comparable across days.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport, renderReportHtml } from "../../src/bench/report.ts";
import { regradeRun, runBench, storedAnchor } from "../../src/bench/run.ts";
import { historyRuns, listRuns, seenKeys, series, vsSeries } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const run = (o: Parameters<typeof runBench>[0]) => runBench(o) as Promise<BenchRun>;
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("bench anchor set", () => {
  test("the same cases every day, kept out of the fresh numbers and the ledger", async () => {
    const p = project();
    const def = p.def("[anchor]\ncases = 4");
    assert.deepEqual(def.anchor, { cases: 4, version: "1" });
    const r1 = await run({ def, env: p.env, now: day("2026-11-04") });
    const r2 = await run({ def, env: p.env, now: day("2026-11-05") });
    const r3 = await run({ def, env: p.env, now: day("2026-11-06") });
    const anchors = (r: BenchRun) => r.cases.filter((c) => c.anchor);
    const fresh = (r: BenchRun) => r.cases.filter((c) => !c.anchor);
    assert.equal(anchors(r1).length, 4);
    assert.equal(fresh(r1).length, 12);
    assert.deepEqual(anchors(r2), anchors(r1), "day 2 reuses day 1's anchor cases");
    assert.deepEqual(anchors(r3), anchors(r1));
    assert.equal(r1.anchor!.frozenBy, r1.id);
    assert.equal(r3.anchor!.frozenBy, r1.id);
    assert.equal(r3.anchor!.sha256, r1.anchor!.sha256);
    // Fresh cases never repeat an anchor case or each other across days.
    const anchorKeys = new Set(anchors(r1).map((c) => c.key));
    for (const r of [r1, r2, r3]) assert.ok(fresh(r).every((c) => !anchorKeys.has(c.key)));
    const all = await listRuns("arith", p.env);
    assert.equal(seenKeys(all).size, 36, "only fresh cases enter the ledger");
    // Every contender ran both sets; the numbers are split.
    assert.equal(r1.cells.length, 32);
    for (const s of r1.summaries) assert.equal(s.n, 12);
    for (const s of r1.anchor!.summaries) assert.equal(s.n, 4);
    assert.equal(r1.anchor!.comparisons.length, 1);
    // Anchor series read the anchor numbers and keep one segment.
    const counted = historyRuns(all);
    const a = series(counted, "pass", { anchor: true });
    assert.deepEqual(a.good!.map((x) => x.n), [4, 4, 4]);
    assert.deepEqual(a.good!.map((x) => x.segment), [0, 0, 0]);
    assert.equal(vsSeries(counted, "good", { anchor: true }).bad!.length, 3);
    assert.deepEqual(series(counted, "pass").good!.map((x) => x.n), [12, 12, 12]);
  });

  test("history --anchor, the report section and the MCP flag", async () => {
    const p = project();
    const def = p.def("[anchor]\ncases = 3");
    for (const d of ["2026-11-04", "2026-11-05"]) await run({ def, env: p.env, now: day(d) });
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: p.root, env: { ...p.env, NO_COLOR: "1" }, encoding: "utf8" });
    const h = cli(["bench", "history", "arith", "--anchor", "--json"]);
    assert.equal(h.status, 0, h.stderr);
    const hj = JSON.parse(h.stdout);
    assert.equal(hj.set, "anchor");
    assert.deepEqual(hj.runs.map((r: { cases: number }) => r.cases), [3, 3]);
    assert.deepEqual(hj.series.good.map((x: { n: number }) => x.n), [3, 3]);
    const show = cli(["bench", "show", "arith"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /12 cases \+ 3 anchor/);
    assert.match(show.stdout, /Anchor set v1: 3 cases/);
    const rep = buildReport(await listRuns("arith", p.env));
    assert.equal(rep.anchor!.cases, 3);
    assert.deepEqual(rep.anchor!.history.good!.map((x) => x.n), [3, 3]);
    assert.ok(rep.difficulty.anchor);
    assert.equal(rep.runs[0]!.cases, 12);
    const html = renderReportHtml(rep);
    assert.match(html, /<section id="anchor">/);
    assert.match(html, /<th class="num">Anchor set<\/th>/);
    assert.match(html, /when only fresh drops, the day's cases were harder/);
    assert.match(html, /\d+ skipped as already tested, \d+ duplicates dropped; plus 3 anchor cases, scored apart/);
    const { buildTools } = await import("../../src/mcp/tools.ts");
    const tool = buildTools().find((t) => t.name === "benchmarks")!;
    const ctx = { env: p.env, cwd: p.root } as never;
    const m = (await tool.run({ name: "arith", metric: "pass", anchor: true }, ctx)) as { set: string; runs: { cases: number }[] };
    assert.equal(m.set, "anchor");
    assert.equal(m.runs[0]!.cases, 3);
    const one = (await tool.run({ name: "arith" }, ctx)) as { cases: number; anchor: { cases: number; leaderboard: unknown[] } };
    assert.equal(one.cases, 12);
    assert.equal(one.anchor.cases, 3);
    assert.equal(one.anchor.leaderboard.length, 2);
  });

  test("a new version picks a new set; regrade keeps the anchor numbers apart", async () => {
    const p = project();
    const r1 = await run({ def: p.def("[anchor]\ncases = 4"), env: p.env, now: day("2026-11-04") });
    const v2 = p.def('[anchor]\ncases = 4\nversion = "2"');
    assert.notEqual(v2.protocolHash, p.def("[anchor]\ncases = 4").protocolHash, "the anchor is part of the protocol");
    const r2 = await run({ def: v2, env: p.env, now: day("2026-11-05") });
    assert.equal(r2.anchor!.version, "2");
    assert.equal(r2.anchor!.frozenBy, r2.id);
    assert.notEqual(r2.anchor!.sha256, r1.anchor!.sha256);
    assert.equal(storedAnchor(v2, await listRuns("arith", p.env))!.frozenBy, r2.id);
    const re = await regradeRun(r2, { def: v2, env: p.env });
    assert.equal(re.anchor!.cases, 4);
    for (const s of re.summaries) assert.equal(s.n, 12);
    for (const s of re.anchor!.summaries) assert.equal(s.n, 4);
  });
  test("definition rules", () => {
    const p = project();
    assert.deepEqual(p.def('[anchor]\nversion = "2026-q4"').anchor, { cases: 30, version: "2026-q4" });
    assert.deepEqual(p.def("[anchor]\ncases = 5\nversion = 3").anchor, { cases: 5, version: "3" });
    assert.throws(() => p.def("[anchor]\ncases = 5\nsize = 3"), /\[anchor\] takes cases and version/);
    assert.throws(() => p.def("[anchor]\ncases = 0"), /at least 1/);
    assert.throws(() => p.def('anchor = "yes"'), /\[anchor\] must be a table/);
    assert.equal(p.def().anchor, undefined);
  });
});
