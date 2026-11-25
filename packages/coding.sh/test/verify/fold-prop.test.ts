// Folding a session (core/sessions.ts foldSession, sessionOf, buildSession), checked on real sessions:
// every spool fixture under test/fixtures/adapters normalized by its adapter, and the Claude Code and
// Codex transcript fixtures read by their backfill, stored as ingest stores them (source "transcript")
// and priced as ingest prices them (core/pricing.ts applyPricing). Each case takes one session, drops
// some of its events (a lost hook line), and splits the rest into batches. The properties:
//
// - Two batches equal one. Ingest saves the fold of a session's events so far (core/ingest.ts
//   foldStoredSession, serialized with node:v8, only for a `simple` fold) and folds the next batch into
//   it, with the row the last batch gave as `prev`. The row at the end is the row one fold of every event
//   gives. Batches that arrive out of time order are folded again from every event, with the last row as
//   `prev`; that row changes nothing either. A batch that repeats events the store has (the same ids)
//   changes nothing.
// - Folding is deterministic. The same events give the same row when folded again, when read back as the
//   store keeps them (JSON), and when the row they gave is `prev` (a stored session folded again).
//   Folding leaves the events as they were.
// - A fold with no events of its own keeps the stored row's end. Every fold works the end out again
//   from the events; with none of its own (no events, or only enrichment: a gateway's copy of one),
//   the row's end stays, inferred (stats.endInferred) or not. Each session is checked whole, as
//   captured and without its session.end.
// - A stat stays absent when no event feeds it. Every optional stat a row has reports something: a
//   number that is not 0, a list with an item, an object with a field that does.
//
// CODING_SH_PROP_RUNS=n runs n cases per test (default 30); CODING_SH_PROP_SEED=s replays one.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { applyPricing, pricesFor } from "../../src/core/pricing.ts";
import { buildSession, byTime, foldSession, sessionOf, sessionState, type SessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { collect, FIXTURES, loadSpool, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { forAll, gen, type Gen } from "../_prop.ts";

/** Transcript fixtures and the variable that points each adapter's backfill at them. */
const BACKFILLS: { agent: string; env: string; dirs: string[] }[] = [
  { agent: "claude-code", env: "CLAUDE_CONFIG_DIR", dirs: ["config", "edge/config", "fallback/config", "fork/config", "hooks-real/config", "real/config", "stop/config", "subagents/config", "unapproved/config"] },
  { agent: "codex", env: "CODEX_HOME", dirs: ["home", "cut", "skill"] },
];

/** Stats every row has. */
const REQUIRED = new Set(["events", "turns", "toolCalls", "toolErrors", "filesChanged"]);
/** A test run's counts: 0 passed is a report when it comes with the failed count. */
const PAIRED = new Set(["testsPassed", "testsFailed"]);

let te: TmpEnv;
/** One entry per session with two events or more, in session id order. */
let corpus: { id: string; events: AgentEvent[] }[] = [];

/** A row as the store keeps it. */
const stored = (s: Session): Session => JSON.parse(JSON.stringify(s)) as Session;

/**
 * Reports nothing: absent, 0, an empty string or list, or an object none of whose fields reports. A
 * duration (a field ending in Ms) reports even at 0: it was measured (latency.wallMs of a one-event session).
 */
function empty(v: unknown, key = ""): boolean {
  if (typeof v === "number" && key.endsWith("Ms")) return false;
  if (v === undefined || v === null || v === 0 || v === "" || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.entries(v).every(([k, x]) => empty(x, k));
  return false;
}

/** One case: a session, the events kept, and how they arrive. */
interface FoldCase {
  session: number;
  /** Per event in time order: kept (true) or dropped. */
  keep: boolean[];
  /** Where the time-ordered batches end, as indices into the kept events. */
  cuts: number[];
  /** Per kept event: the batch it arrives in when batches come out of time order. */
  batch: number[];
  /** Kept events a later batch delivers again. */
  repeats: number[];
}

const caseGen: Gen<FoldCase> = gen.chain(
  gen.tuple(
    gen.int(0, 1 << 20),
    gen.pick([1, 0.9, 0.6, 0.25]),
  ),
  ([pick, keepRate]) => {
    const session = pick % corpus.length;
    const n = must(corpus[session]).events.length;
    return gen.record<FoldCase>({
      session: gen.constant(session),
      keep: gen.array(gen.weighted(keepRate), { minLength: n, maxLength: n }),
      cuts: gen.array(gen.int(0, n), { maxLength: 3 }),
      batch: gen.array(gen.int(0, 2), { minLength: n, maxLength: n }),
      repeats: gen.array(gen.int(0, Math.max(0, n - 1)), { maxLength: 4 }),
    });
  },
);

/** The kept events, in time order. */
function keptOf(c: FoldCase): AgentEvent[] {
  return byTime(must(corpus[c.session]).events).filter((_, i) => c.keep[i]);
}

before(async () => {
  te = tmpEnv();
  const adapters = new Map(ADAPTERS.map((a) => [a.id, a]));
  const events: AgentEvent[] = [];
  const spools = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".spool.jsonl")).sort();
  for (const rel of spools) {
    const { ctx } = testCtx();
    for (const [offset, line] of loadSpool(rel).entries()) {
      const adapter = adapters.get(line.agent);
      if (adapter) events.push(...(await adapter.normalize(line, { ...ctx, source: { file: rel, offset } })));
    }
  }
  for (const b of BACKFILLS) {
    const adapter = must(adapters.get(b.agent));
    for (const dir of b.dirs) {
      process.env[b.env] = join(FIXTURES, b.agent, dir);
      try {
        // As ingest stores a backfilled event (core/ingest.ts backfillEvent): source "transcript",
        // unless the adapter set one.
        for (const e of await collect(must(adapter.backfill)(testCtx().ctx))) events.push(e.source === undefined ? { ...e, source: "transcript" } : e);
      } finally {
        delete process.env[b.env];
      }
    }
  }
  const bySession = new Map<string, Map<string, AgentEvent>>();
  for (const e of applyPricing(events, pricesFor())) {
    const s = bySession.get(e.sessionId) ?? new Map<string, AgentEvent>();
    if (!s.has(e.id)) s.set(e.id, e);
    bySession.set(e.sessionId, s);
  }
  corpus = [...bySession]
    .filter(([, s]) => s.size >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]) => ({ id, events: [...s.values()] }));
  assert.ok(corpus.length >= 20, `only ${corpus.length} sessions in the fixtures`);
});

