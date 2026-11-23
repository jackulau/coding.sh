import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Session, TurnTally } from "../../src/schema/index.ts";
import { scorecardOf } from "../../src/core/scorecard.ts";
import { medianInterval, newcombeDiff, wilson } from "../../src/stats/interval.ts";

let n = 0;
/** A session row with only what the scorecard reads. */
function sess(o: { agent?: string; host?: string; model?: string; launch?: "headless" | "interactive"; parent?: Session["parent"]; turns?: Record<string, TurnTally>; edits?: [number, number?]; shells?: [number, number?] }): Session {
  const stats: Session["stats"] = { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 };
  if (o.launch) stats.launch = o.launch;
  if (o.turns) stats.turnsByModel = o.turns;
  if (o.edits) stats.edits = o.edits[1] ? { calls: o.edits[0], failed: o.edits[1] } : { calls: o.edits[0] };
  if (o.shells) stats.shells = o.shells[1] ? { calls: o.shells[0], failed: o.shells[1] } : { calls: o.shells[0] };
  const s: Session = { id: `s${++n}`, agent: o.agent ?? "claude-code", title: "t", startedAt: 0, flags: [], stats };
  if (o.host) s.host = o.host;
  if (o.model) s.model = o.model;
  if (o.parent) s.parent = o.parent;
  return s;
}

const interactive = (turns: Record<string, TurnTally>, o: Parameters<typeof sess>[0] = {}) => sess({ launch: "interactive", ...o, turns });

