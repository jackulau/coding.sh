// Score time-series and group breakdowns (`measure=score:<name>`) in
// src/viewer/metrics.ts and GET /api/metrics.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore, Score } from "../../src/core/types.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { computeMetrics, DAY_MS, MetricsError, type MetricsSpec } from "../../src/viewer/metrics.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { session } from "../query/_seed.ts";
import { FakeBlobs } from "./fakes.ts";

const T0 = Date.UTC(2026, 9, 7);
const H = 3_600_000;

const SESSIONS: Session[] = [
  session("s1", { agent: "claude-code", model: "claude-opus-5-5", startedAt: T0 + H, endedAt: T0 + 2 * H, repo: { root: "/work/alpha", head: "a" }, flags: ["looping"] }),
  session("s2", { agent: "codex", model: "gpt-6.1-sol", startedAt: T0 + 3 * H, endedAt: T0 + 4 * H, repo: { root: "/work/beta", head: "b" } }),
  session("s3", { agent: "claude-code", model: "claude-opus-5-5", startedAt: T0 + 2 * DAY_MS + H, endedAt: T0 + 2 * DAY_MS + 2 * H, repo: { root: "/work/alpha", head: "a" } }),
  session("s4", { agent: "codex", model: "gpt-6.1-sol", startedAt: T0 + 2 * DAY_MS + 2 * H, endedAt: T0 + 2 * DAY_MS + 3 * H, repo: { root: "/work/beta", head: "b" } }),
  session("sub1", { agent: "claude-code", model: "claude-haiku-4-5", startedAt: T0 + 2 * H, endedAt: T0 + 2 * H + 1000, parent: { sessionId: "s1", type: "Explore" } }),
];

const SCORES: Score[] = [
  // Numeric scores on s1 (day 0) and s3 (day 2)
  { id: "h1", target: "session", targetId: "s1", sessionId: "s1", name: "helpfulness", dataType: "numeric", value: 4, source: "judge", by: "judge", ts: T0 + 2 * H },
  { id: "h2", target: "session", targetId: "s1", sessionId: "s1", name: "helpfulness", dataType: "numeric", value: 5, source: "human", by: "me", ts: T0 + 2 * H + 10 },
  // Categorical and text scores with the same name must be ignored
  { id: "h-cat", target: "session", targetId: "s1", sessionId: "s1", name: "helpfulness", dataType: "categorical", value: "great", source: "human", by: "other", ts: T0 + 2 * H + 20 },
  { id: "h-txt", target: "session", targetId: "s2", sessionId: "s2", name: "helpfulness", dataType: "text", value: "not a number", source: "human", by: "other", ts: T0 + 4 * H },
  // Numeric on s2 (day 0) and s3/s4 (day 2)
  { id: "h3", target: "session", targetId: "s2", sessionId: "s2", name: "helpfulness", dataType: "numeric", value: 2, source: "judge", by: "judge", ts: T0 + 4 * H },
  { id: "h4", target: "session", targetId: "s3", sessionId: "s3", name: "helpfulness", dataType: "numeric", value: 3, source: "judge", by: "judge", ts: T0 + 2 * DAY_MS + 2 * H },
  // Subagent score (counts only when scope=all)
  { id: "h-sub", target: "session", targetId: "sub1", sessionId: "sub1", name: "helpfulness", dataType: "numeric", value: 1, source: "judge", by: "judge", ts: T0 + 2 * H + 5000 },
  // Boolean scores: true -> 1, false -> 0
  { id: "o1", target: "session", targetId: "s1", sessionId: "s1", name: "outcome", dataType: "boolean", value: true, source: "human", by: "me", ts: T0 + 2 * H },
  { id: "o2", target: "session", targetId: "s2", sessionId: "s2", name: "outcome", dataType: "boolean", value: false, source: "human", by: "me", ts: T0 + 4 * H },
  { id: "o3", target: "session", targetId: "s3", sessionId: "s3", name: "outcome", dataType: "boolean", value: true, source: "human", by: "me", ts: T0 + 2 * DAY_MS + 2 * H },
  // Categorical-only score name
  { id: "c1", target: "session", targetId: "s1", sessionId: "s1", name: "style", dataType: "categorical", value: "terse", source: "human", by: "me", ts: T0 + 2 * H },
  // Negative numeric score
  { id: "d1", target: "session", targetId: "s1", sessionId: "s1", name: "delta", dataType: "numeric", value: -2, source: "code", by: "check", ts: T0 + 2 * H },
  { id: "d2", target: "session", targetId: "s2", sessionId: "s2", name: "delta", dataType: "numeric", value: 1, source: "code", by: "check", ts: T0 + 4 * H },
];

