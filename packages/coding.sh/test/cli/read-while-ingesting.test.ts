// Reads never wait on a big ingest (V-1): `status`/`sessions`/`search` answer
// within a budget and say what is still pending, `coding.sh ui` listens before
// it ingests, and the viewer's ingest runs in a worker with its own store
// connection, so reads on the viewer's thread stay prompt while it writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { run as status } from "../../src/cli/commands/status.ts";
import { run as ui } from "../../src/cli/commands/ui.ts";
import { run as sessions } from "../../src/cli/commands/sessions.ts";
import { run as search } from "../../src/cli/commands/search.ts";
import { startBackgroundIngest } from "../../src/cli/ingest-worker.ts";
import { autoIngest } from "../../src/cli/common.ts";
import { Output } from "../../src/cli/output.ts";
import type { FlagValue } from "../../src/cli/args.ts";
import { openContext } from "../../src/core/context.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { median, threadCpuMs } from "../helpers-timing.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// In-process commands' adapters look for T3 Code and Codex stores through process.env: keep them off this machine's.
const isolated = mkdtempSync(join(tmpdir(), "csh-v1-agents-"));
roots.push(isolated);
process.env.T3CODE_HOME = join(isolated, "t3");
process.env.CODEX_HOME = join(isolated, "codex");

