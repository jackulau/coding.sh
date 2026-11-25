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
// - A row's trace ids are those of its own events, first seen first, after the stored row's when a fold
//   resumes one, and at most 256 (Session.traceIds). A gateway's copy adds none.
// - A session ends at its last session.end, unless activity stamped more than 5 s after it reopened
//   it. With none, or once reopened, a session whose own events all came live (OTel, an SDK or the
//   proxy) under an id that is none of their trace ids, or all from recorded history, ends at the end
//   of its last event (stats.endInferred); any other has no end. A gateway's copy changes none of it.
// - A session with a tool call still open did not finish: when it has no session.end, or its last one is
//   a transcript's quiet marker (reason "idle") or was reopened, it has no end, inferred or not. A call is
//   open from its first start until its end. A session.end that is no quiet marker closes every open
//   call, and the session ends there unless activity reopens it.
// - A session's model is the one most of its main-thread calls ran on (a call's response model, else
//   its own, else the one it asked for), the earlier one on a tie; with no main-thread call, the one
//   most calls ran on; with no call that names one, the last model an event named. stats.models counts
//   the calls by model when two or more ran them. A gateway's copy is no call of the session's.
// - A session's phases (stats.phases) count one copy of each call (core/call-copies.ts): with a call its
//   own capture recorded, they are the phases of its events without the proxy's copies, but for where
//   each starts and ends in the events; with none, the proxy's calls are its calls.
// - A shell call that writes files (a redirect, sed -i, tee) counts them when it ends, unless the user
//   stopped it or turned it down (it never ran); one with no usable id (none, an empty one, or one that
//   is no string) counts them as it starts, however it ends. stats.filesChanged counts a file once.
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

/** Session.traceIds holds at most this many. */
const TRACE_CAP = 256;
/** Trace ids t-0, t-1, …: the first n. */
const traceIdsOf = (n: number) => Array.from({ length: n }, (_, i) => `t-${i}`);
/** How many trace ids the stored row a fold resumes saw: no stored row, some, the cap, or more. */
const STORED_TRACES = [0, 120, 253, TRACE_CAP, 300] as const;
const storedRows = new Map<number, Session>();

/** The stored row of a session whose earlier events carried n trace ids, one each, in order. */
function storedRow(n: number): Session | undefined {
  if (n === 0) return undefined;
  let row = storedRows.get(n);
  if (!row) {
    const events = traceIdsOf(n).map((traceId, i): AgentEvent => ({ id: `stored-${i}`, v: 0, sessionId: "trace-session", ts: T0 - n + i, agent: "claude-code", kind: "notification", payload: {}, traceId }));
    storedRows.set(n, (row = buildSession(events)));
  }
  return row;
}

/** A new event: its trace id (none, one the stored row saw, or a new one), or a gateway's copy. */
interface TraceEvent {
  /** Seconds after T0. */
  at: number;
  trace: string | undefined;
  copy: boolean;
}

const traceEventGen: Gen<TraceEvent> = gen.record<TraceEvent>({
  at: gen.int(0, 4),
  trace: gen.frequency<string | undefined>(
    [1, gen.constant(undefined)],
    [1, gen.map(gen.int(0, 9), (i) => `t-${i}`)],
    [4, gen.map(gen.int(0, 11), (i) => `new-${i}`)],
  ),
  copy: gen.weighted(1 / 6),
});

