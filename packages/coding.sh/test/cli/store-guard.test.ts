// The two guards around a user's store, end to end against real bundles laid out
// the way people run them (a git checkout's dist/, a global npm install, an
// `npm link`). On 2026-11-08 a coding.sh run from a source checkout opened the
// real ~/.coding.sh, migrated its index from v8 to v9, and the installed CLI
// could no longer open it. Every run here gets a temp HOME and no CODING_SH_HOME
// unless a test sets one, so "the default home" is always a temp dir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION } from "../../src/store/sqlite.ts";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const SRC_CLI = join(PKG, "src", "cli", "main.ts");
const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string }).version;

let root = "";
/** dist/cli.mjs inside a git checkout of this repo: what `npm run build` writes. */
let CHECKOUT_CLI = "";
/** dist/cli.mjs of a global install (`npm i -g ./coding.sh-x.tgz`). */
let INSTALLED_CLI = "";
/** The checkout's dist/cli.mjs reached through a global prefix (`npm link`). */
let LINKED_CLI = "";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-store-guard-")));
  const checkout = join(root, "repo", "packages", "coding.sh");
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(checkout, "src", "cli"), { recursive: true });
  writeFileSync(join(checkout, "src", "cli", "main.ts"), "// the checkout's sources\n");
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "coding.sh", version: VERSION }));
  CHECKOUT_CLI = (await bundle(join(checkout, "dist"))).cli;

  const installed = join(root, "prefix", "lib", "node_modules", "coding.sh");
  mkdirSync(installed, { recursive: true });
  cpSync(join(checkout, "dist"), join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "coding.sh", version: VERSION }));
  INSTALLED_CLI = join(installed, "dist", "cli.mjs");

  // npm link: <prefix>/lib/node_modules/coding.sh is a link to the checkout (a junction on Windows).
  const linked = join(root, "linkprefix", "lib", "node_modules", "coding.sh");
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(checkout, linked, "junction");
  LINKED_CLI = join(linked, "dist", "cli.mjs");
});
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function tmpHome(): { home: string; data: string } {
  const home = join(root, "homes", `h${seq++}`);
  mkdirSync(home, { recursive: true });
  return { home, data: join(home, ".coding.sh") };
}

function run(cli: string, args: string[], home: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: dirname(process.execPath),
    NO_UPDATE_NOTIFIER: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, ["--no-warnings", cli, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** An index.db at schema `v`, as the coding.sh that knew only up to v wrote it. */
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

async function schemaOf(file: string): Promise<number> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v;
  } finally {
    db.close();
  }
}

/** A previous install that owns `data` (its bin/cli-path, as init writes it). */
function ownedBy(data: string, cli: string): void {
  mkdirSync(join(data, "bin"), { recursive: true });
  writeFileSync(join(data, "bin", "cli-path"), cli + "\n");
  writeFileSync(join(data, "bin", "hook.mjs"), "// the installed hook\n");
}

function oldInstall(version: string): string {
  const pkg = join(root, "old", version, "lib", "node_modules", "coding.sh");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "coding.sh", version }));
  writeFileSync(join(pkg, "dist", "cli.mjs"), "// an older coding.sh\n");
  return join(pkg, "dist", "cli.mjs");
}

describe("a source checkout never opens the default store by accident", () => {
  for (const [what, cli] of [
    ["src/cli/main.ts", () => SRC_CLI],
    ["the dist/ built inside a checkout", () => CHECKOUT_CLI],
  ] as const) {
    it(`from ${what}, with no CODING_SH_HOME, refuses the default home and opens nothing`, () => {
      const { home, data } = tmpHome();
      const r = run(cli(), ["sessions"], home);
      assert.equal(r.status, 1, r.stderr);
      const lines = r.stderr.trim().split("\n");
      assert.equal(lines.length, 1, `one line: ${r.stderr}`);
      assert.match(lines[0]!, /source checkout/);
      assert.match(lines[0]!, /CODING_SH_HOME/);
      assert.match(lines[0]!, /CODING_SH_DEV_REAL_STORE=1/);
      assert.equal(existsSync(data), false, "nothing was created under the default home");

      const j = run(cli(), ["sessions", "--json"], home);
      assert.equal(j.status, 1);
      assert.equal((JSON.parse(j.stderr) as { reason: string }).reason, "source_checkout");
      assert.equal(existsSync(data), false);
    });
  }

  it("works from source with CODING_SH_HOME, --store or CODING_SH_DEV_REAL_STORE=1", () => {
    const { home, data } = tmpHome();
    const other = join(home, "other");
    for (const cli of [SRC_CLI, CHECKOUT_CLI]) {
      const r = run(cli, ["sessions", "--json"], home, { CODING_SH_HOME: other });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.ok(existsSync(join(other, "index.db")));
    // A read of a store that does not exist is store_missing, so a write (ingest) creates it first.
    const store = `sqlite://${join(home, "elsewhere.db")}`;
    const w = run(CHECKOUT_CLI, ["ingest", "--json", "--store", store], home);
    assert.equal(w.status, 0, w.stderr);
    const s = run(CHECKOUT_CLI, ["sessions", "--json", "--store", store], home);
    assert.equal(s.status, 0, s.stderr);
    assert.ok(existsSync(join(home, "elsewhere.db")));
    assert.equal(existsSync(join(data, "index.db")), false, "--store opened the named store, not the default index");
    const opt = run(CHECKOUT_CLI, ["sessions", "--json"], home, { CODING_SH_DEV_REAL_STORE: "1" });
    assert.equal(opt.status, 0, opt.stderr);
    assert.ok(existsSync(join(data, "index.db")), "the opt-in opened the default home");
  });

  it("still prints help and the version from source", () => {
    const { home, data } = tmpHome();
    assert.equal(run(CHECKOUT_CLI, ["--help"], home).status, 0);
    assert.equal(run(CHECKOUT_CLI, ["--version"], home).status, 0);
    assert.equal(run(CHECKOUT_CLI, ["sessions", "--help"], home).status, 0);
    assert.equal(existsSync(data), false);
  });

  it("an installed package (under node_modules) opens the default home", () => {
    const { home, data } = tmpHome();
    const r = run(INSTALLED_CLI, ["sessions", "--json"], home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(data, "index.db")));
  });

  it("an npm link of the checkout opens the default home", () => {
    const { home, data } = tmpHome();
    const r = run(LINKED_CLI, ["sessions", "--json"], home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(data, "index.db")));
  });

  it("the checkout's dist that init installed (named in bin/cli-path) opens its home: the hook's background ingest", () => {
    const { home, data } = tmpHome();
    ownedBy(data, realpathSync(CHECKOUT_CLI));
    const r = run(CHECKOUT_CLI, ["sessions", "--json"], home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(data, "index.db")));
  });
});

