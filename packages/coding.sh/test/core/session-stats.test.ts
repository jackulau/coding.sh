// Session stats that come out right whatever the capture path: a hooked session
// later backfilled, a transcript read mid-turn, a resumed session, usage
// snapshots, subagents still running, Stop-hook loops, half-captured tool calls,
// and local cost estimates. Real adapters over temp HOME / CODING_SH_HOME.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeCode, normalizeClaudeLine } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest } from "../../src/core/ingest.ts";
import { priceEvent, pricesFor } from "../../src/core/pricing.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Adapter } from "../../src/core/types.ts";
import { isRunning } from "../../src/mcp/data.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (...o: object[]) => o.map((x) => JSON.stringify(x) + "\n").join("");

let env: TmpEnv;
beforeEach(() => (env = tmpEnv()));
afterEach(() => env.restore());

function stores(mode: "full" | "metadata" = "full") {
  const config = defaultConfig(process.env);
  config.snapshot.enabled = false;
  config.capture.mode = mode;
  const index = new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  const adapters = new Map<string, Adapter>([["claude-code", claudeCode], ["codex", codex]]);
  return {
    config,
    index,
    ingest: () => ingest({ config, index, blobs, adapters, env: process.env, spoolDir: join(env.dataHome, "spool"), lock: false }),
    backfill: (...only: Adapter[]) => backfill({ config, index, blobs, adapters: only.length ? only : [...adapters.values()], env: process.env }),
    count: async (sid: string, kind: EventKind) => (await index.listEvents(sid, { kinds: [kind] })).length,
  };
}

/** The Claude fixture transcripts under HOME, and the hook spool of the same session pointing at them. */
function claudeFixture() {
  const claudeDir = join(env.home, ".claude");
  cpSync(join(FIXTURES, "claude-code", "config"), claudeDir, { recursive: true });
  const spool = readFileSync(join(FIXTURES, "claude-code", "hooks.spool.jsonl"), "utf8").split("${FIXTURES}/claude-code/config").join(claudeDir);
  mkdirSync(join(env.dataHome, "spool", "claude-code"), { recursive: true });
  writeFileSync(join(env.dataHome, "spool", "claude-code", "2026-11-01.1.jsonl"), spool);
}

function spoolLines(agent: string, name: string, sid: string, lines: [ts: number, event: string, raw?: Record<string, unknown>][]) {
  const dir = join(env.dataHome, "spool", agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    lines.map(([ts, event, raw]) => JSON.stringify({ v: 0, agent, event, ts, pid: 1, cwd: "/tmp", raw: { session_id: sid, hook_event_name: event, cwd: "/tmp", ...raw } }) + "\n").join(""),
  );
}

describe("SES-1: one Claude session captured by hooks and by its transcript", () => {
  for (const mode of ["full", "metadata"] as const) {
    it(`counts each turn and prompt once, ingest then backfill (${mode})`, async () => {
      claudeFixture();
      const s = stores(mode);
      await s.ingest();
      await s.backfill(claudeCode);
      const session = (await s.index.getSession(SID))!;
      assert.equal(session.stats.turns, 2, "two prompts in the transcript");
      assert.equal(await s.count(SID, "turn.end"), 2, "one turn.end per turn");
      assert.equal(await s.count(SID, "session.start"), 1);
      assert.equal(await s.count(SID, "user.message"), 2);
    });

    it(`counts each turn and prompt once, backfill then ingest (${mode})`, async () => {
      claudeFixture();
      const s = stores(mode);
      await s.backfill(claudeCode);
      await s.ingest();
      assert.equal((await s.index.getSession(SID))!.stats.turns, 2);
      assert.equal(await s.count(SID, "user.message"), 2, "the hook copy of a backfilled prompt is dropped");
      assert.equal(await s.count(SID, "turn.end"), 2);
      assert.equal(await s.count(SID, "session.start"), 1);
    });
  }
});

