import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { emitToolEnd, Emitter, envVar, fileTouches, findBinary, isOurCommand, openSqliteCopy, parseJsonc, spawnAgent, testResultFor, toMs, usageFrom } from "../../../src/adapters/more/_util.ts";
import type { TmpEnv } from "../_helpers.ts";
import { fakeBinary, moreEnv, testCtx } from "./_helpers.ts";
import { nodeBin } from "../../_bin.ts";
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
  const makeDb = async (root: string) => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(root, "agent.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    db.close();
    return path;
  };

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
  it("usageFrom reads the common shapes", () => {
    assert.deepEqual(usageFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, total_cost_usd: 0.5 }), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 });
    assert.deepEqual(usageFrom({ promptTokenCount: 5, candidatesTokenCount: 6, cachedContentTokenCount: 1 }), { inputTokens: 5, outputTokens: 6, cacheReadTokens: 1 });
    assert.deepEqual(usageFrom({ input: 7, output: 8, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }), { inputTokens: 7, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.1 });
    assert.equal(usageFrom({}), undefined);
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
