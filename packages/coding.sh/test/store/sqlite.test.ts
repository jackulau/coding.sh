import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { loadSqlite, MIGRATIONS, SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../src/store/sqlite.ts";

const root = mkdtempSync(join(tmpdir(), "csh-sqlite-"));
after(() => rmSync(root, { recursive: true, force: true }));

function events(n: number, session = "perf"): AgentEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${session}-${i}`,
    v: 0,
    sessionId: session,
    ts: 1_700_000_000_000 + i,
    agent: "claude-code",
    kind: i % 3 === 0 ? "assistant.message" : i % 3 === 1 ? "tool.start" : "tool.end",
    payload: i % 3 === 0 ? { text: `message number ${i} about refactoring` } : { tool: "Bash", toolUseId: `t${i}`, ok: i % 2 === 0 },
    usage: { inputTokens: i },
  }));
}

describe("SqliteIndexStore", () => {
  it("writes 10k events in one batch in under a second", async () => {
    const s = await SqliteIndexStore.open(join(root, "perf.db"));
    const batch = events(10_000);
    const t = performance.now();
    const { inserted } = await s.putEvents(batch);
    const ms = performance.now() - t;
    assert.equal(inserted, 10_000);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
    assert.equal(await s.countEvents(), 10_000);
    assert.equal((await s.putEvents(batch)).inserted, 0);
    assert.equal((await s.search("refactoring", { limit: 5 })).length, 5);
    await s.close();
  });

  it("persists across reopen, records migrations and uses WAL", async () => {
    const path = join(root, "reopen.db");
    const s = await SqliteIndexStore.open(path);
    await s.putEvents(events(3, "keep"));
    await s.setCursor("a", 7);
    await s.close();
    await s.close(); // idempotent
    const again = await SqliteIndexStore.open(path);
    assert.equal((await again.listEvents("keep")).length, 3);
    assert.equal(await again.getCursor("a"), 7);
    await again.close();

    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.deepEqual((db.prepare("SELECT version FROM migrations").all() as { version: number }[]).map((r) => r.version), Array.from({ length: SQLITE_SCHEMA_VERSION }, (_, i) => i + 1));
    // Promoted columns are populated for querying.
    const row = db.prepare("SELECT tool, ok FROM events WHERE id = 'keep-2'").get() as { tool: string; ok: number };
    assert.deepEqual({ ...row }, { tool: "Bash", ok: 1 });
    db.exec(`INSERT INTO migrations (version, applied_at) VALUES (${SQLITE_SCHEMA_VERSION + 1}, 0)`);
    db.close();
    await assert.rejects(() => SqliteIndexStore.open(path), new RegExp(`schema v${SQLITE_SCHEMA_VERSION + 1}, but this coding\\.sh only knows up to v${SQLITE_SCHEMA_VERSION}`));
  });

  it("migrates a v2 store so existing tool calls become searchable", async () => {
    const path = join(root, "v2.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 2)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    // Rows as the v2 code wrote them: only message text went into the FTS index.
    const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, tool, payload) VALUES (?, 's', ?, 'claude-code', ?, ?, ?)");
    const rows: [string, string, string | null, object][] = [
      ["u", "user.message", null, { text: "ask emil kowalski" }],
      ["t", "tool.start", "Bash", { tool: "Bash", toolUseId: "x", input: { command: "pgrep -fl vision_connector.py" } }],
      ["o", "tool.end", "Bash", { tool: "Bash", toolUseId: "x", ok: true, output: "4242 vision_connector.py" }],
      ["sa", "subagent.start", null, { subagentId: "a", description: "Research narwhal pricing" }],
    ];
    rows.forEach(([id, kind, tool, payload], i) => insert.run(id, i, kind, tool, JSON.stringify(payload)));
    db.exec("INSERT INTO events_fts (rowid, text) SELECT rowid, text FROM events WHERE text IS NOT NULL");
    db.close();

    const s = await SqliteIndexStore.open(path);
    const ids = async (q: string) => (await s.search(q)).map((h) => h.event.id).sort();
    assert.deepEqual(await ids("kowalski"), ["u"], "message text survives the reindex");
    assert.deepEqual(await ids("pgrep"), ["t"]);
    assert.deepEqual(await ids("vision_connector"), ["o", "t"]);
    assert.deepEqual(await ids("narwhal"), ["sa"]);
    const [hit] = await s.search("pgrep");
    assert.match(hit!.snippet, /«pgrep»/);
    // New writes after the migration index tool calls too.
    await s.putEvents([{ id: "n", v: 0, sessionId: "s", ts: 9, agent: "a", kind: "tool.start", payload: { tool: "TaskStop", input: { task_id: "q1" } } }]);
    assert.deepEqual(await ids("taskstop"), ["n"]);
    await s.close();

    const check = new DatabaseSync(path);
    check.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)"); // throws if index and content disagree
    check.close();
  });

  it("matches prefixes and ignores diacritics", async () => {
    const s = await SqliteIndexStore.open(":memory:");
    await s.putEvents([{ id: "x", v: 0, sessionId: "s", ts: 1, agent: "a", kind: "user.message", payload: { text: "I fixed the café tests" } }]);
    assert.equal((await s.search("fix")).length, 1);
    assert.equal((await s.search("cafe")).length, 1);
    assert.equal((await s.search("fixing")).length, 0, "no stemming");
    await s.close();
  });

  it("loads node:sqlite without printing the ExperimentalWarning", () => {
    const script = `import { SqliteIndexStore } from ${JSON.stringify(new URL("../../src/store/sqlite.ts", import.meta.url).href)};
      const s = await SqliteIndexStore.open(":memory:"); await s.close();
      process.emitWarning("still-visible", "UserWarning");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning.*SQLite/i);
    assert.match(r.stderr, /still-visible/, "other warnings still print");
  });
});
