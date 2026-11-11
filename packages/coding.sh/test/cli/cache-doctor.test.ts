// cache doctor: prompt-cache health over a window. Breaks are the ones stats.cacheBreaks counts,
// classified by the first structural change between the two calls (stored proxy requests), with a
// degraded path when only hashes or transcripts exist.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { AVOIDABLE, breakTotals, cacheHealth, cacheScore, CACHE_CAUSE_FIX, sessionBreaks, volatileLine } from "../../src/cli/cache-health.ts";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { lineDiff } from "../../src/proxy/calls.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import type { BlobStore } from "../../src/core/types.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok } from "../query/_seed.ts";

const T = Date.now() - 2 * 3_600_000;
const TOOLS = [
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
  { name: "Read", description: "Read a file", input_schema: { type: "object" } },
];
const STATIC = "You are a careful coding agent.\nRun the tests before you say done.";

interface Call {
  model?: string;
  system?: string;
  tools?: unknown[];
  read: number;
  write: number;
  /** Minutes after the session's start. */
  at?: number;
  /** Stored request (default), hashes only, or a transcript call. */
  mode?: "full" | "metadata" | "transcript";
  systemHash?: string;
  agent?: string;
  /** The history starts over at this call (an edit that drops the earlier messages). */
  reset?: boolean;
}

const short = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** A session of llm.call events, each request stored as the proxy stores it. */
async function calls(blobs: BlobStore, sid: string, list: Call[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const messages: unknown[] = [];
  for (const [i, c] of list.entries()) {
    if (c.reset) messages.length = 0;
    messages.push({ role: "user", content: [{ type: "text", text: `turn ${i}` }] });
    const model = c.model ?? "claude-sonnet-4-5";
    const mode = c.mode ?? "full";
    const system = c.system ?? STATIC;
    const tools = c.tools ?? TOOLS;
    const payload: Record<string, unknown> = { provider: "anthropic", api: "messages" };
    if (mode === "full") {
      const body = { model, max_tokens: 1024, system, tools, messages: [...messages] };
      payload.requestRef = await blobs.put(JSON.stringify({ provider: "anthropic", api: "messages", method: "POST", path: "/v1/messages", headers: {}, body }));
    }
    if (mode !== "transcript") {
      // What the proxy keeps on the event in either capture mode (proxy/record.ts).
      payload.systemHash = c.systemHash ?? short(system);
      payload.toolsHash = short(tools);
      payload.toolNames = tools.map((t) => (t as { name: string }).name);
      payload.messageCount = messages.length;
    }
    out.push({
      id: `${sid}-call-${i + 1}`,
      v: 0,
      sessionId: sid,
      ts: T + (c.at ?? i) * 60_000,
      durationMs: 1000,
      agent: (c.agent ?? "claude-code") as AgentEvent["agent"],
      kind: "llm.call",
      ...(mode === "transcript" ? {} : { source: "proxy" as const }),
      model,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: c.read, cacheWriteTokens: c.write },
      payload,
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] });
  }
  return out;
}

const miss = (o: Partial<Call> = {}): Call => ({ read: 0, write: 10_000, ...o });
const hit = (o: Partial<Call> = {}): Call => ({ read: 10_000, write: 200, ...o });
const clock = (i: number) => `${STATIC}\nCurrent time: 2026-11-08T10:0${i}:00Z`;

