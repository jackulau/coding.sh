// The record of the last ingest (core/ingest-health.ts, `<home>/ingest-last.json`): every ingest and
// backfill that finishes writes it, one that finds nothing new too; one that fails leaves the one
// before. Reads use it to say how old the index is.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { Adapter } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest } from "../../src/core/ingest.ts";
import { indexAge, indexAgeField, indexAgeText, indexUpdatedText, lastIngestFile, readLastIngest, recordLastIngest, staleIndexText } from "../../src/core/ingest-health.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const root = mkdtempSync(join(tmpdir(), "csh-ingest-last-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
const MIN = 60e3;

/** A home with a spool for the `plain` agent below. */
function home(): { env: NodeJS.ProcessEnv; dir: string; spool: string } {
  const dir = join(root, `h${seq++}`);
  const spool = join(dir, "spool", "plain");
  mkdirSync(spool, { recursive: true });
  return { env: { CODING_SH_HOME: dir, HOME: join(root, "user") }, dir, spool };
}

/** One notification event per spool line. */
const plain: Adapter = {
  id: "plain",
  displayName: "Plain",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    return [{ id: ctx.id(line.agent, line.event), v: 0, sessionId: "s1", ts: line.ts, agent: line.agent, kind: "notification", payload: {} } as AgentEvent];
  },
};

const opts = (env: NodeJS.ProcessEnv, index = new MemoryIndexStore()) => ({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), env, adapters: new Map([[plain.id, plain]]) });

/** Files beside the record other than the record itself: a temp file left by a write. */
const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith("ingest-last.json") && f !== "ingest-last.json");

describe("ingest and backfill record when they finished", () => {
  it("an ingest writes the record, one that finds nothing new too, and leaves no temp file", async () => {
    const h = home();
    appendFileSync(join(h.spool, "2026-11-06.1.jsonl"), JSON.stringify({ v: 0, agent: "plain", event: "E1", ts: 1_700_000_000_000, pid: 1, cwd: "/work/demo", raw: {} }) + "\n");
    const o = opts(h.env);
    const before = Date.now();
    assert.equal((await ingest(o)).events, 1);
    const first = readLastIngest(h.dir);
    assert.ok(first && first.at >= before && first.at <= Date.now(), JSON.stringify(first));
    assert.match(first.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(leftovers(h.dir), []);
    if (process.platform !== "win32") assert.equal(statSync(lastIngestFile(h.dir)).mode & 0o777, 0o600);
    // Nothing new: the index is still as new as the spool, so the record moves on.
    writeFileSync(lastIngestFile(h.dir), JSON.stringify({ at: 1000, version: "0.0.1" }));
    assert.equal((await ingest(o)).events, 0);
    assert.ok(readLastIngest(h.dir)!.at >= before);
    assert.deepEqual(leftovers(h.dir), []);
  });

  it("an ingest that fails leaves the record before it", async () => {
    const h = home();
    appendFileSync(join(h.spool, "2026-11-06.1.jsonl"), JSON.stringify({ v: 0, agent: "plain", event: "E1", ts: 1_700_000_000_000, pid: 1, cwd: "/work/demo", raw: {} }) + "\n");
    recordLastIngest(h.dir, "0.0.1", 1000);
    const broken = new MemoryIndexStore();
    broken.getCursor = async () => {
      throw new Error("disk I/O error");
    };
    await assert.rejects(ingest(opts(h.env, broken)), /disk I\/O error/);
    assert.deepEqual(readLastIngest(h.dir), { at: 1000, version: "0.0.1" });
    assert.deepEqual(leftovers(h.dir), []);
  });

  it("a backfill that reads every source writes it; one another import turns away does not", async () => {
    const h = home();
    const walker: Adapter = { ...plain, id: "hist", async *backfill() {} };
    const base = { config: defaultConfig(h.env), index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), env: h.env, adapters: [walker] };
    await backfill(base);
    assert.ok(readLastIngest(h.dir));
    recordLastIngest(h.dir, "0.0.1", 1000);
    const lockPath = join(h.dir, "sink.lock");
    const lock = await acquireLock(lockPath);
    try {
      const r = await backfill({ ...base, sinks: [{ name: "s", mode: "full", write: async () => ({ ok: true }) }], lock: { path: lockPath, waitMs: 0 } });
      assert.equal(r.busy, true);
    } finally {
      lock.release();
    }
    assert.equal(readLastIngest(h.dir)!.at, 1000);
  });
});

describe("the record", () => {
  it("is not written into a home that does not exist, and a bad one reads as none", () => {
    const dir = join(root, `missing${seq++}`);
    recordLastIngest(dir, "0.0.1");
    assert.equal(existsSync(dir), false);
    mkdirSync(dir);
    writeFileSync(lastIngestFile(dir), "not json");
    assert.equal(readLastIngest(dir), undefined);
    assert.equal(indexAge(dir), undefined);
    writeFileSync(lastIngestFile(dir), JSON.stringify({ version: "0.0.1" }));
    assert.equal(readLastIngest(dir), undefined);
    assert.deepEqual(indexAgeField(undefined), {});
  });

  it("counts as stale past the stall threshold, unless an ingest runs", async () => {
    const dir = join(root, `age${seq++}`);
    mkdirSync(join(dir, "spool"), { recursive: true });
    const now = Date.parse("2026-11-21T12:00:00Z");
    recordLastIngest(dir, "0.0.1", now - 4 * MIN);
    const fresh = indexAge(dir, now)!;
    assert.deepEqual([fresh.ageMs, fresh.stale, fresh.running], [4 * MIN, false, false]);
    assert.equal(indexAgeText(fresh), "index updated 4m ago");
    assert.equal(indexUpdatedText(fresh), "updated 4m ago");
    assert.deepEqual(indexAgeField(fresh), { index: { updatedAt: "2026-11-21T11:56:00.000Z" } });

    recordLastIngest(dir, "0.0.1", now - 3 * 60 * MIN);
    const old = indexAge(dir, now)!;
    assert.equal(old.stale, true);
    assert.equal(staleIndexText(old), "index updated 3h ago: waits and stalls are as of then; run coding.sh ingest");
    assert.deepEqual(indexAgeField(old), { index: { updatedAt: "2026-11-21T09:00:00.000Z", stale: true } });

    // An ingest holding its lock is bringing the index up to date: old, but not stale.
    recordLastIngest(dir, "0.0.1", Date.now() - 3 * 60 * MIN);
    const lock = await acquireLock(join(dir, "spool", ".ingest.lock"));
    try {
      const running = indexAge(dir)!;
      assert.deepEqual([running.running, running.stale], [true, false]);
    } finally {
      lock.release();
    }
    assert.equal(readFileSync(lastIngestFile(dir), "utf8").endsWith("\n"), true);
  });
});
