// Durable workflow runs: one run = one session, however many traces, processes
// and deploys it spans. The *.jsonl fixtures are real OTLP exports, one request
// body per line in arrival order (JSON, or {"protobuf": base64} for exporters
// that send protobuf), captured on a local machine with a stub model (no
// network, no secrets; desk paths and host attributes scrubbed) against
// `coding.sh collector`. Every capture runs the same scenario: plan → search
// (fails once, retried) → read (its process killed with -9 mid-attempt) → a
// durable sleep or wait (its process stopped meanwhile) → write on
// service.version 2.
//
// - temporal.jsonl: Temporal TS SDK 1.25 with OpenTelemetryPlugin on client and
//   worker. Workflow plan → search → read → sleep 6s → write. search fails once;
//   worker A is killed (-9) during read attempt 1; worker B finishes read and is
//   stopped during the sleep; worker C (service.version 2) runs write.
// - temporal-activities-only.jsonl: the same scenario with only the activity
//   interceptors (no plugin): every activity is its own trace.
// - vercel-workflow.jsonl: Vercel Workflow 5.4 (Nitro, local world), default
//   linked trace mode, the same scenario; server C has service.version 2.
// - vercel-workflow-continuous.jsonl: the same in WORKFLOW_TRACE_MODE=continuous.
// - inngest.jsonl: Inngest 4.26 SDK (extendedTracesMiddleware) against the
//   inngest-cli 1.51 dev server, step.sleep 6s.
// - restate.jsonl: restate-server 1.8.1 (OTLP/JSON) + TS SDK 1.18 with the
//   OpenTelemetry hook, a Workflow with ctx.run steps and ctx.sleep 6s.
// - dbos.jsonl (protobuf): DBOS Transact TS 5.4 on Postgres 16, steps with
//   retries, DBOS.sleep 6s; the deploy rewinds the workflow onto version 2.
// - langgraph-openinference.jsonl / langgraph-langsmith.jsonl (protobuf):
//   LangGraph 1.2 with a SQLite checkpointer, traced by OpenInference or by
//   LangSmith's OTel exporter; the wait is an interrupt() answered ~6s later
//   by a resume Command from process C.
// - cloudflare-workflows.jsonl: a Workflow under wrangler 4.158 dev, spans
//   emitted by the Worker itself with the hand-rolled convention (wrangler dev
//   exports none); local instances resume only after pause()/resume().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { durableRows, durableSteps } from "../../src/cli/commands/show.ts";
import { renderTree } from "../../src/cli/commands/workflows.ts";
import { durableStats } from "../../src/core/durable.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { decodeTraceRequest } from "../../src/otel/proto.ts";
import { mapTraces, SpanTree, TraceSessionMap } from "../../src/otel/map.ts";
import type { AgentEvent, DurableStats } from "../../src/schema/index.ts";
import { buildGantt, ganttTsv } from "../../src/workflows/gantt.ts";
import { buildWorkflowTree } from "../../src/workflows/tree.ts";
import { startReceiver } from "../../src/otel/receiver.ts";
import { MemBlobs, MemIndex } from "./_memstore.ts";

type J = Record<string, unknown>;

async function mapBodies(bodies: J[]): Promise<Map<string, AgentEvent[]>> {
  const blobs = new MemBlobs();
  const traceSessions = new TraceSessionMap();
  const spanTree = new SpanTree();
  const by = new Map<string, AgentEvent[]>();
  for (const body of bodies) {
    const { events } = await mapTraces(decodeBody(body), { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions, spanTree });
    for (const e of events) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
  }
  return by;
}

