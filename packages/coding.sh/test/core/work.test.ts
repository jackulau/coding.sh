// Work items (core/work.ts) and their acks and snoozes (core/work-overlay.ts): grouping by
// parent links, buckets and their order, acks by fingerprint, snoozes that a more urgent
// cause breaks, and the overlay file read tolerantly.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildSession, FLAGS } from "../../src/core/sessions.ts";
import { BUCKETS, buildWorkQueue, changedPaths, countsLine, groupWorkItems, INFERRED_RUNNING_MS, needYou, PROBABLY_CLOSED_MS, resumeCommand, selectBatchAckTargets, settleWorkFiles, STAGE_WHY_MAX, STAGES, stagesLine, STALL_MS, SUPERVISION_RISKS, WORK_KINDS, workFiles, workItemId, workItemJson, workJson, workStage } from "../../src/core/work.ts";
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
    const q = queue([open("cx", STALL_MS + MIN, { agent: "codex" }), open("cc", STALL_MS + MIN), open("dv", STALL_MS + MIN, { agent: "devin" })]);
    const cx = q.items.find((i) => i.primaryId === "cx")!;
    assert.equal(cx.bucket, "stalled");
    assert.match(cx.hint ?? "", /codex reports no prompts/);
    assert.equal(q.items.find((i) => i.primaryId === "cc")!.hint, undefined);
    // Devin CLI's PermissionRequest hook reports its prompts.
    assert.equal(q.items.find((i) => i.primaryId === "dv")!.hint, undefined);
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

  test("T3 Code reports its threads' prompts (its store's requests), whatever agent a thread runs", () => {
    const t3cc = open("t3cc", 2 * MIN, { agent: "t3code", provider: "claude-code", stats: { waiting: wait("permission", ago(2 * MIN), "t1") } });
    const q = queue([t3cc]);
    assert.equal(q.items[0]!.bucket, "blocked");
    assert.deepEqual(q.noPromptSignal, []);
    // A quiet T3 thread running Codex is stalled with no hint: T3's store would have shown a pending approval.
    const t3cx = open("t3cx", STALL_MS + MIN, { agent: "t3code", provider: "codex" });
    const q2 = queue([t3cx]);
    assert.equal(q2.items[0]!.bucket, "stalled");
    assert.deepEqual(q2.noPromptSignal, []);
    assert.equal(q2.items[0]!.hint, undefined);
    const lone = open("t3x", STALL_MS + MIN, { agent: "t3code" });
    assert.deepEqual(queue([lone]).noPromptSignal, []);
    // A Codex session T3 did not run still has no prompt signal, beside a T3 thread running Codex.
    const q3 = queue([t3cx, open("cx", STALL_MS + MIN, { agent: "codex" })]);
    assert.deepEqual(q3.noPromptSignal, ["codex"]);
    assert.match(q3.items.find((i) => i.primaryId === "cx")!.hint ?? "", /^codex reports no prompts/);
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
    writeFileSync(path, JSON.stringify({ v: 1, acks: { a: ["x", 3], b: "no" }, snoozes: { a: { until: "soon", bucket: "review" }, b: { until: NOW + 1, bucket: "nope" }, c: { until: NOW + 1, bucket: "turn" }, d: { until: NOW + 1, bucket: "turn", item: 7 } } }));
    assert.deepEqual(readOverlay(path), { v: 1, acks: { a: ["x"] }, snoozes: { c: { until: NOW + 1, bucket: "turn" }, d: { until: NOW + 1, bucket: "turn" } } });
    const o = emptyOverlay();
    addAck(o, "s", "review:s:1");
    addSnooze(o, ["s"], { until: NOW + MIN, bucket: "review" });
    addSnooze(o, ["t"], { until: NOW + MIN, bucket: "stalled", item: "w1a2b3c" });
    addSnooze(o, ["gone"], { until: NOW - MIN, bucket: "review" });
    writeOverlay(path, o, NOW);
    assert.deepEqual(readOverlay(path), { v: 1, acks: { s: ["review:s:1"] }, snoozes: { s: { until: NOW + MIN, bucket: "review" }, t: { until: NOW + MIN, bucket: "stalled", item: "w1a2b3c" } } });
    assert.match(readFileSync(path, "utf8"), /\n$/);
  });
});

