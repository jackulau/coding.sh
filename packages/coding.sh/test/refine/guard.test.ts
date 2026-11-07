// AB-3: kept edits' won dev tasks guard later candidates (K8; arXiv 2611.03219 eq. 3).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGuard, guardSet, guardTasks, type GuardEntry } from "../../src/refine/guard.ts";

const runs = (spec: Record<string, string>): Map<string, boolean[]> => new Map(Object.entries(spec).map(([id, s]) => [id, [...s].map((c) => c === "1")]));

describe("guardTasks", () => {
  it("is the dev tasks the candidate turned from unsolved to solved (per-task majority)", () => {
    const base = runs({ a: "000", b: "100", c: "110", d: "000" });
    const cand = runs({ a: "111", b: "110", c: "111", d: "100" });
    assert.deepEqual(guardTasks({ base, cand }), ["a", "b"]);
  });
});

describe("guardSet", () => {
  const e1: GuardEntry = { id: "r1", at: "2026-11-01T00:00:00Z", status: "kept", guardTasks: ["g1", "g2", "g3", "g4"] };
  const e2: GuardEntry = { id: "r2", at: "2026-11-03T00:00:00Z", status: "applied", guardTasks: ["h1", "g2"] };

  it("unions kept entries newest first and leaves out the finding's own dev and held-out tasks", () => {
    const s = guardSet([e1, e2], { exclude: ["g4", "h9"] });
    assert.deepEqual(s.tasks, ["h1", "g2", "g1", "g3"]);
    assert.deepEqual(s.from.get("g2"), ["r2", "r1"]);
    assert.equal(s.dropped, 0);
    assert.equal(s.note, undefined);
  });

  it("drops rolled-back and rejected entries", () => {
    assert.deepEqual(guardSet([{ ...e1, rolledBack: true }, e2]).tasks, ["h1", "g2"]);
    assert.deepEqual(guardSet([{ ...e1, status: "alternative" }]).tasks, []);
    assert.deepEqual(guardSet([]).tasks, []);
  });

  it("caps at maxGuard, newest first, with a note", () => {
    const s = guardSet([e1, e2], { maxGuard: 3 });
    assert.deepEqual(s.tasks, ["h1", "g2", "g1"]);
    assert.equal(s.dropped, 2);
    assert.equal(s.note, "guard set capped at 3 of 5 tasks (newest kept edits first)");
    assert.equal(s.from.has("g3"), false);
    assert.throws(() => guardSet([e1], { maxGuard: -1 }), /maxGuard/);
  });
});

describe("checkGuard (K8)", () => {
  const kept: GuardEntry = { id: "r1", at: 1, status: "kept", guardTasks: ["g1", "g2", "g3", "g4"] };
  const base = runs({ g1: "111", g2: "111", g3: "110", g4: "111" });

  it("candidate 2 fails 3 of 4 guard tasks from kept candidate 1 → forgets kept edit r1", () => {
    const r = checkGuard(guardSet([kept]), { base, cand: runs({ g1: "000", g2: "100", g3: "000", g4: "111" }) });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, "dont-ship");
    assert.equal(r.reason, "forgets kept edit r1");
    assert.deepEqual(
      r.forgotten.map((f) => f.task),
      ["g1", "g2", "g3"],
    );
    assert.equal(r.gate?.losses, 3);
  });

  it("passes once kept candidate 1 is rolled back: no guard set, no stage", () => {
    const r = checkGuard(guardSet([{ ...kept, rolledBack: true }]), { base, cand: runs({ g1: "000", g2: "000", g3: "000", g4: "000" }) });
    assert.deepEqual(r, { ok: true, verdict: "hold", forgotten: [], forgets: [] });
  });

  it("holding every guard task passes; 'hold' passes too", () => {
    assert.equal(checkGuard(guardSet([kept]), { base, cand: base }).ok, true);
    assert.equal(checkGuard(guardSet([kept]), { base, cand: base }).verdict, "hold");
  });

  it("names every kept entry that lost tasks, most lost first", () => {
    const k2: GuardEntry = { id: "r2", at: 2, status: "kept", guardTasks: ["h1"] };
    const r = checkGuard(guardSet([kept, k2]), { base: runs({ g1: "111", g2: "111", h1: "111" }), cand: runs({ g1: "000", g2: "000", h1: "000" }) });
    assert.equal(r.reason, "forgets kept edit r1, r2");
  });

  it("skips guard tasks either arm did not run", () => {
    const r = checkGuard(guardSet([kept]), { base: runs({ g1: "111" }), cand: runs({ g2: "000" }) });
    assert.equal(r.ok, true);
    assert.equal(r.gate, undefined);
  });
});
