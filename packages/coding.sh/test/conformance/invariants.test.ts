// One test per invariant in src/conformance, on hand-built event lists.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Checker, checkEvents, reportedExitCode, RULES, type ConformanceReport } from "../../src/conformance/index.ts";
import { hashParts } from "../../src/core/ids.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const T0 = Date.UTC(2026, 10, 1, 10);
let n = 0;
function ev(kind: AgentEvent["kind"], over: Partial<AgentEvent> = {}, payload: Record<string, unknown> = {}): AgentEvent {
  return { id: hashParts("test", n++), v: 0, agent: "test", sessionId: "s1", kind, ts: T0 + n, payload, ...over };
}
/** A whole, clean session: start, prompt, one tool call, one model call, end. */
function session(sid = "s1"): AgentEvent[] {
  return [
    ev("session.start", { sessionId: sid, ts: T0 }),
    ev("user.message", { sessionId: sid, ts: T0 + 10 }, { text: "do it" }),
    ev("llm.call", { sessionId: sid, ts: T0 + 20, usage: { inputTokens: 10, outputTokens: 5 } }, { ok: true, messageId: `m-${sid}` }),
    ev("tool.start", { sessionId: sid, ts: T0 + 30 }, { tool: "Bash", toolUseId: `t-${sid}` }),
    ev("tool.end", { sessionId: sid, ts: T0 + 40 }, { tool: "Bash", toolUseId: `t-${sid}`, ok: true, output: "Exit code 0\nfine" }),
    ev("session.end", { sessionId: sid, ts: T0 + 50 }),
  ];
}
const rules = (r: ConformanceReport) => Object.keys(r.violations).sort();

