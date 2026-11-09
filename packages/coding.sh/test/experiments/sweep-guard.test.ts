// AB-1: exp sweep --guard re-runs the start and winner configs on earlier suites
// and blocks adoption when the winner forgets one. Function tasks in process;
// the CLI test uses a temp HOME / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader, Split } from "../../src/datasets/types.ts";
import { appendAdoption, listAdoptions, priorDatasets } from "../../src/experiments/adoptions.ts";
import { renderSweep } from "../../src/experiments/render.ts";
import { runSweep, type SweepConfig } from "../../src/experiments/sweep.ts";
import { pathOf } from "../_bin.ts";

const truthy: Grader = { id: "ok", version: "1", kind: "custom", grade: async (ctx) => ({ score: ctx.output === true ? 1 : 0, pass: ctx.output === true }) };
/** pass(input) decides each case; inputs are "<suite>:<i>". */
const config = (name: string, pass: (suite: string, i: number) => boolean, calls?: string[]): SweepConfig => ({
  name,
  task: {
    kind: "function",
    name,
    fn: (input) => {
      const [suite, i] = String(input).split(":");
      calls?.push(`${name}:${input}`);
      return pass(suite!, Number(i));
    },
  },
});
const target = createDataset({
  name: "target",
  createdAt: 1,
  cases: [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `tr${i}`, input: `t:${i}`, split: "train" as Split })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `te${i}`, input: `t:${100 + i}`, split: "test" as Split })),
  ],
});
const guardDs = (name: string) => createDataset({ name, createdAt: 1, cases: Array.from({ length: 30 }, (_, i) => ({ id: `${name}${i}`, input: `${name}:${i}` })) });

// On the target the candidate solves everything and the start a third: the target gate ships.
const start = config("start", (s, i) => (s === "t" ? i % 3 === 0 : true));
const forgets = config("cand", (s) => s === "t");
const keeps = config("cand", () => true);

