// exp sweep (EM-17): sequential halving on the selection split, the held-out
// re-score, the optimism gap, a fixed-seed simulation of the winner's curse,
// and the CLI end to end. Function tasks in process; the CLI test uses a temp
// HOME / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../src/core/ids.ts";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { Grader, Split } from "../../src/datasets/types.ts";
import { renderSweep } from "../../src/experiments/render.ts";
import { defaultBudget, halvingSchedule, runSweep, type SweepConfig } from "../../src/experiments/sweep.ts";

/** Passes when the task output is true. */
const truthy: Grader = { id: "ok", version: "1", kind: "custom", grade: async (ctx) => ({ score: ctx.output === true ? 1 : 0, pass: ctx.output === true }) };
const u01 = (s: string) => parseInt(sha256Hex(s).slice(0, 8), 16) / 2 ** 32;
/** A config whose pass on each case is a fixed coin with bias p (salted, so seeds can redraw them). */
const coin = (name: string, p: number, salt = "", calls?: Map<string, number>): SweepConfig => ({
  name,
  task: {
    kind: "function",
    name,
    fn: (input) => {
      calls?.set(name, (calls.get(name) ?? 0) + 1);
      return u01(`${salt}:${name}:${String(input)}`) < p;
    },
  },
});
const dataset = (train: number, test: number, name = "sw") =>
  createDataset({
    name,
    createdAt: 1,
    cases: [
      ...Array.from({ length: train }, (_, i) => ({ id: `tr${i}`, input: `tr${i}`, split: "train" as Split })),
      ...Array.from({ length: test }, (_, i) => ({ id: `te${i}`, input: `te${i}`, split: "test" as Split })),
    ],
  });

describe("sequential halving schedule", () => {
  it("halves (rounding up) down to one survivor in ⌈log2 N⌉ rounds", () => {
    assert.deepEqual(halvingSchedule(2), [2]);
    assert.deepEqual(halvingSchedule(5), [5, 3, 2]);
    assert.deepEqual(halvingSchedule(8), [8, 4, 2]);
    assert.deepEqual(halvingSchedule(9), [9, 5, 3, 2]);
  });

  it("the default budget uses each selection case at most once", () => {
    for (const [n, cases] of [[2, 10], [5, 70], [8, 300], [9, 41]] as const) {
      const b = defaultBudget(n, cases);
      const sched = halvingSchedule(n);
      const used = sched.reduce((s, x) => s + Math.floor(b / (x * sched.length)), 0);
      assert.ok(used <= cases, `n=${n}: ${used} > ${cases}`);
      assert.ok(used >= cases - sched.length * 2, `n=${n}: only ${used} of ${cases} used`);
    }
  });
});