describe("stages and kinds", () => {
  const one = (sessions: Session[], opts: Parameters<typeof buildWorkQueue>[1] = {}) => queue(sessions, { all: true, ...opts }).items[0]!;
  const stageOf = (i: { stage: string; kind?: string }) => [i.stage, i.kind];

  test("approval: a member waits on a permission, a question or a plan, running or not", () => {
    const i = one([open("a", MIN, { stats: { waiting: wait("permission", ago(2 * MIN), "t1", "Claude needs your permission to use Bash") } })]);
    assert.deepEqual(stageOf(i), ["approval", undefined]);
    assert.equal(i.stageWhy, "waits 2m for permission: Claude needs your permission to use Bash");
    // A subagent's question makes the whole item wait; files already changed make it a change.
    const root = open("root", MIN, { stats: { filesChanged: 2 } });
    const sub = open("root:sub:1", MIN, { parent: { sessionId: "root" }, stats: { waiting: wait("question", ago(MIN), "q1") } });
    const j = one([root, sub]);
    assert.deepEqual(stageOf(j), ["approval", "change"]);
    assert.equal(j.stageWhy, "waits 1m for an answer");
    assert.deepEqual(stageOf(one([sess("p", 3 * MIN, { stats: { waiting: wait("plan", ago(3 * MIN), "x") } })])), ["approval", undefined]);
  });

  test("an acked blocked item stays approval: the agent still waits", () => {
    const s = open("a", MIN, { stats: { waiting: wait("permission", ago(2 * MIN), "t1") } });
    const o = emptyOverlay();
    const c = one([s]).cause!;
    addAck(o, c.sessionId, c.fingerprint);
    const i = one([s], { overlay: o });
    assert.equal(i.hidden, "acked");
    assert.equal(i.stage, "approval");
  });

  test("executing: running or stalled, and a member changed a file or ran tests", () => {
    const i = one([open("a", MIN, { stats: { filesChanged: 3 } })]);
    assert.deepEqual(stageOf(i), ["executing", "change"]);
    assert.equal(i.stageWhy, "running 2m, changed 3 files");
    const tests = one([open("t", MIN, { stats: { testsPassed: 4, testsFailed: 2 } })]);
    assert.deepEqual(stageOf(tests), ["executing", undefined], "tests ran, but no file changed: the kind is not known yet");
    assert.equal(tests.stageWhy, "running 2m, tests: 4 passed, 2 failed");
    const stalled = one([open("s", STALL_MS + MIN, { agent: "codex", stats: { filesChanged: 1 } })]);
    assert.equal(stalled.bucket, "stalled");
    assert.deepEqual(stageOf(stalled), ["executing", "change"]);
    assert.equal(stalled.stageWhy, "quiet 16m, changed 1 file");
    // A finished root with a running subagent that changed a file is still executing.
    const root = sess("r", 10 * MIN);
    const sub = open("r:sub:1", MIN, { parent: { sessionId: "r" }, stats: { filesChanged: 1 } });
    assert.equal(one([root, sub]).stage, "executing");
  });

  test("planning: running or stalled with no file changed and no tests run", () => {
    const i = one([open("a", MIN)]);
    assert.deepEqual(stageOf(i), ["planning", undefined]);
    assert.equal(i.stageWhy, "running 2m, no file changed yet");
    assert.equal(one([open("s", STALL_MS + MIN, { agent: "codex" })]).stage, "planning");
    assert.equal("kind" in workItemJson(i), false, "the kind is absent while it is not known");
  });

  test("review: stopped with changed files, a failure, or the person's turn", () => {
    const changed = one([sess("c", 13 * MIN, { stats: { filesChanged: 3 } })]);
    assert.deepEqual(stageOf(changed), ["review", "change"]);
    assert.equal(changed.stageWhy, "changed 3 files, last active 12m ago");
    const tests = one([sess("t", 5 * MIN, { stats: { testsFailed: 2 } })]);
    assert.deepEqual(stageOf(tests), ["review", "research"]);
    assert.equal(tests.stageWhy, "tests: 2 failed, last active 4m ago");
    const turn = one([open("u", 5 * MIN, { stats: { waiting: wait("turn", ago(5 * MIN)) } })]);
    assert.equal(turn.bucket, "turn");
    assert.deepEqual(stageOf(turn), ["review", "research"]);
    assert.equal(turn.stageWhy, "your turn for 5m");
  });

  test("a failed item with no change is review, with kind research", () => {
    const i = one([sess("f", 2 * MIN, { flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } as never } })]);
    assert.equal(i.bucket, "failed");
    assert.deepEqual(stageOf(i), ["review", "research"]);
    assert.equal(i.stageWhy, "api 529, last active 1m ago");
  });

  test("with two sessions, the failed reason names whose end it times and the stage the item's last activity", () => {
    // From QA: the main session ended 6h ago on API errors, and its child worked on until 4h ago.
    const H = 60 * MIN;
    const main = sess("m", 8 * H, { endedAt: ago(6 * H), flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } as never } });
    const child = sess("m:sub:1", 5 * H, { endedAt: ago(4 * H), parent: { sessionId: "m" } });
    const i = one([main, child]);
    assert.deepEqual([i.bucket, i.sessionIds.length], ["failed", 2]);
    assert.equal(i.reason, "main session ended 6h ago on api 529");
    assert.equal(i.stageWhy, "api 529, last active 4h ago");
    // One session has no other to tell it from.
    assert.equal(one([main]).reason, "ended 6h ago on api 529");
  });

  test("an acked review item becomes done; acking only the failure leaves it in review", () => {
    const s = sess("a", 5 * MIN, { stats: { filesChanged: 1, testsFailed: 1 } });
    const o = emptyOverlay();
    const failed = one([s]).cause!;
    addAck(o, failed.sessionId, failed.fingerprint);
    const half = one([s], { overlay: o });
    assert.deepEqual([half.bucket, half.stage], ["review", "review"]);
    addAck(o, half.cause!.sessionId, half.cause!.fingerprint);
    const done = one([s], { overlay: o });
    assert.equal(done.hidden, "acked");
    assert.deepEqual(stageOf(done), ["done", "change"]);
    assert.equal(done.stageWhy, "acknowledged: tests: 1 failed, changed 1 file, last active 4m ago");
  });

  test("a snoozed review item stays review", () => {
    const s = sess("a", 5 * MIN, { stats: { filesChanged: 1 } });
    const o = emptyOverlay();
    addSnooze(o, ["a"], { until: NOW + 60 * MIN, bucket: "review" });
    const i = one([s], { overlay: o });
    assert.equal(i.hidden, "snoozed");
    assert.equal(i.stage, "review");
  });

  test("done: stopped with nothing to look at", () => {
    const i = one([sess("d", 5 * MIN)]);
    assert.equal(i.hidden, "done");
    assert.deepEqual(stageOf(i), ["done", "research"]);
    assert.equal(i.stageWhy, "last active 4m ago, no file changed");
    assert.equal(one([sess("p", 5 * MIN, { stats: { testsPassed: 6 } })]).stageWhy, "tests: 6 passed, last active 4m ago");
  });

  test("stages count every item in the window, hidden ones included; the stage filter lists hidden items", () => {
    const sessions = [sess("review", 3 * MIN, { stats: { filesChanged: 2 } }), sess("done", 4 * MIN), open("running", MIN, { stats: { filesChanged: 1 } }), open("plan", MIN)];
    const q = queue(sessions);
    assert.deepEqual(q.items.map((i) => i.primaryId), ["review"]);
    assert.deepEqual(q.stages, { planning: 1, executing: 1, review: 1, approval: 0, done: 1 });
    assert.deepEqual(workJson(q, { since: 0, limit: 20 }).stages, q.stages);
    assert.equal(stagesLine(q.stages), "1 planning · 1 executing · 1 review · 1 done");
    assert.equal(stagesLine({ planning: 0, executing: 0, review: 0, approval: 0, done: 0 }), "no items");
    assert.deepEqual(queue(sessions, { stages: ["done"] }).items.map((i) => i.primaryId), ["done"]);
    assert.deepEqual(queue(sessions, { stages: ["executing", "planning"] }).items.map((i) => i.primaryId).sort(), ["plan", "running"]);
    const j = workItemJson(q.items[0]!);
    assert.deepEqual([j.stage, j.kind, j.stageWhy], ["review", "change", "changed 2 files, last active 2m ago"]);
  });

  test("stageWhy stays short, and work show's distinct file count replaces the sum", async () => {
    const long = "x".repeat(300);
    const i = one([open("a", MIN, { stats: { waiting: wait("permission", ago(MIN), "t1", long) } })]);
    assert.equal(i.stageWhy.length, STAGE_WHY_MAX);
    assert.match(i.stageWhy, /…$/);
    const root = sess("root", 5 * MIN, { stats: { filesChanged: 2 } });
    const sub = sess("root:sub:1", 4 * MIN, { parent: { sessionId: "root" }, stats: { filesChanged: 2 } });
    const item = queue([root, sub]).items[0]!;
    assert.match(item.stageWhy, /^changed 4 files/);
    const ev = (sessionId: string, path: string) => ({ id: `${sessionId}${path}`, v: 0, sessionId, ts: ago(4 * MIN), agent: "claude-code", kind: "file.change", payload: { path } }) as AgentEvent;
    const events: Record<string, AgentEvent[]> = { root: [ev("root", "a.ts"), ev("root", "b.ts")], "root:sub:1": [ev("root:sub:1", "a.ts"), ev("root:sub:1", "c.ts")] };
    await workFiles({ listEvents: async (id: string) => events[id] ?? [] }, item, [root, sub], NOW);
    assert.match(item.stageWhy, /^changed 3 files, last active/);
  });

  test("workStage reads only the sessions and causes it is given", () => {
    const s = sess("a", 5 * MIN, { stats: { filesChanged: 1 } });
    assert.deepEqual(workStage([s], s, NOW), { stage: "review", kind: "change", why: "changed 1 file, last active 4m ago" });
    assert.equal(workStage([s], s, NOW, undefined, () => true).stage, "done");
    // A long failure is cut to make room; the file count and the age after it are never cut.
    const big = sess("b", 5 * MIN, { stats: { filesChanged: 73 } });
    const failure = "3 failed agents (4 failing tests, 12 failing tests, 2 failing tests)";
    const why = workStage([big], big, NOW, [{ bucket: "failed", sessionId: "b", at: ago(4 * MIN), fingerprint: "f", failure }]).why;
    assert.match(why, /…, changed 73 files, last active 4m ago$/);
    assert.ok(why.length <= STAGE_WHY_MAX, why);
    assert.deepEqual([...STAGES],["planning", "executing", "review", "approval", "done"]);
  });
});

