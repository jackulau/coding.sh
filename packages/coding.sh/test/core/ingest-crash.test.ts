// A crash mid-drain loses nothing and stores nothing twice. A child process
// drains a real spool into a real store (SQLite + file blobs) and dies partway,
// again and again: killed from outside (SIGKILL; TerminateProcess on Windows)
// at whatever point it reached, and killing itself right after a given write
// (events, a session row, a cursor) inside a checkpoint. After each death the
// index must be exactly what ingesting the spool up to its cursors gives
// (events, session rows and cursors commit together), and the run that
// finishes the drain must end with exactly the rows a clean drain stores.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { tsNodeArgs } from "../capture/_helpers.ts";

const CHILD = join(import.meta.dirname, "fixtures", "ingest-child.ts");
const SESSIONS = 30;
const TOOLS = 40;

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function newHome(): { env: NodeJS.ProcessEnv; spool: string } {
  const root = mkdtempSync(join(tmpdir(), "csh-crash-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, CODING_SH_HOME: join(root, "home"), HOME: join(root, "user"), CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  const spool = join(env.CODING_SH_HOME!, "spool", "claude-code");
  mkdirSync(spool, { recursive: true });
  return { env, spool };
}

const sessionId = (s: number) => `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;

/** One hook file per session, as the hook writes them: every line a distinct raw payload (one blob each). */
function writeSpool(spool: string): void {
  let ts = Date.now() - 3600e3;
  const cwd = join(spool, "..", "..", "work");
  for (let s = 0; s < SESSIONS; s++) {
    const base = { session_id: sessionId(s), cwd, permission_mode: "default" };
    const line = (event: string, raw: Record<string, unknown>) => JSON.stringify({ v: 0, agent: "claude-code", event, ts: (ts += 7), pid: 1000 + s, cwd, raw: { ...base, hook_event_name: event, ...raw } });
    const lines = [line("SessionStart", { source: "startup" }), line("UserPromptSubmit", { prompt: `fix bug ${s}` })];
    for (let t = 0; t < TOOLS; t++) {
      const call = { tool_name: "Bash", tool_use_id: `toolu_${s}_${t}`, tool_input: { command: `npm test ${t}` } };
      lines.push(line("PreToolUse", call), line("PostToolUse", { ...call, tool_response: { stdout: `ok ${s} ${t}\n` } }));
    }
    lines.push(line("Stop", {}));
    writeFileSync(join(spool, `2026-11-07.${1000 + s}.jsonl`), lines.join("\n") + "\n");
  }
}

interface State {
  cursors: Record<string, number>;
  /** Session id → its stored event ids, sorted. */
  events: Record<string, string[]>;
  /** Session id → its row's stats (absent: no row). */
  stats: Record<string, unknown>;
}

async function state(env: NodeJS.ProcessEnv, spool: string): Promise<State> {
  const ctx = await openContext({ env });
  try {
    const out: State = { cursors: {}, events: {}, stats: {} };
    for (const f of readdirSync(spool).sort()) out.cursors[f] = await ctx.index.getCursor(`claude-code/${f}`);
    for (let s = 0; s < SESSIONS; s++) {
      const id = sessionId(s);
      const ids = (await ctx.index.listEvents(id)).map((e) => e.id).sort();
      if (ids.length) out.events[id] = ids;
      const row = await ctx.index.getSession(id);
      if (row) out.stats[id] = row.stats;
    }
    return out;
  } finally {
    await ctx.close();
  }
}

async function drain(env: NodeJS.ProcessEnv): Promise<void> {
  const ctx = await openContext({ env });
  try {
    const r = await ctx.ingest({});
    assert.deepEqual(r.errors, []);
  } finally {
    await ctx.close();
  }
}

type Death = { killAfterCheckpoints: number } | { crashAfter: string };

/** Runs the child drain until it dies as `death` says. True when it died before finishing. */
function drainAndDie(env: NodeJS.ProcessEnv, death: Death): Promise<boolean> {
  const checkpoints = "killAfterCheckpoints" in death ? death.killAfterCheckpoints : Infinity;
  const crash = "crashAfter" in death ? { CRASH_AFTER: death.crashAfter } : {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...tsNodeArgs(), CHILD], { env: { ...env, CHECKPOINT_EVENTS: "25", ...crash }, stdio: ["ignore", "pipe", "pipe"] });
    let seen = 0;
    let done = false;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      seen += text.split("checkpoint").length - 1;
      if (text.includes("done")) done = true;
      if (seen >= checkpoints && !done) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // Killed (by us or by itself) or finished cleanly; anything else is a bug in the drain.
      if (signal === null && code !== 0 && !child.killed && !(process.platform === "win32" && code === 1 && !stderr)) reject(new Error(`child failed (${code}): ${stderr}`));
      else resolve(!done);
    });
  });
}

describe("ingest crash safety", () => {
  test("a drain killed mid-way, again and again, leaves the index at a checkpoint and the finishing run stores every event exactly once", { timeout: 240_000 }, async () => {
    // What a clean drain stores.
    const clean = newHome();
    writeSpool(clean.spool);
    await drain(clean.env);
    const expected = await state(clean.env, clean.spool);
    assert.equal(Object.keys(expected.stats).length, SESSIONS);
    assert.equal(Object.values(expected.events).flat().length, SESSIONS * (3 + 2 * TOOLS));

    // The same bytes: a hook event's id comes from its payload and time, which a second writeSpool would change.
    const crashed = newHome();
    for (const f of readdirSync(clean.spool)) copyFileSync(join(clean.spool, f), join(crashed.spool, f));
    const deaths: Death[] = [
      { killAfterCheckpoints: 3 },
      // Inside a checkpoint: after its events are written, after a session row, after a cursor.
      { crashAfter: "putEvents:2" },
      { crashAfter: "upsertSession:3" },
      { crashAfter: "setCursor:2" },
      { killAfterCheckpoints: 10 },
    ];
    for (const death of deaths) {
      const label = JSON.stringify(death);
      const before = await state(crashed.env, crashed.spool);
      assert.ok(await drainAndDie(crashed.env, death), `${label}: died before the drain finished`);
      const now = await state(crashed.env, crashed.spool);
      // The same spool, cut at the cursors and drained cleanly, stores exactly what the crashed run committed.
      const prefix = newHome();
      for (const [f, offset] of Object.entries(now.cursors)) writeFileSync(join(prefix.spool, f), readFileSync(join(crashed.spool, f)).subarray(0, offset));
      await drain(prefix.env);
      const atCursors = await state(prefix.env, prefix.spool);
      assert.deepEqual(now.events, atCursors.events, `${label}: events match the cursors`);
      assert.deepEqual(now.stats, atCursors.stats, `${label}: session rows match their events`);
      if ("crashAfter" in death) assert.notDeepEqual(now.cursors, before.cursors, `${label}: earlier checkpoints of that run were kept`);
    }

    await drain(crashed.env);
    const final = await state(crashed.env, crashed.spool);
    assert.deepEqual(final.events, expected.events);
    assert.deepEqual(final.stats, expected.stats);
    for (const f of readdirSync(crashed.spool)) assert.equal(final.cursors[f], readFileSync(join(crashed.spool, f)).byteLength, `${f} fully read`);
  });
});
