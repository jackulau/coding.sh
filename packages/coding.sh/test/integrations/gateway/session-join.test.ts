// Session affinity (client session id) and `vmc/` virtual models, per
// vercel.com/docs/ai-gateway/models-and-providers/session-affinity and
// /virtual-models. Synthetic data only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeTranscriptConverter } from "../../../src/adapters/_shared/claude-transcript.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import { enrichSessions } from "../../../src/integrations/gateway/enrich.ts";
import { virtualModelId } from "../../../src/integrations/gateway/ids.ts";
import { decodeTraceJson } from "../../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../../src/otel/map.ts";
import { defaultEnricher } from "../../../src/otel/receiver.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { MemoryIndexStore } from "../../../src/store/memory.ts";
import { testCtx } from "../../adapters/_helpers.ts";
import { MemBlobs } from "../../otel/_memstore.ts";
import { aiSdkExport, drainExport, GEN_ID, GEN_ID_2 } from "./_fixtures.ts";

const BASE = 1_767_225_600_000; // 2026-01-01T00:00:00Z, the fixtures' clock

async function mapExport(body: unknown): Promise<AgentEvent[]> {
  const blobs = new MemBlobs();
  return (await mapTraces(decodeTraceJson(body), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap(), enrichSpan: defaultEnricher })).events;
}

describe("virtual models and session affinity", () => {
  it("recognises vmc/ slugs, with or without Claude Code's prefix", () => {
    assert.equal(virtualModelId("vmc/coding-agent"), "vmc/coding-agent");
    assert.equal(virtualModelId("claude-code/vmc/coding-agent[1m]"), "vmc/coding-agent");
    assert.equal(virtualModelId("anthropic/claude-sonnet-4.5"), undefined);
  });

  it("Claude Code transcripts keep the vmc/ slug and the model it resolved to", async () => {
    const { ctx } = testCtx();
    const conv = new ClaudeTranscriptConverter(ctx, { agent: "claude-code", mode: "assistant", sessionId: "cc-1", source: "cc-1.jsonl" });
    await conv.add({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }, 1);
    await conv.add(
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        requestedModel: "claude-code/vmc/coding-agent",
        message: { id: "msg_vmc_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 5, output_tokens: 2 }, provider_metadata: { gateway: { routing: { clientSessionId: "cc-1", clientSessionIdSource: "agent", finalProvider: "bedrock" } } } },
      },
      2,
    );
    const call = (await conv.finish()).find((e) => e.kind === "llm.call")!;
    assert.equal(call.payload.virtualModel, "vmc/coding-agent");
    assert.equal(call.payload.resolvedModel, "claude-opus-5-5");
    assert.equal(call.payload.gatewaySessionId, "cc-1");
    assert.equal(call.payload.servedProvider, "bedrock");
  });

  it("AI SDK spans record the client session id and the resolved virtual model", async () => {
    const body = aiSdkExport();
    const call = body.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
    for (const a of call.attributes as { key: string; value: { stringValue?: string } }[]) {
      if (a.key === "ai.model.id" || a.key === "gen_ai.request.model") a.value = { stringValue: "vmc/support" };
      if (a.key === "ai.response.providerMetadata") {
        a.value = { stringValue: JSON.stringify({ gateway: { generationId: GEN_ID_2, virtualModelConfig: { modelId: "openai/gpt-5" }, routing: { clientSessionId: "chat-42", clientSessionIdSource: "explicit", finalProvider: "openai" } } }) };
      }
    }
    const e = (await mapExport(body)).find((x) => x.kind === "llm.call")!;
    assert.equal(e.payload.gatewaySessionId, "chat-42");
    assert.equal(e.payload.gatewaySessionIdSource, "explicit");
    assert.equal(e.payload.virtualModel, "vmc/support");
    assert.equal(e.payload.resolvedModel, "openai/gpt-5");
  });

  it("joins a drained request to the coding.sh session named by its client session id", async () => {
    const drained = await mapExport(drainExport({ requestModel: "claude-code/vmc/coding-agent", sessionId: "cc-join", responseId: "msg_not_recorded" }));
    const root = drained.find((e) => e.kind === "llm.call")!;
    assert.equal(root.payload.gatewaySessionId, "cc-join");
    assert.equal(root.payload.virtualModel, "vmc/coding-agent");
    assert.equal(root.payload.resolvedModel, "claude-sonnet-4-5-20250929");

    const mk = (id: string, ts: number, model = "claude-code/vmc/coding-agent"): AgentEvent => ({ id, v: 0, sessionId: "cc-join", ts, agent: "claude-code", kind: "llm.call", source: "transcript", payload: { requestModel: model, messageId: `${id}-unseen` } });
    // The drained request started at BASE; the near call is 3 s later, the far one 20 min later.
    const agent = [mk("near", BASE + 3_000), mk("far", BASE + 20 * 60_000)];
    const index = new MemoryIndexStore();
    await index.putEvents([...drained, ...agent]);
    for (const id of ["cc-join", root.sessionId]) await index.upsertSession(buildSession(await index.listEvents(id)));

    const r = await enrichSessions({ index, sessions: await index.listSessions() });
    assert.deepEqual({ linkable: r.linkable, enriched: r.enriched, fromDrain: r.fromDrain }, { linkable: 1, enriched: 1, fromDrain: 1 });
    const g = (await index.listEvents("cc-join")).find((e) => e.source === "gateway")!;
    assert.equal(g.parentId, "near");
    assert.equal(g.payload.linkedBy, "client-session-id");
    assert.equal(g.payload.generationId, GEN_ID);
    assert.equal(g.payload.virtualModel, "vmc/coding-agent");
    assert.equal(g.payload.resolvedModel, "claude-sonnet-4-5-20250929");

    const again = await enrichSessions({ index, sessions: await index.listSessions() });
    assert.deepEqual({ enriched: again.enriched, already: again.alreadyEnriched }, { enriched: 0, already: 1 }, "the generation is taken; no second link");
  });
});
