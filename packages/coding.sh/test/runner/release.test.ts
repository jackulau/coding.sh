// AD-13: the agent release each run ran on, and the release confound between arms.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import type { HarnessBundle, RunResult, Session } from "../../src/core/types.ts";
import { loadConfig } from "../../src/core/config.ts";
import { openStores } from "../../src/store/factory.ts";
import { fixtureBundle, fixtureSession } from "../../src/store/conformance.ts";
import { compare, formatCompare, runExperiment } from "../../src/runner/experiment.ts";
import { harnessReport } from "../../src/runner/harness-report.ts";
import { agentVersions, releaseCache, releaseMix, runRelease } from "../../src/runner/release.ts";
import { tmpEnv } from "../adapters/_helpers.ts";
import { cleanupWorlds, fakeAdapter, MemBlobs, MemIndex, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

function run(taskId: string, bundleId: string, attempt: number, pass: boolean, extra: Partial<RunResult> = {}): RunResult {
  return {
    id: `${bundleId}-${taskId}-${attempt}`,
    taskId,
    bundleId,
    attempt,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "", usage: { costUsd: bundleId === "A" ? 0.1 : 0.06 } },
    startedAt: 0,
    endedAt: 2000,
    ...extra,
  };
}

/** 12 tasks per arm, same pass pattern, B cheaper: a Pareto cost-cut promotion on its own. */
function arms(va: (t: number) => string | undefined, vb: (t: number) => string | undefined, n = 12): RunResult[] {
  const rs: RunResult[] = [];
  for (let t = 0; t < n; t++) {
    const a = va(t);
    const b = vb(t);
    rs.push(run(`t${t}`, "A", 1, t < 8, a ? { agentVersion: a } : {}), run(`t${t}`, "B", 1, t < 8, b ? { agentVersion: b } : {}));
  }
  return rs;
}

const claude = { baseline: fixtureBundle({ id: "A", name: "base", files: {} }), candidate: fixtureBundle({ id: "B", name: "cand", files: {} }) };

describe("releaseCache", () => {
  it("asks detect() again only after the TTL, so an update mid-run shows", async () => {
    let t = 0;
    let version = "2.1.316";
    let calls = 0;
    const cache = releaseCache({ now: () => t });
    const detect = async () => {
      calls++;
      return { version };
    };
    assert.equal(await cache("claude-code", detect), "2.1.316");
    version = "2.1.319";
    t = 59_000;
    assert.equal(await cache("claude-code", detect), "2.1.316", "still inside the 60 s TTL");
    assert.equal(calls, 1);
    t = 61_000;
    assert.equal(await cache("claude-code", detect), "2.1.319");
    assert.equal(calls, 2);
    // Per agent.
    assert.equal(await cache("codex", async () => ({ version: "0.9.0" })), "0.9.0");
  });

  it("a detect() that throws or reports no version leaves the release unknown", async () => {
    const cache = releaseCache();
    assert.equal(await cache("a", async () => Promise.reject(new Error("no binary"))), undefined);
    assert.equal(
      await cache("b", () => {
        throw new Error("sync throw");
      }),
      undefined,
    );
    assert.equal(await cache("c", async () => ({})), undefined);
  });
});

