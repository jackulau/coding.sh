// AA-21: `toolevals traces` exports an MCP server's trajectories and per-tool
// health from captured agent sessions and tool-eval trials. Sessions are shaped
// as the Claude Code transcript adapter writes them (tool.start with
// payload.server, tool.end with ok/output); trials carry their tap in a blob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/core/config.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { BlobStore, IndexStore } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { buildTraceWorkspace, errorClass, TraceError, writeTraceWorkspace } from "../../src/toolevals/traces.ts";
import type { McpTool, TapRecord, TrialResult } from "../../src/toolevals/types.ts";
import { metrics } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmpDir = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
type Call = [tool: string, ok: boolean, input: Record<string, unknown>, output: string];

/** A Claude Code session as the transcript adapter writes it. */
function claudeSession(id: string, start: number, calls: Call[], extra: Partial<AgentEvent> = {}): AgentEvent[] {
  let n = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>, dt: number): AgentEvent => ({ id: `${id}-${n++}`.padEnd(16, "0"), v: 0, sessionId: id, ts: start + dt, agent: "claude-code", kind, source: "transcript", cwd: "/work/demo", payload, ...extra });
  const out = [ev("session.start", {}, 0), ev("user.message", { text: "Find the release notes" }, 10)];
  calls.forEach(([tool, ok, input, output], i) => {
    const toolUseId = `toolu_${id}_${i}`;
    const m = /^mcp__([^_]+)__/.exec(tool);
    out.push(ev("tool.start", { tool, toolUseId, input, ...(m ? { server: m[1] } : {}) }, 100 + i * 100));
    out.push(ev("tool.end", { tool, toolUseId, ok, output }, 150 + i * 100));
  });
  out.push(ev("assistant.message", { text: "Done." }, 100 + calls.length * 100 + 10));
  out.push(ev("session.end", {}, 100 + calls.length * 100 + 20));
  return out;
}

const SEARCH = "mcp__acme__search";
const SESSIONS: AgentEvent[][] = [
  claudeSession("sess-a", NOW - 2 * DAY, [[SEARCH, true, { q: "notes" }, "3 results"], ["Read", true, { file_path: "/work/demo/a.md" }, "ok"]]),
  // Two failures, then a retry that works.
  claudeSession("sess-b", NOW - 3 * DAY, [
    [SEARCH, false, { q: 7 }, "Error: invalid arguments: expected string, received number"],
    [SEARCH, false, { q: "7" }, "Error: upstream timed out"],
    [SEARCH, true, { q: "release 7" }, "1 result"],
  ]),
  claudeSession("sess-c", NOW - 4 * DAY, [[SEARCH, true, { q: "notes" }, "3 results"], [SEARCH, true, { q: "notes" }, "3 results"]]),
  // Another server: never part of acme's traces.
  claudeSession("sess-d", NOW - 1 * DAY, [["mcp__other__x", false, {}, "Error: boom"]]),
  // Older than 30 days.
  claudeSession("sess-old", NOW - 60 * DAY, [[SEARCH, false, { q: "old" }, "Error: gone"]]),
];

const tap = (tool: string, cls: TapRecord["class"], ts: number, args: Record<string, unknown> = {}, reason?: string): TapRecord => ({ ts, durationMs: 5, target: "mcp", class: cls, method: "tools/call", tool, args, ...(reason ? { reason } : {}), responseBytes: 120 });

async function trialOf(blobs: BlobStore, index: IndexStore, id: string, taskId: string, pass: boolean, records: TapRecord[], variant = "base"): Promise<TrialResult> {
  const sid = `${id}-session`;
  const events = claudeSession(sid, NOW - DAY, [], { runId: id });
  await index.putEvents(events);
  await index.upsertSession(buildSession(events));
  const tapBlob = await blobs.put(records.map((r) => JSON.stringify(r)).join("\n") + "\n", { contentType: "application/x-ndjson" });
  return { id, experimentId: "texp_tr", taskId, variant, driver: "agent:claude-code", attempt: 1, sessionId: sid, childSessionIds: [], pass, checks: [{ kind: "output", pass }, { kind: "calls", pass: true }], metrics: metrics({ success: pass }), startedAt: 0, endedAt: 1, tapBlob };
}

async function seeded() {
  const index = new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  for (const events of SESSIONS) {
    await index.putEvents(events);
    await index.upsertSession(buildSession(events));
  }
  return { index, blobs };
}

const TOOLS: McpTool[] = [
  { name: "search", description: "Search", inputSchema: { type: "object" } },
  { name: "fetch_doc", description: "Fetch a doc", inputSchema: { type: "object" } },
];

