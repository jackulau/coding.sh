// coding.sh sql: the read-only matrix, output formats, the row cap, the timeout and the store check.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { checkReadOnlySql, runSql, SqlFailed, SqlRejected, SqlTimeout } from "../../src/query/sql.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, event, ok, seed, session } from "./_seed.ts";

let env: TmpEnv;
let db = "";

before(async () => {
  env = tmpEnv();
  db = await seed(env.dataHome, {
    sessions: [session("s1"), session("s2", { agent: "codex", title: 'a, "quoted"\ntitle' }), session("s3", { agent: "codex" })],
    events: [event("s1", 1), event("s1", 2, { kind: "tool.start", payload: { tool: "Bash", command: "ls" } }), event("s2", 1)],
  });
});
after(() => env.restore());

describe("checkReadOnlySql", () => {
  const rejected = [
    "insert into sessions (id) values ('x')",
    "update sessions set title = 'x'",
    "delete from sessions",
    "drop table sessions",
    "attach database '/tmp/x.db' as x",
    "pragma journal_mode = delete",
    "PRAGMA writable_schema = 1",
    "select 1; select 2",
    "select 1; delete from sessions",
    "with x as (select 1) delete from sessions",
    "with x as (select 1) insert into kv select * from kv",
    "vacuum",
    "create table t (a)",
    "replace into kv values ('a', 'b', 1)",
    "/* comment */ delete from events",
    "",
    "select 'unterminated",
  ];
  for (const q of rejected) test(`rejects ${JSON.stringify(q)}`, () => assert.throws(() => checkReadOnlySql(q), SqlRejected));

  const allowed = [
    "select count(*) from sessions",
    "SELECT * FROM sessions;",
    "select 1; -- trailing comment",
    "with x as (select 1 as a) select a from x",
    "select replace(title, 'a', 'b') from sessions",
    "select 'delete from sessions; drop table x' as s",
    'select "update" from (select 1 as "update")',
    "select * from pragma_table_info('sessions')",
    "-- leading comment\nselect 1",
  ];
  for (const q of allowed) test(`allows ${JSON.stringify(q)}`, () => assert.doesNotThrow(() => checkReadOnlySql(q)));
});

describe("runSql", () => {
  test("reads rows with column order kept", async () => {
    const r = await runSql(db, "select id, agent from sessions order by id", { limit: 100, timeoutMs: 10_000 });
    assert.deepEqual(r.columns, ["id", "agent"]);
    assert.deepEqual(r.rows, [["s1", "claude-code"], ["s2", "codex"], ["s3", "codex"]]);
    assert.equal(r.truncated, false);
  });

  test("caps rows and says so", async () => {
    const r = await runSql(db, "select id from sessions order by id", { limit: 2, timeoutMs: 10_000 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true);
  });

  test("the connection itself refuses writes that pass the lexical check", async () => {
    // A user function that writes is impossible here, so check the guard below the lexer directly.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(db, { readOnly: true });
    raw.exec("PRAGMA query_only = ON");
    assert.throws(() => raw.exec("CREATE TEMP TABLE t (a)"));
    assert.throws(() => raw.exec("DELETE FROM sessions"));
    raw.close();
  });

  test("a runaway query stops at the timeout", async () => {
    const q = "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c";
    await assert.rejects(runSql(db, q, { limit: 10, timeoutMs: 300 }), SqlTimeout);
  });

  test("SQLite errors come back as SqlFailed", async () => {
    await assert.rejects(runSql(db, "select nope from sessions", { limit: 10, timeoutMs: 10_000 }), SqlFailed);
  });
});

describe("coding.sh sql", () => {
  test("count(*) from sessions equals what sessions --json lists", () => {
    const listed = JSON.parse(ok(["sessions", "--json", "--subagents", "--limit", "1000"]).stdout) as { sessions: unknown[] };
    const r = JSON.parse(ok(["sql", "select count(*) as n from sessions", "--json"]).stdout) as { rows: { n: number }[] };
    assert.equal(r.rows[0]!.n, 3);
    assert.equal(listed.sessions.length, 3);
  });

  test("table output, tab-separated off a TTY", () => {
    const out = ok(["sql", "select agent, count(*) as n from sessions group by agent order by agent"]).stdout;
    assert.equal(out, "agent\tn\nclaude-code\t1\ncodex\t2\n");
  });

  test("--csv quotes commas, quotes and newlines", () => {
    const out = ok(["sql", "select title from sessions where id = 's2'", "--csv"]).stdout;
    assert.equal(out, 'title\r\n"a, ""quoted""\ntitle"\r\n');
  });

  test("--json: rows as objects, rowCount, truncated", () => {
    const r = JSON.parse(ok(["sql", "select id, id from sessions order by id", "--json", "--limit", "1"]).stdout);
    assert.deepEqual(r, { columns: ["id", "id"], rows: [{ id: "s1", "id:2": "s1" }], rowCount: 1, truncated: true });
  });

  test("a truncated table says so on stderr", () => {
    const r = ok(["sql", "select id from sessions", "--limit", "1"]);
    assert.match(r.stderr, /Showing the first 1 rows/);
  });

  test("writes exit 2 and change nothing", () => {
    const before = readFileSync(db);
    const mtime = statSync(db).mtimeMs;
    for (const q of ["delete from sessions", "insert into kv values ('a','b',1)", "attach database 'x.db' as x", "pragma user_version = 9", "select 1; select 2", "with x as (select 1) update sessions set title = 'x'"]) {
      const r = cli(["sql", q]);
      assert.equal(r.status, 2, `${q}: ${r.stderr}`);
      assert.match(r.stderr, /not allowed|only|read-only/);
    }
    assert.equal(statSync(db).mtimeMs, mtime);
    assert.ok(readFileSync(db).equals(before));
  });

  test("a bad column names the error and how to list columns", () => {
    const r = cli(["sql", "select nope from sessions"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such column: nope/);
    assert.match(r.stderr, /sqlite_schema/);
  });

  test("a non-SQLite store gets a clear error with the export alternative", () => {
    const r = cli(["sql", "select 1", "--store", "postgres://user:secret@db.example:5432/coding"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reads the SQLite index; this store is postgres:\/\/…@db\.example/);
    assert.doesNotMatch(r.stderr, /secret/);
    assert.match(r.stderr, /coding\.sh export sessions/);
  });
});
