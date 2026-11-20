// Work items (core/work.ts) and their acks and snoozes (core/work-overlay.ts): grouping by
// parent links, buckets and their order, acks by fingerprint, snoozes that a more urgent
// cause breaks, and the overlay file read tolerantly.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildSession, FLAGS } from "../../src/core/sessions.ts";
import { BUCKETS, buildWorkQueue, changedPaths, countsLine, groupWorkItems, INFERRED_RUNNING_MS, needYou, PROBABLY_CLOSED_MS, STALL_MS, workFiles, workItemId, workItemJson, workJson } from "../../src/core/work.ts";
import { addAck, addSnooze, emptyOverlay, readOverlay, writeOverlay } from "../../src/core/work-overlay.ts";
import type { AgentEvent, Session, Waiting } from "../../src/schema/index.ts";
import { mkSession } from "../cli/_cmd.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const MIN = 60e3;
const ago = (ms: number) => NOW - ms;
type Extra = Parameters<typeof mkSession>[2];
/** A session that started `startAgo` ago and ended a second later (pass endedAt: undefined for one with no end). */
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, ago(startAgo), { cwd: "/work/demo", ...extra });
/** A session with no end whose last event was `quietFor` ago. */
const open = (id: string, quietFor: number, extra: Extra = {}): Session =>
  sess(id, quietFor + MIN, { endedAt: undefined, ...extra, stats: { latency: { wallMs: MIN }, ...extra?.stats } as Partial<Session["stats"]> });
function wait(kind: Waiting["kind"], at: number, toolUseId?: string, text?: string): Waiting {
  const w: Waiting = { kind, at };
  if (toolUseId) w.toolUseId = toolUseId;
  if (text) w.text = text;
  return w;
}

const queue = (sessions: Session[], opts: Parameters<typeof buildWorkQueue>[1] = {}) => buildWorkQueue(sessions, { now: NOW, ...opts });

