// QA on Windows: `coding.sh ingest` ignored the first Ctrl-C, and every read started another background
// transcript import while one already ran (up to 7 at once). Ctrl-C now stops the ingest at the next
// line with what was read stored, the lock released and exit 130; transcripts are read by one
// process at a time (paths.tailLock), and a read whose import another process holds starts none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as ingestCmd from "../../src/cli/commands/ingest.ts";
import * as sessionsCmd from "../../src/cli/commands/sessions.ts";
import { tailIngest } from "../../src/cli/common.ts";
import { tailMarginMs } from "../../src/cli/ingest-worker.ts";
import type { BackfillResult } from "../../src/core/ingest.ts";
import type { Context } from "../../src/core/context.ts";
import { acquireLock, isLocked } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "spool", "hook.ts");
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

function box(): Sandbox {
  const sb = sandbox({ T3CODE_HOME: undefined });
  sb.env.T3CODE_HOME = join(sb.root, "t3");
  boxes.push(sb);
  return sb;
}

/** Captured hook lines in the sandbox's spool: n tool calls of one session, one file. */
function capture(sb: Sandbox, n: number): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...sb.env };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_DISABLE", "T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  for (let i = 0; i < n; i++) {
    const input = JSON.stringify({ session_id: "stop-1", cwd: "/work/demo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `t${i}`, tool_input: { command: `echo ${i}` }, tool_response: { stdout: `${i}\n` } });
    const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "claude-code", "PostToolUse"], { env, input, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  }
}

describe("Ctrl-C on coding.sh ingest", () => {
  it("stops, releases the lock and exits 130 with the files left named; the next ingest finishes", async () => {
    const sb = box();
    capture(sb, 3);
    const ac = new AbortController();
    ac.abort(); // the first Ctrl-C (core/ingest.test.ts stops one part way through a file)
    const stopped = await runCmd(ingestCmd, sb, { json: true, signal: ac.signal });
    assert.equal(stopped.error, undefined, String(stopped.error));
    assert.equal(stopped.code, 130);
    const doc = stopped.json as { outcome: string; spool: { lines: number; pendingFiles: number } };
    assert.equal(doc.outcome, "interrupted");
    assert.equal(doc.spool.lines, 0);
    assert.equal(doc.spool.pendingFiles, 1);
    assert.equal(isLocked(paths(sb.env).ingestLock), false, "the ingest lock is released");

    const human = await runCmd(ingestCmd, sb, { signal: ac.signal });
    assert.equal(human.code, 130);
    assert.match(human.stderr + human.stdout, /Stopped: 1 file left to ingest; run coding\.sh ingest to finish/);

    const rest = await runCmd(ingestCmd, sb, { json: true });
    assert.equal(rest.code, 0, String(rest.error ?? rest.stderr));
    const done = rest.json as { outcome: string; spool: { lines: number; pendingFiles: number } };
    assert.equal(done.outcome, "ingested");
    assert.equal(done.spool.pendingFiles, 0);
    assert.equal(done.spool.lines, 3, "every line, once");
  });

  it("Ctrl-C while waiting for another ingest's lock stops the wait", async () => {
    const sb = box();
    capture(sb, 1);
    const lockPath = paths(sb.env).ingestLock;
    mkdirSync(dirname(lockPath), { recursive: true });
    const held = await acquireLock(lockPath, { waitMs: 0 });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const t0 = Date.now();
      const r = await runCmd(ingestCmd, sb, { signal: ac.signal });
      assert.equal(r.code, 130);
      assert.ok(Date.now() - t0 < 5000, `stopped waiting after ${Date.now() - t0} ms (the wait is 30 s)`);
    } finally {
      held.release();
    }
  });
});

describe("one transcript import at a time", () => {
  /** A context whose backfill waits until released: a slow transcript import. */
  function slowCtx(sb: Sandbox) {
    const calls: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const result: BackfillResult = { events: 0, sessions: 0, duplicates: 0, errors: [], pendingFiles: 0 } as unknown as BackfillResult; // slop-allow chained-as: only pendingFiles is read
    const ctx = {
      paths: paths(sb.env),
      async backfill() {
        calls.push(Date.now());
        await gate;
        return result;
      },
    } as unknown as Context; // slop-allow chained-as: tailIngest reads only paths and backfill
    return { ctx, calls, release };
  }

  it("a second import while one runs reads nothing and says busy", async () => {
    const sb = box();
    // Claude Code without our hooks: its transcripts are the capture path (tailWhenUnhooked).
    mkdirSync(join(sb.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
    const keys = ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_HOME"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = sb.env[k];
    try {
      const { ctx, calls, release } = slowCtx(sb);
      const first = tailIngest(ctx, { waitMs: 0 });
      while (!calls.length) await new Promise((r) => setTimeout(r, 5));
      assert.ok(isLocked(ctx.paths.tailLock), "the running import holds the tail lock");
      const second = await tailIngest(ctx, { waitMs: 0 });
      assert.deepEqual(second, { pending: 0, busy: true });
      assert.equal(calls.length, 1, "only one import reads the transcripts");
      release();
      assert.deepEqual(await first, { pending: 0, busy: false });
      assert.equal(isLocked(ctx.paths.tailLock), false, "released when done");
      assert.equal(existsSync(ctx.paths.tailLock), false);
      // Free again: the next one runs.
      const { ctx: ctx2, calls: calls2, release: release2 } = slowCtx(sb);
      release2();
      assert.deepEqual(await tailIngest(ctx2, { waitMs: 0 }), { pending: 0, busy: false });
      assert.equal(calls2.length, 1);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("a read while another process imports the transcripts answers at once and says one file is pending", async () => {
    const sb = box();
    mkdirSync(join(sb.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
    const keys = ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_HOME"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = sb.env[k];
    const lockPath = paths(sb.env).tailLock;
    mkdirSync(dirname(lockPath), { recursive: true });
    const held = await acquireLock(lockPath, { waitMs: 0 });
    try {
      const t0 = Date.now();
      const r = await runCmd(sessionsCmd, sb, { json: true });
      assert.equal(r.code, 0, String(r.error ?? r.stderr));
      assert.ok(Date.now() - t0 < 1500, "no wait for the other import");
      // Before: no pending field, so a partial list read as the whole answer.
      assert.deepEqual((r.json as { pending?: unknown }).pending, { files: 1, indexing: true });
    } finally {
      held.release();
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("the tail child stops a quarter of its budget early, between 100 and 500 ms", () => {
    assert.equal(tailMarginMs(200), 100);
    assert.equal(tailMarginMs(1000), 250);
    assert.equal(tailMarginMs(10_000), 500);
    assert.equal(tailMarginMs(-5), 100);
  });
});
