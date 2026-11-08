// Tie-break sampling and the regression stop (TB-3) in exp run: the pure
// tracker, runExperiment with a function task, the render and the CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDataset } from "../../src/datasets/dataset.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { renderExperiment } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { allPassKeys, caseFails, CaseTracker, caseVerdicts } from "../../src/experiments/samples.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("samples: pure helpers", () => {
  it("a case fails at half or more failing trials, never on none", () => {
    assert.equal(caseFails([true, false]), true);
    assert.equal(caseFails([true, false, true]), false);
    assert.equal(caseFails([false, false, true]), true);
    assert.equal(caseFails([]), false);
  });

  it("all-pass keys skip ungraded outcomes and any failure", () => {
    const keys = allPassKeys([
      { key: "a", pass: true },
      { key: "a", pass: true },
      { key: "b", pass: true },
      { key: "b", pass: false },
      { key: "c", pass: undefined },
      { key: "d", pass: undefined },
      { key: "d", pass: true },
    ]);
    assert.deepEqual([...keys].sort(), ["a", "d"]);
  });

  it("verdicts count tie-breaks", () => {
    const v = caseVerdicts([
      { key: "a", pass: true },
      { key: "a", pass: true },
      { key: "b", pass: true },
      { key: "b", pass: false },
      { key: "b", pass: false },
    ]);
    assert.deepEqual(v, { passed: 1, failed: 1, tieBreaks: 1 });
  });

  it("the tracker flags a regression only once the case is finished", () => {
    const t = new CaseTracker("adaptive", 1, new Set(["a"]));
    assert.equal(t.add("a", true), false);
    assert.equal(t.add("a", false), false, "a disagreement waits for the tie-break");
    assert.equal(t.needsTieBreak("a"), true);
    assert.equal(t.add("a", false), true, "2 of 3 failing");
    const f = new CaseTracker("fixed", 2, new Set(["a"]));
    assert.equal(f.add("b", false), false);
    assert.equal(f.add("b", false), false, "not in the baseline");
    assert.equal(f.add("a", false), false);
    assert.equal(f.add("a", false), true);
  });
});

/** A task whose output per case follows a script, one entry per call (P passes, F fails). */
function scripted(plan: Record<string, string>) {
  const calls = new Map<string, number>();
  return (input: unknown) => {
    const id = (input as { id: string }).id;
    const n = calls.get(id) ?? 0;
    calls.set(id, n + 1);
    return plan[id]![n] === "P" ? id : "wrong";
  };
}

const ds = createDataset({ name: "ids", createdAt: 1, cases: ["a", "b", "c", "d"].map((id) => ({ id, input: { id }, expected: id })) });

describe("runExperiment: adaptive samples", () => {
  it("runs 2 trials per case and a 3rd only where they disagree", async () => {
    const r = await runExperiment({ name: "adaptive", dataset: ds, task: scripted({ a: "PP", b: "PFP", c: "FPF", d: "FF" }), graders: [exactGrader()], samples: "adaptive" });
    const count = (id: string) => r.runs.filter((x) => x.caseId === id).length;
    assert.deepEqual(["a", "b", "c", "d"].map(count), [2, 3, 3, 2]);
    assert.equal(r.samples, "adaptive");
    assert.equal(r.trials, 2);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.summary.caseVerdicts, { passed: 2, failed: 2, tieBreaks: 2 });
    const text = renderExperiment(r, { color: false });
    assert.match(text, /pass {4}50\.0%.*\(2\/4 cases; adaptive, no CI: 2 trials each, a 3rd on 2 disagreements; a case fails at half or more failing\)/);
    assert.doesNotMatch(text, /Wilson|cluster bootstrap/);
  });

  it("fixed trials keep no verdicts and no samples field", async () => {
    const r = await runExperiment({ name: "fixed", dataset: ds, task: scripted({ a: "PP", b: "PF", c: "FP", d: "FF" }), graders: [exactGrader()], trials: 2 });
    assert.equal(r.runs.length, 8);
    assert.equal(r.samples, undefined);
    assert.equal(r.summary.caseVerdicts, undefined);
  });
});