describe("metrics score:<name> engine", () => {
  let dir: string;
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();
  const SPEC: MetricsSpec = { since: T0, until: T0 + 3 * DAY_MS, bucket: "day", filter: { parentSessionId: null } };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-metrics-scores-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const st of [sqlite, memory]) {
      for (const s of SESSIONS) await st.upsertSession(s);
      for (const sc of SCORES) await st.putScore(sc);
    }
  });

  after(async () => {
    await sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("SQLite, scan fallback, and memory agree on numeric score buckets and groups", async () => {
    for (const by of [undefined, "agent", "model", "repo", "flag"] as const) {
      const spec: MetricsSpec = { ...SPEC, measure: "score:helpfulness" };
      if (by) spec.by = by;
      const viaSql = await computeMetrics(sqlite, spec);
      const viaScan = await computeMetrics(sqlite, spec, { scan: true });
      const viaMem = await computeMetrics(memory, spec);
      assert.deepEqual(viaScan, viaSql, `scan vs sql (${by ?? "none"})`);
      assert.deepEqual(viaMem, viaSql, `memory vs sql (${by ?? "none"})`);
    }
  });

  test("computes bucketed mean and ignores categorical/text scores", async () => {
    const m = await computeMetrics(sqlite, { ...SPEC, measure: "score:helpfulness", by: "agent" });
    assert.equal(m.measure, "score:helpfulness");
    // Top-level scores: day 0 has s1(4, 5) + s2(2) => sum 11, n=3, mean 3.666667; day 1 empty; day 2 has s3(3) => mean 3
    assert.equal(m.totals.scoreCount, 4);
    assert.equal(m.totals.scoreMean, 3.5);
    assert.deepEqual(m.all.scoreCount, [3, 0, 1]);
    assert.deepEqual(m.all.scoreMean, [3.666667, null, 3]);

    const claude = m.series.find((x) => x.key === "claude-code")!;
    assert.equal(claude.totals.scoreCount, 3);
    assert.equal(claude.totals.scoreMean, 4);
    assert.deepEqual(claude.scoreMean, [4.5, null, 3]);
    assert.deepEqual(claude.scoreCount, [2, 0, 1]);

    const codex = m.series.find((x) => x.key === "codex")!;
    assert.equal(codex.totals.scoreCount, 1);
    assert.equal(codex.totals.scoreMean, 2);
    assert.deepEqual(codex.scoreMean, [2, null, null]);
    assert.deepEqual(codex.scoreCount, [1, 0, 0]);
  });

  test("boolean scores map true=1 and false=0; negative scores average cleanly", async () => {
    const bools = await computeMetrics(sqlite, { ...SPEC, measure: "score:outcome", by: "repo" });
    // Day 0: s1(1), s2(0) -> 0.5; Day 1: null; Day 2: s3(1) -> 1; Total: 2/3
    assert.equal(bools.totals.scoreCount, 3);
    assert.equal(bools.totals.scoreMean, 0.666667);
    assert.deepEqual(bools.all.scoreMean, [0.5, null, 1]);
    assert.equal(bools.series.find((x) => x.key === "alpha")!.totals.scoreMean, 1);
    assert.equal(bools.series.find((x) => x.key === "beta")!.totals.scoreMean, 0);

    const neg = await computeMetrics(sqlite, { ...SPEC, measure: "score:delta" });
    assert.equal(neg.totals.scoreCount, 2);
    assert.equal(neg.totals.scoreMean, -0.5);
    assert.deepEqual(neg.all.scoreMean, [-0.5, null, null]);
  });

  test("categorical-only or unknown score name reports 0 count and null buckets", async () => {
    for (const name of ["style", "missing-score"]) {
      const m = await computeMetrics(sqlite, { ...SPEC, measure: `score:${name}` });
      assert.equal(m.totals.scoreCount, 0);
      assert.equal(m.totals.scoreMean, undefined);
      assert.deepEqual(m.all.scoreMean, [null, null, null]);
      assert.deepEqual(m.all.scoreCount, [0, 0, 0]);
    }
  });

  test("rejects invalid score measure names", async () => {
    await assert.rejects(() => computeMetrics(sqlite, { ...SPEC, measure: "score:" }), MetricsError);
    await assert.rejects(() => computeMetrics(sqlite, { ...SPEC, measure: "score:bad name!" }), MetricsError);
  });
});

