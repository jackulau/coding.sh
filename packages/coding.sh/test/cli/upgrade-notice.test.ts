// An index upgrade too small to print progress (store/upgrade.ts) still says where it kept the
// index as it was, in one dim stderr line, when a person runs the command at a terminal. Not with
// --json, not when stderr is piped, and not from upgrade-store, which says it in its own words.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { main } from "../../src/cli/main.ts";
import { upgradeStoreCommand } from "../../src/core/store-guard.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../../src/store/sqlite.ts";
import { backupPath, WRITER_KEY, type StoreWriter } from "../../src/store/upgrade.ts";
import { removeTestDir } from "../_rm.ts";

const OLD = SQLITE_SCHEMA_VERSION - 1;
let root = "";
let seq = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-upgrade-notice-"));
});
after(() => removeTestDir(root));

/**
 * A home whose index is at schema OLD with three events, last written by an older coding.sh:
 * this install, run from source, may migrate it (core/store-guard.ts ownerGuard).
 */
async function oldHome(): Promise<{ env: NodeJS.ProcessEnv; index: string }> {
  const home = join(root, `h${seq++}`);
  const data = join(home, ".coding.sh");
  mkdirSync(data, { recursive: true });
  const index = join(data, "index.db");
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(index);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= OLD)) {
    db.exec(m.sql);
    m.after?.(db);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
  }
  const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES (?, 's', ?, 'claude-code', 'user.message', ?)");
  for (let i = 0; i < 3; i++) insert.run(`e${i}`, i, JSON.stringify({ text: `message ${i}` }));
  db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)").run(WRITER_KEY, JSON.stringify({ version: "0.0.1", schema: OLD, at: 0 } satisfies StoreWriter));
  db.close();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: data,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    T3CODE_HOME: join(home, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    NO_COLOR: "1",
  };
  delete env.FORCE_COLOR;
  return { env, index };
}

/** main() in this process with stderr captured; `tty` says whether stderr is a terminal. */
async function exec(env: NodeJS.ProcessEnv, tty: boolean, ...args: string[]): Promise<{ status: number; stderr: string }> {
  const write = process.stderr.write;
  const isTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true, writable: true });
  try {
    return { status: await main(args, env), stderr };
  } finally {
    process.stderr.write = write;
    if (isTTY) Object.defineProperty(process.stderr, "isTTY", isTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

/** The line the upgrade prints for a store at `index` that it migrated from OLD. */
const notice = (index: string): string =>
  `coding.sh: index upgraded to schema v${SQLITE_SCHEMA_VERSION}. The index as it was is kept at ${backupPath(index, OLD)}: \`${upgradeStoreCommand(["--restore"])}\` puts it back, and it is yours to delete.`;

describe("an index upgrade too small for progress names the copy it kept", () => {
  test("at a terminal: one line names the copy and the command that puts it back", async () => {
    const { env, index } = await oldHome();
    const r = await exec(env, true, "sessions");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(backupPath(index, OLD)), "the upgrade kept a copy");
    assert.equal(r.stderr.split("\n").filter((l) => l === notice(index)).length, 1, r.stderr);
  });

  test("the line is dim when stderr has color", async () => {
    const { env, index } = await oldHome();
    delete env.NO_COLOR;
    env.FORCE_COLOR = "1";
    const r = await exec(env, true, "sessions");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`\u001b[2m${notice(index)}\u001b[22m\n`), r.stderr);
  });

  test("not with --json, and not when stderr is piped", async () => {
    for (const [tty, args] of [[true, ["sessions", "--json"]], [false, ["sessions"]]] as const) {
      const { env, index } = await oldHome();
      const r = await exec(env, tty, ...args);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(backupPath(index, OLD)), "the upgrade still kept a copy");
      assert.doesNotMatch(r.stderr, /index upgraded|kept at/, `${args.join(" ")}: ${r.stderr}`);
    }
  });

  test("not from upgrade-store, which names the copy itself", async () => {
    const { env, index } = await oldHome();
    const r = await exec(env, true, "upgrade-store", "--yes");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /index upgraded to schema/, r.stderr);
    assert.equal(r.stderr.split(backupPath(index, OLD)).length - 1, 1, r.stderr);
  });
});
