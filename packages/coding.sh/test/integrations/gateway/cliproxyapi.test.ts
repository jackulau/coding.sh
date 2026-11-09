// CLIProxyAPI as a gateway source: a stub management API serves usage-queue
// records (the shape recorded from a real CLIProxyAPI, fixtures/cliproxyapi),
// `enrichFromCliProxyApi` drains it and joins the records to the Claude Code
// and Codex adapter fixtures' sessions.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRedactor } from "../../../src/core/redact.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import { accountHashOf, cliProxyBaseUrl, drainUsageQueue, enrichFromCliProxyApi, PENDING_KEY, usageRecordOf, USAGE_QUEUE_PATH } from "../../../src/integrations/gateway/cliproxyapi.ts";
import { detectGatewaySetups } from "../../../src/integrations/gateway/config.ts";
import { gatewayForUrl } from "../../../src/integrations/gateway/providers.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { MemoryIndexStore } from "../../../src/store/memory.ts";
import { SqliteIndexStore } from "../../../src/store/sqlite.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADAPTERS = join(HERE, "..", "..", "fixtures", "adapters");
const RECORDED = (JSON.parse(readFileSync(join(HERE, "fixtures", "cliproxyapi", "usage-queue.json"), "utf8")) as { records: Record<string, unknown>[] }).records;
const MGMT_KEY = ["mgmt", "test", "key"].join("-");
const CLIENT_KEY = ["sk", "client", "0123456789abcdef0123"].join("-");

// The adapter fixtures' sessions (test/fixtures/adapters/*/golden/backfill.golden.json).
const CC = "11111111-2222-4333-8444-555555555555";
const CC_SUB = `${CC}:sub:abc123`;
const CX_SUB = "0193bbbb-1111-7222-8333-444455556666";
const T0 = 1793527200000; // the fixtures' clock
const NOW = T0 + 3_600_000;

/** An adapter's golden events (the golden leaves out the fields every event of the run shares). */
function golden(agent: string): AgentEvent[] {
  const evs = JSON.parse(readFileSync(join(ADAPTERS, agent, "golden", "backfill.golden.json"), "utf8")) as Omit<AgentEvent, "v" | "agent" | "source">[];
  return evs.map((e) => ({ v: 0, agent, source: "transcript", ...e }) as AgentEvent);
}

async function fixtureIndex(): Promise<MemoryIndexStore> {
  const index = new MemoryIndexStore();
  const events = [...golden("claude-code"), ...golden("codex")];
  await index.putEvents(events);
  for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
  return index;
}

const callAt = (events: AgentEvent[], sessionId: string, ts: number) => events.find((e) => e.kind === "llm.call" && e.sessionId === sessionId && e.ts === ts)!;

/** A recorded queue record, moved to another request (time, session, model). */
function record(over: { startMs: number; latencyMs: number; sessionId?: string; model: string; extra?: Record<string, unknown> }): Record<string, unknown> {
  const r = structuredClone(RECORDED[0]!);
  r.timestamp = new Date(over.startMs).toISOString();
  r.latency_ms = over.latencyMs;
  r.model = over.model;
  r.alias = over.model;
  r.response_model = over.model;
  r.execution_id = `exec-${over.startMs}-${over.model}`;
  if (over.sessionId) r.session_id = over.sessionId;
  else delete r.session_id;
  return { ...r, ...over.extra };
}

interface Stub {
  url: string;
  queue: Record<string, unknown>[];
  requests: { path: string; auth?: string }[];
  v0Only: boolean;
  close(): Promise<void>;
}

