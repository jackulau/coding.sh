// A new snooze of a work item replaces its earlier one (src/core/work-overlay.ts, snoozeItem). The
// work queue model (test/verify/work-model.test.ts) found the case this covers: a snooze is stored
// on the item's main session and on the session behind its cause, and snoozeOf takes the latest
// ending snooze on any of the item's sessions. So after an item moved to a more urgent bucket, a
// shorter snooze left it in the queue (the earlier snooze, still on the earlier cause's session,
// ended later and named the old bucket), and when the shorter one ended, the earlier one hid the
// item again. The snoozes here are written by snoozeItem, which `coding.sh work snooze` calls.
// A review of the fix found that a shorter time window could leave that session out of the item,
// so each snooze now also holds the item's id, and the item's next snooze removes it wherever it is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkQueue, type WorkItem } from "../../src/core/work.ts";
import { addSnooze, emptyOverlay, pruneOverlay, snoozeItem, type WorkOverlay } from "../../src/core/work-overlay.ts";
import type { Session, Waiting } from "../../src/schema/index.ts";

const T0 = Date.parse("2026-11-20T12:00:00Z");
const MIN = 60e3;
const HOUR = 60 * MIN;
const START = T0 - 2 * HOUR;

/** The item's main session, with no end, waiting on `waiting` since its last event. */
const main = (waiting: Waiting): Session => ({
  id: "p",
  agent: "claude-code",
  cwd: "/work/demo",
  startedAt: START,
  flags: [],
  stats: { events: 9, turns: 2, toolCalls: 3, toolErrors: 0, filesChanged: 0, latency: { wallMs: waiting.at - START }, waiting },
});

/** Its subagent, with no end and quiet since an hour before T0: stalled. */
const sub: Session = {
  id: "p:sub:a1",
  agent: "claude-code",
  cwd: "/work/demo",
  parent: { sessionId: "p", subagentId: "a1" },
  startedAt: START,
  flags: [],
  stats: { events: 4, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0, latency: { wallMs: HOUR } },
};

function itemAt(sessions: Session[], now: number, overlay: WorkOverlay): WorkItem {
  const q = buildWorkQueue(sessions, { now, overlay, all: true });
  assert.equal(q.items.length, 1);
  return q.items[0]!;
}

/** What `coding.sh work snooze <id> <duration>` and POST /api/work/snooze write (src/cli/commands/work.ts and src/viewer/work.ts, snooze). */
function snooze(overlay: WorkOverlay, item: WorkItem, now: number, ms: number): void {
  const bucket = item.bucket ?? item.cause?.bucket ?? "review";
  snoozeItem(overlay, item, { until: now + ms, bucket });
  // writeOverlay prunes before it writes.
  pruneOverlay(overlay, now);
}

test("a shorter snooze after a move to a more urgent bucket hides the item, and only until it ends", () => {
  const overlay = emptyOverlay();
  const turn = main({ kind: "turn", at: T0 - 5 * MIN });
  const stalled = itemAt([turn, sub], T0, overlay);
  assert.equal(stalled.bucket, "stalled");
  assert.equal(stalled.cause?.sessionId, sub.id);
  snooze(overlay, stalled, T0, 2 * HOUR);
  assert.equal(itemAt([turn, sub], T0, overlay).hidden, "snoozed");

  // The main session asks for a permission: more urgent than stalled, so the item comes back.
  const prompt = main({ kind: "permission", at: T0 + 9 * MIN, toolUseId: "t1" });
  const blocked = itemAt([prompt, sub], T0 + 10 * MIN, overlay);
  assert.equal(blocked.bucket, "blocked");
  snooze(overlay, blocked, T0 + 10 * MIN, 30 * MIN);
  const hidden = itemAt([prompt, sub], T0 + 10 * MIN, overlay);
  assert.equal(hidden.hidden, "snoozed", "the snooze just made hides the item");
  assert.equal(hidden.next, `snoozed until ${new Date(T0 + 40 * MIN).toISOString()}`);

  // It ends after 30 minutes, and the earlier, longer snooze does not hide the item again.
  assert.equal(itemAt([prompt, sub], T0 + 41 * MIN, overlay).bucket, "blocked");
  const answered = main({ kind: "turn", at: T0 + 45 * MIN });
  const back = itemAt([answered, sub], T0 + 50 * MIN, overlay);
  assert.equal(back.bucket, "stalled", "the earlier snooze was replaced");
});

