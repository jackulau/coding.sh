import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { localDate, phaseLabel, sessionOutline, storedOutline } from "../../src/core/outline.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind, SessionDerail } from "../../src/schema/index.ts";
import { testCtx } from "../adapters/_helpers.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 22); // 22:00 UTC: the day turns over two hours in
let n = 0;
let clock = T0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> & { gap?: number } = {}): AgentEvent => {
  const { gap = 1000, ...rest } = o;
  clock += gap;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, ...rest };
};

describe("session outline", () => {
  it("splits a long session at resumes, compactions and idle gaps, and marks the day turning over", () => {
    n = 0;
    clock = T0;
    const events = [
      ev("session.start", { source: "startup" }),
      ev("user.message", { text: "Step 1: fix the cache" }),
      ev("tool.start", { tool: "Edit", toolUseId: "a" }),
      ev("tool.end", { tool: "Edit", toolUseId: "a", ok: false }),
      ev("file.change", { path: "src/cache.ts" }),
      ev("context.compact", { trigger: "auto" }, { gap: 5 * MIN }),
      ev("session.start", { source: "compact" }), // the start Claude Code logs after a compaction: same phase
      ev("tool.start", { tool: "Read", toolUseId: "b", wrapper: false }),
      ev("tool.end", { tool: "Read", toolUseId: "b", ok: true }),
      // A subagent's events never split the parent's phase, even after a long gap.
      ev("tool.start", { tool: "Read", toolUseId: "c" }, { gap: 40 * MIN, subagentId: "sub1" }),
      ev("session.end", { reason: "prompt_input_exit" }, { gap: 1000 }),
      // `claude --resume`: the hook's SessionStart says so.
      ev("session.start", { source: "resume" }, { gap: 50 * MIN }),
      ev("user.message", { text: "Step 2: carry on" }),
      ev("user.message", { text: "Step 3: after lunch" }, { gap: 45 * MIN }),
      ev("context.compact", { trigger: "manual" }),
      ev("session.end", {}),
      // Events after a session.end with no start (a backfilled resume) still open a resume.
      ev("user.message", { text: "Step 4" }, { gap: 10 * MIN }),
    ];
    const derail: SessionDerail = { flag: "looping", ts: events[13]!.ts + 10, eventId: "x", index: 13, endTs: events[13]!.ts + 20, detail: "Read ×6" };
    const o = sessionOutline(events, [derail]);
    assert.deepEqual(
      o.phases.map((p) => [p.kind, phaseLabel(p)]),
      [
        ["start", "start"],
        ["compaction", "compacted (auto)"],
        ["resume", "resumed after 50 min"],
        ["idle", "back after 45 min idle"],
        ["compaction", "compacted (manual)"],
        ["resume", "resumed after 10 min"],
      ],
    );
    const [start, compact, resume, idle] = o.phases;
    assert.deepEqual([start!.prompts, start!.toolCalls, start!.toolErrors, start!.filesChanged, start!.title], [1, 1, 1, 1, "Step 1: fix the cache"]);
    assert.equal(compact!.events, 6, "the compact start and the subagent's events stay in the compaction phase");
    assert.equal(resume!.eventId, events[11]!.id);
    assert.equal(resume!.title, "Step 2: carry on");
    assert.deepEqual(idle!.derails.map((d) => d.flag), ["looping"], "a derail sits in the phase it started in");
    assert.equal(o.phases.reduce((a, p) => a + p.events, 0), events.length);
    // Day lines follow the local time zone: one per local date after the first.
    const dates = [...new Set(events.map((e) => localDate(e.ts)))];
    assert.deepEqual(o.days.map((d) => d.date), dates.slice(1));
    for (const d of o.days) assert.notEqual(localDate(events[d.index - 1]!.ts), d.date);
  });

  it("marks the day turning over in local time", () => {
    n = 0;
    const midnight = new Date(2026, 10, 4).getTime();
    clock = midnight - 30 * MIN;
    const events = [ev("session.start", { source: "startup" }), ev("user.message", { text: "late" }, { gap: 20 * MIN }), ev("user.message", { text: "after midnight" }, { gap: 20 * MIN })];
    const o = sessionOutline(events);
    assert.deepEqual(o.days, [{ date: "2026-11-04", ts: events[2]!.ts, index: 2, eventId: events[2]!.id }]);
  });

  it("keeps the phases on the session at ingest, so readers need no events", () => {
    n = 0;
    clock = T0;
    const events = [
      ev("session.start", { source: "startup" }),
      ev("user.message", { text: "one" }),
      ev("context.compact", { trigger: "auto" }),
      ev("user.message", { text: "two" }, { gap: 3600_000 }),
    ];
    const s = buildSession(events);
    const fresh = sessionOutline(events);
    assert.deepEqual(s.stats.phases, fresh.phases.map(({ derails: _, ...p }) => p));
    const kept = storedOutline({ stats: { ...s.stats, derails: [{ flag: "stalled", ts: events[3]!.ts, eventId: "e4", index: 3, endTs: events[3]!.ts, detail: "x" }] } })!;
    assert.deepEqual(kept.phases.map((p) => [p.kind, p.derails.map((d) => d.flag)]), [["start", []], ["compaction", []], ["idle", ["stalled"]]]);
    assert.equal(buildSession(events.slice(0, 2)).stats.phases, undefined, "a one-phase session keeps none");
  });

  it("a short session is one phase", () => {
    n = 0;
    clock = T0 - 10 * 3600_000;
    const o = sessionOutline([ev("session.start", { source: "startup" }), ev("user.message", { text: "hi" }), ev("session.end", {})]);
    assert.deepEqual(o.phases.map((p) => p.kind), ["start"]);
    assert.deepEqual(o.days, []);
  });

  it("events within REOPEN_SLACK_MS of a session.end belong to it; later ones resume", () => {
    n = 0;
    clock = T0 - 10 * 3600_000;
    // An SDK trace's last span closes just after its session.end; a transcript window reads past its hook.
    const late = [ev("session.start", {}), ev("llm.call", {}), ev("session.end", {}), ev("llm.call", {}, { gap: 0 }), ev("tool.end", { toolUseId: "x" }, { gap: 4000 })];
    assert.deepEqual(sessionOutline(late).phases.map((p) => p.kind), ["start"]);
    const resumed = [...late, ev("llm.call", {}, { gap: 2000 })];
    assert.deepEqual(sessionOutline(resumed).phases.map((p) => [p.kind, p.from]), [["start", 0], ["resume", 5]]);
  });
});

describe("claude --resume capture", () => {
  const line = (source: string, ts: number): SpoolLine => ({
    v: 0,
    agent: "claude-code",
    event: "SessionStart",
    ts,
    pid: 4047,
    ppid: 3999,
    cwd: "/work/demo",
    raw: { session_id: "11111111-2222-4333-8444-555555555555", cwd: "/work/demo", hook_event_name: "SessionStart", source, model: "claude-opus-4-5" },
  });
  it("keeps the resume's SessionStart as its own event; a fresh start still dedupes with the transcript's", async () => {
    const { ctx } = testCtx();
    const [a] = await claudeCode.normalize(line("startup", T0), ctx);
    const [a2] = await claudeCode.normalize(line("startup", T0 + 5), ctx);
    const [r1] = await claudeCode.normalize(line("resume", T0 + 3600_000), ctx);
    const [r2] = await claudeCode.normalize(line("resume", T0 + 7200_000), ctx);
    assert.equal(a!.id, a2!.id, "fresh starts share the session's start key");
    assert.equal(r1!.payload.source, "resume");
    assert.equal(new Set([a!.id, r1!.id, r2!.id]).size, 3, "each resume is its own row");
  });
});