/** CLIProxyAPI's management API, usage queue only: GET pops up to ?count= records. */
async function startStub(): Promise<Stub> {
  const s: Omit<Stub, "url" | "close"> = { queue: [], requests: [], v0Only: false };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    s.requests.push({ path: u.pathname + u.search, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const v8 = u.pathname === USAGE_QUEUE_PATH && !s.v0Only;
    if (!v8 && u.pathname !== "/v0/management/usage-queue") return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${MGMT_KEY}`) return send(401, { error: "invalid management key" });
    const count = Number(u.searchParams.get("count") ?? "1");
    send(200, s.queue.splice(0, count));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return Object.assign(s, { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
}

let stub: Stub;
before(async () => {
  stub = await startStub();
});
after(() => stub.close());

const drainFrom = (url: string, key = MGMT_KEY) => (keep: (r: unknown[]) => Promise<void>) => drainUsageQueue({ baseUrl: `${url}/v1`, key, onRecords: keep, batch: 2 });

describe("CLIProxyAPI usage queue", () => {
  it("reduces a recorded record to the fields coding.sh keeps", () => {
    const u = usageRecordOf(RECORDED[0]);
    assert.ok(u);
    assert.equal(typeof u.ts, "number");
    const text = JSON.stringify(u);
    for (const k of ["api_key", "apiKey", "client_ip", "clientIp", "user_agent", "userAgent", "x_forwarded_for", "access_token_sha256", "response_headers", "source"]) assert.ok(!text.includes(k), k);
    // The recorded `source` is the upstream key and `api_key` the client key (throwaway values from the capture config).
    for (const v of [RECORDED[0]!.source, RECORDED[0]!.api_key, RECORDED[0]!.user_agent]) assert.ok(!text.includes(String(v)), String(v));
    assert.deepEqual([u.sessionId, u.model, u.alias, u.serviceTier, u.reasoningEffort, u.inputTokens, u.outputTokens], ["11111111-2222-4333-8444-555555555555", "stub-model", "claude-opus-4-5", "auto", undefined, 120, 30]);
    if (typeof RECORDED[0]!.auth_index === "string" && RECORDED[0]!.auth_index) assert.equal(u.accountHash, accountHashOf(RECORDED[0]!.auth_index));
    assert.equal(accountHashOf("0A1B2C3D4E5F6789"), "0a1b2c3d4e5f6789", "a credential index is already a hash");
    assert.match(accountHashOf("claude-oauth-user@example.com.json"), /^[0-9a-f]{16}$/);
    assert.ok(!accountHashOf("claude-oauth-user@example.com.json").includes("example"));
  });

  it("joins the recorded records as recorded: the alias names the transcript's model", async () => {
    const index = await fixtureIndex();
    const before = golden("claude-code");
    // Only the clock moves: each request ends at a Claude Code fixture call (msg_01, msg_02).
    stub.queue = RECORDED.map((r, i) => ({ ...structuredClone(r), timestamp: new Date([T0, 1793527201600][i]! - Number(r.latency_ms)).toISOString() }));
    const r = await enrichFromCliProxyApi({ index, sessions: await index.listSessions({ limit: 100 }), drain: drainFrom(stub.url), redactor: createRedactor(), now: NOW });
    assert.deepEqual([r.errors, r.drained, r.joined, r.bySessionId, r.kept], [[], 2, 2, 2, 0]);
    const spans = (await index.listEvents(CC)).filter((e) => e.source === "gateway");
    assert.deepEqual(spans.map((e) => e.parentId).sort(), [callAt(before, CC, T0).id, callAt(before, CC, 1793527201600).id].sort());
    assert.deepEqual([spans[0]!.payload.model, spans[0]!.payload.alias, spans[0]!.payload.serviceTier, spans[0]!.payload.accountHash, spans[0]!.payload.provider], ["stub-model", "claude-opus-4-5", "auto", RECORDED[0]!.auth_index, "claude"]);
    assert.ok((await index.getSession(CC))!.flags.includes("gateway:cliproxyapi"));
    const again = await enrichFromCliProxyApi({ index, sessions: await index.listSessions({ limit: 100 }), drain: drainFrom(stub.url), now: NOW });
    assert.deepEqual([again.drained, again.joined, again.enriched], [0, 0, 0]);
  });

  it("joins drained records to fixture sessions, and a second drain adds nothing", async () => {
    const index = await fixtureIndex();
    const before = [...golden("claude-code"), ...golden("codex")];
    stub.queue = [
      // Claude Code main session: msg_01 (call at T0), by session id.
      record({ startMs: T0 - 1500, latencyMs: 1600, sessionId: CC, model: "claude-opus-4-5", extra: { reasoning_effort: "high", service_tier: "priority", effective_service_tier: "priority", speed: "fast", ttft_ms: 420, auth_index: "0a1b2c3d4e5f6789", api_key: CLIENT_KEY, client_ip: "203.0.113.9", cost_details: { cost: 0.0123, is_byok: false } } }),
      // Its subagent (session `<id>:sub:abc123`): Claude Code sends the parent's session id.
      record({ startMs: 1793527206100 - 900, latencyMs: 950, sessionId: CC, model: "claude-haiku-4-5", extra: { is_compaction: true } }),
      // A Codex subagent thread, by session id: its first gpt-5.5-mini call.
      record({ startMs: 1793527207000, latencyMs: 560, sessionId: CX_SUB, model: "gpt-5.5-mini" }),
      // No session id: the only free gpt-5.5-mini call at that time.
      record({ startMs: 1793527207800, latencyMs: 290, model: "gpt-5.5-mini" }),
      // No session id and two gpt-5 calls within 30 s: ambiguous, kept.
      record({ startMs: T0 + 700, latencyMs: 100, model: "gpt-5" }),
      // A session not captured yet: kept.
      record({ startMs: T0 + 40_000, latencyMs: 1000, sessionId: "99999999-8888-4777-8666-555555555555", model: "gpt-5.5" }),
    ];
    const sessions = await index.listSessions({ limit: 100 });
    const redactor = createRedactor();
    const r = await enrichFromCliProxyApi({ index, sessions, drain: drainFrom(stub.url), redactor, now: NOW });
    assert.deepEqual(r.errors, []);
    assert.equal(r.drained, 6);
    assert.equal(stub.queue.length, 0);
    assert.deepEqual([r.joined, r.bySessionId, r.byTimeModel, r.enriched, r.kept], [4, 3, 1, 4, 2]);
    assert.equal(r.billedUsd, 0.0123);
    // The management key went as a Bearer token to the v8 route on the server's origin.
    assert.ok(stub.requests.every((q) => q.auth === `Bearer ${MGMT_KEY}`));
    assert.ok(stub.requests.every((q) => q.path.startsWith(`${USAGE_QUEUE_PATH}?count=2`)));

    const spans = async (sessionId: string) => (await index.listEvents(sessionId)).filter((e) => e.source === "gateway");
    const [main] = await spans(CC);
    assert.equal(main!.parentId, callAt(before, CC, T0).id);
    assert.equal(main!.kind, "span");
    assert.deepEqual(
      Object.fromEntries(["gateway", "linkedBy", "reasoningEffort", "serviceTier", "speed", "ttftMs", "accountHash", "billedCostUsd", "isByok"].map((k) => [k, main!.payload[k]])),
      { gateway: "cliproxyapi", linkedBy: "client-session-id", reasoningEffort: "high", serviceTier: "priority", speed: "fast", ttftMs: 420, accountHash: "0a1b2c3d4e5f6789", billedCostUsd: 0.0123, isByok: false },
    );
    assert.equal(main!.usage?.costUsd, 0.0123, "the upstream cost is added once (the call reported none)");
    const [sub] = await spans(CC_SUB);
    assert.equal(sub!.parentId, callAt(before, CC_SUB, 1793527206100).id);
    assert.equal(sub!.payload.isCompaction, true);
    const cx = await spans(CX_SUB);
    assert.deepEqual(cx.map((e) => [e.parentId, e.payload.linkedBy]).sort(), [
      [callAt(before, CX_SUB, 1793527207570).id, "client-session-id"],
      [callAt(before, CX_SUB, 1793527208100).id, "time-model"],
    ].sort());
    for (const id of [CC, CC_SUB, CX_SUB]) assert.ok((await index.getSession(id))!.flags.includes("gateway:cliproxyapi"), id);
    assert.ok(!(await index.getSession("0193cccc-1111-7222-8333-444455556666"))!.flags.includes("gateway:cliproxyapi"), "the ambiguous record joined nothing");

    // Nothing that identifies the client was stored: not in the events, not in the kept records.
    const stored = JSON.stringify([...(await index.listEvents(CC)), ...(await index.listEvents(CX_SUB))]) + ((await index.kvGet!(PENDING_KEY)) ?? "");
    for (const s of [CLIENT_KEY, "203.0.113.9", MGMT_KEY]) assert.ok(!stored.includes(s), s);
    assert.equal(JSON.parse((await index.kvGet!(PENDING_KEY))!).length, 2);

    // The second drain finds an empty queue and writes nothing.
    const count = async () => (await Promise.all([CC, CC_SUB, CX_SUB].map((id) => index.listEvents(id)))).flat().length;
    const n = await count();
    const again = await enrichFromCliProxyApi({ index, sessions, drain: drainFrom(stub.url), redactor, now: NOW });
    assert.deepEqual([again.drained, again.carried, again.joined, again.enriched, again.kept], [0, 2, 0, 0, 2]);
    assert.equal(await count(), n);
  });

  it("keeps popped records until their session is captured, redacted", async () => {
    const index = new MemoryIndexStore();
    const secret = ["sk-ant-api03-", "B".repeat(80), "BB"].join("");
    stub.queue = [record({ startMs: T0 - 1500, latencyMs: 1600, sessionId: CC, model: "claude-opus-4-5", extra: { endpoint: `POST /v1/messages?key=${secret}` } })];
    const first = await enrichFromCliProxyApi({ index, sessions: [], drain: drainFrom(stub.url), redactor: createRedactor(), now: NOW });
    assert.deepEqual([first.drained, first.joined, first.kept], [1, 0, 1]);
    const kept = (await index.kvGet!(PENDING_KEY))!;
    assert.ok(!kept.includes(secret));
    assert.match(kept, /\[redacted:/);

    // The transcript arrives; a run without a drain (--offline) joins the kept record.
    const events = golden("claude-code");
    await index.putEvents(events);
    for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
    const second = await enrichFromCliProxyApi({ index, sessions: await index.listSessions({ limit: 100 }), now: NOW });
    assert.deepEqual([second.drained, second.carried, second.joined, second.kept], [0, 1, 1, 0]);
    const span = (await index.listEvents(CC)).find((e) => e.source === "gateway")!;
    assert.ok(!JSON.stringify(span).includes(secret));
    assert.equal(JSON.parse((await index.kvGet!(PENDING_KEY))!).length, 0);
  });

  it("drops a kept record after a day, and leaves the queue alone with --dry-run", async () => {
    const index = await fixtureIndex();
    stub.queue = [record({ startMs: T0, latencyMs: 10, sessionId: "99999999-8888-4777-8666-555555555555", model: "gpt-5.5" })];
    await enrichFromCliProxyApi({ index, sessions: [], drain: drainFrom(stub.url), now: NOW });
    stub.queue = [record({ startMs: T0, latencyMs: 10, sessionId: CC, model: "claude-opus-4-5" })];
    stub.requests = [];
    const dry = await enrichFromCliProxyApi({ index, sessions: [], drain: drainFrom(stub.url), dryRun: true, now: T0 + 2 * 86_400_000 });
    assert.equal(stub.requests.length, 0, "--dry-run never reads the queue");
    assert.equal(stub.queue.length, 1);
    assert.deepEqual([dry.carried, dry.expired, dry.kept], [1, 1, 0]);
    stub.queue = [];
  });

  it("falls back to the v0 route, and reports a refused key without losing records", async () => {
    stub.v0Only = true;
    stub.requests = [];
    stub.queue = [RECORDED[0]!];
    const got = await drainUsageQueue({ baseUrl: stub.url, key: MGMT_KEY });
    assert.equal(got.path, "/v0/management/usage-queue");
    assert.equal(got.records.length, 1);
    stub.v0Only = false;

    const index = new MemoryIndexStore();
    stub.queue = [RECORDED[0]!];
    const r = await enrichFromCliProxyApi({ index, sessions: [], drain: drainFrom(stub.url, "wrong-key"), now: NOW });
    assert.deepEqual(r.errors, ["CLIProxyAPI refused the management key (401)"]);
    assert.equal(stub.queue.length, 1, "a refused read pops nothing");
    const down = await enrichFromCliProxyApi({ index, sessions: [], drain: drainFrom("http://127.0.0.1:9"), now: NOW });
    assert.match(down.errors[0]!, /^could not reach CLIProxyAPI at http:\/\/127\.0\.0\.1:9/);
    stub.queue = [];
  });

  it("detects CLIProxyAPI by its port or its URL variable", () => {
    assert.equal(gatewayForUrl("http://127.0.0.1:8317"), "cliproxyapi");
    assert.equal(gatewayForUrl("http://localhost:8317/v1"), "cliproxyapi");
    assert.equal(gatewayForUrl("https://proxy.internal/v1", { CLIPROXYAPI_URL: "https://proxy.internal" }), "cliproxyapi");
    assert.equal(gatewayForUrl("http://localhost:4000"), undefined);
    assert.equal(gatewayForUrl("https://openrouter.ai:8317/api"), "openrouter", "a known host wins over the port");
    const found = detectGatewaySetups({ HOME: "/nonexistent", CODEX_HOME: "/nonexistent", CLAUDE_CONFIG_DIR: "/nonexistent", ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
    assert.deepEqual(found.map((f) => [f.gateway, f.agent, f.detail]), [["cliproxyapi", "claude-code", "ANTHROPIC_BASE_URL → 127.0.0.1"]]);
    assert.equal(cliProxyBaseUrl("http://127.0.0.1:8317", { OPENAI_BASE_URL: "http://10.0.0.5:8317/v1" }), "http://10.0.0.5:8317/v1");
    assert.equal(cliProxyBaseUrl("https://cpa.example.com", { OPENAI_BASE_URL: "http://10.0.0.5:8317/v1" }), "https://cpa.example.com");
    assert.equal(cliProxyBaseUrl("http://127.0.0.1:8317", {}), "http://127.0.0.1:8317");
  });

  it("runs as `coding.sh gateway enrich --gateway cliproxyapi`, and status names it", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-cpa-cli-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const env: Record<string, string> = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), PATH: dirname(process.execPath), TMPDIR: tmpdir(), NO_COLOR: "1", CLIPROXYAPI_URL: stub.url };
      mkdirSync(env.CODING_SH_HOME!);
      const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
      await index.migrate();
      const events = golden("claude-code");
      await index.putEvents(events);
      for (const id of new Set(events.map((e) => e.sessionId))) await index.upsertSession(buildSession(await index.listEvents(id)));
      await index.close();
      const MAIN = fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url));
      const cli = (args: string[], extra: Record<string, string> = {}) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
          execFile(process.execPath, ["--no-warnings", MAIN, ...args], { env: { ...env, ...extra }, cwd: home, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })),
        );

      const noKey = await cli(["gateway", "enrich", "--gateway", "cliproxyapi", "--since", "3650d", "--json"]);
      assert.equal(noKey.code, 1);
      assert.match(noKey.stdout + noKey.stderr, /missing_key/);

      stub.requests = [];
      stub.queue = RECORDED.map((r, i) => ({ ...structuredClone(r), timestamp: new Date([T0, 1793527201600][i]! - Number(r.latency_ms)).toISOString() }));
      const keyed = { CLIPROXYAPI_MANAGEMENT_KEY: MGMT_KEY };
      const dry = await cli(["gateway", "enrich", "--gateway", "cliproxyapi", "--since", "3650d", "--dry-run"], keyed);
      assert.equal(dry.code, 0, dry.stderr);
      assert.equal(stub.requests.length, 0, "--dry-run does not read the queue");
      assert.doesNotMatch(dry.stderr, /removes the records/);

      const run = await cli(["gateway", "enrich", "--gateway", "cliproxyapi", "--since", "3650d"], keyed);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stderr, /removes the records it returns: other readers \(Usage Keeper, tokenlayer\) will not get them/);
      assert.match(run.stderr, /read 2 records from http:\/\/127\.0\.0\.1:\d+/);
      assert.match(run.stderr, /2 records to llm calls \(2 by session id, 0 by time and model\)/);
      assert.ok(!(run.stdout + run.stderr).includes(MGMT_KEY), "the key is never printed");

      const again = await cli(["gateway", "enrich", "--gateway", "cliproxyapi", "--since", "3650d", "--json"], keyed);
      assert.equal(again.code, 0, again.stderr);
      const doc = JSON.parse(again.stdout) as { drained: boolean; report: { drained: number; joined: number; enriched: number } };
      assert.deepEqual([doc.drained, doc.report.drained, doc.report.joined, doc.report.enriched], [true, 0, 0, 0]);

      const status = await cli(["gateway", "status", "--gateway", "cliproxyapi"], keyed);
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stderr, /CLIProxyAPI\s+key set \(env CLIPROXYAPI_MANAGEMENT_KEY\); usage queue drain with --gateway cliproxyapi; 1 session tagged gateway:cliproxyapi/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
