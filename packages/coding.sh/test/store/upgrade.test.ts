// A migration is one-way, so the store keeps a way back and says who wrote it:
// the copy of the index made before one (index.db.v<N>.bak), the writer stamp a
// build checks before migrating, the error for a store a newer coding.sh
// migrated, and a progress line that counts events. On 2026-11-08 a stale build
// migrated a real index from v8 to v9: there was no copy, and the installed
// coding.sh could not open the store again.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../src/store/sqlite.ts";
import { backupIndex, backupPath, BackupSpaceError, listBackups, parseWriter, restoreBackup, StoreNewerError, undonePath, WRITER_KEY, type BackupIo, type StoreWriter } from "../../src/store/upgrade.ts";

const root = mkdtempSync(join(tmpdir(), "csh-upgrade-"));
after(() => rmSync(root, { recursive: true, force: true }));

const OLD = SQLITE_SCHEMA_VERSION - 1;
let seq = 0;
const dbPath = (): string => join(mkdtempSync(join(root, `s${seq++}-`)), "index.db");

/** An index at schema `v` holding `events` events, as the coding.sh that knew only up to v left it. */
async function storeAt(file: string, v: number, events = 3, writer?: StoreWriter): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL"); // as every store coding.sh opened is
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= v)) {
    db.exec(m.sql);
    m.after?.(db);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
  }
  const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES (?, 's', ?, 'claude-code', 'user.message', ?)");
  for (let i = 0; i < events; i++) insert.run(`e${i}`, i, JSON.stringify({ text: `message ${i}` }));
  if (writer) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)").run(WRITER_KEY, JSON.stringify(writer));
  db.close();
}

async function peek(file: string): Promise<{ schema: number; events: number; writer: StoreWriter | undefined }> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      schema: (db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v,
      events: (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n,
      writer: parseWriter((db.prepare("SELECT value FROM kv WHERE key = ?").get(WRITER_KEY) as { value?: unknown } | undefined)?.value),
    };
  } finally {
    db.close();
  }
}

const siblings = (file: string): string[] => readdirSync(join(file, "..")).filter((f) => !/-(wal|shm)$/.test(f)).sort();