describe("cache-health: classification", () => {
  const blobs = new MemoryBlobStore();
  test("a timestamp in the static system prompt over 5 calls is system-volatile-line", async () => {
    const ev = await calls(blobs, "vol", [0, 1, 2, 3, 4].map((i) => miss({ system: clock(i) })));
    const b = await sessionBreaks(blobs, ev);
    assert.equal(b.length, 4);
    assert.deepEqual([...new Set(b.map((x) => x.structural))], ["system-volatile-line"]);
    assert.ok(b.every((x) => !x.degraded));
  });
  test("a reorder-only pair is tools-reordered; a new tool is tools-added", async () => {
    const r = await sessionBreaks(blobs, await calls(blobs, "ord", [miss(), miss({ tools: [TOOLS[1], TOOLS[0]] })]));
    assert.deepEqual(r.map((x) => x.structural), ["tools-reordered"]);
    const a = await sessionBreaks(blobs, await calls(blobs, "add", [miss(), miss({ tools: [...TOOLS, { name: "Grep", input_schema: {} }] })]));
    assert.deepEqual(a.map((x) => x.structural), ["tools-added"]);
  });
  test("Opus then Haiku mid-session is model-switch", async () => {
    const r = await sessionBreaks(blobs, await calls(blobs, "sw", [miss({ model: "claude-opus-4-5" }), miss({ model: "claude-haiku-4-5" })]));
    assert.deepEqual(r.map((x) => x.structural), ["model-switch"]);
  });
  test("a reworded system line is system-changed, not volatile", async () => {
    const r = await sessionBreaks(blobs, await calls(blobs, "sys", [miss(), miss({ system: `${STATIC}\nBe brief.` })]));
    assert.deepEqual(r.map((x) => x.structural), ["system-changed"]);
    assert.equal(volatileLine(lineDiff("a\nTime: 10:01", "a\nTime: 10:02")), true);
    assert.equal(volatileLine(lineDiff("a\nUse tabs", "a\nUse spaces")), false);
  });
  test("a long wait with the prefix unchanged is idle, and the stable prefix has no breaks", async () => {
    const r = await sessionBreaks(blobs, await calls(blobs, "idle", [miss(), miss({ at: 20 })]));
    assert.deepEqual(r.map((x) => x.structural), ["idle"]);
    assert.deepEqual(await sessionBreaks(blobs, await calls(blobs, "ok", [miss(), hit(), hit(), hit()])), []);
  });
  test("metadata only and transcript only are classified degraded, without throwing", async () => {
    const m = await sessionBreaks(blobs, await calls(blobs, "meta", [miss({ mode: "metadata", systemHash: "a" }), miss({ mode: "metadata", systemHash: "b" })]));
    assert.deepEqual(m.map((x) => [x.structural, x.degraded]), [["system-changed", true]]);
    const t = await sessionBreaks(blobs, await calls(blobs, "tr", [miss({ mode: "transcript" }), miss({ mode: "transcript", at: 30 }), miss({ mode: "transcript", at: 31 })]));
    assert.deepEqual(t.map((x) => [x.structural, x.degraded]), [["idle", true], ["other", true]]);
  });
  test("ranking, exact fixes and grades", () => {
    const br = (structural: Parameters<typeof cacheHealth>[0]["breaks"][number]["structural"], lostTokens: number, extraUsd: number, s = "s1") => ({ eventId: `${s}-b`, prevEventId: `${s}-a`, cause: "other" as const, lostTokens, gapMs: 0, extraUsd, sessionId: s, structural, degraded: false });
    const r = cacheHealth({ hitRate: 0.5, promptTokens: 100_000, breaks: [br("idle", 5000, 0.01), br("system-volatile-line", 9000, 0.03), br("system-volatile-line", 9000, 0.03, "s2"), br("tools-reordered", 9000, 0.03)] });
    assert.deepEqual(r.causes.map((c) => c.cause), ["system-volatile-line", "tools-reordered", "idle"]);
    assert.equal(r.causes[0]!.fix, "keep changing values (dates, times, counters) out of the static system prompt; pass them in the next user or tool message");
    assert.equal(r.causes[1]!.fix, CACHE_CAUSE_FIX["tools-reordered"]);
    assert.equal(r.causes[0]!.sessions, 2);
    assert.equal(r.causes[2]!.avoidable, false);
    assert.equal(r.avoidableTokens, 27_000);
    assert.deepEqual(cacheScore(0.92, 0), { score: 100, grade: "A" });
    assert.equal(cacheScore(0.5, 0.27).grade, "F");
    assert.equal(cacheHealth({ promptTokens: 0, breaks: [] }).grade, undefined, "no cache tokens: no grade");
  });
  test("without its requests a break stays on its side of avoidable, from hashes, counts, the model and timing", async () => {
    const cases: [string, Call[], string, string][] = [
      ["u-vol", [miss({ system: clock(0) }), miss({ system: clock(1) })], "system-volatile-line", "system-changed"],
      ["u-ord", [miss(), miss({ tools: [TOOLS[1], TOOLS[0]] })], "tools-reordered", "tools-changed"],
      ["u-add", [miss(), miss({ tools: [...TOOLS, { name: "Grep", input_schema: {} }] })], "tools-added", "tools-added"],
      ["u-sw", [miss({ model: "claude-opus-4-5" }), miss({ model: "claude-haiku-4-5" })], "model-switch", "model-switch"],
      ["u-edit", [miss(), hit(), hit(), miss({ reset: true })], "history-rewritten", "history-rewritten"],
      // The same prefix inside the cache lifetime, and after it: neither is avoidable, read or not.
      ["u-same", [miss(), miss()], "other", "other"],
      ["u-idle", [miss(), miss({ at: 20 })], "idle", "idle"],
    ];
    const read: Awaited<ReturnType<typeof sessionBreaks>> = [];
    const bare: typeof read = [];
    for (const [sid, list, withRequests, without] of cases) {
      const ev = await calls(blobs, sid, list);
      const r = await sessionBreaks(blobs, ev);
      const b = await sessionBreaks(blobs, ev, { requests: false });
      assert.deepEqual([r.map((x) => x.structural), b.map((x) => x.structural)], [[withRequests], [without]], sid);
      assert.equal(AVOIDABLE.has(b[0]!.structural), AVOIDABLE.has(r[0]!.structural), sid);
      // Stored but not read is its own count: capture mode full would not tell more, --limit would.
      assert.deepEqual([r[0]!.degraded, r[0]!.notRead, b[0]!.degraded, b[0]!.notRead], [false, undefined, false, true], sid);
      read.push(...r);
      bare.push(...b);
    }
    const a = cacheHealth({ hitRate: 0.9, promptTokens: 400_000, breaks: read });
    const z = cacheHealth({ hitRate: 0.9, promptTokens: 400_000, breaks: bare });
    assert.deepEqual([z.avoidableTokens, z.score, z.grade, z.breaks, z.lostTokens], [a.avoidableTokens, a.score, a.grade, a.breaks, a.lostTokens]);
    assert.deepEqual([a.breaksNotRead, a.degraded, z.breaksNotRead, z.degraded], [undefined, 0, 7, 0]);
    // No stored requests: there is nothing more to read, so the break is the same one either way.
    for (const mode of ["transcript", "metadata"] as const) {
      const ev = await calls(blobs, `u-${mode}`, [miss({ mode }), miss({ mode }), miss({ mode, at: 30 }), hit({ mode, at: 31 }), miss({ mode, at: 32, reset: true })]);
      const r = await sessionBreaks(blobs, ev);
      assert.deepEqual(await sessionBreaks(blobs, ev, { requests: false }), r, mode);
      assert.deepEqual(r.map((x) => [x.structural, x.degraded, x.notRead]), [["other", true, undefined], ["idle", true, undefined], [mode === "metadata" ? "history-rewritten" : "other", true, undefined]], mode);
    }
  });
  test("the headline is the stored totals, as usage adds them up", () => {
    const br = { eventId: "s1-b", prevEventId: "s1-a", cause: "other" as const, lostTokens: 50_000, gapMs: 0, extraUsd: 0.2, sessionId: "s1", structural: "system-volatile-line" as const, degraded: false };
    const stored = [
      { count: 1, lostTokens: 50_000, extraUsd: 0.2, byCause: { other: { count: 1, lostTokens: 50_000, extraUsd: 0.2 } } },
      { count: 3, lostTokens: 110_000, extraUsd: 0.4, byCause: { other: { count: 1, lostTokens: 60_000, extraUsd: 0.2 }, idle: { count: 1, lostTokens: 40_000, extraUsd: 0.1 }, compaction: { count: 1, lostTokens: 10_000, extraUsd: 0.1 } } },
    ];
    const totals = breakTotals(stored);
    assert.deepEqual(totals, { breaks: 4, lostTokens: 160_000, extraUsd: 0.6 });
    const r = cacheHealth({ hitRate: 0.9, promptTokens: 1_000_000, breaks: [br, { ...br, sessionId: "s2", structural: "tools-changed", notRead: true }], totals });
    assert.deepEqual([r.breaks, r.lostTokens, r.extraUsd, r.breaksNotRead, r.avoidableTokens], [4, 160_000, 0.6, 1, 100_000]);
    assert.equal(r.causes[1]!.example!.command, "coding.sh diff-calls s1-a s1-b", "a break that was not read still names its two calls");
    assert.deepEqual([r.score, r.grade], [84, "B"]);
    assert.equal(cacheHealth({ hitRate: 0.9, promptTokens: 1_000_000, breaks: [br] }).score, 92);
    // A break on a model with no price leaves the USD total out, as in one session's stats.
    assert.equal(breakTotals([stored[0]!, { count: 1, lostTokens: 9_000, unpriced: 1, byCause: { other: { count: 1, lostTokens: 9_000 } } }]).extraUsd, undefined);
    assert.equal(cacheHealth({ promptTokens: 10, breaks: [] }).breaksNotRead, undefined);
  });
});