describe("toolevals traces: sessions", () => {
  it("acceptance: search calls, 2 errors, the failed session, 1 retry after an error, no other server", async () => {
    const { index, blobs } = await seeded();
    const ws = await buildTraceWorkspace({ index, blobs, server: "acme", sessions: "since:30d", now: NOW });
    const search = ws.health.find((h) => h.tool === "search")!;
    assert.equal(search.calls, 6);
    assert.equal(search.errors, 2);
    assert.equal(search.retriedAfterError, 1);
    assert.equal(search.repeatedIdenticalCalls, 1, "sess-c called search twice with the same arguments");
    assert.deepEqual(search.invalidKinds, { schema: 1 });
    assert.equal(search.sampleFailures.length, 2);
    assert.equal(search.sampleFailures[0]!.trace, "session-sess-b");
    assert.ok(ws.health.every((h) => h.tool !== "x"), "the other server's tool is absent");
    assert.deepEqual(ws.traces.map((t) => [t.id, t.outcome]), [["session-sess-b", "failed"], ["session-sess-a", "ok"], ["session-sess-c", "ok"]]);
    assert.ok(!ws.traces.some((t) => t.id.includes("sess-d") || t.id.includes("sess-old")));
    const b = ws.traces[0]!;
    assert.equal(b.targetCalls, 3);
    assert.equal(b.targetErrors, 2);
    assert.match(b.markdown, /\[TARGET tool=search ok=false class=invalid reason=schema\]/);
    assert.match(b.markdown, /\[TARGET tool=search ok=false class=failed reason=timeout\]/);
    assert.match(b.markdown, /\[TARGET tool=search ok=true class=ok\]/);
  });

  it("sorts session error text into the tap's kinds", () => {
    assert.deepEqual(errorClass("Unknown tool: serch"), { class: "invalid", reason: "unknown-tool" });
    assert.deepEqual(errorClass("permission denied"), { class: "failed", reason: "denied" });
  });

  it("uncalled tools are neverCalled; output is deterministic", async () => {
    const { index, blobs } = await seeded();
    const a = await buildTraceWorkspace({ index, blobs, server: "acme", sessions: "since:30d", tools: TOOLS, now: NOW });
    const b = await buildTraceWorkspace({ index, blobs, server: "acme", sessions: "since:30d", tools: TOOLS, now: NOW });
    assert.deepEqual(a, b);
    const fetchDoc = a.health.find((h) => h.tool === "fetch_doc")!;
    assert.equal(fetchDoc.neverCalled, true);
    assert.equal(fetchDoc.calls, 0);
    assert.equal(fetchDoc.errorRate, null);
    assert.equal(a.health.find((h) => h.tool === "search")!.neverCalled, false);
  });

  it("skips a trace that holds an unredacted secret", async () => {
    const { index, blobs } = await seeded();
    const key = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const events = claudeSession("sess-leak", NOW - DAY, [[SEARCH, true, { q: key }, "1 result"]]);
    await index.putEvents(events);
    await index.upsertSession(buildSession(events));
    const ws = await buildTraceWorkspace({ index, blobs, server: "acme", sessions: "since:30d", now: NOW });
    assert.ok(!ws.traces.some((t) => t.id === "session-sess-leak"));
    assert.ok(ws.notes.some((n) => n.includes("sess-leak") && n.includes("unredacted")));
  });
});

