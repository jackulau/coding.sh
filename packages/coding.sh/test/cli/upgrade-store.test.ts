// The ways out of a one-way index migration, end to end against a real bundle
// installed the way people run it. On 2026-11-08 a stale build migrated a real
// index from v8 to v9: the installed coding.sh could not open it, ingest stopped
// with no notice while the hook kept spooling, and there was no copy to go back
// to. Every run here gets a temp HOME and its own CODING_SH_HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../../src/store/sqlite.ts";
import { WRITER_KEY } from "../../src/store/upgrade.ts";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const SRC_CLI = join(PKG, "src", "cli", "main.ts");
const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string }).version;
const OLD = SQLITE_SCHEMA_VERSION - 1;

let root = "";
/** dist/cli.mjs of a global install (`npm i -g coding.sh`). */
let CLI = "";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-upgrade-store-")));
  const built = await bundle(join(root, "build", "dist"));
  const installed = join(root, "prefix", "lib", "node_modules", "coding.sh");
  mkdirSync(installed, { recursive: true });
  cpSync(dirname(built.cli), join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "coding.sh", version: VERSION }));
  CLI = realpathSync(join(installed, "dist", "cli.mjs"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function tmpHome(): { home: string; data: string; index: string } {
  const home = join(root, "homes", `h${seq++}`);
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  return { home, data, index: join(data, "index.db") };
}

function run(cli: string, args: string[], h: { home: string; data: string }, opts: { input?: string } = {}) {
  const env: NodeJS.ProcessEnv = {
    HOME: h.home,
    USERPROFILE: h.home,
    CODING_SH_HOME: h.data,
    CLAUDE_CONFIG_DIR: join(h.home, ".claude"),
    CODEX_HOME: join(h.home, ".codex"),
    PATH: dirname(process.execPath),
    NO_UPDATE_NOTIFIER: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
  };
  const r = spawnSync(process.execPath, ["--no-warnings", cli, ...args], { env, encoding: "utf8", timeout: 60_000, input: opts.input });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** An index.db at schema `v` holding one event, stamped as last written by `writer` when given. */
async function storeAt(file: string, v: number, writer?: string): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= v)) {
    db.exec(m.sql);
    m.after?.(db);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
  }
  db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES ('e1', 's', 1, 'claude-code', 'user.message', '{}')").run();
  if (writer) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)").run(WRITER_KEY, JSON.stringify({ version: writer, schema: v, at: 1 }));
  db.close();
}

async function schemaOf(file: string): Promise<number> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v;
  } finally {
    db.close();
  }
}

/** What is in the data home, without SQLite's own side files. */
const files = (data: string): string[] => readdirSync(data).filter((f) => !/-(wal|shm)$/.test(f)).sort();

