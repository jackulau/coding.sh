import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EvalTask, HarnessBundle } from "../../src/core/types.ts";
import { cellKey, evalTaskFingerprint, newestByCell } from "../../src/runner/cells.ts";
import { compare, formatCompare, planCells, runExperiment } from "../../src/runner/experiment.ts";
import { cleanupWorlds, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

describe("cellKey", () => {
  it("changes with what a run measures, not with where the repo lives", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("a", "fix");
    const other = await w.mkBundle("a", "fix it");
    const base = { task: w.task, bundle, adapter: "fake", agentVersion: "1.0.0", attempt: 1 };
    const k = cellKey(base);
    assert.equal(cellKey({ ...base, task: { ...w.task, start: { ...w.task.start, repoRoot: "/elsewhere" } } }), k, "a path is not content");
    assert.equal(cellKey({ ...base, task: { ...w.task, name: "renamed", tags: ["x"] } }), k, "the task's name and tags don't change what it measures");
    const changed: [string, Parameters<typeof cellKey>[0]][] = [
      ["task id (same content, another case)", { ...base, task: { ...w.task, id: "t2" } }],
      ["instruction", { ...base, task: { ...w.task, instruction: "fix add only" } }],
      ["verifier command", { ...base, task: { ...w.task, verifier: { ...w.task.verifier, command: "node test/other.js" } } }],
      ["hidden file content", { ...base, task: { ...w.task, verifier: { ...w.task.verifier, hiddenFiles: { "test/add.test.js": await w.blobs.put("changed") } } } }],
      ["setup", { ...base, task: { ...w.task, setup: [] } }],
      ["start snapshot", { ...base, task: { ...w.task, start: { ...w.task.start, snapshot: "other" } } }],
      ["bundle", { ...base, bundle: other }],
      ["agent version", { ...base, agentVersion: "1.0.1" }],
      ["unknown agent version", { ...base, agentVersion: undefined }],
      ["attempt", { ...base, attempt: 2 }],
      ["timeout", { ...base, timeoutMs: 60_000 }],
      ["env", { ...base, env: { X: "1" } }],
      ["route", { ...base, route: () => ({ env: {}, flags: [], model: "m" }) }],
    ];
    for (const [what, parts] of changed) assert.notEqual(cellKey(parts), k, what);
    assert.equal(evalTaskFingerprint(w.task), evalTaskFingerprint({ ...w.task }));
  });

  it("newestByCell keeps the newest original with a known outcome inside the age limit", () => {
    const r = (id: string, endedAt: number, extra: object = {}) =>
      ({ id, taskId: "t", bundleId: "b", attempt: 1, pass: true, verifierExit: 0, agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, startedAt: 0, endedAt, cellKey: "k", ...extra }) as never;
    const pick = (runs: never[], notBefore = 0) => newestByCell(runs, notBefore).get("k")?.id;
    assert.equal(pick([r("old", 1), r("new", 2)]), "new");
    assert.equal(pick([r("ok", 1), r("err", 2, { error: "boom" })]), "ok", "a run with an error is never reused");
    for (const bad of [{ cancelled: true }, { superseded: true }, { infra: "rate-limit" }, { reusedFrom: "x" }, { cellKey: undefined }]) assert.equal(pick([r("bad", 2, bad)]), undefined, JSON.stringify(bad));
    assert.equal(pick([r("stale", 5)], 6), undefined, "older than the limit");
  });
});

