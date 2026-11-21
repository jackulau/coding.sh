// Regression: `coding.sh serve` stored only the first copy of a Claude Code model call that arrives
// as both a claude_code.llm_request span (ttft_ms, no cost) and an api_request log record
// (reported cost_usd) under one id, so the session lost the TTFT or the reported cost depending
// on which signal came first. The collector merged both (mergeAgentCopies); serve's ingest queue
// now does too, across ticks and within one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { decodeLogsJson, decodeTraceJson } from "../../src/otel/json.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { IngestQueue, type QueueEntry } from "../../src/server/queue.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { iAttr, otlpSpan, otlpTraces, sAttr } from "./_encode.ts";

const root = mkdtempSync(join(tmpdir(), "csh-otel-serve-copies-"));
after(() => rmSync(root, { recursive: true, force: true }));
const config = resolveServeConfig({}, { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data") }).core;

type Otlp = Omit<Extract<QueueEntry, { kind: "otlp" }>, "project">;

function requests(sid: string): { traces: Otlp; logs: Otlp } {
  const T = "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c";
  const c = sAttr("session.id", sid);
  const call = (span: string, start: number, ttft: number, rid: string) =>
    otlpSpan(
      T,
      span,
      "e000000000000001",
      "claude_code.llm_request",
      [c, sAttr("prompt.id", "p1"), sAttr("span.type", "claude_code.llm_request"), sAttr("model", "claude-sonnet-4-5"), iAttr("duration_ms", 1000), iAttr("ttft_ms", ttft), iAttr("input_tokens", 100), iAttr("output_tokens", 50), sAttr("request_id", rid)],
      start,
      start + 1000,
    );
  const traces = otlpTraces("claude-code", [
    otlpSpan(T, "e000000000000001", undefined, "claude_code.interaction", [c, sAttr("span.type", "claude_code.interaction"), sAttr("prompt.id", "p1"), sAttr("user_prompt", "hello there")], 0, 5000),
    call("e000000000000002", 100, 300, "req_s1"),
    call("e000000000000003", 2000, 300, "req_s2"),
  ]);
  const at = (ms: number) => String((1767225600000n + BigInt(ms)) * 1_000_000n);
  const api = (ms: number, rid: string) => ({
    timeUnixNano: at(ms),
    body: { stringValue: "claude_code.api_request" },
    attributes: [c, sAttr("event.name", "api_request"), sAttr("prompt.id", "p1"), sAttr("model", "claude-sonnet-4-5"), { key: "cost_usd", value: { doubleValue: 0.01 } }, iAttr("duration_ms", 1000), iAttr("input_tokens", 100), iAttr("output_tokens", 50), sAttr("request_id", rid)],
  });
  const records = [
    { timeUnixNano: at(0), body: { stringValue: "claude_code.user_prompt" }, attributes: [c, sAttr("event.name", "user_prompt"), sAttr("prompt.id", "p1"), sAttr("prompt", "hello there")] },
    api(1100, "req_s1"),
    api(3000, "req_s2"),
  ];
  const logs = { resourceLogs: [{ resource: { attributes: [sAttr("service.name", "claude-code")] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }] }] };
  return {
    traces: { kind: "otlp", signal: "traces", decoded: decodeTraceJson(traces), items: 3, bytes: 100 },
    logs: { kind: "otlp", signal: "logs", decoded: decodeLogsJson(logs), items: 3, bytes: 100 },
  };
}

describe("serve merges Claude Code's span and log copies of a model call", () => {
  const cases: { name: string; order: ("traces" | "logs")[]; oneTick: boolean; project: string }[] = [
    { name: "traces first", order: ["traces", "logs"], oneTick: false, project: "default" },
    { name: "logs first", order: ["logs", "traces"], oneTick: false, project: "default" },
    { name: "traces first, in one tick, in a project", order: ["traces", "logs"], oneTick: true, project: "demo" },
    { name: "logs first, in one tick", order: ["logs", "traces"], oneTick: true, project: "default" },
  ];
  for (const t of cases) {
    it(t.name, async () => {
      const store = new MemoryIndexStore();
      const q = new IngestQueue({ store, blobs: new MemoryBlobStore(), config, maxEvents: 1000, maxBytes: 1e7 });
      q.setWritable(true);
      const sid = "cc-serve-both";
      const r = requests(sid);
      if (t.oneTick) {
        const pending = t.order.map((k) => q.submit({ ...r[k], project: t.project }));
        q.start();
        await Promise.all(pending);
      } else {
        q.start();
        for (const k of t.order) await q.submit({ ...r[k], project: t.project });
      }
      const stored = t.project === "default" ? sid : `${t.project}/${sid}`;
      const s = await store.getSession(stored);
      assert.equal(s?.stats.latency?.llmCalls, 2, "each call counted once");
      assert.equal(s?.stats.usage?.costUsd, 0.02, "the reported cost, not an estimate");
      assert.equal(s?.stats.usage?.estimatedCostUsd, undefined);
      assert.equal(s?.stats.latency?.ttftP50Ms, 300, "the span's TTFT");
      assert.equal(s?.stats.phases, undefined, "one prompt is one phase, not a resume");
      const calls = (await store.listEvents(stored)).filter((e) => e.kind === "llm.call");
      assert.equal(calls.length, 2);
      for (const e of calls) {
        assert.equal(e.payload.costEstimated, undefined);
        assert.equal(e.payload.ttftMs, 300);
      }
      await q.drain(1000);
    });
  }
});
