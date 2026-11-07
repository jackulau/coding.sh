import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildSession } from "../../../src/core/sessions.ts";
import { createGatewayClient, parseGeneration } from "../../../src/integrations/gateway/client.ts";
import { enrichSessions, genCacheKey } from "../../../src/integrations/gateway/enrich.ts";
import { decodeTraceJson } from "../../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../../src/otel/map.ts";
import { defaultEnricher } from "../../../src/otel/receiver.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { MemoryIndexStore } from "../../../src/store/memory.ts";
import { MemBlobs } from "../../otel/_memstore.ts";
import { aiSdkExport, drainExport, GEN_ID, GEN_ID_2 } from "./_fixtures.ts";
import { generationData, startMockGateway, TEST_KEY, type MockGateway } from "./_mock.ts";

const NO_RETRY = { retries: 0 };

async function mapExport(body: unknown): Promise<AgentEvent[]> {
  const blobs = new MemBlobs();
  const r = await mapTraces(decodeTraceJson(body), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap(), enrichSpan: defaultEnricher });
  assert.deepEqual(r.errors, []);
  return r.events;
}

async function store(events: AgentEvent[], index = new MemoryIndexStore()) {
  await index.putEvents(events);
  for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
  return index;
}

const call = (sessionId: string, i: number, payload: Record<string, unknown>, costUsd?: number): AgentEvent => ({
  id: `${sessionId}-call-${i}`,
  v: 0,
  sessionId,
  ts: 1_767_225_600_000 + i * 1000,
  agent: "claude-code",
  kind: "llm.call",
  source: "transcript",
  model: "claude-sonnet-4-5",
  usage: { inputTokens: 100, outputTokens: 10, ...(costUsd !== undefined ? { costUsd } : {}) },
  payload,
});
const start = (sessionId: string): AgentEvent => ({ id: `${sessionId}-start`, v: 0, sessionId, ts: 1_767_225_599_000, agent: "claude-code", kind: "session.start", source: "transcript", payload: {} });

describe("OTLP: gateway trace drain and AI SDK spans", () => {
  it("maps a drained request to one llm.call (cost reported, not summed) plus attempt spans in a daily session", async () => {
    const events = await mapExport(drainExport());
    assert.ok(events.every((e) => e.agent === "ai-gateway" && e.sessionId === "ai-gateway-2026-01-01"));
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.equal(calls.length, 1, "failover attempts are not extra model calls");
    const root = calls[0]!;
    assert.equal(root.payload.gatewayGenerationId, GEN_ID);
    assert.equal(root.payload.servedProvider, "anthropic");
    assert.equal(root.payload.billedCostUsd, 0.0081);
    assert.equal(root.payload.credentialType, "system");
    assert.equal(root.usage, undefined);
    assert.deepEqual(root.payload.reportedUsage, { inputTokens: 1200, outputTokens: 300, costUsd: 0.0081 });
    assert.ok(!events.some((e) => ["session.start", "session.end", "turn.end", "user.message"].includes(e.kind)));
    const attempts = events.filter((e) => e.kind === "span" && e.payload.attemptNumber !== undefined).sort((a, b) => a.ts - b.ts);
    assert.deepEqual(
      attempts.map((a) => [a.payload.provider, a.payload.success, a.payload.ok, a.payload.providerResponseId]),
      [
        ["vertex", false, false, "msg_vertex_failed"],
        ["anthropic", true, true, "msg_01AgentSawThis"],
      ],
    );
    const s = buildSession(events);
    assert.equal(s.stats.usage, undefined, "a drain mirrors calls: it adds no usage");
    assert.ok(s.flags.includes("gateway:vercel"));
  });

  it("tags AI SDK calls made through the gateway provider and takes cost from providerMetadata", async () => {
    const events = await mapExport(aiSdkExport());
    const c = events.find((e) => e.kind === "llm.call")!;
    assert.equal(c.payload.gateway, "vercel");
    assert.equal(c.payload.gatewayGenerationId, GEN_ID_2);
    assert.equal(c.payload.servedProvider, "azure");
    assert.equal(c.usage?.costUsd, 0.0042);
    assert.ok(buildSession(events).flags.includes("gateway:vercel"));
    // Unrelated spans pass through untouched.
    const plain = await mapExport({ ...aiSdkExport(), resourceSpans: aiSdkExport().resourceSpans.map((rs) => ({ ...rs, scopeSpans: rs.scopeSpans.map((ss) => ({ ...ss, spans: ss.spans.map((sp) => ({ ...sp, attributes: sp.attributes.filter((a: { key: string }) => !a.key.startsWith("ai.response.providerMetadata") && a.key !== "ai.model.provider") })) })) })) });
    assert.equal(plain.find((e) => e.kind === "llm.call")!.payload.gateway, undefined);
  });
});

