// Where the store came from decides what to check when it does not open: --store and
// CODING_SH_STORE_URL name a URL, the config file names a [store] section. A read
// (create: false) through --store or the env var never creates a new SQLite file.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as context from "../../src/core/context.ts";

const root = mkdtempSync(join(tmpdir(), "csh-ctx-store-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("the store-open hint follows the store's source", () => {
  it("--store or CODING_SH_STORE_URL: check that URL; else the config's [store] section", () => {
    const next = (context as { storeOpenNext?: (env: NodeJS.ProcessEnv) => string[] }).storeOpenNext;
    assert.equal(typeof next, "function", "context.ts exports storeOpenNext");
    const viaEnv = next!({ CODING_SH_STORE_URL: "postgres://user:secret@db.example/x" });
    assert.match(viaEnv.join(" "), /--store/);
    assert.match(viaEnv.join(" "), /CODING_SH_STORE_URL/);
    assert.doesNotMatch(viaEnv.join(" "), /secret|config path/, "never echoes the URL, never points at the config");
    assert.deepEqual(next!({}), ["Check the [store] section of the config:", "coding.sh config path"]);
    assert.deepEqual(next!({ CODING_SH_STORE_URL: "  " }), next!({}), "a blank value is no override");
  });
});

describe("a read through --store does not create a store", () => {
  it("a typo'd sqlite path throws StoreMissingError and leaves no file", async () => {
    const typo = join(root, "typo", "indx.db");
    const env = { HOME: root, CODING_SH_HOME: join(root, "home"), CODING_SH_STORE_URL: `sqlite://${typo}` };
    await assert.rejects(context.openContext({ env, create: false } as context.OpenContextOptions), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, "StoreMissingError");
      assert.match(e.message, /indx\.db/);
      assert.match((e as { next?: string[] }).next?.join(" ") ?? "", /--store/);
      return true;
    });
    assert.equal(existsSync(typo), false);
    assert.equal(existsSync(join(root, "typo")), false, "not even its folder");
  });

  it("an existing file opens, memory:// opens, and create (the default) still makes the file", async () => {
    const db = join(root, "made.db");
    const env = { HOME: root, CODING_SH_HOME: join(root, "home"), CODING_SH_STORE_URL: `sqlite://${db}` };
    await (await context.openContext({ env })).close();
    assert.ok(existsSync(db));
    await (await context.openContext({ env, create: false } as context.OpenContextOptions)).close();
    await (await context.openContext({ env: { ...env, CODING_SH_STORE_URL: "sqlite://:memory:" }, create: false } as context.OpenContextOptions)).close();
  });
});
