// `coding.sh ui` on a store an older coding.sh folded (QA round 9): the viewer's background ingest
// starts the refold an upgrade needs, as an MCP server's does, and /api/ingest says `refolding`
// while it runs, so the top bar can say the stats are being rebuilt.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { REFOLD_CURSOR } from "../../src/core/ingest.ts";
import { acquireLock, isLocked } from "../../src/core/lock.ts";
import { foldStamp } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { CLI } from "../_cli.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
  await Promise.all(children.map((c) => c.exitCode !== null || c.signalCode !== null ? undefined : new Promise<void>((resolve) => {
    c.once("exit", () => resolve());
    c.kill();
  })));
  for (const r of roots) {
    // The detached `ingest --background` the viewer started may still be closing the store.
    for (let i = 0; i < 100 && isLocked(join(r, "csh", "reparse.lock")); i++) await sleep(100);
    for (let i = 0; ; i++) {
      try {
        rmSync(r, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i >= 50) throw e;
        await sleep(200);
      }
    }
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "csh-r9rf-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC", NO_COLOR: "1",
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    CODING_SH_HOME: join(root, "csh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
    T3CODE_HOME: join(root, "t3"), GEMINI_CLI_HOME: home, XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "xdgdata"),
    XDG_STATE_HOME: join(root, "xdgstate"), XDG_CACHE_HOME: join(root, "xdgcache"), CODING_SH_NO_UPDATE_CHECK: "1",
  };
  return { root, env };
}

/** Three sessions with their events, last folded by an older build (a stamp that is not this one's). */
async function staleStore(env: Record<string, string>, cwd: string): Promise<void> {
  const ctx = await openContext({ env, cwd });
  try {
    const now = Date.now();
    const events: AgentEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `r9-old-${i}`;
      const t0 = now - (i + 1) * 60_000;
      const base = { v: 0, sessionId: id, agent: "claude-code", cwd } as const;
      events.push(
        { ...base, id: `${id}-0`, ts: t0, kind: "user.message", payload: { text: "Fix the failing parser test" } },
        { ...base, id: `${id}-1`, ts: t0 + 1000, kind: "tool.start", payload: { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } } },
        { ...base, id: `${id}-2`, ts: t0 + 3000, kind: "tool.end", durationMs: 2000, payload: { tool: "Bash", toolUseId: `${id}-t`, ok: true, output: "ok" } },
      );
      const s: Session = {
        id, agent: "claude-code", startedAt: t0, endedAt: t0 + 3000, title: `session ${i}`, cwd,
        stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 },
        flags: ["old-fold-flag"],
      };
      await ctx.index.upsertSession(s);
    }
    await ctx.index.putEvents(events);
    await ctx.index.setCursor(REFOLD_CURSOR, foldStamp() - 1);
  } finally {
    await ctx.close();
  }
}

/** Starts `coding.sh ui --no-open --port 0 --json`; resolves with its URL and token. */
async function startUi(env: Record<string, string>, cwd: string): Promise<{ base: string; token: string }> {
  const child = spawn(process.execPath, ["--no-warnings", CLI, "ui", "--no-open", "--port", "0", "--json"], { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout!.setEncoding("utf8").on("data", (s: string) => (out += s));
  child.stderr!.setEncoding("utf8").on("data", (s: string) => (err += s));
  for (let i = 0; i < 300 && !/"url"/.test(out); i++) await sleep(100);
  const m = /"url":"(http:\/\/127\.0\.0\.1:\d+)\/\?t=([^"]+)"/.exec(out);
  assert.ok(m, `the viewer printed its URL: ${out} ${err}`);
  return { base: m[1]!, token: m[2]! };
}

async function ingestStatus(ui: { base: string; token: string }): Promise<Record<string, unknown>> {
  const res = await fetch(ui.base + "/api/ingest", { headers: { Authorization: `Bearer ${ui.token}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

function refoldCursor(home: string): number | undefined {
  const db = new DatabaseSync(join(home, "index.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT offset FROM cursors WHERE source = ?").get(REFOLD_CURSOR) as { offset: number } | undefined)?.offset;
  } finally {
    db.close();
  }
}

describe("coding.sh ui on a store an older build folded", () => {
  it("starts the refold, as the MCP server does, without any other coding.sh process", async () => {
    const { root, env } = world();
    await staleStore(env, root);
    const ui = await startUi(env, root);
    let cursor: number | undefined;
    for (let i = 0; i < 600 && (cursor = refoldCursor(env.CODING_SH_HOME!)) !== foldStamp(); i++) await sleep(100);
    assert.equal(cursor, foldStamp(), "the stored sessions were folded again by this build");
    // Once it is done the viewer no longer says so.
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      st = await ingestStatus(ui);
      if (st.lastIngestAt && st.refolding === undefined && !isLocked(join(env.CODING_SH_HOME!, "reparse.lock"))) break;
      await sleep(200);
    }
    assert.equal(st.refolding, undefined, JSON.stringify(st));
  });

  it("/api/ingest says refolding while a re-parse holds the store", async () => {
    const { root, env } = world();
    await staleStore(env, root);
    // As an `ingest --background` refolding the store does.
    const lock = await acquireLock(join(env.CODING_SH_HOME!, "reparse.lock"), { waitMs: 0 });
    try {
      const ui = await startUi(env, root);
      let st: Record<string, unknown> = {};
      for (let i = 0; i < 150 && st.refolding !== true; i++) {
        st = await ingestStatus(ui);
        if (st.refolding !== true) await sleep(200);
      }
      assert.equal(st.refolding, true, JSON.stringify(st));
    } finally {
      await lock.release();
    }
  });
});
