import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSession } from "../../../src/core/sessions.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { eveJsonToResourceSpans, importEveRuns, resolveEveTraceStore } from "../../../src/integrations/eve/index.ts";
import { APP_DIR, bySession, CHILD_A0, CHILD_A1, ofKind, OTLP_EXPORT, readJson, ROOT_A, ROOT_B } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "eve-import-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function collect(source: string, opts?: Parameters<typeof importEveRuns>[1]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of importEveRuns(source, opts)) out.push(e);
  return out;
}

/** OTLP spans → the shape `eve traces show <id> --json` prints. */
function toCliTraces(): unknown[] {
  const traces = new Map<string, { traceId: string; spans: unknown[] }>();
  const av = (v: Record<string, unknown>): unknown =>
    "stringValue" in v ? v.stringValue : "intValue" in v ? Number(v.intValue) : "boolValue" in v ? v.boolValue : "doubleValue" in v ? v.doubleValue : "arrayValue" in v ? ((v.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(av) : null;
  const attrs = (list: { key: string; value: Record<string, unknown> }[] = []) => Object.fromEntries(list.map((kv) => [kv.key, av(kv.value)]));
  for (const body of readJson(OTLP_EXPORT) as { resourceSpans: { scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[] }[] }[])
    for (const rs of body.resourceSpans)
      for (const ss of rs.scopeSpans) {
        if (ss.scope.name !== "eve.agent") continue;
        for (const s of ss.spans) {
          const id = s.traceId as string;
          const t = traces.get(id) ?? { traceId: id, spans: [] };
          traces.set(id, t);
          t.spans.push({
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || null,
            name: s.name,
            kind: s.kind,
            scope: ss.scope.name,
            startTimeNs: s.startTimeUnixNano,
            endTimeNs: s.endTimeUnixNano,
            statusCode: (s.status as { code?: number } | undefined)?.code ?? 0,
            statusMessage: (s.status as { message?: string } | undefined)?.message ?? null,
            attributes: attrs(s.attributes as never),
            events: ((s.events as { name: string; timeUnixNano: string; attributes?: never }[]) ?? []).map((e) => ({ name: e.name, timeNs: e.timeUnixNano, attributes: attrs(e.attributes) })),
          });
        }
      }
  return [...traces.values()];
}

describe("importEveRuns", () => {
  it("finds the local trace store from the app root or any level below it", async () => {
    const store = await resolveEveTraceStore(APP_DIR);
    assert.ok(store?.endsWith(join(".eve", "traces", "v1")));
    assert.equal(await resolveEveTraceStore(join(APP_DIR, ".eve")), store);
    assert.equal(await resolveEveTraceStore(store!), store);
    assert.equal(await resolveEveTraceStore(tmp), undefined);
    await assert.rejects(collect(tmp), /no eve trace store/);
  });

  it("imports .eve/traces/v1 into sessions with parents, subagents, tools and model calls", async () => {
    const events = await collect(APP_DIR);
    const sessions = bySession(events);
    assert.deepEqual([...sessions.keys()].sort(), [ROOT_A, CHILD_A0, CHILD_A1, ROOT_B].sort());
    const root = buildSession(sessions.get(ROOT_A)!);
    assert.equal(root.agent, "eve");
    assert.equal(root.title, "What is the weather in Paris?");
    assert.equal(root.stats.turns, 2);
    assert.equal(ofKind(sessions.get(ROOT_A)!, "subagent.start").length, 2);
    assert.equal(buildSession(sessions.get(CHILD_A1)!).parent?.sessionId, ROOT_A);
    assert.equal(buildSession(sessions.get(ROOT_B)!).stats.toolErrors, 1);
    assert.ok(ofKind(events, "llm.call").every((e) => e.usage?.inputTokens && typeof e.durationMs === "number"));
    // Oldest trace first, events in time order within a trace.
    assert.equal(events[0]!.sessionId, ROOT_A);
  });

  it("gives the same event ids as live OTLP export, so import after collect is a no-op", async () => {
    const fromStore = await collect(APP_DIR);
    const fromExport = await collect(OTLP_EXPORT);
    assert.deepEqual(new Set(fromStore.map((e) => e.id)), new Set(fromExport.map((e) => e.id)));
  });

  it("reads `eve traces show --json` output and JSONL", async () => {
    const reference = new Set((await collect(OTLP_EXPORT)).map((e) => e.id));
    const cli = join(tmp, "traces.json");
    writeFileSync(cli, JSON.stringify(toCliTraces()));
    assert.deepEqual(new Set((await collect(cli)).map((e) => e.id)), reference);

    const jsonl = join(tmp, "export.jsonl");
    writeFileSync(jsonl, (readJson(OTLP_EXPORT) as unknown[]).map((b) => JSON.stringify(b)).join("\n"));
    assert.deepEqual(new Set((await collect(jsonl)).map((e) => e.id)), reference);
  });

  it("drops content by default and keeps it out of blobs", async () => {
    const events = await collect(APP_DIR, { maxInlineBytes: 64 });
    assert.ok(events.every((e) => !e.blobs?.length || e.blobs.every((b) => /^[0-9a-f]{64}$/.test(b))));
    assert.ok(events.every((e) => JSON.stringify(e.payload).length < 4096));
  });

  it("filters by start time", async () => {
    const all = await collect(APP_DIR);
    const lastTurn = Math.max(...ofKind(all, "turn.end").map((e) => e.ts));
    const recent = await collect(APP_DIR, { since: lastTurn });
    assert.ok(recent.length < all.length);
  });

  it("reads CLI trace ids with the OTLP rule: non-hex, wrong-length or all-zero ids are unset", async () => {
    const goodTrace = "0123456789abcdef0123456789ABCDEF";
    const goodSpan = "0123456789ABCDEF";
    const goodParent = "FEDCBA9876543210";
    const [batch] = eveJsonToResourceSpans({
      traceId: goodTrace,
      spans: [
        { spanId: goodSpan, parentSpanId: goodParent, name: "ok", startTimeNs: "1700000000000000000" },
        { spanId: "not-hex", parentSpanId: "0000000000000000", name: "bad-span", startTimeNs: "1700000000000000000" },
        { spanId: "0000000000000000", parentSpanId: "short", name: "zero-span", startTimeNs: "1700000000000000000" },
      ],
    });
    const spans = batch!.scopeSpans[0]!.spans;
    assert.equal(spans[0]!.traceId, goodTrace.toLowerCase());
    assert.equal(spans[0]!.spanId, goodSpan.toLowerCase());
    assert.equal(spans[0]!.parentSpanId, goodParent.toLowerCase());
    assert.equal(spans[1]!.spanId, undefined);
    assert.equal(spans[1]!.parentSpanId, undefined);
    assert.equal(spans[2]!.spanId, undefined);
    assert.equal(spans[2]!.parentSpanId, undefined);

    const [badTraceBatch] = eveJsonToResourceSpans({
      traceId: "00000000000000000000000000000000",
      spans: [{ spanId: goodSpan, name: "s", startTimeNs: "1700000000000000000" }],
    });
    assert.equal(badTraceBatch!.scopeSpans[0]!.spans[0]!.traceId, undefined);

    // End-to-end import: a bad span or trace is reported via onError while valid spans still import.
    const cliTraces = toCliTraces() as { traceId: string; spans: Record<string, unknown>[] }[];
    const first = structuredClone(cliTraces[0]!);
    first.spans[0]!.parentSpanId = "not-a-span-id";
    first.spans.push({
      spanId: "bad-span-id",
      parentSpanId: null,
      name: "dropped",
      scope: "eve.agent",
      startTimeNs: first.spans[0]!.startTimeNs,
      endTimeNs: first.spans[0]!.endTimeNs,
    });
    const badTrace = {
      traceId: "too-short",
      spans: [{ spanId: goodSpan, parentSpanId: null, name: "dropped-trace", scope: "eve.agent", startTimeNs: "1700000000000000000" }],
    };
    const file = join(tmp, "mixed-ids.json");
    writeFileSync(file, JSON.stringify([first, badTrace]));
    const errors: string[] = [];
    const events = await collect(file, { onError: (_p, err) => errors.push(err.message) });
    assert.ok(events.length > 0);
    assert.ok(errors.length >= 2);
  });
});
