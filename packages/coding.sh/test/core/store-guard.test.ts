import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { ownerGuard, sourceCheckout, sourceRunRefusal, StoreOwnerError, StoreVersionError } from "../../src/core/store-guard.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../src/store/sqlite.ts";
import { WRITER_KEY } from "../../src/store/upgrade.ts";

const PKG = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-store-guard-unit-")));
after(() => rmSync(root, { recursive: true, force: true }));

function pkgAt(dir: string, withSrc: boolean): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "coding.sh", version: "9.9.9" }));
  writeFileSync(join(dir, "dist", "cli.mjs"), "");
  if (withSrc) {
    mkdirSync(join(dir, "src", "cli"), { recursive: true });
    writeFileSync(join(dir, "src", "cli", "main.ts"), "");
  }
  return join(dir, "dist", "cli.mjs");
}

describe("sourceCheckout", () => {
  it("is the package root for this repo's sources and for the dist/ that `npm run build` writes here", () => {
    assert.equal(sourceCheckout(join(PKG, "src", "core", "store-guard.ts"), join(PKG, "src", "cli", "main.ts")), PKG);
    const dist = join(PKG, "dist", "cli.mjs");
    assert.equal(sourceCheckout(join(PKG, "dist", "chunk-ABC.mjs"), dist), PKG);
    assert.equal(sourceCheckout(dist, dist), PKG);
  });

  it("is undefined for a package installed under node_modules or a global prefix", () => {
    const cli = pkgAt(join(root, "prefix", "lib", "node_modules", "coding.sh"), false);
    assert.equal(sourceCheckout(cli, cli), undefined);
    const npx = pkgAt(join(root, ".npm", "_npx", "abc", "node_modules", "coding.sh"), false);
    assert.equal(sourceCheckout(npx, npx), undefined);
  });

  it("is undefined for a checkout's dist reached through `npm link`", () => {
    const checkout = join(root, "repo", "packages", "coding.sh");
    const real = pkgAt(checkout, true);
    const link = join(root, "linkprefix", "lib", "node_modules", "coding.sh");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(checkout, link, "junction");
    assert.equal(sourceCheckout(real, join(link, "dist", "cli.mjs")), undefined, "the global link");
    assert.equal(sourceCheckout(real, real), checkout, "the same dist run by its own path");
  });
});

describe("sourceRunRefusal", () => {
  const self = join(PKG, "src", "core", "store-guard.ts");
  const at = { self, argv1: join(PKG, "src", "cli", "main.ts") };
  const home = join(root, "h");

  it("refuses the default home from source in one line naming both ways out", () => {
    const why = sourceRunRefusal({ HOME: home }, at);
    assert.ok(why);
    assert.equal(why.split("\n").length, 1);
    assert.match(why, /CODING_SH_HOME/);
    assert.match(why, /CODING_SH_DEV_REAL_STORE=1/);
  });

  it("allows an explicit home, store or opt-in", () => {
    assert.equal(sourceRunRefusal({ HOME: home, CODING_SH_HOME: join(root, "x") }, at), undefined);
    assert.equal(sourceRunRefusal({ HOME: home, CODING_SH_STORE_URL: "memory://" }, at), undefined);
    assert.equal(sourceRunRefusal({ HOME: home, CODING_SH_DEV_REAL_STORE: "1" }, at), undefined);
  });

  it("allows an installed run", () => {
    const cli = pkgAt(join(root, "inst", "lib", "node_modules", "coding.sh"), false);
    assert.equal(sourceRunRefusal({ HOME: home }, { self: cli, argv1: cli }), undefined);
  });
});

