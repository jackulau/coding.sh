// The capture model (capture-model.test.ts) run against the code it models. Real hook lines from the
// adapter fixtures (claude-code, codex and cursor hooks.spool.jsonl, merged by time) go through the real
// spool writer, spool/write.ts appendSpool with the hook's redactor (spool/redact.ts spoolLineRedactor).
// Runs of the real ingest (core/ingest.ts ingest) come between the appends, and each one can stop part
// way at a point the code already has, or crash:
//
// - Signal: `signal` aborts at a chosen store call. The run stops after the line it is on (stopMidFile)
//   or after its next checkpoint, and commits what it read.
// - Deadline: `deadline` has passed. The run stops after its first checkpoint, or after its first file.
// - Crash: the store throws at a chosen call and at every call after it, as a process that died there
//   writes nothing more. SQLite (store/sqlite.ts) rolls back the open transaction, and the test closes
//   and opens the file again. The memory store (store/memory.ts) has no transactions, like Postgres or
//   ClickHouse here: it keeps every write made before the crash.
//
// A final ingest then runs with no stop. The invariants are the model's, checked on the real store:
//
// - After every run, crashed or not, a spool file's cursor covers only lines whose events are stored,
//   and a sink's cursor only lines whose events the sink acknowledged.
// - The final ingest leaves the store as one clean ingest of the same lines leaves it: the same session
//   rows and the same events, none lost or stored twice. An ingest after it finds nothing new.
// - With no crash, each line is consumed once (IngestResult.lines) and each event is inserted once
//   (IngestResult.events), and a sink gets each event exactly once.
// - With crashes on SQLite, a sink gets every event at least once.
//
// A line's events come from the real normalizer (core/ingest.ts spoolNormalizer) reading the reference
// spool: event ids depend on the line and its offset, and every case writes the same lines in the same
// order. The sink checks run on SQLite only, as in the model, where they hold with transactions.
//
// Left out: two ingests at once and a stalled lock holder. SQLite's BEGIN IMMEDIATE waits synchronously,
// so two ingests in one process cannot interleave; capture-model.test.ts checks them. A crash here is a
// thrown error in one process, so `finally` blocks still run (the lock is released, not left stale) and
// module state survives it; lock-model.test.ts checks breaking a dead holder's lock. The blob store never
// fails (ingest has its own tests for StoreWriteError).
//
// CODING_SH_PROP_RUNS=n runs n cases per test (default 3 or 4); CODING_SH_PROP_SEED=s replays one.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest, profileCache, sinkCursorKey, spoolNormalizer, type IngestOptions } from "../../src/core/ingest.ts";
import { paths } from "../../src/core/paths.ts";
import { listSpoolFiles, readSpoolFile } from "../../src/core/spool-read.ts";
import type { AgentEvent, IndexStore, Sink, SpoolLine } from "../../src/core/types.ts";
import { spoolLineRedactor } from "../../src/spool/redact.ts";
import { appendSpool } from "../../src/spool/write.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { loadSpool, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { forAll, gen, type Gen } from "../_prop.ts";

const FIXTURE_SPOOLS = ["claude-code/hooks.spool.jsonl", "codex/hooks.spool.jsonl", "cursor/hooks.spool.jsonl"];
const SINK = "recorder";
const ADAPTER_MAP = new Map(ADAPTERS.map((a) => [a.id, a]));

type Kind = "sqlite" | "memory";
type Stop = "none" | "signal" | "deadline";

/** One ingest run of a case, after its appends. */
interface Run {
  /** Lines appended before the run. */
  append: number;
  /** checkpointEvents. */
  every: number;
  stop: Stop;
  /** With stop "signal": the store call at which the signal fires. */
  at: number;
  /** The store call at which the run crashes (0: it does not). */
  crash: number;
}

/** The fixture lines, merged by time. */
let lines: SpoolLine[] = [];
let te: TmpEnv;
/** What one clean ingest of every line stores, per store kind. */
const reference = new Map<Kind, Contents>();
/** Per spool source, each line's end offset and the ids of the events it holds. */
let lineEvents = new Map<string, { nextOffset: number; ids: string[] }[]>();
let allIds: string[] = [];

type Contents = Record<string, { row: unknown; events: unknown }>;

/** What a crash throws. */
class Crash extends Error {}

/** Session rows and their events, as JSON keeps them (key order aside). */
async function contents(index: IndexStore): Promise<Contents> {
  const out: Contents = {};
  for (const s of await index.listSessions({})) out[s.id] = { row: s, events: await index.listEvents(s.id) };
  return JSON.parse(JSON.stringify(out)) as Contents;
}

async function storedIds(index: IndexStore): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const s of await index.listSessions({})) for (const e of await index.listEvents(s.id)) ids.add(e.id);
  return ids;
}