/** A fixture line is an OTLP/JSON body, or {"protobuf": base64} for an exporter that sent protobuf. */
const decodeBody = (body: J) => (typeof body.protobuf === "string" ? decodeTraceRequest(Buffer.from(body.protobuf, "base64")) : decodeTraceJson(body));
const post = (url: string, body: J) =>
  typeof body.protobuf === "string"
    ? fetch(url, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: Buffer.from(body.protobuf, "base64") })
    : fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const capture = (name: string): J[] =>
  readFileSync(new URL(`../fixtures/otel/durable/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as J);

/** Steps as "name:attempts" with ✗ for failed attempts and +N for unreported ones. */
const shape = (d: DurableStats) => d.steps.map((s) => `${s.name}:${s.unreported ? `+${s.unreported}` : ""}${s.attempts.map((a) => `${a.n}${a.ok ? "" : "✗"}`).join(",")}`);
const resumes = (d: DurableStats) => d.resumes.map((r) => `${r.reason}@${r.step ?? "?"}${r.fromVersion ? ` ${r.fromVersion}→${r.toVersion}` : ""}`);

describe("durable workflow runs from real captures", () => {
  it("Temporal with the plugin: one session; the failed search, the read lost with its worker, the deploy", async () => {
    const by = await mapBodies(capture("temporal"));
    const id = "temporal:research-durable-agents:01a1b76b-3758-712c-8f91-b5e4b3201689";
    assert.deepEqual([...by.keys()], [id]);
    const s = buildSession(by.get(id)!);
    const d = s.stats.durable!;
    assert.equal(d.engine, "temporal");
    assert.equal(d.workflow, "researchAgent");
    assert.equal(s.title, "researchAgent");
    assert.deepEqual(shape(d), ["plan:1", "search:1✗,2", "read:+12", "write:1"]);
    assert.equal(d.steps[1]!.attempts[0]!.error, "search API returned 503");
    // StartActivity:read ran 14s; its only reported attempt 0.5s, on a new worker.
    assert.ok(d.steps[2]!.unreportedMs! > 10_000);
    assert.deepEqual(resumes(d), ["crash@read", "deploy@write 1→2"]);
    assert.equal(d.retries, 2);
    assert.equal(d.failedAttempts, 1);
    assert.equal(d.instances, 4);
    // Sleep, downtime and timeouts are idle, not work.
    assert.ok(d.activeMs < 2_000 && d.wallMs > 30_000, `${d.activeMs} / ${d.wallMs}`);
    assert.equal(d.idleMs, d.wallMs - d.activeMs);
    assert.ok(s.flags.includes("step-retried") && s.flags.includes("resumed"));
    assert.deepEqual(s.stats.usage && { i: s.stats.usage.inputTokens, o: s.stats.usage.outputTokens }, { i: 3100, o: 540 });
  });

  it("Temporal with activity interceptors only: separate traces still make one run", async () => {
    const by = await mapBodies(capture("temporal-activities-only"));
    assert.equal(by.size, 1);
    const [id, events] = [...by][0]!;
    assert.match(id, /^temporal:research-durable-agents:/);
    const d = buildSession(events).stats.durable!;
    assert.deepEqual(shape(d), ["plan:1", "search:1✗,2", "read:1", "write:1"]);
    // No StartActivity spans: the lost read attempt is invisible, the move to a new worker is not.
    assert.deepEqual(resumes(d), ["restart@read", "deploy@write 1→2"]);
  });

  it("Vercel Workflow (linked traces): stitched by run id, failed attempt read from attributes, recovery, sleep", async () => {
    const by = await mapBodies(capture("vercel-workflow"));
    const id = "wrun_01M6VR4652F71REEM5KNF4TQ95";
    const run = by.get(id)!;
    // Only the world's startup scans (world.runs.list, no run id) stay outside the run.
    for (const [k, evs] of by) if (k !== id) assert.deepEqual([...new Set(evs.map((e) => e.payload.name).filter(Boolean))], ["world.runs.list"]);
    const s = buildSession(run);
    const d = s.stats.durable!;
    assert.equal(d.engine, "vercel-workflow");
    assert.equal(d.workflow, "researchAgent");
    assert.deepEqual(shape(d), ["plan:1", "search:1✗,2", "read:+12", "write:1"]);
    assert.equal(d.steps[1]!.attempts[0]!.error, "search API returned 503");
    assert.deepEqual(resumes(d), ["crash@read", "deploy@write 1→2", "wait@write"]);
    assert.equal(d.waits.length, 1);
    const w = d.waits[0]!;
    assert.ok(w.endedAt! - w.startedAt > 6_000 && w.endedAt! - w.startedAt < 7_000);
    assert.equal(d.waitMs, w.endedAt! - w.startedAt);
    assert.ok(d.activeMs < d.wallMs - d.waitMs);
    assert.deepEqual(s.flags.filter((f) => f === "step-retried" || f === "resumed"), ["step-retried", "resumed"]);
    // What `coding.sh show` prints for it.
    const rows = Object.fromEntries(durableRows(d));
    assert.match(rows.Resumed!, /^after a crash at read, .* later; after a deploy \(1 → 2\) at write, .* later$/);
    assert.match(rows.Time!, /^wall 11s: busy [\d.]+s, waiting 6\.4s, idle [\d.]+s$/);
    const lines = durableSteps(d, s.startedAt).join("\n");
    assert.match(lines, /search\s+ok\s+#1 failed \S+ \(search API returned 503\) → #2 ok/);
    assert.match(lines, /read\s+ok\s+1 lost \(its process stopped; seen \S+, then down \S+\) → #2 ok/);
    assert.match(lines, /\(wait\)\s+done\s+wait 6\.4s/);
    assert.deepEqual(s.stats.usage && { i: s.stats.usage.inputTokens, o: s.stats.usage.outputTokens }, { i: 3100, o: 540 });
  });

  it("Vercel Workflow (continuous traces): linked handler traces join the run", async () => {
    const by = await mapBodies(capture("vercel-workflow-continuous"));
    const runs = [...by.keys()].filter((k) => k.startsWith("wrun_"));
    assert.equal(runs.length, 1);
    const d = buildSession(by.get(runs[0]!)!).stats.durable!;
    assert.deepEqual(shape(d), ["plan:1", "search:1✗,2", "read:+12", "write:1"]);
    assert.deepEqual(resumes(d).filter((r) => !r.startsWith("wait")), ["crash@read", "deploy@write 1→2"]);
  });

  it("through the collector: each capture is stored as exactly one session, with its durable stats", async () => {
    for (const [name, read] of [["temporal", "read:+12"], ["temporal-activities-only", "read:1"], ["vercel-workflow", "read:+12"], ["vercel-workflow-continuous", "read:+12"]]) {
      const store = new MemIndex();
      const r = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
      try {
        for (const b of capture(name!)) {
          const res = await post(`${r.url}/v1/traces`, b);
          assert.equal(res.status, 200);
        }
      } finally {
        await r.close();
      }
      // The Workflow SDK's plumbing spans (route init, world.runs.list scans) make no sessions of their own.
      const sessions = await store.listSessions();
      assert.equal(sessions.length, 1, `${name}: ${sessions.map((s) => s.id).join(", ")}`);
      const s = sessions[0]!;
      assert.equal(s.title, "researchAgent", name);
      assert.equal(s.agent, name!.startsWith("temporal") ? "research-worker" : "research-app", name);
      assert.deepEqual(shape(s.stats.durable!), ["plan:1", "search:1✗,2", read, "write:1"], name);
      assert.ok(s.flags.includes("step-retried") && s.flags.includes("resumed"), name);
      // Engine root spans (deliveries, StartWorkflow, recovery writes) are not turns.
      assert.equal(s.stats.turns, 0, name);
      // Model calls stay under their step attempts (no dropped span between them).
      const t = buildWorkflowTree({ spans: await store.listEvents(s.id), runId: s.id });
      assert.ok(t.nodes.filter((n) => n.kind === "step" && !n.lost).every((n) => (n.usage?.inputTokens ?? 0) > 0), name);
    }
  });

  it("builds the workflow tree: attempts as steps, the lost attempt, waits as gaps", async () => {
    const vercel = (await mapBodies(capture("vercel-workflow"))).get("wrun_01M6VR4652F71REEM5KNF4TQ95")!;
    const t = buildWorkflowTree({ spans: vercel, runId: "wrun_01M6VR4652F71REEM5KNF4TQ95" });
    assert.equal(t.run.framework, "vercel-workflow");
    assert.equal(t.run.name, "researchAgent");
    const steps = t.nodes.filter((n) => n.kind === "step");
    assert.deepEqual(
      steps.map((n) => `${n.name}#${n.attempt}/${n.attempts} ${n.status}${n.resume ? ` ${n.resume}` : ""}`),
      ["plan#1/1 ok", "search#1/2 failed", "search#2/2 ok", "read#1/2 failed", "read#2/2 ok crash", "write#1/1 ok deploy"],
    );
    assert.equal(t.nodes.filter((n) => n.kind === "wait").length, 1);
    assert.equal(t.nodes.filter((n) => n.kind === "phase").length, 0);
    // Model calls sit under their step attempts.
    assert.ok(t.nodes.filter((n) => n.kind === "llm").every((n) => steps.some((s) => s.id === n.parentId)));
    assert.deepEqual(steps.map((n) => n.usage?.inputTokens), [400, 300, 300, undefined, 900, 1200]);
    const st = t.run.stats;
    assert.equal(st.stepRetries, 2);
    assert.equal(st.failedAgents, 0, "a retried attempt is not a failure");
    assert.ok(st.waitMs! > 6_000);
    // The sleep sits on the critical path; it is waiting, not orchestration overhead.
    assert.ok(st.orchestrationGapMs! < st.criticalPathMs! - st.waitMs!);
    const tsv = ganttTsv(buildGantt(t.run, t.nodes)).split("\n");
    assert.equal(tsv[0]!.split("\t").slice(-2).join(","), "kind,resume");
    assert.deepEqual(
      tsv.slice(1, -1).map((l) => l.split("\t")).map((c) => `${c[1]} ${c[10]} ${c[11]}`.trim()),
      ["plan attempt", "search #1 attempt", "search #2 attempt", "read #1 lost", "read #2 attempt crash", "wait wait", "write attempt deploy"],
    );

    const temporal = (await mapBodies(capture("temporal"))).values().next().value!;
    const tt = buildWorkflowTree({ spans: temporal, runId: "temporal-run" });
    assert.equal(tt.run.framework, "temporal");
    const lost = tt.nodes.find((n) => n.lost)!;
    assert.equal(`${lost.name}#${lost.attempt} ${lost.status}`, "read#1 failed");
    assert.equal(tt.nodes.find((n) => n.kind === "step" && n.name === "read" && !n.lost)!.resume, "crash");
    assert.equal(tt.run.stats.stepRetries, 2);
    // The lost attempt is work only until its worker was last seen; the rest is downtime, not agent time.
    const read = durableStats([...temporal].sort((a, b) => a.ts - b.ts))!.steps.find((s) => s.name === "read")!;
    const lead = read.unreportedMs!;
    assert.ok(lead > 10_000);
    assert.ok(read.unreportedRanMs! < 1_000, "busy capped at the killed worker's last export");
    assert.equal(lost.endedAt! - lost.startedAt!, read.unreportedRanMs);
    assert.equal(lost.endedAt! - lost.startedAt! + lost.lostMs!, lead);
    assert.equal(tt.run.stats.lostMs, lost.lostMs);
    const busy = tt.nodes.filter((n) => n.kind === "step").reduce((a, n) => a + (n.endedAt! - n.startedAt!), 0);
    assert.equal(tt.run.stats.agentMs, busy);
    assert.ok(tt.run.stats.agentMs < lead, "agent time leaves out the downtime");
    assert.ok(tt.run.stats.orchestrationGapMs! < tt.run.stats.criticalPathMs! - lost.lostMs!);
    assert.ok(renderTree(tt.nodes, false).some((l) => /step read #1 +failed .*lost, then down \d/.test(l)));
    assert.match(durableSteps(durableStats([...temporal].sort((a, b) => a.ts - b.ts))!, 0).join("\n"), /read +ok +1 lost \(its process stopped; seen \S+, then down \S+\)/);
  });
});