describe("GET /api/metrics?measure=score:<name>", () => {
  let dir: string;
  let index: SqliteIndexStore;
  let v: Viewer;

  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-metrics-scores-api-"));
    index = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const s of SESSIONS) await index.upsertSession(s);
    for (const sc of SCORES) await index.putScore(sc);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  });

  after(async () => {
    await v?.close();
    await index?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns bucketed and grouped score series for top and all scopes", async () => {
    const range = `since=${T0}&until=${T0 + 3 * DAY_MS}`;
    const top = await get(`/api/metrics?${range}&scope=top&by=model&measure=score:helpfulness`);
    assert.equal(top.status, 200);
    assert.equal(top.body.measure, "score:helpfulness");
    assert.equal(top.body.totals.scoreCount, 4);
    assert.equal(top.body.totals.scoreMean, 3.5);
    assert.deepEqual(top.body.all.scoreMean, [3.666667, null, 3]);
    assert.equal(top.body.series.find((x: any) => x.key === "claude-opus-5-5").totals.scoreMean, 4);

    // scope=all includes subagent sub1's score (1) -> sum 15, n=5, mean 3
    const all = await get(`/api/metrics?${range}&scope=all&measure=score:helpfulness`);
    assert.equal(all.status, 200);
    assert.equal(all.body.totals.scoreCount, 5);
    assert.equal(all.body.totals.scoreMean, 3);
  });

  test("omitting measure keeps scoreMean/scoreCount absent; built-in measure echoes measure", async () => {
    const range = `since=${T0}&until=${T0 + 3 * DAY_MS}`;
    const plain = await get(`/api/metrics?${range}`);
    assert.equal(plain.status, 200);
    assert.equal("measure" in plain.body, false);
    assert.equal("scoreMean" in plain.body.totals, false);
    assert.equal("scoreMean" in plain.body.all, false);

    const cost = await get(`/api/metrics?${range}&measure=cost`);
    assert.equal(cost.status, 200);
    assert.equal(cost.body.measure, "cost");
    assert.equal("scoreMean" in cost.body.totals, false);
  });

  test("bad measure params return 400", async () => {
    for (const qs of ["measure=score:", "measure=score:bad%20name", "measure=score:a!b", "measure=not-a-measure"]) {
      const r = await get(`/api/metrics?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.match(r.body.error, /measure/i, qs);
    }
  });

  test("store without listScores answers 501 for score measure", async () => {
    const noScores = new Proxy(index, {
      get(target, k) {
        if (k === "listScores") return undefined;
        const val = Reflect.get(target, k, target);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as IndexStore;
    const v2 = await startViewer({ index: noScores, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    try {
      const r = await fetch(`http://127.0.0.1:${v2.port}/api/metrics?since=${T0}&until=${T0 + DAY_MS}&measure=score:helpfulness`, {
        headers: { authorization: `Bearer ${v2.token}` },
      });
      assert.equal(r.status, 501);
    } finally {
      await v2.close();
    }
  });
});
