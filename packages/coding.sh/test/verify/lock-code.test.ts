// The lock model (lock-model.test.ts) run against the code it models, core/lock.ts. The model's
// file states are made on disk, and its steps run on the real code: acquireLock with waitMs 0, as a
// background ingest calls it, assertHeld, the heartbeat and release.
//
// A file at the lock path or at the guard path (`<lock>.break`) is absent or holds one of five
// bodies: a live holder on this host (the test's parent process), a dead holder on this host (a pid
// no process has), a holder with that pid on another host, a body torn mid-write, or a holder
// without its ts. Its mtime is now, 30 s ago or an hour ago. Each of the 16 lock states is checked
// under each of the 16 guard states.
//
// The properties:
// - acquireLock takes a missing lock, and the file names this acquisition: its pid, its host, a ts
//   and a nonce no other acquisition has (on POSIX, no one but the owner can read or write it). A
//   lock whose holder is dead on this host, or whose mtime is more than 2 minutes old, is stale; a
//   body that names no holder (pid, host and ts) is judged by its mtime alone. A stale lock is
//   broken under the guard and taken, and the guard is gone after; a guard whose holder is dead, or
//   whose mtime is more than 10 s old, is removed first. Any other lock, or a stale one under a
//   guard that is not stale, is busy: LockBusyError names the lock's holder, and both files are
//   left as they were. No other file is left in the folder. isStale is true for a stale lock, and
//   isLocked for a lock that is there and not stale.
// - assertHeld passes while the file carries the nonce. Once it fails, or the heartbeat finds the
//   file is not its own, the lock is lost for good, also when the file carries the nonce again (a
//   breaker renamed it aside and linked it back).
// - The heartbeat touches its own file and never another's. release removes its own file and leaves
//   another's as it was, and assertHeld fails after it.
// - The defaults: a lock is stale once its mtime is more than 120,000 ms old, and a guard once its
//   mtime is more than 10,000 ms old; the holder beats every 15 s, and a waiting contender looks
//   again every 100 ms. With waitMs 0 a busy lock fails at once, with no wait, and an abort ends a
//   wait when the contender next looks. acquireLock in a folder that does not exist fails with
//   ENOENT.
//
// Left out: the races inside one call, which one process cannot set up (a file replaced between a
// judgment and the rename that acts on it, or removed between the heartbeat's read and its touch);
// lock-model.test.ts checks them. Also the exit handler, which test/core/lock.test.ts checks, and
// file systems without hard links.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireLock, isLocked, isStale, LockBusyError, LockLostError, type Lock, type LockInfo } from "../../src/core/lock.ts";

/** A lock whose mtime is older than this is stale by default (core/lock.ts DEFAULT_STALE_MS); a guard, older than the second (BREAK_STALE_MS). */
const STALE_MS = 120_000;
const GUARD_STALE_MS = 10_000;
/** No process has this pid: it is above the largest pid Linux allows (2 ** 22), and odd, which no Windows pid is. */
const DEAD_PID = 2 ** 22 + 4321;
const LOCK = ".ingest.lock";
const GUARD = `${LOCK}.break`;

const root = mkdtempSync(join(tmpdir(), "lock-code-"));
after(() => rmSync(root, { recursive: true, force: true }));
let folders = 0;
function folder(): string {
  const d = join(root, String(++folders));
  mkdirSync(d);
  return d;
}

type Body = "live" | "dead" | "elsewhere" | "torn" | "no ts";
type Age = "now" | "30 s ago" | "an hour ago";
const BODIES: Body[] = ["live", "dead", "elsewhere", "torn", "no ts"];
const AGES: Age[] = ["now", "30 s ago", "an hour ago"];
const AGE_MS: Record<Age, number> = { now: 0, "30 s ago": 30_000, "an hour ago": 3_600_000 };
/** A file at the lock or the guard path: none (null), or a body with an mtime. */
type FileState = { body: Body; age: Age } | null;
const STATES: FileState[] = [null, ...BODIES.flatMap((body) => AGES.map((age) => ({ body, age })))];
const nameOf = (s: FileState): string => (s ? `${s.body}, ${s.age}` : "none");

