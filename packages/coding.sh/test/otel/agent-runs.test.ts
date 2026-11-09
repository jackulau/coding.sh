// Agent Runs tee (docs/how-to/tee-agent-runs.md): the spans @vercel/agent-runs
// exports for eve and durable-harness, posted to the receiver, become one
// session with its turn, model calls, tool calls and usage.
//
// fixtures/otel/agent-runs/turn.json is real output: scripts/e2e/agent-runs-capture.mjs
// ran @vercel/agent-runs 0.0.1 with durable-harness 0.0.2's tracer setup
// (service and framework "durable-harness", scope "eve.agent") for one turn
// with two steps and a get_weather tool call, serialized by
// @opentelemetry/otlp-transformer 0.208.0's JsonTraceSerializer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";

const body = readFileSync(new URL("../fixtures/otel/agent-runs/turn.json", import.meta.url), "utf8");

function post(base: string, path: string, data: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("Agent Runs spans through the receiver", () => {
  let store: MemIndex;
  let rx: Receiver;
  before(async () => {
    store = new MemIndex();
    rx = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
    assert.equal(await post(rx.url, "/v1/traces", body), 200);
  });
  after(() => rx.close());

  it("is one session per run, with its turn, model calls, tool calls and usage", async () => {
    const s = await store.getSession("wrun_demo");
    assert.ok(s, "session wrun_demo");
    // The Agent Runs host (agent.framework.name on the resource); the agent's own name is on session.start.
    assert.equal(s.agent, "durable-harness");
    assert.equal(s.title, "What is the weather in Paris?");
    assert.equal(s.stats.turns, 1);
    assert.equal(s.stats.latency?.llmCalls, 2);
    assert.equal(s.stats.toolCalls, 1);
    assert.equal(s.stats.toolErrors, 0);
    // The two chat spans: 1200 + 1300 input of which 800 + 1100 cache reads, 150 cache writes.
    const u = s.stats.usage!;
    assert.equal(u.inputTokens, 1200 - 800 + 1300 - 1100 - 150);
    assert.equal(u.outputTokens, 65);
    assert.equal(u.cacheReadTokens, 1900);
    assert.equal(u.cacheWriteTokens, 150);
    assert.ok((u.costUsd ?? 0) > 0, "priced from the model");
  });

  it("maps each span to the events the eve mapping documents", async () => {
    const events = await store.listEvents("wrun_demo");
    const kinds = events.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === "session.start").length, 1);
    assert.equal(kinds.filter((k) => k === "user.message").length, 1);
    assert.equal(kinds.filter((k) => k === "turn.end").length, 1);
    assert.equal(kinds.filter((k) => k === "llm.call").length, 2);
    const start = events.find((e) => e.kind === "tool.start")!;
    const end = events.find((e) => e.kind === "tool.end")!;
    assert.equal(start.payload.tool, "get_weather");
    assert.deepEqual(start.payload.input, { city: "Paris" });
    assert.equal(events.find((e) => e.kind === "session.start")!.payload.agentName, "weather");
    assert.equal(end.payload.ok, true);
    const steps = events.filter((e) => e.kind === "notification" && e.payload.type === "eve.step");
    assert.deepEqual(steps.map((e) => e.payload.stepIndex).sort(), [0, 1]);
    const user = events.find((e) => e.kind === "user.message")!;
    assert.match(JSON.stringify(user.payload), /What is the weather in Paris\?/);
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.deepEqual(calls.map((e) => e.model), ["claude-sonnet-4-5", "claude-sonnet-4-5"]);
  });

  it("stores nothing new when the same spans are posted again", async () => {
    const before = (await store.listEvents("wrun_demo")).length;
    assert.equal(await post(rx.url, "/v1/traces", body), 200);
    assert.equal((await store.listEvents("wrun_demo")).length, before);
  });
});
