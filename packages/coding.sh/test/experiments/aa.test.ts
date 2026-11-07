// A/A runs and the stored noise floor (EM-10), plus the compare flags end to
// end through the CLI: --cluster, the posterior, attrition and the noise note
// in --json. Temp HOME / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { aaNoise, taskKey } from "../../src/experiments/aa.ts";
import { renderAa } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";

const ids = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
const ds = createDataset({ name: "aa", createdAt: 1, cases: ids.map((id) => ({ id, input: id })) });
const passing = (pass: Set<string>): Grader => ({
  id: "ok",
  version: "1",
  kind: "custom",
  grade: async (ctx) => ({ score: pass.has(String(ctx.output)) ? 1 : 0, pass: pass.has(String(ctx.output)) }),
});
const run = (name: string, pass: Set<string>) => runExperiment({ name, dataset: ds, task: function echo(i) { return i; }, graders: [passing(pass)] });

describe("aaNoise", () => {
  it("flips, flip rate, SD and the cases needed at that noise", async () => {
    // Same config, two runs: c01..c10 pass in both; c11, c12 only in the first, c13 only in the second.
    const first = await run("aa1", new Set([...ids.slice(0, 12)]));
    const second = await run("aa2", new Set([...ids.slice(0, 10), "c13"]));
    const r = aaNoise(first, second, { now: 5 });
    assert.equal(r.noise.paired, 20);
    assert.equal(r.noise.flips, 3);
    assert.equal(r.noise.flipRate, 0.15);
    // Δ: 2 × −1, 1 × +1, 17 × 0 → mean −0.05, sd² = (3 − 20 · 0.0025) / 19.
    assert.ok(Math.abs(r.noise.sd - Math.sqrt(2.95 / 19)) < 1e-12);
    assert.ok(Math.abs(r.noise.delta.mean - -0.05) < 1e-12);
    assert.equal(r.noise.taskKey, taskKey(first.task));
    assert.deepEqual(r.noise.experiments, [first.id, second.id]);
    assert.equal(r.noise.ts, 5);
    const z = 1.959963984540054 + 0.8416212335729143;
    assert.equal(r.plan.for10, Math.ceil(((z * r.noise.sd) / 0.1) ** 2));
    // Two runs made one after the other: flagged, since drift between them counts as noise.
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /not interleaved/);
    const text = renderAa(r, { color: false });
    assert.match(text, /^flips {3}3 of 20 cases \(15\.0%\): 2 passed only in the first run, 1 only in the second {2}mcnemar p=1\.000$/m);
    assert.match(text, /^plan {4}paired cases to detect 5pp: \d+, 10pp: \d+ /m);
  });

  it("warns when the two runs are not the same config", async () => {
    const first = await run("aa1", new Set(ids));
    const other = await runExperiment({ name: "x", dataset: ds, task: function other(i) { return i; }, graders: [passing(new Set(ids.slice(0, 2)))] });
    const r = aaNoise(first, other);
    assert.match(r.warnings.join("\n"), /different tasks/);
    assert.match(r.warnings.join("\n"), /A\/A difference is significant/);
  });

  it("stores one floor per dataset and task", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-aa-"));
    try {
      const store = new FileEvalStore({ root });
      const r = aaNoise(await run("aa1", new Set(ids.slice(0, 5))), await run("aa2", new Set(ids.slice(0, 6))));
      await store.putNoise(r.noise);
      assert.deepEqual(await store.getNoise(ds.id, r.noise.taskKey), r.noise);
      assert.equal(await store.getNoise(ds.id, "000000000000"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("exp aa and exp compare from the CLI", () => {
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 60_000 });
  const json = (args: string[]) => {
    const r = cli([...args, "--json"]);
    assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed:\n${r.stderr}`);
    return JSON.parse(r.stdout) as Record<string, any>;
  };
  // Agent: answers its input; fails (exit 3) for inputs listed in FAIL, and "flaky" inputs every other run (FLIP=1).
  const task = (failing: string[]) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL: failing.join(",") } });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-aa-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 12; i++) cases.push("--case", JSON.stringify({ input: `q${i}`, expected: `q${i}`, metadata: { repo: `r${(i % 3) + 1}` } }));
    const add = cli(["dataset", "add", "ds", ...cases]);
    assert.equal(add.status, 0, add.stderr);
    const big: string[] = [];
    for (let i = 1; i <= 60; i++) big.push("--case", JSON.stringify({ input: `q${i}`, expected: `q${i}` }));
    const addBig = cli(["dataset", "add", "big", ...big]);
    assert.equal(addBig.status, 0, addBig.stderr);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);if((process.env.FAIL||"").split(",").includes(q)){process.stderr.write("boom");process.exit(3)}process.stdout.write(JSON.stringify(q))});\n`,
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("exp aa runs the config twice, stores the floor, and compare reads it", () => {
    const aa = json(["exp", "aa", "-d", "ds", "--task", task(["q1"]), "-g", '{"kind":"exact"}', "--name", "base"]);
    assert.equal(aa.noise.paired, 12);
    assert.equal(aa.noise.flips, 0);
    assert.equal(aa.noise.flipRate, 0);
    assert.deepEqual(aa.warnings, []);
    assert.equal(aa.comparison.a.name, "base-aa1");
    assert.equal(aa.comparison.b.name, "base-aa2");
    // The stored-runs form recomputes the same floor.
    const again = json(["exp", "aa", "base-aa1", "base-aa2"]);
    assert.equal(again.noise.taskKey, aa.noise.taskKey);
    assert.deepEqual(again.noise.experiments, aa.noise.experiments);
    // A run against itself is refused: it would store a noise floor of zero.
    const self = cli(["exp", "aa", "base-aa1", aa.noise.experiments[0]]);
    assert.equal(self.status, 2, self.stderr);
    assert.match(self.stderr, /two different runs/);

    // B: same task (same key), so compare picks the floor up. Fails q1..q4.
    const b = json(["exp", "run", "-d", "ds", "--task", task(["q1", "q2", "q3", "q4"]), "-g", '{"kind":"exact"}', "--name", "cand"]);
    assert.equal(b.experiment.summary.errors, 4);
    const cmp = json(["exp", "compare", "base-aa1", "cand", "--cluster", "repo"]).comparison;
    assert.deepEqual(cmp.power.noise, { sd: 0, flipRate: 0, paired: 12, used: false });
    assert.equal(cmp.cluster.key, "repo");
    assert.equal(cmp.cluster.clusters, 3);
    assert.match(cmp.cluster.warning, /only 3 repo cluster/);
    assert.ok(cmp.posterior.pBetter < 0.2, `P(B>A) ${cmp.posterior.pBetter}`);
    assert.equal(cmp.attrition.a.lost, 1);
    assert.equal(cmp.attrition.b.lost, 4);
    assert.equal(cmp.attrition.b.agent, 4);
    assert.ok(cmp.attrition.p > 0.01);
    const text = cli(["exp", "compare", "base-aa1", "cand", "--cluster", "repo"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\(12 paired cases in 3 repo clusters, 95% cluster bootstrap\)/);
    assert.match(text.stdout, /^noise {3}A\/A flip rate on this dataset 0\.0%/m);
    assert.match(text.stdout, /^bayes {3}P\(B>A\)=/m);
    assert.match(text.stdout, /^lost {4}A 1\/12 \(1 agent error\) {2}B 4\/12 \(4 agent errors\)/m);
    // The A/A arms were interleaved; a candidate run later was not.
    assert.equal(aa.comparison.timing.interleaved, true);
    assert.equal(cmp.timing.interleaved, false);
    assert.match(text.stdout, /^! A and B ran one after the other, not interleaved/m);
  });

  it("exp run --arm interleaves two tasks and --stop-early stops at a look", () => {
    // Base fails all but one case (an arm where every run errors exits 1, like exp run).
    const failing = Array.from({ length: 59 }, (_, i) => `q${i + 1}`);
    const r = json(["exp", "run", "-d", "big", "-g", '{"kind":"exact"}', "--name", "ab", "--arm", `base=${task(failing)}`, "--arm", `cand=${task([])}`, "--stop-early", "--seed", "7", "-c", "4"]);
    assert.equal(r.outcome, "completed");
    assert.equal(r.pair.seed, 7);
    assert.deepEqual(r.experiments.map((e: any) => e.name), ["ab-base", "ab-cand"]);
    assert.deepEqual(r.sequential.plan.looks, [30, 45, 60]);
    assert.equal(r.sequential.reason, "crossed");
    assert.equal(r.sequential.early, true);
    assert.equal(r.sequential.stoppedAt, 30);
    for (const e of r.experiments) {
      assert.equal(e.summary.cases, 30);
      assert.equal(e.pair.id, r.pair.id);
    }
    assert.equal(r.comparison.verdict, "better");
    assert.equal(r.comparison.timing.interleaved, true);
    assert.match(r.comparison.sequentialWarning, /stopped early/);
    // Stored: compare finds the pair again by name.
    const cmp = json(["exp", "compare", "ab-base", "ab-cand"]).comparison;
    assert.equal(cmp.sequential.stoppedAt, 30);
  });

  it("exp run rejects the A/B flags without two arms", () => {
    const bad = cli(["exp", "run", "-d", "big", "-g", '{"kind":"exact"}', "--task", task([]), "--stop-early"]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /--stop-early needs two --arm options/);
    const one = cli(["exp", "run", "-d", "big", "-g", '{"kind":"exact"}', "--arm", `a=${task([])}`]);
    assert.equal(one.status, 2, one.stderr);
    assert.match(one.stderr, /--arm takes exactly two arms/);
  });
});
