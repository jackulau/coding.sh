// diff-calls reads b as a later call in a's conversation. Two calls named the other way round, or
// taken from two sessions, get a warning under the diff; the first also gets the command with the
// two calls swapped, as the user's shell runs it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok } from "../query/_seed.ts";

const T = Date.now() - 2 * 3_600_000;

/** A proxy session of `n` model calls a minute apart, in metadata mode (hashes and counts, no stored request). */
function session(sid: string, startMin: number, n: number): AgentEvent[] {
  return Array.from({ length: n }, (_, i): AgentEvent => ({
    id: `${sid}-call-${i + 1}`,
    v: 0,
    sessionId: sid,
    ts: T + (startMin + i) * 60_000,
    durationMs: 1000,
    agent: "claude-code",
    kind: "llm.call",
    source: "proxy",
    model: "claude-sonnet-4-5",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: i === 0 ? 0 : 8_000, cacheWriteTokens: i === 0 ? 8_000 : 200 },
    payload: { provider: "anthropic", api: "messages", systemHash: "sys1", toolsHash: "tools1", toolNames: ["Bash", "Read"], messageCount: 2 * i + 1 },
  }));
}

let env: TmpEnv;
before(async () => {
  env = tmpEnv();
  const ctx = await openContext({ env: process.env });
  try {
    for (const ev of [session("pair-one", 0, 3), session("pair-two", 10, 2)]) {
      await ctx.index.putEvents(ev);
      await ctx.index.upsertSession(buildSession(ev));
    }
  } finally {
    await ctx.close();
  }
});
after(() => env.restore());

// As PowerShell runs the CLI: no MSYSTEM or SHELL, not started by npx.
const powershell = { MSYSTEM: "", SHELL: "", npm_command: "" };
const bin = process.platform === "win32" ? "codingsh" : "coding.sh";
const BACKWARDS = /^! b ran before a, so it could not read anything a cached: the Cache and Why rows do not apply$/m;
const SESSIONS = /^! a and b are from different sessions: b can read from the cache only the prefix the two requests share, and a history that differs is the other conversation, not an edit$/m;

test("b before a: a warning, and the command with the calls swapped for the user's shell", () => {
  const r = ok(["diff-calls", "pair-one-call-3", "pair-one-call-2"], powershell);
  assert.match(r.stdout, /^Cache {5}/m, "the diff still prints");
  assert.match(r.stderr, BACKWARDS);
  assert.doesNotMatch(r.stderr, SESSIONS);
  assert.ok(r.stderr.includes(`  Name the earlier call first:\n    ${bin} diff-calls pair-one-call-2 pair-one-call-3\n`), r.stderr);
});

test("two sessions: a warning that b shares only the common prefix, and no swap when a ran first", () => {
  const r = ok(["diff-calls", "pair-one-call-3", "pair-two-call-2"], powershell);
  assert.match(r.stderr, SESSIONS);
  assert.doesNotMatch(r.stderr, BACKWARDS);
  assert.doesNotMatch(r.stderr, /earlier call first/);
  // Both, named the other way round.
  const both = ok(["diff-calls", "pair-two-call-2", "pair-one-call-3"], powershell);
  assert.match(both.stderr, BACKWARDS);
  assert.match(both.stderr, SESSIONS);
  assert.ok(both.stderr.includes(`${bin} diff-calls pair-one-call-3 pair-two-call-2`), both.stderr);
});

test("a later call of the same session, named or found, prints no warning", () => {
  for (const args of [["pair-one-call-2", "pair-one-call-3"], ["pair-one-call-3"], ["pair-one-call-1", "pair-one-call-3"]]) {
    const r = ok(["diff-calls", ...args], powershell);
    assert.doesNotMatch(r.stderr, /^! /m, `${args.join(" ")}: ${r.stderr}`);
  }
});

test("--json prints no warning; the order and the sessions are in the object", () => {
  const r = ok(["diff-calls", "pair-two-call-2", "pair-one-call-3", "--json"], powershell);
  assert.doesNotMatch(r.stderr, /^! /m);
  const d = JSON.parse(r.stdout);
  assert.ok(d.cache.gapMs < 0, `gapMs ${d.cache.gapMs}`);
  assert.notEqual(d.a.sessionId, d.b.sessionId);
});
