// The FTS tokenizer keeps letters, marks and digits only: a query of emoji or other
// symbols has no word to match. Search then scans the newest events' text for it (a
// bounded scan), on SQLite and the in-memory store. Text with letters still uses FTS.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { IndexStore } from "../../src/core/types.ts";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../../src/store/common.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { event } from "../query/_seed.ts";

describe("search for symbols with no word characters", () => {
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();
  before(async () => {
    sqlite = await SqliteIndexStore.open(":memory:");
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents([
        event("s1", 1, { kind: "user.message", payload: { text: "ship it 🚀 today" } }),
        event("s1", 2, { kind: "assistant.message", payload: { text: "ünïcode handled" } }),
        event("s2", 1, { kind: "user.message", payload: { text: "a → b" } }),
        // Not searchable text: a notification's message is never indexed, so never scanned either.
        event("s3", 1, { kind: "notification", payload: { message: "🚀 launched" } }),
      ]);
    }
  });
  after(() => sqlite?.close());

  for (const [name, st] of [["sqlite", () => sqlite], ["memory", () => memory]] as const) {
    test(`${name}: 🚀 finds the message that has it, with the match marked`, async () => {
      const hits = await st().search("🚀");
      assert.deepEqual(hits.map((h) => h.event.id), ["s1-e1"]);
      assert.ok(hits[0]!.snippet.includes(`${SNIPPET_OPEN}🚀${SNIPPET_CLOSE}`), hits[0]!.snippet);
      assert.deepEqual((await st().search("→")).map((h) => h.event.id), ["s2-e1"]);
      // Quoted as a phrase, the same symbol: the quotes are not part of what is searched.
      assert.deepEqual((await st().search('"🚀"')).map((h) => h.event.id), ["s1-e1"]);
      assert.deepEqual(await st().search("🛸"), []);
      assert.deepEqual(await st().search("   "), []);
      assert.deepEqual((await st().search("🚀", { agent: "codex" })).length, 0);
    });

    test(`${name}: text with letters still matches by word`, async () => {
      assert.deepEqual((await st().search("ünïcode")).map((h) => h.event.id), ["s1-e2"]);
    });
  }
});
