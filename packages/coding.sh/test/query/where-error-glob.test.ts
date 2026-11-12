// Two --where fixes, on SQLite and the scan (the store plugins run the same
// queries from _where-fixture.ts and the conformance suite):
// - error: matches an error event's message (payload.message), not only a failed
//   call's payload.error, with no migration of stored rows;
// - `*` inside quotes stays a wildcard, and `\*` there is a literal star.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore } from "../../src/core/types.ts";
import { compileWhere } from "../../src/query/compile.ts";
import { findEvents, findSessions } from "../../src/query/run.ts";
import { parseWhere, printWhere } from "../../src/query/where.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { event, session } from "./_seed.ts";

describe("error: and quoted globs", () => {
  let dir: string;
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-where-err-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents([
        event("e1", 1, { kind: "error", payload: { message: "Rate limit exceeded (429)", statusCode: 429 } }),
        event("e2", 1, { kind: "tool.end", payload: { tool: "Bash", ok: false, error: "permission denied" } }),
        // Not an error event: its message is not error text.
        event("e3", 1, { kind: "notification", payload: { message: "rate limit is near" } }),
      ]);
      for (const [id, cwd] of [["e1", "/a b/c"], ["e2", "/a b/*"], ["e3", "/a b/c*d"]] as const) await st.upsertSession(session(id, { cwd }));
    }
  });
  after(async () => {
    await sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = async (st: IndexStore, q: string) => (await findSessions(st, parseWhere(q))).sessions.map((s) => s.id).sort();
  const both = async (q: string, want: string[]) => {
    assert.deepEqual(await ids(sqlite, q), want, `sqlite ${q}`);
    assert.deepEqual(await ids(memory, q), want, `scan ${q}`);
  };

  test("error: matches an error event's message", async () => {
    await both("error:rate", ["e1"]);
    await both("error:429", ["e1"]);
    await both("error:denied", ["e2"]);
    await both("-error:rate", ["e2", "e3"]);
    const page = await findEvents(sqlite, parseWhere("error:limit"));
    assert.deepEqual(page.items.map((e) => e.sessionId), ["e1"]);
  });

  test("error: on SQLite still starts from an index, not a scan of every event", () => {
    const db = Reflect.get(sqlite, "db") as import("node:sqlite").DatabaseSync;
    const c = compileWhere(parseWhere("error:timeout").root!, "session");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT s.id FROM sessions s WHERE ${c.sql}`).all(...c.params) as { detail: string }[]).map((r) => r.detail).join("\n");
    assert.doesNotMatch(plan, /SCAN e\b(?! USING)/, plan);
    assert.match(plan, /events_error/, plan);
  });

  test("a quoted * is a wildcard; \\* is a literal star", async () => {
    await both('dir:"/a b/*"', ["e1", "e2", "e3"]);
    await both('dir:"/a b/\\*"', ["e2"]);
    await both('dir:"/a b/c\\**"', ["e3"]);
    await both("dir:/a*", ["e1", "e2", "e3"]);
    await both('dir:"/a b/c"', ["e1"]);
  });

  test("printWhere reads back to the same query", () => {
    for (const q of ['dir:"/a b/*"', 'dir:"/a b/\\*"', 'title:"x\\*y*z"', 'dir:"C:\\\\work\\\\*"', "dir:/a*", 'title:"say \\"hi\\""']) {
      const parsed = parseWhere(q);
      assert.deepEqual(parseWhere(printWhere(parsed)), parsed, q);
    }
    assert.equal(parseWhere('dir:"/a b/*"').root!.t === "cmp" && (parseWhere('dir:"/a b/*"').root as { values: { kind: string }[] }).values[0]!.kind, "glob");
    const literal = parseWhere('dir:"/a b/\\*"').root as { values: { kind: string; raw: string }[] };
    assert.deepEqual([literal.values[0]!.kind, literal.values[0]!.raw], ["eq", "/a b/*"]);
  });
});
