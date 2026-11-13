// Weight edits and checkpoints over MCP: sessions_list finds the session by its tag and by a
// checkpoint's hash and carries the stat, session_get's timeline has one line per edit and
// checkpoint, the session resource has the row, and the experiment tools name the session
// that recorded the weights file an experiment ran.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { RawClient, cleanup, makeWorld, seed, type World } from "./helpers.ts";

const SID = "sess-weights";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
// Hashes of whole weights files: the one the session saved and the one it started from.
const FILE = `c0ffee${"1".repeat(58)}`;
const FILE_BASE = `ba5e${"2".repeat(60)}`;
const STATS = { events: 3, tensors: 2, weightsChanged: 66560, checkpoints: [FILE] };
const ids: Record<string, string> = {};

let w: World;
let c: RawClient;

before(async () => {
  w = makeWorld();
  await seed(w);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  const t0 = w.now - 3600e3;
  const base = { v: 0 as const, sessionId: SID, agent: "weights-run" };
  const edit = (tensor: string, changed: number, from: string, to: string) => ({ kind: "weights.edit", tensor, shape: [4096, 11008], changed, l2: 0.0183, maxAbs: 0.004, baseSha256: from, editedSha256: to });
  const evs: AgentEvent[] = [
    { ...base, id: "w-0", ts: t0, kind: "session.start", payload: { name: "edit layer 15" } },
    { ...base, id: "w-1", ts: t0 + 100, kind: "notification", payload: edit("model.layers.15.mlp.down_proj.weight", 65536, A, B) },
    { ...base, id: "w-2", ts: t0 + 200, kind: "notification", payload: edit("model.layers.16.mlp.down_proj.weight", 1024, B, C) },
    { ...base, id: "w-2b", ts: t0 + 250, kind: "notification", payload: { kind: "weights.edit" } },
    { ...base, id: "w-2c", ts: t0 + 275, kind: "notification", payload: { kind: "weights.checkpoint", sha256: FILE, baseSha256: FILE_BASE, note: "saved after layer 16" } },
    { ...base, id: "w-3", ts: t0 + 300, kind: "session.end", payload: {} },
  ];
  await ctx.index.putEvents(evs);
  await ctx.index.upsertSession(buildSession(evs));
  // One experiment ran the file the session saved, one ran the file it started from, one recorded none.
  const ds = createDataset({ name: "wt", createdAt: 1, cases: [1, 2].map((n) => ({ id: `m${n}`, input: n, expected: n })) });
  const exact: Grader = { id: "exact", version: "1", kind: "custom", grade: async (x) => ({ score: 1, pass: x.output === x.expected }) };
  const evals = new FileEvalStore({ env: w.env, index: ctx.index });
  for (const [name, sha256] of [["wt-base", FILE_BASE], ["wt-edited", FILE], ["wt-plain", undefined]] as const) {
    const r = await runExperiment({ name, dataset: ds, task: (n) => n, graders: [exact], metadata: sha256 ? { weights: { sha256 } } : undefined });
    await evals.putExperiment(r);
    ids[name] = r.id;
  }
  await ctx.close();
  c = new RawClient(w.env, w.repo);
  await c.initialize();
});

after(async () => {
  await c?.close();
  cleanup();
});

