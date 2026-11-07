// coding.sh export: JSONL round trip, CSV quoting, the sessions filters, labels, paging and memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { csvCell } from "../../src/query/csv.ts";
import { CSV_COLUMNS, exportRows } from "../../src/query/export.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { CLI, event, ok, seed, session, T0 } from "./_seed.ts";

let env: TmpEnv;
const sessions: Session[] = [
  session("s1", { flags: ["looping"] }),
  session("s2", { agent: "codex", startedAt: T0 + 3600_000, title: '=cmd|" /C calc"!A0, then\nmore' }),
  session("c1", { parent: { sessionId: "s1" }, startedAt: T0 + 10 }),
];
const events: AgentEvent[] = [event("s1", 1), event("s1", 2, { kind: "tool.start", payload: { tool: "Bash", command: "echo a,b" } }), event("s2", 1), event("c1", 1)];

before(async () => {
  env = tmpEnv();
  await seed(env.dataHome, {
    sessions,
    events,
    labels: [
      { id: "l1", sessionId: "s1", criterion: "outcome", value: "fail", note: "looped", by: "me", ts: T0 },
      { id: "l2", sessionId: "s2", criterion: "outcome", value: "pass", by: "me", ts: T0 },
    ],
  });
});
after(() => env.restore());

const jsonl = (s: string) => s.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("csvCell", () => {
  test("quotes commas, quotes and newlines; neutralises formulas; leaves numbers", () => {
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("one\ntwo"), '"one\ntwo"');
    assert.equal(csvCell("=1+2"), "'=1+2");
    assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(csvCell(-3), "-3");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(true), "true");
    assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  });
});

describe("coding.sh export", () => {
  test("sessions JSONL round-trips the stored objects, top-level only by default", () => {
    const rows = jsonl(ok(["export", "sessions"]).stdout);
    assert.deepEqual(rows.map((r) => r.id), ["s2", "s1"]);
    assert.deepEqual(rows[1], sessions[0]);
  });

  test("--subagents, --agent, --flag, --since and --limit filter as in sessions", () => {
    assert.deepEqual(jsonl(ok(["export", "sessions", "--subagents"]).stdout).map((r) => r.id), ["s2", "c1", "s1"]);
    assert.deepEqual(jsonl(ok(["export", "sessions", "--agent", "codex"]).stdout).map((r) => r.id), ["s2"]);
    assert.deepEqual(jsonl(ok(["export", "sessions", "--flag", "looping"]).stdout).map((r) => r.id), ["s1"]);
    assert.deepEqual(jsonl(ok(["export", "sessions", "--since", "2026-11-01T10:30:00Z"]).stdout).map((r) => r.id), ["s2"]);
    assert.deepEqual(jsonl(ok(["export", "sessions", "--limit", "1"]).stdout).map((r) => r.id), ["s2"]);
  });

  test("sessions CSV: header, quoting and a neutralised formula title", () => {
    const out = ok(["export", "sessions", "--format", "csv", "--agent", "codex"]).stdout;
    assert.ok(out.startsWith(CSV_COLUMNS.sessions.join(",") + "\r\n"));
    assert.ok(out.includes(`"'=cmd|"" /C calc""!A0, then\nmore"`), out);
  });

  test("events JSONL holds every event of the matching sessions", () => {
    const rows = jsonl(ok(["export", "events", "--agent", "claude-code"]).stdout);
    assert.deepEqual(rows.map((r) => r.id), ["s1-e1", "s1-e2"]);
    assert.deepEqual((rows[1]!.payload as Record<string, unknown>).command, "echo a,b");
  });

  test("events CSV puts the payload in a JSON column", () => {
    const lines = ok(["export", "events", "--format", "csv", "--agent", "claude-code"]).stdout.split("\r\n");
    assert.equal(lines[0], CSV_COLUMNS.events.join(","));
    assert.match(lines[2]!, /^s1-e2,s1,2026-11-01T10:00:02.000Z,tool.start,claude-code,,Bash,,/);
    assert.ok(lines[2]!.endsWith(`"{""tool"":""Bash"",""command"":""echo a,b""}"`), lines[2]);
  });

  test("labels: all of them unfiltered, those of the matching sessions with a filter", () => {
    assert.deepEqual(jsonl(ok(["export", "labels"]).stdout).map((r) => r.id).sort(), ["l1", "l2"]);
    assert.deepEqual(jsonl(ok(["export", "labels", "--agent", "codex"]).stdout).map((r) => r.id), ["l2"]);
    const csv = ok(["export", "labels", "--format", "csv", "--agent", "claude-code"]).stdout;
    assert.equal(csv, `${CSV_COLUMNS.labels.join(",")}\r\nl1,s1,,outcome,fail,looped,me,2026-11-01T10:00:00.000Z\r\n`);
  });

  test("a bad kind or format exits 2", () => {
    const r1 = spawnSync(process.execPath, ["--no-warnings", CLI, "export", "nope"], { env: process.env, encoding: "utf8" });
    assert.equal(r1.status, 2);
    const r2 = spawnSync(process.execPath, ["--no-warnings", CLI, "export", "sessions", "--format", "xml"], { env: process.env, encoding: "utf8" });
    assert.equal(r2.status, 2);
  });
});

