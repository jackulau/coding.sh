// checkAdapter on fake adapters: a throwing backfill, the event cap, the
// timeout, an adapter with no backfill, and score().
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkAdapter, score, type AdapterReport } from "../../src/conformance/index.ts";
import { hashParts } from "../../src/core/ids.ts";
import type { Adapter, BackfillOpts, NormalizeContext } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const T0 = Date.UTC(2026, 10, 1, 10);

function fake(id: string, backfill?: (ctx: NormalizeContext, opts?: BackfillOpts) => AsyncIterable<AgentEvent>): Adapter {
  const a = { id, displayName: id, tier: "B", detect: async () => ({ installed: false }), install: async () => [], uninstall: async () => [], normalize: async () => [] } as unknown as Adapter;
  if (backfill) a.backfill = backfill;
  return a;
}

/** A clean session `sid` as one transcript file. */
function session(sid: string, at = T0): AgentEvent[] {
  const e = (kind: AgentEvent["kind"], dt: number, payload: Record<string, unknown> = {}): AgentEvent => ({ id: hashParts("fake", sid, kind, dt), v: 0, agent: "fake", sessionId: sid, kind, ts: at + dt, payload });
  return [e("session.start", 0), e("user.message", 1, { text: "go" }), e("tool.start", 2, { tool: "Bash", toolUseId: "t1" }), e("tool.end", 3, { tool: "Bash", toolUseId: "t1", ok: true }), e("session.end", 4)];
}

describe("checkAdapter", () => {
  it("a backfill that throws is reported as backfill-threw, with paths cut, not rethrown", async () => {
    const r = await checkAdapter(
      fake("thrower", async function* () {
        yield* session("s1");
        throw new Error("ENOENT: no such file, open '/home/someone/private/projects/x.jsonl'\nstack line");
      }),
    );
    assert.deepEqual(r.report.violations, { "backfill-threw": 1 });
    assert.equal(r.report.counts.events, 5);
    const detail = r.report.examples[0]!.detail;
    assert.match(detail, /ENOENT/);
    assert.doesNotMatch(detail, /someone|private|stack line/);
    assert.match(detail, /…\/x\.jsonl/);
    assert.equal(r.violations, 1);
  });

  it("a backfill that throws before its first event is backfill-threw, not empty-backfill", async () => {
    const r = await checkAdapter(fake("thrower", async function* () { throw new Error("bad"); }));
    assert.deepEqual(r.report.violations, { "backfill-threw": 1 });
  });

  it("maxEvents stops the read; the session being read is partial and skips whole-session checks", async () => {
    // The second file is cut after its tool.start: a whole-session check would call the
    // missing end and other lines out, but it is partial.
    const r = await checkAdapter(
      fake("big", async function* (_ctx, opts) {
        await opts?.changed?.({ path: "a.jsonl", size: 1, mtimeMs: 1 });
        yield* session("s1");
        await opts?.changed?.({ path: "b.jsonl", size: 1, mtimeMs: 1 });
        yield* session("s2").slice(2);
      }),
      { maxEvents: 6 },
    );
    assert.equal(r.truncated, "max-events");
    assert.equal(r.report.counts.events, 6);
    assert.equal(r.report.counts.partialSessions, 1);
    assert.deepEqual(r.report.violations, {});
  });

  it("without file boundaries, the sessions of the last events are partial", async () => {
    const r = await checkAdapter(
      fake("big", async function* () {
        yield* session("s1");
        yield* session("s2").slice(1, 3);
        yield* session("s3");
      }),
      { maxEvents: 7 },
    );
    assert.equal(r.truncated, "max-events");
    assert.deepEqual(r.report.violations, {});
  });

  it("a backfill that hangs is stopped by timeoutMs and returns what it read", async () => {
    const r = await checkAdapter(
      fake("slow", async function* () {
        yield* session("s1");
        await new Promise(() => {});
      }),
      { timeoutMs: 50 },
    );
    assert.equal(r.truncated, "timeout");
    assert.equal(r.report.counts.events, 5);
    assert.ok(r.ms < 5_000);
  });

  it("an adapter without a backfill is skipped", async () => {
    const r = await checkAdapter(fake("hooks-only"));
    assert.equal(r.skipped, "no-backfill");
    assert.equal(r.violations, 0);
  });

  it("an agent with no source table gets no empty-backfill verdict", async () => {
    const r = await checkAdapter(fake("unknown", async function* () {}));
    assert.equal(r.sources, undefined);
    assert.deepEqual(r.report.violations, {});
  });

  it("score is the share of checked adapters with no violations; skipped ones do not count", () => {
    const rep = (violations: number, skipped?: "no-backfill") => ({ adapter: "x", ms: 0, violations, ...(skipped ? { skipped } : {}) }) as AdapterReport;
    assert.equal(score([]), 1);
    assert.equal(score([rep(0), rep(2), rep(0), rep(1)]), 0.5);
    assert.equal(score([rep(0), rep(0, "no-backfill")]), 1);
    assert.equal(score([rep(3), rep(0, "no-backfill")]), 0);
  });

  it("the report serializes with no string over 200 characters", async () => {
    const long = "x".repeat(5000);
    const r = await checkAdapter(
      fake("thrower", async function* () {
        throw new Error(long);
      }),
    );
    const strings: string[] = [];
    JSON.stringify(r, (_k, v) => {
      if (typeof v === "string") strings.push(v);
      return v;
    });
    assert.ok(strings.every((s) => s.length <= 200), "a string over 200 chars");
  });
});
