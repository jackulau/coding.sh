// The sink mirror (src/server/mirror.ts) and the otlp sink's session span. A session
// keyed by a conversation id never gets a session.end, so the mirror hands the sink
// its open sessions and the sink sends their invoke_agent span: the parent the chat
// and execute_tool spans already name. A stub OTLP endpoint runs in-process; the
// receiver is wired to the mirror as `coding.sh collector` wires it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { startReceiver } from "../../src/otel/receiver.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { SinkMirror, type SinkMirrorOptions } from "../../src/server/mirror.ts";
import { startServe } from "../../src/server/serve.ts";
import { OtlpSink, sessionSpanId, traceIdFor } from "../../src/sinks/otlp.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { fixture } from "../otel/_encode.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

type J = any;

const servers: Server[] = [];
const mirrors: SinkMirror[] = [];
const dirs: string[] = [];
after(async () => {
  for (const m of mirrors) await m.close(0);
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Stub {
  url: string;
  /** Status codes to answer, in order; 200 once they run out. Only a 200 keeps the spans. */
  plan: number[];
  spans(): J[];
  sessionSpans(): J[];
}

async function stub(plan: number[] = []): Promise<Stub> {
  const bodies: J[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const status = plan.length ? plan.shift()! : 200;
      if (status === 200) bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(status, status === 503 ? { "retry-after": "0" } : {});
      res.end(status === 200 ? "{}" : "busy");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const spans = () => bodies.flatMap((b) => b.resourceSpans.flatMap((rs: J) => rs.scopeSpans.flatMap((ss: J) => ss.spans)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, plan, spans, sessionSpans: () => spans().filter((s: J) => s.name.startsWith("invoke_agent ")) };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out waiting");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mirror with one otlp sink. The quiet period and the busy refresh are off (a minute) unless a test turns one on. */
function mirrorTo(s: Stub, o: Partial<SinkMirrorOptions> = {}, mode: "full" | "metadata" = "metadata"): SinkMirror {
  const sink = new OtlpSink({ kind: "otlp", name: "team", endpoint: s.url, mode });
  const m = new SinkMirror({ sinks: [sink], blobs: new MemBlobs(), flushMs: 10, minBackoffMs: 10, maxBackoffMs: 50, quietMs: 60_000, refreshMs: 60_000, ...o });
  mirrors.push(m);
  return m;
}

const attr = (span: J, key: string): J => {
  const v = span.attributes.find((kv: J) => kv.key === key)?.value;
  return v === undefined ? undefined : "intValue" in v ? Number(v.intValue) : (v.stringValue ?? v.doubleValue ?? v.boolValue);
};

const T0 = 1_800_000_000_000;

function call(sessionId: string, n: number): AgentEvent {
  return { v: 0, id: `${sessionId}-call-${n}`, sessionId, ts: T0 + n * 1000, agent: "sdk", kind: "llm.call", durationMs: 500, model: "gpt-4o", payload: { provider: "openai", requestModel: "gpt-4o", ok: true } } as AgentEvent;
}

function end(sessionId: string, n: number): AgentEvent {
  return { v: 0, id: `${sessionId}-end`, sessionId, ts: T0 + n * 1000, agent: "sdk", kind: "session.end", payload: { reason: "completed" } } as AgentEvent;
}

/** The session row after `events` events; `endedAt` as a conversation-keyed session has it (the end of the last event). */
function row(id: string, events: number, extra: Partial<Session> = {}): Session {
  return { id, agent: "sdk", model: "gpt-4o", title: "fix the login bug", startedAt: T0, endedAt: T0 + events * 1000 + 500, stats: { events, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [], ...extra } as Session;
}

describe("the sink mirror sends an open session's invoke_agent span to the otlp sink", () => {
  // Each fixture goes through the real receiver, as the collector stores it. Only genai-semconv.json
  // is keyed by its trace and ends with its root span; the others never get a session.end.
  const wire: [string, string, string][] = [
    ["Claude Code traces", "/v1/traces", "claude-code-traces.json"],
    ["Claude Code logs", "/v1/logs", "claude-code-logs.json"],
    ["Codex logs", "/v1/logs", "codex-agents-logs.json"],
    ["a gen_ai.conversation.id trace (OpenInference)", "/v1/traces", "openinference.json"],
    ["an Agent Runs turn", "/v1/traces", "agent-runs/turn.json"],
    ["a trace that ends (GenAI semconv)", "/v1/traces", "genai-semconv.json"],
  ];
  for (const [name, path, file] of wire) {
    it(`${name}: one invoke_agent span per session, and every span's parent was sent`, async () => {
      const s = await stub();
      const mirror = mirrorTo(s, { quietMs: 80 });
      const store = new MemIndex();
      const errors: Error[] = [];
      const rx = await startReceiver({ port: 0, store, blobs: new MemBlobs(), onBatch: (b) => mirror.add(b.insertedEvents, b.sessions), onError: (e) => void errors.push(e) });
      try {
        const res = await fetch(rx.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture(file)) });
        assert.equal(res.status, 200, await res.text());
        const sessions = [...store.sessions.keys()];
        assert.ok(sessions.length > 0);
        await until(() => s.sessionSpans().length >= sessions.length);
        // Several quiet periods later nothing was sent again.
        await pause(300);
        assert.deepEqual(s.sessionSpans().map((sp) => sp.spanId).sort(), sessions.map(sessionSpanId).sort());
        const sent = new Set(s.spans().map((sp) => sp.spanId));
        const children = s.spans().filter((sp) => !sp.name.startsWith("invoke_agent "));
        assert.ok(children.length > 0, "the fixture sends chat or execute_tool spans");
        for (const sp of s.spans()) if (sp.parentSpanId) assert.ok(sent.has(sp.parentSpanId), `${sp.name} names a parent that was never sent`);
        for (const sp of s.sessionSpans()) {
          assert.equal(attr(sp, "gen_ai.operation.name"), "invoke_agent");
          const id = attr(sp, "gen_ai.conversation.id");
          assert.equal(attr(sp, "coding_sh.stats.events"), store.sessions.get(id)!.stats.events);
          // Its children carry the same trace id.
          for (const c of children) if (c.parentSpanId === sp.spanId) assert.equal(c.traceId, sp.traceId);
        }
        assert.deepEqual(errors, []);
      } finally {
        await rx.close();
      }
    });
  }

  it("a busy session is not sent on every flush: once when asked, and again only after more events", async () => {
    const s = await stub();
    const mirror = mirrorTo(s);
    for (let n = 1; n <= 5; n++) {
      mirror.add([call("busy", n)], [row("busy", n)]);
      await until(() => s.spans().length === n);
    }
    // Five batches went out on the timer; the session is neither quiet nor ended.
    await pause(60);
    assert.equal(s.sessionSpans().length, 0);
    await mirror.flush();
    assert.equal(s.sessionSpans().length, 1);
    const first = s.sessionSpans()[0]!;
    assert.equal(first.spanId, sessionSpanId("busy"));
    assert.equal(first.traceId, traceIdFor("busy"));
    assert.equal(attr(first, "coding_sh.stats.events"), 5);
    assert.equal(first.endTimeUnixNano, `${T0 + 5500}000000`);
    for (const sp of s.spans()) if (sp !== first) assert.equal(sp.parentSpanId, first.spanId);
    // Nothing changed: nothing is sent again.
    await mirror.flush();
    await mirror.flush();
    assert.equal(s.sessionSpans().length, 1);
    // More events: the same span again, with the newer row.
    mirror.add([call("busy", 6)], [row("busy", 6)]);
    await mirror.flush();
    const again = s.sessionSpans();
    assert.equal(again.length, 2);
    assert.equal(again[1]!.spanId, first.spanId);
    assert.equal(again[1]!.traceId, first.traceId);
    assert.equal(attr(again[1]!, "coding_sh.stats.events"), 6);
  });

  it("a session that has not gone quiet is sent once refreshMs passed", async () => {
    const s = await stub();
    const mirror = mirrorTo(s, { refreshMs: 40 });
    mirror.add([call("long", 1)], [row("long", 1)]);
    await until(() => s.sessionSpans().length === 1);
    await pause(150);
    assert.equal(s.sessionSpans().length, 1, "no new events, no resend");
  });

  it("a session without endedAt ends at its last mirrored event", async () => {
    const s = await stub();
    const mirror = mirrorTo(s);
    const { endedAt: _endedAt, ...running } = row("running", 2);
    mirror.add([call("running", 1), call("running", 2)], [running as Session]);
    await mirror.flush();
    assert.equal(s.sessionSpans().length, 1);
    assert.equal(s.sessionSpans()[0]!.startTimeUnixNano, `${T0}000000`);
    assert.equal(s.sessionSpans()[0]!.endTimeUnixNano, `${T0 + 2000}000000`);
  });

  it("a session that ends gets exactly one invoke_agent span", async () => {
    const s = await stub();
    const mirror = mirrorTo(s, { quietMs: 40 });
    // The end arrives with the events.
    mirror.add([call("ends", 1), end("ends", 2)], [row("ends", 2)]);
    // The end arrives in a later batch, before the session went quiet.
    const m2 = mirrorTo(s);
    m2.add([call("ends-later", 1)], [row("ends-later", 1)]);
    await until(() => s.spans().some((sp) => sp.parentSpanId === sessionSpanId("ends-later")));
    m2.add([end("ends-later", 2)], [row("ends-later", 2)]);
    await until(() => s.sessionSpans().length === 2);
    await pause(200);
    await mirror.flush();
    await m2.flush();
    assert.deepEqual(s.sessionSpans().map((sp) => sp.spanId).sort(), [sessionSpanId("ends"), sessionSpanId("ends-later")].sort());
  });

  it("close() sends the open sessions before the sinks close (the collector's Ctrl-C)", async () => {
    const s = await stub();
    const mirror = mirrorTo(s);
    mirror.add([call("closing", 1)], [row("closing", 1)]);
    await mirror.close(2000);
    assert.equal(s.spans().length, 2);
    assert.equal(s.sessionSpans().length, 1);
    assert.equal(s.sessionSpans()[0]!.spanId, sessionSpanId("closing"));
  });

  it("a session span the sink could not take is retried, not lost and not doubled", async () => {
    // The events are accepted, then the session span gets a 503 twice.
    const s = await stub([200, 503, 503]);
    const mirror = mirrorTo(s, { quietMs: 20 });
    mirror.add([call("flaky", 1)], [row("flaky", 1)]);
    await until(() => s.sessionSpans().length === 1);
    await pause(150);
    assert.equal(s.sessionSpans().length, 1);
    assert.equal(s.spans().length, 2);
    assert.deepEqual(s.plan, []);
  });

  it("a metadata sink's session span has no title; a full sink's has it", async () => {
    const meta = await stub();
    const full = await stub();
    for (const [s, mode] of [[meta, "metadata"], [full, "full"]] as const) {
      const mirror = mirrorTo(s, {}, mode);
      mirror.add([call("titled", 1)], [row("titled", 1)]);
      await mirror.flush();
      assert.equal(s.sessionSpans().length, 1);
    }
    assert.equal(attr(meta.sessionSpans()[0]!, "coding_sh.session.title"), undefined);
    assert.ok(!JSON.stringify(meta.spans()).includes("fix the login bug"));
    assert.equal(attr(full.sessionSpans()[0]!, "coding_sh.session.title"), "fix the login bug");
  });

  it("`coding.sh serve` with an otlp [[sinks]] entry sends the session span for an OTLP conversation", async () => {
    const s = await stub();
    const root = mkdtempSync(join(tmpdir(), "csh-mirror-"));
    dirs.push(root);
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "data"));
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_LOG: "json", CODING_SH_STORE_URL: "memory://" };
    const file = join(root, "data", "config.toml");
    writeFileSync(file, `[[sinks]]\nkind = "otlp"\nname = "team"\nendpoint = "${s.url}"\nmode = "metadata"\n`);
    const cfg = resolveServeConfig({ port: 0, config: file }, env);
    const index = new MemoryIndexStore();
    const h = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), stores: { index, blobs: new MemoryBlobStore() }, hookTiming: { flushMs: 10, quietMs: 60 } });
    try {
      const res = await fetch(`${h.url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture("agent-runs/turn.json")) });
      assert.equal(res.status, 200, await res.text());
      await until(() => s.sessionSpans().length > 0);
      await pause(250);
      assert.equal(s.sessionSpans().length, 1);
      const sent = new Set(s.spans().map((sp) => sp.spanId));
      assert.ok(s.spans().length > 1);
      for (const sp of s.spans()) if (sp.parentSpanId) assert.ok(sent.has(sp.parentSpanId), `${sp.name} names a parent that was never sent`);
    } finally {
      await h.shutdown();
    }
  });

  it("a subagent's open session joins its parent's trace", async () => {
    const s = await stub();
    const mirror = mirrorTo(s);
    const child = row("child", 1, { parent: { sessionId: "root", eventId: "root-call-1" } } as Partial<Session>);
    mirror.add([call("root", 1), call("child", 1)], [row("root", 1), child]);
    await mirror.flush();
    const [a, b] = ["root", "child"].map((id) => s.sessionSpans().find((sp) => sp.spanId === sessionSpanId(id))!);
    assert.equal(a!.traceId, traceIdFor("root"));
    assert.equal(a!.parentSpanId, undefined);
    assert.equal(b!.traceId, traceIdFor("root"));
    assert.equal(b!.parentSpanId, a!.spanId);
    for (const sp of s.spans()) assert.equal(sp.traceId, traceIdFor("root"));
  });
});
