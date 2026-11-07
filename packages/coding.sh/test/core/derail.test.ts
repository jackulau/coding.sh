import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { DERAIL_THRESHOLDS, detectDerails, progressMetrics } from "../../src/core/derail.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

const MIN = 60_000;
let n = 0;
let clock = 0;
const reset = () => {
  n = 0;
  clock = Date.UTC(2026, 10, 3, 16);
};
/** Next event, `gap` ms after the previous one. */
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> & { gap?: number } = {}): AgentEvent => {
  const { gap = 1000, ...rest } = o;
  clock += gap;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, ...rest };
};
/** A tool call: start, then end `ms` later. */
const call = (tool: string, input: unknown, opts: { ok?: boolean; output?: string; ms?: number; gap?: number; interrupted?: boolean } = {}): AgentEvent[] => {
  const id = `tu${n + 1}`;
  return [
    ev("tool.start", { tool, toolUseId: id, input }, { gap: opts.gap ?? 1000 }),
    ev("tool.end", { tool, toolUseId: id, ok: opts.ok ?? true, ...(opts.output !== undefined ? { output: opts.output } : {}), ...(opts.interrupted ? { interrupted: true } : {}) }, { gap: opts.ms ?? 200 }),
  ];
};
const read = (path: string, output = `contents of ${path}`) => call("Read", { file_path: path }, { output });
const edit = (path: string, old_string: string, new_string: string) => call("Edit", { file_path: path, old_string, new_string }, { output: "updated" });
const llm = (context: number) => ev("llm.call", { ok: true }, { usage: { inputTokens: 500, cacheReadTokens: context - 500, outputTokens: 50 } });
const flags = (events: AgentEvent[]) => detectDerails(events).map((d) => d.flag);

