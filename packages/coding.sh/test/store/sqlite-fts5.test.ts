// A Node whose bundled SQLite has no FTS5 (before 22.16 on some builds) fails to open
// the index with "no such module: fts5". The CLI says which Node coding.sh needs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { withContext } from "../../src/cli/common.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

describe("a Node without FTS5", () => {
  let root: string;
  let restore: () => void;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-fts5-"));
    const { DatabaseSync } = await loadSqlite();
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (/USING fts5/i.test(sql)) throw Object.assign(new Error("no such module: fts5"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
      return exec.call(this, sql);
    };
    restore = () => void (DatabaseSync.prototype.exec = exec);
  });
  after(() => {
    restore();
    rmSync(root, { recursive: true, force: true });
  });

  test("the store error names FTS5 and Node 22.16", async () => {
    await assert.rejects(SqliteIndexStore.open(join(root, "a", "index.db")), /no FTS5; coding\.sh needs Node 22\.16 or newer/);
  });

  test("the CLI error names Node 22.16", async () => {
    const env = { HOME: root, CODING_SH_HOME: join(root, "home") };
    const sink = { write: () => true, isTTY: false };
    const out = new Output({ json: false, env, stdout: sink, stderr: sink, stdin: { isTTY: false } });
    const c: CommandContext = { flags: {}, positionals: [], rest: [], out, env, cwd: root, debug: false, signal: new AbortController().signal };
    await assert.rejects(withContext(c, async () => 0), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Node 22\.16/);
      return true;
    });
  });
});
