import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { cliCommand, quoteArg } from "../../src/cli/next-steps.ts";
import { ownerGuard, pathCli, sourceCheckout, sourceRunRefusal, StoreOwnerError, StoreVersionError, upgradeStoreCommand } from "../../src/core/store-guard.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../src/store/sqlite.ts";
import { WRITER_KEY } from "../../src/store/upgrade.ts";
import { npmBins, npmShShim } from "../cli/_npm-bins.ts";

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
      (e: unknown) => e instanceof StoreOwnerError && e.from === OLD && e.to === SQLITE_SCHEMA_VERSION && e.owner === owner && e.ownerVersion === "9.9.9" && e.command === cliCommand(process.env, ["upgrade-store"]) && e.message.endsWith(`: ${e.command}`),
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
      (e: unknown) => e instanceof StoreVersionError && e.from === OLD && e.to === SQLITE_SCHEMA_VERSION && e.writer === undefined && /source checkout/.test(e.message) && e.command === cliCommand(process.env, ["upgrade-store"]) && e.message.endsWith(`: ${e.command}`),
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
        (e: unknown) => e instanceof StoreVersionError && e.writer === "0.1.6" && e.version === v && e.from === OLD && /last written by coding\.sh 0\.1\.6/.test(e.message) && e.message.endsWith(`: ${cliCommand(process.env, ["upgrade-store"])}`),
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