describe("buckets", () => {
  test("each cause lands in its bucket, in the documented order", () => {
    const q = queue([
      sess("review", 3 * MIN, { stats: { filesChanged: 2 } }),
      open("turn", 5 * MIN, { stats: { waiting: wait("turn", ago(5 * MIN)) } }),
      open("stalled", STALL_MS + MIN, { agent: "codex" }),
      sess("failed", 2 * MIN, { flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } as never } }),
      open("blocked", 2 * MIN, { stats: { waiting: wait("permission", ago(2 * MIN), "t1", "Claude needs your permission to use Bash") } }),
      sess("done", 4 * MIN),
      open("running", MIN),
    ]);
    assert.deepEqual(q.items.map((i) => [i.primaryId, i.bucket]), [["blocked", "blocked"], ["failed", "failed"], ["stalled", "stalled"], ["turn", "turn"], ["review", "review"]]);
    assert.deepEqual(q.counts, { blocked: 1, failed: 1, stalled: 1, turn: 1, review: 1 });
    assert.equal(q.hidden, 2);
    assert.equal(needYou(q), 2);
    assert.equal(countsLine(q.counts), "1 blocked on you · 1 failed · 1 stalled · 1 your turn · 1 ready for review");
    assert.equal(countsLine({ blocked: 0, failed: 0, stalled: 0, turn: 0, review: 0 }), "nothing needs you");
    const blocked = q.items[0]!;
    assert.match(blocked.reason, /^waiting on a permission prompt for 2m: "Claude needs your permission to use Bash"$/);
    assert.equal(blocked.next, "answer in claude-code in /work/demo");
    assert.equal(q.items[1]!.cause?.failure, "api 529");
    assert.match(q.items[4]!.reason, /with 2 files changed/);
    const all = queue([sess("done", 4 * MIN), open("running", MIN)], { all: true });
    assert.deepEqual(all.items.map((i) => i.hidden).sort(), ["done", "running"]);
  });

  test("a running session's blocked wait shows; a running session with no wait does not", () => {
    const q = queue([open("a", 0, { stats: { waiting: wait("question", ago(MIN), "q1", "Which database?") } }), open("b", 0)]);
    assert.deepEqual(q.items.map((i) => i.primaryId), ["a"]);
    assert.match(q.items[0]!.reason, /asked you a question .*Which database\?/);
  });

  test("inside a bucket, the oldest wait comes first and the newest failure first", () => {
    const q = queue([
      open("b-new", MIN, { stats: { waiting: wait("permission", ago(MIN), "x") } }),
      open("b-old", 9 * MIN, { stats: { waiting: wait("permission", ago(9 * MIN), "y") } }),
      sess("f-old", 9 * MIN, { stats: { testsFailed: 1 } }),
      sess("f-new", MIN, { stats: { testsFailed: 3 } }),
    ]);
    assert.deepEqual(q.items.map((i) => i.primaryId), ["b-old", "b-new", "f-new", "f-old"]);
    assert.equal(q.items[2]!.cause?.failure, "3 failing tests");
  });

  test("a no-prompt agent's quiet session is stalled with a hint, and the header names it", () => {
    const q = queue([open("cx", STALL_MS + MIN, { agent: "codex" }), open("cc", STALL_MS + MIN)]);
    const cx = q.items.find((i) => i.primaryId === "cx")!;
    assert.equal(cx.bucket, "stalled");
    assert.match(cx.hint ?? "", /codex reports no prompts/);
    assert.equal(q.items.find((i) => i.primaryId === "cc")!.hint, undefined);
    assert.deepEqual(q.noPromptSignal, ["codex"]);
  });

  test("a session read from its transcript (an inferred end) that was active lately is running, not ready for review", () => {
    // Its endedAt is its last event, 30 s ago: no session.end was seen.
    const recent = (id: string, quiet: number) => sess(id, quiet + MIN, { endedAt: ago(quiet), stats: { filesChanged: 3, endInferred: true } });
    const q = queue([recent("live", 30e3)], { all: true });
    assert.equal(q.items[0]!.hidden, "running");
    assert.equal(q.items[0]!.running, true);
    assert.equal(q.counts.review, 0);
    assert.equal(queue([recent("old", INFERRED_RUNNING_MS + MIN)]).items[0]!.bucket, "review");
    const real = sess("real", 2 * MIN, { endedAt: ago(30e3), stats: { filesChanged: 3 } });
    assert.equal(queue([real]).items[0]!.bucket, "review", "a real end is finished at once");
    // A workflow whose newest child is still writing: the whole item is running.
    const root = sess("wf", 60 * MIN, { endedAt: ago(40 * MIN), stats: { filesChanged: 5, endInferred: true } });
    const child = recent("wf:sub:1", 26e3);
    child.parent = { sessionId: "wf" };
    assert.equal(queue([root, child], { all: true }).items[0]!.hidden, "running");
  });

  test("a transcript that stops on an unanswered tool call is running, then stalled, then probably closed", () => {
    // Read from its transcript only: no hooks, no session.end, the last line a tool call with no result.
    const tr = (quiet: number, idleMarker = false): Session => {
      const at = ago(quiet);
      const e = (kind: AgentEvent["kind"], ts: number, payload: Record<string, unknown> = {}): AgentEvent => ({ id: `${kind}${ts}`, v: 0, sessionId: "tr", ts, agent: "claude-code", kind, payload, source: "transcript", cwd: "/work/demo" });
      const events = [e("user.message", at - 2000, { text: "Add a sum function" }), e("tool.start", at, { tool: "Write", toolUseId: "toolu_1" })];
      if (idleMarker) events.push(e("session.end", at, { reason: "idle" }));
      return buildSession(events);
    };
    assert.equal(queue([tr(MIN)], { all: true }).items[0]!.hidden, "running");
    const stalled = queue([tr(20 * MIN)]).items[0]!;
    assert.equal(stalled.bucket, "stalled");
    assert.match(stalled.reason, /^quiet for 20m mid-turn/);
    assert.equal(stalled.next, "check claude-code in /work/demo");
    const closed = queue([tr(40 * 3600e3, true)]).items[0]!;
    assert.equal(closed.bucket, "stalled");
    assert.equal(closed.probablyClosed, true);
    assert.match(closed.next, /^probably closed: resume with `claude --resume tr`/);
  });

  test("a T3 Code thread running Claude Code that reports a permission prompt is not named as having no prompt signal", () => {
    const t3cc = open("t3cc", 2 * MIN, { agent: "t3code", provider: "claude-code", stats: { waiting: wait("permission", ago(2 * MIN), "t1") } });
    const q = queue([t3cc]);
    assert.equal(q.items[0]!.bucket, "blocked");
    assert.deepEqual(q.noPromptSignal, []);
    const t3cx = open("t3cx", STALL_MS + MIN, { agent: "t3code", provider: "codex" });
    const q2 = queue([t3cx]);
    assert.deepEqual(q2.noPromptSignal, ["codex"]);
    assert.match(q2.items[0]!.hint ?? "", /^codex reports no prompts/);
    const lone = open("t3x", STALL_MS + MIN, { agent: "t3code" });
    assert.deepEqual(queue([lone]).noPromptSignal, ["t3code"]);
  });

  test("a wait older than 12 hours is probably closed, and says how to resume or ack", () => {
    const q = queue([open("old", PROBABLY_CLOSED_MS + MIN, { stats: { waiting: wait("turn", ago(PROBABLY_CLOSED_MS + MIN)) } })]);
    const i = q.items[0]!;
    assert.equal(i.probablyClosed, true);
    assert.equal(i.next, `probably closed: resume with \`claude --resume old\`, or \`coding.sh work ack ${i.id}\``);
  });

  test("failed items with the same API cause are grouped", () => {
    const failed = (id: string) => sess(id, MIN, { flags: [FLAGS.apiStall], stats: { llmErrors: { count: 2, statusCode: 529 } as never } });
    const q = queue([failed("a"), failed("b"), sess("c", MIN, { flags: [FLAGS.apiStall] })]);
    assert.equal(q.groups.length, 1, "api error (no status code) is a cause of its own, with one item");
    const [g] = q.groups;
    assert.deepEqual({ ...g, items: [...g!.items].sort() }, { bucket: "failed", cause: "api 529", count: 2, items: [workItemId("a"), workItemId("b")].sort() });
  });
});

