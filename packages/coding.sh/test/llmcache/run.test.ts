// X-11 through the experiment runner: function and command tasks, CaseRun.llm,
// metadata.llm, the render line, a missing source, the control noise floor and
// the compare note.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Dataset } from "../../src/datasets/types.ts";
import { runAb } from "../../src/experiments/ab.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import type { TaskContext } from "../../src/experiments/task.ts";
import { controlNoise, llmReplayNote } from "../../src/llmcache/report.ts";
import { gcLlmCache } from "../../src/llmcache/store.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { API_KEY, recordingTexts, startStub, threeCalls, tmp, type Stub } from "./_stub.ts";

let stub: Stub;
let dir: string;
before(async () => {
  stub = await startStub();
  dir = tmp();
});
after(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

const dataset: Dataset = {
  id: "ds",
  name: "ds",
  version: "v1",
  createdAt: 0,
  cases: [
    { id: "c1", input: "first", expected: "x" },
    { id: "c2", input: "second", expected: "x" },
    { id: "c3", input: "third", expected: "x" },
  ],
};

/** A function task: three calls through ctx.llm; its output is the last reply. */
const fnTask = (o: { system?: string; second?: string } = {}) => ({
  kind: "function" as const,
  name: "agent",
  fn: async (input: unknown, ctx: TaskContext) => {
    assert.ok(ctx.llm, "ctx.llm is set");
    const r = await threeCalls(ctx.llm.anthropicBaseUrl, { ...(o.system ? { system: o.system } : {}), second: o.second ?? `second ${String(input)}` });
    return r.map((x) => (JSON.parse(x.text) as { content: { text: string }[] }).content[0]!.text).join(" | ");
  },
});

const llm = (mode: "record" | "replay", source?: string, until?: number) => ({ mode, dir, upstream: { anthropic: stub.url, openai: stub.url }, ...(source ? { source } : {}), ...(until !== undefined ? { until } : {}) });

describe("exp run with the llm cache", () => {
  let rec: Awaited<ReturnType<typeof runExperiment>>;
  before(async () => {
    rec = await runExperiment({ name: "rec", id: "exp_r1", dataset, task: fnTask(), graders: [exactGrader()], llm: llm("record") });
  });

  test("record: each case-trial counts its calls, metadata.llm says so, and the view shows the line", () => {
    assert.equal(rec.runs.length, 3);
    for (const r of rec.runs) assert.deepEqual(r.llm, { calls: 3, hits: 0, live: 3 });
    assert.deepEqual(rec.metadata?.llm, { mode: "record" });
    assert.match(renderExperiment(rec, { color: false }), /LLM calls: 9 \(0 cached, 9 live\)/);
  });

  test("an unchanged replay: 0 upstream calls, identical outputs", async () => {
    const before = stub.calls();
    const rep = await runExperiment({ name: "rep", id: "exp_r2", dataset, task: fnTask(), graders: [exactGrader()], llm: llm("replay", "exp_r1") });
    assert.equal(stub.calls() - before, 0);
    assert.deepEqual(rep.runs.map((r) => r.output), rec.runs.map((r) => r.output));
    for (const r of rep.runs) assert.deepEqual(r.llm, { calls: 3, hits: 3, live: 0 });
    assert.deepEqual(rep.metadata?.llm, { mode: "replay", source: "exp_r1" });
    assert.match(renderExperiment(rep, { color: false }), /LLM calls: 9 \(9 cached, 0 live\)/);
  });

  test("a system-prompt edit hits 100%; a changed message 2 goes live at ordinal 2", async () => {
    const sys = await runExperiment({ name: "sys", id: "exp_r3", dataset, task: fnTask({ system: "edited system prompt" }), graders: [exactGrader()], llm: llm("replay", "exp_r1") });
    for (const r of sys.runs) assert.deepEqual(r.llm, { calls: 3, hits: 3, live: 0 });
    const m2 = await runExperiment({ name: "m2", id: "exp_r4", dataset, task: fnTask({ second: "edited" }), graders: [exactGrader()], llm: llm("replay", "exp_r1") });
    for (const r of m2.runs) assert.deepEqual(r.llm, { calls: 3, hits: 1, live: 2, firstLiveOrdinal: 2 });
  });

  test("a missing source runs live and leaves the run unscored", async () => {
    const warn: string[] = [];
    const r = await runExperiment({ name: "ms", id: "exp_r5", dataset, task: fnTask(), graders: [exactGrader()], llm: { ...llm("replay", "exp_none"), onWarn: (m) => warn.push(m) } });
    assert.equal(warn.length, 3);
    for (const x of r.runs) {
      assert.deepEqual(x.llm, { calls: 3, hits: 0, live: 3, firstLiveOrdinal: 1, unscored: "missing-source" });
      assert.equal(x.ungraded, true);
      assert.equal(x.pass, false);
    }
    assert.equal(r.summary.ungraded, 3);
    const text = renderExperiment(r, { color: false });
    assert.match(text, /unscored 3 replayed run/);
    assert.doesNotMatch(text, /with a grader error/);
  });

  test("a command task gets ANTHROPIC_BASE_URL and replays with 0 upstream calls", async () => {
    const script = join(dir, "agent.mjs");
    writeFileSync(
      script,
      `import { readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\n` +
        `const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.TEST_KEY }, body: JSON.stringify({ model: "m", system: process.env.SYS, messages: [{ role: "user", content: input }] }) });\n` +
        `process.stdout.write(JSON.stringify((await res.json()).content[0].text));\n`,
    );
    const task = (sys: string) => ({ kind: "command" as const, command: process.execPath, args: [script], env: { TEST_KEY: API_KEY, SYS: sys } });
    const r1 = await runExperiment({ name: "cmd", id: "exp_c1", dataset, task: task("a"), graders: [exactGrader()], llm: llm("record") });
    assert.ok(r1.runs.every((r) => r.error === undefined && r.llm?.calls === 1), JSON.stringify(r1.runs.map((r) => r.error)));
    // The recorded task spec keeps non-secret env and leaves the key out.
    const spec = (r1.metadata?.llm as { task?: { env?: Record<string, string> } }).task;
    assert.deepEqual(spec?.env, { SYS: "a" });
    const before = stub.calls();
    const r2 = await runExperiment({ name: "cmd2", id: "exp_c2", dataset, task: task("b"), graders: [exactGrader()], llm: llm("replay", "exp_c1") });
    assert.equal(stub.calls() - before, 0);
    assert.deepEqual(r2.runs.map((r) => r.output), r1.runs.map((r) => r.output));
    for (const t of recordingTexts(dir)) assert.ok(!t.includes(API_KEY));
  });

  test("(11) control arm: the noise floor and the compare note", async () => {
    // A vs A' at the same boundary: both arms replay exp_r1 up to call 1.
    const ab = await runAb({ name: "ctl", dataset, arms: [{ name: "control", task: fnTask() }, { name: "cand", task: fnTask({ system: "new prompt" }) }], graders: [exactGrader()], seed: 1, llm: llm("replay", "exp_r1", 1) });
    for (const r of [...ab.a.runs, ...ab.b.runs]) assert.deepEqual(r.llm, { calls: 3, hits: 1, live: 2, firstLiveOrdinal: 2 });
    const noise = controlNoise(ab.a, rec);
    assert.ok(noise);
    assert.equal(noise.n, 3);
    assert.equal(noise.outputsDiffer, 3, "calls 2 and 3 ran live, so every output differs from the recording");
    assert.deepEqual(noise.firstLive, { n: 3, min: 2, median: 2, max: 2 });
    ab.a.metadata = { ...ab.a.metadata, llm: { ...(ab.a.metadata?.llm as object), noise } };
    const cmp = compareExperiments(ab.a, ab.b, { force: true });
    assert.deepEqual(cmp.llmReplay?.replayed, ["a", "b"]);
    assert.match(cmp.llmReplay!.note, /correlated/);
    assert.equal(cmp.llmReplay?.noise?.n, 3);
    const text = renderComparison(cmp, { color: false, a: ab.a, b: ab.b });
    assert.match(text, /llm replay noise floor 0% \(n=3\)/);
    assert.match(text, /first live call 2–2 \(median 2\)/);
    assert.match(text, /Confirm with a fresh live run/);
    // No replay on either side: no note.
    assert.equal(compareExperiments(rec, rec, { force: true }).llmReplay, undefined);
    assert.match(llmReplayNote({ metadata: { llm: { mode: "replay", control: "skipped" } } }, {})!.controlWarning!, /--no-control/);
  });

  test("gc drops the least recently used recordings past the cap", async () => {
    const all = await gcLlmCache(dir, { dryRun: true });
    assert.ok(all.scanned >= 9);
    const r = await gcLlmCache(dir, { maxBytes: 0, dryRun: true });
    assert.equal(r.deleted, r.scanned);
    assert.equal(r.keptBytes, 0);
  });
});