test("BUCKETS is the documented order", () => {
  assert.deepEqual([...BUCKETS], ["blocked", "failed", "stalled", "turn", "review"]);
});

describe("a worktree nested in its repo", () => {
  const repo = (root: string, branch: string) => ({ root, head: "", branch }) as never;
  const fc = (sessionId: string, path: string) => ({ id: `${sessionId}${path}`, v: 0, sessionId, ts: ago(4 * MIN), agent: "claude-code", kind: "file.change", payload: { path } }) as AgentEvent;

  test("a review item whose files are all outside its repo names them, not an empty git diff", async () => {
    const agent = sess("out", 5 * MIN, { cwd: "C:/work/demo", repo: repo("C:/work/demo", "main"), stats: { filesChanged: 1 } });
    const item = queue([agent]).items[0]!;
    assert.match(item.next, /git -C C:\/work\/demo diff/);
    const events: Record<string, AgentEvent[]> = { out: [fc("out", "C:/home/user/.tool/state.json")] };
    await workFiles({ listEvents: async (id: string) => events[id] ?? [] }, item, [agent], NOW);
    assert.equal(item.next, "review: `C:/home/user/.tool/state.json` (outside C:/work/demo), then `coding.sh work ack " + item.id + "`");
    // One file inside the repo keeps the diff.
    const inside = queue([agent]).items[0]!;
    await workFiles({ listEvents: async () => [fc("out", "src/a.ts"), fc("out", "C:/home/user/.tool/state.json")] }, inside, [agent], NOW);
    assert.match(inside.next, /git -C C:\/work\/demo diff/);
  });

  test("settleWorkFiles gives the list the review step work show gives: a single-session item names its outside files", async () => {
    const agent = sess("out", 5 * MIN, { cwd: "C:/work/demo", repo: repo("C:/work/demo", "main"), stats: { filesChanged: 1 } });
    const listed = queue([agent]).items[0]!;
    const shown = queue([agent]).items[0]!;
    const read = { listEvents: async () => [fc("out", "C:/home/user/.tool/state.json")] };
    await settleWorkFiles(read, [listed], [agent], NOW);
    await workFiles(read, shown, [agent], NOW);
    assert.equal(listed.next, shown.next);
    assert.match(listed.next, /outside C:\/work\/demo/);
    assert.equal(listed.filesChanged, shown.filesChanged);
  });

  test("names the worktree and diffs it when its branch is not the main checkout's", async () => {
    const wt = "C:/work/demo/data/worktrees/fix-ui";
    const main = sess("main", 30 * MIN, { cwd: "C:/work/demo", repo: repo("C:/work/demo", "main") });
    const agent = sess("wt", 5 * MIN, { cwd: wt, repo: repo("C:/work/demo", "improve/fix-ui"), stats: { filesChanged: 2 } });
    const item = queue([main, agent]).items.find((i) => i.primaryId === "wt")!;
    assert.equal(item.repo, wt);
    assert.equal(item.next, "review: `git -C C:/work/demo/data/worktrees/fix-ui diff`, then `coding.sh work ack " + item.id + "`");
    // One path base: a path written outside the worktree makes every path absolute.
    const events: Record<string, AgentEvent[]> = { wt: [fc("wt", "src/ui.ts"), fc("wt", "C:/work/demo/notes/ui.md")] };
    const files = await workFiles({ listEvents: async (id: string) => events[id] ?? [] }, item, [main, agent], NOW);
    assert.deepEqual(files.sort(), ["C:/work/demo/data/worktrees/fix-ui/src/ui.ts", "C:/work/demo/notes/ui.md"]);
  });

  test("a subfolder on the main checkout's branch keeps the repo root", () => {
    const main = sess("main", 30 * MIN, { cwd: "/work/demo", repo: repo("/work/demo", "main") });
    const sub = sess("sub", 5 * MIN, { cwd: "/work/demo/packages/app", repo: repo("/work/demo", "main"), stats: { filesChanged: 1 } });
    const alone = sess("alone", 5 * MIN, { cwd: "/work/other/data/wt", repo: repo("/work/other", "feature"), stats: { filesChanged: 1 } });
    const items = queue([main, sub, alone]).items;
    assert.equal(items.find((i) => i.primaryId === "sub")!.repo, "/work/demo");
    // With no session at the root to compare branches with, the root stays.
    assert.equal(items.find((i) => i.primaryId === "alone")!.repo, "/work/other");
  });

  test("the review git -C step quotes repo paths with spaces or shell metacharacters and leaves plain paths unquoted", () => {
    const plain = queue([sess("plain", 5 * MIN, { cwd: "/work/demo", repo: repo("/work/demo", "main"), stats: { filesChanged: 1 } })]).items[0]!;
    assert.equal(plain.next, `review: \`git -C /work/demo diff\`, then \`coding.sh work ack ${plain.id}\``);
    const spaced = queue([sess("spaced", 5 * MIN, { cwd: "/work/my repo", repo: repo("/work/my repo", "main"), stats: { filesChanged: 1 } })]).items[0]!;
    assert.equal(spaced.next, `review: \`git -C '/work/my repo' diff\`, then \`coding.sh work ack ${spaced.id}\``);
    const meta = queue([sess("meta", 5 * MIN, { cwd: "/work/a;b $(id)", repo: repo("/work/a;b $(id)", "main"), stats: { filesChanged: 1 } })]).items[0]!;
    assert.equal(meta.next, `review: \`git -C '/work/a;b $(id)' diff\`, then \`coding.sh work ack ${meta.id}\``);
    const quoted = queue([sess("quoted", 5 * MIN, { cwd: "/work/it's", repo: repo("/work/it's", "main"), stats: { filesChanged: 1 } })]).items[0]!;
    assert.equal(quoted.next, `review: \`git -C '/work/it'\\''s' diff\`, then \`coding.sh work ack ${quoted.id}\``);
  });
});

