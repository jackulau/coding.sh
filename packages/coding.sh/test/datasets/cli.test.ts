// `coding.sh dataset add|import` end to end through the CLI: every case in a written
// version gets a split, so session-derived (labellable) cases reach
// split-filtered runs and `judge calibrate`. Temp HOME / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { splitFor } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Case } from "../../src/datasets/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { CLI as MAIN } from "../_cli.ts";

const SESSIONS = Array.from({ length: 8 }, (_, i) => `c0000000-0000-4000-8000-00000000000${i}`);

let root = "";
let env: Record<string, string> = {};

function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args, "--json"], { env, cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout) as { dataset: { id: string; version: string } };
}

async function cases(id: string): Promise<Case[]> {
  const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
  try {
    const ds = await new FileEvalStore({ env, index }).getDataset(id);
    assert.ok(ds, `dataset ${id} missing`);
    return ds.cases;
  } finally {
    await index.close();
  }
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-ds-cli-")));
  const home = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(home);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    PATH: dirname(process.execPath),
    NO_COLOR: "1",
  };
  mkdirSync(env.CODING_SH_HOME!, { recursive: true });
  const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
  try {
    for (const [i, id] of SESSIONS.entries()) {
      const session: Session = {
        id,
        agent: "claude-code",
        startedAt: 1_700_000_000_000 + i * 60_000,
        stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
        flags: [],
      };
      const ev = (n: number, kind: AgentEvent["kind"], text: string): AgentEvent => ({
        id: `${id}-e${n}`,
        v: 0,
        sessionId: id,
        ts: session.startedAt + n,
        agent: "claude-code",
        kind,
        payload: { text },
      });
      await index.upsertSession(session);
      await index.putEvents([ev(1, "user.message", `question ${i}`), ev(2, "assistant.message", `answer ${i}`)]);
    }
  } finally {
    await index.close();
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("dataset add/import assign splits", () => {
  it("session-derived cases get the deterministic hash split", async () => {
    cli(["dataset", "add", "qs", ...SESSIONS.flatMap((s) => ["--session", s])]);
    const got = await cases("qs");
    assert.equal(got.length, 8);
    for (const c of got) {
      assert.ok(c.sourceSessionId, "case keeps its session");
      assert.equal(c.split, splitFor(c.id), `case ${c.id} has the hash split`);
    }
  });

  it("--split pins the added cases; a split in the case JSON wins", async () => {
    cli(["dataset", "add", "pinned", "--split", "test", "--session", SESSIONS[0]!, "--case", '{"input":"a"}', "--case", '{"input":"b","split":"train"}']);
    const got = await cases("pinned");
    assert.deepEqual(got.map((c) => [c.input, c.split]).sort(), [["a", "test"], ["b", "train"], ["question 0", "test"]]);
    // Adding more later never reshuffles the pinned cases.
    cli(["dataset", "add", "pinned", "--case", '{"input":"c"}']);
    const more = await cases("pinned");
    assert.equal(more.find((c) => c.input === "question 0")?.split, "test");
    assert.equal(more.find((c) => c.input === "c")?.split, splitFor(more.find((c) => c.input === "c")!.id));
  });

  it("import fills missing splits and keeps explicit ones", async () => {
    const file = join(root, "imp.jsonl");
    writeFileSync(file, '{"id":"x","input":"x"}\n{"id":"y","input":"y","split":"test"}\n');
    cli(["dataset", "import", file]);
    const got = await cases("imp");
    assert.deepEqual(Object.fromEntries(got.map((c) => [c.id, c.split])), { x: splitFor("x"), y: "test" });
  });
});

describe("dataset files Windows PowerShell wrote", () => {
  // `>` and Out-File write UTF-16LE with a byte order mark; Out-File -Encoding utf8 writes UTF-8 with one.
  const utf16 = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  const utf8Bom = (s: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")]);

  it("import reads a JSONL file in UTF-16 or in UTF-8 with a byte order mark", async () => {
    const wide = join(root, "ps16.jsonl");
    writeFileSync(wide, utf16('{"id":"p","input":"café"}\r\n{"id":"q","input":"q"}\r\n'));
    cli(["dataset", "import", wide]);
    assert.deepEqual((await cases("ps16")).map((c) => [c.id, c.input]).sort(), [["p", "café"], ["q", "q"]]);
    const marked = join(root, "ps8.jsonl");
    writeFileSync(marked, utf8Bom('{"id":"r","input":"r"}\r\n'));
    cli(["dataset", "import", marked]);
    assert.deepEqual((await cases("ps8")).map((c) => c.id), ["r"]);
  });

  it("--case reads a JSON file in either encoding", async () => {
    const wide = join(root, "case16.json");
    writeFileSync(wide, utf16('{"input":"from utf-16"}\r\n'));
    const marked = join(root, "case8.json");
    writeFileSync(marked, utf8Bom('{"input":"from utf-8"}\r\n'));
    cli(["dataset", "add", "pscase", "--case", wide, "--case", marked]);
    assert.deepEqual((await cases("pscase")).map((c) => c.input).sort(), ["from utf-16", "from utf-8"]);
  });
});

describe("dataset add --case <JSON|FILE>", () => {
  it("reads a case from a JSON file as well as inline JSON, and help says so", async () => {
    writeFileSync(join(root, "case.json"), '{"input":"2+2","expected":"4"}\n');
    cli(["dataset", "add", "fromfile", "--case", "case.json", "--case", '{"input":"3+3","expected":"6"}']);
    assert.deepEqual((await cases("fromfile")).map((c) => [c.input, c.expected]).sort(), [["2+2", "4"], ["3+3", "6"]]);
    const help = spawnSync(process.execPath, ["--no-warnings", MAIN, "dataset", "add", "--help"], { env, cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.match(help.stdout, /--case <JSON\|FILE> +Case as JSON or a JSON file/);
  });
});

describe("dataset add/import with case kinds (TB-12)", () => {
  it("--kind marks the added cases; a kind in the case JSON wins; the summary counts kinds", async () => {
    const out = cli(["dataset", "add", "fix", "--kind", "control", "--session", SESSIONS[1]!, "--case", '{"input":"a"}', "--case", '{"input":"b","kind":"bad"}']) as unknown as { dataset: { kinds?: Record<string, number> } };
    assert.deepEqual(out.dataset.kinds, { control: 2, bad: 1 });
    const got = await cases("fix");
    assert.deepEqual(got.map((c) => [c.input, c.kind]).sort(), [["a", "control"], ["b", "bad"], ["question 1", "control"]]);
    const plain = cli(["dataset", "add", "nokind", "--case", '{"input":"a"}']) as unknown as { dataset: Record<string, unknown> };
    assert.equal("kinds" in plain.dataset, false);
  });

  it("import keeps kinds and refuses an unknown one", async () => {
    const file = join(root, "kinds.jsonl");
    writeFileSync(file, '{"id":"g","input":"g","kind":"guard"}\n{"id":"o","input":"o"}\n');
    cli(["dataset", "import", file]);
    assert.deepEqual(Object.fromEntries((await cases("kinds")).map((c) => [c.id, c.kind ?? null])), { g: "guard", o: null });
    const bad = join(root, "bogus.jsonl");
    writeFileSync(bad, '{"input":"x","kind":"regression"}\n');
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "dataset", "import", bad, "--json"], { env, cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /case 1: \\"kind\\" must be one of bad, guard, control/);
  });
});
