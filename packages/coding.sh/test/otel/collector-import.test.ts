// `coding.sh collector import --clickhouse`, run from source in a temp HOME /
// CODING_SH_HOME against the stub ClickHouse in _clickhouse.ts: --json prints
// one document (errors go to stderr), a second run imports nothing, --dry-run writes nothing, and a
// bad URL or bad credentials is an error with next steps. A run resumes at its own filter's cursor;
// --from-start or a --since on the command line reads from --since again.
// A run that stops part-way says how far it got, and the same command reads the rest.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { decodeTraceJson } from "../../src/otel/json.ts";
import type { ClickHouseSpanRow } from "../../src/otel/clickhouse.ts";
import { chatRows, type StubClickHouse, stubClickHouse, toRows } from "./_clickhouse.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
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

/** A temp HOME and CODING_SH_HOME under a new root. */
function tmpHome(): void {
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
}

describe("coding.sh collector import", () => {
  before(async () => {
    tmpHome();
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

// Regression: one cursor per table, and every run resumed from it. A run with no
// --where after a filtered one, and a run with --since, read only the hour before
// that cursor: 4 spans, 0 new.
describe("coding.sh collector import: the cursor", () => {
  const DAY_NS = 86_400_000_000_000n;
  const now = BigInt(Date.now()) * 1_000_000n;
  /** The rows with their first span `days` ago (inside the default --since 7d). */
  const aged = (name: string, days: bigint): ClickHouseSpanRow[] => {
    const src = toRows(decodeTraceJson(JSON.parse(readFileSync(new URL(`../fixtures/otel/${name}`, import.meta.url), "utf8"))), "map");
    const first = src.map((r) => BigInt(String(r.TimestampNs))).reduce((a, b) => (a < b ? a : b));
    return src.map((r) => ({ ...r, TimestampNs: String(BigInt(String(r.TimestampNs)) - first + now - days * DAY_NS) }));
  };
  const claude = aged("claude-code-traces.json", 3n);
  const vercel = aged("vercel-ai.json", 1n);
  const table = [...claude, ...vercel];
  const run = async (...args: string[]) => {
    const r = await cli(["collector", "import", "--clickhouse", ch.url, "--json", ...args]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout) as { spans: number; inserted: number; sessions: number; cursor: { ts: string } | null };
  };

  before(async () => {
    tmpHome();
    ch = await stubClickHouse({ rows: () => table, mode: () => "map", user: "otel", password: PASSWORD });
  });
  after(async () => {
    await ch.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a run without --where imports the rows a filtered run skipped, then resumes", async () => {
    const filtered = await run("--where", "ServiceName = 'my-vercel-app'");
    assert.equal(filtered.spans, vercel.length);
    assert.equal(filtered.sessions, 1);
    const unfiltered = await run();
    assert.equal(unfiltered.spans, table.length);
    assert.ok(unfiltered.inserted > 0, "the claude-code rows, two days behind the filtered run's cursor");
    assert.ok(unfiltered.sessions >= 1);
    const resumed = await run();
    assert.deepEqual([resumed.spans, resumed.inserted], [vercel.length, 0], "only the hour before the cursor is read again");
    assert.deepEqual(resumed.cursor, unfiltered.cursor);
  });

  it("--from-start and a --since on the command line read from --since again; the cursor stays", async () => {
    const saved = (await run()).cursor;
    const fromStart = await run("--from-start");
    assert.deepEqual([fromStart.spans, fromStart.inserted], [table.length, 0]);
    assert.deepEqual([(await run("--since", "5d")).spans, (await run("--since", "2d")).spans], [table.length, vercel.length]);
    assert.deepEqual([(await run("--from-start", "--since", "2d")).spans, (await run("--since", "2d", "--dry-run")).spans], [vercel.length, vercel.length]);
    const next = await run();
    assert.deepEqual([next.spans, next.cursor], [vercel.length, saved], "the next plain run resumes where the first one stopped");
  });
});

// Regression: a run that lost ClickHouse on a later page exited with "check the
// URL", its stored events had no sessions, and the next run exited 0 with fewer
// sessions than traces.
describe("coding.sh collector import: a run that stops part-way", () => {
  // 5,001 rows: two pages at the CLI's 5,000 a page, the last trace split over both.
  const table = chatRows(1667, 3, Date.now() - 3 * 86_400_000);
  const where = "ServiceName = 'chat-app'";
  const totals = async () => {
    const r = await cli(["stats", "--json", "--since", "7d"]);
    assert.equal(r.code, 0, r.stderr);
    return (JSON.parse(r.stdout) as { totals: { sessions: number; costUsd: number } }).totals;
  };

  before(async () => {
    tmpHome();
    // ClickHouse fails the first time page 2 is asked for, with an error a new try would get again.
    ch = await stubClickHouse({ rows: () => table, mode: () => "map", user: "otel", password: PASSWORD, fault: (select) => (select === 2 ? 500 : undefined) });
  });
  after(async () => {
    await ch.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("says how far it got and names the rerun, and the rerun finishes the job", async () => {
    const first = await cli(["collector", "import", "--clickhouse", ch.url, "--where", where, "--json"]);
    assert.equal(first.code, 1);
    assert.equal(first.stdout, "");
    const err = JSON.parse(first.stderr) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "clickhouse_error");
    assert.match(err.message, /^The import stopped after 5000 spans \(1667 sessions stored\): Code: 241\..*MEMORY_LIMIT_EXCEEDED/);
    assert.deepEqual(err.next, ["Run it again to read the rest (nothing is stored twice):", `coding.sh collector import --clickhouse ${ch.url} --where 'ServiceName = '\\''chat-app'\\'''`]);
    const partial = await totals();
    assert.equal(partial.sessions, 1667, "every stored span is in a session");

    const second = await cli(["collector", "import", "--clickhouse", ch.url, "--where", where, "--json"]);
    assert.equal(second.code, 0, second.stderr);
    const doc = JSON.parse(second.stdout) as { spans: number; inserted: number; sessions: number };
    assert.equal(doc.spans, table.length, "the hour before the cursor again, and the last row");
    assert.ok(doc.inserted > 0);
    assert.equal(doc.sessions, 1, "the trace that was split");
    const whole = await totals();
    assert.equal(whole.sessions, 1667, "one session per trace");
    assert.ok(Math.abs(whole.costUsd / partial.costUsd - 5001 / 5000) < 1e-9, "the last span's cost is in its session");
  });
});