after(() => te.restore());

test("a fold saved and resumed batch by batch gives the row one fold of every event gives", async (t) => {
  let resumed = 0;
  await forAll(
    caseGen,
    (c) => {
      const sorted = keptOf(c);
      if (!sorted.length) return;
      // Batches in time order, as ingest folds a session that grows.
      let state = sessionState();
      let prev: Session | undefined;
      let i = 0;
      for (const cut of [...[...c.cuts].sort((a, b) => a - b), sorted.length]) {
        for (; i < Math.min(cut, sorted.length); i++) foldSession(state, must(sorted[i]));
        if (i === 0) continue;
        prev = stored(sessionOf(state, prev, state.simple ? undefined : sorted.slice(0, i)));
        // The store keeps a simple fold only, and ingest folds the next batch into what it read back.
        if (state.simple && i < sorted.length) {
          state = deserialize(serialize(state)) as SessionState;
          resumed++;
        }
      }
      assert.deepEqual(prev, stored(buildSession(sorted)));
    },
    { runs: 30, label: "fold resumed" },
  );
  t.diagnostic(`${corpus.length} sessions, ${corpus.reduce((a, s) => a + s.events.length, 0)} events; ${resumed} folds resumed`);
});

test("batches out of time order, with repeats, give the row of one batch", async () => {
  await forAll(
    caseGen,
    (c) => {
      const kept = keptOf(c);
      const store = new Map<string, AgentEvent>();
      let prev: Session | undefined;
      for (let b = 0; b <= 2; b++) {
        const batch = kept.filter((_, j) => c.batch[j] === b);
        for (const r of c.repeats) {
          const again = kept[r];
          if (again && (c.batch[r] ?? 0) < b) batch.push(again);
        }
        for (const e of batch) if (!store.has(e.id)) store.set(e.id, e);
        if (store.size) prev = stored(buildSession([...store.values()], prev));
      }
      if (!store.size) return;
      assert.deepEqual(prev, stored(buildSession([...store.values()])));
    },
    { runs: 30, label: "batches out of order" },
  );
});

test("folding is deterministic, keeps the events as they were, and a stored session folds to the same row", async () => {
  await forAll(
    caseGen,
    (c) => {
      const kept = keptOf(c);
      if (!kept.length) return;
      const before = structuredClone(kept);
      const row = buildSession(kept);
      assert.deepEqual(kept, before, "folding changed the events");
      assert.deepEqual(buildSession(kept), row, "a second fold differs");
      const asStored = JSON.parse(JSON.stringify(kept)) as AgentEvent[];
      assert.deepEqual(stored(buildSession(asStored)), stored(row), "the events as the store keeps them fold differently");
      assert.deepEqual(stored(buildSession(kept, stored(row))), stored(row), "folding again with the stored row as prev changed it");
    },
    { runs: 30, label: "deterministic" },
  );
});

test("a fold with no events of its own keeps the stored row's end, inferred or not", (t) => {
  const ends = { inferred: 0, recorded: 0, none: 0 };
  const endOf = (s: Session) => ({ endedAt: s.endedAt, endInferred: s.stats.endInferred });
  for (const { id, events } of corpus) {
    // As captured, and with no session.end (a transcript's quiet marker is one): some then end at
    // their last activity (stats.endInferred).
    for (const own of [byTime(events), byTime(events).filter((e) => e.kind !== "session.end")]) {
      if (!own.length) continue;
      const row = stored(buildSession(own));
      ends[row.endedAt === undefined ? "none" : row.stats.endInferred ? "inferred" : "recorded"]++;
      assert.deepEqual(endOf(buildSession([], row)), endOf(row), `${id}: a fold of no events changed the end`);
      // Enrichment never decides a session's shape: a gateway's copy of an event is not its own.
      for (const e of own) {
        const copy: AgentEvent = { ...e, id: `${e.id}:enriched`, source: "gateway" };
        assert.deepEqual(endOf(buildSession([copy], row)), endOf(row), `${id}: a fold of an enrichment copy of ${e.kind} ${e.id} changed the end`);
      }
    }
  }
  assert.ok(ends.inferred > 0 && ends.recorded > 0, `ends in the fixtures: ${JSON.stringify(ends)}`);
  t.diagnostic(`${ends.inferred} inferred ends, ${ends.recorded} recorded, ${ends.none} none`);
});

test("a stat a session has reports something", async () => {
  await forAll(
    caseGen,
    (c) => {
      const kept = keptOf(c);
      if (!kept.length) return;
      const stats = buildSession(kept).stats as Record<string, unknown>;
      const hollow = Object.keys(stats).filter((k) => !REQUIRED.has(k) && !PAIRED.has(k) && empty(stats[k]));
      assert.deepEqual(hollow, [], `stats that report nothing: ${hollow.map((k) => `${k}=${JSON.stringify(stats[k])}`).join(", ")}`);
    },
    { runs: 30, label: "absent when empty" },
  );
});

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