test("a new snooze replaces the earlier one on a session that the time window leaves out", () => {
  // p and its subagent c1 started 3 days ago, and c1 has been quiet since: stalled. c2 started 2 hours
  // ago and has ended. A 7-day window loads all three. A 1-day window loads c2 and, as c2's parent, p
  // (core/work.ts loadWorkSessions), but not c1: the same item, without c1.
  const DAY = 24 * HOUR;
  const OLD = T0 - 3 * DAY;
  const root = (waiting: Waiting): Session => ({ ...main(waiting), startedAt: OLD, stats: { ...main(waiting).stats, latency: { wallMs: waiting.at - OLD } } });
  const c1: Session = { ...sub, id: "p:sub:c1", parent: { sessionId: "p", subagentId: "c1" }, startedAt: OLD };
  const c2: Session = { ...sub, id: "p:sub:c2", parent: { sessionId: "p", subagentId: "c2" }, startedAt: T0 - 2 * HOUR, endedAt: T0 - HOUR };
  const overlay = emptyOverlay();
  const turn = root({ kind: "turn", at: T0 - 5 * MIN });
  const stalled = itemAt([turn, c1, c2], T0, overlay);
  assert.equal(stalled.bucket, "stalled");
  assert.equal(stalled.cause?.sessionId, c1.id);
  snooze(overlay, stalled, T0, 4 * HOUR);

  // p asks for a permission, and the item is snoozed again through the 1-day window.
  const prompt = root({ kind: "permission", at: T0 + 9 * MIN, toolUseId: "t1" });
  const blocked = itemAt([prompt, c2], T0 + 10 * MIN, overlay);
  assert.equal(blocked.id, stalled.id, "the same item through both windows");
  assert.equal(blocked.bucket, "blocked");
  snooze(overlay, blocked, T0 + 10 * MIN, 30 * MIN);

  // Through the 7-day window, the snooze just made hides the item: the earlier one is gone from c1 too.
  const hidden = itemAt([prompt, c1, c2], T0 + 10 * MIN, overlay);
  assert.equal(hidden.hidden, "snoozed", "the snooze just made hides the item");
  assert.equal(hidden.next, `snoozed until ${new Date(T0 + 40 * MIN).toISOString()}`);

  // It ends after 30 minutes, and the earlier, longer snooze does not hide the item again.
  assert.equal(itemAt([prompt, c1, c2], T0 + 41 * MIN, overlay).bucket, "blocked");
  const answered = root({ kind: "turn", at: T0 + 45 * MIN });
  assert.equal(itemAt([answered, c1, c2], T0 + 50 * MIN, overlay).bucket, "stalled", "the earlier snooze was replaced");
});

test("a snooze of another item is kept, even one that ends at the same time and names the same bucket", () => {
  const overlay = emptyOverlay();
  // Another item's snooze from a file written before snoozes held their item's id.
  addSnooze(overlay, ["other"], { until: T0 + HOUR, bucket: "review" });
  // Another item, snoozed at the same moment as the first snooze below, for as long, from the same bucket.
  addSnooze(overlay, ["twin"], { until: T0 + 2 * HOUR, bucket: "stalled", item: "w000000" });
  const turn = main({ kind: "turn", at: T0 - 5 * MIN });
  snooze(overlay, itemAt([turn, sub], T0, overlay), T0, 2 * HOUR);
  assert.deepEqual({ ...overlay.snoozes.p, item: "w000000" }, overlay.snoozes.twin, "the first snooze equals the other item's but for the item id");
  snooze(overlay, itemAt([turn, sub], T0, overlay), T0 + MIN, 3 * HOUR);
  assert.deepEqual(overlay.snoozes.other, { until: T0 + HOUR, bucket: "review" });
  assert.deepEqual(overlay.snoozes.twin, { until: T0 + 2 * HOUR, bucket: "stalled", item: "w000000" });
  assert.deepEqual(Object.keys(overlay.snoozes).sort(), ["other", "p", "p:sub:a1", "twin"]);
});