describe("runSweep guards", () => {
  it("no guards: the result has no guard fields (byte-identical to before)", async () => {
    const r = await runSweep({ name: "s", dataset: target, configs: [start, keeps], graders: [truthy], seed: 3 });
    assert.equal("guards" in r, false);
    assert.equal("blockedBy" in r, false);
    assert.equal(r.adopt?.verdict, "ship");
    assert.doesNotMatch(renderSweep(r, { color: false }), /guard/);
  });

  it("a winner that breaks the start's solved guard cases: dont-ship, blockedBy, even though the target ships", async () => {
    const r = await runSweep({ name: "s", dataset: target, configs: [start, forgets], graders: [truthy], seed: 3, guards: [{ dataset: guardDs("old") }] });
    assert.equal(r.comparison?.gate?.verdict, "ship", "the target gate alone ships");
    assert.equal(r.adopt?.verdict, "dont-ship");
    assert.deepEqual(r.blockedBy, ["old"]);
    const g = r.guards![0]!;
    assert.equal(g.blocks, true);
    assert.equal(g.start.p, 1);
    assert.equal(g.winner.p, 0);
    assert.equal(g.deltaForget, 1);
    assert.equal(g.rhoForget, 1);
    assert.ok(r.notes.some((n) => n === "winner forgets old: 100% -> 0% (rho 100%)"));
    const text = renderSweep(r, { color: false });
    assert.match(text, /^keep {4}start: cand forgets old \(guard\)$/m);
    assert.match(text, /BLOCKS: Don't ship: B breaks 30 cases A solved/);
  });

  it("a guard the winner ties: no discordant cases, no block, still ships", async () => {
    const r = await runSweep({ name: "s", dataset: target, configs: [start, keeps], graders: [truthy], seed: 3, guards: [{ dataset: guardDs("old") }] });
    assert.equal(r.adopt?.verdict, "ship");
    assert.equal(r.blockedBy, undefined);
    assert.equal(r.guards?.length, 1);
    assert.equal(r.guards![0]!.blocks, false);
    assert.equal(r.guards![0]!.gate.wins + r.guards![0]!.gate.losses, 0);
    assert.equal(r.guards![0]!.deltaForget, 0);
  });

  it("Δ and ρ follow eqs. 4-5, and a hold never blocks", async () => {
    // Start passes 0.9 of the guard, winner 0.3 → Δ 0.6, ρ 0.667.
    const s = config("start", (su, i) => (su === "t" ? i % 3 === 0 : i % 10 !== 0));
    const w = config("cand", (su, i) => (su === "t" ? true : i % 10 < 3 && i % 10 !== 0) || (su !== "t" && i % 10 === 9));
    const r = await runSweep({ name: "s", dataset: target, configs: [s, w], graders: [truthy], seed: 3, guards: [{ dataset: guardDs("old") }] });
    const g = r.guards![0]!;
    assert.ok(Math.abs(g.start.p - 0.9) < 1e-9 && Math.abs(g.winner.p - 0.3) < 1e-9, `${g.start.p} ${g.winner.p}`);
    assert.ok(Math.abs(g.deltaForget - 0.6) < 1e-9);
    assert.ok(Math.abs(g.rhoForget - 0.6 / 0.9) < 1e-9);
  });

  it("the start wins: guards is [] and no guard experiment is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csh-guard-"));
    try {
      const store = new FileEvalStore({ env: { CODING_SH_HOME: dir } });
      const weak = config("cand", () => false);
      const r = await runSweep({ name: "s", dataset: target, configs: [start, weak], graders: [truthy], seed: 3, store, guards: [{ dataset: guardDs("old") }] });
      assert.equal(r.winner?.name, "start");
      assert.deepEqual(r.guards, []);
      assert.equal((await store.listExperiments()).filter((e) => e.name.includes("-guard-")).length, 0);
      assert.match(renderSweep(r, { color: false }), /guards {2}not run: the start config won/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("adoptions", () => {
  it("round trip; prior datasets are distinct, in order, without the target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csh-adopt-"));
    try {
      assert.deepEqual(await listAdoptions(dir), []);
      for (const d of ["a", "b", "a", "t"]) await appendAdoption(dir, { dataset: d, name: d, version: "v", config: "c", taskKey: "k", sweep: "s", at: 1 });
      const all = await listAdoptions(dir);
      assert.equal(all.length, 4);
      assert.deepEqual(priorDatasets(all, "t"), ["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exp sweep --guard from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  // MODE=forget: right on the target, wrong elsewhere; MODE=keep: always right; MODE=start: right on a third of the target.
  const task = (mode: string) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { MODE: mode } });
  const stored = () => JSON.parse(cli(["exp", "list", "--json", "--limit", "500"]).stdout).experiments.length as number;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-guard-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const add = (name: string, cases: { id: string; input: unknown; expected: unknown; split?: string }[]) =>
      assert.equal(cli(["dataset", "add", name, ...cases.flatMap((c) => ["--case", JSON.stringify(c)])]).status, 0);
    add("tgt", [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `tr${i}`, input: { s: "t", i }, expected: true, split: "train" })),
      ...Array.from({ length: 24 }, (_, i) => ({ id: `te${i}`, input: { s: "t", i: 100 + i }, expected: true, split: "test" })),
    ]);
    add("old", Array.from({ length: 36 }, (_, i) => ({ id: `o${i}`, input: { s: "o", i }, expected: true, split: i < 12 ? "train" : "test" })));
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const m=process.env.MODE;` +
        `const ok=m==="keep"?true:m==="forget"?q.s==="t":q.s==="t"?q.i%3===0:true;process.stdout.write(JSON.stringify(ok))});\n`,
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("flag validation fails before any run", () => {
    const base = ["exp", "sweep", `start=${task("start")}`, `cand=${task("forget")}`, "-d", "tgt", "-g", '{"kind":"exact"}', "--seed", "1"];
    for (const bad of [["--guard", "tgt"], ["--guard", "missing"], ["--guard-tau", "0.2"], ["--guard", "old", "--guard-tau", "2"]]) {
      const r = cli([...base, ...bad]);
      assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
    }
    assert.equal(stored(), 0);
  });

  it("a forgetting winner blocks (exit 1, guards[0].blocks); a keeping one ships and is remembered for --guard prior", () => {
    const base = (cand: string) => ["exp", "sweep", `start=${task("start")}`, `cand=${task(cand)}`, "-d", "tgt", "-g", '{"kind":"exact"}', "--seed", "1"];
    const blocked = cli([...base("forget"), "--guard", "old", "--json"]);
    assert.equal(blocked.status, 1, blocked.stderr);
    const sw = JSON.parse(blocked.stdout).sweep;
    assert.equal(sw.guards[0].blocks, true);
    assert.deepEqual(sw.blockedBy, ["old"]);
    assert.equal(sw.adopt.verdict, "dont-ship");
    const text = cli([...base("forget"), "--guard", "old"]);
    assert.match(text.stdout, /forgets old \(guard\)/);

    // Nothing adopted yet: --guard prior guards nothing.
    const none = cli([...base("keep"), "--guard", "prior"]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stderr, /no earlier dataset has an adopted config yet/);
    // A ship on "old" (where "forget" is always wrong) is remembered; a sweep on tgt then guards old.
    const onOld = cli(["exp", "sweep", `start=${task("forget")}`, `cand=${task("keep")}`, "-d", "old", "-g", '{"kind":"exact"}', "--seed", "1"]);
    assert.equal(onOld.status, 0, onOld.stderr);
    const adoptions = readFileSync(join(home, ".coding.sh", "adoptions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(adoptions.some((a) => a.name === "old"));
    const prior = cli([...base("forget"), "--guard", "prior", "--json"]);
    assert.equal(prior.status, 1, prior.stderr);
    assert.deepEqual(JSON.parse(prior.stdout).sweep.blockedBy, ["old"]);
  });
});