describe("items", () => {
  test("subagents fold into their root; the root's id is stable and does not depend on the members", () => {
    const root = open("root", MIN);
    const sub = open("root:sub:a1", MIN, { parent: { sessionId: "root", subagentId: "a1" }, stats: { waiting: wait("permission", ago(MIN), "t9") } });
    const q = queue([root, sub]);
    assert.equal(q.items.length, 1);
    const i = q.items[0]!;
    assert.equal(i.id, workItemId("root"));
    assert.equal(i.bucket, "blocked");
    assert.deepEqual(i.sessionIds, ["root", "root:sub:a1"]);
    assert.equal(i.cause?.sessionId, "root:sub:a1");
    assert.match(i.id, /^w[0-9a-f]{6}$/);
    assert.equal(queue([root]).items.length, 0, "the root alone is running and hidden");
    assert.equal(queue([root], { all: true }).items[0]!.id, i.id);
  });

  test("agents of a workflow whose root is not stored form one item keyed by the missing root", () => {
    const a = sess("w:sub:1", 3 * MIN, { parent: { sessionId: "w" }, stats: { filesChanged: 1 } });
    const b = sess("w:sub:2", 2 * MIN, { parent: { sessionId: "w" } });
    const [item] = groupWorkItems([a, b]);
    assert.equal(item!.rootId, "w");
    const q = queue([a, b]);
    assert.equal(q.items[0]!.id, workItemId("w"));
    assert.equal(q.items[0]!.primaryId, "w:sub:1");
  });

  test("a harness child or a host thread is its own item, started by its parent's item", () => {
    const orch = sess("orch", 5 * MIN);
    const child = sess("child", 4 * MIN, { agent: "codex", parent: { sessionId: "orch", type: "harness" }, stats: { testsFailed: 1 } });
    const t3 = sess("t3", 3 * MIN, { agent: "t3code", parent: { sessionId: "orch" }, stats: { filesChanged: 1 } });
    const q = queue([orch, child, t3], { all: true });
    assert.equal(q.items.length, 3);
    assert.equal(q.items.find((i) => i.primaryId === "child")!.startedBy, workItemId("orch"));
    assert.equal(q.items.find((i) => i.primaryId === "t3")!.startedBy, workItemId("orch"));
  });

  test("the JSON form has ISO times and leaves out what is not set", () => {
    const q = queue([open("a", MIN, { stats: { waiting: wait("permission", ago(MIN), "t1") } })]);
    const j = workItemJson(q.items[0]!);
    assert.equal(j.since, new Date(ago(MIN)).toISOString());
    assert.deepEqual(j.waiting, { kind: "permission", at: new Date(ago(MIN)).toISOString(), toolUseId: "t1" });
    for (const k of ["hidden", "repo", "branch", "provider", "failure", "probablyClosed", "hint", "startedBy", "costUsd"]) assert.equal(k in j, false, k);
    const doc = workJson(q, { since: ago(7 * 86400e3), limit: 0 });
    assert.deepEqual(doc.items, []);
    assert.equal(doc.more, 1);
    assert.equal(doc.needYou, 1);
  });
});

