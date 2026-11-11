// `coding.sh dataset add` run by several processes at once keeps every case: each
// write names the version it read (putDataset's parent), a writer that lost the race
// reads the new latest and merges again. An empty import exits 1 and writes nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { cli } from "../query/_seed.ts";

// By name, as the CLI matches it (a plugin's bundled copy counts too).
const conflict = (e: unknown) => e instanceof Error && e.name === "DatasetConflict";
const MAIN = join(dirname(fileURLToPath(import.meta.url)), "../../src/cli/main.ts");
const N = 8;

let root = "";
let env: NodeJS.ProcessEnv = {};

let SLOW_READ: string[] = [];

function run(args: string[], preload: string[] = []): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ["--no-warnings", ...preload, MAIN, ...args, "--json"], { env, cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b));
    p.on("close", (status) => done({ status, stderr }));
  });
}

async function cases(id: string): Promise<string[]> {
  const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
  try {
    return ((await new FileEvalStore({ env, index }).getDataset(id))?.cases ?? []).map((c) => String(c.input)).sort();
  } finally {
    await index.close();
  }
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-ds-race-")));
  const home = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(home);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    PATH: dirname(process.execPath),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
  };
  // Preloaded into the CLI: the index's getDataset resolves 300 ms after it reads.
  const slow = join(root, "slow-read.mjs");
  const sqlite = pathToFileURL(join(dirname(MAIN), "../store/sqlite.ts")).href;
  writeFileSync(slow, `import { SqliteIndexStore } from ${JSON.stringify(sqlite)};
const get = SqliteIndexStore.prototype.getDataset;
SqliteIndexStore.prototype.getDataset = async function (...a) { const ds = await get.apply(this, a); await new Promise((r) => setTimeout(r, 300)); return ds; };
`);
  SLOW_READ = ["--import", pathToFileURL(slow).href];
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("dataset add from several processes at once", () => {
  test(`${N} parallel adds to a seeded dataset keep all ${N + 1} cases`, async () => {
    const seed = await run(["dataset", "add", "race", "--case", '{"input":"seed"}']);
    assert.equal(seed.status, 0, seed.stderr);
    // Every add reads the dataset, then waits before it writes, so the writes overlap on every run.
    const runs = await Promise.all(Array.from({ length: N }, (_, i) => run(["dataset", "add", "race", "--case", JSON.stringify({ input: `case ${i}` })], SLOW_READ)));
    for (const r of runs) assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await cases("race"), ["seed", ...Array.from({ length: N }, (_, i) => `case ${i}`)].sort());
  });

  test("an empty import exits 1 and creates no dataset", async () => {
    const file = join(root, "empty.jsonl");
    writeFileSync(file, "");
    const r = cli(["dataset", "import", file, "--name", "nothing"], env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no cases/);
    assert.deepEqual(await cases("nothing"), []);
    const list = cli(["dataset", "list", "--json"], env);
    assert.ok(!list.stdout.includes('"nothing"'), list.stdout);
  });
});

describe("putDataset with a parent writes only over the version it read", () => {
  const one = createDataset({ name: "p", cases: [{ input: "a" }] });
  const two = createDataset({ name: "p", cases: [{ input: "a" }, { input: "b" }] });
  const stores = {
    sqlite: async () => SqliteIndexStore.open(":memory:"),
    memory: async () => new MemoryIndexStore(),
    files: async () => new FileEvalStore({ env: { ...env, CODING_SH_HOME: mkdtempSync(join(root, "files-")) } }),
  };
  for (const [name, open] of Object.entries(stores)) {
    test(name, async () => {
      const st = await open();
      await st.putDataset!(one, { parent: null });
      await assert.rejects(st.putDataset!(two, { parent: null }), conflict);
      assert.equal((await st.getDataset!("p"))?.version, one.version, "a refused write leaves latest alone");
      await st.putDataset!(two, { parent: one.version });
      assert.equal((await st.getDataset!("p"))?.version, two.version);
      await assert.rejects(st.putDataset!(one, { parent: one.version }), conflict);
      // No parent: last writer wins, as before.
      await st.putDataset!(one);
      assert.equal((await st.getDataset!("p"))?.version, one.version);
    });
  }
});