// ---------------------------------------------------------------- the other engines

/** Posts a capture through a collector; its sessions, the durable one first. */
async function collect(name: string) {
  const store = new MemIndex();
  const r = await startReceiver({ port: 0, store, blobs: new MemBlobs() });
  try {
    for (const b of capture(name)) assert.equal((await post(`${r.url}/v1/traces`, b)).status, 200, name);
  } finally {
    await r.close();
  }
  const sessions = (await store.listSessions()).sort((a, b) => Number(!a.stats.durable) - Number(!b.stats.durable));
  return { store, sessions };
}

const LOST_READ = "read:+12";
const ENGINES: { name: string; engine: string; steps: string[]; waits: string[]; resumes: string[]; title: string; failed: string }[] = [
  { name: "inngest", engine: "inngest", steps: ["plan:1", "search:1✗,2", LOST_READ, "write:1"], waits: [], resumes: ["crash@read", "deploy@write 1→2"], title: "inngest run 01M6VTR3561VS97TPW0AB6AZ4V", failed: "" },
  { name: "restate", engine: "restate", steps: ["plan:1", "search:1✗,2", LOST_READ, "write:1"], waits: ["cooldown"], resumes: ["crash@read", "deploy@write 1→2"], title: "researchAgent", failed: "search API returned 503" },
  { name: "dbos", engine: "dbos", steps: ["plan:1,1,1", "search:1✗,2,2,2", "read:1,1", "write:1"], waits: [], resumes: ["restart@read", "deploy@write 1→2"], title: "researchAgent", failed: "search API returned 503" },
  { name: "langgraph-openinference", engine: "langgraph", steps: ["plan:1", "search:1✗,2", LOST_READ, "review:1", "write:1"], waits: ["interrupt"], resumes: ["crash@read", "deploy@review 1→2"], title: "researchAgent", failed: "search API returned 503" },
  { name: "langgraph-langsmith", engine: "langgraph", steps: ["plan:1", "search:1✗,2", LOST_READ, "review:1", "write:1"], waits: ["interrupt"], resumes: ["crash@read", "deploy@review 1→2"], title: "researchAgent", failed: "search API returned 503" },
  { name: "cloudflare-workflows", engine: "workflow", steps: ["plan:1", "search:1✗,2", LOST_READ, "write:1"], waits: ["pause"], resumes: ["crash@read", "deploy@write 1→2"], title: "researchAgent", failed: "search API returned 503" },
];