describe("SES-2: a transcript backfilled mid-turn", () => {
  it("ends the turn once, with the duration Claude recorded", async () => {
    const sid = "aaaaaaaa-0000-4000-8000-000000000001";
    const file = join(env.home, ".claude", "projects", "-work-x", `${sid}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    const t0 = Date.now() - 5 * 60_000;
    const base = { sessionId: sid, cwd: "/work/x", version: "2.1.0" };
    writeFileSync(
      file,
      jsonl(
        { ...base, type: "user", uuid: "u1", timestamp: iso(t0), message: { role: "user", content: "fix the bug and run tests" } },
        { ...base, type: "assistant", uuid: "a1", timestamp: iso(t0 + 1000), message: { id: "msg_1", model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ),
    );
    const s = stores();
    await s.backfill(claudeCode);
    assert.equal(await s.count(sid, "turn.end"), 0, "a turn still running has no end yet");
    appendFileSync(
      file,
      jsonl(
        { ...base, type: "user", uuid: "u2", timestamp: iso(t0 + 60_000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
        { ...base, type: "assistant", uuid: "a2", timestamp: iso(t0 + 61_000), message: { id: "msg_2", model: "claude-x", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5 } } },
        { ...base, type: "system", subtype: "turn_duration", uuid: "s1", timestamp: iso(t0 + 61_100), durationMs: 61_100 },
      ),
    );
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    await s.backfill(claudeCode);
    const ends = await s.index.listEvents(sid, { kinds: ["turn.end"] });
    assert.deepEqual(ends.map((e) => e.durationMs), [61_100]);
    assert.equal((await s.index.getSession(sid))!.stats.turns, 1);
  });
});

describe("SES-3: a session resumed after it ended", () => {
  const now = Date.now();
  const T = (min: number) => now - 60 * 60_000 + min * 60_000;
  const cases = [
    ["claude-code", "cccccccc-0000-4000-8000-000000000001", {}],
    ["codex", "0193dddd-1111-7222-8333-444455556666", { model: "gpt-5" }],
  ] as const;
  for (const [agent, sid, extra] of cases) {
    it(`is running again, and ends at its last exit (${agent})`, async () => {
      const turn = (id: string) => (agent === "codex" ? { turn_id: id } : {});
      spoolLines(agent, "a.jsonl", sid, [
        [T(0), "SessionStart", { source: "startup", ...extra }],
        [T(1), "UserPromptSubmit", { prompt: "first", ...turn("t1"), ...extra }],
        [T(2), "Stop", { ...turn("t1"), ...extra }],
        [T(3), "SessionEnd", { reason: "exit", ...extra }],
        [T(53), "SessionStart", { source: "resume", ...extra }],
        [T(54), "UserPromptSubmit", { prompt: "continue", ...turn("t2"), ...extra }],
        [T(59), "PreToolUse", { tool_name: "Bash", tool_use_id: "call_9", tool_input: { command: "sleep 600" }, ...turn("t2"), ...extra }],
      ]);
      const s = stores();
      await s.ingest();
      let session = (await s.index.getSession(sid))!;
      assert.equal(session.endedAt, undefined, "activity after the end reopens the session");
      assert.equal(isRunning(session, now), true);

      spoolLines(agent, "b.jsonl", sid, [
        [T(59.5), "PostToolUse", { tool_name: "Bash", tool_use_id: "call_9", tool_response: { stdout: "" }, ...turn("t2"), ...extra }],
        [T(59.6), "Stop", { ...turn("t2"), ...extra }],
        [T(59.7), "SessionEnd", { reason: "exit", ...extra }],
      ]);
      await s.ingest();
      session = (await s.index.getSession(sid))!;
      assert.equal(session.endedAt, T(59.7), "ends at the resumed run's exit");
      assert.equal(await s.count(sid, "session.end"), 2);
    });
  }

  it("buildSession: activity past the end clears endedAt; a call that began before it does not", () => {
    const ev = (kind: EventKind, ts: number, o: Partial<AgentEvent> = {}): AgentEvent => ({ id: `${kind}${ts}`, v: 0, sessionId: "s", ts, agent: "claude-code", kind, payload: {}, ...o });
    assert.equal(buildSession([ev("session.start", 0), ev("session.end", 1000), ev("user.message", 60_000)]).endedAt, undefined);
    assert.equal(buildSession([ev("session.start", 0), ev("llm.call", 500, { durationMs: 10_000 }), ev("session.end", 1000)]).endedAt, 1000);
  });
});

describe("SES-4: usage snapshots", () => {
  it("counts the latest snapshot per session, never the sum", () => {
    const snap = (ts: number, inputTokens: number, outputTokens: number): AgentEvent => ({
      id: `u${ts}`, v: 0, sessionId: "s", ts, agent: "t3code", kind: "notification", payload: { type: "usage-summary" }, usage: { inputTokens, outputTokens },
    });
    const s = buildSession([snap(2000, 40_000, 7000), snap(1000, 300, 100)]);
    assert.equal(s.stats.usage?.inputTokens, 40_000);
    assert.equal(s.stats.usage?.outputTokens, 7000);
  });
});

describe("SES-5: a Codex subagent rollout read while the child runs", () => {
  it("ends the subagent only once the child finished", async () => {
    const name = "rollout-2026-11-01T10-00-07-0193bbbb-1111-7222-8333-444455556666.jsonl";
    const parent = "0193aaaa-1111-7222-8333-444455556666";
    const raw = readFileSync(join(FIXTURES, "codex", "home", "sessions", "2026", "11", "01", name), "utf8").split("\n").filter(Boolean);
    // Recent timestamps: an idle child counts as finished.
    const shift = Date.now() - 5 * 60_000 - Date.parse(JSON.parse(raw[0]!).timestamp);
    const at = (v: string) => iso(Date.parse(v) + shift);
    const lines = raw.map((l) => {
      const o = JSON.parse(l);
      if (o.timestamp) o.timestamp = at(o.timestamp);
      if (o.payload?.timestamp) o.payload.timestamp = at(o.payload.timestamp);
      return JSON.stringify(o);
    });
    const file = join(env.home, ".codex", "sessions", "2026", "11", "01", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, lines.slice(0, 7).join("\n") + "\n");
    const s = stores();
    await s.backfill(codex);
    assert.equal(await s.count(parent, "subagent.end"), 0, "the child's tool call is still running");
    writeFileSync(file, lines.join("\n") + "\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await s.backfill(codex);
    const ends = await s.index.listEvents(parent, { kinds: ["subagent.end"] });
    assert.deepEqual(ends.map((e) => e.payload.ok), [true]);
  });
});

describe("SES-6/7: Claude hook edge cases", () => {
  const sid = "dddddddd-0000-4000-8000-000000000001";
  const T = 1_800_000_000_000;
  let offset = 0;
  const hook = (ts: number, event: string, raw: Record<string, unknown> = {}) =>
    normalizeClaudeLine({ v: 0, agent: "claude-code", event, ts, pid: 1, cwd: "/tmp", raw: { session_id: sid, hook_event_name: event, ...raw } }, { ...testCtx().ctx, source: { file: "f", offset: offset++ } });

  it("a Stop-hook continuation (stop_hook_active) is the same turn", async () => {
    const ev = [
      ...(await hook(T, "UserPromptSubmit", { prompt: "fix it" })),
      ...(await hook(T + 1000, "Stop", { stop_hook_active: false })),
      ...(await hook(T + 9000, "Stop", { stop_hook_active: true })),
    ];
    assert.equal(buildSession(ev).stats.turns, 1);
  });

  it("counts tool calls by id when one lost its start and another its end", async () => {
    const ev = [
      ...(await hook(T, "UserPromptSubmit", { prompt: "go" })),
      ...(await hook(T + 10, "PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_A", tool_input: { command: "sleep 99" } })),
      ...(await hook(T + 20, "PostToolUse", { tool_name: "Read", tool_use_id: "toolu_B", tool_input: {}, tool_response: "x" })),
    ];
    assert.equal(buildSession(ev).stats.toolCalls, 2);
    const both = [...(await hook(T + 30, "PreToolUse", { tool_name: "Read", tool_use_id: "toolu_C", tool_input: {} })), ...(await hook(T + 40, "PostToolUse", { tool_name: "Read", tool_use_id: "toolu_C", tool_input: {}, tool_response: "x" }))];
    assert.equal(buildSession(both).stats.toolCalls, 1);
  });
});

describe("local cost", () => {
  it("prices captured and backfilled model calls with known models", async () => {
    claudeFixture();
    const s = stores();
    await s.ingest();
    await s.backfill(claudeCode);
    const calls = await s.index.listEvents(SID, { kinds: ["llm.call"] });
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(typeof c.usage?.costUsd, "number", `${c.model} priced`);
      assert.equal(c.payload.costEstimated, true);
    }
    const session = (await s.index.getSession(SID))!;
    const sum = calls.reduce((n, c) => n + c.usage!.costUsd!, 0);
    assert.ok(session.stats.usage!.costUsd! > 0);
    assert.ok(Math.abs(session.stats.usage!.costUsd! - sum) < 1e-9, "each call priced once");
  });

  it("honours [pricing] overrides", async () => {
    claudeFixture();
    const s = stores();
    s.config.pricing = { "claude-opus-4-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "claude-haiku-4-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await s.backfill(claudeCode);
    assert.equal((await s.index.getSession(SID))!.stats.usage?.costUsd, 0);
  });

  it("keeps a reported cost, and prices usage snapshots", () => {
    const base = { v: 0 as const, sessionId: "s", ts: 1, agent: "a" };
    const prices = pricesFor({ m: { input: 1, output: 2 } });
    const reported: AgentEvent = { ...base, id: "1", kind: "llm.call", model: "m", payload: {}, usage: { inputTokens: 1e6, costUsd: 9 } };
    assert.equal(priceEvent(reported, prices), reported);
    const snap = priceEvent({ ...base, id: "2", kind: "notification", model: "m", payload: { type: "usage-summary" }, usage: { inputTokens: 1e6, outputTokens: 1e6 } }, prices);
    assert.equal(snap.usage?.costUsd, 3);
    assert.equal(snap.payload.costEstimated, true);
  });
});

describe("idle ends for a backfilled file that never changes again", () => {
  const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
    const real = Date.now;
    Date.now = () => real() + ms;
    try {
      return await fn();
    } finally {
      Date.now = real;
    }
  };

  it("a Claude transcript read mid-turn gets its turn and session ended once it goes idle", async () => {
    const sid = "aaaaaaaa-0000-4000-8000-000000000002";
    const file = join(env.home, ".claude", "projects", "-work-x", `${sid}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    const t0 = Date.now() - 60_000;
    const base = { sessionId: sid, cwd: "/work/x", version: "2.1.0" };
    writeFileSync(
      file,
      jsonl(
        { ...base, type: "user", uuid: "u1", timestamp: iso(t0), message: { role: "user", content: "fix it" } },
        { ...base, type: "assistant", uuid: "a1", timestamp: iso(t0 + 1000), message: { id: "msg_1", model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ),
    );
    const s = stores();
    await s.backfill(claudeCode);
    assert.equal(await s.count(sid, "turn.end"), 0);
    const idle = 40 * 60_000;
    await later(idle, () => s.backfill(claudeCode));
    assert.equal(await s.count(sid, "turn.end"), 1, "the abandoned turn is closed");
    assert.equal(await s.count(sid, "session.end"), 1);
    assert.equal((await s.index.getSession(sid))!.stats.turns, 1);
    const again = await later(idle + 60_000, () => s.backfill(claudeCode));
    assert.equal(again.events, 0, "read once at the idle transition, then skipped");
  });

  it("a Codex subagent rollout read mid-run gets its subagent.end once the child goes idle", async () => {
    const name = "rollout-2026-11-01T10-00-07-0193bbbb-1111-7222-8333-444455556666.jsonl";
    const parent = "0193aaaa-1111-7222-8333-444455556666";
    const raw = readFileSync(join(FIXTURES, "codex", "home", "sessions", "2026", "11", "01", name), "utf8").split("\n").filter(Boolean);
    const shift = Date.now() - 60_000 - Date.parse(JSON.parse(raw[0]!).timestamp);
    const at = (v: string) => iso(Date.parse(v) + shift);
    const lines = raw.slice(0, 7).map((l) => {
      const o = JSON.parse(l);
      if (o.timestamp) o.timestamp = at(o.timestamp);
      if (o.payload?.timestamp) o.payload.timestamp = at(o.payload.timestamp);
      return JSON.stringify(o);
    });
    const file = join(env.home, ".codex", "sessions", "2026", "11", "01", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
    const s = stores();
    await s.backfill(codex);
    assert.equal(await s.count(parent, "subagent.end"), 0);
    await later(40 * 60_000, () => s.backfill(codex));
    assert.equal(await s.count(parent, "subagent.end"), 1);
  });
});