/** A home of its own, with the fixture lines appended up to `upTo` by the hook's writer. */
function spoolHome(name: string): { env: NodeJS.ProcessEnv; append: (from: number, to: number) => void } {
  const env: NodeJS.ProcessEnv = { ...process.env, CODING_SH_HOME: mkdtempSync(join(te.root, `${name}-`)) };
  const redact = spoolLineRedactor(env);
  return { env, append: (from, to) => lines.slice(from, to).forEach((l) => appendSpool(l, env, { redact })) };
}

/** A sink that acknowledges every batch and counts each event it got. */
function recorder(): { sink: Sink; got: Map<string, number> } {
  const got = new Map<string, number>();
  const sink: Sink = {
    name: SINK,
    mode: "full",
    write: async (batch: AgentEvent[]) => {
      for (const e of batch) got.set(e.id, (got.get(e.id) ?? 0) + 1);
      return { ok: true };
    },
  };
  return { sink, got };
}

/** `store` as one run sees it: the signal fires at call `at`, and from call `crash` on every call throws (0: never). */
function faulty(store: IndexStore, at: number, crash: number, ac: AbortController): IndexStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, key) {
      const v: unknown = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls++;
        if (crash > 0 && calls >= crash) throw new Crash(`crashed at store call ${crash}`);
        if (calls === at) ac.abort();
        return Reflect.apply(v, target, args);
      };
    },
  });
}

/** A cursor covers only stored lines; a sink cursor only lines whose events the sink got. */
async function assertCovered(index: IndexStore, got: Map<string, number> | undefined, when: string): Promise<void> {
  const stored = await storedIds(index);
  for (const [source, ls] of lineEvents) {
    const local = await index.getCursor(source);
    const sent = got ? await index.getCursor(sinkCursorKey(SINK, source)) : 0;
    for (const l of ls) {
      for (const id of l.ids) {
        if (l.nextOffset <= local) assert.ok(stored.has(id), `${when}: the cursor of ${source} is at ${local}, past the line ending at ${l.nextOffset}, but its event ${id} is not stored`);
        if (got && l.nextOffset <= sent) assert.ok(got.has(id), `${when}: the sink cursor of ${source} is at ${sent}, past the line ending at ${l.nextOffset}, but the sink never got its event ${id}`);
      }
    }
  }
}

interface Outcome {
  /** Lines and events the runs that returned reported, the final ingest included. */
  lines: number;
  events: number;
  crashes: number;
  /** Runs that returned with files left to read. */
  stopped: number;
  /** What the sink got, by event id (with a sink). */
  got: Map<string, number> | undefined;
}

/** Runs one case on a fresh store and checks what holds whatever the faults were. */
async function runCase(kind: Kind, runs: readonly Run[], withSink: boolean): Promise<Outcome> {
  const { env, append } = spoolHome("case");
  const config = defaultConfig(env);
  const dbPath = paths(env).index;
  let store: IndexStore = kind === "sqlite" ? await SqliteIndexStore.open(dbPath) : new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  const rec = withSink ? recorder() : undefined;
  const out: Outcome = { lines: 0, events: 0, crashes: 0, stopped: 0, got: rec?.got };
  const options = (index: IndexStore): IngestOptions => {
    const o: IngestOptions = { config, index, blobs, adapters: ADAPTER_MAP, env };
    if (rec) o.sinks = [rec.sink];
    return o;
  };
  let appended = 0;
  try {
    for (const [i, r] of runs.entries()) {
      append(appended, appended + r.append);
      appended = Math.min(lines.length, appended + r.append);
      const ac = new AbortController();
      const o = options(faulty(store, r.stop === "signal" ? r.at : 0, r.crash, ac));
      o.checkpointEvents = r.every;
      o.signal = ac.signal;
      if (r.stop === "deadline") o.deadline = 0;
      try {
        const res = await ingest(o);
        assert.deepEqual(res.errors, [], `run ${i + 1} reported errors`);
        out.lines += res.lines;
        out.events += res.events;
        if (res.pendingFiles) out.stopped++;
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
        out.crashes++;
        if (store instanceof SqliteIndexStore) {
          await store.close();
          store = await SqliteIndexStore.open(dbPath);
        }
      }
      await assertCovered(store, rec?.got, `after run ${i + 1}`);
    }
    append(appended, lines.length);
    const fin = await ingest(options(store));
    assert.deepEqual(fin.errors, [], "the final ingest reported errors");
    assert.equal(fin.pendingFiles, 0, "the final ingest left files to read");
    out.lines += fin.lines;
    out.events += fin.events;
    await assertCovered(store, rec?.got, "after the final ingest");
    for (const f of await listSpoolFiles(paths(env).spool)) assert.equal(await store.getCursor(f.source), f.size, `the cursor of ${f.source} is short of its end`);
    assert.deepEqual(await contents(store), reference.get(kind), "the store differs from one clean ingest of the same lines");
    const sentBefore = rec ? [...rec.got.values()].reduce((a, n) => a + n, 0) : 0;
    const again = await ingest(options(store));
    assert.deepEqual([again.lines, again.events], [0, 0], "an ingest after the final one found something new");
    if (rec) assert.equal([...rec.got.values()].reduce((a, n) => a + n, 0), sentBefore, "an ingest after the final one sent again");
    return out;
  } finally {
    await store.close();
  }
}