describe("conformance invariants", () => {
  it("a clean session has no violations", () => {
    const r = checkEvents([...session("a"), ...session("b")]);
    assert.equal(r.ok, true, JSON.stringify(r.examples));
    assert.equal(r.counts.events, 12);
    assert.equal(r.counts.sessions, 2);
    assert.equal(r.counts.kinds["tool.start"], 2);
  });

  it("duplicate-id: same id, other content (F1); the same content again is only counted", () => {
    const [start, prompt, call, ...rest] = session();
    const same = { ...call! };
    const other = { ...call!, payload: { ...call!.payload, ttftMs: 512 } };
    const r = checkEvents([start!, prompt!, call!, same, other, ...rest]);
    assert.deepEqual(rules(r), ["duplicate-id"]);
    assert.equal(r.examples[0]!.finding, "F1");
    assert.equal(r.counts.duplicateIdsSameContent, 1);
    assert.equal(r.counts.duplicateIdsDifferentContent, 1);
  });

  it("duplicate-id ignores key order", () => {
    const e = ev("notification", {}, { a: 1, b: 2 });
    const reordered = { ...Object.fromEntries(Object.entries(e).reverse()), payload: { b: 2, a: 1 } } as unknown as AgentEvent;
    const r = checkEvents([e, reordered]);
    assert.equal(r.counts.duplicateIdsSameContent, 1);
    assert.equal(r.ok, true);
  });

  it("bad-timestamp: seconds for ms, NaN, a string", () => {
    const r = checkEvents([ev("notification", { ts: 1_790_000_000 }), ev("notification", { ts: Number.NaN }), ev("notification", { ts: "2026" as unknown as number })]);
    assert.equal(r.violations["bad-timestamp"], 3);
    assert.equal(r.counts.badTimestamps, 3);
  });

  it("negative-duration", () => {
    const r = checkEvents([ev("notification", { durationMs: -5 }), ev("notification", { durationMs: 0 })]);
    assert.equal(r.violations["negative-duration"], 1);
  });

  it("negative-usage", () => {
    const r = checkEvents([ev("user.message"), ev("llm.call", { usage: { inputTokens: -1, outputTokens: 3 } }, { ok: true })]);
    assert.deepEqual(rules(r), ["negative-usage"]);
  });

  it("usage-double-count: two calls with one message id carry usage", () => {
    const base = session();
    const again = ev("llm.call", { ts: T0 + 25, usage: { inputTokens: 10, outputTokens: 5 } }, { ok: true, messageId: "m-s1" });
    assert.deepEqual(rules(checkEvents([...base, again])), ["usage-double-count"]);
    // A proxy copy of the same call is a second capture path, paired downstream: not a double count.
    assert.equal(checkEvents([...base, { ...again, source: "proxy" }]).ok, true);
    // A replayed call is left out of usage by design.
    assert.equal(checkEvents([...base, { ...again, payload: { ...again.payload, replay: true } }]).ok, true);
  });

  it("usage-double-count: a session total in usage next to per-call usage", () => {
    const base = session().filter((e) => e.kind !== "session.end");
    const end = ev("session.end", { ts: T0 + 60, usage: { inputTokens: 10, outputTokens: 5 } });
    assert.deepEqual(rules(checkEvents([...base, end])), ["usage-double-count"]);
    // Usage only on the end (an agent that reports per session) is fine.
    const noCalls = base.map((e) => (e.kind === "llm.call" ? { ...e, usage: undefined } : e));
    assert.equal(checkEvents([...noCalls, end]).ok, true);
  });

  it("tool-end-without-start and duplicate-tool-call", () => {
    const base = session();
    const orphan = ev("tool.end", { ts: T0 + 45 }, { tool: "Read", toolUseId: "t-orphan", ok: true });
    const r1 = checkEvents([...base, orphan]);
    assert.deepEqual(rules(r1), ["tool-end-without-start"]);
    assert.equal(r1.counts.toolEndWithoutStart, 1);
    const twice = ev("tool.start", { ts: T0 + 31 }, { tool: "Bash", toolUseId: "t-s1" });
    assert.deepEqual(rules(checkEvents([...base, twice])), ["duplicate-tool-call"]);
  });

  it("a tool.start without its end is counted, not a violation (a cancelled or running call)", () => {
    const r = checkEvents([...session(), ev("tool.start", { ts: T0 + 45 }, { tool: "Bash", toolUseId: "t-open" })]);
    assert.equal(r.ok, true);
    assert.equal(r.counts.toolStartWithoutEnd, 1);
  });

  it("end-before-start: tool, subagent and session", () => {
    const tool = [ev("tool.start", { ts: T0 + 100 }, { tool: "Bash", toolUseId: "x" }), ev("tool.end", { ts: T0 + 90 }, { tool: "Bash", toolUseId: "x", ok: true })];
    const sub = [ev("subagent.start", { ts: T0 + 100 }, { subagentId: "a" }), ev("subagent.end", { ts: T0 + 50 }, { subagentId: "a" })];
    const sess = [ev("session.start", { sessionId: "s2", ts: T0 + 100 }), ev("session.end", { sessionId: "s2", ts: T0 + 10 })];
    const r = checkEvents([...session(), ...tool, ...sub, ...sess]);
    assert.equal(r.violations["end-before-start"], 3);
  });

  it("turn-end-repeated", () => {
    const r = checkEvents([...session(), ev("turn.end", { turnId: "t1" }), ev("turn.end", { turnId: "t1" })]);
    assert.deepEqual(rules(r), ["turn-end-repeated"]);
  });

  it("dangling-parent, parent-other-session and a self parent (F2)", () => {
    const a = session("a");
    const b = session("b");
    const toolA = a.find((e) => e.kind === "tool.start")!;
    const dangling = ev("subagent.start", { sessionId: "a" }, { subagentId: "x" });
    dangling.parentId = hashParts("missing");
    const cross = ev("notification", { sessionId: "b", parentId: toolA.id });
    const self = ev("notification", { sessionId: "a" });
    self.parentId = self.id;
    const r = checkEvents([...a, ...b, dangling, cross, self]);
    assert.equal(r.violations["dangling-parent"], 2);
    assert.equal(r.violations["parent-other-session"], 1);
    assert.equal(r.counts.danglingParentIds, 1);
    assert.ok(r.examples.every((v) => v.finding === "F2"));
  });

  it("a parent that comes later in the stream resolves", () => {
    const [start, prompt, call, toolStart, ...rest] = session();
    const child = ev("notification", { parentId: toolStart!.id });
    assert.equal(checkEvents([start!, prompt!, call!, child, toolStart!, ...rest]).ok, true);
  });

  it("parent-link-broken: a child session names a parentEventId that is not in its parent", () => {
    const parent = session("p");
    const subStart = ev("subagent.start", { sessionId: "p" }, { subagentId: "c" });
    const good = [ev("session.start", { sessionId: "c" }, { parentSessionId: "p", parentEventId: subStart.id }), ev("user.message", { sessionId: "c" })];
    assert.equal(checkEvents([...parent, subStart, ...good]).ok, true);
    const bad = [ev("session.start", { sessionId: "c" }, { parentSessionId: "p", parentEventId: hashParts("nope") }), ev("user.message", { sessionId: "c" })];
    assert.deepEqual(rules(checkEvents([...parent, subStart, ...bad])), ["parent-link-broken"]);
    // The parent session is not in the data at all: nothing to check against.
    assert.equal(checkEvents(bad).ok, true);
  });

  it("session-without-prompt (F6): work but no user.message; a session with no work is fine", () => {
    const noPrompt = session().filter((e) => e.kind !== "user.message");
    const r = checkEvents(noPrompt);
    assert.deepEqual(rules(r), ["session-without-prompt"]);
    assert.equal(r.examples[0]!.finding, "F6");
    assert.equal(checkEvents([ev("session.start"), ev("session.end")]).ok, true);
  });

  it("exit-code-not-failed (F6): the output says a nonzero exit, ok is not false", () => {
    const base = session();
    const call = (output: string, ok?: boolean) => [
      ev("tool.start", { ts: T0 + 41 }, { tool: "run_command", toolUseId: `c${n}` }),
      ev("tool.end", { ts: T0 + 42 }, { tool: "run_command", toolUseId: `c${n - 1}`, output, ...(ok === undefined ? {} : { ok }) }),
    ];
    assert.deepEqual(rules(checkEvents([...base, ...call("The command exited with code 1.\nOutput:", true)])), ["exit-code-not-failed"]);
    assert.deepEqual(rules(checkEvents([...base, ...call("Exit code: 2\nWall time: 1s")])), ["exit-code-not-failed"]);
    assert.equal(checkEvents([...base, ...call("Error: Exit code 1\nFAIL", false)]).ok, true);
    assert.equal(checkEvents([...base, ...call("Exit code: 0", true)]).ok, true);
  });

  it("reportedExitCode reads the first lines only and only line starts", () => {
    assert.equal(reportedExitCode("Error: Exit code 1\nmore"), 1);
    assert.equal(reportedExitCode("process exited with code 127"), 127);
    assert.equal(reportedExitCode("exit status 3"), 3);
    assert.equal(reportedExitCode("Exit code 0"), undefined);
    assert.equal(reportedExitCode("the test asserts that exit code 1 is returned"), undefined);
    assert.equal(reportedExitCode(`${"x".repeat(400)}\nExit code 1`), undefined);
    assert.equal(reportedExitCode(undefined), undefined);
  });

  it("since: sessions that began before the cut skip the checks that need a whole session", () => {
    // A session cut by `since`: no session.start, an orphan tool.end, a parent before the window.
    const cut = [ev("tool.end", { sessionId: "old" }, { tool: "Bash", toolUseId: "z", ok: true }), ev("llm.call", { sessionId: "old", parentId: hashParts("before") }, { ok: true })];
    const r = checkEvents([...session(), ...cut], { since: T0 });
    assert.equal(r.ok, true, JSON.stringify(r.examples));
    assert.equal(r.counts.partialSessions, 1);
    // Without since the same data is whole, so it is checked.
    assert.deepEqual(rules(checkEvents([...session(), ...cut])), ["dangling-parent", "session-without-prompt", "tool-end-without-start"]);
  });

  it("partial sessions passed to report() skip whole-session checks", () => {
    const c = new Checker();
    for (const e of session().filter((e) => e.kind !== "user.message")) c.add(e);
    assert.equal(c.report().ok, false);
    assert.equal(c.report(["s1"]).ok, true);
  });

  it("caps examples per rule and counts them all", () => {
    const many = Array.from({ length: 20 }, () => ev("notification", { durationMs: -1 }));
    const r = checkEvents(many, { maxExamples: 3 });
    assert.equal(r.violations["negative-duration"], 20);
    assert.equal(r.examples.length, 3);
  });

  it("never puts payload text in a report", () => {
    const secret = `SECRET-${"y".repeat(500)}`;
    const events = [
      ev("user.message", {}, { text: secret }),
      ev("tool.start", {}, { tool: `Bash ${secret}`, toolUseId: "q", input: { command: secret } }),
      ev("tool.end", {}, { tool: `Bash ${secret}`, toolUseId: "q", ok: true, output: `Exit code 1 ${secret}` }),
      ev("tool.end", {}, { tool: secret, toolUseId: "q", ok: true }),
      ev("llm.call", { durationMs: -1, usage: { inputTokens: -1 } }, { messageId: secret }),
    ];
    const text = JSON.stringify(checkEvents(events));
    assert.doesNotMatch(text, /SECRET/);
    const strings: string[] = [];
    JSON.parse(text, (_k, v) => (typeof v === "string" && strings.push(v), v));
    assert.ok(strings.every((s) => s.length <= 200), strings.find((s) => s.length > 200));
  });

  it("every rule has a description, and the four findings each have rules", () => {
    for (const [k, r] of Object.entries(RULES)) assert.ok(r.desc.length > 10, k);
    const findings = new Set(Object.values(RULES).map((r) => (r as { finding?: string }).finding).filter(Boolean));
    assert.deepEqual([...findings].sort(), ["F1", "F2", "F3", "F6"]);
  });
});
