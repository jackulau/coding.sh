import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { claudeRunArgs } from "../../src/adapters/claude-code.ts";
import { codexExecArgs } from "../../src/adapters/codex.ts";
import type { EvalTask, RunSpec } from "../../src/core/types.ts";
import { cellKey } from "../../src/runner/cells.ts";
import { compare, formatCompare, runExperiment } from "../../src/runner/experiment.ts";
import { failingTestNames, falseAlarmFires, repairMessage, repairOptsProblem } from "../../src/runner/repair.ts";
import { runTask } from "../../src/runner/run.ts";
import { BUGGY, FIXED, cleanupWorlds, fakeAdapter, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

const FIX: Record<string, string> = { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
const HALF: Record<string, string> = { "src/add.js": FIXED["src/add.js"] as string };

/** An agent that leaves the bug on its first try and fixes it once told the verifier failed. */
const learner = (o: { canResume?: boolean; seen?: { hidden: boolean; spec: RunSpec }[] } = {}) =>
  fakeAdapter({
    canResume: o.canResume ?? true,
    usage: { costUsd: 0.1 },
    act: (spec) => {
      o.seen?.push({ hidden: existsSync(join(spec.cwd, "test/add.test.js")), spec });
      return spec.instruction.includes("Verification failed.") ? FIX : HALF;
    },
  });

describe("repair rounds", () => {
  it("a failing first attempt is told 'Verification failed.' in its own session and fixes it in one round", async () => {
    const w = await toyWorld();
    const seen: { hidden: boolean; spec: RunSpec }[] = [];
    const adapter = learner({ seen });
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 3, signal: "bit" } });
    assert.equal(r.pass, false, "pass stays the first attempt's");
    assert.equal(r.error, undefined);
    assert.ok(r.repair);
    assert.equal(r.repair.pass, true);
    assert.equal(r.repair.mode, "resume");
    assert.equal(r.repair.limit, 3);
    assert.equal(r.repair.rounds.length, 1, "stops at the first pass");
    const [round] = r.repair.rounds;
    assert.equal(round?.n, 1);
    assert.equal(round?.pass, true);
    assert.equal(round?.verifierExit, 0);
    assert.deepEqual(round?.usage, { costUsd: 0.1 });
    assert.equal(round?.tamper, undefined);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.spec.instruction, "Verification failed.");
    assert.equal(seen[1]?.spec.resumeSessionId, r.sessionId, "the agent's own session is resumed");
    assert.equal(seen[0]?.spec.resumeSessionId, undefined);
    assert.deepEqual(
      seen.map((s) => s.hidden),
      [false, false],
      "hidden tests are out of the work tree in every agent round",
    );
    assert.match((await w.blobs.getText(round?.diffBlob ?? "")) ?? "", /src\/mul\.js/, "the round's diff is stored");
    assert.deepEqual(w.index.runs, [r]);
  });

  it("an adapter that can't resume gets a fresh session with the instruction first", async () => {
    const w = await toyWorld();
    const seen: { hidden: boolean; spec: RunSpec }[] = [];
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: learner({ canResume: false, seen }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 1, signal: "bit" } });
    assert.equal(r.repair?.mode, "fresh");
    assert.equal(r.repair?.pass, true);
    assert.equal(seen[1]?.spec.instruction, "fix add and mul\n\nVerification failed.");
    assert.equal(seen[1]?.spec.resumeSessionId, undefined);
  });

  it("rounds never exceed N; a passing run gets none unless the false alarm fires", async () => {
    const w = await toyWorld();
    const stuck = fakeAdapter({ canResume: true, act: () => HALF });
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: stuck, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 2, signal: "bit" } });
    assert.equal(r.repair?.rounds.length, 2);
    assert.equal(r.repair?.pass, false);
    assert.equal(stuck.specs.length, 3);

    const fixer = fakeAdapter({ canResume: true, act: () => FIX });
    const p = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: fixer, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 2, signal: "bit", falseAlarm: 0 } });
    assert.equal(p.pass, true);
    assert.deepEqual(p.repair?.rounds, []);
    assert.equal(p.repair?.falseAlarmFired, undefined);
    assert.equal(p.repair?.pass, true);
    assert.equal(fixer.specs.length, 1);

    // p = 1 always fires: one round, and an agent that then breaks its work fails at the end.
    let calls = 0;
    const breaker = fakeAdapter({ canResume: true, act: () => (calls++ === 0 ? FIX : { "src/add.js": BUGGY["src/add.js"] as string }) });
    const f = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: breaker, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 1, signal: "names", falseAlarm: 1, seed: 7 } });
    assert.equal(f.pass, true);
    assert.equal(f.repair?.falseAlarmFired, true);
    assert.equal(f.repair?.falseAlarm, 1);
    assert.equal(f.repair?.rounds.length, 1);
    assert.equal(f.repair?.pass, false, "the false alarm broke a passing run");
    assert.equal(breaker.specs[1]?.instruction, "Verification failed.", "a false alarm names no test");
    assert.equal(f.repair?.rounds[0]?.namesParsed, false);
  });

  it("the false-alarm draw is deterministic per seed and run id, and never fires at 0", () => {
    assert.equal(falseAlarmFires(0, 1, "run_a"), false);
    assert.equal(falseAlarmFires(undefined, 1, "run_a"), false);
    assert.equal(falseAlarmFires(1, 1, "run_a"), true);
    const ids = Array.from({ length: 400 }, (_, i) => `run_${i}`);
    const a = ids.map((id) => falseAlarmFires(0.3, 5, id));
    assert.deepEqual(a, ids.map((id) => falseAlarmFires(0.3, 5, id)));
    assert.notDeepEqual(a, ids.map((id) => falseAlarmFires(0.3, 6, id)), "another seed draws other runs");
    const rate = a.filter(Boolean).length / ids.length;
    assert.ok(rate > 0.2 && rate < 0.4, `about 30% fire (${rate})`);
  });

  it("names: the failing test names from node:test output, never the hidden test's text; unparsed output falls back to the bit", async () => {
    const w = await toyWorld();
    // TAP like node:test prints, with the hidden test's own text in a diagnostic line.
    const hidden = await w.blobs.put(
      [
        "// SECRET hidden test body",
        "const s = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'add' + '.js'), 'utf8');",
        "if (!s.includes('a + b')) {",
        "  console.log('TAP version 13');",
        "  console.log('not ok 1 - adds two numbers');",
        "  console.log('# SECRET-ASSERTION add(2,3)===5');",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
    );
    const task: EvalTask = { ...w.task, verifier: { command: "node test/hidden.cjs", hiddenFiles: { "test/hidden.cjs": hidden }, timeoutMs: 30_000 } };
    const adapter = fakeAdapter({ canResume: true, act: (spec) => (spec.instruction.startsWith("Verification failed.") ? FIX : { "src/mul.js": FIXED["src/mul.js"] as string }) });
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 1, signal: "names" } });
    assert.equal(adapter.specs[1]?.instruction, "Verification failed. Failing tests: adds two numbers");
    assert.doesNotMatch(adapter.specs[1]?.instruction ?? "", /SECRET/);
    assert.equal(r.repair?.rounds[0]?.namesParsed, true);
    assert.equal(r.repair?.pass, true);
    // The first attempt's verifier output is kept on the run; the passing round printed nothing.
    assert.match(r.verifierOutput?.stdout ?? "", /not ok 1 - adds two numbers/);
    assert.equal(r.repair?.rounds[0]?.verifierOutput, undefined);

    const plain = { ...task, verifier: { ...task.verifier, command: "exit 1" } };
    const b = fakeAdapter({ canResume: true });
    const u = await runTask({ task: plain, bundle: await w.mkBundle("x", "x"), adapter: b, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 1, signal: "names" } });
    assert.equal(b.specs[1]?.instruction, "Verification failed.");
    assert.equal(u.repair?.rounds[0]?.namesParsed, false);

    const loud = { ...task, verifier: { ...task.verifier, command: "echo still failing; exit 1" } };
    const l = await runTask({ task: loud, bundle: await w.mkBundle("x", "x"), adapter: fakeAdapter({ canResume: true }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 1, signal: "bit" } });
    assert.deepEqual(l.repair?.rounds[0]?.verifierOutput, { stdout: "still failing" }, "each round keeps its own verifier output");
  });

  it("a repair that passes by editing a test is not a repair", async () => {
    const w = await toyWorld();
    const VISIBLE = 'import { add } from "../src/add.js";\nif (add(2, 3) !== 5) process.exit(1);\n';
    w.git.add("vis", { ...BUGGY, "test/add.vis.test.js": VISIBLE });
    const task: EvalTask = { ...w.task, start: { ...w.task.start, snapshot: "vis" }, verifier: { command: "node test/add.vis.test.js", hiddenFiles: {}, timeoutMs: 30_000 } };
    const cheat = fakeAdapter({ canResume: true, act: (spec) => (spec.resumeSessionId ? { "test/add.vis.test.js": "process.exit(0);\n" } : undefined) });
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: cheat, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 3, signal: "bit" } });
    assert.equal(r.pass, false);
    assert.equal(r.repair?.rounds.length, 1, "a tampering round ends the loop");
    assert.equal(r.repair?.rounds[0]?.pass, true, "the verifier passed");
    assert.equal(r.repair?.rounds[0]?.tamper?.flagged, true);
    assert.equal(r.repair?.pass, false, "but the repair does not count");
  });

  it("cancel during a repair round: cancelled, not passing", async () => {
    const w = await toyWorld();
    const ac = new AbortController();
    const adapter = fakeAdapter({
      canResume: true,
      act: (spec) => {
        if (spec.resumeSessionId) {
          ac.abort();
          return FIX;
        }
        return HALF;
      },
    });
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, signal: ac.signal, repair: { rounds: 2, signal: "bit" } });
    assert.equal(r.cancelled, true);
    assert.equal(r.pass, false);
  });

  it("a first attempt that errored gets no rounds", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: fakeAdapter({ throws: true, canResume: true }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, repair: { rounds: 2, signal: "bit" } });
    assert.equal(r.repair?.skipped, "error");
    assert.deepEqual(r.repair?.rounds, []);
  });

  it("without repair the run carries no repair record", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: learner(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.repair, undefined);
    assert.equal("repair" in r, false);
  });
});