describe("weight edits over MCP", () => {
  it("sessions_list finds the session by its tag, with the stat", async () => {
    const r = await c.call("sessions_list", { flag: "weights:edited" });
    const sessions = r.structuredContent!.sessions as { id: string; flags?: string[]; weightEdits?: unknown }[];
    assert.deepEqual(sessions.map((s) => s.id), [SID]);
    assert.deepEqual(sessions[0]!.weightEdits, STATS);
    assert.ok(sessions[0]!.flags!.includes("weights:edited") && sessions[0]!.flags!.includes("weights:checkpoint"));
    for (const q of [`weights.checkpoint:${FILE}`, "weights.checkpoint:c0ffee*", "flag:weights:checkpoint"]) {
      const hit = await c.call("sessions_list", { where: q });
      assert.deepEqual((hit.structuredContent!.sessions as { id: string }[]).map((s) => s.id), [SID], q);
    }
    const miss = await c.call("sessions_list", { where: `weights.checkpoint:${FILE_BASE}` });
    assert.deepEqual(miss.structuredContent!.sessions, [], "the hash a checkpoint started from is not a checkpoint");
    const where = await c.call("sessions_list", { where: "weights.changed>1000" });
    assert.deepEqual((where.structuredContent!.sessions as { id: string }[]).map((s) => s.id), [SID]);
    const all = await c.call("sessions_list", {});
    const other = (all.structuredContent!.sessions as { id: string; weightEdits?: unknown }[]).filter((s) => s.id !== SID);
    assert.ok(other.length > 0 && other.every((s) => !Object.hasOwn(s, "weightEdits")), "sessions without edits carry no weightEdits key");
  });

  it("session_get has one timeline line per edit and checkpoint", async () => {
    const r = await c.call("session_get", { sessionId: SID });
    const d = r.structuredContent as { session: { weightEdits?: unknown }; timeline: { kind: string; text: string }[]; timelineTotal: number };
    assert.deepEqual(d.session.weightEdits, STATS);
    assert.deepEqual(
      d.timeline.map((t) => [t.kind, t.text]),
      [
        ["weights", "model.layers.15.mlp.down_proj.weight [4096×11008] · 65,536 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaaaaaa → bbbbbbbbbbbb"],
        ["weights", "model.layers.16.mlp.down_proj.weight [4096×11008] · 1,024 of 45,088,768 weights · L2 0.0183 · max 0.004 · bbbbbbbbbbbb → cccccccccccc"],
        ["weights", "no details recorded"],
        ["weights", "checkpoint c0ffee111111 ← ba5e22222222"],
      ],
    );
    assert.equal(d.timelineTotal, 4, "an edit with no readable field keeps its line");
  });

  it("session_get names the experiments that ran the session's checkpoint, as coding.sh show --json does", async () => {
    const r = await c.call("session_get", { sessionId: SID });
    const d = r.structuredContent as { checkpointExperiments?: unknown };
    // The file the session saved, not the one it started from: wt-base ran that one.
    assert.deepEqual(d.checkpointExperiments, [{ sha256: FILE, experiments: [{ id: ids["wt-edited"], name: "wt-edited" }] }]);
    const plain = await c.call("session_get", { sessionId: "sess-a" });
    assert.equal(Object.hasOwn(plain.structuredContent!, "checkpointExperiments"), false, "absent on a session with no checkpoint");
  });

  it("the session resource has the weight edits row and both lines", async () => {
    const r = await c.request("resources/read", { uri: `codingsh://session/${SID}` });
    const text = (r.result!.contents as { text: string }[])[0]!.text;
    assert.match(text, /Weight edits.*3 edits, 2 tensors, 66,560 weights changed, checkpoint c0ffee111111/);
    assert.match(text, /checkpoint c0ffee111111 ← ba5e22222222/);
    assert.doesNotMatch(text, /saved after layer 16/);
    assert.match(text, /model\.layers\.15\.mlp\.down_proj\.weight \[4096×11008\]/);
    assert.match(text, /model\.layers\.16\.mlp\.down_proj\.weight \[4096×11008\]/);
  });

  it("experiments_list and experiment_compare name the session that recorded the weights file a run used", async () => {
    const list = await c.call("experiments_list", {});
    const rows = list.structuredContent!.experiments as { id: string; weights?: unknown }[];
    const row = (name: string) => rows.find((r) => r.id === ids[name])!;
    assert.deepEqual(row("wt-edited").weights, { sha256: FILE, sessions: [SID] });
    assert.deepEqual(row("wt-base").weights, { sha256: FILE_BASE }, "no session recorded this file: the stamp alone");
    assert.equal(Object.hasOwn(row("wt-plain"), "weights"), false);

    const cmp = await c.call("experiment_compare", { baseline: ids["wt-base"], candidate: ids["wt-edited"] });
    const d = cmp.structuredContent as { baseline: { weights?: unknown }; candidate: { weights?: unknown } };
    assert.deepEqual(d.baseline.weights, { sha256: FILE_BASE });
    assert.deepEqual(d.candidate.weights, { sha256: FILE, sessions: [SID] });
    const plain = await c.call("experiment_compare", { baseline: ids["wt-plain"], candidate: ids["wt-edited"] });
    assert.equal(Object.hasOwn((plain.structuredContent as { baseline: object }).baseline, "weights"), false);
  });
});
