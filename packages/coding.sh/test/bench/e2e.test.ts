// The whole CLI loop in a temp CODING_SH_HOME: `bench new` with a command
// source and two command contenders (one worse), runs on three simulated
// days, then history, report, regrade, MCP reads and schedule (with a fake
// crontab on PATH; the real one is never touched).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTools, type ToolCtx } from "../../src/mcp/tools.ts";
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
    mkdirSync(bin, { recursive: true });
    const tab = join(root, "crontab.txt");
    writeFileSync(tab, "0 1 * * * echo keep-me\n");
    writeFileSync(join(bin, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${tab}"; else cat > "${tab}"; fi\n`);
    chmodSync(join(bin, "crontab"), 0o755);
    const fake = { PATH: `${bin}:${env.PATH}` };

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
