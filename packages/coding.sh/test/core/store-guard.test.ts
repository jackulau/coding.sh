import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { sourceCheckout, sourceRunRefusal, StoreOwnerError } from "../../src/core/store-guard.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../../src/store/sqlite.ts";

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

  it("a store with no owner, or a gone one, migrates; a store at the current schema opens for anyone", async () => {
    for (const env of [home(), home(join(root, "gone", "cli.mjs"))]) {
      await storeAt(join(env.CODING_SH_HOME!, "index.db"), OLD);
      const ctx = await openContext({ env });
      await ctx.close();
    }
    const owner = pkgAt(join(root, "old2", "lib", "node_modules", "coding.sh"), false);
    const env = home(owner);
    await storeAt(join(env.CODING_SH_HOME!, "index.db"), SQLITE_SCHEMA_VERSION);
    const ctx = await openContext({ env });
    await ctx.close();
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
