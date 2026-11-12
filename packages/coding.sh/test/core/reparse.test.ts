import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import type { Adapter } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest } from "../../src/core/ingest.ts";
import { acquireLock, wakeMarker } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { REFOLD_CURSOR, REPARSE_CURSOR, reparse, reparseDue, reparseKeptKey } from "../../src/core/reparse.ts";
import { foldStamp, SESSION_FOLD_VERSION } from "../../src/core/sessions.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { loadSqlite, MIGRATIONS, SqliteIndexStore } from "../../src/store/sqlite.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const T0 = 1_700_000_000_000;
type Raw = { session: string; kind: EventKind; [k: string]: unknown };

/**
 * An adapter whose parse changes between versions, the way today's fixes did:
 * v1 normalize emits each llm.call twice (tokens double), and v1 backfill gives
 * a tool call's transcript rows ids of their own, so ingest stores them beside
 * the hook copies (tool errors double) and marks a failed call that succeeded.
 */
function versioned(transcripts: { path: string; events: Raw[] }[]) {
  const adapter: Adapter = {
    id: "vf",
    displayName: "Versioned fake",
    tier: "A",
    parseVersion: 1,
    detect: async () => ({ installed: true, hooked: true }),
    install: async () => [],
    uninstall: async () => [],
    async normalize(line, ctx) {
      const { session, kind, ...payload } = line.raw as Raw;
      // A line whose rows are read from a file it names, as a Stop line's model calls are: without the file, no rows.
      if (typeof payload.reads === "string" && !existsSync(payload.reads)) {
        ctx.missing?.(payload.reads, session);
        return [];
      }
      const n = kind === "llm.call" && adapter.parseVersion === 1 ? 2 : 1;
      return Array.from({ length: n }, (_, i) => ({
        id: ctx.id(line.agent, session, line.ts, line.event, i),
        v: 0 as const,
        sessionId: session,
        ts: line.ts,
        agent: line.agent,
        kind,
        payload,
        ...(kind === "llm.call" ? { usage: { inputTokens: 100, outputTokens: 10 } } : {}),
      }));
    },
    async *backfill(_ctx, opts) {
      for (const t of transcripts) {
        if (opts?.changed && !(await opts.changed({ path: t.path, size: 1, mtimeMs: 1 }))) continue;
        for (const [i, { session, kind, ...payload }] of t.events.entries()) {
          const v1 = adapter.parseVersion === 1;
          const call = typeof payload.toolUseId === "string" ? payload.toolUseId : undefined;
          yield {
            id: v1 || !call ? `tr-${t.path}-${i}` : `call-${session}-${kind}-${call}`,
            v: 0,
            sessionId: session,
            ts: T0 + Number(payload.at ?? i) * 1000,
            agent: "vf",
            kind,
            payload: kind === "tool.end" && v1 && payload.flaky ? { ...payload, ok: false } : payload,
          } satisfies AgentEvent;
        }
      }
    },
  };
  return adapter;
}

async function setup(transcripts: { path: string; events: Raw[] }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "csh-reparse-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const config = defaultConfig(env);
  const spool = join(env.CODING_SH_HOME, "spool", "vf");
  mkdirSync(spool, { recursive: true });
  const adapter = versioned(transcripts);
  const adapters = new Map<string, Adapter>([["vf", adapter]]);
  const index = await SqliteIndexStore.open(join(root, "index.db"));
  const blobs = new MemoryBlobStore();
  let n = 0;
  const hook = (file: string, raw: Raw, at: number) =>
    appendFileSync(join(spool, file), JSON.stringify({ v: 0, agent: "vf", event: `E${n++}`, ts: T0 + at * 1000, pid: 1, cwd: root, raw }) + "\n");
  const base = { config, index, blobs, env };
  return {
    root, env, spool, adapter, adapters, index, blobs, hook,
    ingest: () => ingest({ ...base, adapters }),
    backfill: () => backfill({ ...base, adapters: [adapter] }),
    reparse: (o: { all?: boolean; agents?: string[] } = {}) => reparse({ ...base, adapters, ...o }),
    due: () => reparseDue(index, adapters),
    stats: async (id: string) => {
      const s = (await index.getSession(id))!;
      return { events: s.stats.events, toolErrors: s.stats.toolErrors, input: s.stats.usage?.inputTokens ?? 0, parseVersion: s.parseVersion };
    },
  };
}