describe("runExperiment: stop on regression", () => {
  it("stops at the first case that passed every baseline trial and fails here", async () => {
    const baseline = await runExperiment({ name: "base", dataset: ds, task: scripted({ a: "P", b: "P", c: "P", d: "F" }), graders: [exactGrader()] });
    const r = await runExperiment({ name: "cand", dataset: ds, task: scripted({ a: "P", b: "F", c: "F", d: "F" }), graders: [exactGrader()], concurrency: 1, stopOnRegression: baseline });
    assert.deepEqual(r.regression, { caseId: "b", baseline: baseline.id });
    assert.equal(r.status, "cancelled");
    assert.deepEqual(
      r.runs.map((x) => x.caseId),
      ["a", "b"],
      "no case started after the regression",
    );
    assert.match(renderExperiment(r, { color: false }), /regression: case b passed every trial of .* and fails here; the run stopped \(--stop-on-regression\)/);
  });

  it("a case that already failed in the baseline is no regression", async () => {
    const baseline = await runExperiment({ name: "base", dataset: ds, task: scripted({ a: "P", b: "F", c: "P", d: "F" }), graders: [exactGrader()] });
    const r = await runExperiment({ name: "cand", dataset: ds, task: scripted({ a: "P", b: "F", c: "P", d: "F" }), graders: [exactGrader()], concurrency: 1, stopOnRegression: baseline });
    assert.equal(r.regression, undefined);
    assert.equal(r.status, "completed");
    assert.equal(r.runs.length, 4);
  });

  it("with adaptive samples, a disagreement is settled by the tie-break before it counts", async () => {
    const baseline = await runExperiment({ name: "base", dataset: ds, task: scripted({ a: "PP", b: "PP", c: "PP", d: "PP" }), graders: [exactGrader()], trials: 2 });
    const ok = await runExperiment({ name: "cand", dataset: ds, task: scripted({ a: "PFP", b: "PP", c: "PP", d: "PP" }), graders: [exactGrader()], samples: "adaptive", stopOnRegression: baseline });
    assert.equal(ok.regression, undefined, "a: 1 of 3 failing passes");
    const bad = await runExperiment({ name: "cand", dataset: ds, task: scripted({ a: "PFF", b: "PP", c: "PP", d: "PP" }), graders: [exactGrader()], samples: "adaptive", stopOnRegression: baseline });
    assert.deepEqual(bad.regression, { caseId: "a", baseline: baseline.id });
  });
});

describe("exp run --samples / --stop-on-regression from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  // Agent: echoes its input, or answers -1 (wrong) on every k-th case for FAIL_EVERY=k.
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } });
  const run = (every: number, ...extra: string[]) => cli(["exp", "run", "-d", "gt", "--task", task(every), "-g", '{"kind":"exact"}', "--concurrency", "1", ...extra]);

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-samples-cli-")));
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
    const cases: string[] = [];
    for (let i = 1; i <= 6; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: i, expected: i }));
    assert.equal(cli(["dataset", "add", "gt", ...cases]).status, 0);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&q%k===0?-1:q))});\n`,
    );
    assert.equal(run(0, "--name", "base").status, 0);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("exits 1 at the first regression and says which case", () => {
    const r = run(4, "--name", "cand", "--stop-on-regression", "--baseline", "base", "--json");
    assert.equal(r.status, 1, r.stderr);
    const doc = JSON.parse(r.stdout) as { outcome: string; regression: { caseId: string }; experiment: { runs: unknown[] } };
    assert.equal(doc.outcome, "regression");
    assert.equal(doc.regression.caseId, "c4");
    assert.equal(doc.experiment.runs.length, 4, "c5 and c6 never ran");
  });

  it("passes when nothing regressed", () => {
    const r = run(0, "--name", "same", "--stop-on-regression", "--baseline", "base");
    assert.equal(r.status, 0, r.stderr);
  });

  it("adaptive: 2 trials per case when they agree, no CI, and compare refuses it", () => {
    const r = run(3, "--name", "adapt", "--samples", "adaptive", "--json");
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { experiment: { id: string; samples: string; runs: unknown[]; summary: { caseVerdicts: unknown } } };
    assert.equal(doc.experiment.samples, "adaptive");
    assert.equal(doc.experiment.runs.length, 12);
    assert.deepEqual(doc.experiment.summary.caseVerdicts, { passed: 4, failed: 2, tieBreaks: 0 });
    const text = cli(["exp", "show", doc.experiment.id]);
    assert.match(text.stdout, /adaptive, no CI/);
    const cmp = cli(["exp", "compare", "base", doc.experiment.id]);
    assert.notEqual(cmp.status, 0);
    assert.match(cmp.stderr, /adaptive samples/);
  });

  it("rejects flag combinations that make no sense", () => {
    assert.match(run(0, "--stop-on-regression").stderr, /--stop-on-regression needs --baseline/);
    assert.match(run(0, "--baseline", "base").stderr, /--baseline needs --stop-on-regression/);
    assert.match(run(0, "--samples", "adaptive", "--trials", "3").stderr, /drop --trials/);
    assert.match(run(0, "--samples", "sometimes").stderr, /sometimes/);
    assert.match(run(0, "--stop-on-regression", "--baseline", "nope").stderr, /Can't find a completed experiment "nope"/);
  });
});
