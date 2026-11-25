// Folding a session (core/sessions.ts foldSession, sessionOf, buildSession), checked on real sessions
// and on generated ones. The real ones: every spool fixture under test/fixtures/adapters normalized by
// its adapter, and the Claude Code and Codex transcript fixtures read by their backfill, stored as
// ingest stores them (source "transcript") and priced as ingest prices them (core/pricing.ts
// applyPricing). Each case takes one session, drops some of its events (a lost hook line), and splits
// the rest into batches. The properties:
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
// The generated sessions are small, and each is checked against what the docs say its row holds:
// - A session a host app drove (payload.via: T3 Code) is the agent the host ran: the first event from
//   another agent, else the agent the host's events name (payload.provider), unless the host thread
//   started none (a host-link with no provider thread) or names none it knows ("unknown"). Session.host
//   is the host then, and provider the agent; otherwise the session is the host's, with no host. A
//   session no host drove is the agent of its first event that is no durable engine's span.
// - A session's parent is the one its first session.start names, unless that start is a spawn marker
//   an older ingest stamped (spool/spawned.ts); with none, a subagent's id names it
//   (`<parent>:sub:<agentId>`, neither part empty); else the first call the proxy saw that names
//   another session.
// - A session reports what its own events say: its last test run's counts (a count that is no finite
//   number reads 0; none without a test run), how the agent was launched (a host's launch wins over
//   the first session.start that says), and a fork's inherited tokens (the first count a fork notice
//   gives that is above 0: one of 0, below 0 or not finite is skipped). A gateway's copy of an event
//   reports nothing.
//
// CODING_SH_PROP_RUNS=n runs n cases per test (default 30, more for the generated sessions);
// CODING_SH_PROP_SEED=s replays one.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { applyPricing, pricesFor } from "../../src/core/pricing.ts";
import { buildSession, byTime, foldSession, sessionOf, sessionState, type SessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import type { EventKind } from "../../src/schema/index.ts";
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

/** When the generated sessions start. */
const T0 = Date.UTC(2026, 0, 5);

/** A generated event: what the fold reads to name a session's agent, its host and what the host ran. */
interface HostEvent {
  agent: string;
  kind: EventKind;
  /** Seconds after T0: events often share a second. */
  at: number;
  /** payload.via, the host app that drove the agent ("" names none). */
  via?: string;
  /** A notification's payload.type and payload.t3ProviderThreadId (the agent run a host-link names). */
  type?: string;
  thread?: string;
  /** payload.provider: the agent the host names, or something that names none. */
  provider?: unknown;
  /** A durable engine's tag (payload.durable), on an event with no span. */
  durable: boolean;
}

const hostEventGen: Gen<HostEvent> = gen.record<HostEvent>({
  agent: gen.frequency<string>([3, gen.constant("t3code")], [1, gen.constant("claude-code")], [1, gen.constant("codex")]),
  kind: gen.pick<EventKind>(["notification", "notification", "session.start", "user.message", "llm.call", "turn.end"]),
  at: gen.int(0, 4),
  via: gen.pick([undefined, "t3code", "t3code", "", "codex"]),
  type: gen.pick([undefined, "host-link", "host-link", "usage-summary"]),
  thread: gen.pick([undefined, "pt-1"]),
  provider: gen.pick<unknown>([undefined, undefined, "claude-code", "codex", "unknown", "t3code", "", 5]),
  durable: gen.weighted(0.3),
});

/** A session's events: in 2 sessions in 5 no event names a host, in 1 the host's own events are all. */
const hostSessionGen: Gen<HostEvent[]> = gen.map(
  gen.tuple(gen.pick(["hostless", "hostless", "alone", "mixed", "mixed"] as const), gen.array(hostEventGen, { minLength: 1, maxLength: 6 })),
  ([mode, hs]) => hs.map((h) => (mode === "hostless" ? { ...h, via: h.via && undefined } : mode === "alone" ? { ...h, agent: "t3code", via: h.via && "t3code" } : h)),
);

function hostEvents(hs: HostEvent[]): AgentEvent[] {
  return hs.map((h, i): AgentEvent => {
    const payload: Record<string, unknown> = {};
    if (h.via !== undefined) payload.via = h.via;
    if (h.kind === "notification" && h.type !== undefined) payload.type = h.type;
    if (h.kind === "notification" && h.thread !== undefined) payload.t3ProviderThreadId = h.thread;
    if (h.provider !== undefined) payload.provider = h.provider;
    // With no span the session has no durable run (core/durable.ts reads spans), only a tagged event.
    if (h.durable) payload.durable = { engine: "restate", run: "run-1", role: "other" };
    return { id: `host-${i}`, v: 0, sessionId: "host-session", ts: T0 + h.at * 1000, agent: h.agent, kind: h.kind, payload };
  });
}

interface HostRow {
  agent: string;
  host: string | undefined;
  provider: string | undefined;
}

/**
 * The agent, host and provider of a session's row, from the docs of Session.host and Session.provider
 * and of the fold's hostedAgent, with how they were found.
 */
function hostOf(sorted: AgentEvent[]): { want: HostRow; why: string } {
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const via = sorted.map((e) => text(e.payload.via)).find((v) => v !== undefined);
  if (via === undefined) {
    const own = sorted.find((e) => e.payload.durable === undefined);
    const first = must(sorted[0]);
    return { want: { agent: (own ?? first).agent, host: undefined, provider: undefined }, why: own && own !== first && own.agent !== first.agent ? "durable first" : "no host" };
  }
  const named = sorted.map((e) => text(e.payload.provider)).find((p) => p !== undefined);
  const other = sorted.find((e) => e.agent !== via)?.agent;
  // A host-link the host's events carry with no provider thread: the thread started no agent.
  const bare = sorted.some((e) => text(e.payload.via) !== undefined && e.payload.type === "host-link" && e.payload.t3ProviderThreadId === undefined);
  const known = named !== undefined && named !== "unknown" && named !== via;
  const ran = other ?? (!bare && known ? named : undefined);
  const why = other ? "another agent" : ran ? "named" : bare && known ? "bare" : "names none";
  return { want: ran === undefined ? { agent: via, host: undefined, provider: named } : { agent: ran, host: via, provider: ran }, why };
}

test("a session a host app drove is the agent it ran, with the host as its host", async (t) => {
  const seen: Record<string, number> = { "no host": 0, "durable first": 0, "another agent": 0, named: 0, bare: 0, "names none": 0 };
  await forAll(
    hostSessionGen,
    (hs) => {
      const events = hostEvents(hs);
      const { want, why } = hostOf(byTime(events));
      seen[why]!++;
      const row = buildSession(events);
      assert.deepEqual({ agent: row.agent, host: row.host, provider: row.provider }, want, why);
    },
    { runs: 1000, label: "host" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

type Parent = NonNullable<Session["parent"]>;

/** Session ids, and the parent each names as `<parent>:sub:<agentId>`, neither part empty. */
const SUB_IDS: readonly (readonly [string, Parent | undefined])[] = [
  ["s-1", undefined],
  ["p-1:sub:a-1", { sessionId: "p-1", subagentId: "a-1", type: "subagent" }],
  ["p-1:sub:a-1:sub:a-2", { sessionId: "p-1:sub:a-1", subagentId: "a-2", type: "subagent" }],
  [":sub:a-1", undefined],
  ["p-1:sub:", undefined],
];

/** A generated event: what the fold reads to find a session's parent. */
interface ParentEvent {
  kind: "session.start" | "llm.call" | "user.message";
  /** Seconds after T0. */
  at: number;
  /** payload.parentSessionId: another session, this one ("self"), or no id. */
  parent: unknown;
  /** A model call's source: "proxy" for a call the proxy saw. */
  source: string | undefined;
  /** A session.start's payload.subagentType, and whether it names the agent that spawned it. */
  subagentType: string | undefined;
  parentAgent: boolean;
  /** The subagent the event belongs to, and a model call's payload.agentId and agentType. */
  subagentId: string | undefined;
  agentId: unknown;
  agentType: unknown;
}

const parentEventGen: Gen<ParentEvent> = gen.record<ParentEvent>({
  kind: gen.pick(["session.start", "session.start", "llm.call", "llm.call", "user.message"] as const),
  at: gen.int(0, 3),
  parent: gen.pick<unknown>([undefined, "parent-1", "parent-2", "self", 7]),
  source: gen.pick([undefined, "proxy", "proxy", "hook"]),
  subagentType: gen.pick([undefined, "Explore", "harness", "harness"]),
  parentAgent: gen.weighted(0.5),
  subagentId: gen.pick([undefined, "sa-1"]),
  agentId: gen.pick<unknown>([undefined, "agent-1", 3]),
  agentType: gen.pick<unknown>([undefined, "general-purpose", false]),
});

function parentEvents(id: string, idParent: Parent | undefined, ps: ParentEvent[]): AgentEvent[] {
  return ps.map((p, i): AgentEvent => {
    // When a subagent's id names its parent, its model calls name no other: which of the two came first
    // would win, an order no doc gives.
    const other = typeof p.parent === "string" && p.parent !== "self";
    const parent = p.parent === "self" ? id : idParent && p.kind === "llm.call" && other ? undefined : p.parent;
    const payload: Record<string, unknown> = {};
    if (parent !== undefined) payload.parentSessionId = parent;
    if (p.kind === "session.start" && p.subagentType !== undefined) payload.subagentType = p.subagentType;
    if (p.kind === "session.start" && p.parentAgent) payload.parentAgent = "claude-code";
    if (p.kind === "llm.call" && p.agentId !== undefined) payload.agentId = p.agentId;
    if (p.kind === "llm.call" && p.agentType !== undefined) payload.agentType = p.agentType;
    const e: AgentEvent = { id: `parent-${i}`, v: 0, sessionId: id, ts: T0 + p.at * 1000, agent: "claude-code", kind: p.kind, payload };
    if (p.kind === "llm.call" && p.source !== undefined) e.source = p.source;
    if (p.subagentId !== undefined) e.subagentId = p.subagentId;
    return e;
  });
}

/** A spawn marker an older ingest stamped (spool/spawned.ts): the session it names is not the parent. */
const isMarker = (e: AgentEvent) => e.kind === "session.start" && e.payload.subagentType === "harness" && typeof e.payload.parentAgent === "string";
/** A call the proxy saw that names a session other than its own. */
const namesOther = (e: AgentEvent) => e.kind === "llm.call" && e.source === "proxy" && typeof e.payload.parentSessionId === "string" && e.payload.parentSessionId !== e.sessionId;

/**
 * The parent a session's row names, from the docs of parentOf and the fold: the first session.start
 * that names one and is no spawn marker; with none, a subagent's id; else the first call the proxy saw
 * that names another session.
 */
function parentWant(idParent: Parent | undefined, sorted: AgentEvent[]): { want: Parent | undefined; why: string } {
  const start = sorted.find((e) => e.kind === "session.start" && typeof e.payload.parentSessionId === "string" && !isMarker(e));
  if (start) {
    const want: Parent = { sessionId: start.payload.parentSessionId as string };
    if (start.subagentId) want.subagentId = start.subagentId;
    if (typeof start.payload.subagentType === "string") want.type = start.payload.subagentType;
    return { want, why: "session.start" };
  }
  if (idParent) return { want: idParent, why: "id" };
  const call = sorted.find(namesOther);
  if (!call) return { want: undefined, why: "none" };
  const want: Parent = { sessionId: call.payload.parentSessionId as string };
  const sub = call.subagentId ?? (typeof call.payload.agentId === "string" ? call.payload.agentId : undefined);
  if (sub) want.subagentId = sub;
  if (typeof call.payload.agentType === "string") want.type = call.payload.agentType;
  return { want, why: "proxy" };
}

test("a session's parent is the one its session.start names, else its id's, else the proxy's", async (t) => {
  const seen: Record<string, number> = { "session.start": 0, id: 0, proxy: 0, none: 0, "a spawn marker": 0, "a proxy call after a session.start": 0, "a proxy call naming its own session": 0, "an id that names none": 0 };
  await forAll(
    gen.tuple(gen.pick(SUB_IDS), gen.array(parentEventGen, { minLength: 1, maxLength: 5 })),
    ([[id, idParent], ps]) => {
      const events = parentEvents(id, idParent, ps);
      const sorted = byTime(events);
      const { want, why } = parentWant(idParent, sorted);
      seen[why]!++;
      if (why !== "session.start" && sorted.some((e) => isMarker(e) && e.payload.parentSessionId !== undefined)) seen["a spawn marker"]!++;
      if (why === "session.start" && sorted.some(namesOther)) seen["a proxy call after a session.start"]!++;
      if (sorted.some((e) => e.kind === "llm.call" && e.source === "proxy" && e.payload.parentSessionId === id)) seen["a proxy call naming its own session"]!++;
      if (why !== "session.start" && (id === ":sub:a-1" || id === "p-1:sub:")) seen["an id that names none"]!++;
      assert.deepEqual(buildSession(events).parent, want, why);
    },
    { runs: 1000, label: "parent" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** What a row reports of its last test run, its launch and a fork's inherited context. */
type Reports = Pick<Session["stats"], "testsPassed" | "testsFailed" | "launch" | "inheritedTokens">;

/** session.start payloads, and how each says the agent was launched (the doc of launchOf). */
const STARTS: readonly (readonly [Record<string, string>, Reports["launch"]])[] = [
  [{}, undefined],
  [{ entrypoint: "cli" }, "interactive"],
  [{ entrypoint: "sdk-ts" }, "headless"],
  [{ entrypoint: "remote" }, undefined],
  [{ launch: "exec" }, "headless"],
  [{ originator: "codex_vscode" }, "interactive"],
];

/** A generated event that reports something: a test run, a session.start or a notification. */
interface ReportEvent {
  kind: "test.result" | "session.start" | "notification";
  /** Seconds after T0. */
  at: number;
  /** A gateway's copy of the event (source "gateway", enrichment), not one of the session's own. */
  copy: boolean;
  /** A test run's payload.passed and payload.failed: counts, or values that are no count. */
  passed: unknown;
  failed: unknown;
  /** A session.start's payload, and the launch it says. */
  start: readonly [Record<string, string>, Reports["launch"]];
  /** A notification: a fork's notice, a host's link or another host notice. */
  note: "fork" | "host-link" | "usage-summary";
  /** A fork notice's payload.inheritedTokens, and a host notice's payload.launch. */
  inherited: unknown;
  launch: unknown;
}

const reportEventGen: Gen<ReportEvent> = gen.record<ReportEvent>({
  kind: gen.pick(["test.result", "test.result", "session.start", "notification", "notification"] as const),
  at: gen.int(0, 4),
  copy: gen.weighted(1 / 6),
  passed: gen.pick<unknown>([undefined, 0, 3, 12, "4", NaN, Infinity, null]),
  failed: gen.pick<unknown>([undefined, 0, 1, 5, "2", NaN]),
  start: gen.pick(STARTS),
  note: gen.pick(["fork", "fork", "host-link", "host-link", "usage-summary"] as const),
  // A count the session keeps (above 0), one it skips (0, below 0 or not finite), or none that is a number.
  inherited: gen.frequency<unknown>([3, gen.pick<unknown>([1200, 54000])], [3, gen.pick<unknown>([0, -300, NaN, Infinity])], [2, gen.pick<unknown>([undefined, "800"])]),
  launch: gen.pick<unknown>([undefined, "interactive", "headless", "batch"]),
});

function reportEvents(rs: ReportEvent[]): AgentEvent[] {
  return rs.map((r, i): AgentEvent => {
    const payload: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => {
      if (v !== undefined) payload[k] = v;
    };
    if (r.kind === "test.result") {
      put("passed", r.passed);
      put("failed", r.failed);
    } else if (r.kind === "session.start") Object.assign(payload, r.start[0]);
    else if (r.note === "fork") {
      payload.kind = "fork";
      put("inheritedTokens", r.inherited);
    } else {
      payload.type = r.note;
      put("launch", r.launch);
    }
    const e: AgentEvent = { id: `report-${i}`, v: 0, sessionId: "report-session", ts: T0 + r.at * 1000, agent: "claude-code", kind: r.kind, payload };
    if (r.copy) e.source = "gateway";
    return e;
  });
}

const isCount = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** A host-link's launch, which wins over a session.start's. */
const hostLaunchOf = (r: ReportEvent) => (r.kind === "notification" && r.note === "host-link" && (r.launch === "interactive" || r.launch === "headless") ? r.launch : undefined);
/** A fork notice's tokens, when it gives a number. */
const forkTokensOf = (r: ReportEvent) => (r.kind === "notification" && r.note === "fork" && typeof r.inherited === "number" ? r.inherited : undefined);
/** A fork notice's count that the session keeps: a finite number above 0. */
const isKeptCount = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0;

/**
 * What a session's events report, in time order, from the docs of Session.stats and the test.result
 * payload: the last test run's counts (one that is no finite number reads 0), how the agent was
 * launched (a host-link's launch wins over the first session.start that says), and the first count a
 * fork notice gives that is above 0 (one of 0, below 0 or not finite is skipped).
 */
function reportsOf(rs: ReportEvent[]): Reports {
  const run = rs.findLast((r) => r.kind === "test.result");
  const host = rs.map(hostLaunchOf).find((l) => l !== undefined);
  const start = rs.find((r) => r.kind === "session.start" && r.start[1] !== undefined)?.start[1];
  return {
    testsPassed: run && (isCount(run.passed) ? (run.passed as number) : 0),
    testsFailed: run && (isCount(run.failed) ? (run.failed as number) : 0),
    launch: host ?? start,
    inheritedTokens: rs.map(forkTokensOf).find(isKeptCount),
  };
}

test("a session reports its last test run, its launch and a fork's inherited tokens as its own events give them", async (t) => {
  const seen: Record<string, number> = {
    "a test run": 0,
    "a passed count that is no number": 0,
    "a failed count that is no number": 0,
    "a host's launch over a start's other one": 0,
    "a start's launch": 0,
    "a start that says none before one that says": 0,
    "a fork's tokens": 0,
    "a fork's count that is skipped, and none kept": 0,
    "a skipped count before a kept one": 0,
    "a kept count before another": 0,
    "a gateway's copy that would change it": 0,
  };
  await forAll(
    gen.array(reportEventGen, { minLength: 1, maxLength: 6 }),
    (rs) => {
      // The fold reads events in time order, keeping the order of events at the same time.
      const all = [...rs].sort((a, b) => a.at - b.at);
      // Enrichment never decides a session's shape: a gateway's copy reports nothing.
      const own = all.filter((r) => !r.copy);
      const want = reportsOf(own);
      const run = own.findLast((r) => r.kind === "test.result");
      if (run) seen["a test run"]!++;
      if (run && !isCount(run.passed)) seen["a passed count that is no number"]!++;
      if (run && !isCount(run.failed)) seen["a failed count that is no number"]!++;
      const starts = own.filter((r) => r.kind === "session.start");
      const start = starts.find((r) => r.start[1] !== undefined);
      const host = own.map(hostLaunchOf).find((l) => l !== undefined);
      if (host && start && host !== start.start[1]) seen["a host's launch over a start's other one"]!++;
      if (!host && start) seen["a start's launch"]!++;
      if (start && starts[0] !== start) seen["a start that says none before one that says"]!++;
      const counts = own.map(forkTokensOf).filter((n) => n !== undefined);
      const kept = counts.findIndex(isKeptCount);
      if (kept >= 0) seen["a fork's tokens"]!++;
      if (counts.length > 0 && kept < 0) seen["a fork's count that is skipped, and none kept"]!++;
      if (kept > 0) seen["a skipped count before a kept one"]!++;
      if (kept >= 0 && counts.slice(kept + 1).some(isKeptCount)) seen["a kept count before another"]!++;
      if (!isDeepStrictEqual(reportsOf(all), want)) seen["a gateway's copy that would change it"]!++;
      const { stats } = buildSession(reportEvents(rs));
      assert.deepEqual({ testsPassed: stats.testsPassed, testsFailed: stats.testsFailed, launch: stats.launch, inheritedTokens: stats.inheritedTokens }, want);
    },
    { runs: 1000, label: "reports" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