describe("a migration keeps the index as it was", () => {
  it("copies the index to index.db.v<N>.bak before migrating, and the copy opens at the old schema with every event", async () => {
    const file = dbPath();
    await storeAt(file, OLD, 4);
    const s = await SqliteIndexStore.open(file);
    assert.equal((await s.listEvents("s")).length, 4);
    await s.close();
    assert.deepEqual(siblings(file), ["index.db", `index.db.v${OLD}.bak`]);
    assert.deepEqual(await peek(backupPath(file, OLD)), { schema: OLD, events: 4, writer: undefined });
    assert.equal((await peek(file)).schema, SQLITE_SCHEMA_VERSION);
  });

  it("includes what was still in the WAL when the migration started", async () => {
    const file = dbPath();
    await storeAt(file, OLD, 1);
    const { DatabaseSync } = await loadSqlite();
    // A second connection that stays open keeps the frames in the WAL after the write.
    const reader = new DatabaseSync(file);
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES ('late', 's', 9, 'claude-code', 'user.message', '{}')").run();
    assert.ok(statSync(`${file}-wal`).size > 0, "the new event is in the WAL only");
    const s = await SqliteIndexStore.open(file);
    await s.close();
    writer.close();
    reader.close();
    assert.equal((await peek(backupPath(file, OLD))).events, 2);
  });

  it("a new store and a store already at this schema get no copy", async () => {
    const file = dbPath();
    await (await SqliteIndexStore.open(file)).close();
    await (await SqliteIndexStore.open(file)).close();
    assert.deepEqual(siblings(file), ["index.db"]);
  });

  it("keeps one way back: the copy of an older schema goes when a later migration finishes", async () => {
    const file = dbPath();
    await storeAt(file, OLD);
    writeFileSync(backupPath(file, OLD - 1), "the copy from the migration before");
    await (await SqliteIndexStore.open(file)).close();
    assert.deepEqual(listBackups(file).map((b) => b.schema), [OLD]);
  });

  it("a refused migration leaves the store and its folder as they were", async () => {
    const file = dbPath();
    await storeAt(file, OLD);
    await assert.rejects(SqliteIndexStore.open(file, { beforeMigrate: () => { throw new Error("not yours"); } }), /not yours/);
    assert.deepEqual(siblings(file), ["index.db"]);
    assert.equal((await peek(file)).schema, OLD);
  });

  it("a migration that fails removes the copy it made: the store is still what it was", async () => {
    const file = dbPath();
    await storeAt(file, OLD);
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file);
    db.exec("CREATE INDEX events_duration ON events(ts)"); // v11's CREATE INDEX events_duration fails
    db.close();
    await assert.rejects(SqliteIndexStore.open(file), /already exists/);
    assert.deepEqual(siblings(file), ["index.db"]);
    assert.equal((await peek(file)).schema, OLD);
  });

  it("without copy-on-write it makes a full copy, and refuses with the size needed when that would not fit", async () => {
    const file = dbPath();
    await storeAt(file, OLD);
    const size = statSync(file).size;
    const calls: string[] = [];
    const io = (free: number | undefined): BackupIo => ({
      clone: () => {
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      },
      copy: (src, dest) => {
        calls.push(`copy ${basename(src)}`);
        writeFileSync(dest, "copy");
      },
      size: (p) => statSync(p).size,
      free: () => free,
    });
    await assert.rejects(
      async () => backupIndex(file, OLD, io(size - 1)),
      (e: unknown) => e instanceof BackupSpaceError && e.needed > size && e.free === size - 1 && /GB free/.test(e.message) && e.message.includes(file),
    );
    assert.deepEqual(calls, [], "nothing was copied");
    assert.deepEqual(siblings(file), ["index.db"]);
    // The migration itself is refused for the same reason, and nothing changes.
    await assert.rejects(SqliteIndexStore.open(file, { backup: (p, from) => backupIndex(p, from, io(0)) }), BackupSpaceError);
    assert.equal((await peek(file)).schema, OLD);
    assert.deepEqual(siblings(file), ["index.db"]);
    // Room for it (or a platform that can't tell): a full copy.
    assert.equal(backupIndex(file, OLD, io(size * 1000 + 1e9)), backupPath(file, OLD));
    assert.equal(backupIndex(file, OLD, io(undefined)), backupPath(file, OLD));
    assert.deepEqual(calls, ["copy index.db", "copy index.db"]);
  });

  it("restoreBackup puts the copy back and keeps the index it replaces", async () => {
    const file = dbPath();
    await storeAt(file, OLD, 2);
    const s = await SqliteIndexStore.open(file);
    await s.putEvents([{ id: "after", v: 0, sessionId: "s", ts: 99, agent: "claude-code", kind: "user.message", payload: { text: "indexed after the migration" } }]);
    await s.close();
    const [backup] = listBackups(file);
    assert.ok(backup);
    const undone = restoreBackup(file, backup, SQLITE_SCHEMA_VERSION);
    assert.equal(undone, undonePath(file, SQLITE_SCHEMA_VERSION));
    assert.deepEqual(siblings(file), ["index.db", `index.db.v${SQLITE_SCHEMA_VERSION}.undone`]);
    assert.deepEqual(await peek(file), { schema: OLD, events: 2, writer: undefined });
    assert.equal((await peek(undone)).events, 3, "what was indexed since is in the replaced index");
  });
});

