import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addUsage, copyMargin, emitToolEnd, Emitter, envVar, fileTouches, findBinary, isOurCommand, jsonlTail, openSqliteCopy, openSqliteInPlace, parseJsonc, readSnapshot, spawnAgent, sqliteBusy, sqliteShapeError, testResultFor, toMs, usageFrom } from "../../../src/adapters/more/_util.ts";
import type { TmpEnv } from "../_helpers.ts";
import { fakeBinary, moreEnv, testCtx } from "./_helpers.ts";
import { nodeBin } from "../../_bin.ts";
import { startWriter, type Writer } from "../_sqlite-writer.ts";
import { reapSqliteCopies, SQLITE_COPY_OWNER, SQLITE_COPY_PREFIX, UNOWNED_COPY_AGE_MS } from "../../../src/adapters/_shared/sqlite-copies.ts";

const TMP_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
/** Points os.tmpdir() at a fresh dir for the test's copies; returns it and a restore. */
function ownTmpdir(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "csh-sqltmp-"));
  const saved = Object.fromEntries(TMP_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TMP_KEYS) process.env[k] = dir;
  assert.equal(tmpdir(), dir);
  return {
    dir,
    restore() {
      for (const k of TMP_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const copies = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(SQLITE_COPY_PREFIX));
const UTIL = new URL("../../../src/adapters/more/_util.ts", import.meta.url).href;
/** A database in rollback-journal mode (the default) with one row, closed. */
const makeDb = async (root: string) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(root, "agent.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
  db.close();
  return path;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("openSqliteCopy", () => {
  it("reads rows still in the agent's WAL from a read-only copy, and leaves the agent's files as they were", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const root = mkdtempSync(join(tmpdir(), "csh-sqlcopy-"));
    const path = join(root, "agent.sqlite");
    // The agent's writer stays open with its rows in the WAL, as a running app's would.
    const writer = new DatabaseSync(path);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);");
      const before = [path, `${path}-wal`].map((f) => readFileSync(f));
      assert.ok(before[1]!.length > 0, "the rows are in the WAL");
      const h = await openSqliteCopy(path);
      assert.ok(h);
      try {
        assert.equal(h.db.prepare("SELECT count(*) AS n FROM t").get()?.n, 3);
        // Read-only: closing it doesn't fold the copied WAL into the copy (seconds for a large store).
        assert.throws(() => h.db.exec("INSERT INTO t VALUES (4)"), /readonly/i);
      } finally {
        h.close();
      }
      assert.deepEqual([path, `${path}-wal`].map((f) => readFileSync(f)), before);
      assert.equal(existsSync(path), true);
    } finally {
      writer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("openSqliteCopy temp copies", () => {
  it("removes a copy whose owner was killed before it could, and keeps live owners' copies", async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = await makeDb(src);
      // A process killed while it holds a copy (a read's tail child at its deadline): no cleanup runs.
      const killed = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `const { openSqliteCopy } = await import(${JSON.stringify(UTIL)}); const h = await openSqliteCopy(${JSON.stringify(path)}); process.kill(process.pid, "SIGKILL");`], { encoding: "utf8", env: { ...process.env } });
      assert.equal(killed.status === 0, false, killed.stderr);
      assert.equal(copies(t.dir).length, 1, "the killed process left its copy");
      const [left] = copies(t.dir);
      assert.ok(existsSync(join(t.dir, left!, "agent.sqlite")));
      // A copy of a process still running, and one being made right now (no owner file yet).
      const liveDir = join(t.dir, `${SQLITE_COPY_PREFIX}live01`);
      mkdirSync(liveDir);
      const sleeper = (await import("node:child_process")).spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      try {
        writeFileSync(join(liveDir, SQLITE_COPY_OWNER), String(sleeper.pid));
        const fresh = join(t.dir, `${SQLITE_COPY_PREFIX}fresh1`);
        mkdirSync(fresh);
        // From before owner files: no owner, untouched for longer than a copy is in use.
        const old = join(t.dir, `${SQLITE_COPY_PREFIX}old001`);
        mkdirSync(old);
        writeFileSync(join(old, "agent.sqlite"), "x");
        const then = (Date.now() - UNOWNED_COPY_AGE_MS - 60_000) / 1000;
        utimesSync(join(old, "agent.sqlite"), then, then);
        utimesSync(old, then, then);
        // The next open removes the killed process's copy and the old one, and closes its own.
        const h = await openSqliteCopy(path);
        assert.ok(h);
        assert.equal(h.db.prepare("SELECT count(*) AS n FROM t").get()?.n, 1);
        h.close();
        assert.deepEqual(copies(t.dir).sort(), [`${SQLITE_COPY_PREFIX}fresh1`, `${SQLITE_COPY_PREFIX}live01`]);
        // Once its owner has stopped, the live one goes too.
        sleeper.kill();
        await new Promise((r) => sleeper.once("exit", r));
        assert.equal(reapSqliteCopies(), 1);
        assert.deepEqual(copies(t.dir), [`${SQLITE_COPY_PREFIX}fresh1`]);
      } finally {
        sleeper.kill();
      }
    } finally {
      t.restore();
    }
  });

  // A removal cut short (the read kills its tail child while the child's exit is removing its copy, or a file is
  // still held open) used to take the owner file first and leave the rest, which then looked like a copy being made.
  it("a removal cut short keeps the owner file, and the next reap removes the rest", { skip: process.platform !== "win32" && process.getuid?.() === 0 }, async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const { DatabaseSync } = await import("node:sqlite");
      // Named as T3 Code's store is: it sorts after the owner file.
      const path = join(src, "statev2.sqlite");
      const w = new DatabaseSync(path);
      w.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
      w.close();
      const killed = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `const { openSqliteCopy } = await import(${JSON.stringify(UTIL)}); const h = await openSqliteCopy(${JSON.stringify(path)}); process.kill(process.pid, "SIGKILL");`], { encoding: "utf8", env: { ...process.env } });
      assert.equal(killed.status === 0, false, killed.stderr);
      const [name] = copies(t.dir);
      assert.ok(name, "the killed process left its copy");
      const dir = join(t.dir, name);
      // Something the removal can't take: on Windows the database held open by SQLite (no delete sharing),
      // elsewhere a file in a directory that can't be written.
      let unblock: () => void;
      if (process.platform === "win32") {
        const held = new DatabaseSync(join(dir, "statev2.sqlite"), { readOnly: true });
        held.prepare("SELECT count(*) FROM t").get();
        unblock = () => held.close();
      } else {
        const locked = join(dir, "statev2.sqlite-wal");
        mkdirSync(locked);
        writeFileSync(join(locked, "x"), "x");
        chmodSync(locked, 0o500);
        unblock = () => chmodSync(locked, 0o700);
      }
      try {
        assert.equal(reapSqliteCopies(), 0);
        assert.ok(existsSync(join(dir, SQLITE_COPY_OWNER)), "the owner file stays while the rest can't be removed");
      } finally {
        unblock();
      }
      assert.equal(reapSqliteCopies(), 1);
      assert.deepEqual(copies(t.dir), []);
    } finally {
      t.restore();
    }
  });

  // On Windows a child killed a moment ago can still hold its copy open, and the reap waits up to a second for it. On
  // Node 24 rmSync's own retries did not wait, so the copy (T3 Code's is 1.7 GB) stayed until the next read.
  it("waits for a child it just killed to let go of its copy, then removes it", { skip: process.platform !== "win32" && "a file held open blocks removal only on Windows", timeout: 30_000 }, async () => {
    const t = ownTmpdir();
    try {
      const dir = join(t.dir, `${SQLITE_COPY_PREFIX}held01`);
      mkdirSync(dir);
      const file = join(dir, "statev2.sqlite");
      writeFileSync(file, "x");
      // The killed child, still exiting: it holds the database with no sharing for a moment more.
      const script = `$f = [System.IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Write-Output locked; Start-Sleep -Milliseconds 400; $f.Close()`;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"] });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        writeFileSync(join(dir, SQLITE_COPY_OWNER), String(child.pid));
        await new Promise<void>((resolve, reject) => {
          let out = "";
          child.stdout!.on("data", (d) => {
            out += d;
            if (out.includes("locked")) resolve();
          });
          child.once("exit", (code) => reject(new Error(`the child exited (${code}) before it held the copy`)));
        });
        assert.equal(reapSqliteCopies({ killed: child.pid }), 1);
        assert.deepEqual(copies(t.dir), []);
      } finally {
        child.kill();
        await exited;
      }
    } finally {
      t.restore();
    }
  });

  it("removes a copy still open when its process exits", async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = await makeDb(src);
      const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `const { openSqliteCopy } = await import(${JSON.stringify(UTIL)}); const h = await openSqliteCopy(${JSON.stringify(path)}); if (!h) process.exit(3); process.exit(0);`], { encoding: "utf8", env: { ...process.env } });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(copies(t.dir), []);
    } finally {
      t.restore();
    }
  });

  it("a copy that fails resolves undefined, or throws with throwOnError, and leaves no dir", async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = await makeDb(src);
      // A -wal that can't be copied (a directory), as a full temp volume can't take the copy.
      mkdirSync(`${path}-wal`);
      assert.equal(await openSqliteCopy(path), undefined);
      await assert.rejects(openSqliteCopy(path, { throwOnError: true }), (e: Error) => e.message.includes("could not copy") && e.message.includes(t.dir));
      assert.deepEqual(copies(t.dir), []);
    } finally {
      t.restore();
    }
  });
});