describe("durable workflow runs from real captures of the other engines", () => {
  for (const x of ENGINES) {
    it(`${x.name}: one session with its steps, attempts, waits and resumes`, async () => {
      const { store, sessions } = await collect(x.name);
      const s = sessions[0]!;
      const d = s.stats.durable!;
      assert.equal(d.engine, x.engine);
      // Restate's client span is the user's own, exported before any span names the run.
      assert.equal(sessions.filter((o) => o.stats.durable).length, 1, sessions.map((o) => o.id).join(", "));
      assert.equal(sessions.length, x.name === "restate" ? 2 : 1, sessions.map((o) => o.id).join(", "));
      assert.equal(s.title, x.title);
      assert.equal(s.agent, "research-app");
      assert.deepEqual(shape(d), x.steps);
      assert.deepEqual(d.waits.map((w) => w.name), x.waits);
      for (const w of d.waits) assert.ok(w.endedAt! - w.startedAt >= 5_900, `${w.name} ${w.endedAt! - w.startedAt}`);
      assert.deepEqual(resumes(d).filter((r) => !r.startsWith("wait")), x.resumes);
      assert.equal(d.instances, 3);
      assert.deepEqual(s.flags.filter((f) => f === "step-retried" || f === "resumed"), ["step-retried", "resumed"]);
      assert.deepEqual(s.stats.usage && { i: s.stats.usage.inputTokens, o: s.stats.usage.outputTokens }, { i: 3100, o: 540 });
      const failed = d.steps.flatMap((st) => st.attempts).filter((a) => !a.ok);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.error ?? "", x.failed);
      // A lost read is drawn from when its process was last seen to the retry; it is not agent time.
      const read = d.steps.find((st) => st.name === "read")!;
      if (read.unreported) assert.ok(read.unreportedMs! > 0 && read.unreportedRanMs! < read.unreportedMs!);

      const t = buildWorkflowTree({ spans: await store.listEvents(s.id), runId: s.id });
      assert.equal(t.run.framework, x.engine === "workflow" ? "otel" : x.engine);
      // Every step but review (it only waits for the human) calls the model.
      assert.ok(t.nodes.filter((n) => n.kind === "step" && !n.lost && n.status !== "cached" && n.name !== "review").every((n) => (n.usage?.inputTokens ?? 0) > 0), "model calls under their step attempts");
      // The failed search attempt is its own node, even when the engine keeps both attempts in one span (DBOS).
      const search = t.nodes.filter((n) => n.kind === "step" && n.name === "search" && n.status !== "cached");
      assert.deepEqual(search.map((n) => `${n.attempt}:${n.status}`), ["1:failed", "2:ok"]);
      assert.equal(t.run.stats.stepRetries, d.retries);
      assert.equal(t.run.stats.failedAgents, 0);
      assert.equal(t.nodes.filter((n) => n.kind === "wait").length, x.waits.length);
      if (read.unreported) assert.equal(t.run.stats.lostMs, read.unreportedMs! - read.unreportedRanMs!);
    });
  }

  it("DBOS: the failed attempt ends at its event and the retry starts after the retry interval", async () => {
    const { sessions } = await collect("dbos");
    const search = sessions[0]!.stats.durable!.steps.find((s) => s.name === "search")!;
    const [a1, a2] = search.attempts;
    assert.ok(a1!.endedAt - a1!.startedAt > 100 && a1!.endedAt - a1!.startedAt < 1_000);
    assert.ok(a2!.startedAt - a1!.endedAt >= 1_000, "retryIntervalSeconds 1");
    assert.equal(sessions[0]!.stats.durable!.replays, 5);
  });
});