describe("cache doctor (CLI)", () => {
  let env: TmpEnv;
  const stored: Session[] = [];
  before(async () => {
    env = tmpEnv();
    const ctx = await openContext({ env: process.env });
    try {
      const sessions: AgentEvent[][] = [
        await calls(ctx.blobs, "c-volatile", [0, 1, 2, 3, 4].map((i) => miss({ system: clock(i) }))),
        await calls(ctx.blobs, "c-reorder", [miss(), hit(), miss({ tools: [TOOLS[1], TOOLS[0]] })]),
        await calls(ctx.blobs, "c-switch", [miss({ model: "claude-opus-4-5" }), miss({ model: "claude-haiku-4-5" })]),
        await calls(ctx.blobs, "x-clean", Array.from({ length: 10 }, (_, i) => (i === 0 ? miss({ agent: "codex" }) : hit({ agent: "codex" })))),
        // Stored requests whose breaks are not avoidable (the same prefix, a wait), next to one that is.
        await calls(ctx.blobs, "o-volatile", [0, 1, 2].map((i) => miss({ agent: "opencode", system: clock(i) }))),
        await calls(ctx.blobs, "o-same", [miss({ agent: "opencode" }), miss({ agent: "opencode" })]),
        await calls(ctx.blobs, "o-idle", [miss({ agent: "opencode" }), miss({ agent: "opencode", at: 20 })]),
        await calls(ctx.blobs, "o-edit", [miss({ agent: "opencode" }), hit({ agent: "opencode" }), miss({ agent: "opencode", reset: true })]),
        // No stored requests at all: transcripts, as a hook or backfill capture leaves them.
        ...(await Promise.all(["t-1", "t-2", "t-3"].map((sid) => calls(ctx.blobs, sid, [miss({ agent: "pi", mode: "transcript" }), miss({ agent: "pi", mode: "transcript" }), miss({ agent: "pi", mode: "transcript", at: 30 })])))),
      ];
      for (const ev of sessions) {
        await ctx.index.putEvents(ev);
        const s = buildSession(ev);
        stored.push(s);
        await ctx.index.upsertSession(s);
      }
    } finally {
      await ctx.close();
    }
  });
  after(() => env.restore());

  test("--agent claude-code: hit rate, grade and causes ranked, reconciling with usage and stats", () => {
    const r = JSON.parse(ok(["cache", "doctor", "--agent", "claude-code", "--json"]).stdout);
    assert.equal(typeof r.hitRate, "number");
    assert.match(r.grade, /^[A-F]$/);
    assert.equal(r.causes[0].cause, "system-volatile-line");
    assert.deepEqual(r.causes.map((c: { cause: string }) => c.cause).sort(), ["model-switch", "system-volatile-line", "tools-reordered"]);
    for (const c of r.causes) for (const k of ["count", "sessions", "lostTokens", "extraUsd", "fix", "example"]) assert.ok(k in c, `${c.cause} has ${k}`);
    // The hit rate is usage's CACHE READ over the same sessions.
    const u = JSON.parse(ok(["usage", "--agent", "claude-code", "--json"]).stdout);
    assert.equal(r.hitRate, u.total.cacheReadShare);
    // Tokens and USD are the stored stats' own.
    const mine = stored.filter((s) => s.agent === "claude-code");
    assert.equal(r.lostTokens, mine.reduce((n, s) => n + (s.stats.cacheBreaks?.lostTokens ?? 0), 0));
    const usd = mine.reduce((n, s) => n + (s.stats.cacheBreaks?.extraUsd ?? 0), 0);
    assert.ok(Math.abs(r.extraUsd - usd) < 1e-6, `${r.extraUsd} vs ${usd}`);
    assert.equal(r.degraded, 0);
    // The example names two calls diff-calls can read.
    const d = JSON.parse(ok(["diff-calls", r.causes[0].example.a, r.causes[0].example.b, "--json"]).stdout);
    assert.equal(d.content, "full");
    assert.equal(d.system.same, false);
  });

  test("the human form exits 0 with the hit rate, grade, the table and a diff-calls example per cause", () => {
    const r = cli(["cache", "doctor", "--agent", "claude-code"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Prompt cache: \d+% hit rate, grade [A-F] \(\d+\/100\)\n/);
    assert.match(r.stdout, /CAUSE\s+BREAKS\s+SESSIONS\s+RE-BILLED\s+EXTRA/);
    assert.match(r.stdout, /\n1\. system-volatile-line: keep changing values/);
    assert.match(r.stdout, /e\.g\. coding\.sh diff-calls c-volatile-call-\d c-volatile-call-\d/);
  });

  test("a clean setup grades A with no avoidable causes; an unknown agent has no sessions", () => {
    const r = JSON.parse(ok(["cache", "doctor", "--agent", "codex", "--json"]).stdout);
    assert.equal(r.grade, "A");
    assert.deepEqual(r.causes, []);
    assert.equal(r.avoidableTokens, 0);
    const none = cli(["cache", "doctor", "--agent", "cursor"]);
    assert.equal(none.status, 0);
    assert.match(none.stderr, /No sessions in the last 30d that match/);
  });

  const GRADED = ["sessions", "hitRate", "promptTokens", "breaks", "lostTokens", "extraUsd", "avoidableTokens", "avoidableShare", "score", "grade"];
  const doctor = (...args: string[]) => JSON.parse(ok(["cache", "doctor", "--json", ...args]).stdout);
  const causes = (r: { causes: { cause: string; count: number }[] }) => r.causes.map((c) => [c.cause, c.count]);

  test("--limit bounds the sessions whose requests are read, not the totals or the grade", () => {
    const full = doctor("--agent", "claude-code");
    const one = doctor("--agent", "claude-code", "--limit", "1");
    assert.equal(full.sessionsNotRead, undefined);
    assert.equal(one.sessionsNotRead, 2);
    // The headline is usage's, over every session in the window.
    const u = JSON.parse(ok(["usage", "--agent", "claude-code", "--json"]).stdout).total;
    assert.equal(one.breaks, 6);
    assert.equal(one.breaksNotRead, 2);
    assert.equal(one.breaks, u.cacheBreaks);
    assert.equal(one.lostTokens, u.cacheBreakTokens);
    assert.ok(Math.abs(one.extraUsd - u.cacheBreakUsd) < 1e-4, `${one.extraUsd} vs ${u.cacheBreakUsd}`);
    for (const k of GRADED) assert.equal(one[k], full[k], k);
    // The costliest session is diffed; the reorder past the limit shows in the tools hash, without
    // its detail, and the model switch in the two calls' models. Each still names two calls to diff.
    assert.deepEqual(causes(one), [["system-volatile-line", 4], ["tools-changed", 1], ["model-switch", 1]]);
    assert.deepEqual(causes(full), [["system-volatile-line", 4], ["tools-reordered", 1], ["model-switch", 1]]);
    assert.equal(one.causes.reduce((n: number, c: { lostTokens: number }) => n + c.lostTokens, 0), one.lostTokens);
    assert.ok(one.causes.every((c: { example?: unknown }) => c.example !== undefined));
    const r = cli(["cache", "doctor", "--agent", "claude-code", "--limit", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /: 6 cache breaks re-billed /);
    assert.match(r.stdout, /\n2\. tools-changed: keep tool descriptions and schemas byte-for-byte stable/);
    assert.match(r.stderr, /Read the stored requests of the 1 costliest session with breaks; 2 more not read \(--limit\): 2 breaks are classified from hashes, message counts, the model and timing there, and the totals and the grade count them/);
  });

  test("a break that is not avoidable stays so past --limit: the same prefix, a wait", () => {
    const full = doctor("--agent", "opencode");
    // The same prefix inside the cache lifetime and the idle gap are not avoidable; the timestamp and the edit are.
    assert.deepEqual(causes(full), [["system-volatile-line", 2], ["history-rewritten", 1], ["idle", 1], ["other", 1]]);
    assert.ok(full.avoidableTokens > 0 && full.avoidableTokens < full.lostTokens);
    for (const n of ["1", "2", "3"]) {
      const some = doctor("--agent", "opencode", "--limit", n);
      for (const k of GRADED) assert.equal(some[k], full[k], `--limit ${n}: ${k}`);
      assert.equal(some.sessionsNotRead, 4 - Number(n));
      assert.deepEqual(some.causes.filter((c: { avoidable: boolean }) => !c.avoidable).map((c: { cause: string }) => c.cause), ["idle", "other"], `--limit ${n}`);
    }
  });

  test("sessions with no stored requests read the same at any --limit", () => {
    const full = doctor("--agent", "pi");
    assert.deepEqual(causes(full), [["idle", 3], ["other", 3]]);
    assert.equal(full.avoidableTokens, 0);
    assert.equal(full.degraded, 6);
    // Nothing is left unread: no count of it, no note, and the same report.
    for (const n of ["1", "2"]) assert.deepEqual({ ...doctor("--agent", "pi", "--limit", n), since: full.since }, full, `--limit ${n}`);
    const r = cli(["cache", "doctor", "--agent", "pi", "--limit", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /none of them avoidable/);
    assert.doesNotMatch(r.stderr, /--limit/);
  });

  test("an unknown action is a usage error", () => {
    assert.equal(cli(["cache", "nope"]).status, 2);
  });
});
