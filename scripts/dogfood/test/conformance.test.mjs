import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { captureHealth, copyIndex, healthEnv, healthRepo, incompleteCounts, indexWriter, LIVE_MS, removeTemp, scoreSession, underRepo } from "../conformance.mjs";
import { PKG, REPO, tempDir } from "../lib/util.mjs";
import { loadConfig } from "../../../packages/coding.sh/src/core/config.ts";
import { buildSession } from "../../../packages/coding.sh/src/core/sessions.ts";
import { openStores } from "../../../packages/coding.sh/src/store/factory.ts";
import { version } from "../../../packages/coding.sh/src/cli/meta.ts";

const SOURCE_CLI = join(PKG, "src", "cli", "main.ts");
const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = (p) => {
  const d = tempDir(p);
  dirs.push(d);
  return d;
};

const MIN = 60_000;
const ev = (sessionId, agent, cwd, n, kind, ts, payload = {}) => ({ id: `${sessionId}-${n}`.padEnd(16, "0"), v: 0, sessionId, ts, agent, kind, source: "transcript", cwd, payload });

/** One session's events: kinds in order, one minute apart, the last one at `end`. */
function session(id, agent, cwd, kinds, end) {
  const start = end - (kinds.length - 1) * MIN;
  return kinds.map((k, i) => {
    const payload = k.startsWith("tool.") ? { tool: "Bash", toolUseId: `t-${id}`, ...(k === "tool.end" ? { ok: true, output: "ok" } : { input: { command: "ls" } }) } : k === "llm.call" ? { provider: "anthropic", responseModel: "claude-x" } : k === "user.message" ? { text: "hi" } : {};
    return ev(id, agent, cwd, i, k, start + i * MIN, payload);
  });
}

test("scoreSession holds each kind of session to its own expectations", () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const old = now - 2 * 3600_000;
  const evs = (kinds, ts = old) => kinds.map((kind) => ({ kind, ts }));
  // A wrapper never has tool events.
  assert.deepEqual(scoreSession({ id: "w", agent: "wrapper" }, evs(["session.start", "llm.call", "session.end"]), now).missing, []);
  assert.deepEqual(scoreSession({ id: "w", agent: "t3code" }, evs(["session.start", "session.end"]), now).missing, ["llm.call"]);
  // A subagent is scored on tool and llm events only.
  assert.deepEqual(scoreSession({ id: "p:sub:a1", agent: "claude-code" }, evs(["tool.start", "tool.end", "llm.call"]), now), { missing: [], expect: "subagent" });
  assert.deepEqual(scoreSession({ id: "c", agent: "codex", parent: { sessionId: "p" } }, evs(["llm.call"]), now).missing, ["tool events"]);
  // A full session.
  assert.deepEqual(scoreSession({ id: "c", agent: "claude-code" }, evs(["session.start", "tool.end"]), now).missing, ["session.end", "llm.call"]);
  assert.deepEqual(scoreSession({ id: "c", agent: "codex" }, evs(["session.start", "tool.end", "session.end"]), now).missing, []);
  // Live: no end and the last event under 30 min old. An old session with no end is incomplete.
  assert.deepEqual(scoreSession({ id: "l", agent: "claude-code" }, evs(["session.start"], now - LIVE_MS + MIN), now), { excluded: "live" });
  assert.deepEqual(scoreSession({ id: "l", agent: "claude-code" }, evs(["session.start", "tool.end", "llm.call"], now - LIVE_MS - MIN), now).missing, ["session.end"]);
  // A recent session with an end is never live.
  assert.equal(scoreSession({ id: "e", agent: "claude-code" }, evs(["session.start", "session.end"], now), now).excluded, undefined);
});

test("healthEnv puts every home under the temp dir and turns auto-ingest off", () => {
  const root = join("x", "cs-health-1");
  const env = healthEnv(root, join(root, "data"));
  for (const k of ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) assert.ok(env[k].startsWith(root), `${k}=${env[k]}`);
  assert.equal(env.CODING_SH_NO_AUTO_INGEST, "1");
  assert.equal(env.NO_COLOR, "1");
});

test("underRepo: on Windows case and slash direction do not matter; elsewhere they do", () => {
  assert.equal(underRepo("C:\\Projects\\coding.sh", "C:/Projects/coding.sh", "win32"), true);
  assert.equal(underRepo("c:\\projects\\Coding.sh\\packages\\x", "C:/Projects/coding.sh/", "win32"), true);
  assert.equal(underRepo("C:\\Projects\\coding.sh-other", "C:/Projects/coding.sh", "win32"), false);
  assert.equal(underRepo("/work/demo/sub", "/work/demo", "linux"), true);
  assert.equal(underRepo("/work/demo", "/work/demo/", "linux"), true);
  assert.equal(underRepo("/work/Demo", "/work/demo", "linux"), false);
  assert.equal(underRepo("/work/demo2", "/work/demo", "linux"), false);
  assert.equal(underRepo(undefined, "/work/demo", "linux"), false);
});