describe("reparse", () => {
  it("re-parses sessions stored by an older parse, corrects their counts, and is idempotent", async () => {
    const t = await setup([
      {
        path: "a.jsonl",
        events: [
          { session: "a", kind: "user.message", text: "fix it", at: 1 },
          { session: "a", kind: "tool.start", tool: "Bash", toolUseId: "x1", at: 2 },
          { session: "a", kind: "tool.end", tool: "Bash", toolUseId: "x1", ok: false, at: 3 },
          { session: "a", kind: "tool.start", tool: "Read", toolUseId: "x2", at: 5 },
          { session: "a", kind: "tool.end", tool: "Read", toolUseId: "x2", ok: true, flaky: true, at: 6 },
        ],
      },
      { path: "t.jsonl", events: [{ session: "t", kind: "tool.start", tool: "Edit", toolUseId: "y", at: 1 }, { session: "t", kind: "tool.end", tool: "Edit", toolUseId: "y", ok: true, flaky: true, at: 2 }] },
    ]);
    // Session a: captured by hooks (the transcript's x2 call the hooks missed) and backfilled.
    t.hook("d1.1.jsonl", { session: "a", kind: "user.message", text: "fix it" }, 1);
    t.hook("d1.1.jsonl", { session: "a", kind: "tool.start", tool: "Bash", toolUseId: "x1" }, 2);
    t.hook("d1.1.jsonl", { session: "a", kind: "tool.end", tool: "Bash", toolUseId: "x1", ok: false }, 3);
    t.hook("d1.1.jsonl", { session: "a", kind: "llm.call", model: "m" }, 4);
    await t.ingest();
    await t.backfill();
    assert.deepEqual(await t.stats("a"), { events: 9, toolErrors: 3, input: 200, parseVersion: 1 }, "v1: doubled tokens and tool errors");
    assert.deepEqual(await t.stats("t"), { events: 2, toolErrors: 1, input: 0, parseVersion: 1 });
    assert.equal(await t.due(), false, "nothing is stale while the adapter is at v1");

    t.adapter.parseVersion = 2;
    assert.equal(await t.due(), true);
    const r = await t.reparse();
    assert.deepEqual([r.sessions, r.reparsed, r.kept, r.errors], [2, 2, 0, []]);
    // a: one prompt, x1 start+end (hook), one llm.call, x2 start+end (transcript).
    assert.deepEqual(await t.stats("a"), { events: 6, toolErrors: 1, input: 100, parseVersion: 2 });
    assert.deepEqual(await t.stats("t"), { events: 2, toolErrors: 0, input: 0, parseVersion: 2 });
    const a = await t.index.listEvents("a");
    assert.deepEqual(a.map((e) => [e.kind, e.source]), [
      ["user.message", "hook"],
      ["tool.start", "hook"],
      ["tool.end", "hook"],
      ["llm.call", "hook"],
      ["tool.start", "transcript"],
      ["tool.end", "transcript"],
    ]);
    assert.equal(a[5]!.durationMs, 1000, "re-inserted tool.end rows get their duration");
    assert.equal(await t.due(), false, "the stamp is set");
    assert.equal(await t.index.getCursor(REPARSE_CURSOR) !== undefined, true);

    const before = await t.index.listEvents("a");
    const again = await t.reparse({ all: true });
    assert.deepEqual([again.reparsed, again.removed, again.inserted, again.errors], [2, 0, 0, []], "a second run writes nothing");
    assert.deepEqual(await t.index.listEvents("a"), before);
    assert.deepEqual(await t.stats("a"), { events: 6, toolErrors: 1, input: 100, parseVersion: 2 });
    // New sessions are stamped with the current version.
    t.hook("d2.1.jsonl", { session: "n", kind: "user.message", text: "new" }, 50);
    await t.ingest();
    assert.equal((await t.stats("n")).parseVersion, 2);
    await t.index.close();
  });

  it("keeps a hook-only session whose spool is gone, removing its duplicate rows, and says why", async () => {
    const t = await setup();
    // The hook fired twice for one tool call, as old hook configs did.
    t.hook("d1.1.jsonl", { session: "h", kind: "tool.start", tool: "Bash", toolUseId: "z" }, 1);
    t.hook("d1.1.jsonl", { session: "h", kind: "tool.end", tool: "Bash", toolUseId: "z", ok: false }, 2);
    t.hook("d1.1.jsonl", { session: "h", kind: "tool.end", tool: "Bash", toolUseId: "z", ok: false }, 2);
    await t.ingest();
    assert.deepEqual(await t.stats("h"), { events: 3, toolErrors: 2, input: 0, parseVersion: 1 });
    rmSync(join(t.spool, "d1.1.jsonl")); // gc

    t.adapter.parseVersion = 2;
    const r = await t.reparse();
    assert.deepEqual([r.reparsed, r.kept, r.removed, r.inserted], [0, 1, 1, 0]);
    assert.deepEqual(await t.stats("h"), { events: 2, toolErrors: 1, input: 0, parseVersion: 1 }, "kept at v1, deduped");
    assert.match(r.keptSessions[0]!.reason, /spool lines were removed by gc.*1 duplicate row removed/);
    const kv = JSON.parse((await t.index.kvGet!(reparseKeptKey("h")))!) as { version: number; reason: string };
    assert.equal(kv.version, 2);
    assert.equal(kv.reason, r.keptSessions[0]!.reason);
    assert.equal(await t.due(), false, "a kept session does not make every read retry");
    const again = await t.reparse({ all: true });
    assert.deepEqual([again.kept, again.removed, again.inserted], [1, 0, 0]);
    await t.index.close();
  });

  it("keeps the hook rows of a session whose spool line reads a file that is gone, and says why", async () => {
    const t = await setup();
    const transcript = join(t.root, "run-home", "s.jsonl");
    mkdirSync(join(t.root, "run-home"));
    writeFileSync(transcript, "");
    t.hook("d1.1.jsonl", { session: "s", kind: "user.message", text: "hi" }, 1);
    t.hook("d1.1.jsonl", { session: "s", kind: "llm.call", model: "m", reads: transcript }, 2);
    // Another session in the same spool file, with nothing missing.
    t.hook("d1.1.jsonl", { session: "o", kind: "llm.call", model: "m" }, 3);
    await t.ingest();
    assert.deepEqual(await t.stats("s"), { events: 3, toolErrors: 0, input: 200, parseVersion: 1 });
    rmSync(join(t.root, "run-home"), { recursive: true }); // the run's home is deleted; the spool line stays

    t.adapter.parseVersion = 2;
    const r = await t.reparse();
    assert.deepEqual([r.sessions, r.reparsed, r.kept, r.removed, r.inserted, r.errors], [2, 1, 1, 1, 0, []]);
    assert.deepEqual(await t.stats("s"), { events: 3, toolErrors: 0, input: 200, parseVersion: 1 }, "no row is removed that can't be read again");
    assert.deepEqual(await t.stats("o"), { events: 1, toolErrors: 0, input: 100, parseVersion: 2 });
    assert.deepEqual(r.keptSessions, [{ id: "s", agent: "vf", reason: "the transcript its hook lines read is gone, or has grown past their turns" }]);
    assert.equal(await t.due(), false);
    await t.index.close();
  });

  it("re-reads the spool when the hook rows' lines are still there", async () => {
    const t = await setup();
    t.hook("d1.1.jsonl", { session: "s", kind: "user.message", text: "hi" }, 1);
    t.hook("d1.1.jsonl", { session: "s", kind: "llm.call", model: "m" }, 2);
    await t.ingest();
    assert.equal((await t.stats("s")).input, 200);
    t.adapter.parseVersion = 2;
    const r = await t.reparse();
    assert.deepEqual([r.reparsed, r.kept], [1, 0]);
    assert.deepEqual(await t.stats("s"), { events: 2, toolErrors: 0, input: 100, parseVersion: 2 });
    await t.index.close();
  });

  it("--agent limits the run and leaves the stamp for the automatic one", async () => {
    const t = await setup();
    t.hook("d1.1.jsonl", { session: "s", kind: "llm.call", model: "m" }, 1);
    await t.ingest();
    t.adapter.parseVersion = 2;
    const other = await t.reparse({ all: true, agents: ["claude-code"] });
    assert.equal(other.sessions, 0);
    assert.equal(await t.due(), true);
    const mine = await t.reparse({ all: true, agents: ["vf"] });
    assert.equal(mine.reparsed, 1);
    assert.equal(await t.due(), false, "nothing stale left: the stamp is set by the check");
    await t.index.close();
  });

  it("holds the ingest lock briefly and ingests what hooks spool meanwhile between holds", async () => {
    const t = await setup();
    for (let i = 0; i < 4; i++) t.hook(`d1.${i}.jsonl`, { session: `s${i}`, kind: "llm.call", model: "m" }, i);
    await t.ingest();
    t.adapter.parseVersion = 2;
    const lockPath = join(t.env.CODING_SH_HOME, "spool", ".ingest.lock");
    let clock = T0;
    let wakes = 0;
    const seen: boolean[] = [];
    const r = await reparse({
      config: defaultConfig(t.env), index: t.index, blobs: t.blobs, env: t.env, adapters: t.adapters,
      // Each session takes longer than a hold: the lock is released after every one.
      now: () => (clock += 5_000),
      onWake: async () => {
        wakes++;
        await ingest({ config: defaultConfig(t.env), index: t.index, blobs: t.blobs, env: t.env, adapters: t.adapters });
      },
      onProgress: (p) => {
        if (p.phase !== "sessions") return;
        seen.push(existsSync(lockPath));
        if (p.done === 1) {
          // A hook spools a line and touches the wake marker while the re-parse holds the lock.
          t.hook("d2.9.jsonl", { session: "fresh", kind: "llm.call", model: "m" }, 9);
          writeFileSync(wakeMarker(lockPath), "");
        }
      },
    });
    assert.equal(r.reparsed, 4);
    assert.ok(seen.every(Boolean), "every session is written under the ingest lock");
    assert.equal(wakes, 1, "the marker woke one ingest, after the hold it was left in");
    assert.equal((await t.stats("fresh")).events, 1, "the line spooled mid-re-parse is indexed");
    await t.index.close();
  });

  it("a new fold version refolds every stored session once, from its rows, and a cut-short pass resumes", async () => {
    const t = await setup();
    for (const s of ["a", "b", "c"]) t.hook(`d1.${s}.jsonl`, { session: s, kind: "llm.call", model: "m" }, 1);
    await t.ingest();
    assert.equal(await t.due(), false, "a store whose sessions all came from this version has nothing to refold");
    // Sessions an older coding.sh derived: a flag this version no longer gives, and its fold version.
    for (const id of ["a", "b", "c"]) {
      const s = (await t.index.getSession(id))!;
      await t.index.upsertSession({ ...s, flags: [...s.flags, "old-flag"] });
    }
    await t.index.setCursor(REFOLD_CURSOR, SESSION_FOLD_VERSION - 1);
    // An earlier pass got as far as "a" before it was stopped.
    await t.index.kvSet!("reparse:fold-after", JSON.stringify({ v: foldStamp(), id: "a" }));
    assert.equal(await t.due(), true);
    const r = await t.reparse();
    assert.deepEqual([r.sessions, r.refolded], [0, 2], "nothing stale; b and c refolded, a was done");
    const flags = async (id: string) => (await t.index.getSession(id))!.flags.includes("old-flag");
    assert.deepEqual([await flags("a"), await flags("b"), await flags("c")], [true, false, false]);
    assert.equal(await t.index.getCursor(REFOLD_CURSOR), foldStamp());
    assert.equal(await t.due(), false);
    assert.equal((await t.reparse()).refolded, 0, "once per fold version");
    // A session the last run under these parsers kept (stale, no source it could use) is refolded, not read again.
    const c = (await t.index.getSession("c"))!;
    await t.index.upsertSession({ ...c, parseVersion: t.adapter.parseVersion! - 1 });
    await t.index.setCursor(REFOLD_CURSOR, SESSION_FOLD_VERSION - 1);
    const fold = await t.reparse();
    assert.deepEqual([fold.sessions, fold.refolded], [0, 3]);
    assert.equal((await t.index.getSession("c"))!.parseVersion, t.adapter.parseVersion! - 1);
    // `ingest --rebuild` re-parses every adapter session; one no adapter made (OTel, SDK) is refolded.
    await t.index.replaceSessionEvents!("otel", [], [{ id: "o1", v: 0, sessionId: "otel", ts: T0, agent: "otel", kind: "llm.call", payload: { model: "m" } }]);
    for (const id of ["a", "otel"]) {
      const s = (await t.index.getSession(id)) ?? { id, agent: "otel", startedAt: T0, stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] };
      await t.index.upsertSession({ ...s, flags: [...s.flags, "old-flag"] });
    }
    await t.index.setCursor(REFOLD_CURSOR, SESSION_FOLD_VERSION - 1);
    const all = await t.reparse({ all: true });
    assert.deepEqual([all.sessions, all.refolded], [3, 1]);
    assert.deepEqual([await flags("a"), await flags("otel")], [false, false]);
    await t.index.close();
  });

  it("a session stored before weight edits were folded gains the stat and the tag on the refold", async () => {
    const t = await setup();
    const edit = { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4, 8], changed: 12, l2: 0.25, maxAbs: 0.1, baseSha256: "a".repeat(64), editedSha256: "b".repeat(64) };
    await t.index.replaceSessionEvents!("sdk", [], [
      { id: "w0", v: 0, sessionId: "sdk", ts: T0, agent: "sdk", kind: "session.start", payload: {} },
      { id: "w1", v: 0, sessionId: "sdk", ts: T0 + 1, agent: "sdk", kind: "notification", payload: edit },
    ]);
    // What fold version 19 stored for it: no stat, no tag.
    await t.index.upsertSession({ id: "sdk", agent: "sdk", startedAt: T0, stats: { events: 2, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] });
    await t.index.setCursor(REFOLD_CURSOR, 19 * 1e9);
    assert.equal(await t.due(), true);
    assert.equal((await t.reparse()).refolded, 1);
    const s = (await t.index.getSession("sdk"))!;
    assert.deepEqual(s.stats.weightEdits, { events: 1, tensors: 1, weightsChanged: 12 });
    assert.deepEqual(s.flags, ["weights:edited"]);
    await t.index.close();
  });

  it("one re-parse at a time", async () => {
    const t = await setup();
    const lock = await acquireLock(paths(t.env).reparseLock, { waitMs: 0 });
    await assert.rejects(t.reparse(), { name: "LockBusyError" });
    lock.release();
    assert.equal((await t.reparse()).errors.length, 0);
    await t.index.close();
  });

  it("does nothing on a store that can't swap a session's events", async () => {
    const index = new MemoryIndexStore();
    Object.defineProperty(index, "replaceSessionEvents", { value: undefined });
    const adapters = new Map<string, Adapter>([["vf", { ...versioned([]), parseVersion: 2 }]]);
    await index.upsertSession({ id: "s", agent: "vf", startedAt: 1, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [], parseVersion: 1 });
    assert.equal(await reparseDue(index, adapters), false);
    const r = await reparse({ config: defaultConfig({}), index, blobs: new MemoryBlobStore(), adapters, runLock: false });
    assert.match(r.errors[0]!.message, /can't replace/);
  });

  it("SQLite migration 6 marks existing sessions as parse version 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reparse-mig-"));
    roots.push(root);
    const path = join(root, "v5.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 5)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    db.exec(`INSERT INTO sessions (id, agent, started_at, stats, flags) VALUES ('old', 'codex', 1, '{"events":0,"turns":0,"toolCalls":0,"toolErrors":0,"filesChanged":0}', '[]')`);
    db.close();
    const s = await SqliteIndexStore.open(path);
    assert.equal((await s.getSession("old"))?.parseVersion, 1);
    // An upsert that leaves it unset keeps the stored version.
    const { parseVersion: _p, ...rest } = (await s.getSession("old"))!;
    await s.upsertSession({ ...rest, title: "t" });
    assert.equal((await s.getSession("old"))?.parseVersion, 1);
    await s.upsertSession({ ...rest, parseVersion: 3 });
    assert.equal((await s.getSession("old"))?.parseVersion, 3);
    await s.close();
  });
});