describe("runExperiment records the release", () => {
  it("each run carries detect()'s version; a throwing detect() leaves it absent", async () => {
    const w = await toyWorld();
    const A = await w.mkBundle("lazy", "half effort");
    const B = await w.mkBundle("diligent", "always fix bugs");
    const versioned = { ...fakeAdapter(), detect: async () => ({ installed: true, hooked: false, version: "2.1.319" }) };
    const r = await runExperiment({ tasks: [w.task], bundles: [A, B], adapterFor: () => versioned, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map((x) => x.agentVersion), ["2.1.319", "2.1.319"]);
    assert.deepEqual((await w.index.listRuns({ experimentId: r.experimentId })).map((x) => x.agentVersion), ["2.1.319", "2.1.319"]);
    const broken = {
      ...fakeAdapter(),
      detect: async () => {
        throw new Error("no binary");
      },
    };
    const r2 = await runExperiment({ tasks: [w.task], bundles: [A, B], adapterFor: () => broken, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.ok(r2.results.every((x) => !("agentVersion" in x) && !x.error));
  });
});

describe("releaseMix", () => {
  it("counts valid runs per release per arm; a captured session's release wins", () => {
    const rs = arms((t) => (t < 6 ? "2.1.316" : undefined), () => "2.1.316", 8);
    const sessions = new Map<string, Session>([["B-t0-1", fixtureSession({ id: "s", agentVersion: "2.1.319" })]]);
    assert.equal(runRelease(rs.find((r) => r.id === "B-t0-1")!, sessions.get("B-t0-1")), "2.1.319");
    const m = releaseMix(rs.filter((r) => r.bundleId === "A"), rs.filter((r) => r.bundleId === "B"), sessions);
    assert.deepEqual(m, { baseline: { "2.1.316": 6 }, candidate: { "2.1.316": 7, "2.1.319": 1 }, unknown: { baseline: 2, candidate: 0 }, splitTasks: 1 });
  });

  it("orders releases numerically", () => {
    const m = releaseMix([run("t", "A", 1, true, { agentVersion: "2.1.10" }), run("u", "A", 1, true, { agentVersion: "2.1.9" })], []);
    assert.deepEqual(Object.keys(m.baseline), ["2.1.9", "2.1.10"]);
  });
});

describe("compare: release confound", () => {
  it("arms on different releases: note, agentVersions, agent row, gate note, and --promote refused", () => {
    const rs = arms(() => "2.1.316", () => "2.1.319");
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {}, gate: {} });
    // Every task ran on both releases (A on one, B on the other).
    assert.deepEqual(r.agentVersions, { baseline: { "2.1.316": 12 }, candidate: { "2.1.319": 12 }, unknown: { baseline: 0, candidate: 0 }, splitTasks: 12, agent: "claude-code", confound: "arms-differ" });
    assert.ok(
      r.notes.includes(
        "baseline ran on claude-code 2.1.316 (12 runs), candidate on claude-code 2.1.319 (12 runs); the agent release differs between arms, so the delta mixes your change with the release. Rerun both arms together on one release, with the agent's auto-update off",
      ),
      r.notes.join("\n"),
    );
    // Without the confound the same runs promote on cost.
    const clean = compare(arms(() => "2.1.316", () => "2.1.316"), { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {} });
    assert.equal(clean.pareto?.promote, true);
    assert.equal(r.pareto?.promote, false);
    assert.equal(r.pareto?.reason, "none");
    assert.equal(r.pareto?.refused, "release_confound");
    const text = formatCompare(r);
    assert.match(text, /^agent claude-code\s+2\.1\.316 ×12\s+2\.1\.319 ×12\s+release differs$/m, text);
    assert.match(text, /^ {6}the arms ran on different agent releases \(see the agent row\): this answer mixes the change with the release$/m, text);
    assert.match(text, /^pareto: support 1\.00 → hold \(release confound: the arms ran on different agent releases\) /m, text);
    assert.match(text, /^note: baseline ran on claude-code 2\.1\.316 \(12 runs\)/m);
  });

  it("the release changed mid-comparison in both arms: a softer note with the split tasks, no refusal", () => {
    const v = (t: number) => (t < 9 ? "2.1.316" : "2.1.319");
    const rs = arms(v, v);
    // One task straddles the update: A ran before it, B after.
    rs.find((r) => r.id === "B-t8-1")!.agentVersion = "2.1.319";
    rs.find((r) => r.id === "A-t9-1")!.agentVersion = "2.1.316";
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {} });
    assert.equal(r.agentVersions?.confound, "mixed");
    assert.equal(r.agentVersions?.splitTasks, 2);
    assert.ok(
      r.notes.includes(
        "both arms ran on claude-code 2.1.316 and 2.1.319: the release changed mid-comparison (2 tasks ran on more than one). Interleaved runs spread it across both arms, but each task's result can mix in the release",
      ),
      r.notes.join("\n"),
    );
    assert.equal(r.pareto?.refused, undefined);
    assert.match(formatCompare(r), /^agent claude-code\s+2\.1\.316 ×10, 2\.1\.319 ×2\s+2\.1\.316 ×8, 2\.1\.319 ×4\s+release changed mid-run$/m);
  });

  it("one release: agentVersions without a confound, no note and no agent row", () => {
    const r = compare(arms(() => "2.1.319", () => "2.1.319"), { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude });
    assert.deepEqual(r.agentVersions, { baseline: { "2.1.319": 12 }, candidate: { "2.1.319": 12 }, unknown: { baseline: 0, candidate: 0 }, splitTasks: 0, agent: "claude-code" });
    assert.ok(!r.notes.some((n) => /release/.test(n)));
    assert.doesNotMatch(formatCompare(r), /^agent claude-code|release differs|release changed/m);
  });

  it("no known release: no field, and output byte-identical to runs from before AD-13", () => {
    const rs = arms(() => undefined, () => undefined);
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {}, gate: {} });
    assert.equal("agentVersions" in r, false);
    // Old runs: the same objects never had the key.
    const old = rs.map(({ agentVersion: _v, ...x }) => x as RunResult);
    const o = compare(old, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {}, gate: {} });
    assert.equal(formatCompare(r), formatCompare(o));
    assert.equal(JSON.stringify(r), JSON.stringify(o));
  });

  it("under half of an arm's runs with a known release: no note", () => {
    const r = compare(arms(() => "2.1.316", (t) => (t < 5 ? "2.1.319" : undefined)), { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude, pareto: {} });
    assert.deepEqual(r.agentVersions?.unknown, { baseline: 0, candidate: 7 });
    assert.equal(r.agentVersions?.confound, undefined);
    assert.ok(!r.notes.some((n) => /release/.test(n)));
    assert.equal(r.pareto?.refused, undefined);
  });

  it("arms on different agents: the agent is the change, not a confound", () => {
    const codex = { ...claude, candidate: fixtureBundle({ id: "B", name: "cand", agent: "codex", files: {} }) };
    const r = compare(arms(() => "2.1.316", () => "0.9.0"), { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: codex });
    assert.equal(r.agentVersions?.confound, undefined);
    assert.equal(r.agentVersions?.agent, undefined);
    assert.ok(!r.notes.some((n) => /release/.test(n)));
  });

  it("cancelled and infra runs do not count", () => {
    const rs = arms(() => "2.1.316", () => "2.1.316");
    rs.push(run("t0", "B", 2, false, { agentVersion: "2.1.319", cancelled: true }), run("t1", "B", 2, false, { agentVersion: "2.1.319", infra: "rate-limit" }));
    assert.equal(compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: claude }).agentVersions?.confound, undefined);
  });
});