describe("exportRows", () => {
  test("pages through sessions and events without skipping or repeating", async () => {
    const store = new MemoryIndexStore();
    const ss = Array.from({ length: 7 }, (_, i) => session(`p${i}`, { startedAt: T0 + i }));
    for (const s of ss) await store.upsertSession(s);
    await store.putEvents(ss.flatMap((s) => Array.from({ length: 5 }, (_, n) => event(s.id, n))));
    let text = "";
    const r = await exportRows(store, "events", { filter: {}, format: "jsonl", pageSize: 2, write: (c) => void (text += c) });
    assert.equal(r.rows, 35);
    assert.equal(new Set(jsonl(text).map((e) => e.id)).size, 35);
  });

  test("100k events (40+ MB) stream with flat memory", { timeout: 120_000 }, async () => {
    // A child process so the measurement is not this test runner's heap. Loading TypeScript from
    // source costs ~40 MB of RSS by itself, so the bound is on growth past the loaded baseline.
    const script = `
      import { exportRows } from ${JSON.stringify(new URL("../../src/query/export.ts", import.meta.url).href)};
      const sessions = 100, per = 1000;
      const store = {
        async listSessions(f) { const out = []; for (let i = f.offset; i < Math.min(sessions, f.offset + f.limit); i++) out.push({ id: "s" + i, agent: "a", startedAt: i, stats: {}, flags: [] }); return out; },
        async listEvents(id, o) { const out = []; for (let n = o.offset; n < Math.min(per, o.offset + o.limit); n++) out.push({ id: id + "-" + n, v: 0, sessionId: id, ts: n, agent: "a", kind: "tool.end", payload: { tool: "Bash", output: "x".repeat(400) } }); return out; },
      };
      const base = process.memoryUsage().rss;
      let peak = 0, bytes = 0;
      const r = await exportRows(store, "events", { filter: {}, format: "jsonl", write: (c) => { bytes += c.length; if (bytes % 1000 < 600) peak = Math.max(peak, process.memoryUsage().rss); } });
      peak = Math.max(peak, process.memoryUsage().rss);
      console.log(JSON.stringify({ rows: r.rows, growth: peak - base, bytes }));
    `;
    const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const { rows, growth, bytes } = JSON.parse(r.stdout) as { rows: number; growth: number; bytes: number };
    assert.equal(rows, 100_000);
    assert.ok(bytes > 40e6, `exported ${bytes} bytes`);
    assert.ok(growth < 64 * 1024 * 1024, `RSS grew ${Math.round(growth / 1048576)} MB`);
  });
});