describe("a build that is not newer than the store's last writer", () => {
  it("is refused with no bin/ at all, and the store is unchanged", async () => {
    const h = tmpHome();
    await storeAt(h.index, OLD, VERSION);
    const r = run(CLI, ["sessions"], h);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`index schema v${OLD}\\b`));
    assert.ok(r.stderr.includes(`last written by coding.sh ${VERSION}`), r.stderr);
    assert.match(r.stderr, /coding\.sh upgrade-store/);
    const j = run(CLI, ["sessions", "--json"], h);
    const err = JSON.parse(j.stderr) as { reason: string; askUser?: boolean; next: string[]; data: { from: number; to: number; writer: string } };
    assert.equal(err.reason, "store_version");
    assert.equal(err.askUser, true, "an agent asks the user before a one-way migration");
    assert.ok(err.next.includes("coding.sh upgrade-store"));
    assert.deepEqual([err.data.from, err.data.to, err.data.writer], [OLD, SQLITE_SCHEMA_VERSION, VERSION]);
    assert.equal(await schemaOf(h.index), OLD, "the store was not migrated");
    assert.deepEqual(files(h.data), ["index.db"], "no copy, no bin/, nothing else");
  });

  it("from source, a store with no stamp is refused too (the read that migrated a v9 copy by itself)", async () => {
    const h = tmpHome();
    await storeAt(h.index, OLD);
    const r = run(SRC_CLI, ["sessions", "--json"], h);
    assert.equal(r.status, 1, r.stderr);
    assert.equal((JSON.parse(r.stderr) as { reason: string }).reason, "store_version");
    assert.match(r.stderr, /source checkout/);
    assert.equal(await schemaOf(h.index), OLD);
  });

  it("upgrade-store --yes migrates it, keeps the index as it was, and --restore puts it back", async () => {
    const h = tmpHome();
    await storeAt(h.index, OLD, VERSION);
    assert.equal(run(CLI, ["upgrade-store"], h).status, 2, "piped, it needs --yes");
    assert.equal(await schemaOf(h.index), OLD);

    const up = run(CLI, ["upgrade-store", "--yes", "--json"], h);
    assert.equal(up.status, 0, up.stderr);
    const doc = JSON.parse(up.stdout) as { status: string; from: number; to: number; backup: string; cliPath: string };
    assert.deepEqual([doc.status, doc.from, doc.to], ["migrated", OLD, SQLITE_SCHEMA_VERSION]);
    assert.equal(doc.backup, `${h.index}.v${OLD}.bak`);
    assert.equal(await schemaOf(h.index), SQLITE_SCHEMA_VERSION);
    assert.equal(await schemaOf(doc.backup), OLD, "the copy is the index as it was");
    assert.equal(run(CLI, ["sessions", "--json"], h).status, 0, "this build opens it now");

    assert.equal(run(CLI, ["upgrade-store", "--restore"], h).status, 2, "piped, a restore needs --yes too");
    assert.equal(await schemaOf(h.index), SQLITE_SCHEMA_VERSION);
    const back = run(CLI, ["upgrade-store", "--restore", "--yes", "--json"], h);
    assert.equal(back.status, 0, back.stderr);
    const restored = JSON.parse(back.stdout) as { status: string; from: number; to: number; undone: string };
    assert.deepEqual([restored.status, restored.from, restored.to], ["restored", SQLITE_SCHEMA_VERSION, OLD]);
    assert.equal(await schemaOf(h.index), OLD, "the old schema is back");
    assert.equal(await schemaOf(restored.undone), SQLITE_SCHEMA_VERSION, "the migrated index is kept");
    assert.equal(existsSync(doc.backup), false, "the copy was moved back, not copied");

    // The build that restored it does not migrate it again by itself.
    const again = run(CLI, ["sessions", "--json"], h);
    assert.equal(again.status, 1);
    assert.equal((JSON.parse(again.stderr) as { reason: string }).reason, "store_version");
    assert.equal(await schemaOf(h.index), OLD);

    const none = run(CLI, ["upgrade-store", "--restore", "--yes", "--json"], h);
    assert.equal(none.status, 1);
    assert.equal((JSON.parse(none.stderr) as { reason: string }).reason, "no_backup");
  });
});

describe("upgrade-store always leaves bin/cli-path naming the running CLI", () => {
  it("writes it where there was no bin/", async () => {
    const h = tmpHome();
    await storeAt(h.index, OLD, VERSION);
    const r = run(CLI, ["upgrade-store", "--yes", "--json"], h);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8").trim(), CLI);
    assert.equal((JSON.parse(r.stdout) as { cliPath: string }).cliPath, CLI);
    assert.equal(existsSync(join(h.data, "bin", "hook.mjs")), false, "no capture was installed");
  });

  it("rewrites a bin/ that holds only a cli-path naming the old install, and --restore gives the hooks back", async () => {
    const h = tmpHome();
    await storeAt(h.index, OLD);
    const old = join(root, "old", "lib", "node_modules", "coding.sh");
    mkdirSync(join(old, "dist"), { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "coding.sh", version: "0.1.2" }));
    writeFileSync(join(old, "dist", "cli.mjs"), "// an older coding.sh\n");
    const oldCli = join(old, "dist", "cli.mjs");
    mkdirSync(join(h.data, "bin"), { recursive: true });
    writeFileSync(join(h.data, "bin", "cli-path"), oldCli + "\n");

    assert.equal(run(CLI, ["sessions"], h).status, 1, "another install owns it");
    const r = run(CLI, ["upgrade-store", "--yes", "--json"], h);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8").trim(), CLI, "cli-path names the running CLI");

    const back = run(CLI, ["upgrade-store", "--restore", "--yes", "--json"], h);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8").trim(), oldCli, "hooks start the coding.sh that opens the restored schema");
    assert.equal(await schemaOf(h.index), OLD);
  });

  it("repairs a cli-path that names a CLI that is gone, with nothing to migrate and nothing to ask", async () => {
    const h = tmpHome();
    await storeAt(h.index, SQLITE_SCHEMA_VERSION);
    mkdirSync(join(h.data, "bin"), { recursive: true });
    writeFileSync(join(h.data, "bin", "cli-path"), join(root, "gone", "dist", "cli.mjs") + "\n");
    const r = run(CLI, ["upgrade-store", "--json"], h);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8").trim(), CLI);
    assert.deepEqual(files(h.data), ["bin", "index.db"], "nothing to migrate: no copy");
  });
});

