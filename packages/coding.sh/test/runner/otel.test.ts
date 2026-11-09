// R1-13: per-run OpenTelemetry. The agent process gets an OTLP endpoint, a
// TRACEPARENT from the run id and coding_sh.run_id in its resource attributes;
// a stub agent that exports a span through them lands in the index tagged with
// the run, in the run's session. Off by default, with no env change.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import type { RunSpec } from "../../src/core/types.ts";
import { runExperiment } from "../../src/runner/experiment.ts";
import { CLAUDE_TELEMETRY_ENV, otelEnv, runTraceContext, withRunAttribute } from "../../src/runner/otel.ts";
import { runTask } from "../../src/runner/run.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { cleanupWorlds, fakeAdapter, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

const run = promisify(execFile);

/** A separate process, like a real agent: reads the OTEL env it was given and POSTs one chat span as OTLP/JSON. */
const STUB = `
const env = process.env;
const [, traceId, parentId] = env.TRACEPARENT.split("-");
const resource = env.OTEL_RESOURCE_ATTRIBUTES.split(",").map((kv) => { const [k, v] = kv.split("="); return { key: k, value: { stringValue: decodeURIComponent(v) } }; });
const ns = (ms) => String(BigInt(ms) * 1000000n);
const now = Date.now();
const span = { traceId, spanId: "a1b2c3d4e5f60718", parentSpanId: parentId, name: "chat stub-model", kind: 3, startTimeUnixNano: ns(now - 50), endTimeUnixNano: ns(now), status: {},
  attributes: [
    { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
    { key: "gen_ai.request.model", value: { stringValue: "stub-model" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
    { key: "session.id", value: { stringValue: process.argv[1] } },
  ] };
const body = { resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope: { name: "stub" }, spans: [span] }] }] };
fetch(env.OTEL_EXPORTER_OTLP_ENDPOINT + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((r) => process.exit(r.ok ? 0 : 3), () => process.exit(4));
`;

/** An agent whose process exports its span, then fixes the bug. */
const otlpAgent = () =>
  fakeAdapter({
    act: async (spec: RunSpec) => {
      await run(process.execPath, ["-e", STUB, `sess-${spec.runId}`], { env: { ...process.env, ...spec.env } });
      return undefined;
    },
  });

const OTEL_KEYS = /^(OTEL_|TRACEPARENT$|CLAUDE_CODE_ENABLE_TELEMETRY$|CLAUDE_CODE_ENHANCED)/;

describe("per-run OpenTelemetry", () => {
  it("otelEnv: a valid TRACEPARENT, the run id appended to the resource attributes, deterministic per run", () => {
    const e = otelEnv("run_01ABC", "fake", "http://127.0.0.1:4999", { OTEL_RESOURCE_ATTRIBUTES: "service.name=my-agent,coding_sh.run_id=old" });
    assert.match(e.TRACEPARENT ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(e.OTEL_RESOURCE_ATTRIBUTES, "service.name=my-agent,coding_sh.run_id=run_01ABC");
    assert.equal(e.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4999");
    assert.equal(e.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
    assert.deepEqual(otelEnv("run_01ABC", "fake", "x", {}).TRACEPARENT, e.TRACEPARENT, "same run id, same trace");
    assert.notEqual(otelEnv("run_01ABD", "fake", "x", {}).TRACEPARENT, e.TRACEPARENT, "another run, another trace");
    assert.equal(e.CLAUDE_CODE_ENABLE_TELEMETRY, undefined, "only Claude Code gets its telemetry switches");
    const c = otelEnv("run_01ABC", "claude-code", "x", {});
    for (const [k, v] of Object.entries(CLAUDE_TELEMETRY_ENV)) assert.equal(c[k], v);
    assert.equal(withRunAttribute(undefined, "run a,b"), "coding_sh.run_id=run%20a%2Cb", "percent-encoded");
  });

  it("off by default: the agent env has no OTel keys and the run no trace id", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("fixer", "always fix bugs"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    const spec = adapter.specs[0] as RunSpec;
    assert.deepEqual(Object.keys(spec.env).filter((k) => OTEL_KEYS.test(k)), []);
    assert.deepEqual(Object.keys(spec.env).sort(), ["CODING_SH_RUN_ID", "FROM_BUNDLE"]);
    assert.equal(r.traceId, undefined);
  });

  it("otel: true — a stub agent's span lands in the index tagged with the run, in the run's session; setup and verifier see no OTel env", async () => {
    const w = await toyWorld();
    const index = new MemoryIndexStore();
    // The verifier fails if it sees the endpoint, so the agent-only rule is checked too.
    const task = { ...w.task, setup: ['test -z "$OTEL_EXPORTER_OTLP_ENDPOINT"'], verifier: { ...w.task.verifier, command: 'test -z "$OTEL_EXPORTER_OTLP_ENDPOINT" && test -z "$TRACEPARENT"' } };
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: otlpAgent(), blobs: w.blobs, index, git: w.git, runsDir: w.runsDir, otel: true });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true);
    assert.equal(r.traceId, runTraceContext(r.id).traceId);
    const events = await index.listEvents(`sess-${r.id}`);
    const call = events.find((e) => e.kind === "llm.call");
    assert.ok(call, `an llm.call in the run's session: ${JSON.stringify(events.map((e) => e.kind))}`);
    assert.equal(call.runId, r.id);
    const session = await index.getSession(`sess-${r.id}`);
    assert.equal(session?.runId, r.id);
    assert.deepEqual((await index.listSessions({ runId: r.id })).map((s) => s.id), [`sess-${r.id}`]);
  });

  it("runExperiment otel: true — one receiver for every run, each span tagged with its own run", async () => {
    const w = await toyWorld();
    const index = new MemoryIndexStore();
    const bundles = [await w.mkBundle("a", "x"), await w.mkBundle("b", "y")];
    const r = await runExperiment({ tasks: [w.task], bundles, adapterFor: () => otlpAgent(), blobs: w.blobs, index, git: w.git, runsDir: w.runsDir, otel: true, concurrency: 2 });
    assert.equal(r.results.length, 2);
    for (const run of r.results) {
      const s = await index.getSession(`sess-${run.id}`);
      assert.equal(s?.runId, run.id);
      assert.equal(run.traceId, runTraceContext(run.id).traceId);
    }
  });
});
