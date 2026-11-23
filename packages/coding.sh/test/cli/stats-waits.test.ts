// `stats --json` adds `waits`: the window's waits on the person (Session.stats.waits), summed
// over the sessions that started in it and match --where, subagents included, and absent when
// none waited. The text table does not change. SQLite reads only the waits (metricRows); a store
// without metricRows reads whole sessions, and a read that stops at 100,000 sessions says so.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import * as stats from "../../src/cli/commands/stats.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore, Session } from "../../src/core/types.ts";
import { parseWhere } from "../../src/query/where.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { METRICS_SCAN_CAP } from "../../src/viewer/metrics.ts";
import { removeTestDir } from "../_rm.ts";
import { normalizeFixture } from "../adapters/more/_helpers.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const DAY = 86_400_000;
const MIN = 60_000;
const yesterday = Date.now() - DAY;
const at = (id: string, startedAt: number, extra: Parameters<typeof mkSession>[2] = {}) => mkSession(id, startedAt, extra);

let sb: Sandbox;
let gemini: Session;
/** The sessions seeded besides the recorded capture's. */
let seeded: Session[];
before(async () => {
  sb = sandbox();
  const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
  gemini = buildSession(events);
  seeded = [
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
  ];
  await sb.seed([...seeded, gemini], events);
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

test("on SQLite the waits come through metricRows: no session is read whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "csh-waits-"));
  const store = await SqliteIndexStore.open(join(dir, "index.db"));
  try {
    await store.migrate();
    for (const s of seeded) await store.upsertSession(s);
    const called = new Set<string>();
    const spy = new Proxy(store, {
      get(t, k) {
        const v = Reflect.get(t, k);
        return typeof v === "function" ? (...a: unknown[]) => (called.add(String(k)), v.apply(t, a)) : v;
      },
    });
    const since = Date.now() - 7 * DAY;
    assert.deepEqual(await stats.windowWaits(spy, since, Date.now(), undefined), window);
    assert.equal(await stats.windowWaits(spy, since, Date.now(), parseWhere("agent:codex")), undefined);
    assert.deepEqual([...called], ["metricRows"], "neither listSessions nor querySessions: no whole session");
    const rows = await store.metricRows({}, { filter: { since, until: Date.now() } });
    const waitsOf = (id: string) => rows.find((r) => r.id === id)?.waits;
    assert.deepEqual(waitsOf("top"), seeded.find((s) => s.id === "top")!.stats.waits);
    assert.equal(waitsOf("codex-run"), undefined);
  } finally {
    await store.close();
    removeTestDir(dir);
  }
});

test("a store without metricRows reads the waits from whole sessions: the same sums", async () => {
  const memory: IndexStore = new MemoryIndexStore();
  for (const s of seeded) await memory.upsertSession(s);
  assert.equal(memory.metricRows, undefined, "the scan path");
  const since = Date.now() - 7 * DAY;
  assert.deepEqual(await stats.windowWaits(memory, since, Date.now(), undefined), window);
  assert.equal(await stats.windowWaits(memory, since, Date.now(), parseWhere("agent:codex")), undefined);
});

/** A store with no metricRows that returns the same full page however far it is read: its scan never runs out. */
class Endless extends MemoryIndexStore {
  reads = 0;
  readonly page: Session[];
  constructor(page: Session[]) {
    super();
    this.page = page;
  }
  override async listSessions(): Promise<Session[]> {
    this.reads++;
    return this.page;
  }
}

test("a scan that stops at 100,000 sessions says so: truncated", async () => {
  const wait = { count: 1, ms: MIN, byKind: { turn: { count: 1, ms: MIN } } };
  const store = new Endless(Array.from({ length: 1000 }, (_, i) => at(`many-${i}`, yesterday, { stats: { waits: wait } })));
  const w = await stats.windowWaits(store, Date.now() - 7 * DAY, Date.now(), undefined);
  assert.equal(store.reads, METRICS_SCAN_CAP / 1000, "it stops at the cap");
  const n = METRICS_SCAN_CAP;
  const sum = { count: n, ms: n * MIN, minutes: n };
  assert.deepEqual(w, { sessions: n, ...sum, byKind: { turn: sum }, truncated: true });
});