describe("scorecardOf", () => {
  it("counts each turn under the model that ran it and each call under its session's model", () => {
    const card = scorecardOf(
      [
        interactive({ a: { turns: 3, replied: 2, pushback: { undo: 1 } }, b: { turns: 1 } }, { model: "a", edits: [4, 1], shells: [10, 2] }),
        interactive({ b: { turns: 5, replied: 5, pushback: { redo: 1, broken: 2 }, cancelled: 1 } }, { model: "b", shells: [6] }),
      ],
      "model",
    );
    assert.equal(card.sessions, 2);
    assert.equal(card.turnSessions, 2);
    assert.deepEqual(card.groups.map((g) => g.key), ["b", "a"]);
    const [b, a] = card.groups;
    assert.deepEqual(b!.turns, { n: 6, sessions: 2 });
    assert.deepEqual(a!.turns, { n: 3, sessions: 1 });
    // b's one turn in the first session has no reply: pushback counts out of b's replied turns only.
    assert.equal(b!.pushback!.k, 3);
    assert.equal(b!.pushback!.n, 5);
    assert.equal(b!.pushback!.sessions, 1);
    assert.equal(b!.pushback!.byKind.broken.k, 2);
    assert.equal(b!.pushback!.byKind.broken.n, 5);
    assert.equal(b!.pushback!.byKind.intent.k, 0);
    assert.equal(b!.cancelled!.k, 1);
    assert.equal(b!.cancelled!.n, 6);
    assert.equal(b!.cancelled!.sessions, 2);
    // The tool rows read Session.model: b's turn in the first session leaves its calls with a.
    assert.deepEqual([a!.edits!.k, a!.edits!.n, a!.edits!.sessions], [1, 4, 1]);
    assert.deepEqual([a!.shells!.k, a!.shells!.n], [2, 10]);
    assert.equal(b!.edits, undefined);
    assert.deepEqual([b!.shells!.k, b!.shells!.n, b!.shells!.sessions], [0, 6, 1]);
    const w = wilson(1, 4);
    assert.deepEqual([a!.edits!.rate, a!.edits!.lo, a!.edits!.hi], [w.p, w.lo, w.hi]);
    // 0 of n starts at 0 exactly, not at the formula's 1e-17.
    assert.deepEqual([b!.shells!.lo, b!.pushback!.byKind.intent.lo], [0, 0]);
    assert.ok(wilson(0, 28).lo > 0, "the formula alone leaves a rounding error at 0 of 28");
    assert.equal(scorecardOf([interactive({ c: { turns: 28, replied: 28 } }, { model: "c" })], "model").groups[0]!.pushback!.byKind.undo.lo, 0);
  });

  it("by agent, a session's models share one group and count it once", () => {
    const card = scorecardOf([interactive({ a: { turns: 2, replied: 1 }, b: { turns: 2, replied: 2, pushback: { intent: 1 } } }, { model: "a" })], "agent");
    assert.equal(card.groups.length, 1);
    const g = card.groups[0]!;
    assert.equal(g.key, "claude-code");
    assert.deepEqual(g.turns, { n: 4, sessions: 1 });
    assert.deepEqual([g.pushback!.k, g.pushback!.n, g.pushback!.sessions], [1, 3, 1]);
    assert.equal(card.difference, undefined);
  });

  it("leaves cancelled out for turns whose capture does not record it: the group lists them instead of a 0", () => {
    const card = scorecardOf(
      [
        interactive({ m: { turns: 4, cancelNotRecorded: 4 } }, { agent: "gemini-cli", model: "m" }),
        interactive({ m: { turns: 2, cancelled: 1 } }, { model: "m" }),
        interactive({ g: { turns: 3, cancelNotRecorded: 3 } }, { agent: "gemini-cli", model: "g" }),
        // A T3 Code thread built from T3 Code's store: its agent records a stop, the host's store does not.
        interactive({ g: { turns: 5, cancelNotRecorded: 5 } }, { host: "t3code", model: "g" }),
      ],
      "model",
    );
    const m = card.groups.find((g) => g.key === "m")!;
    assert.deepEqual([m.cancelled!.k, m.cancelled!.n, m.cancelled!.sessions], [1, 2, 1]);
    assert.deepEqual(m.cancelNotRecorded, { "gemini-cli": 4 });
    const g = card.groups.find((x) => x.key === "g")!;
    assert.equal(g.cancelled, undefined);
    assert.deepEqual(g.cancelNotRecorded, { "gemini-cli": 3, t3code: 5 });
    // Neither group has a cancelled row the other can be set against.
    assert.equal(card.difference!.cancelled, undefined);
  });

  it("says why sessions count in no turn row, and counts their calls in the tool rows", () => {
    const card = scorecardOf(
      [
        sess({ model: "a", launch: "interactive", parent: { sessionId: "p", type: "task" }, edits: [2, 2] }),
        sess({ model: "a", launch: "headless", shells: [3, 1] }),
        sess({ agent: "gemini-cli", model: "a" }),
        sess({ agent: "gemini-cli", model: "a" }),
        // A provider switch is not a subagent, and an interactive session with no turns is left out of nothing.
        sess({ model: "a", launch: "interactive", parent: { sessionId: "p", type: "provider-switch" } }),
      ],
      "model",
    );
    assert.equal(card.turnSessions, 0);
    assert.deepEqual(card.turnsLeftOut, { subagent: 1, headless: 1, launchUnknown: { "gemini-cli": 2 } });
    assert.equal(card.groups.length, 1);
    const a = card.groups[0]!;
    assert.equal(a.turns, undefined);
    assert.equal(a.pushback, undefined);
    assert.deepEqual([a.edits!.k, a.edits!.n, a.edits!.hi], [2, 2, 1]);
    assert.deepEqual([a.shells!.k, a.shells!.n], [1, 3]);
  });

  it("gives the median turn duration its interval from 6 turns on, and the quartiles", () => {
    const five = scorecardOf([interactive({ a: { turns: 5, durationsMs: [500, 100, 400, 200, 300] } })], "model").groups[0]!.duration!;
    assert.deepEqual(five, { n: 5, sessions: 1, medianMs: 300, p25Ms: 200, p75Ms: 400 });
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
    const card = scorecardOf([interactive({ a: { turns: 10, durationsMs: xs.slice(0, 10) } }), interactive({ a: { turns: 10, durationsMs: xs.slice(10).reverse() } })], "model");
    const d = card.groups[0]!.duration!;
    const m = medianInterval(xs);
    assert.deepEqual([d.n, d.sessions, d.medianMs, d.loMs, d.hiMs], [20, 2, m.p, m.lo, m.hi]);
    assert.deepEqual([d.p25Ms, d.p75Ms], [5750, 15250]);
  });

  it("names a session with no model with the empty key", () => {
    const card = scorecardOf([interactive({ "": { turns: 1 } }, { shells: [1] })], "model");
    assert.deepEqual(card.groups.map((g) => g.key), [""]);
    assert.deepEqual(card.groups[0]!.turns, { n: 1, sessions: 1 });
    assert.equal(card.groups[0]!.shells!.n, 1);
  });

  it("sets two groups side by side: the second minus the first, clear only when the interval leaves out 0", () => {
    const card = scorecardOf(
      [
        interactive({ a: { turns: 100, replied: 100, pushback: { undo: 30 } } }, { model: "a", edits: [50, 1] }),
        interactive({ b: { turns: 40, replied: 40, pushback: { undo: 2 } } }, { model: "b", edits: [50, 2] }),
      ],
      "model",
    );
    const diff = card.difference!;
    assert.deepEqual([diff.a, diff.b], ["a", "b"]);
    const pb = newcombeDiff(30, 100, 2, 40);
    assert.deepEqual(diff.pushback, { d: pb.p, lo: pb.lo, hi: pb.hi, clear: true });
    assert.ok(pb.hi < 0);
    assert.equal(diff.pushbackByKind!.undo!.clear, true);
    assert.equal(diff.pushbackByKind!.intent!.clear, false);
    const ed = newcombeDiff(1, 50, 2, 50);
    assert.deepEqual(diff.edits, { d: ed.p, lo: ed.lo, hi: ed.hi, clear: false });
    assert.equal(diff.shells, undefined);
    assert.equal(diff.durationMs, undefined);
  });

  it("gives a duration difference no interval while either side has fewer than 6 turns", () => {
    const card = scorecardOf(
      [
        interactive({ a: { turns: 3, durationsMs: [1000, 2000, 3000] } }, { model: "a" }),
        interactive({ b: { turns: 8, durationsMs: [1, 2, 3, 4, 5, 6, 7, 8].map((x) => x * 10_000) } }, { model: "b" }),
      ],
      "model",
    );
    // b ran more turns, so it is the first group: the difference is a's median minus b's.
    assert.deepEqual([card.difference!.a, card.difference!.b], ["b", "a"]);
    assert.deepEqual(card.difference!.durationMs, { d: 2000 - 45_000, clear: false });
  });

  it("has no difference column with more than two groups, and nothing to show with no sessions", () => {
    const three = scorecardOf([interactive({ a: { turns: 1 }, b: { turns: 1 }, c: { turns: 1 } })], "model");
    assert.equal(three.groups.length, 3);
    assert.equal(three.difference, undefined);
    assert.deepEqual(scorecardOf([], "model"), { by: "model", sessions: 0, turnSessions: 0, groups: [], turnsLeftOut: {} });
  });
});