describe("toolevals traces: trials", () => {
  async function experiment() {
    const { index, blobs } = await seeded();
    const trials = [
      await trialOf(blobs, index, "trial_1", "dev-1", false, [tap("search", "invalid", 1, { q: 1 }, "schema"), tap("search", "ok", 2, { q: "1" })]),
      await trialOf(blobs, index, "trial_2", "dev-2", true, [tap("search", "ok", 1, { q: "a" })]),
      await trialOf(blobs, index, "trial_3", "dev-1", true, [tap("search", "ok", 1, { q: "b" })]),
      await trialOf(blobs, index, "trial_4", "dev-2", true, [tap("search", "ok", 1, { q: "c" })]),
      await trialOf(blobs, index, "trial_5", "dev-1", true, [tap("search", "ok", 1, { q: "d" })]),
      await trialOf(blobs, index, "trial_6", "held-1", false, [tap("search", "failed", 1, { q: "secret held-out" }, "tool-error")]),
      await trialOf(blobs, index, "trial_7", "held-1", true, [tap("search", "ok", 1)], "terse"),
    ];
    const meta = { id: "texp_tr", target: { name: "acme", kind: "mcp" }, tasks: [{ id: "dev-1", split: "dev" }, { id: "dev-2", split: "dev" }, { id: "held-1", split: "heldout" }] };
    return { index, blobs, experiment: { id: "texp_tr", meta, trials } };
  }

  it("exports dev trials only, failing first and at most 3 passing, with the trial checks", async () => {
    const { index, blobs, experiment: exp } = await experiment();
    const ws = await buildTraceWorkspace({ index, blobs, server: "acme", experiment: exp, arm: "base@agent:claude-code", now: NOW });
    assert.deepEqual(ws.traces.map((t) => t.id), ["trial-trial_1", "trial-trial_2", "trial-trial_3", "trial-trial_4"]);
    assert.equal(ws.matched, 5);
    assert.ok(ws.notes.some((n) => n.includes("held-out")));
    assert.ok(ws.notes.some((n) => n.includes("kept 3 of 4 passing")));
    assert.ok(!ws.traces.some((t) => t.taskId === "held-1"));
    assert.ok(!ws.traces.some((t) => t.markdown.includes("secret held-out")));
    const t1 = ws.traces[0]!;
    assert.equal(t1.outcome, "fail");
    assert.equal(t1.reward, 0.5);
    assert.match(t1.markdown, /## Checks\n\n- FAIL output/);
    const search = ws.health.find((h) => h.tool === "search")!;
    assert.equal(search.calls, 6, "health counts every matched dev trial, kept or not");
    assert.equal(search.errors, 1);
    assert.equal(search.retriedAfterError, 1);
  });

  it("an arm with only held-out trials errors", async () => {
    const { index, blobs, experiment: exp } = await experiment();
    await assert.rejects(buildTraceWorkspace({ index, blobs, server: "acme", experiment: exp, arm: "terse@agent:claude-code" }), (e: unknown) => e instanceof TraceError && e.reason === "heldout_only");
    await assert.rejects(buildTraceWorkspace({ index, blobs, server: "acme", experiment: exp, arm: "nope@agent:claude-code" }), /no trials in arm/);
  });

  it("trials and sessions together; index.jsonl matches traces/ one to one", async () => {
    const { index, blobs, experiment: exp } = await experiment();
    const ws = await buildTraceWorkspace({ index, blobs, server: "acme", experiment: exp, arm: "base@agent:claude-code", sessions: "since:30d", tools: TOOLS, now: NOW });
    // Trial sessions (runId set) come only through --from.
    assert.ok(!ws.traces.some((t) => t.id.startsWith("session-trial_")));
    assert.deepEqual(ws.traces.filter((t) => t.outcome === "fail" || t.outcome === "failed").map((t) => t.id), ["session-sess-b", "trial-trial_1"]);
    const dir = tmpDir("csh-traces-");
    writeFileSync(join(dir, "stale"), "");
    mkdirSync(join(dir, "traces"));
    writeFileSync(join(dir, "traces", "old.md"), "old");
    await writeTraceWorkspace(ws, dir);
    const files = readdirSync(join(dir, "traces")).sort();
    const index_ = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; bytes: number });
    assert.deepEqual(files, index_.map((e) => `${e.id}.md`).sort());
    for (const e of index_) assert.equal(Buffer.byteLength(readFileSync(join(dir, "traces", `${e.id}.md`), "utf8")), e.bytes);
    const health = JSON.parse(readFileSync(join(dir, "tool-health.json"), "utf8")) as { server: string; tools: { tool: string; neverCalled: boolean }[] };
    assert.equal(health.server, "acme");
    assert.equal(health.tools.find((t) => t.tool === "fetch_doc")!.neverCalled, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")), TOOLS);
  });
});

describe("coding.sh toolevals traces", () => {
  it("prints the health table, writes the workspace, and needs no toolevals config", async () => {
    const root = tmpDir("csh-traces-cli-");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: join(root, "data"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1", TZ: "UTC" };
    mkdirSync(join(root, "home"), { recursive: true });
    const now = Date.now();
    const stores = await openStores(loadConfig(env));
    try {
      for (const events of SESSIONS) {
        const shifted = events.map((e) => ({ ...e, ts: e.ts - NOW + now }));
        await stores.index.putEvents(shifted);
        await stores.index.upsertSession(buildSession(shifted));
      }
    } finally {
      await stores.index.close();
      await stores.blobs.close?.();
    }
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, "toolevals", "traces", ...args], { env, cwd: join(root, "home"), encoding: "utf8", timeout: 60_000 });
    const r = cli("acme", "--sessions", "since:30d", "--out", "ws");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^tool\s+calls\s+errors\s+error%\s+repeats\s+retried-after-error\nsearch\s+6\s+2\s+33\.3%\s+1\s+1$/m);
    assert.match(r.stdout, /failed\s+session-sess-b\s+2\/3 target calls failed/);
    assert.ok(!r.stdout.includes("other"));
    assert.equal(readdirSync(join(root, "home", "ws", "traces")).length, 3);
    const j = cli("acme", "--sessions", "since:30d", "--json");
    assert.equal(j.status, 0, j.stderr);
    const doc = JSON.parse(j.stdout) as { health: { tool: string; errors: number; retriedAfterError: number }[]; traces: { id: string; outcome: string }[] };
    assert.deepEqual(doc.health.map((h) => [h.tool, h.errors, h.retriedAfterError]), [["search", 2, 1]]);
    assert.deepEqual(doc.traces[0], { ...doc.traces[0], id: "session-sess-b", outcome: "failed" });
    const none = cli("acme");
    assert.equal(none.status, 2);
    assert.match(none.stderr, /--from <experimentId>, --sessions/);
  });
});