/** A home whose spool holds `sessions` Claude Code sessions, one hook file each (as the hook writes them). */
function home(sessions: number, tools = 3) {
  const root = mkdtempSync(join(tmpdir(), "csh-v1-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, CODING_SH_HOME: join(root, "home"), HOME: join(root, "user"), NO_COLOR: "1", CI: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  delete env.CODING_SH_READ_BUDGET_MS;
  const dir = join(env.CODING_SH_HOME!, "spool", "claude-code");
  mkdirSync(dir, { recursive: true });
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  let ts = Date.now() - 3600e3;
  for (let s = 0; s < sessions; s++) {
    const base = { session_id: `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`, cwd, permission_mode: "default" };
    const line = (event: string, raw: Record<string, unknown>) => JSON.stringify({ v: 0, agent: "claude-code", event, ts: (ts += 7), pid: 1000 + s, cwd, raw: { ...base, hook_event_name: event, ...raw } });
    const lines = [line("SessionStart", { source: "startup" }), line("UserPromptSubmit", { prompt: `fix bug ${s}` })];
    for (let t = 0; t < tools; t++) {
      const call = { tool_name: "Bash", tool_use_id: `toolu_${s}_${t}`, tool_input: { command: `npm test ${t}` } };
      lines.push(line("PreToolUse", call), line("PostToolUse", { ...call, tool_response: { stdout: "ok\n" } }));
    }
    lines.push(line("Stop", {}));
    writeFileSync(join(dir, `2026-11-07.${1000 + s}.jsonl`), lines.join("\n") + "\n");
  }
  return { root, env, cwd };
}

function capture(env: NodeJS.ProcessEnv) {
  const io = { stdout: "", stderr: "" };
  const out = new Output({ env, stdout: { write: (s: string) => (io.stdout += s), isTTY: false }, stderr: { write: (s: string) => (io.stderr += s), isTTY: false }, stdin: { isTTY: false } });
  return { io, out };
}

async function runStatus(env: NodeJS.ProcessEnv, cwd: string, flags: Record<string, FlagValue> = {}) {
  const { io, out } = capture(env);
  const code = await status({ flags, positionals: [], rest: [], out, env, cwd, debug: false, signal: new AbortController().signal });
  return { code, ...io };
}

async function sessionCount(env: NodeJS.ProcessEnv): Promise<number> {
  const ctx = await openContext({ env });
  try {
    return (await ctx.index.listSessions({ limit: 10_000 })).length;
  } finally {
    await ctx.close();
  }
}

describe("reads during ingest", () => {
  test("status answers from what is indexed once its budget is spent, and says what is pending on stderr only", async () => {
    const h = home(5);
    const r = await runStatus({ ...h.env, CODING_SH_READ_BUDGET_MS: "0" }, h.cwd);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /4 files not yet ingested; showing what is indexed so far \(--fresh waits for all\)/);
    assert.doesNotMatch(r.stdout, /not yet ingested/);
    assert.match(r.stderr, /Last 24h\s+1 session from claude-code/, "answered after its first file");

    const fresh = await runStatus({ ...h.env, CODING_SH_READ_BUDGET_MS: "0" }, h.cwd, { fresh: true });
    assert.doesNotMatch(fresh.stderr, /not yet ingested/);
    assert.match(fresh.stderr, /Last 24h\s+5 sessions/);
    assert.equal(await sessionCount(h.env), 5, "nothing lost between the budgeted and the full run");
  });

  test("--json reads carry a pending field while captures are still waiting, and none once all are indexed", async () => {
    const h = home(5);
    const env = { ...h.env, CODING_SH_READ_BUDGET_MS: "0", CODING_SH_NO_AUTO_INGEST: "1" };
    const json = async (cmd: typeof status, positionals: string[] = [], flags: Record<string, FlagValue> = {}) => {
      const io = { stdout: "", stderr: "" };
      const out = new Output({ env, json: true, stdout: { write: (s: string) => (io.stdout += s), isTTY: false }, stderr: { write: (s: string) => (io.stderr += s), isTTY: false }, stdin: { isTTY: false } });
      assert.equal(await cmd({ flags, positionals, rest: [], out, env, cwd: h.cwd, debug: false, signal: new AbortController().signal }), 0);
      assert.equal(io.stderr, "", "--json keeps stderr empty");
      return JSON.parse(io.stdout) as Record<string, unknown> & { pending?: { files: number; indexing: boolean } };
    };
    // Each read with a 0 ms budget ingests one more file (every run makes progress), then answers.
    const st = await json(status);
    assert.deepEqual(st.pending, { files: 4, indexing: false });
    const ss = await json(sessions);
    assert.deepEqual(ss.pending, { files: 3, indexing: false });
    assert.equal((ss.sessions as unknown[]).length, 2);
    const se = await json(search, ["fix"]);
    assert.deepEqual(se.pending, { files: 2, indexing: false });
    const all = await json(sessions, [], { fresh: true });
    assert.equal("pending" in all, false, "no pending field once everything is indexed");
    assert.equal((all.sessions as unknown[]).length, 5);
  });

  test("a read on the viewer's thread stays prompt while the background worker ingests", async () => {
    // Measured in this thread's CPU time, not wall time: node:sqlite is synchronous, so an
    // ingest on this thread would show up as CPU spent here, while the wall clock on a busy
    // machine also counts the time this thread waits for a core.
    const cpu = threadCpuMs;
    // Calibration: what the same ingest costs when it runs on this thread.
    const inlineIngest = async (sessions: number) => {
      const twin = home(sessions, 10);
      const tctx = await openContext({ env: twin.env, cwd: twin.cwd });
      try {
        const c = cpu();
        await autoIngest(tctx);
        return cpu() - c;
      } finally {
        await tctx.close();
      }
    };
    await inlineIngest(1); // loads the modules an ingest needs
    const inline = await inlineIngest(20);

    const h = home(20, 10);
    const ctx = await openContext({ env: h.env, cwd: h.cwd });
    // Reads 20 ms apart until `done`: this thread's CPU in each read, and in each wait
    // between reads (where an ingest sharing this thread would run).
    const sample = async (done: (n: number) => boolean) => {
      const reads: number[] = [];
      const waits: number[] = [];
      while (!done(waits.length)) {
        const w = cpu();
        await new Promise((r) => setTimeout(r, 20));
        waits.push(cpu() - w);
        const c = cpu();
        await ctx.index.listSessions({ limit: 50 });
        reads.push(cpu() - c);
      }
      return { reads, waits };
    };
    try {
      // What a wait costs this thread on an idle store (timers, promises), same process, same moment.
      const idle = await sample((n) => n >= 15);
      const bg = startBackgroundIngest({ env: h.env, cwd: h.cwd, intervalMs: 60_000 });
      const started = performance.now();
      const busy = await sample(() => bg.status().lastIngestAt !== null || performance.now() - started > 120_000);
      await bg.close();
      assert.ok(bg.status().lastIngestAt !== null, "the pass finished");
      assert.equal((await ctx.index.listSessions({ limit: 100 })).length, 20, "the worker's writes are visible on this connection");
      assert.ok(busy.reads.length > 0);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const extra = sum(busy.waits) - busy.waits.length * median(idle.waits);
      const detail = `this thread, ms of CPU: ${sum(busy.waits).toFixed(1)} in ${busy.waits.length} waits (${extra.toFixed(1)} over idle), max read ${Math.max(...busy.reads).toFixed(2)}; the ingest inline: ${inline.toFixed(1)}`;
      // The ingest ran elsewhere: between reads this thread did no more than when idle.
      assert.ok(extra < inline / 4, detail);
      // And no read did a share of it.
      assert.ok(Math.max(...busy.reads) < inline / 4, detail);
    } finally {
      await ctx.close();
    }
  });

  test("coding.sh ui listens before it ingests and shows sessions as the worker indexes them", async () => {
    const h = home(5);
    const { io, out } = capture(h.env);
    const ac = new AbortController();
    const done = ui({ flags: { port: "0", open: false }, positionals: [], rest: [], out, env: h.env, cwd: h.cwd, debug: false, signal: ac.signal });
    try {
      for (let i = 0; i < 400 && !io.stderr.includes("Ctrl-C"); i++) await new Promise((r) => setTimeout(r, 25));
      const url = new URL(io.stdout.trim());
      const auth = { authorization: `Bearer ${url.searchParams.get("t")}` };
      const api = async (path: string) => (await fetch(new URL(path, url), { headers: auth })).json() as Promise<Record<string, unknown>>;
      const first = await api("/api/ingest");
      assert.equal(first.lastIngestAt, null, "ready before the first ingest pass finished");
      let items: unknown[] = [];
      for (let i = 0; i < 600 && items.length < 5; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = (await api("/api/sessions?limit=50")).items as unknown[];
      }
      assert.equal(items.length, 5);
      const st = await api("/api/ingest");
      assert.deepEqual(Object.keys(st).sort(), ["filesPending", "importing", "ingesting", "lastIngestAt"]);
      assert.equal(st.importing, false);
      // init's background history import holds the import lock: the viewer says it is importing.
      const lock = await acquireLock(paths(h.env).importLock, { waitMs: 0 });
      try {
        assert.equal((await api("/api/ingest")).importing, true);
      } finally {
        lock.release();
      }
      assert.equal((await api("/api/ingest")).importing, false);
    } finally {
      ac.abort();
      assert.equal(await done, 130);
    }
  });
});
