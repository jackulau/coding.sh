// The whole CLI loop in a temp CODING_SH_HOME: `bench new` with a command
// source and two command contenders (one worse), runs on three simulated
// days, then history, report, regrade, MCP reads and schedule (with a fake
// crontab on PATH; the real one is never touched).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTools, type ToolCtx } from "../../src/mcp/tools.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { cleanup, project } from "./helpers.ts";

after(cleanup);

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

function cli(cwd: string, env: NodeJS.ProcessEnv, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd, env: { ...env, ...extra, NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, any> };
}

describe("bench e2e", () => {
  const p = project();
  const { root, env } = p;
  const run = (args: string[], extra?: NodeJS.ProcessEnv) => cli(root, env, args, extra);

  test("new writes a definition and prints what the sample size can detect", () => {
    const r = run(["bench", "new", "daily", "--command", "node gen.mjs", "-c", "good=node good.cjs", "-c", "bad=node bad.cjs", "-g", '{"kind":"exact"}', "-n", "15"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /smallest pass-rate gap/);
    assert.ok(existsSync(join(root, "bench", "daily.toml")));
  });

  test("dry run samples without running anything", () => {
    const r = run(["bench", "run", "daily", "--dry-run", "--json"], { CODING_SH_BENCH_NOW: "2026-11-04T06:15:00Z" });
    assert.equal(r.status, 0, r.stderr);
    const d = r.json();
    assert.equal(d.cases.length, 15);
    assert.equal(d.mode, "scheduled");
    assert.ok(d.plan.mde > 0);
    assert.ok(!existsSync(join(env.CODING_SH_HOME!, "benchmarks", "daily", "runs")));
  });

  test("three daily runs, then history shows one counted run per day", () => {
    const days = ["2026-11-04", "2026-11-05", "2026-11-06"];
    const ids: string[] = [];
    for (const d of days) {
      const r = run(["bench", "run", "daily", "--json"], { CODING_SH_BENCH_NOW: `${d}T06:15:00Z` });
      assert.equal(r.status, 0, r.stderr);
      const out = r.json();
      assert.equal(out.run.date, d);
      assert.equal(out.run.mode, "scheduled");
      ids.push(out.run.id);
    }
    // A same-day rerun is adhoc.
    const again = run(["bench", "run", "daily", "--json"], { CODING_SH_BENCH_NOW: "2026-11-06T09:00:00Z" });
    assert.equal(again.json().run.mode, "adhoc");
    const h = run(["bench", "history", "daily", "--json"]).json();
    assert.deepEqual(h.runs.map((r: { id: string }) => r.id), ids);
    assert.equal(h.notCounted, 1);
    assert.ok(h.series.good.every((pt: { value: number }) => pt.value === 1), "good passes everything");
    assert.ok(h.series.bad.some((pt: { value: number }) => pt.value < 1), "bad fails some");
    const seen = new Set<string>();
    for (const id of ids) {
      const s = run(["bench", "show", "daily", "--run", id, "--json"]).json();
      assert.equal(s.run.contenders.length, 2);
      assert.equal(s.run.cells, 30);
      assert.equal(s.run.dataset.sha256.length, 64);
    }
    const shown = run(["bench", "show", "daily", "--cases", "--json"]).json();
    for (const c of shown.run.cases) seen.add(c.key);
    assert.equal(seen.size, 15);
    const vs = run(["bench", "history", "daily", "--vs", "good", "--json"]).json();
    assert.equal(vs.metric, "gap");
    assert.ok(vs.series.bad.every((pt: { value: number }) => pt.value <= 0));
  });

  test("report writes self-contained HTML with the trend and where each contender fails", () => {
    const outDir = join(root, "public");
    const r = run(["bench", "report", "daily", "--out", outDir, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const json = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(json.runs.length, 3);
    assert.equal(json.otherRuns.length, 1);
    assert.match(html, /<section id="trend"/);
    // The pass-rate chart comes in a desktop and a phone size; CSS shows one.
    assert.equal((html.match(/<svg class="trend lg" data-metric="pass"/g) ?? []).length, 1);
    assert.equal((html.match(/<svg class="trend sm" data-metric="pass" viewBox="0 0 400 /g) ?? []).length, 1);
    assert.match(html, /@media\(max-width:640px\)\{\.trend\.lg\{display:none\}/);
    assert.match(html, /<g data-contender="bad">/);
    assert.match(html, /<section id="failures"/);
    assert.match(html, /Where each contender fails/);
    assert.match(html, /<span class="tag">(crash|wrong)<\/span>/);
    assert.doesNotMatch(html, /<script|<link /, "no scripts, no external assets");
    assert.ok(!html.includes(root), "no local paths");
  });

  test("regrade re-scores without calling contenders", () => {
    const r = run(["bench", "regrade", "daily", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().runs.length, 1);
  });

  test("MCP tools list benchmarks and read results and history", async () => {
    const tools = new Map(buildTools().map((t) => [t.name, t]));
    const ctx = { env, cwd: root, now: () => Date.now(), store: async () => { throw new Error("unused"); } } as unknown as ToolCtx;
    const list = (await tools.get("benchmarks")!.run({}, ctx)) as { benchmarks: { name: string; runs: number }[] };
    assert.ok(list.benchmarks.some((b) => b.name === "daily" && b.runs >= 4));
    const res = (await tools.get("benchmarks")!.run({ name: "daily" }, ctx)) as { leaderboard: { contender: string; place: number }[]; mode: string };
    assert.equal(res.leaderboard[0]!.contender, "good");
    assert.equal(res.mode, "scheduled");
    const hist = (await tools.get("benchmarks")!.run({ name: "daily", metric: "pass" }, ctx)) as { runs: unknown[] };
    assert.equal(hist.runs.length, 3);
  });

  test("schedule prints by default, refuses to install without a budget, and edits only its own crontab line", () => {
    const printed = run(["bench", "schedule", "daily", "--json"]);
    assert.equal(printed.status, 0, printed.stderr);
    const s = printed.json();
    assert.equal(s.installed, false);
    assert.match(s.cron, /bench run daily/);
    assert.match(s.workflow, /npm install -g coding\.sh@\d+\.\d+\.\d+/);
    assert.match(s.workflow, /bench-daily-runs/);
    assert.doesNotMatch(s.workflow, /actions\/cache/);

    const bin = join(root, "fakebin");
    const tab = join(root, "crontab.txt");
    writeFileSync(tab, "0 1 * * * echo keep-me\n");
    const fs = `require("node:fs")`;
    nodeBin(bin, "crontab", `const tab = ${JSON.stringify(tab)};\nif (process.argv[2] === "-l") process.stdout.write(${fs}.readFileSync(tab));\nelse ${fs}.writeFileSync(tab, ${fs}.readFileSync(0));\n`);
    const fake = { PATH: pathOf(bin, env.PATH) };

    const refused = run(["bench", "schedule", "daily", "--install-cron", "--yes"], fake);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /budget_usd/);
    assert.equal(readFileSync(tab, "utf8"), "0 1 * * * echo keep-me\n");

    const def = join(root, "bench", "daily.toml");
    writeFileSync(def, readFileSync(def, "utf8").replace("cases = 15", "cases = 15\nbudget_usd = 1"));
    for (let i = 0; i < 2; i++) {
      const ok = run(["bench", "schedule", "daily", "--install-cron", "--yes", "--at", "07:30"], fake);
      assert.equal(ok.status, 0, ok.stderr);
    }
    const lines = readFileSync(tab, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "installed once, replaced on the second call");
    assert.equal(lines[0], "0 1 * * * echo keep-me");
    assert.match(lines[1]!, /^30 7 \* \* \* cd .* bench run daily .*# coding\.sh bench daily$/);
  });

  test("help lists every action", () => {
    const r = run(["bench", "--help"]);
    for (const a of ["new", "run", "regrade", "list", "show", "history", "report", "schedule"]) assert.match(r.stdout, new RegExp(`\\b${a}\\b`));
  });
});

describe("bench e2e: model × harness grid and routing headroom", () => {
  // Four command contenders labelled with axes: m1 is right under h1, m2 under h2, and each is right on even a elsewhere.
  const GRID = `const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const [model, harness] = process.argv.slice(2);
const right = (model === "m1") === (harness === "h1") || Math.abs(input.a) % 2 === 0;
process.stdout.write(String(input.a + input.b + (right ? 0 : 1)));
`;
  const contender = (m: string, h: string) => `[[contenders]]\nname = "${m}-${h}"\ncommand = "node grid.cjs ${m} ${h}"\naxes = { model = "${m}", harness = "${h}" }\n`;
  const p = project(`name = "grid"\ncases = 40\nconcurrency = 4\n[source]\nkind = "command"\ncommand = "node gen.mjs"\n${contender("m1", "h1")}${contender("m1", "h2")}${contender("m2", "h1")}${contender("m2", "h2")}[[graders]]\nkind = "exact"\n`);
  p.write("grid.cjs", GRID);
  writeFileSync(join(p.root, "bench", "grid.toml"), readFileSync(p.file, "utf8"));
  const run = (args: string[], extra?: NodeJS.ProcessEnv) => cli(p.root, p.env, args, extra);

  test("bench show prints the grid table, the reversal and the routing headroom; --json carries both", () => {
    const r = run(["bench", "run", "grid", "--json"], { CODING_SH_BENCH_NOW: "2026-11-04T06:15:00Z" });
    assert.equal(r.status, 0, r.stderr);
    const shown = run(["bench", "show", "grid"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Model × harness grid: 40 cases; .*\(\* = this cell's 95% CI excludes 0, not adjusted for the number of cells\)/);
    assert.match(shown.stdout, /MODEL\s+H1\s+H2/);
    assert.match(shown.stdout, /m1\s+100\.0% \+\d+\.\d\*/);
    assert.match(shown.stdout, /Rank reversal: m1 leads m2 under h1, m2 leads under h2\./);
    assert.match(shown.stdout, /Cross-model fit: /);
    assert.match(shown.stdout, /Leave-one-model-out regret: .*; mean \d+\.\d \(95% CI \d+\.\d to \d+\.\d\)\./);
    assert.match(shown.stdout, /Routing headroom: any contender \d+\.\d% vs best single \(\S+\) \d+\.\d%/);
    const j = run(["bench", "show", "grid", "--json"]).json();
    assert.deepEqual(j.run.grid.models, ["m1", "m2"]);
    assert.ok(j.run.grid.meanRegretCi.lo <= j.run.grid.meanRegret && j.run.grid.meanRegret <= j.run.grid.meanRegretCi.hi, JSON.stringify(j.run.grid.meanRegretCi));
    assert.ok(j.run.grid.lomo.every((x: { regretCi?: { lo: number; hi: number } }) => x.regretCi && x.regretCi.lo <= x.regretCi.hi));
    assert.deepEqual(j.run.contenders[0].axes, { model: "m1", harness: "h1" });
    assert.equal(j.run.specialization.cases, 40);
  });
});
