// doctor and status on what stops capture or hides it: the hook file the agents
// run, a day file hooks can't append to, stored values past physical limits, a
// store password, and spool files ingest has yet to read.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
import { CLI, event, seed, session, T0 } from "../query/_seed.ts";
import { spawnSync } from "node:child_process";
import { implausible, PLAUSIBLE_LIMITS } from "../../src/cli/commands/doctor.ts";
import { maskStoreUrl, maskUrlsIn } from "../../src/core/store-url.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { spoolFile } from "../../src/spool/write.ts";

interface Warning {
  check: string;
  agent?: string;
  message: string;
  next?: string;
}
interface Doc {
  ok: boolean;
  warnings: Warning[];
  agents: { id: string }[];
  store: { url?: string };
}

const posix = process.platform !== "win32";
const root = typeof process.getuid === "function" && process.getuid() === 0;
const PASSWORD = ["hun", "ter", "2-not-real"].join("");

describe("doctor and status: capture problems", () => {
  let env: TmpEnv;
  let cwd: string;
  let hook: string;
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", ...extra }, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
    const init = run(["init", "--yes", "--agent", "claude-code"]);
    assert.equal(init.status, 0, init.stderr);
  });
  after(() => env.restore());

  test("a missing hook.sh (what agents run outside Windows) is a Hook warning, and the agent row is not ok", { skip: !posix && "agents run hook.mjs on Windows" }, () => {
    const sh = join(env.dataHome, "bin", "hook.sh");
    rmSync(sh);
    try {
      const r = run(["doctor", "--agent", "claude-code"]);
      assert.ok(r.stderr.includes(`! Hook`) && r.stderr.includes(`missing at ${sh}`), r.stderr);
      assert.match(r.stderr, /^! Claude Code\s+v2\.1\.319, hooked.*, but the hook it runs is missing/m);
      const doc = JSON.parse(run(["doctor", "--agent", "claude-code", "--json"]).stdout) as Doc;
      assert.ok(doc.warnings.some((w) => w.check === "hook" && w.message === `The hook is missing at ${sh}`), JSON.stringify(doc.warnings));
      assert.ok(doc.warnings.some((w) => w.check === "agent" && w.agent === "claude-code"));
    } finally {
      assert.equal(run(["init", "--yes", "--agent", "claude-code"]).status, 0);
    }
    assert.match(run(["doctor", "--agent", "claude-code"]).stderr, /^✓ Claude Code/m);
  });

  test("a day file hooks can't append to, and write failures in errors.log, are Spool warnings", { skip: (!posix || root) && "needs file modes" }, () => {
    const file = spoolFile("claude-code", Date.now(), { ...process.env, CODING_SH_HOME: env.dataHome });
    const day = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
    writeFile(file, "");
    chmodSync(file, 0o400);
    try {
      const r = run(["doctor", "--agent", "claude-code"]);
      assert.ok(r.stderr.includes(`spool/claude-code/${day}.jsonl not writable: EACCES`), r.stderr);
      assert.doesNotMatch(r.stderr, /✓ Spool/);
    } finally {
      chmodSync(file, 0o600);
    }
    writeFileSync(join(env.dataHome, "spool", "errors.log"), [
      JSON.stringify({ ts: Date.now() - 60_000, pid: 1, agent: "claude-code", error: "ENOSPC: no space left on device, write", code: "ENOSPC" }),
      JSON.stringify({ ts: Date.now() - 3 * 86_400_000, pid: 1, error: "old", code: "EACCES" }),
      "",
    ].join("\n"));
    try {
      const doc = JSON.parse(run(["doctor", "--agent", "claude-code", "--json"]).stdout) as Doc;
      const w = doc.warnings.filter((x) => x.check === "spool");
      assert.deepEqual(w.map((x) => x.message), ["1 hook write failed in the last day (ENOSPC 1; last: ENOSPC: no space left on device, write); see spool/errors.log"]);
    } finally {
      rmSync(join(env.dataHome, "spool", "errors.log"));
    }
    assert.match(run(["doctor", "--agent", "claude-code"]).stderr, /^✓ Spool/m);
  });

  test("a stored model call at 9,000 tok/s is a Stats warning naming its session; one at 120 tok/s is not", async () => {
    const call = (sid: string, n: number, outputTokens: number, durationMs: number) => event(sid, n, { kind: "llm.call", durationMs, usage: { inputTokens: 10, outputTokens }, payload: { ok: true } });
    await seed(env.dataHome, {
      events: [call("fast", 1, 9000, 1000), call("fast", 2, 120, 1000), call("sane", 1, 120, 1000)],
      sessions: [session("fast", { startedAt: T0 + 1000 }), session("sane")],
    });
    const doc = JSON.parse(run(["doctor", "--agent", "claude-code", "--json"]).stdout) as Doc;
    const w = doc.warnings.filter((x) => x.check === "stats");
    assert.deepEqual(w.map((x) => [x.message, x.next]), [[`1 model call past physical limits (over ${PLAUSIBLE_LIMITS.maxTokensPerSec} tok/s 1); most in fast`, "coding.sh show fast"]]);
    assert.match(run(["doctor", "--agent", "claude-code"]).stderr, /^! Stats\s+1 model call past physical limits/m);
  });

  test("status and doctor print the store URL with its password masked", () => {
    const url = `sqlite://coding:${PASSWORD}@/${join(env.dataHome, "pw-index.db")}`;
    const extra = { CODING_SH_STORE_URL: url };
    const status = run(["status", "--json"], extra);
    assert.equal(status.status, 0, status.stderr);
    assert.ok(!status.stdout.includes(PASSWORD), status.stdout);
    assert.ok((JSON.parse(status.stdout) as { store: string }).store.includes("coding:***@"));
    const text = run(["status"], extra);
    assert.ok(!(text.stdout + text.stderr).includes(PASSWORD));
    const doctor = run(["doctor", "--agent", "claude-code", "--json"], extra);
    assert.ok(!doctor.stdout.includes(PASSWORD), doctor.stdout);
    assert.ok(!run(["doctor", "--agent", "claude-code"], extra).stderr.includes(PASSWORD));
  });

  test("status says how many spool files ingest has yet to read, as --json does", async () => {
    const dir = join(env.dataHome, "spool", "claude-code");
    writeFile(join(dir, "2026-01-03.jsonl"), `${JSON.stringify({ v: 0, agent: "claude-code", event: "Stop", ts: Date.UTC(2026, 0, 3), pid: 1, cwd: "/w", raw: { session_id: "pending-1" } })}\n`);
    // Another ingest holds the lock: status reads what is indexed and counts the rest as waiting.
    const lock = await acquireLock(join(env.dataHome, "spool", ".ingest.lock"), { waitMs: 0 });
    try {
      const doc = JSON.parse(run(["status", "--json"]).stdout) as { pending?: { files: number; indexing: boolean } };
      assert.deepEqual(doc.pending, { files: 1, indexing: true });
      const r = run(["status"]);
      assert.match(r.stderr + r.stdout, /Spool\s+\d+ files?, .*, 1 file not yet ingested \(ingest running\)/);
    } finally {
      lock.release();
    }
    const r = run(["status"]);
    assert.doesNotMatch(r.stderr + r.stdout, /not yet ingested/);
    rmSync(join(dir, "2026-01-03.jsonl"));
  });
});

