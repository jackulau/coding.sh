// A model of one work item's acks and snoozes, checked with test/_model.ts against the real code.
// groupWorkItems and workItem (src/core/work.ts) build the item. addAck, addSnooze and pruneOverlay
// (src/core/work-overlay.ts) change the overlay as `coding.sh work ack` and `coding.sh work snooze`
// do (ack and snooze in src/cli/commands/work.ts; workSnooze in src/viewer/work.ts does the same).
//
// The item has a main session p and its subagent c. A step is new activity on one of them (it
// works, waits for its turn, waits on a prompt, fails, or ends with changed files), 20 minutes
// passing, or the user acknowledging or snoozing the item. A spec written from the rules in
// docs/design/work.md ("The queue", "Acknowledging and snoozing") says where the item belongs: in
// the bucket of its most urgent cause the user has not acknowledged, hidden while the user's newest
// snooze runs and that cause is no more urgent than the bucket the snooze was made in, and hidden as
// acknowledged, running or done when no cause is left. An ack covers one cause until new activity
// gives it a new identity. The invariants say the real item is where the spec puts it.
//
// Bounds: two time steps, two activities and two user actions. Two steps are enough for a session to
// stall (one step) and to stop running (two), and for a 30-minute snooze to run out while a one-hour
// snooze has not. Two activities and two user actions are enough for two snoozes, or an ack and a
// snooze, around a change of cause. CODING_SH_MODEL_BOUND=n adds n to each bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf, check, formatTrace, stableKey, update, type Action, type CheckResult, type Model } from "../_model.ts";
import { BUCKETS, groupWorkItems, workItem, type Bucket, type WorkItem } from "../../src/core/work.ts";
import { addAck, addSnooze, pruneOverlay, emptyOverlay, type WorkOverlay, type WorkSnooze } from "../../src/core/work-overlay.ts";
import type { Session } from "../../src/schema/index.ts";

const SEC = 1e3;
const MIN = 60 * SEC;
const T0 = Date.parse("2026-11-20T12:00:00Z");
const START = T0 - 120 * MIN;
/**
 * One time step. Activity is about a minute old at the step it happens in, so a session with no end
 * and no wait is running then, stalled one step later, and no longer running two steps later.
 */
const STEP = 20 * MIN;
/** The doc's thresholds: quiet this long is a stall; active within this long is running. */
const STALL = 15 * MIN;
const IDLE = 30 * MIN;

type Who = "p" | "c";
type Phase = "working" | "turn" | "blocked" | "failed" | "done" | "idle";
/** A session's state: its phase, the activity that set it (0 at the start), and when that was. */
interface Member {
  phase: Phase;
  n: number;
  at: number;
}

interface WorkState {
  tick: number;
  steps: number;
  users: number;
  p: Member;
  c: Member;
  overlay: WorkOverlay;
  /** Spec: the ids of the causes the user acknowledged. */
  acked: string[];
  /** Spec: the newest snooze the user made. */
  snooze: WorkSnooze | null;
}

interface Bounds {
  ticks: number;
  steps: number;
  users: number;
}

const ID: Record<Who, string> = { p: "p", c: "p:sub:a1" };
const PHASES: Record<Who, readonly Phase[]> = { p: ["working", "turn", "blocked", "failed", "done"], c: ["working", "blocked", "done"] };
const ended = (m: Member): boolean => m.phase === "failed" || m.phase === "done" || m.phase === "idle";
const nowOf = (s: WorkState): number => T0 + s.tick * STEP;
const rank = (b: Bucket): number => BUCKETS.indexOf(b);