describe("runSweep", () => {
  it("drops weak configs on train, re-scores start and winner on test", async () => {
    const calls = new Map<string, number>();
    const configs = [coin("base", 0.4, "", calls), coin("bad", 0.1, "", calls), coin("good", 0.9, "", calls), coin("meh", 0.3, "", calls), coin("ok", 0.5, "", calls)];
    const r = await runSweep({ name: "s", dataset: dataset(70, 30), configs, graders: [truthy], seed: 7, concurrency: 8 });
    assert.equal(r.method, "sequential-halving");
    assert.equal(r.status, "completed");
    assert.deepEqual(r.splits, { select: "train", heldOut: "test", source: "dataset", selectCases: 70, heldOutCases: 30 });
    assert.deepEqual(r.rounds.map((x) => x.configs.length), [5, 3, 2]);
    assert.deepEqual(r.rounds.map((x) => x.configs.filter((c) => c.kept).length), [3, 2, 1]);
    assert.ok(r.used <= r.budget);
    assert.equal(r.used, r.rounds.reduce((s, x) => s + x.cases * x.configs.length, 0));
    // Survivors of a round have run the same cases.
    for (const rd of r.rounds) for (const c of rd.configs) assert.equal(c.n, rd.totalCases);
    // A dropped config stops running: its train calls are the cases it saw when dropped.
    for (const c of r.configs) {
      const trainCalls = c.train.n;
      const heldOut = c.name === "base" || c.name === r.winner?.name ? 30 : 0;
      assert.equal(calls.get(c.name), trainCalls + heldOut, c.name);
      if (c.droppedIn) assert.equal(trainCalls, r.rounds[c.droppedIn - 1]!.totalCases);
    }
    assert.equal(r.winner?.name, "good");
    assert.equal(r.configs.find((c) => c.name === "good")?.droppedIn, undefined);
    assert.equal(r.configs.find((c) => c.name === "bad")?.droppedIn, 1);
    const dropped = r.rounds[0]!.configs.find((c) => c.config === "bad")!;
    assert.ok(dropped.vsLeader!.hi < 0, "bad is clearly behind the leader");
    // Held-out: the winner and the start config, interleaved and compared.
    assert.equal(r.winner!.heldOut.n, 30);
    assert.equal(r.start!.name, "base");
    assert.ok(Math.abs(r.winner!.optimismGap - (r.winner!.train.passRate - r.winner!.heldOut.p)) < 1e-12);
    assert.equal(r.comparison?.paired, 30);
    assert.equal(r.comparison?.timing.interleaved, true);
    assert.equal(r.comparison?.verdict, "better");
    const text = renderSweep(r, { color: false });
    assert.match(text, /^winner {2}good {2}train \d+\.\d% \(\d+ cases\) {2}held-out \d+\.\d% \[\d+\.\d%, \d+\.\d%\] \(30 cases\)$/m);
    assert.match(text, /^gap {5}[+-]?\d+\.\dpp optimism \(train − held-out\)/m);
    assert.match(text, /dropped, -\d+\.\dpp \[-\d+\.\dpp, -\d+\.\dpp\] vs leader/);
    // EM-7: the plausibly-best set on the round-1 cases every config ran.
    assert.equal(r.bestSet?.n, r.rounds[0]!.cases);
    assert.equal(r.bestSet?.best[0], "good");
    assert.ok(!r.bestSet?.best.includes("bad"));
    assert.match(text, /^(best: good \(clearly ahead|plausibly best \(95%, \d+ shared cases\): good)/m);
    // Same seed, same race.
    const again = await runSweep({ name: "s", dataset: dataset(70, 30), configs, graders: [truthy], seed: 7, concurrency: 3 });
    assert.deepEqual(again.rounds, r.rounds);
  });

  it("holds out a seeded 30% when the dataset has no splits, and validates its inputs", async () => {
    const ds = createDataset({ name: "nosplit", createdAt: 1, cases: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, input: i })) });
    const r = await runSweep({ name: "n", dataset: ds, configs: [coin("a", 0.5), coin("b", 0.5)], graders: [truthy], seed: 1 });
    assert.equal(r.splits.source, "random");
    assert.equal(r.splits.heldOutCases, 6);
    assert.equal(r.splits.selectCases, 14);
    assert.equal(r.winner!.heldOut.n, 6);
    assert.match(r.notes.join("\n"), /only 6 held-out case/);
    const base = { name: "x", graders: [truthy] };
    await assert.rejects(runSweep({ ...base, dataset: ds, configs: [coin("a", 0.5)] }), /at least 2 configs/);
    await assert.rejects(runSweep({ ...base, dataset: ds, configs: [coin("a", 0.5), coin("a", 0.5)] }), /share the name/);
    await assert.rejects(runSweep({ ...base, dataset: dataset(10, 5), configs: [coin("a", 0.5), coin("b", 0.5)], heldOut: "train" }), /both "train"/);
    await assert.rejects(runSweep({ ...base, dataset: dataset(10, 0), configs: [coin("a", 0.5), coin("b", 0.5)] }), /no cases in the "test" split/);
    await assert.rejects(runSweep({ ...base, dataset: dataset(10, 5), configs: [coin("a", 0.5), coin("b", 0.5), coin("c", 0.5)], budget: 3 }), /too small/);
  });

  it("adopt or keep: the gate on the held-out comparison of winner vs start", async () => {
    const fixed = (name: string, pass: (id: string) => boolean): SweepConfig => ({ name, task: { kind: "function", name, fn: (input) => pass(String(input)) } });
    const num = (id: string) => Number(id.slice(2));
    // good passes everything, base nothing: 30 held-out wins, no losses.
    const adopt = await runSweep({ name: "a", dataset: dataset(20, 30), configs: [fixed("base", () => false), fixed("good", () => true)], graders: [truthy], seed: 1 });
    assert.equal(adopt.winner?.name, "good");
    assert.deepEqual([adopt.adopt?.decision, adopt.adopt?.wins, adopt.adopt?.losses], ["accept", 30, 0]);
    assert.match(renderSweep(adopt, { color: false }), /^adopt {3}good: wins 30 cases, loses 0 on held-out$/m);

    // flashy wins the race (every train case) but breaks the 10 test cases base solves and fixes only 2.
    const configs = [fixed("base", (id) => id.startsWith("te") && num(id) < 10), fixed("flashy", (id) => id.startsWith("tr") || num(id) >= 28)];
    const keep = await runSweep({ name: "k", dataset: dataset(20, 30), configs, graders: [truthy], seed: 1 });
    assert.equal(keep.winner?.name, "flashy");
    assert.equal(keep.adopt?.verdict, "dont-ship");
    assert.deepEqual([keep.adopt?.wins, keep.adopt?.losses, keep.adopt?.solved], [2, 10, 10]);
    const text = renderSweep(keep, { color: false });
    assert.match(text, /^keep {4}base: flashy breaks 10 cases base solved$/m);
    assert.match(text, /^ {8}lost: te0, te1, te2, te3, te4 \(\+5 more\)$/m);

    // The start config won: nothing to adopt.
    const same = await runSweep({ name: "s", dataset: dataset(20, 30), configs: [fixed("base", () => true), fixed("worse", () => false)], graders: [truthy], seed: 1 });
    assert.equal(same.winner?.name, "base");
    assert.equal(same.adopt, undefined);
    assert.doesNotMatch(renderSweep(same, { color: false }), /^(adopt|keep) /m);
  });

  it("notes when the budget asks for more cases than the split has", async () => {
    const r = await runSweep({ name: "o", dataset: dataset(12, 5), configs: [coin("a", 0.5), coin("b", 0.6), coin("c", 0.4)], graders: [truthy], seed: 2, budget: 200 });
    assert.match(r.notes.join("\n"), /selection split ran out in round \d/);
    assert.ok(r.rounds.at(-1)!.totalCases <= 12);
    assert.ok(r.winner);
  });
});