describe("gateway REST client (mock server)", () => {
  let gw: MockGateway;
  before(async () => (gw = await startMockGateway()));
  after(() => gw.close());
  beforeEach(() => {
    gw.requests.length = 0;
    gw.generations.clear();
    gw.failWith500 = false;
  });

  it("looks up a generation with the bearer key and keeps only whitelisted fields", async () => {
    gw.generations.set(GEN_ID, generationData(GEN_ID));
    const client = createGatewayClient({ baseUrl: gw.url, apiKey: TEST_KEY, retry: NO_RETRY });
    const r = await client.generation(GEN_ID);
    if (r.status !== "ok") return assert.fail("expected a record");
    const info = r.info;
    assert.equal(info.totalCostUsd, 0.0123);
    assert.equal(info.provider, "bedrock");
    assert.equal(info.cachedTokens, 800);
    assert.ok(!JSON.stringify(info).includes("SECRET PROMPT"));
    assert.equal(gw.requests[0]!.path, `/v1/generation?id=${GEN_ID}`);
    assert.deepEqual(await client.credits(), { balanceUsd: 95.5, totalUsedUsd: 4.5 });
  });

  it("reports pending for 404 and scrubs the key from errors", async () => {
    const client = createGatewayClient({ baseUrl: gw.url, apiKey: TEST_KEY, retry: NO_RETRY });
    assert.deepEqual(await client.generation(GEN_ID), { status: "pending" });
    gw.failWith500 = true;
    await assert.rejects(client.generation(GEN_ID), (e: Error) => {
      assert.ok(!e.message.includes(TEST_KEY), e.message);
      return true;
    });
  });

  it("parses BYOK records: billed cost includes the provider's charge", () => {
    const g = parseGeneration(generationData(GEN_ID, { total_cost: 0, usage: 0, is_byok: true, upstream_inference_cost: 0.05 }))!;
    assert.equal(g.isByok, true);
    assert.equal(g.upstreamCostUsd, 0.05);
  });
});