describe("files", () => {
  let n = 0;
  const ev = (sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, o: Partial<AgentEvent> = {}): AgentEvent =>
    ({ id: `e${++n}`, v: 0, sessionId, ts: ago(10 * MIN) + n, agent: "claude-code", kind, payload, ...o }) as AgentEvent;
  const shell = (sid: string, id: string, command: string, end: Record<string, unknown> = { ok: true }) => [
    ev(sid, "tool.start", { tool: "Bash", toolUseId: id, input: { command } }),
    ev(sid, "tool.end", { tool: "Bash", toolUseId: id, ...end }),
  ];

  test("changedPaths keys file edits and shell writes as filesChanged does, and drops a stopped shell call", () => {
    const events = [
      ev("a", "file.change", { path: "/work/demo/src/x.ts" }),
      ev("a", "file.change", { path: "src/x.ts" }),
      ...shell("a", "t1", "echo hi > notes.txt"),
      ...shell("a", "t2", "echo no > stopped.txt", { ok: false, interrupted: true }),
    ];
    assert.deepEqual([...changedPaths(events, "/work/demo")].sort(), ["notes.txt", "src/x.ts"]);
  });

  test("work show's count is the number of distinct paths listed across the item's sessions", async () => {
    const events: Record<string, AgentEvent[]> = {
      root: [ev("root", "file.change", { path: "a.ts" }), ev("root", "file.change", { path: "b.ts" })],
      "root:sub:1": [ev("root:sub:1", "file.change", { path: "a.ts" }), ...shell("root:sub:1", "t3", "echo x > out.log")],
    };
    const root = sess("root", 5 * MIN, { stats: { filesChanged: 2 } });
    const sub = sess("root:sub:1", 4 * MIN, { parent: { sessionId: "root" }, stats: { filesChanged: 2 } });
    const item = queue([root, sub]).items[0]!;
    assert.equal(item.filesChanged, 4, "the queue sums the sessions' own counts");
    assert.match(item.reason, /with up to 4 files changed in 2 sessions$/);
    const index = { listEvents: async (id: string, o?: { kinds?: string[] }) => (events[id] ?? []).filter((e) => !o?.kinds || o.kinds.includes(e.kind)) };
    const files = await workFiles(index, item, [root, sub], NOW);
    assert.deepEqual(files.sort(), ["a.ts", "b.ts", "out.log"]);
    assert.equal(item.filesChanged, 3);
    assert.match(item.reason, /^finished \d+m ago with 3 files changed$/);
    const one = queue([sess("solo", 5 * MIN, { stats: { filesChanged: 1 } })]).items[0]!;
    assert.match(one.reason, /with 1 file changed$/);
  });
});

