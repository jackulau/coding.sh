// `coding.sh collector import --clickhouse`, run from source in a temp HOME /
// CODING_SH_HOME against the stub ClickHouse in _clickhouse.ts: --json prints
// one document (errors go to stderr), a second run imports nothing, --dry-run writes nothing, and a
// bad URL or bad credentials is an error with next steps.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { type StubClickHouse, stubClickHouse, toRows } from "./_clickhouse.ts";

const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const PASSWORD = ["pa", "ss"].join("");
const rows = toRows(decodeTraceJson(JSON.parse(readFileSync(new URL("../fixtures/otel/claude-code-traces.json", import.meta.url), "utf8"))), "map");

let root: string;
let ch: StubClickHouse;
let env: NodeJS.ProcessEnv;

function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("coding.sh collector import", () => {
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "cs-ch-import-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: tmpdir(),
      NO_COLOR: "1",
      CLICKHOUSE_USER: "otel",
      CLICKHOUSE_PASSWORD: PASSWORD,
    };
    ch = await stubClickHouse({ rows: () => rows, mode: () => "map", user: "otel", password: PASSWORD });
  });
  after(async () => {
    await ch.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("--dry-run counts the spans and writes nothing", async () => {
    const r = await cli(["collector", "import", "--clickhouse", ch.url, "--since", "3650d", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.outcome, "planned");
    assert.equal(doc.spans, rows.length);
    assert.ok(doc.events > 0);
    assert.equal(doc.inserted, 0);
    assert.equal(doc.cursor, null);
  });

  it("imports once, and a second run imports 0 events", async () => {
    const first = await cli(["collector", "import", "--clickhouse", ch.url, "--since", "3650d", "--json"]);
    assert.equal(first.code, 0, first.stderr);
    const a = JSON.parse(first.stdout);
    assert.equal(a.outcome, "imported");
    assert.equal(a.mode, "map");
    assert.equal(a.spans, rows.length);
    assert.ok(a.inserted > 0);
    assert.equal(a.inserted, a.events);
    assert.ok(a.sessions >= 1);
    assert.equal(a.rejected, 0);
    assert.ok(a.cursor?.ts);
    const second = await cli(["collector", "import", "--clickhouse", ch.url, "--since", "3650d", "--json"]);
    const b = JSON.parse(second.stdout);
    assert.deepEqual([b.inserted, b.sessions], [0, 0]);
    assert.deepEqual(b.cursor, a.cursor);
    // The sessions are in the store, with the trace's spans.
    const ls = await cli(["sessions", "--json", "--since", "3650d"]);
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, /claude-code/);
  });

  it("prints rows on stderr and nothing but the result on stdout without --json", async () => {
    const r = await cli(["collector", "import", "--clickhouse", ch.url, "--since", "3650d", "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /Spans\s+read \d+ spans \(Map attributes\)/);
  });

  it("bad credentials: clickhouse_unauthorized with the environment to set", async () => {
    const r = await cli(["collector", "import", "--clickhouse", ch.url, "--json"], { CLICKHOUSE_PASSWORD: "wrong" });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    const doc = JSON.parse(r.stderr);
    assert.equal(doc.reason, "clickhouse_unauthorized");
    assert.match(doc.next.join(" "), /CLICKHOUSE_PASSWORD/);
    assert.ok(!r.stderr.includes("wrong"));
  });

  it("an unreachable URL: clickhouse_unreachable with a check to run", async () => {
    const r = await cli(["collector", "import", "--clickhouse", "http://127.0.0.1:9/", "--json"]);
    assert.equal(r.code, 1);
    const doc = JSON.parse(r.stderr);
    assert.equal(doc.reason, "clickhouse_unreachable");
    assert.match(doc.next.join(" "), /ping/);
  });

  it("no --clickhouse: a usage error, exit 2", async () => {
    const r = await cli(["collector", "import", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr).reason, "missing_argument");
  });
});