/** The holder a body names, written at `ts`: undefined for a body that names none. */
function holderOf(body: Body, ts: number): LockInfo | undefined {
  if (body === "live") return { pid: process.ppid, host: hostname(), ts, nonce: "live" };
  if (body === "dead") return { pid: DEAD_PID, host: hostname(), ts, nonce: "dead" };
  if (body === "elsewhere") return { pid: DEAD_PID, host: "elsewhere.invalid", ts, nonce: "elsewhere" };
  return undefined;
}
function textOf(body: Body, ts: number): string {
  if (body === "torn") return `{"pid":${DEAD_PID},"host":"`;
  if (body === "no ts") return JSON.stringify({ pid: DEAD_PID, host: hostname(), nonce: "no-ts" });
  return JSON.stringify(holderOf(body, ts));
}
/** Stale by the code's rule: a holder dead on this host, or an mtime more than `limitMs` old. */
const stale = (s: FileState, limitMs: number): boolean => s !== null && (s.body === "dead" || AGE_MS[s.age] > limitMs);

/** A file as it is on disk: its text and mtime. */
type Seen = { text: string; mtimeMs: number };
function look(path: string): Seen | undefined {
  try {
    return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}
function make(path: string, s: FileState, now: number): Seen | undefined {
  if (!s) return undefined;
  writeFileSync(path, textOf(s.body, now));
  const t = new Date(now - AGE_MS[s.age]);
  utimesSync(path, t, t);
  return look(path);
}
/** The names in `dir`, sorted. */
const filesIn = (dir: string): string[] => readdirSync(dir).sort();
/** Resolves once the jobs queued so far have run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
/** What `p` has settled to so far: "pending", "taken" with the lock, or the name of the error it failed with. */
function track(p: Promise<Lock>): { state: string; lock?: Lock } {
  const t: { state: string; lock?: Lock } = { state: "pending" };
  p.then(
    (lock) => Object.assign(t, { state: "taken", lock }),
    (e: unknown) => (t.state = e instanceof Error ? e.name : String(e)),
  );
  return t;
}

test("each lock state under each guard state is taken, broken and taken, or busy, as the model's steps say", async (t) => {
  const nonces = new Set<string>();
  const seen = { taken: 0, broken: 0, busy: 0 };
  for (const lockState of STATES) {
    for (const guardState of STATES) {
      const at = `lock ${nameOf(lockState)}, guard ${nameOf(guardState)}`;
      const dir = folder();
      const path = join(dir, LOCK);
      const guard = join(dir, GUARD);
      const now = Date.now();
      const lockWas = make(path, lockState, now);
      const guardWas = make(guard, guardState, now);
      const lockStale = stale(lockState, STALE_MS);
      assert.equal(isStale(path), lockStale, `${at}: isStale`);
      assert.equal(isLocked(path), lockState !== null && !lockStale, `${at}: isLocked`);
      const busy = lockState !== null && (!lockStale || (guardState !== null && !stale(guardState, GUARD_STALE_MS)));
      const was = filesIn(dir);

      const got = await acquireLock(path, { waitMs: 0 }).catch((e: unknown) => {
        if (e instanceof LockBusyError) return e;
        throw e;
      });
      if (got instanceof LockBusyError) {
        assert.ok(lockState && busy, `${at}: busy, not taken`);
        assert.deepEqual(got.holder, holderOf(lockState.body, now), `${at}: the error names another holder`);
        assert.deepEqual(look(path), lockWas, `${at}: a busy attempt changed the lock`);
        assert.deepEqual(look(guard), guardWas, `${at}: a busy attempt changed the guard`);
        assert.deepEqual(filesIn(dir), was, `${at}: a busy attempt left other files`);
        seen.busy++;
        continue;
      }

      assert.ok(!busy, `${at}: taken, not busy`);
      const body = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
      assert.equal(body.pid, process.pid, `${at}: the lock names another pid`);
      assert.equal(body.host, hostname(), `${at}: the lock names another host`);
      assert.equal(typeof body.ts, "number", `${at}: the lock has no ts`);
      assert.ok(typeof body.nonce === "string" && body.nonce !== "" && !nonces.has(body.nonce), `${at}: the lock has no nonce of its own`);
      nonces.add(body.nonce);
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0, `${at}: others can read or write the lock`);
      // A lock taken where none was leaves the guard alone; a broken one leaves no guard.
      const guardAfter = lockState === null ? guardWas : undefined;
      assert.deepEqual(look(guard), guardAfter, `${at}: the guard after taking the lock`);
      const rest = guardAfter ? [GUARD] : [];
      assert.deepEqual(filesIn(dir), [LOCK, ...rest], `${at}: other files left in the folder`);
      assert.equal(isLocked(path), true, `${at}: isLocked after taking it`);
      got.assertHeld();
      got.release();
      assert.throws(() => got.assertHeld(), LockLostError, `${at}: a fence passed after release`);
      got.release();
      assert.deepEqual(filesIn(dir), rest, `${at}: release left the lock`);
      if (lockState === null) seen.taken++;
      else seen.broken++;
    }
  }
  t.diagnostic(`${seen.taken} taken where none was, ${seen.broken} broken and taken, ${seen.busy} busy`);
});

