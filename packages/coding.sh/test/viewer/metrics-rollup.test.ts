// Metrics over top-level sessions (parentSessionId: null) add each subagent's
// spend to the session it ran under: no dollar is lost, and sessions counts
// top-level sessions. SQLite's metricRows, the scan and the memory store agree.
// A store with a --where compiler but no metricRows (the Postgres and ClickHouse
// plugins) pages querySessions, so event keys and bare words work there too.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore } from "../../src/core/types.ts";
import { parseWhere } from "../../src/query/where.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import * as metrics from "../../src/viewer/metrics.ts";
import { computeMetrics, DAY_MS, type MetricsSpec } from "../../src/viewer/metrics.ts";
import { event, session } from "../query/_seed.ts";

const T0 = Date.UTC(2026, 9, 7);
const H = 3_600_000;
const s = (id: string, hour: number, costUsd: number, over: Partial<Session> = {}): Session =>
  session(id, { startedAt: T0 + hour * H, endedAt: T0 + hour * H + 60_000, stats: { events: 2, turns: 1, toolCalls: 2, toolErrors: 1, filesChanged: 0, usage: { inputTokens: 100, outputTokens: 10, costUsd }, latency: { llmCalls: 3 } }, ...over });

// p: a parent at $0.10 with a subagent q at $0.02 (on another model) that has its own subagent r at $0.005.
// o: a subagent whose parent started before the range. x: a second top-level session.
const SESSIONS = [
  s("p", 1, 0.1, { model: "opus" }),
  s("q", 2, 0.02, { model: "haiku", parent: { sessionId: "p", type: "Explore" }, flags: ["no-verification"] }),
  s("r", 3, 0.005, { model: "haiku", parent: { sessionId: "q", type: "Explore" } }),
  s("o", 4, 0.3, { model: "haiku", parent: { sessionId: "before-the-range", type: "Explore" } }),
  s("x", 30, 1, { model: "opus", agent: "codex" }),
];
const TOP: MetricsSpec = { since: T0, until: T0 + 3 * DAY_MS, bucket: "day", filter: { parentSessionId: null } };