describe("plausibility limits", () => {
  const call = (over: object) => ({ id: "e", v: 0, sessionId: "s", ts: 0, agent: "claude-code", kind: "llm.call", payload: { ok: true }, ...over }) as Parameters<typeof implausible>[0];
  test("speed, time to first token and cost", () => {
    assert.deepEqual(implausible(call({ durationMs: 1000, usage: { outputTokens: 9000 } })), ["speed"]);
    assert.deepEqual(implausible(call({ durationMs: 1000, usage: { outputTokens: 120 } })), []);
    assert.deepEqual(implausible(call({ durationMs: 10, usage: { outputTokens: 900 } })), [], "too short to time");
    assert.deepEqual(implausible(call({ payload: { tokensPerSec: 12_000 } })), ["speed"]);
    assert.deepEqual(implausible(call({ durationMs: 1000, payload: { ttftMs: 5000 } })), ["ttft"]);
    assert.deepEqual(implausible(call({ payload: { ttftMs: -1 } })), ["ttft"]);
    assert.deepEqual(implausible(call({ usage: { costUsd: -0.5 } })), ["cost"]);
    assert.deepEqual(implausible(call({ usage: { costUsd: 900 } })), ["cost"]);
    assert.deepEqual(implausible(call({ usage: { costUsd: 0.4 } })), []);
  });
});

describe("maskStoreUrl", () => {
  test("hides a URL's password and secret query values; leaves paths and plain URLs as they are", () => {
    assert.equal(maskStoreUrl(`postgres://coding:${PASSWORD}@db.local:5432/cs`), "postgres://coding:***@db.local:5432/cs");
    assert.equal(maskStoreUrl(`clickhouse://db.local:8123/cs?user=u&password=${PASSWORD}`), "clickhouse://db.local:8123/cs?user=u&password=***");
    assert.equal(maskStoreUrl("postgres://db.local/cs"), "postgres://db.local/cs");
    assert.equal(maskStoreUrl("/home/user/.coding.sh/index.db"), "/home/user/.coding.sh/index.db");
    assert.equal(maskUrlsIn(`cannot open postgres://coding:${PASSWORD}@db.local/cs: refused`), "cannot open postgres://coding:***@db.local/cs: refused");
  });
});