test("once a fence or the heartbeat finds the file is not its own, the lock is lost for good", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = folder();
  const path = join(dir, LOCK);
  const aside = `${path}.aside`;
  const a = await acquireLock(path, { waitMs: 0 });
  a.assertHeld();
  // A breaker renames the lock aside, then links it back.
  renameSync(path, aside);
  assert.throws(() => a.assertHeld(), LockLostError, "a fence passed with no lock file");
  renameSync(aside, path);
  assert.throws(() => a.assertHeld(), LockLostError, "a fence passed again after one failed");
  a.release();
  const b = await acquireLock(path, { waitMs: 0, heartbeatMs: 1_000 });
  renameSync(path, aside);
  t.mock.timers.tick(1_000);
  renameSync(aside, path);
  assert.throws(() => b.assertHeld(), LockLostError, "a fence passed after the heartbeat found no lock file");
  b.release();
  assert.deepEqual(filesIn(dir), [], "release left its own lock");
});

test("the heartbeat touches its own lock file and never another's, and release leaves another's", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = folder();
  const path = join(dir, LOCK);
  const hourAgo = new Date(Date.now() - 3_600_000);
  const l = await acquireLock(path, { waitMs: 0, heartbeatMs: 1_000 });
  utimesSync(path, hourAgo, hourAgo);
  const old = statSync(path).mtimeMs;
  t.mock.timers.tick(999);
  assert.equal(statSync(path).mtimeMs, old, "the heartbeat beat before its interval");
  t.mock.timers.tick(1);
  assert.ok(statSync(path).mtimeMs > Date.now() - 60_000, "the heartbeat left its own lock an hour old");
  l.assertHeld();
  // A peer broke the lock and took it, and its file is an hour old too.
  writeFileSync(path, textOf("live", Date.now()));
  utimesSync(path, hourAgo, hourAgo);
  const peer = look(path);
  t.mock.timers.tick(1_000);
  assert.deepEqual(look(path), peer, "the heartbeat touched a peer's lock");
  assert.throws(() => l.assertHeld(), LockLostError);
  l.release();
  assert.deepEqual(look(path), peer, "release changed a peer's lock");
});