describe("metrics roll subagents up into their top-level session", () => {
  let dir: string;
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-rollup-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const st of [sqlite, memory]) {
      await st.putEvents([event("q", 1, { kind: "tool.end", payload: { tool: "Bash", ok: false } }), event("p", 1, { payload: { text: "deploy the docs" } })]);
      for (const x of SESSIONS) await st.upsertSession(x);
    }
  });
  after(async () => {
    await sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a $0.10 parent with a $0.02 subagent costs $0.12 and counts once", async () => {
    const m = await computeMetrics(sqlite, { ...TOP, until: T0 + DAY_MS, where: parseWhere("id:p,q") });
    assert.equal(m.totals.costUsd, 0.12);
    assert.equal(m.totals.sessions, 1);
    assert.equal(m.totals.toolCalls, 4);
    assert.equal(m.totals.llmCalls, 6);
  });

  test("totals equal the per-session view's, sessions count top-level ones, and an orphan stands alone", async () => {
    const all = await computeMetrics(sqlite, { ...TOP, filter: {} });
    const top = await computeMetrics(sqlite, TOP);
    assert.equal(top.totals.costUsd, all.totals.costUsd);
    assert.equal(top.totals.costUsd, 1.425);
    assert.equal(top.totals.tokens, all.totals.tokens);
    assert.equal(top.totals.toolCalls, all.totals.toolCalls);
    assert.equal(all.totals.sessions, 5);
    // p (with q and r), the orphan o, and x.
    assert.equal(top.totals.sessions, 3);
    // q's failure flag is a subagent's: failures count top-level sessions.
    assert.equal(top.totals.failures, 0);
    assert.equal(all.totals.failures, 1);
  });

  test("a subagent's spend goes to its top session's bucket and group", async () => {
    const m = await computeMetrics(sqlite, { ...TOP, by: "model" });
    const opus = m.series.find((x) => x.key === "opus")!;
    const haiku = m.series.find((x) => x.key === "haiku")!;
    assert.equal(opus.totals.costUsd, 1.125);
    assert.equal(opus.totals.sessions, 2);
    assert.deepEqual(opus.costUsd, [0.125, 1, 0]);
    // Only the orphan is left under haiku.
    assert.equal(haiku.totals.costUsd, 0.3);
    assert.equal(haiku.totals.sessions, 1);
  });

  test("SQLite, the scan and the memory store agree", async () => {
    for (const where of [undefined, parseWhere("agent:claude-code"), parseWhere("cost>0.01")]) {
      const spec: MetricsSpec = { ...TOP, by: "model" };
      if (where) spec.where = where;
      const viaSql = await computeMetrics(sqlite, spec);
      assert.deepEqual(await computeMetrics(sqlite, spec, { scan: true }), viaSql);
      assert.deepEqual(await computeMetrics(memory, spec), viaSql);
    }
  });

  test("rollUpSubagents survives a loop of parents", () => {
    const rows = metrics.rollUpSubagents([
      { id: "a", parentSessionId: "b", startedAt: 1, agent: "x", flags: [], toolCalls: 1, toolErrors: 0, costUsd: 1 },
      { id: "b", parentSessionId: "a", startedAt: 2, agent: "x", flags: [], toolCalls: 1, toolErrors: 0, costUsd: 2 },
    ]);
    assert.equal(rows.reduce((n, r) => n + (r.costUsd ?? 0), 0), 3);
  });

  test("a store with querySessions but no metricRows answers event keys and bare words", async () => {
    // What the Postgres and ClickHouse plugins look like to metrics: a --where compiler, no metricRows.
    const plugin = new Proxy(sqlite, {
      get(target, k) {
        if (k === "kind") return "plugin";
        if (k === "metricRows") return undefined;
        const v = Reflect.get(target, k, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as IndexStore;
    for (const q of ["tool:Bash", "ok:false", "kind:tool.end", "deploy", "-tool:Bash"]) {
      const spec: MetricsSpec = { ...TOP, where: parseWhere(q), filter: {} };
      assert.deepEqual(await computeMetrics(plugin, spec), await computeMetrics(sqlite, spec), q);
    }
  });
});

describe("top-level latency covers the subagents' model calls", () => {
  // An OpenInference or Agents SDK run: the root makes no model call, its subagent makes them all.
  const lat = (id: string, hour: number, latency: NonNullable<Session["stats"]["latency"]>, over: Partial<Session> = {}): Session =>
    session(id, { agent: "oi-app", startedAt: T0 + hour * H, endedAt: T0 + hour * H + 60_000, stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency }, ...over });
  const ROWS = [
    lat("root", 1, {}),
    lat("child", 1.5, { llmCalls: 1, llmP50Ms: 3000, llmP95Ms: 3000, ttftP50Ms: 1000 }, { parent: { sessionId: "root", type: "researcher" } }),
    lat("root2", 2, { llmCalls: 1, llmP50Ms: 5000, llmP95Ms: 5000, ttftP50Ms: 500 }),
    lat("child2", 2.5, { llmCalls: 4, llmP50Ms: 2000, llmP95Ms: 2000, ttftP50Ms: 300 }, { parent: { sessionId: "root2", type: "researcher" } }),
    lat("child3", 2.6, { llmCalls: 4, llmP50Ms: 2000, llmP95Ms: 2000, ttftP50Ms: 300 }, { parent: { sessionId: "root2", type: "researcher" } }),
  ];

  test("a root with no model calls of its own shows its subagent's p95 and TTFT", async () => {
    const store = new MemoryIndexStore();
    for (const x of ROWS.slice(0, 2)) await store.upsertSession(x);
    const m = await computeMetrics(store, { ...TOP, by: "agent" });
    assert.equal(m.totals.sessions, 1);
    assert.equal(m.totals.llmCalls, 1);
    assert.equal(m.totals.llmP95Ms, 3000);
    assert.equal(m.totals.ttftP50Ms, 1000);
    assert.equal(m.series[0]!.totals.llmP95Ms, 3000);
    assert.deepEqual(m.all.llmP95Ms, [3000, null, null]);
  });

  test("top-level latency equals the per-session view's", async () => {
    const store = new MemoryIndexStore();
    for (const x of ROWS) await store.upsertSession(x);
    const top = await computeMetrics(store, TOP);
    const all = await computeMetrics(store, { ...TOP, filter: {} });
    assert.equal(top.totals.sessions, 2);
    assert.equal(top.totals.llmP95Ms, all.totals.llmP95Ms);
    assert.equal(top.totals.ttftP50Ms, all.totals.ttftP50Ms);
    // The subagents' 300 ms TTFTs count, not only root2's own 500 ms.
    assert.equal(top.totals.ttftP50Ms, 300);
  });
});
