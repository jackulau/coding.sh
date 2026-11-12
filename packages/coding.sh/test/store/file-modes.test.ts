// The index and the blob pack hold prompts, tool output and file contents: only
// their owner can read them, whatever the umask. Not on Windows (no POSIX modes).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { backupIndex } from "../../src/store/upgrade.ts";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;
const private_ = (p: string) => assert.equal(mode(p) & 0o077, 0, `${p} is ${mode(p).toString(8)}`);

describe("store files are owner-only", { skip: !posix && "no POSIX file modes on Windows" }, () => {
  let root: string;
  let umask: number;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "csh-modes-"));
    umask = process.umask(0o022);
  });
  after(() => {
    process.umask(umask);
    rmSync(root, { recursive: true, force: true });
  });

  test("a new index: its home dir, index.db, -wal and -shm", async () => {
    const home = join(root, "new", "home");
    const db = join(home, "index.db");
    const st = await SqliteIndexStore.open(db);
    try {
      await st.upsertSession({ id: "s", agent: "claude-code", startedAt: 1, flags: [], stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } });
      assert.equal(mode(home), 0o700);
      for (const p of [db, `${db}-wal`, `${db}-shm`]) private_(p);
    } finally {
      await st.close();
    }
  });

  test("an index made world-readable before is owner-only once opened", async () => {
    const db = join(root, "old.db");
    await (await SqliteIndexStore.open(db)).close();
    for (const p of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(p)) chmodSync(p, 0o644);
    const st = await SqliteIndexStore.open(db);
    try {
      for (const p of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(p)) private_(p);
    } finally {
      await st.close();
    }
  });

  test("the backup a migration keeps", () => {
    const db = join(root, "b.db");
    writeFileSync(db, "x");
    chmodSync(db, 0o644);
    private_(backupIndex(db, 1));
  });

  test("blobs/pack.db and the blobs dir", async () => {
    const dir = join(root, "blobs");
    const blobs = new FsBlobStore(dir);
    try {
      await blobs.put("a small blob goes in the pack");
      private_(dir);
      private_(join(dir, "pack.db"));
      for (const p of [join(dir, "pack.db-wal"), join(dir, "pack.db-shm")]) if (existsSync(p)) private_(p);
    } finally {
      blobs.close();
    }
  });
});
