// A session a hook call saw with CODING_SH_DISABLE set stays out of the store:
// the hook keeps its id in spool/disabled-sessions, and neither an import of the
// agent's transcripts (backfill) nor live ingest stores its events.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest } from "../../src/core/ingest.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { PKG_ROOT, removeTmp, tmp, tsNodeArgs } from "../capture/_helpers.ts";

const REAL = join(PKG_ROOT, "test", "fixtures", "adapters", "claude-code", "real", "config", "projects", "-work-demo", "cd0185b0-305a-4df2-92fa-6fc6caffdb55.jsonl");
const PAUSED = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";
const OTHER = "0f0f0f0f-1111-4222-8333-444444444444";

after(() => removeTmp());

function home() {
  const root = tmp("csh-paused-");
  const h = join(root, "coding.sh");
  const claude = join(root, "claude");
  const env = { HOME: join(root, "home"), CODING_SH_HOME: h, CLAUDE_CONFIG_DIR: claude, PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
  return { h, claude, env };
}

/** Runs `fn` with process.env pointed at `env` (adapters read their config dir from it). */
async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = env[k];
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("paused sessions (CODING_SH_DISABLE)", () => {
  test("backfill stores no session listed in spool/disabled-sessions; another transcript in the same dir is stored", async () => {
    const { h, claude, env } = home();
    const dir = join(claude, "projects", "-work-demo");
    mkdirSync(dir, { recursive: true });
    copyFileSync(REAL, join(dir, `${PAUSED}.jsonl`));
    writeFileSync(join(dir, `${OTHER}.jsonl`), readFileSync(REAL, "utf8").replaceAll(PAUSED, OTHER));
    mkdirSync(join(h, "spool"), { recursive: true });
    writeFileSync(join(h, "spool", "disabled-sessions"), `${PAUSED}\n`);
    const index = new MemoryIndexStore();
    const r = await withEnv(env, () => backfill({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters: [claudeCode], env, lock: false }));
    assert.deepEqual(r.errors, []);
    assert.ok(r.excluded > 0);
    assert.equal(await index.getSession(PAUSED), undefined);
    assert.ok(await index.getSession(OTHER), "the other session is stored");
  });

  test("live ingest stores no event of a listed session", async () => {
    const { h, env } = home();
    const dir = join(h, "spool", "claude-code");
    mkdirSync(dir, { recursive: true });
    const line = (sid: string, ts: number) => JSON.stringify({ v: 0, agent: "claude-code", event: "UserPromptSubmit", ts, pid: 1, cwd: "/work/demo", raw: { session_id: sid, cwd: "/work/demo", hook_event_name: "UserPromptSubmit", prompt: "hello" } });
    writeFileSync(join(dir, "2026-11-06.jsonl"), `${line(PAUSED, 1793527200005)}\n${line(OTHER, 1793527200105)}\n`);
    writeFileSync(join(h, "spool", "disabled-sessions"), `${PAUSED}\n`);
    const index = new MemoryIndexStore();
    const r = await withEnv(env, () => ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters: new Map([["claude-code", claudeCode]]), env, lock: false }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.excluded, 1);
    assert.equal(await index.getSession(PAUSED), undefined);
    assert.ok(await index.getSession(OTHER));
  });

  const payload = JSON.stringify({ session_id: PAUSED, cwd: "/work/demo", hook_event_name: "UserPromptSubmit", prompt: "PRIVATE paused" });

  test("hook.mjs keeps the session id and writes no line", () => {
    const { h, env } = home();
    const r = spawnSync(process.execPath, [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts"), "claude-code", "UserPromptSubmit"], { input: payload, env: { ...env, CODING_SH_DISABLE: "1", CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(readFileSync(join(h, "spool", "disabled-sessions"), "utf8"), `${PAUSED}\n`);
    assert.ok(!readFileSync(join(h, "spool", "disabled-sessions"), "utf8").includes("PRIVATE"));
  });

  test("hook.sh keeps the session id and writes no line", { skip: process.platform === "win32" && "no hook.sh on Windows" }, () => {
    const { h, env } = home();
    const r = spawnSync("/bin/sh", [join(PKG_ROOT, "src", "spool", "hook.sh"), "claude-code", "UserPromptSubmit"], { input: payload, env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: h, HOME: env.HOME, CODING_SH_DISABLE: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(readFileSync(join(h, "spool", "disabled-sessions"), "utf8"), `${PAUSED}\n`);
    // Antigravity names it conversationId.
    const r2 = spawnSync("/bin/sh", [join(PKG_ROOT, "src", "spool", "hook.sh"), "antigravity", "Stop", "--reply={}"], { input: JSON.stringify({ conversationId: "c-1", workspacePaths: ["/w"] }), env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: h, HOME: env.HOME, CODING_SH_DISABLE: "1" }, encoding: "utf8" });
    assert.deepEqual([r2.status, r2.stdout], [0, "{}\n"]);
    assert.equal(readFileSync(join(h, "spool", "disabled-sessions"), "utf8"), `${PAUSED}\nc-1\n`);
  });

  test("a payload with no plain session id keeps nothing", () => {
    const { h, env } = home();
    const r = spawnSync(process.execPath, [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts"), "claude-code", "Stop"], { input: JSON.stringify({ session_id: "../../etc" }), env: { ...env, CODING_SH_DISABLE: "1", CODING_SH_NO_AUTO_INGEST: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.throws(() => readFileSync(join(h, "spool", "disabled-sessions")));
  });
});