describe("a migration never strands another install", () => {
  const OLD = SQLITE_SCHEMA_VERSION - 1;

  it("an install that doesn't own the store is refused, naming both versions and the command", async () => {
    const { home, data } = tmpHome();
    const index = join(data, "index.db");
    await storeAt(index, OLD);
    const owner = oldInstall("0.1.2");
    ownedBy(data, owner);

    const r = run(INSTALLED_CLI, ["sessions"], home);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /0\.1\.2/, "names the owner's version");
    assert.ok(r.stderr.includes(VERSION), "names this version");
    assert.ok(r.stderr.includes(owner), "names the owner's path");
    assert.match(r.stderr, new RegExp(`v${OLD}\\b`));
    assert.match(r.stderr, new RegExp(`v${SQLITE_SCHEMA_VERSION}\\b`));
    assert.match(r.stderr, /coding\.sh upgrade-store/);
    assert.equal(await schemaOf(index), OLD, "the store was not migrated");

    const j = run(INSTALLED_CLI, ["sessions", "--json"], home);
    const err = JSON.parse(j.stderr) as { reason: string; next: string[]; askUser?: boolean };
    assert.equal(err.reason, "store_owned");
    assert.ok(err.next.some((n) => n.includes("coding.sh upgrade-store")));
    assert.equal(err.askUser, true, "an agent asks the user before stranding their other install");
    assert.equal(await schemaOf(index), OLD);
  });

  it("upgrade-store migrates it and makes this install the one hooks run", async () => {
    const { home, data } = tmpHome();
    const index = join(data, "index.db");
    await storeAt(index, OLD);
    ownedBy(data, oldInstall("0.1.2"));

    const ask = run(INSTALLED_CLI, ["upgrade-store"], home);
    assert.equal(ask.status, 2, "piped, it needs --yes");
    assert.equal(await schemaOf(index), OLD);

    const r = run(INSTALLED_CLI, ["upgrade-store", "--yes", "--json"], home);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { from: number; to: number; cli: string };
    assert.deepEqual([doc.from, doc.to], [OLD, SQLITE_SCHEMA_VERSION]);
    assert.equal(await schemaOf(index), SQLITE_SCHEMA_VERSION);
    assert.equal(readFileSync(join(data, "bin", "cli-path"), "utf8").trim(), realpathSync(INSTALLED_CLI), "hooks now start this install");
    assert.equal(run(INSTALLED_CLI, ["sessions", "--json"], home).status, 0);
  });

  it("the owning install migrates as before", async () => {
    const { home, data } = tmpHome();
    const index = join(data, "index.db");
    await storeAt(index, OLD);
    ownedBy(data, realpathSync(INSTALLED_CLI));
    const r = run(INSTALLED_CLI, ["sessions", "--json"], home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await schemaOf(index), SQLITE_SCHEMA_VERSION);
  });

  it("a store no install owns, or whose owner is gone, migrates as before", async () => {
    for (const owner of [undefined, join(root, "gone", "dist", "cli.mjs")]) {
      const { home, data } = tmpHome();
      const index = join(data, "index.db");
      await storeAt(index, OLD);
      if (owner) ownedBy(data, owner);
      const r = run(INSTALLED_CLI, ["sessions", "--json"], home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(await schemaOf(index), SQLITE_SCHEMA_VERSION);
    }
  });

  it("the opt-in from source still can't migrate a store another install owns", async () => {
    const { home, data } = tmpHome();
    const index = join(data, "index.db");
    await storeAt(index, OLD);
    ownedBy(data, oldInstall("0.1.2"));
    const r = run(CHECKOUT_CLI, ["sessions"], home, { CODING_SH_DEV_REAL_STORE: "1" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /coding\.sh upgrade-store/);
    assert.equal(await schemaOf(index), OLD);
  });
});