// ---------------------------------------------------------------- hand-written spans

const T0 = 1767225600000n;
const ns = (ms: number) => String((T0 + BigInt(ms)) * 1_000_000n);
type A = [string, string | number | boolean];
const attrs = (kv: A[]) => kv.map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : { intValue: String(v) } }));
/** Readable ids in the tests, hex on the wire. */
const hex = (s: string, len: number) => Buffer.from(s).toString("hex").padStart(len, "0");
function span(trace: string, id: string, parent: string | undefined, name: string, kv: A[], start: number, end: number, extra: J = {}): J {
  return { traceId: hex(trace, 32), spanId: hex(id, 16), ...(parent ? { parentSpanId: hex(parent, 16) } : {}), name, kind: 1, startTimeUnixNano: ns(start), endTimeUnixNano: ns(end), attributes: attrs(kv), status: {}, ...extra };
}
const body = (scope: string, resource: A[], spans: J[]): J => ({ resourceSpans: [{ resource: { attributes: attrs(resource) }, scopeSpans: [{ scope: { name: scope }, spans }] }] });
const llm = (trace: string, id: string, parent: string, start: number, input: number): J =>
  span(trace, id, parent, "chat gpt-4o-mini", [["gen_ai.operation.name", "chat"], ["gen_ai.request.model", "gpt-4o-mini"], ["gen_ai.usage.input_tokens", input], ["gen_ai.usage.output_tokens", 10]], start, start + 100);