describe("derail detection", () => {
  before(reset);

  describe("looping", () => {
    it("flags the same call with the same result over and over, at its first repeat", () => {
      reset();
      const events = [ev("user.message", { text: "fix it" }), ...read("src/a.ts"), ...Array.from({ length: 5 }, () => [...call("Grep", { pattern: "x" }, { output: "none" }), ...read("src/a.ts")]).flat()];
      const d = detectDerails(events);
      assert.deepEqual(d.map((x) => x.flag), ["looping"], "one episode, even with two calls repeating in it");
      assert.equal(d[0]!.eventId, events[1]!.id, "onset is the first Read");
      assert.match(d[0]!.detail, /Read src\/a\.ts ×6/);
    });

    it("leaves repeats whose result changes, polling, UI driving and repeats across an edit alone", () => {
      reset();
      const changing = Array.from({ length: 8 }, (_, i) => call("Bash", { command: "npm test" }, { output: `run ${i}` })).flat();
      assert.deepEqual(flags(changing), []);
      reset();
      const polling = Array.from({ length: 10 }, () => call("BashOutput", { bash_id: "b1" }, { output: "still running" })).flat();
      assert.deepEqual(flags(polling), []);
      reset();
      const waiting = Array.from({ length: 10 }, () => call("wait_agent", { id: "a1" }, { output: "running" })).flat();
      assert.deepEqual(flags(waiting), []);
      reset();
      const browser = Array.from({ length: 10 }, () => call("mcp__chrome-devtools__press_key", { key: "Tab" }, { output: "pressed" })).flat();
      const browser2 = Array.from({ length: 10 }, () => call("mcp__browser__extract_text", {}, { output: "same" })).flat();
      assert.deepEqual(flags([...browser, ...browser2]), []);
      reset();
      const acrossEdit = [...read("a.ts"), ...read("a.ts"), ...read("a.ts"), ...edit("a.ts", "x", "y"), ...read("a.ts"), ...read("a.ts"), ...read("a.ts")];
      assert.deepEqual(flags(acrossEdit), []);
    });
  });

  describe("failure-streak", () => {
    it("flags five failed calls in a row, not four, and not user interrupts", () => {
      reset();
      const five = Array.from({ length: 5 }, (_, i) => call("Bash", { command: `cmd${i}` }, { ok: false })).flat();
      const d = detectDerails(five);
      assert.deepEqual(d.map((x) => x.flag), ["failure-streak"]);
      assert.equal(d[0]!.eventId, five[0]!.id);
      reset();
      assert.deepEqual(flags(Array.from({ length: 4 }, (_, i) => call("Bash", { command: `c${i}` }, { ok: false })).flat()), []);
      reset();
      const interrupted = Array.from({ length: 6 }, (_, i) => call("Bash", { command: `c${i}` }, { ok: false, interrupted: true })).flat();
      assert.deepEqual(flags(interrupted), []);
    });
  });

  describe("churn", () => {
    it("flags a file edited back and forth twice, starting at the edit that got undone", () => {
      reset();
      const events = [...edit("src/c.ts", "ttl = 30", "ttl = 60"), ...edit("src/c.ts", "ttl = 60", "ttl = 30"), ...edit("src/c.ts", "ttl = 30", "ttl = 60")];
      const d = detectDerails(events);
      assert.deepEqual(d.map((x) => x.flag), ["churn"]);
      assert.equal(d[0]!.eventId, events[0]!.id);
      assert.match(d[0]!.detail, /src\/c\.ts edited back and forth \(2 reverts\)/);
    });

    it("reads apply_patch and whole-file writes too, and leaves one revert alone", () => {
      reset();
      const patch = (a: string, b: string) => call("apply_patch", { input: `*** Begin Patch\n*** Update File: src/p.ts\n@@\n-${a}\n+${b}\n*** End Patch` });
      assert.deepEqual(flags([...patch("a", "b"), ...patch("b", "a"), ...patch("a", "b")]), ["churn"]);
      reset();
      const write = (content: string) => call("Write", { file_path: "w.ts", content });
      assert.deepEqual(flags([...write("A"), ...write("B"), ...write("A"), ...write("B"), ...write("A")]), ["churn"]);
      reset();
      assert.deepEqual(flags([...edit("x.ts", "a", "b"), ...edit("x.ts", "b", "a")]), [], "one revert is a change of mind");
    });
  });

  describe("no-progress", () => {
    const circle = (calls: number, distinct: number, startCtx = 40_000) => {
      const out: AgentEvent[] = [];
      for (let i = 0; i < calls; i++) out.push(llm(startCtx + i * 1500), ...read(`src/f${i % distinct}.ts`, `body ${i}`));
      return out;
    };

    it("flags a long stretch going round the same calls while the context climbs", () => {
      reset();
      const events = [...edit("a.ts", "1", "2"), ev("user.message", { text: "now make the tests pass" }), ...circle(DERAIL_THRESHOLDS.noProgressCalls + 10, 12)];
      const d = detectDerails(events);
      assert.deepEqual(d.map((x) => x.flag), ["no-progress"]);
      assert.equal(d[0]!.eventId, events.find((e) => e.kind === "tool.start" && e.payload.tool === "Read")!.id);
      assert.match(d[0]!.detail, /repeats/);
    });

    it("leaves exploration, delegation, shell edits and read-only sessions alone", () => {
      reset();
      const explore = [...edit("a.ts", "1", "2"), ...circle(120, 120)];
      assert.deepEqual(flags(explore), [], "every call new: exploring");
      reset();
      const flat = [...edit("a.ts", "1", "2"), ...Array.from({ length: 120 }, (_, i) => [llm(40_000), ...read(`f${i % 10}.ts`, `b${i}`)]).flat()];
      assert.deepEqual(flags(flat), [], "context not growing");
      reset();
      const delegating = [...edit("a.ts", "1", "2"), ...circle(50, 10), ...call("send_message", { to: "worker" }), ...circle(50, 10, 120_000)];
      assert.deepEqual(flags(delegating), []);
      reset();
      const shell = [...edit("a.ts", "1", "2"), ...circle(50, 10), ...call("Bash", { command: "sed -i s/a/b/ src/x.ts" }), ...circle(50, 10, 120_000)];
      assert.deepEqual(flags(shell), []);
      reset();
      assert.deepEqual(flags(circle(120, 12)), [], "no edits anywhere: a question, not a task");
    });
  });

  describe("stalled", () => {
    it("flags a tool that sat 15+ minutes with nothing else happening and then failed or never ended", () => {
      reset();
      const hung = [ev("user.message", { text: "run e2e" }), ...call("Bash", { command: "npm run e2e" }, { ok: false, ms: 22 * MIN })];
      const d = detectDerails(hung);
      assert.deepEqual(d.map((x) => x.flag), ["stalled"]);
      assert.equal(d[0]!.eventId, hung[1]!.id);
      assert.match(d[0]!.detail, /npm run e2e hung 22 min, then failed/);
      reset();
      const lost = [ev("tool.start", { tool: "Bash", toolUseId: "t", input: { command: "git commit" } }), ev("assistant.message", { text: "…" }, { gap: 40 * MIN })];
      assert.match(detectDerails(lost)[0]!.detail, /never finished/);
    });

    it("leaves long successful jobs, subagents, sleeps, user waits and idle gaps alone", () => {
      reset();
      assert.deepEqual(flags(call("Bash", { command: "cargo build --release" }, { ms: 40 * MIN })), [], "a long job that finished");
      reset();
      assert.deepEqual(flags(call("Task", { prompt: "research" }, { ok: false, ms: 40 * MIN })), []);
      reset();
      assert.deepEqual(flags(call("Bash", { command: "sleep 1200" }, { ok: false, ms: 20 * MIN })), []);
      reset();
      assert.deepEqual(flags(call("AskUserQuestion", { q: "?" }, { ok: false, ms: 60 * MIN })), []);
      reset();
      assert.deepEqual(flags([ev("assistant.message", { text: "a" }), ev("llm.call", {}, { gap: 30 * MIN })]), [], "nothing running: asleep or waiting");
      reset();
      assert.deepEqual(flags([ev("tool.start", { tool: "Bash", toolUseId: "t", input: { command: "x" } }), ev("notification", { message: "needs permission" }), ev("tool.end", { tool: "Bash", toolUseId: "t", ok: false }, { gap: 30 * MIN })]), [], "waiting on a permission prompt");
    });
  });

  describe("context-thrash", () => {
    it("flags automatic compactions back to back and counts the run", () => {
      reset();
      const events = [ev("context.compact", { trigger: "auto" }), ...read("a.ts"), ev("context.compact", { trigger: "auto" }, { gap: 5 * MIN }), ev("context.compact", { trigger: "auto" }, { gap: 5 * MIN })];
      const d = detectDerails(events);
      assert.deepEqual(d.map((x) => x.flag), ["context-thrash"]);
      assert.equal(d[0]!.eventId, events[0]!.id);
      assert.match(d[0]!.detail, /^3 compactions in 10 min/);
    });

    it("leaves manual compactions and well-spaced ones alone", () => {
      reset();
      assert.deepEqual(flags([ev("context.compact", { trigger: "manual" }), ev("context.compact", { trigger: "manual" }, { gap: MIN })]), []);
      reset();
      const spaced = [ev("context.compact", { trigger: "auto" }), ...Array.from({ length: 20 }, (_, i) => read(`f${i}.ts`)).flat(), ev("context.compact", { trigger: "auto" }, { gap: 20 * MIN })];
      assert.deepEqual(flags(spaced), []);
    });
  });

  it("buildSession keeps the episodes on stats.derails and their names in flags", () => {
    reset();
    const events = [ev("session.start"), ev("user.message", { text: "go" }), ...Array.from({ length: 6 }, (_, i) => call("Bash", { command: `c${i}` }, { ok: false })).flat()];
    const s = buildSession(events);
    assert.ok(s.flags.includes("failure-streak"));
    assert.equal(s.stats.derails?.length, 1);
    assert.equal(s.stats.derails![0]!.index, 2);
    assert.equal(buildSession(read("a.ts")).stats.derails, undefined, "unset when clean");
  });

  it("progressMetrics: time to first derail, or the whole run when it never derailed", () => {
    assert.deepEqual(progressMetrics([], 1000, 61_000), { derails: 0, timeToFirstDerailMs: 60_000, onTrack: 1 });
    const m = progressMetrics([{ flag: "stalled", ts: 31_000 }, { flag: "looping", ts: 16_000 }], 1000, 61_000);
    assert.deepEqual(m, { derails: 2, firstFlag: "looping", timeToFirstDerailMs: 15_000, onTrack: 0.25 });
  });

  describe("no false positives on the adapter fixtures (real agent captures and goldens)", () => {
    const goldens: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".golden.json")) goldens.push(p);
      }
    };
    before(() => walk(join(import.meta.dirname, "..", "fixtures", "adapters")));
    it("every golden session is clean", () => {
      assert.ok(goldens.length >= 20, `found ${goldens.length} goldens`);
      let sessions = 0;
      for (const g of goldens) {
        const events = JSON.parse(readFileSync(g, "utf8")) as AgentEvent[];
        if (!Array.isArray(events)) continue;
        const by = new Map<string, AgentEvent[]>();
        for (const e of events) if (e && e.sessionId) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
        for (const [id, list] of by) {
          sessions++;
          list.sort((a, b) => a.ts - b.ts);
          assert.deepEqual(detectDerails(list), [], `${g}: ${id}`);
        }
      }
      assert.ok(sessions >= 30);
    });
  });
});