test("a subagent's resume step names the session Claude Code can resume, not coding.sh's child id", () => {
  assert.equal(resumeCommand({ id: "1f2e3d4c-0000-4000-8000-000000000001:sub:a7e2b9c4d1f8a3e65", agent: "claude-code" }), "claude --resume 1f2e3d4c-0000-4000-8000-000000000001");
  assert.equal(resumeCommand({ id: "thr:sub:x", agent: "codex" }), "codex resume thr");
});

describe("high-scale filters and batch ack selection", () => {
  const HOUR = 60 * MIN;
  const repo = (root: string, branch: string) => ({ root, head: "", branch }) as never;

  function scaleSessions(): Session[] {
    const list: Session[] = [];
    // 4 blocked (2 recent change, 2 probably closed no-change)
    for (let i = 1; i <= 2; i++) {
      list.push(
        open(`blk-chg-${i}`, 2 * MIN, {
          cwd: "/work/app",
          repo: repo("/work/app", `feat/blk-${i}`),
          title: `approve deploy ${i}`,
          stats: { filesChanged: 1, waiting: wait("permission", ago(3 * MIN), `t-${i}`, "Allow Bash deploy") },
        }),
      );
      list.push(
        open(`blk-old-${i}`, 15 * HOUR, {
          cwd: "/work/old",
          repo: repo("/work/old", "main"),
          title: `stale wait ${i}`,
          stats: { waiting: wait("question", ago(14 * HOUR), `q-${i}`, "Which region?") },
        }),
      );
    }
    // 4 api 529 failed (research) + 2 failing tests (change) + 1 workflow run (failed)
    for (let i = 1; i <= 4; i++) {
      list.push(
        sess(`api529-${i}`, (10 + i) * MIN, {
          cwd: "/work/api",
          repo: repo("/work/api", `fix/rate-${i}`),
          title: `api worker ${i}`,
          flags: [FLAGS.apiStall],
          stats: { llmErrors: { count: 3, statusCode: 529 } as never },
        }),
      );
    }
    for (let i = 1; i <= 2; i++) {
      list.push(
        sess(`tfail-${i}`, (20 + i) * MIN, {
          cwd: "/work/api",
          repo: repo("/work/api", `fix/tests-${i}`),
          title: `unit suite ${i}`,
          stats: { filesChanged: 2, testsFailed: 2 },
        }),
      );
    }
    list.push(
      sess("wf-1", 30 * MIN, {
        cwd: "/work/api",
        parent: { sessionId: "orch-root", workflowId: "run-99", workflowName: "Release Sweep", phase: "verify" },
        stats: { testsFailed: 1 },
      }),
      sess("wf-2", 30 * MIN, {
        cwd: "/work/api",
        parent: { sessionId: "orch-root", workflowId: "run-99", workflowName: "Release Sweep", phase: "verify" },
      }),
    );
    // 2 stalled + 2 turn + 8 review (change) + 6 done (research) = 29 items total
    for (let i = 1; i <= 2; i++) {
      list.push(open(`stall-${i}`, STALL_MS + (5 + i) * MIN, { agent: "codex", cwd: "/work/infra", title: `infra sync ${i}` }));
      list.push(open(`turn-${i}`, (5 + i) * MIN, { cwd: "/work/docs", title: `draft rfc ${i}`, stats: { waiting: wait("turn", ago((4 + i) * MIN)) } }));
    }
    for (let i = 1; i <= 8; i++) {
      list.push(
        sess(`rev-${i}`, (40 + i) * MIN, {
          cwd: "/work/app",
          repo: repo("/work/app", `feat/pr-${i}`),
          title: `refactor module ${i}`,
          stats: { filesChanged: i },
        }),
      );
    }
    for (let i = 1; i <= 6; i++) {
      list.push(sess(`done-${i}`, (60 + i) * MIN, { cwd: "/work/docs", title: `notes ${i}` }));
    }
    return list;
  }

  test("kinds, buckets and q filter across 29 concurrent items consistently", () => {
    const sessions = scaleSessions();
    assert.deepEqual([...WORK_KINDS], ["research", "change"]);

    const changes = queue(sessions, { kinds: ["change"] });
    assert.equal(changes.items.length, 12, "2 blocked + 2 failed + 8 review changes");
    assert.ok(changes.items.every((i) => i.kind === "change"));
    assert.equal(changes.counts.blocked, 2);
    assert.equal(changes.counts.failed, 2);
    assert.equal(changes.counts.review, 8);
    assert.equal(changes.hidden, 0);

    const research = queue(sessions, { kinds: ["research"], all: true });
    assert.equal(research.items.length, 13, "4 api529 + 1 workflow + 2 turn + 6 done research");
    assert.ok(research.items.every((i) => i.kind === "research"));
    assert.equal(research.hidden, 6);

    const failedOnly = queue(sessions, { buckets: ["failed"] });
    assert.equal(failedOnly.items.length, 7);
    assert.ok(failedOnly.items.every((i) => i.bucket === "failed"));
    assert.equal(failedOnly.groups.length, 1);
    assert.equal(failedOnly.groups[0]!.cause, "api 529");

    const blockedOnly = queue(sessions, { buckets: ["blocked"] });
    assert.equal(blockedOnly.items.length, 4);
    assert.deepEqual(blockedOnly.groups, [], "failed API groups are omitted when failed bucket is excluded");

    // q matches title, repo, branch, id, primaryId, workflow.name and reason (trimmed, case-insensitive).
    assert.equal(queue(sessions, { q: "  RELEASE SWEEP " }).items.length, 1, "matches workflow.name");
    assert.equal(queue(sessions, { q: "feat/pr-7" }).items.length, 1, "matches branch");
    assert.equal(queue(sessions, { q: "/work/app" }).items.length, 10, "matches repo");
    assert.equal(queue(sessions, { q: workItemId("rev-3").toUpperCase() }).items.length, 1, "matches id");
    assert.equal(queue(sessions, { q: "TFAIL-2" }).items.length, 1, "matches primaryId");
    assert.equal(queue(sessions, { q: "ALLOW BASH DEPLOY" }).items.length, 2, "matches reason");
  });

  test("selectBatchAckTargets selects probablyClosed, group, bucket, ids and ignores empty selectors", () => {
    const q = queue(scaleSessions(), { all: true });
    assert.deepEqual(selectBatchAckTargets(q.items, {}), []);
    assert.deepEqual(selectBatchAckTargets(q.items, { probablyClosed: false }), []);

    const closed = selectBatchAckTargets(q.items, { probablyClosed: true });
    assert.deepEqual(closed.map((i) => i.primaryId).sort(), ["blk-old-1", "blk-old-2"]);

    const byGroup = selectBatchAckTargets(q.items, { group: "api 529" });
    assert.equal(byGroup.length, 4);
    const byGroupLabel = selectBatchAckTargets(q.items, { group: "  API 529 x4 " });
    assert.deepEqual(byGroupLabel.map((i) => i.id), byGroup.map((i) => i.id));

    const oneFp = byGroup[0]!.cause!.fingerprint;
    assert.deepEqual(selectBatchAckTargets(q.items, { group: oneFp }).map((i) => i.id), [byGroup[0]!.id]);

    const reviewBucket = selectBatchAckTargets(q.items, { bucket: "review" });
    assert.equal(reviewBucket.length, 8);
    assert.ok(reviewBucket.every((i) => i.bucket === "review" && i.cause !== undefined));

    // Combined narrowing: bucket + probablyClosed.
    assert.equal(selectBatchAckTargets(q.items, { bucket: "failed", probablyClosed: true }).length, 0);
    assert.equal(selectBatchAckTargets(q.items, { bucket: "blocked", probablyClosed: true }).length, 2);

    // Explicit ids ignore hidden items that have no ackable cause.
    const picked = selectBatchAckTargets(q.items, { ids: [workItemId("rev-1"), workItemId("done-1")] });
    assert.deepEqual(picked.map((i) => i.id), [workItemId("rev-1")]);
  });
});