describe("sweep simulation (fixed seeds)", () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 100 + i);
  const ds = dataset(300, 200, "sim");

  it("winner's curse: with 8 equal configs the winner's train score overstates its held-out score", async () => {
    let gap = 0;
    let held = 0;
    for (const seed of SEEDS) {
      const configs = Array.from({ length: 8 }, (_, i) => coin(`eq${i}`, 0.5, String(seed)));
      const r = await runSweep({ name: "curse", dataset: ds, configs, graders: [truthy], seed, concurrency: 16, bootstrapIters: 200 });
      gap += r.winner!.optimismGap / SEEDS.length;
      held += r.winner!.heldOut.p / SEEDS.length;
    }
    assert.ok(gap > 0.015, `mean optimism gap ${gap.toFixed(3)}`);
    assert.ok(Math.abs(held - 0.5) < 0.03, `mean held-out ${held.toFixed(3)}`);
  });

  it("finds the best of 8 configs most of the time", async () => {
    const ps = [0.4, 0.45, 0.5, 0.55, 0.6, 0.62, 0.65, 0.75];
    let best = 0;
    for (const seed of SEEDS) {
      const configs = ps.map((p, i) => coin(`p${i}`, p, String(seed)));
      const r = await runSweep({ name: "best", dataset: ds, configs, graders: [truthy], seed, concurrency: 16, bootstrapIters: 200 });
      if (r.winner!.name === "p7") best++;
    }
    assert.ok(best >= 16, `best config won ${best} of ${SEEDS.length}`);
  });
});

describe("exp sweep from the CLI", () => {
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  // Agent: echoes its input, and fails (wrong answer) on every k-th case for FAIL_EVERY=k.
  const cfg = (name: string, every: number) => {
    const file = join(home, `${name}.json`);
    writeFileSync(file, JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } }));
    return file;
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-sweep-cli-")));
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
    for (let i = 1; i <= 40; i++) cases.push("--case", JSON.stringify({ input: i, expected: i, split: i <= 28 ? "train" : "test" }));
    const add = cli(["dataset", "add", "sw", ...cases]);
    assert.equal(add.status, 0, add.stderr);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&q%k===0?-1:q))});\n`,
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("races the configs and reports the winner, held-out score and optimism gap", () => {
    const args = ["exp", "sweep", `base=${cfg("base", 2)}`, cfg("better", 5), cfg("best", 0), "-d", "sw", "-g", '{"kind":"exact"}', "--seed", "3", "--name", "sw1"];
    const r = cli([...args, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout).sweep;
    assert.equal(s.winner.name, "best");
    assert.equal(s.winner.train.passRate, 1);
    assert.equal(s.winner.heldOut.p, 1);
    assert.equal(s.winner.optimismGap, 0);
    assert.equal(s.start.name, "base");
    assert.equal(s.start.heldOut.n, 12);
    assert.equal(s.splits.selectCases, 28);
    assert.equal(s.rounds.length, 2);
    assert.deepEqual(s.configs.map((c: { name: string }) => c.name), ["base", "better", "best"]);
    assert.equal(s.comparison.verdict, "better");
    // The race's runs are stored experiments.
    const show = cli(["exp", "show", s.configs[0].experiment]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /sw1-base/);
    // Text output.
    const t = cli(args);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^winner {2}best /m);
    assert.match(t.stdout, /^gap {5}0\.0pp optimism/m);
    // best fixes base's 6 held-out failures and breaks none: too few to adopt at the default λ=2.
    assert.deepEqual([s.adopt.decision, s.adopt.wins, s.adopt.losses], ["abstain", 6, 0]);
    assert.match(t.stdout, /^keep {4}base: not enough evidence that best is better \(wins 6, loses 0; needs 8\+ wins with no losses\)$/m);
    // Usage errors.
    const one = cli(["exp", "sweep", cfg("solo", 0), "-d", "sw", "-g", '{"kind":"exact"}']);
    assert.equal(one.status, 2);
    assert.match(one.stderr, /at least two configs/);
    const same = cli(["exp", "sweep", cfg("a", 0), cfg("b", 0), "-d", "sw", "-g", '{"kind":"exact"}', "--split", "test"]);
    assert.equal(same.status, 2);
    assert.match(same.stderr, /both test/);
  });
});
