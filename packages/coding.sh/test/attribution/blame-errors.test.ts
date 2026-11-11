// blame checks the path and the line range itself and fails with a reason and a next step,
// not a raw "git blame ...: exit 128".
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { main } from "../../src/cli/main.ts";
import { openContext } from "../../src/core/context.ts";
import { isolate, removeTmp, tmp } from "../capture/_helpers.ts";
import { buildFixture, type Fixture } from "./_fixture.ts";

let fx: Fixture;
let env: NodeJS.ProcessEnv;
const cwd = process.cwd();

before(async () => {
  isolate();
  fx = await buildFixture();
  const home = tmp("csh-blame-home-");
  mkdirSync(join(home, "codex"), { recursive: true });
  env = { ...process.env, ["HO" + "ME"]: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
  const ctx = await openContext({ env, cwd: fx.root });
  try {
    for (const s of Object.values(fx.sessions)) await ctx.index.upsertSession(s);
  } finally {
    await ctx.close();
  }
  process.chdir(fx.root);
});
after(() => {
  process.chdir(cwd);
  removeTmp();
});

async function blame(target: string): Promise<{ status: number; err: { reason: string; message: string; next: string[] } }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
  try {
    const status = await main(["blame", target, "--json"], env);
    return { status, err: JSON.parse(stderr.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}") };
  } finally {
    process.stderr.write = write;
  }
}

describe("blame errors", () => {
  test("line 0 is a usage error", async () => {
    const r = await blame("src/math.ts:0");
    assert.equal(r.status, 2);
    assert.match(r.err.message, /line numbers start at 1/);
    assert.equal(r.err.next.length, 2);
  });
  test("a range that ends before it starts is a usage error", async () => {
    const r = await blame("src/math.ts:9-3");
    assert.equal(r.status, 2);
    assert.match(r.err.message, /ends before it starts/);
  });
  test("a range past the end of the file is not_found with the file's length", async () => {
    const r = await blame("src/math.ts:900-905");
    assert.equal(r.status, 1);
    assert.equal(r.err.reason, "not_found");
    assert.match(r.err.message, /^src\/math\.ts has \d+ lines at [0-9a-f]{8}; ask for lines 1-\d+$/);
    assert.doesNotMatch(r.err.message, /git |exit 128|fatal/);
    assert.deepEqual(r.err.next, ["Blame the whole file:", "coding.sh blame src/math.ts"]);
  });
  test("a path git does not know is not_found with a next step", async () => {
    const r = await blame("src/nope.ts");
    assert.equal(r.status, 1);
    assert.equal(r.err.reason, "not_found");
    assert.match(r.err.message, /^src\/nope\.ts is not in [0-9a-f]{8}$/);
    assert.deepEqual(r.err.next, ["See the files git tracks:", "git ls-files"]);
  });
});