const runGen = (stop: Gen<Stop>, crash: Gen<number>): Gen<Run> =>
  gen.record<Run>({ append: gen.int(0, 16), every: gen.int(1, 3), stop, at: gen.int(1, 150), crash });
const casesGen = (stop: Gen<Stop>, crash: Gen<number>): Gen<Run[]> => gen.array(runGen(stop, crash), { minLength: 1, maxLength: 5 });
const STOPS = gen.pick<Stop>(["none", "signal", "deadline"]);
const CRASHES = gen.frequency<number>([1, gen.constant(0)], [3, gen.int(1, 200)]);

before(async () => {
  te = tmpEnv();
  lines = FIXTURE_SPOOLS.flatMap((f) => loadSpool(f)).sort((a, b) => a.ts - b.ts);
  for (const kind of ["sqlite", "memory"] as const) {
    const { env, append } = spoolHome(`reference-${kind}`);
    append(0, lines.length);
    const index = kind === "sqlite" ? await SqliteIndexStore.open(paths(env).index) : new MemoryIndexStore();
    try {
      const r = await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters: ADAPTER_MAP, env });
      assert.deepEqual(r.errors, []);
      assert.equal(r.lines, lines.length);
      reference.set(kind, await contents(index));
      if (kind === "sqlite") allIds = [...(await storedIds(index))].sort();
    } finally {
      await index.close();
    }
    if (kind !== "sqlite") continue;
    // Each line's events, read back from the reference spool by the normalizer ingest uses.
    const spoolDir = paths(env).spool;
    const normalize = spoolNormalizer({ adapters: ADAPTER_MAP, blobs: new MemoryBlobStore(), env, profileFor: profileCache(defaultConfig(env), env, () => {}), error: () => {}, excluded: () => {} });
    lineEvents = new Map();
    for (const f of await listSpoolFiles(spoolDir)) {
      const ls: { nextOffset: number; ids: string[] }[] = [];
      for await (const rec of readSpoolFile(spoolDir, f.path)) ls.push({ nextOffset: rec.nextOffset, ids: (await normalize(rec.line, rec.source, rec.offset)).map((e) => e.id) });
      lineEvents.set(f.source, ls);
    }
  }
  // The per-line ids are exactly the stored ones: the cursor checks see every event.
  assert.deepEqual([...new Set([...lineEvents.values()].flat().flatMap((l) => l.ids))].sort(), allIds);
});

after(() => te.restore());

test("runs stopped by a signal or a deadline store every line once and send every event once", async (t) => {
  const seen = { stopped: 0, runs: 0 };
  await forAll(
    gen.tuple(gen.pick<Kind>(["sqlite", "memory"]), casesGen(STOPS, gen.constant(0))),
    async ([kind, runs]) => {
      const o = await runCase(kind, runs, true);
      seen.stopped += o.stopped;
      seen.runs += runs.length;
      assert.equal(o.lines, lines.length, "lines consumed");
      assert.equal(o.events, allIds.length, "events inserted");
      assert.deepEqual([...must(o.got).entries()].filter(([, n]) => n !== 1), [], "events the sink got more than once");
      assert.deepEqual([...must(o.got).keys()].sort(), allIds, "events the sink got");
    },
    { runs: 4, label: "stopped runs", maxShrinks: 100 },
  );
  t.diagnostic(`${seen.runs} runs, ${seen.stopped} stopped with files left`);
  assert.ok(seen.stopped > 0, "no run stopped part way");
});

test("runs that crash at any store call lose nothing on SQLite, and the sink gets every event", async (t) => {
  const seen = { crashes: 0, runs: 0 };
  await forAll(
    casesGen(STOPS, CRASHES),
    async (runs) => {
      const o = await runCase("sqlite", runs, true);
      seen.crashes += o.crashes;
      seen.runs += runs.length;
      assert.deepEqual(allIds.filter((id) => !must(o.got).has(id)), [], "events the sink never got");
    },
    { runs: 4, label: "crashes on sqlite", maxShrinks: 100 },
  );
  t.diagnostic(`${seen.runs} runs, ${seen.crashes} crashed`);
  assert.ok(seen.crashes > 0, "no run crashed");
});

test("runs that crash at any store call lose nothing on a store without transactions", async (t) => {
  const seen = { crashes: 0, runs: 0 };
  await forAll(
    casesGen(STOPS, CRASHES),
    async (runs) => {
      const o = await runCase("memory", runs, false);
      seen.crashes += o.crashes;
      seen.runs += runs.length;
    },
    { runs: 3, label: "crashes on memory", maxShrinks: 100 },
  );
  t.diagnostic(`${seen.runs} runs, ${seen.crashes} crashed`);
  assert.ok(seen.crashes > 0, "no run crashed");
});

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