test("a row keeps its events' trace ids first seen first, after the stored row's, and at most 256", async (t) => {
  // Folded from scratch, a session keeps the first ones.
  for (const n of STORED_TRACES) assert.deepEqual(storedRow(n)?.traceIds, n ? traceIdsOf(Math.min(n, TRACE_CAP)) : undefined, `${n} trace ids`);
  const seen: Record<string, number> = {
    "no stored row": 0,
    "a stored row with room": 0,
    "a new id past the cap": 0,
    "a full row and a new id": 0,
    "a stored id again": 0,
    "a gateway's copy with a new id": 0,
  };
  await forAll(
    gen.tuple(gen.pick(STORED_TRACES), gen.array(traceEventGen, { minLength: 1, maxLength: 14 })),
    ([n, rs]) => {
      const events = rs.map((r, i): AgentEvent => {
        const e: AgentEvent = { id: `trace-${i}`, v: 0, sessionId: "trace-session", ts: T0 + r.at * 1000, agent: "claude-code", kind: "notification", payload: {} };
        if (r.trace !== undefined) e.traceId = r.trace;
        if (r.copy) e.source = "gateway";
        return e;
      });
      const stored = traceIdsOf(Math.min(n, TRACE_CAP));
      // In time order, keeping the order of events at the same time; a gateway's copy adds none.
      const own = [...rs].sort((a, b) => a.at - b.at).flatMap((r) => (r.copy || r.trace === undefined ? [] : [r.trace]));
      const ids = [...new Set([...stored, ...own])];
      if (n === 0) seen["no stored row"]!++;
      else if (ids.length > stored.length && ids.length <= TRACE_CAP) seen["a stored row with room"]!++;
      if (ids.length > TRACE_CAP && stored.length < TRACE_CAP) seen["a new id past the cap"]!++;
      if (ids.length > TRACE_CAP && stored.length === TRACE_CAP) seen["a full row and a new id"]!++;
      if (own.some((id) => stored.includes(id))) seen["a stored id again"]!++;
      if (rs.some((r) => r.copy && r.trace !== undefined && !ids.includes(r.trace))) seen["a gateway's copy with a new id"]!++;
      const want = ids.slice(0, TRACE_CAP);
      assert.deepEqual(buildSession(events, storedRow(n)).traceIds, want.length ? want : undefined);
    },
    { runs: 1000, label: "traces" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** Activity over this long after a session.end reopens the session (outline.ts REOPEN_SLACK_MS). */
const REOPEN_SLACK = 5000;

/** Event sources by how a session was captured: live, from recorded history, by a hook, or a mix. */
const END_SOURCES = {
  live: ["otel-span", "otel-log", "sdk", "proxy"],
  history: ["transcript", "backfill", "store"],
  hook: [undefined],
  mixed: [undefined, "otel-span", "sdk", "proxy", "transcript"],
} as const;

/** A generated event: what the fold reads to find where a session ended. */
interface EndEvent {
  kind: "session.end" | "user.message" | "llm.call" | "turn.end" | "notification" | "tool.start" | "tool.end";
  /** Milliseconds after T0: two events are often 5 s or 5.001 s apart. */
  at: number;
  /** How long the event took, for one stamped at its start. */
  durationMs: number | undefined;
  source: string | undefined;
  /** The event's trace id: none, another trace, or the session's id (a trace-keyed OTel session). */
  trace: "none" | "other" | "own";
  /** A gateway's copy of the event. */
  copy: boolean;
}

const endEventGen = (sources: readonly (string | undefined)[]): Gen<EndEvent> =>
  gen.record<EndEvent>({
    kind: gen.pick(["session.end", "session.end", "user.message", "llm.call", "turn.end", "notification"] as const),
    at: gen.pick([0, 1000, 5000, 6000, 6001, 12000]),
    durationMs: gen.pick([undefined, undefined, 0, 2500, 8000]),
    source: gen.pick(sources),
    trace: gen.pick(["none", "none", "other", "own"] as const),
    copy: gen.weighted(1 / 6),
  });

const endSessionGen: Gen<EndEvent[]> = gen.chain(gen.pick(["live", "live", "history", "hook", "mixed"] as const), (how) =>
  gen.array(endEventGen(END_SOURCES[how]), { minLength: 1, maxLength: 5 }),
);

function endEvents(rs: EndEvent[]): AgentEvent[] {
  return rs.map((r, i): AgentEvent => {
    const e: AgentEvent = { id: `end-${i}`, v: 0, sessionId: "end-session", ts: T0 + r.at, agent: "claude-code", kind: r.kind, payload: {} };
    if (r.durationMs !== undefined) e.durationMs = r.durationMs;
    if (r.trace !== "none") e.traceId = r.trace === "own" ? "end-session" : "trace-1";
    const source = r.copy ? "gateway" : r.source;
    if (source !== undefined) e.source = source;
    return e;
  });
}

const isLive = (r: EndEvent) => r.source?.startsWith("otel") === true || r.source === "sdk" || r.source === "proxy";
const activityOf = (own: EndEvent[]) => own.filter((r) => r.kind !== "session.end");

/**
 * Where a session ended, from the docs of Session.endedAt, stats.endInferred and the reopen slack,
 * given its own events in time order (no tool call left open: see endOfCalls): at its last
 * session.end, unless activity stamped more than 5 s after it reopened it. With no session.end, or
 * once reopened, a session whose events all came live under an id that is none of their trace ids, or
 * all from recorded history, ends at the end of its last event; any other has no end.
 */
function endOf(own: EndEvent[]): { endedAt: number | undefined; endInferred: true | undefined; why: string } {
  const end = own.findLast((r) => r.kind === "session.end");
  // Activity counts from when it was stamped: a span that began before the end is no resume.
  const reopened = end !== undefined && activityOf(own).some((r) => r.at > end.at + REOPEN_SLACK);
  if (end && !reopened) return { endedAt: T0 + end.at, endInferred: undefined, why: "a session.end" };
  const live = own.length > 0 && own.every(isLive) && !own.some((r) => r.trace === "own");
  const history = own.length > 0 && own.every((r) => r.source === "transcript" || r.source === "backfill" || r.source === "store");
  if (!live && !history) return { endedAt: undefined, endInferred: undefined, why: reopened ? "reopened" : "no end" };
  // The end of the last event: ts for a *.end event, ts + durationMs for one stamped at its start.
  const last = Math.max(...own.map((r) => r.at + (r.kind.endsWith(".end") ? 0 : (r.durationMs ?? 0))));
  return { endedAt: T0 + last, endInferred: true, why: reopened ? "reopened, then its last activity" : "its last activity" };
}

test("a session ends at its last session.end unless activity over 5 s later reopened it, else, if it came live or from history, at its last event", async (t) => {
  const seen: Record<string, number> = {
    "a session.end": 0,
    "its last activity": 0,
    "reopened, then its last activity": 0,
    reopened: 0,
    "no end": 0,
    "activity 5 s after the end": 0,
    "activity 5.001 s after the end": 0,
    "a span stamped before the end that closed after the slack": 0,
    "a live session of one event": 0,
    "a trace-keyed live session with no end": 0,
    "a gateway's copy that would change it": 0,
  };
  await forAll(
    endSessionGen,
    (rs) => {
      // The fold reads events in time order, keeping the order of events at the same time.
      const all = [...rs].sort((a, b) => a.at - b.at);
      // Enrichment never decides a session's shape.
      const own = all.filter((r) => !r.copy);
      const { why, ...want } = endOf(own);
      seen[why]!++;
      const end = own.findLast((r) => r.kind === "session.end");
      const activity = activityOf(own);
      const last = Math.max(...activity.map((r) => r.at));
      if (end && last === end.at + REOPEN_SLACK) seen["activity 5 s after the end"]!++;
      if (end && last === end.at + REOPEN_SLACK + 1) seen["activity 5.001 s after the end"]!++;
      if (end && why === "a session.end" && activity.some((r) => r.at < end.at && !r.kind.endsWith(".end") && r.at + (r.durationMs ?? 0) > end.at + REOPEN_SLACK)) seen["a span stamped before the end that closed after the slack"]!++;
      if (own.length === 1 && why === "its last activity" && isLive(own[0]!)) seen["a live session of one event"]!++;
      if (own.length > 0 && own.every(isLive) && own.some((r) => r.trace === "own") && (why === "no end" || why === "reopened")) seen["a trace-keyed live session with no end"]!++;
      const ifOwn = endOf(all.map((r) => (r.copy ? { ...r, source: "gateway" } : r)));
      if (ifOwn.endedAt !== want.endedAt || ifOwn.endInferred !== want.endInferred) seen["a gateway's copy that would change it"]!++;
      const row = buildSession(endEvents(rs));
      assert.deepEqual({ endedAt: row.endedAt, endInferred: row.stats.endInferred }, want, why);
    },
    { runs: 1000, label: "end" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** A generated event: a tool call's start or end, a session.end, or a prompt. */
interface CallEvent {
  kind: "tool.start" | "tool.end" | "session.end" | "user.message";
  /** Milliseconds after T0: a call often starts within 5 s of an end, or 5.001 s after it. */
  at: number;
  /** The call (payload.toolUseId) a tool event is for. */
  call: "call-1" | "call-2";
  source: string | undefined;
  /** A session.end's payload.reason: a transcript's quiet marker says "idle". */
  reason: "idle" | "other" | undefined;
}

const callEventGen = (sources: readonly (string | undefined)[]): Gen<CallEvent> =>
  gen.record<CallEvent>({
    kind: gen.pick(["tool.start", "tool.start", "tool.end", "session.end", "session.end", "user.message"] as const),
    at: gen.pick([0, 1000, 3000, 5000, 6001]),
    call: gen.pick(["call-1", "call-2"] as const),
    source: gen.pick(sources),
    reason: gen.pick(["idle", "idle", "other", undefined] as const),
  });

const callSessionGen: Gen<CallEvent[]> = gen.chain(gen.pick(["live", "history", "history", "hook", "mixed"] as const), (how) =>
  gen.array(callEventGen(END_SOURCES[how]), { minLength: 1, maxLength: 6 }),
);

function callEvents(rs: CallEvent[]): AgentEvent[] {
  return rs.map((r, i): AgentEvent => {
    const payload: Record<string, unknown> = {};
    if (r.kind === "tool.start") Object.assign(payload, { tool: "Read", toolUseId: r.call });
    if (r.kind === "tool.end") Object.assign(payload, { tool: "Read", toolUseId: r.call, ok: true });
    if (r.kind === "session.end" && r.reason !== undefined) payload.reason = r.reason;
    if (r.kind === "user.message") payload.text = `prompt ${i}`;
    const e: AgentEvent = { id: `open-${i}`, v: 0, sessionId: "open-session", ts: T0 + r.at, agent: "claude-code", kind: r.kind, payload };
    if (r.source !== undefined) e.source = r.source;
    return e;
  });
}

const fromHistory = (r: CallEvent) => END_SOURCES.history.some((s) => s === r.source);
/** A transcript's quiet marker: a session.end from recorded history with reason "idle". */
const isQuiet = (r: CallEvent) => r.kind === "session.end" && r.reason === "idle" && fromHistory(r);
const asEndEvent = (r: CallEvent): EndEvent => ({ kind: r.kind, at: r.at, durationMs: undefined, source: r.source, trace: "none", copy: false });

/**
 * The tool calls a session's events in time order leave open (core/waiting.ts), and how many open
 * calls a session.end closed: a call is open from its first start until its end (a start after its
 * end opens nothing), and a session.end that is no quiet marker closes every open call.
 */
function openCalls(sorted: CallEvent[]): { open: string[]; closed: number } {
  const open = new Set<string>();
  const ended = new Set<string>();
  let closed = 0;
  for (const r of sorted) {
    if (r.kind === "tool.start" && !ended.has(r.call)) open.add(r.call);
    if (r.kind === "tool.end") {
      open.delete(r.call);
      ended.add(r.call);
    }
    if (r.kind === "session.end" && !isQuiet(r)) {
      closed += open.size;
      open.clear();
    }
  }
  return { open: [...open], closed };
}

/** A session's last session.end, and whether activity stamped more than 5 s after it reopened the session. */
function lastEndOf(sorted: CallEvent[]): { end: CallEvent | undefined; reopened: boolean } {
  const end = sorted.findLast((r) => r.kind === "session.end");
  return { end, reopened: end !== undefined && sorted.some((r) => r.kind !== "session.end" && r.at > end.at + REOPEN_SLACK) };
}

/**
 * Where a session with tool calls ended, from the doc of Session.endedAt, given its events in time
 * order: with a call still open and no session.end, or its last one a quiet marker or reopened, it did
 * not finish and has no end, inferred or not; otherwise it ends as endOf says.
 */
function endOfCalls(sorted: CallEvent[]): { endedAt: number | undefined; endInferred: true | undefined; why: string } {
  const { end, reopened } = lastEndOf(sorted);
  const open = openCalls(sorted).open.length > 0;
  if (open && (end === undefined || reopened || isQuiet(end))) {
    const why = end === undefined ? "a call left open, and no session.end" : reopened ? "a call left open past a reopened end" : "a call left open by a quiet marker";
    return { endedAt: undefined, endInferred: undefined, why };
  }
  const { endedAt, endInferred } = endOf(sorted.map(asEndEvent));
  return { endedAt, endInferred, why: open ? "a call opened after a real end" : "no call left open" };
}

test("a session with a tool call still open has no end, unless its last session.end is no quiet marker and was not reopened", async (t) => {
  const seen: Record<string, number> = {
    "no call left open": 0,
    "a call left open, and no session.end": 0,
    "a call left open past a reopened end": 0,
    "a call left open by a quiet marker": 0,
    "a call opened after a real end": 0,
    "a hook's end with reason idle, then a call": 0,
    "a transcript's end with another reason, then a call": 0,
    "a call a real end closed, then a quiet marker": 0,
    "a call started again after its end": 0,
    "a call left open where the session would end at its last activity": 0,
  };
  await forAll(
    callSessionGen,
    (rs) => {
      // The fold reads events in time order, keeping the order of events at the same time.
      const sorted = [...rs].sort((a, b) => a.at - b.at);
      const { why, ...want } = endOfCalls(sorted);
      seen[why]!++;
      const { end, reopened } = lastEndOf(sorted);
      if (end && why === "a call opened after a real end" && end.source === undefined && end.reason === "idle") seen["a hook's end with reason idle, then a call"]!++;
      if (end && why === "a call opened after a real end" && fromHistory(end) && end.reason !== "idle") seen["a transcript's end with another reason, then a call"]!++;
      if (end && why === "no call left open" && isQuiet(end) && !reopened && openCalls(sorted).closed > 0) seen["a call a real end closed, then a quiet marker"]!++;
      const restarted = sorted.some(
        (r, i) =>
          r.kind === "tool.start" &&
          sorted.slice(0, i).some((p) => p.kind === "tool.end" && p.call === r.call) &&
          !sorted.slice(i + 1).some((n) => (n.kind === "tool.end" && n.call === r.call) || (n.kind === "session.end" && !isQuiet(n))),
      );
      if (restarted) seen["a call started again after its end"]!++;
      if (why.startsWith("a call left open") && endOf(sorted.map(asEndEvent)).endInferred) seen["a call left open where the session would end at its last activity"]!++;
      const row = buildSession(callEvents(rs));
      assert.deepEqual({ endedAt: row.endedAt, endInferred: row.stats.endInferred }, want, why);
    },
    { runs: 1000, label: "open calls" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** A generated event: a model call, or another event, that may name models. */
interface ModelEvent {
  kind: "llm.call" | "user.message" | "notification";
  at: number;
  /** payload.responseModel: a name, an empty one, none, or a value that is no string. */
  response: unknown;
  /** The event's model field. */
  model: string | undefined;
  /** payload.requestModel. */
  request: unknown;
  /** The subagent whose call it is, or none for the main thread's. */
  subagent: "agent-1" | "agent-2" | undefined;
  source: "transcript" | "otel-span" | "sdk" | undefined;
  /** A gateway's copy of the event. */
  copy: boolean;
}

const modelEventGen: Gen<ModelEvent> = gen.record<ModelEvent>({
  kind: gen.pick(["llm.call", "llm.call", "llm.call", "llm.call", "user.message", "notification"] as const),
  at: gen.int(0, 4),
  response: gen.pick<unknown>([undefined, undefined, undefined, "model-a", "model-c", "", 7]),
  model: gen.pick([undefined, "model-a", "model-b", "model-b", "model-c", ""]),
  request: gen.pick<unknown>([undefined, undefined, "model-b", "model-c", null]),
  subagent: gen.frequency<ModelEvent["subagent"]>([4, gen.constant(undefined)], [1, gen.pick(["agent-1", "agent-2"] as const)]),
  source: gen.pick([undefined, "transcript", "otel-span", "sdk"] as const),
  copy: gen.weighted(1 / 6),
});

function modelEvents(rs: ModelEvent[]): AgentEvent[] {
  return rs.map((r, i): AgentEvent => {
    const payload: Record<string, unknown> = {};
    if (r.response !== undefined) payload.responseModel = r.response;
    if (r.request !== undefined) payload.requestModel = r.request;
    const e: AgentEvent = { id: `model-${i}`, v: 0, sessionId: "model-session", ts: T0 + r.at * 1000, agent: "claude-code", kind: r.kind, payload };
    if (r.model !== undefined) e.model = r.model;
    if (r.subagent !== undefined && r.kind === "llm.call") e.subagentId = r.subagent;
    const source = r.copy ? "gateway" : r.source;
    if (source !== undefined) e.source = source;
    return e;
  });
}

/** The model that served a call: the response's, else the event's, else the one requested (modelOf). */
const servedBy = (r: ModelEvent): string | undefined => [r.response, r.model, r.request].find((m): m is string => typeof m === "string" && m !== "");

/** How many of the calls ran on each model, in the order each model first ran one. */
function callsByModel(calls: ModelEvent[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const r of calls) {
    const m = servedBy(r);
    if (m) n.set(m, (n.get(m) ?? 0) + 1);
  }
  return n;
}

/** The models that ran the most calls, the first to run one first. */
function mostUsed(n: Map<string, number>): string[] {
  const most = Math.max(...n.values());
  return [...n].filter(([, k]) => k === most).map(([m]) => m);
}

/**
 * A session's model and its calls by model, from the docs of mainModelOf, modelOf and
 * Session.stats.models, given its own events in time order: the model most main-thread calls ran on,
 * the earlier one on a tie; with no main-thread call, the one most calls ran on (no doc says which on
 * a tie); with no call that names a model, the last model an event named. Calls by model when two or
 * more models ran them, a subagent's calls with the rest.
 */
function modelOfRun(own: ModelEvent[]): { model: (string | undefined)[]; models: Record<string, number> | undefined; why: string } {
  const calls = own.filter((r) => r.kind === "llm.call");
  const all = callsByModel(calls);
  const models = all.size > 1 ? Object.fromEntries(all) : undefined;
  const main = callsByModel(calls.filter((r) => r.subagent === undefined));
  if (main.size) {
    const [first, ...tied] = mostUsed(main);
    return { model: [first], models, why: tied.length ? "a tie on the main thread" : "the main thread's most used" };
  }
  if (all.size) return { model: mostUsed(all), models, why: "only a subagent's calls" };
  const named = own.findLast((r) => r.model)?.model;
  return { model: [named], models, why: named ? "the last model an event named" : "no model" };
}

test("a session's model is the one most of its main-thread calls ran on, and it counts calls by model", async (t) => {
  const seen: Record<string, number> = {
    "the main thread's most used": 0,
    "a tie on the main thread": 0,
    "only a subagent's calls": 0,
    "the last model an event named": 0,
    "no model": 0,
    "a main model that is not the last one named": 0,
    "a subagent's model with more calls than the main thread's": 0,
    "a response's model over the event's": 0,
    "a requested model alone": 0,
    "two or more models": 0,
    "a gateway's copy that would change it": 0,
  };
  await forAll(
    gen.array(modelEventGen, { minLength: 1, maxLength: 8 }),
    (rs) => {
      // The fold reads events in time order, keeping the order of events at the same time.
      const all = [...rs].sort((a, b) => a.at - b.at);
      // Enrichment never decides a session's shape.
      const own = all.filter((r) => !r.copy);
      const want = modelOfRun(own);
      seen[want.why]!++;
      const calls = own.filter((r) => r.kind === "llm.call");
      const main = want.why.includes("main thread") ? want.model[0]! : undefined;
      if (main && main !== own.findLast((r) => r.model)?.model) seen["a main model that is not the last one named"]!++;
      const byModel = callsByModel(calls);
      if (main && [...byModel.values()].some((n) => n > byModel.get(main)!)) seen["a subagent's model with more calls than the main thread's"]!++;
      if (calls.some((r) => typeof r.response === "string" && r.response && r.model && r.model !== r.response)) seen["a response's model over the event's"]!++;
      if (calls.some((r) => servedBy(r) !== undefined && servedBy({ ...r, request: undefined }) === undefined)) seen["a requested model alone"]!++;
      if (want.models) seen["two or more models"]!++;
      const ifOwn = modelOfRun(all);
      if (!isDeepStrictEqual(ifOwn.model, want.model) || !isDeepStrictEqual(ifOwn.models, want.models)) seen["a gateway's copy that would change it"]!++;
      const row = buildSession(modelEvents(rs));
      assert.ok(want.model.includes(row.model), `model ${row.model}, want ${want.model.join(" or ")} (${want.why})`);
      assert.deepEqual(row.stats.models, want.models, want.why);
    },
    { runs: 1000, label: "models" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** A generated event: what the fold reads to outline a session, from the agent's own capture or the proxy. */
interface PhaseEvent {
  kind: "user.message" | "llm.call" | "context.compact" | "session.start";
  /** Minutes after T0: a gap of 30 minutes or more opens an idle phase (outline.ts IDLE_PHASE_MS). */
  at: number;
  /** A model call's source: the proxy's copy, the agent's transcript, or its hook (none). */
  source: "proxy" | "transcript" | undefined;
  /** A model call's input tokens. */
  tokens: number;
}

const phaseEventGen: Gen<PhaseEvent> = gen.record<PhaseEvent>({
  kind: gen.pick(["user.message", "llm.call", "llm.call", "llm.call", "context.compact", "session.start"] as const),
  at: gen.pick([0, 1, 2, 40, 41, 90]),
  source: gen.pick([undefined, "transcript", "proxy", "proxy"] as const),
  tokens: gen.int(1, 9),
});

function phaseEvents(rs: PhaseEvent[]): AgentEvent[] {
  return rs.map((r, i): AgentEvent => {
    const payload: Record<string, unknown> = r.kind === "user.message" ? { text: `prompt ${i}` } : {};
    const e: AgentEvent = { id: `phase-${i}`, v: 0, sessionId: "phase-session", ts: T0 + r.at * 60_000, agent: "claude-code", kind: r.kind, payload };
    if (r.kind === "llm.call") {
      e.usage = { inputTokens: r.tokens, outputTokens: 1 };
      if (r.source !== undefined) e.source = r.source;
    }
    return e;
  });
}

const isProxyCopy = (e: AgentEvent) => e.kind === "llm.call" && e.source === "proxy";

/** A row's phases, without where each starts and ends in the session's events: the proxy's copies move that. */
const phasesOf = (s: Session) => s.stats.phases?.map(({ from: _from, to: _to, ...p }) => p);

test("a session's phases count one copy of each call: without the proxy's when its own capture recorded calls", async (t) => {
  const seen: Record<string, number> = {
    "calls of its own": 0,
    "only the proxy's calls": 0,
    "a phase that opens after the proxy's first call": 0,
    "the proxy's calls that change the phases": 0,
  };
  await forAll(
    gen.array(phaseEventGen, { minLength: 1, maxLength: 8 }),
    (rs) => {
      const events = phaseEvents(rs);
      const row = buildSession(events);
      const rest = events.filter((e) => !isProxyCopy(e));
      if (rest.some((e) => e.kind === "llm.call")) {
        seen["calls of its own"]!++;
        const sans = buildSession(rest);
        const first = byTime(events).find(isProxyCopy);
        if (first && sans.stats.phases?.some((p) => p.startTs > first.ts)) seen["a phase that opens after the proxy's first call"]!++;
        assert.deepEqual(phasesOf(row), phasesOf(sans));
        return;
      }
      seen["only the proxy's calls"]!++;
      if (rest.length && !isDeepStrictEqual(phasesOf(row), phasesOf(buildSession(rest)))) seen["the proxy's calls that change the phases"]!++;
      // The proxy's calls are the session's calls: the phases are those the same calls give from a hook.
      const hooked = events.map((e) => {
        if (!isProxyCopy(e)) return e;
        const { source: _source, ...own } = e;
        return own;
      });
      assert.deepEqual(row.stats.phases, buildSession(hooked).stats.phases);
    },
    { runs: 1000, label: "phases" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

/** A generated shell call: what the fold reads to count the files it writes. */
interface ShellCall {
  /** payload.toolUseId on its start and end: an id of its own, an empty one, none, or one that is no string. */
  id: "own" | "" | undefined | 7;
  /** How it ended: it ran (and passed or failed), the user stopped it or turned it down, or no end came. */
  end: "ok" | "failed" | "stopped" | "turned down" | "none";
  /** The file it writes: calls often share one. */
  file: "a.txt" | "src/b.ts" | "notes.md";
  /** How it writes the file. */
  how: "redirect" | "sed" | "tee";
  /** Seconds after T0 that it started; its end comes a second later. */
  at: number;
}

const shellCallGen: Gen<ShellCall> = gen.record<ShellCall>({
  id: gen.pick(["own", "own", "", undefined, 7] as const),
  end: gen.pick(["ok", "failed", "stopped", "turned down", "none"] as const),
  file: gen.pick(["a.txt", "src/b.ts", "notes.md"] as const),
  how: gen.pick(["redirect", "sed", "tee"] as const),
  at: gen.int(0, 6),
});

/** The fold's reading of a tool call's id (sessions.ts, filesChanged): a string that is not empty. */
const usableId = (c: ShellCall) => c.id === "own";

function shellEvents(cs: ShellCall[]): AgentEvent[] {
  const commands = { redirect: (f: string) => `echo x > ${f}`, sed: (f: string) => `sed -i 's/a/b/' ${f}`, tee: (f: string) => `echo x | tee ${f} > /dev/null` };
  const ends = {
    ok: { ok: true },
    failed: { ok: false, output: "Exit code 1\n1 failing" },
    stopped: { ok: false, interrupted: true },
    "turned down": { ok: false, output: "The user doesn't want to proceed with this tool use." },
  };
  return cs.flatMap((c, i): AgentEvent[] => {
    const id = c.id === "own" ? { toolUseId: `call-${i}` } : c.id === undefined ? {} : { toolUseId: c.id };
    const at = (s: number, kind: EventKind, payload: Record<string, unknown>): AgentEvent => ({ id: `shell-${i}-${kind}`, v: 0, sessionId: "shell-session", ts: T0 + s * 1000, agent: "claude-code", kind, cwd: "/work/demo", payload });
    const start = at(c.at, "tool.start", { tool: "Bash", ...id, input: { command: commands[c.how](c.file) } });
    return c.end === "none" ? [start] : [start, at(c.at + 1, "tool.end", { tool: "Bash", ...id, ...ends[c.end] })];
  });
}

test("a shell call's files count when it ends unless it never ran, and as it starts when it has no usable id", async (t) => {
  const seen: Record<string, number> = {
    "no id": 0,
    "an empty id": 0,
    "an id that is no string": 0,
    "a call of its own id stopped or turned down": 0,
    "a call of its own id with no end": 0,
    "a call that failed": 0,
    "a call with no usable id that never ran to its end": 0,
    "a file two calls write": 0,
  };
  await forAll(
    gen.array(shellCallGen, { minLength: 1, maxLength: 5 }),
    (cs) => {
      const counted = new Set(cs.filter((c) => !usableId(c) || c.end === "ok" || c.end === "failed").map((c) => c.file));
      for (const c of cs) {
        if (c.id === undefined) seen["no id"]!++;
        if (c.id === "") seen["an empty id"]!++;
        if (c.id === 7) seen["an id that is no string"]!++;
        if (usableId(c) && (c.end === "stopped" || c.end === "turned down")) seen["a call of its own id stopped or turned down"]!++;
        if (usableId(c) && c.end === "none") seen["a call of its own id with no end"]!++;
        if (c.end === "failed") seen["a call that failed"]!++;
        if (!usableId(c) && (c.end === "stopped" || c.end === "turned down" || c.end === "none")) seen["a call with no usable id that never ran to its end"]!++;
      }
      if (new Set(cs.map((c) => c.file)).size < cs.length) seen["a file two calls write"]!++;
      assert.equal(buildSession(shellEvents(cs)).stats.filesChanged, counted.size, [...counted].join(", "));
    },
    { runs: 1000, label: "shell files" },
  );
  for (const [why, n] of Object.entries(seen)) assert.ok(n > 0, `no case: ${why} (${JSON.stringify(seen)})`);
  t.diagnostic(JSON.stringify(seen));
});

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