describe("a store one schema ahead of this coding.sh", () => {
  async function ahead(): Promise<ReturnType<typeof tmpHome>> {
    const h = tmpHome();
    await storeAt(h.index, SQLITE_SCHEMA_VERSION, "9.9.9");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(h.index);
    db.exec(`INSERT INTO migrations (version, applied_at) VALUES (${SQLITE_SCHEMA_VERSION + 1}, 0)`);
    db.close();
    for (const f of ["a.jsonl", "b.jsonl"]) {
      mkdirSync(join(h.data, "spool", "claude-code"), { recursive: true });
      writeFileSync(join(h.data, "spool", "claude-code", f), "{}\n");
    }
    return h;
  }

  it("says captures are safe in the spool, how many wait, which version opens it, and coding.sh update", async () => {
    const h = await ahead();
    const r = run(CLI, ["sessions"], h);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`index schema v${SQLITE_SCHEMA_VERSION + 1}, written by coding\\.sh 9\\.9\\.9`));
    assert.ok(r.stderr.includes(`this coding.sh ${VERSION} only knows up to v${SQLITE_SCHEMA_VERSION}`), r.stderr);
    assert.match(r.stderr, /Your captures are safe: 2 capture files wait in the spool/);
    assert.ok(r.stderr.includes(join(h.data, "spool")), "names the spool");
    assert.match(r.stderr, /coding\.sh 9\.9\.9 or newer/);
    assert.match(r.stderr, /coding\.sh update/);
    assert.doesNotMatch(r.stderr, /config path/, "the next step is not the config file");

    const j = run(CLI, ["sessions", "--json"], h);
    const err = JSON.parse(j.stderr) as { reason: string; next: string[]; data: { schema: number; known: number; writer: string; spool: { files: number } } };
    assert.equal(err.reason, "store_newer");
    assert.ok(err.next.includes("coding.sh update"));
    assert.deepEqual([err.data.schema, err.data.known, err.data.writer, err.data.spool.files], [SQLITE_SCHEMA_VERSION + 1, SQLITE_SCHEMA_VERSION, "9.9.9", 2]);
  });

  it("the hook's background ingest leaves a marker, and status, status --json and the status line say ingest stopped", async () => {
    const h = await ahead();
    assert.equal((JSON.parse(run(CLI, ["status", "--json"], h).stdout || "{}") as { ingestStopped?: unknown }).ingestStopped, undefined, "nothing has failed yet");

    const bg = run(CLI, ["ingest", "--background"], h); // what the hook starts at session end
    assert.equal(bg.status, 1);
    const s = run(CLI, ["status", "--json"], h);
    assert.equal(s.status, 1, "the store still can't be opened");
    const doc = JSON.parse(s.stdout) as { home: string; spool: { files: number }; storeError: string; ingestStopped: { since: string; reason: string; message: string; next: string } };
    assert.equal(doc.storeError, "store_newer");
    assert.equal(doc.spool.files, 2);
    assert.equal(doc.ingestStopped.reason, "store_newer");
    assert.equal(doc.ingestStopped.next, "coding.sh update");
    assert.ok(Date.now() - Date.parse(doc.ingestStopped.since) < 60_000);
    assert.equal((JSON.parse(s.stderr) as { reason: string }).reason, "store_newer", "and the error is still the answer on stderr");

    const text = run(CLI, ["status"], h);
    assert.match(text.stderr, /Ingest\s+stopped (just now|\d+s ago): .*run coding\.sh update/);
    assert.match(text.stderr, /Spool\s+2 files/);

    const line = run(CLI, ["statusline"], h, { input: JSON.stringify({ model: { display_name: "Fable" } }) });
    assert.equal(line.status, 0);
    assert.match(line.stdout, /^Fable {2}· {2}! ingest stopped (just now|\d+s ago)\n$/);

    const doctor = run(CLI, ["doctor", "--json"], h);
    const d = JSON.parse(doctor.stdout) as { ingestStopped?: { reason: string }; warnings: { check: string; next?: string }[] };
    assert.equal(d.ingestStopped?.reason, "store_newer");
    assert.ok(d.warnings.some((w) => w.check === "ingest" && w.next === "coding.sh update"));

    // The first failure's time is kept while it keeps failing.
    run(CLI, ["ingest", "--background"], h);
    assert.equal((JSON.parse(run(CLI, ["status", "--json"], h).stdout) as { ingestStopped: { since: string } }).ingestStopped.since, doc.ingestStopped.since);
  });

  it("the stranded coding.sh puts back the index from before the migration itself", async () => {
    const h = await ahead();
    // The copy the newer coding.sh kept when it migrated.
    await storeAt(`${h.index}.v${SQLITE_SCHEMA_VERSION}.bak`, SQLITE_SCHEMA_VERSION);
    assert.match(run(CLI, ["sessions"], h).stderr, /coding\.sh upgrade-store --restore puts back the index from before the migration/);
    run(CLI, ["ingest", "--background"], h);
    assert.ok(existsSync(join(h.data, "ingest-stopped.json")));

    const back = run(CLI, ["upgrade-store", "--restore", "--yes", "--json"], h);
    assert.equal(back.status, 0, back.stderr);
    const doc = JSON.parse(back.stdout) as { from: number; to: number; undone: string; cliPath: string };
    assert.deepEqual([doc.from, doc.to], [SQLITE_SCHEMA_VERSION + 1, SQLITE_SCHEMA_VERSION]);
    assert.equal(doc.undone, `${h.index}.v${SQLITE_SCHEMA_VERSION + 1}.undone`);
    assert.equal(doc.cliPath, CLI, "hooks start the coding.sh that opens the restored index");
    // It opens again, the spool is ingested, and the marker goes.
    const s = run(CLI, ["status", "--json"], h);
    assert.equal(s.status, 0, s.stderr);
    assert.equal("ingestStopped" in (JSON.parse(s.stdout) as object), false);
    assert.equal(await schemaOf(h.index), SQLITE_SCHEMA_VERSION);
  });

  it("an ingest that works again removes the marker", async () => {
    const h = tmpHome();
    await storeAt(h.index, SQLITE_SCHEMA_VERSION);
    writeFileSync(join(h.data, "ingest-stopped.json"), JSON.stringify({ since: Date.now() - 4 * 3600e3, at: Date.now(), reason: "store_newer", why: "a newer coding.sh migrated the store, and this one can't open it", next: "coding.sh update", version: VERSION }));
    const before = run(CLI, ["status"], h); // CODING_SH_NO_AUTO_INGEST: status itself ingests nothing here
    assert.match(before.stderr, /Ingest\s+stopped 4h ago/);
    assert.equal(run(CLI, ["ingest", "--background"], h).status, 0);
    assert.equal(existsSync(join(h.data, "ingest-stopped.json")), false);
    const s = run(CLI, ["status", "--json"], h);
    assert.equal(s.status, 0, s.stderr);
    assert.equal("ingestStopped" in (JSON.parse(s.stdout) as object), false);
  });
});