function boundsFrom(env: NodeJS.ProcessEnv): Bounds {
  const raw = env.CODING_SH_MODEL_BOUND ?? "0";
  const extra = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${raw}`);
  return { ticks: 2 + extra, steps: 2 + extra, users: 2 + extra };
}

/** The session the store would hold for a member in this state. */
function sessionOf(who: Who, m: Member): Session {
  const s: Session = {
    id: ID[who],
    agent: "claude-code",
    cwd: "/work/demo",
    startedAt: START + (who === "p" ? 0 : SEC),
    flags: [],
    stats: { events: 4, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: m.phase === "failed" || m.phase === "done" ? 1 : 0 },
  };
  if (who === "c") s.parent = { sessionId: ID.p, subagentId: "a1" };
  if (ended(m)) s.endedAt = m.at;
  else s.stats.latency = { wallMs: m.at - s.startedAt };
  if (m.phase === "turn") s.stats.waiting = { kind: "turn", at: m.at };
  // p's prompt has a tool call id; c's question has none, so its time tells one wait from the next.
  if (m.phase === "blocked") s.stats.waiting = who === "p" ? { kind: "permission", at: m.at, toolUseId: `t${m.n}` } : { kind: "question", at: m.at };
  if (m.phase === "failed") s.stats.testsFailed = 1;
  return s;
}

interface SpecCause {
  bucket: Bucket;
  who: Who;
  /** Changes when, and only when, new activity makes it a new cause. */
  id: string;
}

const members = (s: WorkState) => (["p", "c"] as const).map((who) => ({ who, m: s[who] })).sort((a, b) => a.m.at - b.m.at);
const specRunning = (s: WorkState): boolean => members(s).some(({ m }) => !ended(m) && nowOf(s) - m.at < IDLE);

/** The item's causes by the doc's rules, most urgent first, oldest first within a bucket. */
function specCauses(s: WorkState): SpecCause[] {
  const now = nowOf(s);
  const all = members(s);
  const stopped = !specRunning(s) && !all.some(({ m }) => m.phase === "turn" || m.phase === "blocked");
  const out: SpecCause[] = [];
  for (const { who, m } of all) if (m.phase === "blocked") out.push({ bucket: "blocked", who, id: `blocked:${who}:${m.n}` });
  if (stopped && s.p.phase === "failed") out.push({ bucket: "failed", who: "p", id: `failed:${s.p.n}` });
  for (const { who, m } of all) if (m.phase === "working" && now - m.at >= STALL) out.push({ bucket: "stalled", who, id: `stalled:${who}:${m.n}` });
  if (s.p.phase === "turn") out.push({ bucket: "turn", who: "p", id: `turn:${s.p.n}` });
  const files = all.some(({ m }) => m.phase === "failed" || m.phase === "done");
  if (stopped && files) out.push({ bucket: "review", who: "p", id: `review:${Math.max(s.p.n, s.c.n)}` });
  return out;
}

const specTop = (s: WorkState): SpecCause | undefined => specCauses(s).find((c) => !s.acked.includes(c.id));

type View = { bucket: Bucket; who: Who } | { hidden: string };

function specView(s: WorkState): View {
  const top = specTop(s);
  const z = s.snooze;
  if (top && z && nowOf(s) < z.until && rank(top.bucket) >= rank(z.bucket)) return { hidden: "snoozed" };
  if (top) return { bucket: top.bucket, who: top.who };
  if (specCauses(s).length) return { hidden: "acked" };
  return { hidden: specRunning(s) ? "running" : "done" };
}

function realView(item: WorkItem): View | string {
  if (!item.bucket) return { hidden: item.hidden ?? "none" };
  const who = (["p", "c"] as const).find((w) => ID[w] === item.cause?.sessionId);
  return who ? { bucket: item.bucket, who } : `a cause on ${item.cause?.sessionId ?? "no session"}`;
}

type SnoozeWriter =(o: WorkOverlay, sessionIds: readonly string[], snooze: WorkSnooze) => void;

function workModel(snoozeWith: SnoozeWriter, bounds: Bounds): Model<WorkState> {
  // The checker hands the same state object to the invariants and to every action, so the item is built once per state.
  const built = new WeakMap<WorkState, WorkItem>();
  const real = (s: WorkState): WorkItem => {
    const known = built.get(s);
    if (known) return known;
    const raws = groupWorkItems([sessionOf("p", s.p), sessionOf("c", s.c)]);
    assert.equal(raws.length, 1, "p and its subagent are one item");
    const item = workItem(raws[0]!, nowOf(s), s.overlay);
    built.set(s, item);
    return item;
  };
  const actions: Action<WorkState>[] = [];
  for (const who of ["p", "c"] as const) {
    for (const phase of PHASES[who]) {
      actions.push({
        name: `${who} ${phase}`,
        guard: (s) => s.steps < bounds.steps,
        effect: (s) => update(s, (d) => {
          d.steps++;
          d[who] = { phase, n: d.steps, at: nowOf(s) - MIN + d.steps * SEC };
        }),
      });
    }
  }
  actions.push({ name: "20 minutes pass", guard: (s) => s.tick < bounds.ticks, effect: (s) => update(s, (d) => void d.tick++) });
  // `coding.sh work ack`: only an item in a bucket has a cause to acknowledge.
  actions.push({
    name: "ack",
    guard: (s) => s.users < bounds.users && real(s).bucket !== undefined,
    effect: (s) => {
      const cause = real(s).cause;
      const top = specTop(s);
      if (!cause || !top) return [];
      return update(s, (d) => {
        addAck(d.overlay, cause.sessionId, cause.fingerprint);
        pruneOverlay(d.overlay, nowOf(s));
        d.acked = [...new Set([...d.acked, top.id])].sort();
        d.users++;
      });
    },
  });
  // `coding.sh work snooze <id> <duration>`: the bucket the item is in, on its main session and its cause's.
  for (const [label, ms] of [["30m", 30 * MIN], ["1h", 60 * MIN]] as const) {
    actions.push({
      name: `snooze ${label}`,
      guard: (s) => s.users < bounds.users,
      effect: (s) => {
        const item = real(s);
        const now = nowOf(s);
        const snooze: WorkSnooze = { until: now + ms, bucket: item.bucket ?? item.cause?.bucket ?? "review" };
        const ids = [...new Set([item.primaryId, item.cause?.sessionId ?? item.primaryId])];
        const top = specTop(s) ?? specCauses(s)[0];
        return update(s, (d) => {
          snoozeWith(d.overlay, ids, snooze);
          pruneOverlay(d.overlay, now);
          d.snooze = { until: now + ms, bucket: top?.bucket ?? "review" };
          d.users++;
        });
      },
    });
  }
  return {
    init: {
      tick: 0,
      steps: 0,
      users: 0,
      // p waits for its turn; c ended long ago with no changes.
      p: { phase: "turn", n: 0, at: START + 30 * MIN },
      c: { phase: "idle", n: 0, at: START + 10 * MIN },
      overlay: emptyOverlay(),
      acked: [],
      snooze: null,
    },
    actions,
    invariants: {
      "one bucket or one hidden reason": (s) => {
        const i = real(s);
        return (i.bucket === undefined) !== (i.hidden === undefined) || `bucket ${i.bucket}, hidden ${i.hidden}`;
      },
      "the item is where the rules put it": (s) => {
        const want = specView(s);
        const got = realView(real(s));
        return stableKey(got) === stableKey(want) || `the item is ${stableKey(got)}; the rules put it at ${stableKey(want)}`;
      },
      "a snoozed item says when it comes back": (s) => {
        const i = real(s);
        if (i.hidden !== "snoozed") return true;
        const want = `snoozed until ${new Date(s.snooze?.until ?? 0).toISOString()}`;
        return i.next === want || `next is "${i.next}", not "${want}"`;
      },
    },
    final: () => true,
  };
}

const explain = (r: CheckResult<WorkState>): string => (r.violation ? `${r.violation.invariant}: ${r.violation.message ?? ""}\n${formatTrace(r.violation.trace, (s) => stableKey({ ...s, overlay: s.overlay.snoozes }))}` : "");

test("the item is where the rules put it after any activity, acks, snoozes and time", (t) => {
  const bounds = boundsFrom(process.env);
  const r = check(workModel(addSnooze, bounds));
  assert.equal(r.ok, true, explain(r));
  assert.equal(r.complete, true);
  assert.ok(r.states >= 16_000, `explored ${r.states} states`);
  t.diagnostic(`${r.states} states, ${r.transitions} transitions, depth ${r.depth}`);
});

test("the model finds the snooze that lost to an older one, with the code before the fix", () => {
  // addSnooze as it was: each id gets the new snooze, and a copy of the old one on the earlier cause's session stays.
  const before: SnoozeWriter = (o, ids, z) => {
    for (const id of ids) o.snoozes[id] = { ...z };
  };
  const r = check(workModel(before, { ticks: 2, steps: 2, users: 2 }));
  const v = r.violation;
  assert.ok(v, "the old addSnooze breaks an invariant");
  assert.equal(v.invariant, "a snoozed item says when it comes back");
  assert.deepEqual(actionsOf(v.trace), ["c blocked", "snooze 1h", "c working", "snooze 30m"]);
});