describe("openSqliteInPlace", () => {
  const count = (db: import("node:sqlite").DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM t").get()?.n);

  it("reads a database its writer has open in WAL mode where it is: no copy, and the writer never gets SQLITE_BUSY", { timeout: 60_000 }, async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    let w: Writer | undefined;
    try {
      const path = join(src, "agent.sqlite");
      // Another process commits every 2 ms with busy_timeout 0, and checkpoints every 10 pages.
      w = await startWriter(path, { setup: "PRAGMA wal_autocheckpoint = 10; CREATE TABLE t (x INTEGER)", step: "INSERT INTO t VALUES ($n)", everyMs: 2 });
      const h = await openSqliteInPlace(path);
      assert.ok(h);
      try {
        assert.equal(h.inPlace, true);
        assert.deepEqual(copies(t.dir), []);
        const first = readSnapshot(h.db, () => count(h.db));
        let last = first;
        for (const end = Date.now() + 20_000; last < first + 20 && Date.now() < end; await sleep(5)) last = readSnapshot(h.db, () => count(h.db));
        assert.ok(last >= first + 20, `the reads see the writer's commits (${first}, then ${last})`);
        // One read transaction is one snapshot: commits made during it show in the next one.
        h.db.exec("BEGIN");
        const a = count(h.db);
        await sleep(200);
        assert.equal(count(h.db), a);
        h.db.exec("COMMIT");
        assert.ok(readSnapshot(h.db, () => count(h.db)) > a);
        assert.throws(() => h.db.exec("INSERT INTO t VALUES (0)"), /readonly/i);
      } finally {
        h.close();
      }
      const r = await w.stop();
      assert.deepEqual([r.busy, r.errors], [0, []]);
      assert.ok(r.commits > 20, `${r.commits} commits`);
      assert.deepEqual(copies(t.dir), []);
    } finally {
      await w?.kill();
      t.restore();
    }
  });

  it("opens a database in rollback-journal mode as a copy, and removes the copy on close", async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = await makeDb(src);
      const h = await openSqliteInPlace(path);
      assert.ok(h);
      try {
        assert.equal(h.inPlace, false);
        assert.equal(copies(t.dir).length, 1);
        assert.equal(count(h.db), 1);
      } finally {
        h.close();
      }
      assert.deepEqual(copies(t.dir), []);
      assert.deepEqual(readdirSync(src), ["agent.sqlite"]);
    } finally {
      t.restore();
    }
  });

  it("opens a WAL database without -wal and -shm (no writer has it open) as a copy, and creates no file next to it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = join(src, "agent.sqlite");
      const w = new DatabaseSync(path);
      w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
      w.close(); // the last connection's close checkpoints and removes -wal and -shm
      assert.deepEqual(readdirSync(src), ["agent.sqlite"]);
      const before = readFileSync(path);
      assert.deepEqual([before[18], before[19]], [2, 2], "still in WAL mode");
      // Opened in place, a read-only connection would create -wal and -shm next to it, and leave them.
      const h = await openSqliteInPlace(path);
      assert.ok(h);
      try {
        assert.equal(h.inPlace, false);
        assert.equal(copies(t.dir).length, 1);
        assert.equal(count(h.db), 1);
        assert.deepEqual(readdirSync(src), ["agent.sqlite"]);
      } finally {
        h.close();
      }
      assert.deepEqual(readdirSync(src), ["agent.sqlite"]);
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(copies(t.dir), []);
      // A -wal with no -shm, as a crash between the two can leave: a copy too, and no -shm appears.
      writeFileSync(`${path}-wal`, "");
      const h2 = await openSqliteInPlace(path);
      assert.ok(h2);
      try {
        assert.equal(h2.inPlace, false);
        assert.equal(count(h2.db), 1);
      } finally {
        h2.close();
      }
      assert.deepEqual(readdirSync(src).sort(), ["agent.sqlite", "agent.sqlite-wal"]);
      assert.deepEqual(copies(t.dir), []);
    } finally {
      t.restore();
    }
  });

  it("opens a database its writer holds in exclusive locking mode as a copy", { timeout: 60_000 }, async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    let w: Writer | undefined;
    try {
      const path = join(src, "agent.sqlite");
      // CREATE TABLE opens -wal and -shm before the switch, so the database looks open in WAL mode.
      w = await startWriter(path, { setup: "CREATE TABLE t (x INTEGER)", step: "INSERT INTO t VALUES ($n)", everyMs: 0, exclusive: true });
      assert.ok(existsSync(`${path}-wal`) && existsSync(`${path}-shm`));
      // In place, the first read fails: the writer holds the database's exclusive lock.
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(path, { readOnly: true });
      try {
        assert.throws(() => count(raw), (e: unknown) => sqliteBusy(e));
      } finally {
        raw.close();
      }
      const h = await openSqliteInPlace(path);
      assert.ok(h);
      try {
        assert.equal(h.inPlace, false);
        assert.equal(copies(t.dir).length, 1);
        assert.equal(count(h.db), 1);
      } finally {
        h.close();
      }
      assert.deepEqual(copies(t.dir), []);
      assert.deepEqual(await w.stop(), { commits: 1, busy: 0, errors: [] });
    } finally {
      await w?.kill();
      t.restore();
    }
  });

  it("reads a WAL database whose writer was killed in place, and leaves the database and its -wal as they were", { timeout: 60_000 }, async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    let w: Writer | undefined;
    try {
      const path = join(src, "agent.sqlite");
      w = await startWriter(path, { setup: "PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x INTEGER)", step: "INSERT INTO t VALUES ($n)", everyMs: 0 });
      await w.kill(); // no close: -wal and -shm stay, the row only in the WAL
      const orig = [path, `${path}-wal`].map((f) => readFileSync(f));
      assert.ok(orig[1]!.length > 0, "the row is in the WAL");
      const h = await openSqliteInPlace(path);
      assert.ok(h);
      try {
        assert.equal(h.inPlace, true);
        assert.equal(count(h.db), 1);
      } finally {
        h.close();
      }
      // The first reader rebuilds -shm from the WAL, as any reader does after a crash; the database and WAL are not written.
      assert.deepEqual([path, `${path}-wal`].map((f) => readFileSync(f)), orig);
      assert.deepEqual(copies(t.dir), []);
    } finally {
      await w?.kill();
      t.restore();
    }
  });
});

