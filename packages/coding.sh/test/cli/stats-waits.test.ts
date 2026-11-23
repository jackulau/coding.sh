// `stats --json` adds `waits`: the window's waits on the person (Session.stats.waits), summed
// over the sessions that started in it and match --where, subagents included, and absent when
// none waited. The text table does not change.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import * as stats from "../../src/cli/commands/stats.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import { normalizeFixture } from "../adapters/more/_helpers.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const DAY = 86_400_000;
const MIN = 60_000;
const yesterday = Date.now() - DAY;
const at = (id: string, startedAt: number, extra: Parameters<typeof mkSession>[2] = {}) => mkSession(id, startedAt, extra);

let sb: Sandbox;
let gemini: Session;
before(async () => {
  sb = sandbox();
  const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
  gemini = buildSession(events);
  await sb.seed([
    at("top", yesterday, {
      stats: { waits: { count: 2, ms: 3 * MIN, byKind: { question: { count: 1, ms: MIN }, turn: { count: 1, ms: 2 * MIN } }, agent: { count: 1, ms: MIN / 2 }, steers: 1 } },
    }),
    // A subagent's permission prompt waits in the subagent's own session.
    at("top-sub", yesterday + MIN, {
      parent: { sessionId: "top", type: "Explore" },
      stats: { waits: { count: 1, ms: MIN / 2, byKind: { permission: { count: 1, ms: MIN / 2, open: 1 } }, open: { count: 1, ms: MIN / 2 } } },
    }),
    at("codex-run", yesterday, { agent: "codex" }),
    at("old", Date.now() - 40 * DAY, { stats: { waits: { count: 1, ms: 9 * MIN, byKind: { turn: { count: 1, ms: 9 * MIN } } } } }),
    gemini,
  ], events);
});
after(() => sb.cleanup());

const json = async (flags: Record<string, string | boolean>) => (await runCmd(stats, sb, { flags, json: true })).json;

const window = {
  sessions: 2,
  count: 3,
  ms: 210_000,
  minutes: 3.5,
  byKind: {
    permission: { count: 1, ms: 30_000, minutes: 0.5 },
    question: { count: 1, ms: 60_000, minutes: 1 },
    turn: { count: 1, ms: 120_000, minutes: 2 },
  },
  open: { count: 1, ms: 30_000, minutes: 0.5 },
  agent: { count: 1, ms: 30_000, minutes: 0.5 },
  steers: 1,
};

test("the window's waits by kind, with a subagent's in its own session and a session before the window left out", async () => {
  const j = await json({ since: "7d" });
  assert.equal(j.totals.sessions, 2, "the subagent rolls up into its session");
  assert.deepEqual(j.waits, window);
});

test("--all lists subagents as their own rows; the waits are the same", async () => {
  assert.deepEqual((await json({ since: "7d", all: true })).waits, window);
});

test("--where narrows the waits to the sessions it matches, and none left means no field", async () => {
  const j = await json({ since: "7d", where: "agent:codex" });
  assert.equal(j.totals.sessions, 1);
  assert.equal("waits" in j, false);
});

test("the text table does not print the waits", async () => {
  const r = await runCmd(stats, sb, { flags: { since: "7d" } });
  assert.doesNotMatch(r.stdout + r.stderr, /wait/i);
});

test("a recorded capture: the Gemini CLI session's unanswered permission prompt", async () => {
  const w = gemini.stats.waits!;
  const iso = (t: number) => new Date(t).toISOString();
  const j = await json({ since: iso(gemini.startedAt - DAY), until: iso(gemini.startedAt + DAY) });
  const shown = { count: 1, ms: w.ms, minutes: Math.round(w.ms / 6000) / 10 };
  assert.deepEqual(j.waits, { sessions: 1, ...shown, byKind: { permission: shown }, open: shown });
});