describe("the upgrade-store command a refusal names runs the install that printed it", () => {
  // PowerShell and cmd set neither MSYSTEM nor SHELL; Git Bash sets both.
  const PS: NodeJS.ProcessEnv = {};
  const BASH: NodeJS.ProcessEnv = { MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" };
  const WIN = "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\coding.sh\\dist\\cli.mjs";
  const SPACED = "C:\\Program Files\\nodejs\\node_modules\\coding.sh\\dist\\cli.mjs";
  const LINUX = "/home/user/.npm-global/lib/node_modules/coding.sh/dist/cli.mjs";
  const OLD = SQLITE_SCHEMA_VERSION - 1;

  it("is the bin on PATH, named for the shell, when that bin starts this install", () => {
    assert.equal(upgradeStoreCommand([], { env: PS, platform: "win32", cli: WIN, onPath: WIN }), "codingsh upgrade-store");
    assert.equal(upgradeStoreCommand(["--restore"], { env: BASH, platform: "win32", cli: WIN, onPath: WIN }), "coding.sh upgrade-store --restore");
    // Windows paths match in any case; others only as written.
    assert.equal(upgradeStoreCommand([], { env: PS, platform: "win32", cli: WIN, onPath: WIN.toLowerCase() }), "codingsh upgrade-store");
    assert.equal(upgradeStoreCommand([], { env: {}, platform: "linux", cli: LINUX, onPath: LINUX }), "coding.sh upgrade-store");
    assert.equal(upgradeStoreCommand([], { env: {}, platform: "linux", cli: LINUX, onPath: LINUX.toUpperCase() }), `node ${LINUX} upgrade-store`);
    // npx puts the bin of the package it runs first on PATH, and runs it through cmd on Windows.
    assert.equal(upgradeStoreCommand([], { env: { ...BASH, npm_command: "exec" }, platform: "win32", cli: WIN, onPath: WIN }), "npx -p coding.sh codingsh upgrade-store");
    assert.equal(upgradeStoreCommand([], { env: { npm_command: "exec" }, platform: "linux", cli: LINUX, onPath: LINUX }), "npx coding.sh upgrade-store");
  });

  it("is this install by its path, quoted for the shell, when PATH starts another install or none", () => {
    for (const onPath of [undefined, "C:\\Users\\user\\old\\node_modules\\coding.sh\\dist\\cli.mjs"]) {
      assert.equal(upgradeStoreCommand([], { env: PS, platform: "win32", cli: WIN, onPath }), `node ${WIN} upgrade-store`);
      assert.equal(upgradeStoreCommand([], { env: BASH, platform: "win32", cli: WIN, onPath }), `node '${WIN}' upgrade-store`);
    }
    assert.equal(upgradeStoreCommand(["--restore"], { env: PS, platform: "win32", cli: SPACED, onPath: undefined }), `node "${SPACED}" upgrade-store --restore`);
    assert.equal(upgradeStoreCommand(["--restore"], { env: BASH, platform: "win32", cli: SPACED, onPath: undefined }), `node '${SPACED}' upgrade-store --restore`);
    assert.equal(upgradeStoreCommand([], { env: {}, platform: "linux", cli: LINUX, onPath: "/usr/lib/node_modules/coding.sh/dist/cli.mjs" }), `node ${LINUX} upgrade-store`);
  });

  it("from source, where no install runs, is the bin next steps name", () => {
    assert.equal(upgradeStoreCommand([], { env: PS, platform: "win32", cli: undefined }), "codingsh upgrade-store");
    assert.equal(upgradeStoreCommand(["--restore"], { env: BASH, platform: "win32", cli: undefined }), "coding.sh upgrade-store --restore");
    assert.equal(upgradeStoreCommand([], { env: {}, platform: "linux", cli: undefined }), "coding.sh upgrade-store");
  });

  it("ownerGuard's refusals name it, as e.command and at the end of the message", () => {
    const cli = pkgAt(join(root, "this", "lib", "node_modules", "coding.sh"), false);
    const owner = pkgAt(join(root, "that", "lib", "node_modules", "coding.sh"), false);
    const owned = mkdtempSync(join(root, "data-"));
    mkdirSync(join(owned, "bin"));
    writeFileSync(join(owned, "bin", "cli-path"), owner + "\n");
    const unowned = mkdtempSync(join(root, "data-"));
    const refusals = (env: NodeJS.ProcessEnv): (StoreOwnerError | StoreVersionError)[] => {
      const errors: (StoreOwnerError | StoreVersionError)[] = [];
      try {
        ownerGuard(owned, join(owned, "index.db"), cli, { env })!(OLD, SQLITE_SCHEMA_VERSION);
      } catch (e) {
        assert.ok(e instanceof StoreOwnerError);
        errors.push(e);
      }
      try {
        ownerGuard(unowned, join(unowned, "index.db"), cli, { version: "0.1.6", source: false, env })!(OLD, SQLITE_SCHEMA_VERSION, { version: "0.1.6", schema: OLD, at: 1 });
      } catch (e) {
        assert.ok(e instanceof StoreVersionError);
        errors.push(e);
      }
      assert.equal(errors.length, 2);
      return errors;
    };
    // Nothing on PATH starts this install (the owner's bin does not count): name it by its path.
    const env = { PATH: npmBins(owner) };
    for (const e of refusals(env)) {
      assert.equal(e.command, `node ${quoteArg(cli, env)} upgrade-store`);
      assert.ok(e.message.endsWith(`: node ${quoteArg(cli, env)} upgrade-store`), e.message);
    }
    // Its own bin is on PATH: name the bin, for PowerShell (on Windows) and for sh.
    const dir = npmBins(cli);
    for (const shell of [{}, BASH]) {
      const onPath = { ...shell, PATH: dir };
      for (const e of refusals(onPath)) assert.equal(e.command, cliCommand(onPath, ["upgrade-store"]));
    }
  });
});

describe("pathCli", () => {
  const install = (name: string) => pkgAt(join(root, name, "lib", "node_modules", "coding.sh"), false);
  const SEP = process.platform === "win32" ? ";" : ":";
  // Git Bash on Windows runs npm's sh shim; macOS and Linux run the link.
  const SH: NodeJS.ProcessEnv = process.platform === "win32" ? { MSYSTEM: "MINGW64" } : {};

  it("follows the bin the shell runs to the CLI it starts: the link on macOS and Linux, npm's sh shim in Git Bash", () => {
    const cli = install("pc-sh");
    assert.equal(pathCli({ ...SH, PATH: npmBins(cli) }), cli);
  });

  it("on Windows follows codingsh.cmd in PowerShell and cmd, and under npx in any shell", { skip: process.platform !== "win32" && "Windows only" }, () => {
    const cli = install("pc-cmd");
    const dir = npmBins(cli);
    assert.equal(pathCli({ PATH: dir }, "win32"), cli);
    assert.equal(pathCli({ Path: dir }, "win32"), cli, "a copied Windows env spells it Path");
    assert.equal(pathCli({ MSYSTEM: "MINGW64", npm_command: "exec", PATH: dir }, "win32"), cli);
    rmSync(join(dir, "codingsh.cmd"));
    assert.equal(pathCli({ PATH: dir }, "win32"), undefined, "the sh shim is not what PowerShell runs");
  });

  it("the first directory on PATH with the bin wins; with none it is undefined", () => {
    const a = install("pc-a");
    const b = install("pc-b");
    const da = npmBins(a);
    const db = npmBins(b);
    const empty = mkdtempSync(join(root, "empty-"));
    assert.equal(pathCli({ ...SH, PATH: ["", empty, db, da].join(SEP) }), b);
    assert.equal(pathCli({ ...SH, PATH: [da, db].join(SEP) }), a);
    assert.equal(pathCli({ ...SH, PATH: empty }), undefined);
    assert.equal(pathCli({ ...SH }), undefined);
  });

  it("a coding.sh on PATH that is no npm link or shim is itself", () => {
    const dir = mkdtempSync(join(root, "own-"));
    writeFileSync(join(dir, "coding.sh"), "#!/bin/sh\necho mine\n");
    assert.equal(pathCli({ ...SH, PATH: dir }), join(dir, "coding.sh"));
    // A shim for another package names that package's file.
    const other = mkdtempSync(join(root, "other-"));
    writeFileSync(join(other, "coding.sh"), npmShShim("node_modules/other/cli.js"));
    assert.equal(pathCli({ ...SH, PATH: other }), join(other, "node_modules", "other", "cli.js"));
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