describe("migrations wait for the install that owns the store", () => {
  const OLD = SQLITE_SCHEMA_VERSION - 1;

  async function storeAt(file: string, v: number): Promise<void> {
    const { DatabaseSync } = await loadSqlite();
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= v)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    db.close();
  }

  function home(owner?: string): NodeJS.ProcessEnv {
    const data = mkdtempSync(join(root, "data-"));
    if (owner) {
      mkdirSync(join(data, "bin"), { recursive: true });
      writeFileSync(join(data, "bin", "cli-path"), owner + "\n");
    }
    return { HOME: join(root, "h"), CODING_SH_HOME: data };
  }

  it("a run that is not the owner (here: from source) gets a StoreOwnerError and the store stays as it was", async () => {
    const owner = pkgAt(join(root, "old", "lib", "node_modules", "coding.sh"), false);
    const env = home(owner);
    await storeAt(join(env.CODING_SH_HOME!, "index.db"), OLD);
    await assert.rejects(
      () => openContext({ env }),
      (e: unknown) => e instanceof StoreOwnerError && e.from === OLD && e.to === SQLITE_SCHEMA_VERSION && e.owner === owner && e.ownerVersion === "9.9.9" && /coding\.sh upgrade-store/.test(e.message),
    );
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(join(env.CODING_SH_HOME!, "index.db"), { readOnly: true });
    assert.equal((db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v, OLD);
    db.close();
  });

  it("a store with no owner, or a gone one, is not another install's; a store at the current schema opens for anyone", async () => {
    for (const env of [home(), home(join(root, "gone", "cli.mjs"))]) {
      const file = join(env.CODING_SH_HOME!, "index.db");
      await storeAt(file, OLD);
      // An installed coding.sh migrates it (test/cli/store-guard.test.ts runs one).
      assert.doesNotThrow(() => ownerGuard(env.CODING_SH_HOME!, file, undefined, { source: false })!(OLD, SQLITE_SCHEMA_VERSION));
    }
    const owner = pkgAt(join(root, "old2", "lib", "node_modules", "coding.sh"), false);
    const env = home(owner);
    await storeAt(join(env.CODING_SH_HOME!, "index.db"), SQLITE_SCHEMA_VERSION);
    const ctx = await openContext({ env });
    await ctx.close();
  });

  it("a run from a source checkout never migrates a store that holds data by itself, even one nobody owns", async () => {
    const env = home();
    const file = join(env.CODING_SH_HOME!, "index.db");
    await storeAt(file, OLD);
    await assert.rejects(
      () => openContext({ env }),
      (e: unknown) => e instanceof StoreVersionError && e.from === OLD && e.to === SQLITE_SCHEMA_VERSION && e.writer === undefined && /source checkout/.test(e.message) && /coding\.sh upgrade-store/.test(e.message),
    );
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal((db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v, OLD);
    db.close();
    // A new index is nothing to strand: source creates it.
    const fresh = home();
    await (await openContext({ env: fresh })).close();
  });

  it("only a release newer than the store's last writer migrates it, with or without bin/", () => {
    const data = mkdtempSync(join(root, "data-"));
    const file = join(data, "index.db");
    const stamp = { version: "0.1.6", schema: OLD, at: 1 };
    const guard = (version: string, source = false) => ownerGuard(data, file, undefined, { version, source })!;
    // The same version with a newer schema is a source build or a stale one, not the next release.
    for (const [v, source] of [["0.1.6", false], ["0.1.6", true], ["0.1.5", false], ["0.1.6-dev.1", false], ["not a version", false]] as const) {
      assert.throws(
        () => guard(v, source)(OLD, SQLITE_SCHEMA_VERSION, stamp),
        (e: unknown) => e instanceof StoreVersionError && e.writer === "0.1.6" && e.version === v && e.from === OLD && /last written by coding\.sh 0\.1\.6/.test(e.message) && /coding\.sh upgrade-store/.test(e.message),
        v,
      );
    }
    // The release that follows migrates, also from a source checkout of it.
    assert.doesNotThrow(() => guard("0.1.7")(OLD, SQLITE_SCHEMA_VERSION, stamp));
    assert.doesNotThrow(() => guard("0.2.0", true)(OLD, SQLITE_SCHEMA_VERSION, stamp));
    // No stamp (a store from before 0.1.6): an install migrates, a source checkout does not.
    assert.doesNotThrow(() => guard("0.1.6")(OLD, SQLITE_SCHEMA_VERSION, undefined));
    assert.throws(() => guard("0.1.6", true)(OLD, SQLITE_SCHEMA_VERSION, undefined), StoreVersionError);
    // A new index has nothing to strand.
    assert.doesNotThrow(() => guard("0.1.6", true)(0, SQLITE_SCHEMA_VERSION, undefined));
  });

  it("another install's store is refused as owned before the version is looked at", () => {
    const owner = pkgAt(join(root, "old4", "lib", "node_modules", "coding.sh"), false);
    const env = home(owner);
    const file = join(env.CODING_SH_HOME!, "index.db");
    assert.throws(() => ownerGuard(env.CODING_SH_HOME!, file, undefined, { version: "0.1.7", source: false })!(OLD, SQLITE_SCHEMA_VERSION, { version: "0.1.6", schema: OLD, at: 1 }), StoreOwnerError);
  });

  it("only guards the home's own index, not a store named with --store", async () => {
    const owner = pkgAt(join(root, "old3", "lib", "node_modules", "coding.sh"), false);
    const env = home(owner);
    const elsewhere = join(root, "elsewhere", "index.db");
    await storeAt(elsewhere, OLD);
    const ctx = await openContext({ env: { ...env, CODING_SH_STORE_URL: `sqlite://${elsewhere}` } });
    await ctx.close();
  });
});

describe("the owner is judged under the migration's write lock", () => {
  const OLD = SQLITE_SCHEMA_VERSION - 1;
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** An index at OLD in a new home, and a second connection holding its write lock. */
  async function heldStore(owner?: string, writer?: string) {
    const data = mkdtempSync(join(root, "lock-"));
    if (owner) {
      mkdirSync(join(data, "bin"), { recursive: true });
      writeFileSync(join(data, "bin", "cli-path"), owner + "\n");
    }
    const file = join(data, "index.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= OLD)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES ('e0', 's', 0, 'claude-code', 'user.message', '{}')").run();
    if (writer) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)").run(WRITER_KEY, JSON.stringify({ version: writer, schema: OLD, at: 1 }));
    db.exec("BEGIN IMMEDIATE");
    return { data, file, db };
  }
  const schema = async (file: string): Promise<number> => {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v;
    } finally {
      db.close();
    }
  };
  const backups = (data: string): string[] => readdirSync(data).filter((f) => f.endsWith(".bak"));

  it("an index another process finished migrating while this one waited opens, with no StoreOwnerError", async () => {
    // Another install owns the home, so a judgment here would refuse with a StoreOwnerError.
    const owner = pkgAt(join(root, "lock-owner", "lib", "node_modules", "coding.sh"), false);
    const { data, file, db } = await heldStore(owner);
    const guard = ownerGuard(data, file, undefined, { version: "0.1.7", source: false });
    assert.ok(guard);
    const opening = SqliteIndexStore.open(file, { beforeMigrate: guard });
    let settled: unknown = "pending";
    opening.then(() => (settled = "opened"), (e: unknown) => (settled = e));
    await tick(300);
    assert.equal(settled, "pending", "the open waits for the write lock");
    // The owner migrates under the lock it holds.
    for (const m of MIGRATIONS.filter((m) => m.version > OLD)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    db.exec("COMMIT");
    db.close();
    const store = await opening;
    await store.close();
    assert.equal(await schema(file), SQLITE_SCHEMA_VERSION);
    assert.deepEqual(backups(data), []);
  });

  it("a migration refused under the lock rolls back, makes no copy and leaves the lock free", async () => {
    // Read before the lock, the stamp says 0.1.6 and 0.1.7 may migrate; under it, 0.1.8 wrote it.
    const { data, file, db } = await heldStore(undefined, "0.1.6");
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(JSON.stringify({ version: "0.1.8", schema: OLD, at: 2 }), WRITER_KEY);
    const opening = SqliteIndexStore.open(file, { beforeMigrate: ownerGuard(data, file, undefined, { version: "0.1.7", source: false }) });
    await tick(300);
    db.exec("COMMIT");
    db.close();
    await assert.rejects(opening, (e: unknown) => e instanceof StoreVersionError && e.writer === "0.1.8" && e.from === OLD);
    assert.deepEqual(backups(data), []);
    assert.equal(await schema(file), OLD);
    const { DatabaseSync } = await loadSqlite();
    const next = new DatabaseSync(file);
    next.exec("PRAGMA busy_timeout = 0");
    next.exec("BEGIN IMMEDIATE");
    next.exec("ROLLBACK");
    next.close();
  });
});
