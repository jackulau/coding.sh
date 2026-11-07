// core/lock.ts: mutual exclusion across processes, atomic stale-lock breaking,
// fencing, and cleanup on process.exit.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { acquireLock, isLocked, isStale, LockBusyError, LockLostError } from "../../src/core/lock.ts";

// A file URL: a bare Windows path is not an import specifier.
const LOCK_TS = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "core", "lock.ts")).href;
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function dir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "csh-lock-")));
  roots.push(d);
  return d;
}
const DEAD_PID = 2 ** 22 + 4321;

/** Runs `body` (an async module body with `acquireLock` and `args` in scope) in a fresh node process. */
function child(body: string, args: string[]): Promise<string> {
  const src = `const { acquireLock } = await import(${JSON.stringify(LOCK_TS)}); const args = ${JSON.stringify(args)};\n${body}`;
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("error", rej);
    c.on("close", () => res(out.trim()));
  });
}

describe("lock", () => {
  it("a missing lock file is free, not stale; a dead holder's lock is stale, a live one is locked", async () => {
    const d = dir();
    const p = join(d, ".ingest.lock");
    assert.equal(isStale(p), false, "gone is not stale (the caller retries the create)");
    assert.equal(isLocked(p), false);
    writeFileSync(p, JSON.stringify({ pid: DEAD_PID, host: hostname(), ts: 1 }));
    assert.equal(isStale(p), true);
    assert.equal(isLocked(p), false);
    rmSync(p);
    const l = await acquireLock(p);
    assert.equal(isLocked(p), true);
    assert.ok(JSON.parse(readFileSync(p, "utf8")).nonce, "the lock body carries a nonce");
    l.release();
    assert.equal(existsSync(p), false);
  });

  it("never lets two processes into the critical section under contention", { timeout: 120_000 }, async () => {
    const d = dir();
    const p = join(d, ".ingest.lock");
    const body = `
      const { mkdirSync, rmdirSync } = await import("node:fs");
      const [path, startAt] = [args[0], Number(args[1])];
      while (Date.now() < startAt) {}
      let overlaps = 0, got = 0;
      for (let i = 0; i < 40; i++) {
        const l = await acquireLock(path, { waitMs: 60000, pollMs: 1 });
        got++;
        let mine = false;
        try { mkdirSync(path + ".inside"); mine = true; } catch { overlaps++; }
        await new Promise((r) => setTimeout(r, 3));
        if (mine) rmdirSync(path + ".inside");
        l.release();
      }
      console.log(JSON.stringify({ got, overlaps }));`;
    const startAt = String(Date.now() + 2000);
    const outs = await Promise.all(Array.from({ length: 6 }, () => child(body, [p, startAt])));
    const rs = outs.map((o) => JSON.parse(o.split("\n").pop()!) as { got: number; overlaps: number });
    assert.equal(rs.reduce((a, r) => a + r.got, 0), 240);
    assert.equal(rs.reduce((a, r) => a + r.overlaps, 0), 0, "mutual exclusion holds");
  });

  it("lets exactly one of many racing processes break a dead holder's lock", { timeout: 120_000 }, async () => {
    const body = `
      const [path, startAt] = [args[0], Number(args[1])];
      while (Date.now() < startAt) {}
      try { const l = await acquireLock(path, { waitMs: 0 }); console.log("ACQ"); await new Promise((r) => setTimeout(r, 1500)); l.release(); }
      catch (e) { console.log(e.name); }`;
    for (let round = 0; round < 3; round++) {
      const d = dir();
      const p = join(d, ".ingest.lock");
      writeFileSync(p, JSON.stringify({ pid: DEAD_PID, host: hostname(), ts: 1 }));
      const startAt = String(Date.now() + 2000);
      const outs = await Promise.all(Array.from({ length: 8 }, () => child(body, [p, startAt])));
      assert.equal(outs.filter((o) => o === "ACQ").length, 1, `round ${round}: ${outs.join(",")}`);
      assert.deepEqual(new Set(outs.filter((o) => o !== "ACQ")), new Set(["LockBusyError"]));
    }
  });

  it("assertHeld() throws once a peer has broken the lock, and the heartbeat leaves the new holder's file alone", async () => {
    const d = dir();
    const p = join(d, ".ingest.lock");
    const l = await acquireLock(p, { heartbeatMs: 10 });
    l.assertHeld();
    // A peer judged us stale (e.g. we slept past staleMs) and took the lock.
    const peer = JSON.stringify({ pid: process.ppid, host: hostname(), ts: Date.now(), nonce: "peer" });
    writeFileSync(p, peer);
    assert.throws(() => l.assertHeld(), LockLostError);
    await new Promise((r) => setTimeout(r, 50));
    l.release();
    assert.equal(readFileSync(p, "utf8"), peer, "release never removes someone else's lock");
    await assert.rejects(acquireLock(p, { waitMs: 0 }), LockBusyError);
  });

  it("removes a held lock when the process exits without running finally (process.exit(130))", () => {
    const d = dir();
    const p = join(d, ".ingest.lock");
    const src = `const { acquireLock } = await import(${JSON.stringify(LOCK_TS)}); await acquireLock(${JSON.stringify(p)}); try { process.exit(130); } finally { /* never reached */ }`;
    const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(r.status, 130, r.stderr);
    assert.equal(existsSync(p), false, "lock removed by the exit handler");
  });
});