describe("failingTestNames", () => {
  it("reads pytest, node:test, jest, vitest, go and cargo failures", () => {
    const out = [
      "FAILED tests/test_math.py::test_add - AssertionError: assert 1 == 2",
      "not ok 2 - mul handles zero # TODO later",
      "  ✖ subtracts (1.25ms)",
      "    ✕ divides by two (5 ms)",
      " FAIL  src/math.test.ts > rounds",
      "--- FAIL: TestParse (0.00s)",
      "test parser::tests::empty ... FAILED",
      "ok 3 - passes",
      "test parser::tests::fine ... ok",
      "FAILED tests/test_math.py::test_add - again",
    ].join("\n");
    assert.deepEqual(failingTestNames(out), ["tests/test_math.py::test_add", "mul handles zero", "subtracts", "divides by two", "src/math.test.ts > rounds", "TestParse", "parser::tests::empty"]);
  });

  it("strips colors, keeps at most 20, clips long names, and finds nothing in plain output", () => {
    const many = Array.from({ length: 30 }, (_, i) => `\x1b[31mnot ok ${i + 1} - case ${i}\x1b[0m`).join("\n");
    const names = failingTestNames(many);
    assert.equal(names.length, 20);
    assert.equal(names[0], "case 0");
    assert.equal(failingTestNames(`--- FAIL: ${"T".repeat(500)}`)[0]?.length, 200);
    assert.deepEqual(failingTestNames("Error: expected 5, got -1\n    at add.test.js:3"), []);
    assert.equal(repairMessage([]), "Verification failed.");
    assert.equal(repairMessage(["a", "b"]), "Verification failed. Failing tests: a, b");
  });

  it("checks the options", () => {
    assert.equal(repairOptsProblem({ rounds: 2, signal: "names", falseAlarm: 0.5 }), undefined);
    assert.match(repairOptsProblem({ rounds: 0, signal: "bit" }) ?? "", /1-8 rounds/);
    assert.match(repairOptsProblem({ rounds: 9, signal: "bit" }) ?? "", /1-8 rounds/);
    assert.match(repairOptsProblem({ rounds: 1, signal: "loud" as "bit" }) ?? "", /bit or names/);
    assert.match(repairOptsProblem({ rounds: 1, signal: "bit", falseAlarm: 1.5 }) ?? "", /0 to 1/);
  });
});