describe("filters", () => {
  test("by agent and by place", () => {
    const sessions = [
      sess("cc", MIN, { stats: { testsFailed: 1 }, cwd: "/work/demo" }),
      sess("cx", MIN, { agent: "codex", stats: { testsFailed: 1 }, cwd: "/work/other", repo: { root: "/work/other" } as never }),
    ];
    assert.deepEqual(queue(sessions, { agents: ["codex"] }).items.map((i) => i.primaryId), ["cx"]);
    assert.deepEqual(queue(sessions, { place: { name: "demo" } }).items.map((i) => i.primaryId), ["cc"]);
    assert.deepEqual(queue(sessions, { place: { path: "/work/other" } }).items.map((i) => i.primaryId), ["cx"]);
  });
});

describe("acks and snoozes", () => {
  test("acking one prompt hides it; the next prompt on the same session shows again", () => {
    const first = open("a", MIN, { stats: { waiting: wait("permission", ago(2 * MIN), "t1") } });
    const o = emptyOverlay();
    const cause = queue([first]).items[0]!.cause!;
    addAck(o, cause.sessionId, cause.fingerprint);
    const acked = queue([first], { overlay: o, all: true });
    assert.equal(acked.items[0]!.hidden, "acked");
    assert.equal(acked.counts.blocked, 0);
    const second = open("a", 0, { stats: { waiting: wait("permission", ago(MIN), "t2") } });
    assert.equal(queue([second], { overlay: o }).items[0]!.bucket, "blocked");
  });

  test("acking the top cause shows the next one", () => {
    const root = sess("root", 5 * MIN, { stats: { filesChanged: 1, testsFailed: 1 } });
    const o = emptyOverlay();
    const c = queue([root]).items[0]!.cause!;
    assert.equal(c.bucket, "failed");
    addAck(o, c.sessionId, c.fingerprint);
    assert.equal(queue([root], { overlay: o }).items[0]!.bucket, "review");
  });

  test("a snooze hides the item until it ends or a more urgent cause comes", () => {
    const review = sess("a", 5 * MIN, { stats: { filesChanged: 1 } });
    const o = emptyOverlay();
    addSnooze(o, ["a"], { until: NOW + 60 * MIN, bucket: "review" });
    assert.equal(queue([review], { overlay: o }).items.length, 0);
    assert.equal(queue([review], { overlay: o, all: true }).items[0]!.hidden, "snoozed");
    assert.equal(queue([review], { overlay: o, now: NOW + 61 * MIN }).items[0]!.bucket, "review");
    const failed = sess("a", 5 * MIN, { stats: { filesChanged: 1, testsFailed: 2 } });
    assert.equal(queue([failed], { overlay: o }).items[0]!.bucket, "failed");
  });

  test("a missing or corrupt overlay reads as empty; a written one reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-overlay-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "work.json");
    assert.deepEqual(readOverlay(path), emptyOverlay());
    writeFileSync(path, "{not json");
    assert.deepEqual(readOverlay(path), emptyOverlay());
    writeFileSync(path, JSON.stringify({ v: 1, acks: { a: ["x", 3], b: "no" }, snoozes: { a: { until: "soon", bucket: "review" }, b: { until: NOW + 1, bucket: "nope" }, c: { until: NOW + 1, bucket: "turn" } } }));
    assert.deepEqual(readOverlay(path), { v: 1, acks: { a: ["x"] }, snoozes: { c: { until: NOW + 1, bucket: "turn" } } });
    const o = emptyOverlay();
    addAck(o, "s", "review:s:1");
    addSnooze(o, ["s"], { until: NOW + MIN, bucket: "review" });
    addSnooze(o, ["gone"], { until: NOW - MIN, bucket: "review" });
    writeOverlay(path, o, NOW);
    assert.deepEqual(readOverlay(path), { v: 1, acks: { s: ["review:s:1"] }, snoozes: { s: { until: NOW + MIN, bucket: "review" } } });
    assert.match(readFileSync(path, "utf8"), /\n$/);
  });
});

test("BUCKETS is the documented order", () => {
  assert.deepEqual([...BUCKETS], ["blocked", "failed", "stalled", "turn", "review"]);
});