test("by default a lock is stale once its mtime is more than 120,000 ms old, and the holder beats every 15 s", async (t) => {
  const dir = folder();
  const path = join(dir, LOCK);
  writeFileSync(path, textOf("live", Date.now()));
  // A whole second, so the sums below are exact.
  const sec = Math.floor(Date.now() / 1000) - 10;
  utimesSync(path, sec, sec);
  const mtime = statSync(path).mtimeMs;
  assert.equal(mtime, sec * 1000, "the file system keeps a whole-second mtime");
  assert.equal(isStale(path, undefined, mtime + STALE_MS), false, "a lock 120,000 ms old is stale");
  assert.equal(isLocked(path, undefined, mtime + STALE_MS), true, "a lock 120,000 ms old is not held");
  assert.equal(isStale(path, undefined, mtime + STALE_MS + 1), true, "a lock 120,001 ms old is not stale");
  assert.equal(isLocked(path, undefined, mtime + STALE_MS + 1), false, "a lock 120,001 ms old is held");
  rmSync(path);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const l = await acquireLock(path, { waitMs: 0 });
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(path, hourAgo, hourAgo);
  const old = statSync(path).mtimeMs;
  t.mock.timers.tick(14_999);
  assert.equal(statSync(path).mtimeMs, old, "the heartbeat beat before 15 s");
  t.mock.timers.tick(1);
  assert.ok(statSync(path).mtimeMs > old, "the heartbeat did not beat at 15 s");
  l.release();
});

test("a guard is stale once its mtime is more than 10,000 ms old: a stale lock under it is busy until then, and broken and taken after", async (t) => {
  const sec = Math.floor(Date.now() / 1000) - 60;
  t.mock.timers.enable({ apis: ["Date"], now: sec * 1000 + GUARD_STALE_MS });
  for (const [ageMs, taken] of [
    [GUARD_STALE_MS, false],
    [GUARD_STALE_MS + 1, true],
  ] as const) {
    const dir = folder();
    const path = join(dir, LOCK);
    const guard = join(dir, GUARD);
    writeFileSync(path, textOf("dead", sec * 1000));
    writeFileSync(guard, textOf("live", sec * 1000));
    utimesSync(guard, sec, sec);
    assert.equal(statSync(guard).mtimeMs, sec * 1000, "the file system keeps a whole-second mtime");
    t.mock.timers.setTime(sec * 1000 + ageMs);
    const got = await acquireLock(path, { waitMs: 0 }).catch((e: unknown) => {
      if (e instanceof LockBusyError) return e;
      throw e;
    });
    if (taken) {
      assert.ok(!(got instanceof LockBusyError), `a stale lock under a guard ${ageMs} ms old is busy`);
      assert.deepEqual(filesIn(dir), [LOCK], `a guard ${ageMs} ms old was left`);
      got.release();
    } else {
      assert.ok(got instanceof LockBusyError, `a stale lock under a guard ${ageMs} ms old was taken`);
      assert.deepEqual(filesIn(dir), [LOCK, GUARD], `a guard ${ageMs} ms old was removed`);
    }
  }
});

test("with waitMs 0 a busy lock fails at once; a waiting contender looks again every 100 ms, and an abort ends its wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const dir = folder();
  const path = join(dir, LOCK);
  writeFileSync(path, textOf("live", Date.now()));
  const once = track(acquireLock(path, { waitMs: 0 }));
  await flush();
  assert.equal(once.state, "LockBusyError", "with waitMs 0 a busy lock did not fail at once");

  const waiting = track(acquireLock(path, { waitMs: 1_000 }));
  await flush();
  assert.equal(waiting.state, "pending", "a waiting contender gave up before its time");
  rmSync(path);
  t.mock.timers.tick(99);
  await flush();
  assert.equal(waiting.state, "pending", "a waiting contender polled before 100 ms");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(waiting.state, "taken", "a waiting contender did not take the lock at its poll at 100 ms");
  waiting.lock?.release();

  writeFileSync(path, textOf("live", Date.now()));
  const ac = new AbortController();
  const aborted = track(acquireLock(path, { waitMs: 60_000, signal: ac.signal }));
  await flush();
  ac.abort();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(aborted.state, "LockBusyError", "an abort did not end the wait at the next poll");
});

test("acquireLock in a folder that does not exist fails with ENOENT", async () => {
  await assert.rejects(acquireLock(join(root, "missing", LOCK), { waitMs: 0 }), { code: "ENOENT" });
});