describe("room for a copy", () => {
  it("makes no copy that would leave less free in the temp directory than it takes, and names the sizes", async () => {
    const t = ownTmpdir();
    const src = mkdtempSync(join(t.dir, "src-"));
    try {
      const path = await makeDb(src);
      const need = statSync(path).size;
      assert.ok(need >= 1000 && need < 1e6, `a database of a few kB (${need} B)`);
      const kB = (n: number) => `${(n / 1e3).toFixed(1)} kB`;
      const asked: string[] = [];
      const room = (free: number | undefined) => (dir: string) => {
        asked.push(dir);
        return free;
      };
      assert.equal(await openSqliteCopy(path, { room: room(2 * need - 1) }), undefined);
      assert.deepEqual(asked, [t.dir], "it measures the temp directory");
      await assert.rejects(openSqliteCopy(path, { throwOnError: true, room: room(need) }), {
        message: `could not copy ${path} to ${t.dir}: that needs ${kB(2 * need)} free (${kB(need)} for the copy and ${kB(need)} left over), and ${kB(need)} is free`,
      });
      // In rollback-journal mode, in place falls back to the copy, and so to the same check.
      await assert.rejects(openSqliteInPlace(path, { throwOnError: true, room: room(0) }), /could not copy .* and 0 B is free$/);
      assert.deepEqual(readdirSync(t.dir), [basename(src)], "no copy and no partial file");
      // Enough room, or a platform that can't tell: the copy is made.
      for (const free of [2 * need, undefined]) {
        const h = await openSqliteCopy(path, { room: room(free) });
        assert.ok(h, `a copy with ${free} B free`);
        h.close();
      }
      assert.deepEqual(copies(t.dir), []);
    } finally {
      t.restore();
    }
  });

  it("leaves as much free as the copy takes, up to 2 GB", () => {
    assert.equal(copyMargin(8192), 8192);
    assert.equal(copyMargin(2e9), 2e9);
    assert.equal(copyMargin(5e9), 2e9);
  });
});

