// Weight edits and checkpoints over MCP: sessions_list finds the session by its tag and by a
// checkpoint's hash and carries the stat, session_get's timeline has one line per edit and
// checkpoint, and the session resource has the row.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
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

  it("the session resource has the weight edits row and both lines", async () => {
    const r = await c.request("resources/read", { uri: `codingsh://session/${SID}` });
    const text = (r.result!.contents as { text: string }[])[0]!.text;
    assert.match(text, /Weight edits.*3 edits, 2 tensors, 66,560 weights changed, checkpoint c0ffee111111/);
    assert.match(text, /checkpoint c0ffee111111 ← ba5e22222222/);
    assert.doesNotMatch(text, /saved after layer 16/);
    assert.match(text, /model\.layers\.15\.mlp\.down_proj\.weight \[4096×11008\]/);
    assert.match(text, /model\.layers\.16\.mlp\.down_proj\.weight \[4096×11008\]/);
  });
});