describe("runExperiment reuse", () => {
  async function setup() {
    const w = await toyWorld();
    const A = await w.mkBundle("lazy", "half effort");
    const B = await w.mkBundle("diligent", "always fix bugs");
    const tasks: EvalTask[] = [w.task, { ...w.task, id: "t2" }];
    const agent = obedientAgent();
    let now = Date.now() + 60_000;
    let version: string | undefined = "1.0.0";
    const opts = (bundles: HarnessBundle[], extra: object = {}) => ({
      tasks,
      bundles,
      adapterFor: () => agent,
      agentVersion: async () => version,
      blobs: w.blobs,
      index: w.index,
      git: w.git,
      runsDir: w.runsDir,
      k: 2,
      concurrency: 2,
      ...extra,
    });
    return {
      w,
      A,
      B,
      tasks,
      agent,
      opts,
      clock: () => now,
      tick: (ms: number) => (now += ms),
      setVersion: (v: string | undefined) => (version = v),
    };
  }

  it("--reuse baseline: the second comparison runs only the candidate, and the report says the arms were not interleaved", async () => {
    const s = await setup();
    const first = await runExperiment(s.opts([s.A, s.B]));
    assert.equal(s.agent.specs.length, 8);
    assert.ok(first.results.every((r) => typeof r.cellKey === "string" && !r.reusedFrom), "every run is stamped with its cell key");
    assert.equal(first.reuse, undefined, "no reuse asked, none reported");

    const B2 = await s.w.mkBundle("diligent2", "always fix bugs, carefully");
    const plan = await planCells(s.opts([s.A, B2], { reuse: { bundleIds: [s.A.id], now: s.clock } }));
    assert.equal(plan.cached.size, 4);
    assert.deepEqual(plan.missing.map((i) => plan.jobs[i]!.bundle.name), ["diligent2", "diligent2", "diligent2", "diligent2"]);
    const second = await runExperiment(s.opts([s.A, B2], { reuse: { bundleIds: [s.A.id], now: s.clock } }));
    assert.equal(s.agent.specs.length, 12, "only the candidate's 4 runs called the agent");
    assert.deepEqual(second.reuse, { reused: 4, unknownVersion: [] });
    const copies = second.results.filter((r) => r.reusedFrom);
    assert.equal(copies.length, 4);
    assert.ok(copies.every((r) => r.bundleId === s.A.id && r.experimentId === second.experimentId && r.id !== r.reusedFrom));
    assert.deepEqual(copies.map((r) => r.reusedFrom).sort(), first.results.filter((r) => r.bundleId === s.A.id).map((r) => r.id).sort());
    assert.equal((await s.w.index.listRuns({ experimentId: second.experimentId })).length, 8, "compare --experiment sees both arms");
    const report = compare(second.results, { baseline: s.A.id, candidate: B2.id });
    assert.deepEqual(report.reused, { baseline: 4, candidate: 0 });
    assert.equal(report.pairedTasks, 2);
    assert.match(formatCompare(report), /reused runs from earlier comparisons \(baseline 4\/4\).*did not run interleaved/);
    assert.equal(compare(first.results, { baseline: s.A.id, candidate: s.B.id }).reused, undefined);
  });

  it("misses on a changed instruction, a changed agent version, a stored error and an age past the limit; none reuses nothing", async () => {
    const s = await setup();
    const first = await runExperiment(s.opts([s.A, s.B]));
    const reuseA = { reuse: { bundleIds: [s.A.id], now: s.clock } };
    const cachedOf = async (extra: object) => (await planCells({ ...s.opts([s.A, s.B]), ...extra })).cached.size;
    assert.equal(await cachedOf(reuseA), 4);
    assert.equal(await cachedOf({ ...reuseA, reuse: { ...reuseA.reuse, bundleIds: [s.A.id, s.B.id] } }), 8, "--reuse both");
    assert.equal(await cachedOf({}), 0, "--reuse none");
    assert.equal(await cachedOf({ ...reuseA, tasks: [{ ...s.tasks[0]!, instruction: "fix mul only" }, s.tasks[1]!] }), 2, "t1's instruction changed: only t2 is reused");
    assert.equal(await cachedOf({ ...reuseA, tasks: [{ ...s.tasks[0]!, verifier: { ...s.tasks[0]!.verifier, hiddenFiles: { "test/add.test.js": await s.w.blobs.put("// new test") } } }, s.tasks[1]!] }), 2, "a changed hidden file");
    s.setVersion("1.0.1");
    assert.equal(await cachedOf(reuseA), 0, "the agent was upgraded");
    s.setVersion("1.0.0");
    const one = first.results.find((r) => r.bundleId === s.A.id && r.taskId === "t2" && r.attempt === 1)!;
    // The test index appends on putRun; a real store upserts by id.
    s.w.index.runs = s.w.index.runs.map((r) => (r.id === one.id ? { ...r, error: "verifier timed out" } : r));
    assert.equal(await cachedOf(reuseA), 3, "a stored run with an error is run again");
    s.tick(8 * 86_400_000);
    assert.equal(await cachedOf(reuseA), 0, "older than 7 days");
    assert.equal(await cachedOf({ reuse: { ...reuseA.reuse, maxAgeMs: 30 * 86_400_000 } }), 3, "a longer --reuse-max-age");
    const plain = await runExperiment(s.opts([s.A, s.B]));
    assert.equal(s.agent.specs.length, 16, "no reuse: every run calls the agent, as before");
    assert.ok(plain.results.every((r) => !r.reusedFrom));
  });

  it("an unknown agent version still reuses, and says so; reused runs cost nothing against --max-cost", async () => {
    const s = await setup();
    s.setVersion(undefined);
    await runExperiment(s.opts([s.A, s.B]));
    const B2 = await s.w.mkBundle("diligent2", "always fix bugs, carefully");
    const r = await runExperiment(s.opts([s.A, B2], { reuse: { bundleIds: [s.A.id], now: s.clock }, maxCostUsd: 100, concurrency: 1 }));
    assert.deepEqual(r.reuse, { reused: 4, unknownVersion: ["fake"] });
    assert.equal(r.budget?.spentUsd, 2, "4 new runs at $0.50; the 4 reused are not charged again");
    // The agent spend row counts what this comparison paid; the reused runs' original cost shows on its own row.
    const report = compare(r.results, { baseline: s.A.id, candidate: B2.id });
    assert.deepEqual(report.spend.baseline, { usd: 0, priced: 0, runs: 0, reused: { runs: 4, usd: 2, priced: 4 }, graderUsd: 0, graderCalls: 0, graderUnpriced: 0 });
    assert.deepEqual(report.spend.candidate, { usd: 2, priced: 4, runs: 4, graderUsd: 0, graderCalls: 0, graderUnpriced: 0 });
    const text = formatCompare(report);
    assert.match(text, /^agent spend\s+\$0\.00\s+\$2\.00\s+\$2\.00 total$/m);
    assert.match(text, /^reused\s+\$2\.00\s+\$2\.00 not spent: 4 runs paid for by earlier comparisons$/m);
  });

  it("resume keeps a reused copy instead of copying it again", async () => {
    const s = await setup();
    await runExperiment(s.opts([s.A, s.B]));
    const B2 = await s.w.mkBundle("diligent2", "always fix bugs, carefully");
    const recorded = new Map<string, { data?: unknown }>();
    const state = new Map<string, unknown>();
    const scope = {
      prefix: "",
      job: { setTotal: async () => {}, addRefs: async () => {} },
      done: (key: string) => recorded.get(key),
      record: async (key: string, line: { data?: unknown }) => void recorded.set(key, line),
      state: (n: string) => state.get(n),
      setState: async (n: string, v: unknown) => void state.set(n, v),
    } as never;
    const o = s.opts([s.A, B2], { reuse: { bundleIds: [s.A.id], now: s.clock }, job: scope });
    const r1 = await runExperiment(o);
    const r2 = await runExperiment(o);
    assert.equal(r2.experimentId, r1.experimentId);
    assert.equal((await s.w.index.listRuns({ experimentId: r1.experimentId })).length, 8, "no duplicate copies");
    assert.deepEqual(r2.reuse, { reused: 4, unknownVersion: [] });
  });
});