describe("readSnapshot", () => {
  it("reads in one transaction, and ends it when the read throws", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const root = mkdtempSync(join(tmpdir(), "csh-snapshot-"));
    const path = join(root, "agent.sqlite");
    const w = new DatabaseSync(path);
    let r: import("node:sqlite").DatabaseSync | undefined;
    try {
      w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
      const db = (r = new DatabaseSync(path, { readOnly: true }));
      const n = () => Number(db.prepare("SELECT count(*) AS n FROM t").get()?.n);
      const both = readSnapshot(db, () => {
        const a = n();
        w.exec("INSERT INTO t VALUES (2)");
        return [a, n()];
      });
      assert.deepEqual(both, [1, 1], "a commit made during the read is not in it");
      assert.equal(db.isTransaction, false);
      assert.equal(readSnapshot(db, n), 2);
      assert.throws(
        () =>
          readSnapshot(db, () => {
            n();
            throw new Error("schema drift");
          }),
        /schema drift/,
      );
      assert.equal(db.isTransaction, false);
      assert.equal(readSnapshot(db, n), 2);
    } finally {
      r?.close();
      w.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sqliteBusy", () => {
  it("is SQLITE_BUSY or SQLITE_LOCKED, extended codes too, or their message", () => {
    const err = (errcode: number) => Object.assign(new Error("x"), { errcode });
    for (const code of [5, 6, 261, 517, 262]) assert.equal(sqliteBusy(err(code)), true, String(code));
    for (const code of [1, 8, 11, 13]) assert.equal(sqliteBusy(err(code)), false, String(code));
    assert.equal(sqliteBusy(new Error("database is locked")), true);
    assert.equal(sqliteBusy(new Error("database table is locked")), true);
    for (const e of [new Error("no such table: t"), null, undefined, "database is locked"]) assert.equal(sqliteBusy(e), false, String(e));
  });
});

describe("sqliteShapeError", () => {
  it("is SQLITE_ERROR or an error SQLite did not raise, never busy, an I/O error, a corrupt page or a full disk", () => {
    const err = (errcode: number) => Object.assign(new Error("x"), { errcode });
    for (const code of [1, 257]) assert.equal(sqliteShapeError(err(code)), true, String(code));
    for (const code of [5, 6, 261, 10, 266, 11, 13, 26]) assert.equal(sqliteShapeError(err(code)), false, String(code));
    assert.equal(sqliteShapeError(new TypeError("Cannot read properties of undefined (reading 'id')")), true);
    assert.equal(sqliteShapeError(new Error("database is locked")), false);
  });
});

describe("testResultFor", () => {
  // The shared parser (parseTestOutput) behind a test or check command. Before it, the more/
  // adapters had a parser of their own: it named node:test "node" and kept skipped: 0.
  const cases: [string, string, string, unknown][] = [
    ["cargo", "cargo test", "test result: FAILED. 5 passed; 1 failed; 2 ignored; 0 measured", { runner: "cargo", passed: 5, failed: 1, skipped: 2 }],
    ["jest", "npx jest", "Tests:       1 failed, 2 skipped, 5 passed, 8 total", { runner: "jest", passed: 5, failed: 1, skipped: 2 }],
    ["vitest", "npx vitest run", "      Tests  2 failed | 10 passed | 1 skipped (13)", { runner: "vitest", passed: 10, failed: 2, skipped: 1 }],
    ["node:test", "node --test", "# tests 6\n# pass 5\n# fail 1\n# skipped 0", { runner: "node:test", passed: 5, failed: 1 }],
    ["node spec", "node --test", "ℹ pass 3\nℹ fail 0", { runner: "node:test", passed: 3, failed: 0 }],
    ["pytest", "pytest", "===== 3 failed, 10 passed, 1 skipped, 2 errors in 0.52s =====", { runner: "pytest", passed: 10, failed: 5, skipped: 1 }],
    ["mocha", "npm test", "  5 passing (20ms)\n  2 pending\n  1 failing", { runner: "mocha", passed: 5, failed: 1, skipped: 2 }],
    ["go", "go test -v ./...", "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- PASS: TestC (0.00s)", { runner: "go", passed: 2, failed: 1 }],
    ["go pkgs", "go test ./...", "ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s", { runner: "go", passed: 1, failed: 1 }],
  ];
  for (const [name, cmd, text, want] of cases) it(name, () => assert.deepEqual(testResultFor({ command: cmd }, text), want));
  it("reads pytest -q's bare summary line, and not prose", () => {
    const bare: [string, number, number][] = [
      ["2 passed in 0.01s", 2, 0],
      ["1 failed, 2 passed in 0.12s", 2, 1],
      ["2 passed, 1 warning in 0.01s", 2, 0],
      ["5 passed in 62.03s (0:01:02)", 5, 0],
    ];
    for (const [line, passed, failed] of bare) assert.deepEqual(testResultFor({ command: "pytest -q" }, `..\n${line}\n`), { runner: "pytest", passed, failed }, line);
    assert.equal(testResultFor({ command: "pytest -q" }, "the value was passed in 3s\n"), undefined);
  });
  it("takes the last summary and ignores ANSI colour", () => {
    assert.deepEqual(testResultFor({ command: "npx jest" }, "Tests:  1 failed, 1 total\n\x1b[1mTests:\x1b[22m  2 passed, 2 total"), { runner: "jest", passed: 2, failed: 0 });
  });
  it("counts mocha and go after a check command, as a test command", () => {
    assert.deepEqual(testResultFor({ command: "npm run check" }, "  5 passing (20ms)\n"), { runner: "mocha", passed: 5, failed: 0 });
    assert.deepEqual(testResultFor({ command: "make verify" }, "ok  \texample.com/a\t0.01s\n"), { runner: "go", passed: 1, failed: 0 });
  });
  it("reads only test and check commands, and only their summaries", () => {
    assert.equal(testResultFor({ command: "cat results.log" }, "2 passed in 0.01s\n"), undefined);
    assert.equal(testResultFor({ command: "npm run build" }, "compiled successfully"), undefined);
  });
});

describe("emitToolEnd", () => {
  it("records a test.result for a pytest -q shell call", async () => {
    const { ctx } = testCtx();
    const em = new Emitter(ctx, { agent: "droid", sessionId: "s1", ts: 1 }, ["s1"]);
    await emitToolEnd(em, ctx, { tool: "Bash", toolUseId: "t1", input: { command: "pytest -q" }, output: "..\n2 passed in 0.01s\n", ok: true }, "/work/demo");
    assert.deepEqual(em.events.find((e) => e.kind === "test.result")?.payload, { runner: "pytest", passed: 2, failed: 0, toolUseId: "t1" });
  });
});

describe("envVar / findBinary on Windows env copies", () => {
  it("reads Windows' own spelling (Path) from a copy of process.env, and only on Windows", () => {
    assert.equal(envVar({ Path: "C:\\bin" }, "PATH", "win32"), "C:\\bin");
    assert.equal(envVar({ Path: "C:\\bin", PATH: "C:\\override" }, "PATH", "win32"), "C:\\override", "an override spelled PATH wins");
    assert.equal(envVar({ Path: "/bin" }, "PATH", "linux"), undefined, "POSIX names are case-sensitive");
  });

  it("findBinary finds an .exe through { ...process.env, ...overrides } (key Path)", { skip: process.platform !== "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-findbin-"));
    try {
      writeFileSync(join(dir, "goose.exe"), "");
      assert.equal(findBinary(["goose"], { Path: dir, PATHEXT: ".COM;.EXE" }), join(dir, "goose.exe"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fileTouches", () => {
  it("reads apply_patch bodies", () => {
    const patch = "*** Begin Patch\n*** Add File: /r/a.ts\n+x\n*** Update File: b.ts\n*** Delete File: /r/c.ts\n*** End Patch";
    assert.deepEqual(fileTouches("apply_patch", { input: patch }, "/r"), [
      { path: "a.ts", op: "add" },
      { path: "b.ts", op: "modify" },
      { path: "c.ts", op: "delete" },
    ]);
  });
  it("maps edit-like tools by name and path keys", () => {
    assert.deepEqual(fileTouches("Create", { file_path: "/r/x.py" }, "/r"), [{ path: "x.py", op: "add" }]);
    assert.deepEqual(fileTouches("delete_file", { path: "/r/y" }, "/r"), [{ path: "y", op: "delete" }]);
    assert.deepEqual(fileTouches("MultiEdit", { edits: [{ file_path: "/r/a" }, { file_path: "/r/a" }, { file_path: "/elsewhere/b" }] }, "/r"), [
      { path: "a", op: "modify" },
      { path: "/elsewhere/b", op: "modify" },
    ]);
  });
  it("ignores read-only tools", () => {
    assert.deepEqual(fileTouches("read_file", { path: "/r/a" }, "/r"), []);
    assert.deepEqual(fileTouches("Bash", { command: "rm -rf x" }, "/r"), []);
  });
});

describe("small parsers", () => {
  it("toMs accepts ISO, seconds and ms", () => {
    assert.equal(toMs("2026-09-21T10:00:00.000Z"), Date.parse("2026-09-21T10:00:00.000Z"));
    assert.equal(toMs(1790000000), 1790000000000);
    assert.equal(toMs(1790000000123), 1790000000123);
    assert.equal(toMs("1790000000"), 1790000000000);
    assert.equal(toMs("nope"), undefined);
  });
  it("toMs reads a time out of the Date range as missing", () => {
    assert.equal(toMs(8.64e15), 8.64e15);
    assert.equal(toMs(-8.64e12), -8.64e15);
    for (const v of [1e308, -1e308, 9e15, -8.7e12, "9000000000000000"]) assert.equal(toMs(v), undefined, String(v));
  });
  it("usageFrom reads the common shapes", () => {
    assert.deepEqual(usageFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, total_cost_usd: 0.5 }), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 });
    assert.deepEqual(usageFrom({ promptTokenCount: 5, candidatesTokenCount: 6, cachedContentTokenCount: 1 }), { inputTokens: 5, outputTokens: 6, cacheReadTokens: 1 });
    assert.deepEqual(usageFrom({ input: 7, output: 8, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }), { inputTokens: 7, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.1 });
    assert.equal(usageFrom({}), undefined);
  });
  it("addUsage skips a count that is not a whole number from 0 to 2^53 - 1 and keeps the rest of the sum", () => {
    assert.deepEqual(addUsage({ inputTokens: 100, outputTokens: 12.5 }, { inputTokens: -1, outputTokens: 20, cacheReadTokens: 2 ** 53 }), { inputTokens: 100, outputTokens: 20 });
    assert.deepEqual(addUsage(undefined, { inputTokens: 10.5, outputTokens: 3, costUsd: 0.5 }), { outputTokens: 3, costUsd: 0.5 });
    assert.deepEqual(addUsage({ inputTokens: 1 }, undefined), { inputTokens: 1 });
  });
  it("parseJsonc tolerates comments and trailing commas", () => {
    assert.deepEqual(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}'), { a: "http://x", b: [1, 2] });
  });
  it("isOurCommand recognises our hook for the right agent only", () => {
    assert.ok(isOurCommand('node "/x/hook.mjs" gemini-cli AfterTool', "gemini-cli"));
    assert.ok(!isOurCommand('node "/x/hook.mjs" gemini-cli AfterTool', "gemini"));
    assert.ok(isOurCommand('/bin/sh "/x/hook.sh" gemini-cli AfterTool', "gemini-cli"));
    assert.ok(!isOurCommand("./guard.sh gemini-cli x", "gemini-cli"));
  });
});

describe("spawnAgent", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("times out, kills the process group and keeps output tails", async () => {
    // A node agent that starts a node child and records the child's real pid (an MSYS
    // shell's pids are not Windows pids), then prints. The timeout leaves room for two
    // node startups on a loaded machine; the child checks the whole tree/group is killed.
    const pidFile = join(env.root, "slow.bg.pid");
    const p = nodeBin(
      join(env.root, "bin"),
      "slow",
      `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
console.log("started");
setTimeout(() => {}, 60000);
`,
    );
    mkdirSync(join(env.root, "w"), { recursive: true });
    const r = await spawnAgent({ bin: p, args: [], cwd: join(env.root, "w"), env: { ...process.env }, timeoutMs: 8000 });
    assert.equal(r.timedOut, true);
    assert.match(r.stdoutTail, /started/);
    assert.ok(r.durationMs < 30_000, `took ${r.durationMs}ms`);
    const bg = Number(readFileSync(pidFile, "utf8").trim());
    // The child was killed with the agent, but its pipes can close before it has been
    // reaped (it is reparented first), so give it a moment instead of checking once.
    const isAlive = () => {
      try {
        process.kill(bg, 0);
        return true;
      } catch {
        return false;
      }
    };
    let alive = isAlive();
    for (let i = 0; alive && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alive = isAlive();
    }
    if (alive) process.kill(bg, "SIGKILL");
    assert.equal(alive, false, "background child of the agent killed with its group");
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await spawnAgent({ bin: join(env.root, "nope"), args: [], cwd: env.root, env: { ...process.env }, timeoutMs: 1000 });
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  it("keeps only the last tailBytes of output", async () => {
    const p = fakeBinary(join(env.root, "bin"), "loud", `for (let i = 0; i < 2000; i++) console.log("line " + i);`);
    const r = await spawnAgent({ bin: p, args: [], cwd: env.root, env: { ...process.env }, timeoutMs: 120_000, tailBytes: 256 }); // a ceiling, not a timing: node startup is slow under load
    assert.ok(r.stdoutTail.length <= 256);
    assert.match(r.stdoutTail, /line 1999/);
  });
});

describe("jsonlTail", () => {
  const pick = (r: Record<string, unknown>): unknown[] => [r.n];

  it("gives no items for a path that names a folder or nothing, and reads a file's records, then the ones appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-jsonl-tail-"));
    try {
      const file = join(dir, "t.jsonl");
      writeFileSync(file, '{"n":1}\n{"n":2}\n'); // a folder with an entry has a size on every file system that gives folders one
      assert.deepEqual(jsonlTail("tail-folder", dir, pick), []);
      assert.deepEqual(jsonlTail("tail-none", join(dir, "none.jsonl"), pick), []);
      assert.deepEqual(jsonlTail("tail-file", file, pick), [1, 2]);
      appendFileSync(file, '{"n":3}\n');
      assert.deepEqual(jsonlTail("tail-file", file, pick), [1, 2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the items read so far while the file cannot be read, and the rest once it can", { skip: process.platform === "win32" ? "chmod does not stop a read on Windows" : process.getuid?.() === 0 && "root reads any file" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-jsonl-tail-"));
    const file = join(dir, "t.jsonl");
    try {
      writeFileSync(file, '{"n":1}\n');
      assert.deepEqual(jsonlTail("tail-locked", file, pick), [1]);
      appendFileSync(file, '{"n":2}\n');
      chmodSync(file, 0o000);
      assert.deepEqual(jsonlTail("tail-locked", file, pick), [1]);
      chmodSync(file, 0o600);
      assert.deepEqual(jsonlTail("tail-locked", file, pick), [1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