describe("durable workflow runs from hand-written spans", () => {
  it("a replayed workflow function's model calls are not counted again", async () => {
    const run: A = ["workflow.run.id", "wrun_replay"];
    const by = await mapBodies([
      body("workflow", [["service.instance.id", "a"]], [
        span("a1", "s1", undefined, "workflow.run flow", [run, ["workflow.execution.mode", "live"]], 0, 500),
        llm("a1", "l1", "s1", 100, 1000),
      ]),
      body("workflow", [["service.instance.id", "a"]], [
        span("b1", "s2", undefined, "workflow.run flow", [run, ["workflow.execution.mode", "replay"]], 5_000, 5_400),
        llm("b1", "l2", "s2", 5_100, 1000),
      ]),
    ]);
    assert.deepEqual([...by.keys()], ["wrun_replay"]);
    const s = buildSession(by.get("wrun_replay")!);
    assert.equal(s.stats.usage?.inputTokens, 1000);
    assert.equal(s.stats.duplicateUsage?.calls, 1);
    assert.equal(s.stats.durable?.replayedCalls, 1);
  });

  it("an explicit conversation id outranks the run id", async () => {
    const by = await mapBodies([
      body("workflow", [], [span("c1", "s1", undefined, "step.execute plan", [["workflow.run.id", "wrun_x"], ["gen_ai.conversation.id", "conv-1"], ["step.name", "plan"]], 0, 10)]),
    ]);
    assert.deepEqual([...by.keys()], ["conv-1"]);
    assert.equal(buildSession(by.get("conv-1")!).stats.durable?.runId, "wrun_x");
  });

  it("the hand-rolled convention: workflow.run.id + step.name, a gap in step.attempt is an unreported attempt", async () => {
    const run: A = ["workflow.run.id", "run-42"];
    const by = await mapBodies([
      body("my-app", [["service.instance.id", "w1"]], [
        span("t1", "s1", undefined, "fetch", [run, ["step.name", "fetch"], ["step.id", "f"], ["step.attempt", 1]], 0, 100, { status: { code: 2, message: "boom" } }),
      ]),
      body("my-app", [["service.instance.id", "w1"]], [span("t2", "s2", undefined, "fetch", [run, ["step.name", "fetch"], ["step.id", "f"], ["step.attempt", 3]], 9_000, 9_100)]),
    ]);
    const d = buildSession(by.get("run-42")!).stats.durable!;
    assert.equal(d.engine, "workflow");
    assert.deepEqual(shape(d), ["fetch:+11✗,3"]);
    assert.equal(d.retries, 2);
  });

  it("Inngest counts attempts from 0; DBOS reports failed attempts as span events", async () => {
    const inn = await mapBodies([
      body("inngest", [], [
        span("i1", "s1", undefined, "inngest.execution", [["sdk.run.id", "01RUN"], ["sys.function.id", "app-agent"]], 0, 1_000),
        span("i1", "s2", "s1", "step", [["sdk.run.id", "01RUN"], ["inngest.step.id", "summarize"], ["inngest.step.attempt", 1]], 100, 200),
      ]),
    ]);
    const di = buildSession(inn.get("inngest:01RUN")!).stats.durable!;
    assert.deepEqual(shape(di), ["summarize:+12"]);
    assert.equal(di.workflow, "app-agent");

    const dbos = await mapBodies([
      body("dbos-tracer", [], [
        span("d1", "s1", undefined, "agentWorkflow", [["operationUUID", "wf-1"], ["operationType", "workflow"], ["operationName", "agentWorkflow"]], 0, 1_000),
        span("d1", "s2", "s1", "callModel", [["operationUUID", "wf-1"], ["operationType", "step"], ["operationName", "callModel"]], 100, 900, {
          events: [{ timeUnixNano: ns(200), name: "Step attempt 1 failed", attributes: [] }],
        }),
      ]),
    ]);
    const dd = buildSession(dbos.get("dbos:wf-1")!).stats.durable!;
    assert.deepEqual(shape(dd), ["callModel:1✗,2"]);
    assert.equal(dd.retries, 1);
  });
});
