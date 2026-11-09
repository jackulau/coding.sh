// Metrics (src/viewer/metrics.ts): the SQLite path and the scan fallback give
// the same series on a fixture index (golden), the sums reconcile with
// /api/stats, an empty range is all zeros, and bad params are 400s.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { parseWhere } from "../../src/query/where.ts";
import { bucketStart, bucketTimes, computeMetrics, DAY_MS, MetricsError, metricsOf, metricRow, type MetricsSpec } from "../../src/viewer/metrics.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { FakeBlobs, metricFixtures } from "./fakes.ts";

const GOLDEN = new URL("./fixtures/metrics.golden.json", import.meta.url);
// Wednesday 2026-10-07 00:00 UTC, the first day of metricFixtures().
const T0 = Date.UTC(2026, 9, 7);
const H = 3_600_000;

/** JSON with each array of numbers on one line, so the golden diff reads by bucket. */
const compact = (v: unknown): string => JSON.stringify(v, null, 2).replace(/\[\s*((?:-?[\d.e+-]+|null)(?:,\s*(?:-?[\d.e+-]+|null))*)\s*\]/g, (_, xs: string) => `[${xs.split(/,\s*/).join(", ")}]`) + "\n";

const SPEC: MetricsSpec = { since: T0, until: T0 + 10 * DAY_MS, bucket: "day" };

