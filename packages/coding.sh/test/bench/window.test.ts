// The window estimate: per-day gaps pooled over the definition's `window`
// (DerSimonian-Laird with the HKSJ interval), and the t quantile behind it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport, renderReportHtml } from "../../src/bench/report.ts";
import { runBench } from "../../src/bench/run.ts";
import { pooledGap, tQuantile } from "../../src/bench/stats.ts";
import { listRuns } from "../../src/bench/store.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe("bench window estimate", () => {
  test("t quantiles", () => {
    // Table values (two-sided 95% and one 99.5%).
    close(tQuantile(0.975, 1), 12.7062, 1e-4);
    close(tQuantile(0.975, 2), 4.3027, 1e-4);
    close(tQuantile(0.975, 3), 3.1824, 1e-4);
    close(tQuantile(0.975, 5), 2.5706, 1e-4);
    close(tQuantile(0.975, 10), 2.2281, 1e-4);
    close(tQuantile(0.975, 30), 2.0423, 1e-4);
    close(tQuantile(0.995, 4), 4.6041, 1e-4);
    close(tQuantile(0.025, 7), -2.3646, 1e-4);
    const mid = tQuantile(0.975, 2.5);
    assert.ok(mid < tQuantile(0.975, 2) && mid > tQuantile(0.975, 3), "non-integer df falls between its neighbours");
    assert.equal(tQuantile(0.5, 9), 0);
  });

  test("identical days: no between-day variance, and the pooled CI is narrower than one day's", () => {
    const day1 = { value: 0.2, lo: 0.1, hi: 0.3, n: 50 };
    const g = pooledGap(Array.from({ length: 10 }, () => day1))!;
    assert.equal(g.k, 10);
    assert.equal(g.cases, 500);
    assert.equal(g.tau2, 0);
    assert.equal(g.i2, 0);
    close(g.fixed.mean, 0.2, 1e-12);
    close(g.random.mean, 0.2, 1e-12);
    assert.ok(g.random.hi - g.random.lo < day1.hi - day1.lo);
    // HKSJ never goes below the DL variance: ~ t(9) × se/√10.
    const se = 0.1 / 1.959964;
    close(g.random.hi - g.random.lo, 2 * tQuantile(0.975, 9) * (se / Math.sqrt(10)), 1e-9);
    assert.ok(g.predict && g.predict.lo < 0.2 && g.predict.hi > 0.2);
  });

  test("days that disagree: τ² > 0, a wider random-effects CI, and a prediction interval wider still", () => {
    const pts = [0.3, -0.1, 0.25, -0.05, 0.4, 0.0].map((v) => ({ value: v, lo: v - 0.08, hi: v + 0.08, n: 60 }));
    const g = pooledGap(pts)!;
    assert.ok(g.tau2 > 0);
    assert.ok(g.i2 > 0.5);
    assert.ok(g.random.hi - g.random.lo > g.fixed.hi - g.fixed.lo);
    assert.ok(g.predict!.hi - g.predict!.lo > g.random.hi - g.random.lo);
    close(g.fixed.mean, pts.reduce((a, x) => a + x.value, 0) / pts.length, 1e-12);
  });

  test("edge cases: fewer than two days, zero-width intervals, two days", () => {
    assert.equal(pooledGap([]), undefined);
    assert.equal(pooledGap([{ value: 0.1, lo: 0, hi: 0.2, n: 10 }]), undefined);
    // Both sides passed everything: zero-width CIs get the 1/(2n) floor, not infinite weight.
    const flat = pooledGap([{ value: 0, lo: 0, hi: 0, n: 20 }, { value: 0, lo: 0, hi: 0, n: 20 }])!;
    assert.ok(Number.isFinite(flat.random.lo) && flat.random.lo < 0 && flat.random.hi > 0);
    assert.equal(flat.predict, undefined, "two days give no prediction interval");
    // Three noisy days: no prediction interval yet, and the CI stays inside [−1, 1].
    const three = pooledGap([-0.35, -0.55, -0.4].map((v) => ({ value: v, lo: v - 0.25, hi: v + 0.25, n: 20 })))!;
    assert.equal(three.predict, undefined);
    assert.ok(three.random.lo >= -1 && three.random.hi <= 1);
  });

  test("history --vs and the report pool the last `window` runs; window isn't part of the protocol", () => {
    const p = project();
    const def = p.def("window = 2");
    assert.equal(def.window, 2);
    assert.equal(def.protocolHash, p.def().protocolHash);
    assert.equal(p.def().window, 28);
    assert.throws(() => p.def("window = 1"), /window/);
    p.def("window = 2");
    return (async () => {
      for (const d of ["2026-11-04", "2026-11-05", "2026-11-06"]) await runBench({ def, env: p.env, now: day(d) });
      const h = spawnSync(process.execPath, ["--no-warnings", MAIN, "bench", "history", "arith", "--vs", "good", "--json"], { cwd: p.root, env: { ...p.env, NO_COLOR: "1" }, encoding: "utf8" });
      assert.equal(h.status, 0, h.stderr);
      const j = JSON.parse(h.stdout);
      assert.equal(j.window, 2);
      assert.equal(j.pooled.bad.k, 2, "only the last two runs are pooled");
      assert.ok(j.pooled.bad.random.mean < 0, "bad trails good");
      const text = spawnSync(process.execPath, ["--no-warnings", MAIN, "bench", "history", "arith", "--vs", "good"], { cwd: p.root, env: { ...p.env, NO_COLOR: "1" }, encoding: "utf8" });
      assert.match(text.stdout, /bad vs good, last 2 runs pooled: -\d/);
      const rep = buildReport(await listRuns("arith", p.env), { reference: "good", window: 2 });
      assert.equal(rep.pooled.bad!.k, 2);
      assert.equal(rep.difficulty.fresh!.length, 3);
      const html = renderReportHtml(rep);
      assert.match(html, /Gap over the last 2 days/);
      assert.match(html, /<h3>Difficulty<\/h3>/);
      assert.match(html, /Add an \[anchor\] set to tell the two apart/);
    })();
  });
});