describe("resume argv", () => {
  it("claude: --resume <id> in place of --session-id; bundle session flags win", () => {
    const fresh = claudeRunArgs({ flags: [] });
    assert.ok(fresh.args.includes("--session-id"));
    const resumed = claudeRunArgs({ flags: [], resumeSessionId: "abc" });
    assert.equal(resumed.sessionId, "abc");
    assert.deepEqual(resumed.args.slice(resumed.args.indexOf("--resume"), resumed.args.indexOf("--resume") + 2), ["--resume", "abc"]);
    assert.ok(!resumed.args.includes("--session-id"));
    assert.ok(!claudeRunArgs({ flags: ["--continue"], resumeSessionId: "abc" }).args.includes("--resume"));
  });

  it("codex: exec options, then resume <id>, instruction on stdin", () => {
    const args = codexExecArgs({ cwd: "/w", model: "gpt-5", flags: ["-c", "x=1"], resumeSessionId: "th_1" }, "");
    assert.deepEqual(args, ["exec", "--json", "-s", "workspace-write", "-m", "gpt-5", "-C", "/w", "--skip-git-repo-check", "-c", "x=1", "resume", "th_1", "-"]);
  });
});

describe("compare with repair", () => {
  it("cell keys: unchanged without repair, different with it", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("x", "x");
    const base = { task: w.task, bundle, adapter: "fake", agentVersion: "1", attempt: 1 };
    assert.equal(cellKey(base), cellKey({ ...base, repair: undefined }));
    const r1 = cellKey({ ...base, repair: { rounds: 1, signal: "bit" } });
    assert.notEqual(r1, cellKey(base));
    assert.notEqual(r1, cellKey({ ...base, repair: { rounds: 1, signal: "names" } }));
    assert.notEqual(r1, cellKey({ ...base, repair: { rounds: 2, signal: "bit" } }));
    assert.equal(r1, cellKey({ ...base, repair: { rounds: 1, signal: "bit", seed: 9 } }), "the seed matters only with a false alarm");
  });

  it("reports first pass, pass after repair and the repair rate per arm; --repair-verdict moves the verdict", async () => {
    const w = await toyWorld();
    const tasks = ["t1", "t2", "t3"].map((id) => ({ ...w.task, id, name: id }));
    // Arm A: never fixes. Arm B: fixes after one "failed".
    const A = await w.mkBundle("stuck", "stuck");
    const B = await w.mkBundle("learner", "learner");
    const adapters = { [A.id]: fakeAdapter({ canResume: true, usage: { costUsd: 0.1 }, act: () => HALF }), [B.id]: learner() };
    const res = await runExperiment({ tasks, bundles: [A, B], adapterFor: (b) => adapters[b.id]!, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, concurrency: 2, repair: { rounds: 2, signal: "bit" }, maxCostUsd: 100 });
    assert.equal(res.results.length, 6);
    // A: 3 runs × (1 + 2 rounds), B: 3 × (1 + 1); every call $0.10.
    assert.ok(Math.abs((res.budget?.spentUsd ?? 0) - 1.5) < 1e-9, `budget counts repair rounds (${res.budget?.spentUsd})`);
    const r = compare(res.results, { baseline: A.id, candidate: B.id, iters: 200, seed: 1 });
    assert.equal(r.baseline.passes, 0);
    assert.equal(r.candidate.passes, 0, "pass rates stay first-attempt");
    const rb = r.candidate.repair!;
    assert.equal(rb.firstFails, 3);
    assert.equal(rb.repaired, 3);
    assert.equal(rb.repairRate, 1);
    assert.equal(rb.passAfterRepair.p, 1);
    assert.equal(rb.meanRounds, 1);
    assert.equal(rb.rounds, 3);
    assert.ok(Math.abs(rb.extraCostUsd - 0.3) < 1e-9);
    assert.ok(Math.abs(r.spend.candidate.usd - 0.6) < 1e-9, "agent spend includes the rounds");
    assert.ok(Math.abs(r.spend.baseline.usd - 0.9) < 1e-9);
    const ra = r.baseline.repair!;
    assert.equal(ra.repaired, 0);
    assert.equal(ra.rounds, 6);
    assert.equal(ra.passAfterRepair.p, 0);
    assert.equal(r.verdict.kind, "no-difference");
    const text = formatCompare(r);
    assert.match(text, /with verifier feedback \(bit, up to 2 rounds, resume\)/);
    assert.match(text, /^seq@3 +0\.0% .* 100\.0% .* \+100\.0 pp$/m);
    assert.match(text, /^repaired +0\/3 \(0%\) +3\/3 \(100%\) · 1\.0 rd$/m);

    const v = compare(res.results, { baseline: A.id, candidate: B.id, iters: 200, seed: 1, repairVerdict: true });
    assert.equal(v.repairVerdict, true);
    assert.equal(v.candidate.passes, 3);
    assert.equal(v.candidate.repair?.firstPass.p, 0, "the repair block keeps the first attempt");
    assert.match(formatCompare(v), /^verdict \(after repair\): /m);
  });

  it("runs without repair report exactly as before", async () => {
    const w = await toyWorld();
    const A = await w.mkBundle("a", "half");
    const B = await w.mkBundle("b", "fix");
    const res = await runExperiment({ tasks: [w.task], bundles: [A, B], adapterFor: () => learner(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    const r = compare(res.results, { baseline: A.id, candidate: B.id, iters: 200, seed: 1 });
    assert.equal(r.baseline.repair, undefined);
    assert.equal("repairVerdict" in r, false);
    assert.doesNotMatch(formatCompare(r), /verifier feedback|after repair/);
    const v = compare(res.results, { baseline: A.id, candidate: B.id, iters: 200, seed: 1, repairVerdict: true });
    assert.ok(v.notes.some((n) => n.startsWith("no repair rounds in these runs")));
  });
});