describe("metrics engine", () => {
  let dir: string;
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-metrics-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const s of metricFixtures()) {
      await sqlite.upsertSession(s);
      await memory.upsertSession(s);
    }
  });
  after(async () => {
    await sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("buckets start at local midnight; weeks on Monday", () => {
    assert.equal(bucketStart(T0 + 5 * H, "day"), T0);
    // UTC+2 (offset -120): local midnight is 22:00 UTC the day before.
    assert.equal(bucketStart(T0 + 5 * H, "day", -120), T0 - 2 * H);
    // 2026-10-07 is a Wednesday; its week starts Monday 2026-10-05.
    assert.equal(bucketStart(T0 + 5 * H, "week"), Date.UTC(2026, 9, 5));
    assert.equal(bucketStart(Date.UTC(2026, 9, 11, 23), "week"), Date.UTC(2026, 9, 5));
    assert.equal(bucketStart(Date.UTC(2026, 9, 12), "week"), Date.UTC(2026, 9, 12));
    assert.equal(bucketTimes(T0, T0 + 10 * DAY_MS, "day").length, 10);
    assert.deepEqual(bucketTimes(T0, T0 + 10 * DAY_MS, "week"), [Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)]);
    assert.throws(() => bucketTimes(T0, T0 + 500 * DAY_MS, "day"), MetricsError);
    assert.throws(() => bucketTimes(T0, T0, "day"), MetricsError);
  });

  test("golden: SQLite and the scan fallback agree for every split", async () => {
    const out: Record<string, unknown> = {};
    for (const by of [undefined, "agent", "model", "repo", "flag"] as const) {
      for (const bucket of ["day", "week"] as const) {
        const spec: MetricsSpec = { ...SPEC, bucket, ...(by ? { by } : {}) };
        const viaSql = await computeMetrics(sqlite, spec);
        const viaScan = await computeMetrics(sqlite, spec, { scan: true });
        const viaMemory = await computeMetrics(memory, spec);
        assert.deepEqual(viaScan, viaSql, `sqlite scan vs sql (${by ?? "none"}, ${bucket})`);
        assert.deepEqual(viaMemory, viaSql, `memory vs sqlite (${by ?? "none"}, ${bucket})`);
        if (bucket === "day" || !by) out[`${by ?? "none"}/${bucket}`] = viaSql;
      }
    }
    const filtered = parseWhere("agent:codex cost>0.1");
    const a = await computeMetrics(sqlite, { ...SPEC, by: "model", where: filtered, filter: { parentSessionId: null } });
    const b = await computeMetrics(memory, { ...SPEC, by: "model", where: filtered, filter: { parentSessionId: null } });
    assert.deepEqual(b, a);
    assert.equal(a.totals.sessions, 2);
    out["where agent:codex cost>0.1 top/model/day"] = a;
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, compact(out));
    assert.deepEqual(out, JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  test("totals: failures skip tags, tokens add the four counts, percentiles rank the sessions", async () => {
    const m = await computeMetrics(sqlite, SPEC);
    assert.equal(m.totals.sessions, 12);
    // m01, m02, m05, m06, m10, m12 have a flag with no colon; m07's model:switch is a tag.
    assert.equal(m.totals.failures, 6);
    assert.equal(m.totals.pricedSessions, 8);
    assert.equal(m.totals.costUsd, 5.404444444);
    assert.equal(m.totals.toolCalls, metricFixtures().reduce((n, s) => n + s.stats.toolCalls, 0));
    assert.equal(m.totals.llmP95Ms, 30_000);
    // Nearest rank over 300, 500, 900, 1100, 1500, 2000.
    assert.equal(m.totals.ttftP50Ms, 900);
    assert.equal(m.totals.llmErrors, 2);
    assert.equal(m.all.sessions.reduce((a, b) => a + b, 0), 12);
    // m07 and m08 start in the same hour of day 5.
    assert.equal(m.all.sessions[5], 2);
    assert.equal(m.all.sessions[4], 0);
    assert.equal(m.all.llmP95Ms[4], null);
  });

  test("a split keeps the 6 largest groups and adds the rest up in other", () => {
    const rows = metricFixtures().map(metricRow);
    const m = metricsOf(rows, { ...SPEC, by: "model", maxGroups: 2 });
    assert.deepEqual(m.series.map((s) => s.key), ["claude-opus-5-5", "gpt-6.1-sol", "other"]);
    assert.equal(m.series.reduce((n, s) => n + s.totals.sessions, 0), 12);
    const flags = metricsOf(rows, { ...SPEC, by: "flag" });
    // A session with two flags counts in both rows; "(none)" holds the unflagged ones.
    assert.equal(flags.series.find((s) => s.key === "compaction")!.totals.sessions, 2);
    assert.equal(flags.series.find((s) => s.key === "(none)")!.totals.sessions, 5);
  });

  test("an empty range is all zeros, one bucket per day", async () => {
    const m = await computeMetrics(sqlite, { since: T0 + 100 * DAY_MS, until: T0 + 107 * DAY_MS, bucket: "day", by: "agent" });
    assert.equal(m.buckets.length, 7);
    assert.equal(m.totals.sessions, 0);
    assert.deepEqual(m.all.sessions, [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(m.all.llmP95Ms, [null, null, null, null, null, null, null]);
    assert.deepEqual(m.series, []);
    assert.equal(m.totals.failureRate, undefined);
  });
});

describe("GET /api/metrics", () => {
  let dir: string;
  let index: SqliteIndexStore;
  let v: Viewer;
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}` } });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-metrics-api-"));
    index = await SqliteIndexStore.open(join(dir, "index.db"));
    for (const s of metricFixtures()) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  });
  after(async () => {
    await v?.close();
    await index?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sums reconcile with /api/stats over the same range", async () => {
    const range = `since=${T0}&until=${T0 + 10 * DAY_MS}`;
    for (const scope of ["all", "top"]) {
      const stats = (await get(`/api/stats?scope=${scope}&${range}`)).body;
      const m = (await get(`/api/metrics?scope=${scope}&${range}&by=agent`)).body;
      assert.equal(m.totals.sessions, stats.sessions, `sessions (${scope})`);
      const byAgent = Object.fromEntries(m.series.map((s: any) => [s.key, s.totals.sessions]));
      assert.deepEqual(byAgent, stats.byAgent, `by agent (${scope})`);
      if (scope === "all") {
        // /api/stats sums tools and cost over every session; metrics with scope=all do too.
        assert.equal(m.totals.toolCalls, stats.toolCalls);
        assert.equal(m.totals.toolErrors, stats.toolErrors);
        assert.equal(m.totals.llmCalls, stats.llmCalls);
        assert.equal(m.totals.pricedSessions, stats.pricedSessions);
        assert.ok(Math.abs(m.totals.costUsd - stats.costUsd) < 1e-9);
        const byFlag = Object.fromEntries((await get(`/api/metrics?scope=all&${range}&by=flag&groups=50`)).body.series.filter((s: any) => s.key !== "(none)").map((s: any) => [s.key, s.totals.sessions]));
        assert.deepEqual(byFlag, stats.byFlag);
        const byModel = Object.fromEntries((await get(`/api/metrics?scope=all&${range}&by=model&groups=50`)).body.series.filter((s: any) => s.key !== "(none)").map((s: any) => [s.key, s.totals.sessions]));
        assert.deepEqual(byModel, stats.byModel);
      }
    }
  });

  test("an empty range answers 200 with zero buckets filled in", async () => {
    const r = await get(`/api/metrics?since=${T0 - 30 * DAY_MS}&until=${T0 - 23 * DAY_MS}&bucket=day`);
    assert.equal(r.status, 200);
    assert.equal(r.body.buckets.length, 7);
    assert.equal(r.body.totals.sessions, 0);
  });

  test("relative ranges and defaults", async () => {
    const r = await get("/api/metrics");
    assert.equal(r.status, 200);
    assert.equal(r.body.bucket, "day");
    assert.ok(r.body.buckets.length === 30 || r.body.buckets.length === 31);
    const w = await get("/api/metrics?since=90d&bucket=week&tz=-120");
    assert.equal(w.status, 200);
    assert.equal(w.body.tzOffsetMin, -120);
  });

  test("bad params are 400s that say why", async () => {
    const cases: [string, RegExp][] = [
      ["bucket=hour", /bucket must be day or week/],
      ["by=tool", /by must be one of agent, model, repo, flag/],
      ["since=yesterday", /since must be/],
      [`since=${T0}&until=${T0}`, /since must be before until/],
      [`since=${T0 - 900 * DAY_MS}&until=${T0}`, /more than 400 day buckets; use bucket=week/],
      ["tz=999", /tz must be/],
      ["tz=abc", /tz must be/],
      ["where=cost%3E%3E1", /where/],
      ["scope=mine", /scope must be top or all/],
      ["groups=0", /groups/],
    ];
    for (const [qs, re] of cases) {
      const r = await get(`/api/metrics?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.match(r.body.error, re, qs);
    }
    assert.equal((await get("/api/metrics/x")).status, 404);
  });
});
