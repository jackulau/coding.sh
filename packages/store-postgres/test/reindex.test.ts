// Migration v3 indexes the error text of rows stored before it was searchable.
// The first tests need no server: they check which rows get new search text and
// how the backfill drives its cursor. The last migrates a real v2 schema.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import pg from "pg";
import { PgIndexStore } from "../src/index.ts";
import { MIGRATIONS, quoteIdent } from "../src/pool.ts";
import { reindexErrorText, searchFolded, staleSearchText, type Queryable, type StoredSearchRow } from "../src/search.ts";
import { PG_URL, SKIP, schemaUrl } from "./helpers.ts";

const row = (id: string, kind: string, payload: Record<string, unknown>, search_folded: string | null): StoredSearchRow => ({ id, kind, payload: JSON.stringify(payload), search_folded });

// Rows as a store before v3 wrote them: no text for errors, tool text without the error.
const OLD_ROWS: StoredSearchRow[] = [
  row("e1", "error", { message: "API Error: 429", errorType: "rate_limit_error", statusCode: 429 }, null),
  row("c1", "llm.call", { ok: false, error: "upstream connect error", errorType: "overloaded_error" }, null),
  row("t1", "tool.end", { tool: "Bash", ok: false, error: "permission denied by sandbox", output: "exit 1" }, "bash exit 1"),
  row("s1", "subagent.end", { subagentId: "a1", type: "reviewer", ok: false, error: "quota exhausted" }, null),
  row("x1", "session.end", { reason: "error", error: "agent process segfaulted" }, null),
];

describe("postgres search backfill (no server)", () => {
  it("gives new search text to the rows stored without their error text, and leaves the rest", () => {
    const current = row("t2", "tool.end", { tool: "Read", ok: false, error: "ENOENT wombat", output: "x" }, null);
    current.search_folded = searchFolded({ kind: "tool.end", payload: JSON.parse(current.payload) } as Parameters<typeof searchFolded>[0]);
    const rows = [
      ...OLD_ROWS,
      current,
      row("s2", "subagent.end", { subagentId: "a2", ok: true, note: '"error":"in a string"' }, null),
      row("bad", "error", {}, null),
    ];
    rows[rows.length - 1]!.payload = "{not json";
    const stale = staleSearchText(rows);
    assert.deepEqual(stale.map((r) => r.id), ["e1", "c1", "t1", "s1", "x1"], "an up-to-date row, an end without an error and an unreadable payload are left");
    const byId = new Map(stale.map((r) => [r.id, r.folded]));
    assert.match(byId.get("e1")!, /\brate limit error\b/);
    assert.match(byId.get("t1")!, /\bsandbox\b.*\bexit 1\b/, "the tool's error, before its output");
    assert.equal(byId.get("s1"), "quota exhausted reviewer");
    assert.equal(byId.get("x1"), "agent process segfaulted");
  });

  it("reads the candidates through one cursor in batches and updates only the stale rows", async () => {
    const sql: string[] = [];
    const updates: unknown[][] = [];
    const pending = [OLD_ROWS.slice(0, 2), OLD_ROWS.slice(2, 4), OLD_ROWS.slice(4)];
    const client: Queryable = {
      async query(text: string, params?: unknown[]) {
        sql.push(text.split(/\s+/).slice(0, 2).join(" "));
        if (text.startsWith("FETCH")) return { rows: pending.shift() ?? [] };
        if (text.startsWith("UPDATE")) updates.push(params!);
        return { rows: [] };
      },
    };
    assert.equal(await reindexErrorText(client, '"t_x"', 2), 5);
    assert.deepEqual(sql, ["DECLARE coding_sh_reindex", "FETCH 2", "UPDATE \"t_x\".events", "FETCH 2", "UPDATE \"t_x\".events", "FETCH 2", "UPDATE \"t_x\".events", "CLOSE coding_sh_reindex"]);
    assert.deepEqual(updates.map((u) => u[0]), [["e1", "c1"], ["t1", "s1"], ["x1"]]);
  });
});

describe("postgres search backfill", { skip: SKIP }, () => {
  it("migrating a v2 schema indexes the error text stored before, so search finds it", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const s = quoteIdent(schema);
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${s}`);
      await client.query(`CREATE TABLE ${s}.coding_sh_migrations (version integer PRIMARY KEY, applied_at bigint NOT NULL)`);
      for (const m of MIGRATIONS.filter((m) => m.version <= 2)) {
        await client.query(m.sql(s));
        await client.query(`INSERT INTO ${s}.coding_sh_migrations (version, applied_at) VALUES ($1, 0)`, [m.version]);
      }
      const rows = [...OLD_ROWS, row("m1", "user.message", { text: "summarize the changelog" }, "summarize the changelog")];
      for (const [i, r] of rows.entries()) {
        await client.query(`INSERT INTO ${s}.events (id, session_id, ts, agent, kind, payload, search_folded) VALUES ($1, $2, $3, 'sdk', $4, $5, $6)`, [r.id, `s-${r.id}`, i, r.kind, r.payload, r.search_folded]);
      }
    } finally {
      await client.end();
    }
    const store = await PgIndexStore.open(schemaUrl(schema), { dropSchemaOnClose: true });
    try {
      const ids = async (q: string) => (await store.search(q)).map((h) => h.event.id).sort();
      assert.deepEqual(await ids("rate_limit_error"), ["e1"]);
      assert.deepEqual(await ids("upstream connect"), ["c1"]);
      assert.deepEqual(await ids("sandbox"), ["t1"]);
      assert.deepEqual(await ids("exit"), ["t1"], "the tool's output is still found");
      assert.deepEqual(await ids("quota exhausted"), ["s1"]);
      assert.deepEqual(await ids("segfaulted"), ["x1"]);
      assert.deepEqual(await ids("changelog"), ["m1"]);
    } finally {
      await store.close();
    }
  });
});