describe("supervision risk and proof status", () => {
  test("aggregates supervisionRisk, riskReasons, and proof across single and multi-session items, omitted when absent", () => {
    assert.deepEqual([...SUPERVISION_RISKS], ["medium", "high"]);
    const clean = sess("clean", 10 * MIN, { title: "plain change", stats: { filesChanged: 1 } });
    const single = sess("single-proof", 8 * MIN, {
      title: "verify lemma",
      stats: {
        filesChanged: 1,
        contextHygiene: { supervisionRisk: "medium", riskReasons: ["unverified-edits"] },
        verification: {
          checks: 2,
          passed: 2,
          failed: 0,
          maxUnverifiedEdits: 1,
          proof: { langs: ["lean"], checks: 2, passed: 2, failed: 0 },
        },
      },
    });
    const parent = sess("multi-root", 15 * MIN, {
      title: "prove theorem",
      stats: {
        filesChanged: 2,
        contextHygiene: { supervisionRisk: "medium", riskReasons: ["unverified-edits", "compaction-churn"] },
        verification: {
          checks: 2,
          passed: 1,
          failed: 1,
          maxUnverifiedEdits: 3,
          proof: { langs: ["lean"], checks: 2, passed: 1, failed: 1, escapeRemaining: 2 },
        },
      },
    });
    const child = sess("multi-root:sub:1", 12 * MIN, {
      parent: { sessionId: "multi-root", subagentId: "1" },
      stats: {
        contextHygiene: { supervisionRisk: "high", riskReasons: ["tactic-oscillation", "unverified-edits"] },
        verification: {
          checks: 1,
          passed: 1,
          failed: 0,
          maxUnverifiedEdits: 0,
          proof: { langs: ["rocq", "lean"], checks: 1, passed: 1, failed: 0, oscillatingChecks: 1 },
        },
      },
    });

    const q = queue([clean, single, parent, child]);
    const byId = new Map(q.items.map((i) => [i.primaryId, i]));

    const cleanItem = byId.get("clean")!;
    assert.equal(cleanItem.supervisionRisk, undefined);
    assert.equal(cleanItem.riskReasons, undefined);
    assert.equal(cleanItem.proof, undefined);
    const cleanJson = workItemJson(cleanItem);
    assert.equal("supervisionRisk" in cleanJson, false);
    assert.equal("riskReasons" in cleanJson, false);
    assert.equal("proof" in cleanJson, false);

    const singleItem = byId.get("single-proof")!;
    assert.equal(singleItem.supervisionRisk, "medium");
    assert.deepEqual(singleItem.riskReasons, ["unverified-edits"]);
    assert.deepEqual(singleItem.proof, { langs: ["lean"], checks: 2, passed: 2, failed: 0 });
    const singleJson = workItemJson(singleItem);
    assert.equal("escapeRemaining" in (singleJson.proof as Record<string, unknown>), false);
    assert.equal("oscillatingChecks" in (singleJson.proof as Record<string, unknown>), false);

    const multiItem = byId.get("multi-root")!;
    assert.equal(multiItem.supervisionRisk, "high");
    assert.deepEqual(multiItem.riskReasons, ["compaction-churn", "tactic-oscillation", "unverified-edits"]);
    assert.deepEqual(multiItem.proof, {
      langs: ["lean", "rocq"],
      checks: 3,
      passed: 2,
      failed: 1,
      escapeRemaining: 2,
      oscillatingChecks: 1,
    });
    const multiJson = workItemJson(multiItem);
    assert.equal(multiJson.supervisionRisk, "high");
    assert.deepEqual(multiJson.riskReasons, ["compaction-churn", "tactic-oscillation", "unverified-edits"]);
    assert.deepEqual(multiJson.proof, multiItem.proof);
  });

  test("risks filter surfaces still-running high/medium risk sessions while keeping default unfiltered queue unchanged", () => {
    const runningHigh = open("run-high", 2 * MIN, {
      title: "long horizon drift",
      stats: {
        filesChanged: 3,
        contextHygiene: { supervisionRisk: "high", riskReasons: ["post-compaction-repeats", "unverified-edits"] },
      },
    });
    const runningClean = open("run-clean", 2 * MIN, { title: "steady work" });
    const failedMed = sess("fail-med", 10 * MIN, {
      title: "failing suite",
      stats: {
        testsFailed: 2,
        contextHygiene: { supervisionRisk: "medium", riskReasons: ["dead-end-loop"] },
      },
    });
    const reviewHigh = sess("rev-high", 15 * MIN, {
      title: "risky review",
      stats: {
        filesChanged: 1,
        contextHygiene: { supervisionRisk: "high", riskReasons: ["unverified-edits"] },
      },
    });
    const doneHigh = sess("done-high", 20 * MIN, {
      title: "done research",
      stats: { contextHygiene: { supervisionRisk: "high", riskReasons: ["compaction-churn"] } },
    });
    const all = [runningHigh, runningClean, failedMed, reviewHigh, doneHigh];

    // Default unfiltered queue hides runningHigh and doneHigh.
    const def = queue(all);
    assert.deepEqual(def.items.map((i) => i.primaryId).sort(), ["fail-med", "rev-high"]);

    // risks: ["high"] surfaces still-running high-risk item alongside active high-risk items, leaving done hidden.
    const highOnly = queue(all, { risks: ["high"] });
    assert.deepEqual(highOnly.items.map((i) => i.primaryId).sort(), ["rev-high", "run-high"]);
    assert.equal(highOnly.items.find((i) => i.primaryId === "run-high")!.hidden, "running");

    // risks: ["medium", "high"] includes medium active + high active + high running.
    const medPlus = queue(all, { risks: ["medium", "high"] });
    assert.deepEqual(medPlus.items.map((i) => i.primaryId).sort(), ["fail-med", "rev-high", "run-high"]);

    // With all: true, doneHigh is also included.
    const highAll = queue(all, { risks: ["high"], all: true });
    assert.deepEqual(highAll.items.map((i) => i.primaryId).sort(), ["done-high", "rev-high", "run-high"]);
  });
});