describe("item gate still reruns on two releases", () => {
  it("with the release from the runs when no session is captured", async () => {
    const blobs = new MemBlobs();
    const index = new MemIndex();
    const A: HarnessBundle = fixtureBundle({ id: "A", name: "base", files: { "CLAUDE.md": await blobs.put("be brief\n") } });
    const B: HarnessBundle = fixtureBundle({ id: "B", name: "cand", files: { ...A.files, ".claude/rules/clock.md": await blobs.put("use the clock\n") } });
    const rs: RunResult[] = [];
    for (let t = 0; t < 3; t++) for (let a = 1; a <= 3; a++) rs.push(run(`t${t}`, "A", a, false, { agentVersion: "2.1.316" }), run(`t${t}`, "B", a, true, { agentVersion: a === 3 ? "2.1.319" : "2.1.316" }));
    const r = await harnessReport({ index, blobs }, A, B, rs, { iters: 200, seed: 1, change: { mode: "add", path: ".claude/rules/clock.md" } });
    assert.equal(r.itemGate?.verdict, "RERUN");
    assert.ok(r.itemGate?.reasons.includes("2 agent versions across runs (2.1.316, 2.1.319)"), r.itemGate?.reasons.join("\n"));
  });
});

describe("CLI: compare --promote refuses across releases", () => {
  it("exits 1 with release_confound and carries agentVersions in --json", async () => {
    const env = tmpEnv();
    try {
      const stores = await openStores(loadConfig(process.env));
      await stores.index.putBundle(claude.baseline);
      await stores.index.putBundle(claude.candidate);
      for (const r of arms(() => "2.1.316", () => "2.1.319")) await stores.index.putRun({ ...r, experimentId: "exp_release" });
      await stores.index.close();
      const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
      const cli = (...extra: string[]) =>
        spawnSync(process.execPath, ["--no-warnings", CLI, "compare", "base", "cand", "--experiment", "exp_release", "--promote", ...extra], {
          env: { ...process.env, NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" },
          cwd: env.home,
          encoding: "utf8",
          timeout: 60_000,
        });
      const text = cli();
      assert.equal(text.status, 1, text.stdout + text.stderr);
      assert.match(text.stderr, /--promote refused \(release_confound\): baseline and candidate ran on different agent releases, so nothing is promoted/);
      assert.match(text.stdout, /^agent claude-code\s+2\.1\.316 ×12\s+2\.1\.319 ×12\s+release differs$/m);
      const res = cli("--json");
      assert.equal(res.status, 1, res.stdout + res.stderr);
      const out = JSON.parse(res.stdout);
      const report = (out.data ?? out).report;
      assert.equal(report.pareto.refused, "release_confound");
      assert.equal(report.agentVersions.confound, "arms-differ");
      assert.deepEqual(report.agentVersions.baseline, { "2.1.316": 12 });
    } finally {
      env.restore();
    }
  });
});
