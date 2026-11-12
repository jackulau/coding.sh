// upgrade-store migrates the SQLite index. With a store plugin in use (--store,
// CODING_SH_STORE_URL or the config's [store] index), the plugin migrates its own
// schema when it opens: the command says so, exits 0 and never touches index.db.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli } from "../query/_seed.ts";

const URL_ = ["postgres://user:", "hunter2", "@127.0.0.1:9/coding"].join("");

describe("upgrade-store with a store plugin", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  test("--store postgres://… --json: status plugin, no local path, no password", () => {
    const r = cli(["upgrade-store", "--store", URL_, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "plugin");
    assert.equal(j.scheme, "postgres");
    assert.ok(!r.stdout.includes(env.dataHome) && !r.stdout.includes("index.db"), r.stdout);
    assert.ok(!r.stdout.includes("hunter2") && !r.stderr.includes("hunter2"));
    assert.equal(existsSync(join(env.dataHome, "index.db")), false);
  });

  test("text output, and --restore, say the plugin migrates on open", () => {
    for (const args of [["upgrade-store", "--store", URL_], ["upgrade-store", "--restore", "--store", URL_]]) {
      const r = cli(args);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout + r.stderr, /postgres store.*migrates.*opens/i);
      assert.doesNotMatch(r.stdout + r.stderr, /index\.db|hunter2/);
    }
  });

  test("the config's [store] index counts too", () => {
    mkdirSync(env.dataHome, { recursive: true });
    writeFileSync(join(env.dataHome, "config.toml"), `[store]\nindex = "clickhouse://127.0.0.1:9"\n`);
    try {
      const r = cli(["upgrade-store", "--json"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).scheme, "clickhouse");
      assert.equal(existsSync(join(env.dataHome, "index.db")), false);
    } finally {
      rmSync(join(env.dataHome, "config.toml"));
    }
  });
});