describe("the store names its last writer", () => {
  it("an open with a version stamps a new store, and a migration stamps in the same transaction", async () => {
    const fresh = dbPath();
    await (await SqliteIndexStore.open(fresh, { writer: "1.2.3" })).close();
    const w = (await peek(fresh)).writer;
    assert.deepEqual([w?.version, w?.schema], ["1.2.3", SQLITE_SCHEMA_VERSION]);

    const old = dbPath();
    await storeAt(old, OLD, 1, { version: "1.2.3", schema: OLD, at: 1 });
    await (await SqliteIndexStore.open(old, { writer: "1.2.3" })).close();
    assert.equal((await peek(old)).writer?.schema, SQLITE_SCHEMA_VERSION);
    assert.equal((await peek(backupPath(old, OLD))).writer?.schema, OLD, "the copy keeps the stamp it had");
  });

  it("is the newest version that opened the store: an older or equal one leaves the stamp, a newer one replaces it", async () => {
    const file = dbPath();
    await (await SqliteIndexStore.open(file, { writer: "1.2.3" })).close();
    const first = (await peek(file)).writer!;
    for (const v of ["1.2.3", "1.2.2", "1.2.3-beta.1", "not a version"]) await (await SqliteIndexStore.open(file, { writer: v })).close();
    assert.deepEqual((await peek(file)).writer, first);
    await (await SqliteIndexStore.open(file, { writer: "1.3.0" })).close();
    assert.equal((await peek(file)).writer?.version, "1.3.0");
    // No version given (a library open): no stamp is written.
    const bare = dbPath();
    await (await SqliteIndexStore.open(bare)).close();
    assert.equal((await peek(bare)).writer, undefined);
  });

  it("beforeMigrate gets the stamp of a store that has one", async () => {
    const file = dbPath();
    const stamp = { version: "1.2.3", schema: OLD, at: 5 };
    await storeAt(file, OLD, 1, stamp);
    const seen: unknown[] = [];
    await (await SqliteIndexStore.open(file, { beforeMigrate: (from, to, writer) => void seen.push([from, to, writer]) })).close();
    assert.deepEqual(seen, [[OLD, SQLITE_SCHEMA_VERSION, stamp]]);
  });
});

describe("a store a newer coding.sh migrated", () => {
  it("fails with a StoreNewerError that names the writer, the spool and coding.sh update, and closes the file", async () => {
    const file = dbPath();
    await (await SqliteIndexStore.open(file)).close();
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file);
    db.exec(`INSERT INTO migrations (version, applied_at) VALUES (${SQLITE_SCHEMA_VERSION + 1}, 0)`);
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)").run(WRITER_KEY, JSON.stringify({ version: "9.9.9", schema: SQLITE_SCHEMA_VERSION + 1, at: 1 }));
    db.close();
    await assert.rejects(
      SqliteIndexStore.open(file),
      (e: unknown) =>
        e instanceof StoreNewerError &&
        e.schema === SQLITE_SCHEMA_VERSION + 1 &&
        e.known === SQLITE_SCHEMA_VERSION &&
        e.writer?.version === "9.9.9" &&
        /written by coding\.sh 9\.9\.9/.test(e.message) &&
        /safe in the spool/.test(e.message) &&
        /coding\.sh update/.test(e.message),
    );
    assert.equal(existsSync(backupPath(file, SQLITE_SCHEMA_VERSION + 1)), false);
    rmSync(file); // Windows: fails if the refused open left the file open
  });
});

describe("upgrade progress counts events", () => {
  it("says how many events the store holds, not its highest rowid", async () => {
    const file = dbPath();
    await storeAt(file, OLD, 10);
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file);
    // Rowids keep their gaps where events were deleted (gc, purge, a re-parse).
    db.exec("DELETE FROM events WHERE id IN ('e0', 'e1', 'e2', 'e3', 'e4', 'e5')");
    db.close();
    const lines: string[] = [];
    await (await SqliteIndexStore.open(file, { progress: (l) => lines.push(l), progressMinRows: 1 })).close();
    assert.match(lines[0]!, /the index holds 4 events; upgrading it from schema v\d+ to v\d+/);
    for (const l of lines) assert.doesNotMatch(l, /\b10\b events|of 10 events/, l);
    assert.match(lines.at(-1)!, new RegExp(`index upgraded in [\\d.]+s\\..*kept at .*index\\.db\\.v${OLD}\\.bak.*coding\\.sh upgrade-store --restore`));
  });
});