describe("gateway enrich", () => {
  let gw: MockGateway;
  before(async () => (gw = await startMockGateway()));
  after(() => gw.close());
  beforeEach(() => {
    gw.requests.length = 0;
    gw.generations.clear();
  });

  it("links calls by generation id, writes a cost delta, caches lookups, and is idempotent", async () => {
    // Codex-style call through the gateway: response id is the generation id; reported cost 0.01.
    const index = await store([start("s1"), call("s1", 1, { responseId: GEN_ID, provider: "vercel" }, 0.01), call("s1", 2, { responseId: GEN_ID_2 }), call("s1", 3, { messageId: "msg_unrelated" })]);
    gw.generations.set(GEN_ID, generationData(GEN_ID, { total_cost: 0.0123 }));
    gw.generations.set(GEN_ID_2, generationData(GEN_ID_2, { total_cost: 0, usage: 0, is_byok: true, upstream_inference_cost: 0.02, provider_name: "anthropic" }));
    const client = createGatewayClient({ baseUrl: gw.url, apiKey: TEST_KEY, retry: NO_RETRY });
    const sessions = await index.listSessions();

    const dry = await enrichSessions({ index, sessions, client, dryRun: true });
    assert.equal(dry.enriched, 2);
    assert.equal(await index.kvGet(genCacheKey(GEN_ID)), undefined, "dry run writes nothing");
    assert.equal((await index.listEvents("s1")).length, 4);

    gw.requests.length = 0;
    const r = await enrichSessions({ index, sessions, client });
    assert.deepEqual({ calls: r.calls, linkable: r.linkable, enriched: r.enriched, fetched: r.fetched, pending: r.pending }, { calls: 3, linkable: 2, enriched: 2, fetched: 2, pending: 0 });
    assert.equal(r.billedUsd, 0.0323);
    assert.deepEqual(r.providers, { bedrock: 1, anthropic: 1 });
    assert.ok(gw.requests.every((q) => q.auth === `Bearer ${TEST_KEY}`));

    const evs = await index.listEvents("s1");
    const gen = evs.filter((e) => e.source === "gateway");
    assert.equal(gen.length, 2);
    const g1 = gen.find((e) => e.parentId === "s1-call-1")!;
    assert.equal(g1.kind, "span");
    assert.equal(g1.payload.provider, "bedrock");
    assert.equal(g1.payload.reportedCostUsd, 0.01);
    assert.deepEqual(g1.usage, { costUsd: 0.0023 }, "only the difference to what the call reported");
    const g2 = gen.find((e) => e.parentId === "s1-call-2")!;
    assert.equal(g2.payload.billedCostUsd, 0.02, "BYOK: provider charge counts");
    assert.equal(g2.payload.isByok, true);
    const s = (await index.getSession("s1"))!;
    assert.equal(s.stats.usage?.costUsd, 0.0323, "session cost = what the gateway billed");
    assert.ok(s.flags.includes("gateway:vercel"));
    assert.ok(!JSON.stringify(gen).includes("SECRET PROMPT"));
    assert.ok(!(await index.kvGet(genCacheKey(GEN_ID)))!.includes("SECRET PROMPT"));

    // Re-run: nothing new, no calls.
    gw.requests.length = 0;
    const again = await enrichSessions({ index, sessions: await index.listSessions(), client });
    assert.deepEqual({ enriched: again.enriched, already: again.alreadyEnriched, fetched: again.fetched }, { enriched: 0, already: 2, fetched: 0 });
    assert.equal(gw.requests.length, 0);
    assert.equal((await index.getSession("s1"))!.stats.usage?.costUsd, 0.0323);
  });

  it("uses the cache for other sessions with the same generation, and counts pending and keyless lookups", async () => {
    const index = await store([start("a"), call("a", 1, { responseId: GEN_ID })]);
    await index.kvSet(genCacheKey(GEN_ID), JSON.stringify({ id: GEN_ID, totalCostUsd: 0.5, provider: "vertex" }));
    const r = await enrichSessions({ index, sessions: await index.listSessions() });
    assert.deepEqual({ fromCache: r.fromCache, enriched: r.enriched, needKey: r.needKey }, { fromCache: 1, enriched: 1, needKey: 0 });

    const index2 = await store([start("b"), call("b", 1, { responseId: GEN_ID_2 })]);
    const keyless = await enrichSessions({ index: index2, sessions: await index2.listSessions() });
    assert.deepEqual({ needKey: keyless.needKey, enriched: keyless.enriched }, { needKey: 1, enriched: 0 });
    const client = createGatewayClient({ baseUrl: gw.url, apiKey: TEST_KEY, retry: NO_RETRY });
    const pending = await enrichSessions({ index: index2, sessions: await index2.listSessions(), client });
    assert.deepEqual({ pending: pending.pending, enriched: pending.enriched }, { pending: 1, enriched: 0 });
  });

  it("links Claude Code calls to drained gateway traces by the provider's message id, offline", async () => {
    const drained = await mapExport(drainExport({ responseId: "msg_01AgentSawThis" }));
    const index = await store([...drained, start("cc"), call("cc", 1, { messageId: "msg_01AgentSawThis" }, 0.0081), call("cc", 2, { messageId: "msg_vertex_failed" })]);
    const sessions = await index.listSessions();
    const r = await enrichSessions({ index, sessions });
    assert.equal(r.sessions, 1, "the drain's own day session is skipped");
    assert.deepEqual({ linkable: r.linkable, enriched: r.enriched, fromDrain: r.fromDrain }, { linkable: 1, enriched: 1, fromDrain: 1 });
    const g = (await index.listEvents("cc")).find((e) => e.source === "gateway")!;
    assert.equal(g.parentId, "cc-call-1");
    assert.equal(g.payload.linkedBy, "provider-response-id");
    assert.equal(g.payload.generationId, GEN_ID);
    assert.equal(g.payload.provider, "anthropic");
    assert.equal(g.usage, undefined, "billed equals reported: no delta");
    assert.ok((await index.getSession("cc"))!.flags.includes("gateway:vercel"));
  });
});