test("healthRepo: CODING_SH_HEALTH_REPO picks the checkout to score, else this one", () => {
  assert.equal(healthRepo({}), REPO);
  assert.equal(healthRepo({ CODING_SH_HEALTH_REPO: join(REPO, "x", "..") }), REPO);
});

test("copyIndex copies index.db and its sidecars only", () => {
  const home = tmp("cs-health-src-");
  writeFileSync(join(home, "index.db"), "db");
  writeFileSync(join(home, "index.db-wal"), "wal");
  writeFileSync(join(home, "config.toml"), "");
  mkdirSync(join(home, "blobs"));
  writeFileSync(join(home, "blobs", "big"), "x".repeat(1000));
  mkdirSync(join(home, "spool"));
  const dest = join(tmp("cs-health-dst-"), "data");
  assert.equal(copyIndex(home, dest), 5);
  assert.deepEqual(readdirSync(dest).sort(), ["index.db", "index.db-wal"]);
});

test("removeTemp turns a failed removal into a warning and passes retries", () => {
  let opts;
  assert.equal(removeTemp("gone", (_p, o) => (opts = o)), undefined);
  assert.equal(opts.maxRetries, 5);
  assert.equal(opts.retryDelay, 200);
  const w = removeTemp("locked", () => {
    throw Object.assign(new Error("busy"), { code: "EPERM" });
  });
  assert.match(w, /could not remove locked: EPERM/);
});

test("captureHealth: a wrapper and a complete session score 1, n=2; the live session is excluded", async () => {
  const root = tmp("cs-health-test-");
  const home = join(root, "live");
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  const now = Date.now();
  const sessions = [
    session("wrap-1", "wrapper", repo, ["session.start", "user.message", "llm.call", "session.end"], now - 3 * 3600_000),
    session("live-1", "claude-code", repo, ["session.start", "user.message", "tool.start", "tool.end", "llm.call"], now),
    session("done-1", "claude-code", repo, ["session.start", "user.message", "tool.start", "tool.end", "llm.call", "session.end"], now - 2 * 3600_000),
  ];
  const stores = await openStores(loadConfig({ HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: home }));
  try {
    for (const events of sessions) {
      await stores.index.putEvents(events);
      await stores.index.upsertSession(buildSession(events));
    }
  } finally {
    await stores.index.close();
    await stores.blobs.close?.();
  }
  writeFileSync(join(home, "marker-not-copied"), "x");
  const r = captureHealth({ home, repo, cli: SOURCE_CLI });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.value, 1, JSON.stringify(r));
  assert.equal(r.n, 2);
  assert.deepEqual(r.excluded, [{ id: "live-1", agent: "claude-code", reason: "live" }]);
  assert.deepEqual(r.incomplete, []);
  assert.deepEqual(r.incompleteCounts, { byAgent: {}, byMissing: {} });
  assert.equal(r.writer?.version, version(), "the coding.sh that wrote the index, read from the copy before the scorer's CLI opens it");
  assert.equal(typeof r.writer?.schema, "number");
  assert.equal(r.warning, undefined);
  assert.ok(existsSync(join(home, "marker-not-copied")));
});

test("incompleteCounts counts every incomplete row by agent and by what it misses", () => {
  const rows = [
    ...Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, agent: "t3code", missing: ["llm.call"] })),
    { id: "c1", agent: "claude-code", missing: ["session.end", "llm.call"] },
    { id: "c2", agent: "claude-code", missing: ["session.end"] },
    { id: "c3", agent: "claude-code", missing: [] },
    { id: "x1", agent: "codex", missing: [] },
  ];
  assert.deepEqual(incompleteCounts(rows), {
    byAgent: { t3code: 70, "claude-code": 2 },
    byMissing: { t3code: { "llm.call": 70 }, "claude-code": { "session.end": 2, "llm.call": 1 } },
  });
  assert.deepEqual(incompleteCounts([]), { byAgent: {}, byMissing: {} });
});

test("indexWriter reads the writer stamp and schema from a copy, read-only; nothing when there is no stamp", () => {
  const dir = tmp("cs-writer-test-");
  const file = join(dir, "index.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO migrations VALUES (?, ?)").run(1, 1);
  db.prepare("INSERT INTO migrations VALUES (?, ?)").run(7, 2);
  db.prepare("INSERT INTO kv VALUES (?, ?, ?)").run("store:writer", JSON.stringify({ version: "0.9.1", schema: 7, at: 1700000000000 }), 1);
  db.close();
  const before = readFileSync(file);
  assert.deepEqual(indexWriter(dir), { version: "0.9.1", schema: 7, at: 1700000000000 });
  assert.deepEqual(readFileSync(file), before, "the copy is not written");
  const bare = tmp("cs-writer-bare-");
  const db2 = new DatabaseSync(join(bare, "index.db"));
  db2.exec("CREATE TABLE events (id TEXT)");
  db2.close();
  assert.equal(indexWriter(bare), undefined);
  assert.equal(indexWriter(tmp("cs-writer-none-")), undefined);
});
