// docs/reference/query.md names only columns the SQLite index has, and lists the export's CSV columns as the code writes them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CSV_COLUMNS } from "../../src/query/export.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const DOC = readFileSync(new URL("../../../../docs/reference/query.md", import.meta.url), "utf8");

test("every table column in query.md exists in the index", async () => {
  const store = await SqliteIndexStore.open(":memory:");
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  let checked = 0;
  for (const section of DOC.split(/^### /m).slice(1)) {
    const table = /^`([a-z_]+)`/.exec(section)?.[1];
    if (!table) continue;
    const have = new Set((db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table) as { name: string }[]).map((r) => r.name));
    assert.ok(have.size, `table ${table} is missing`);
    for (const m of section.matchAll(/^\| `([a-z_]+)` \|/gm)) {
      assert.ok(have.has(m[1]!), `${table}.${m[1]} is in query.md but not in the index`);
      checked++;
    }
  }
  await store.close();
  assert.ok(checked > 40, `checked ${checked} columns`);
});

test("the CSV columns in query.md match the export", () => {
  for (const kind of ["sessions", "events", "labels"] as const) {
    const row = new RegExp(`^\\| \`${kind}\` \\| (.+) \\|$`, "m").exec(DOC)?.[1];
    assert.ok(row, `no CSV row for ${kind}`);
    assert.deepEqual(row.split(", ").map((c) => c.replace(/ \(.*\)$/, "")), [...CSV_COLUMNS[kind]]);
  }
});
