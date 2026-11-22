// A session T3 Code hosted is the agent that ran (claude-code, codex), with T3 Code as its host:
// usage --by agent, status, sessions --agent, MCP status and the viewer all count the agent that
// ran, and --agent t3code still finds the sessions T3 Code drove.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { after, before, describe, test } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed } from "../query/_seed.ts";

type Obj = Record<string, unknown>;

const NOW = Date.now();
const HOSTED_CLAUDE = "t3h-claude";
const HOSTED_CODEX = "t3h-codex";
const DIRECT = "t3h-direct";

let n = 0;
const ev = (sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], payload: Obj = {}): AgentEvent => ({ id: `${sessionId}-${n++}`, v: 0, sessionId, ts, agent, kind, payload, cwd: "/work/demo" });

/** A T3 Code thread that ran `agent`: the host's link row, then the agent's own rows. */
function hosted(id: string, agent: string, t0: number): AgentEvent[] {
  return [
    ev(id, "t3code", t0 - 10, "notification", { type: "host-link", via: "t3code", provider: agent, t3ThreadId: `thr-${id}`, t3ProviderThreadId: `pt-${id}`, title: `T3 thread ${id}` }),
    ev(id, agent, t0, "session.start", { source: "transcript" }),
    ev(id, agent, t0 + 1000, "user.message", { text: "fix the parser" }),
    ev(id, agent, t0 + 60_000, "session.end", { reason: "exit" }),
  ];
}

const EVENTS = [
  ...hosted(HOSTED_CLAUDE, "claude-code", NOW - 3600e3),
  ...hosted(HOSTED_CODEX, "codex", NOW - 2 * 3600e3),
  // Claude Code run directly, earlier than the hosted one.
  ev(DIRECT, "claude-code", NOW - 5 * 3600e3, "session.start", {}),
  ev(DIRECT, "claude-code", NOW - 5 * 3600e3 + 1000, "user.message", { text: "add a test" }),
  ev(DIRECT, "claude-code", NOW - 5 * 3600e3 + 60_000, "session.end", { reason: "exit" }),
];
const of = (id: string) => EVENTS.filter((e) => e.sessionId === id);
const SESSIONS: Session[] = [HOSTED_CLAUDE, HOSTED_CODEX, DIRECT].map((id) => buildSession(of(id)));

test("a T3-hosted session folds to the agent that ran, with T3 Code as host; a direct one has no host", () => {
  const by = Object.fromEntries(SESSIONS.map((s) => [s.id, [s.agent, s.host]]));
  assert.deepEqual(by, { [HOSTED_CLAUDE]: ["claude-code", "t3code"], [HOSTED_CODEX]: ["codex", "t3code"], [DIRECT]: ["claude-code", undefined] });
  // A T3 thread that never reached a provider stays T3 Code's, with no host.
  const bare = buildSession([ev("t3h-bare", "t3code", NOW, "notification", { type: "host-link", via: "t3code", provider: "unknown", t3ThreadId: "thr-bare", title: "Draft" })]);
  assert.deepEqual([bare.agent, bare.host], ["t3code", undefined]);
});

describe("CLI and MCP over a store with T3-hosted Claude Code and Codex sessions", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { events: EVENTS, sessions: SESSIONS });
  });
  after(() => env.restore());

  test("usage --by agent has claude-code and codex rows and no t3code row", () => {
    const r = JSON.parse(ok(["usage", "--by", "agent", "--since", "1d", "--json"]).stdout) as { groups: { key: string; sessions: number }[] };
    assert.deepEqual(r.groups.map((g) => [g.key, g.sessions]).sort(), [["claude-code", 2], ["codex", 1]]);
  });

  test("status lists the agents that ran in the last 24h", () => {
    const r = JSON.parse(ok(["status", "--json"]).stdout) as { last24h: { agents: string[] } };
    assert.deepEqual(r.last24h.agents, ["claude-code", "codex"]);
  });

  test("sessions --agent t3code still lists the sessions T3 Code hosted; --agent claude-code adds them to the direct ones", () => {
    const list = (agent: string) => (JSON.parse(ok(["sessions", "--agent", agent, "--json"]).stdout) as { sessions: { id: string; agent: string; host?: string }[] }).sessions;
    const t3 = list("t3code");
    assert.deepEqual(t3.map((s) => [s.id, s.agent, s.host]).sort(), [[HOSTED_CLAUDE, "claude-code", "t3code"], [HOSTED_CODEX, "codex", "t3code"]]);
    const claude = list("claude-code");
    assert.deepEqual(claude.map((s) => s.id).sort(), [DIRECT, HOSTED_CLAUDE].sort());
    assert.equal(claude.find((s) => s.id === DIRECT)?.host, undefined, "a direct session has no host");
  });

  test("MCP status: lastCapture for claude-code is the T3-hosted session, and the session summary names the host", async () => {
    const mcp = createCodingShMcp({ env: { ...process.env, CODING_SH_NO_AUTO_INGEST: "1" }, cwd: env.root, ingestIntervalMs: 0, ingestBudgetMs: 0, log: () => {} });
    try {
      const call = async (name: string, args: Obj = {}) => {
        const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
        const res = r!.result as { structuredContent: Obj; isError?: boolean; content: { text: string }[] };
        assert.notEqual(res.isError, true, res.content[0]?.text);
        return res.structuredContent;
      };
      const st = await call("status");
      assert.deepEqual((st.last24h as { agents: string[] }).agents, ["claude-code", "codex"]);
      const last = Object.fromEntries((st.lastCapture as { agent: string; at: string; sessionId: string }[]).map((x) => [x.agent, x]));
      assert.deepEqual(Object.keys(last).sort(), ["claude-code", "codex"]);
      // status names a session by the shortest id that resolves (8 characters or more).
      assert.ok(HOSTED_CLAUDE.startsWith(last["claude-code"]!.sessionId), last["claude-code"]!.sessionId);
      assert.equal(last["claude-code"]!.at, new Date(NOW - 3600e3 + 60_000).toISOString());
      const u = await call("usage", { since: "1d", groupBy: "agent" });
      assert.deepEqual((u.groups as { key: string }[]).map((g) => g.key).sort(), ["claude-code", "codex"]);
      const l = await call("sessions_list", { agent: "t3code", since: "1d" });
      assert.deepEqual((l.sessions as { id: string; host?: string }[]).map((s) => [s.id, s.host]).sort(), [[HOSTED_CLAUDE, "t3code"], [HOSTED_CODEX, "t3code"]]);
    } finally {
      await mcp.close();
    }
  });
});

describe("viewer on a mixed store", () => {
  let v: Viewer;
  before(async () => {
    const index = new MemoryIndexStore();
    await index.putEvents(EVENTS);
    for (const s of SESSIONS) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new MemoryBlobStore(), port: 0 });
  });
  after(async () => {
    await v.close();
  });
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}` } });
    assert.equal(r.status, 200, path);
    return (await r.json()) as Obj;
  };

  test("the list cell's agent and the Agent facet agree, and both name the agent that ran", async () => {
    const items = (await get("/api/sessions")).items as { id: string; agent: string; host?: string }[];
    const cells: Record<string, number> = {};
    for (const s of items) cells[s.agent] = (cells[s.agent] ?? 0) + 1;
    const facet = (await get("/api/stats")).byAgent as Record<string, number>;
    assert.deepEqual(cells, facet);
    assert.deepEqual(facet, { "claude-code": 2, codex: 1 });
    assert.equal(items.find((s) => s.id === HOSTED_CLAUDE)?.host, "t3code");
    // Picking the facet lists the sessions it counted; t3code lists the sessions T3 Code drove.
    const pick = async (agent: string) => ((await get(`/api/sessions?agent=${agent}`)).items as { id: string }[]).map((s) => s.id).sort();
    assert.deepEqual(await pick("claude-code"), [DIRECT, HOSTED_CLAUDE].sort());
    assert.deepEqual(await pick("t3code"), [HOSTED_CLAUDE, HOSTED_CODEX].sort());
  });

  test("the cell's tooltip and the session header say via T3 Code", () => {
    const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
    const a = html.indexOf("function viaHost(");
    const b = html.indexOf("\n}\n", a);
    assert.ok(a >= 0 && b > a, "viaHost is in the page");
    const viaHost = runInNewContext(`(${html.slice(a, b + 2)})`) as (s: Obj) => string;
    assert.equal(viaHost({ agent: "claude-code", host: "t3code" }), " via T3 Code");
    assert.equal(viaHost({ agent: "claude-code" }), "");
    assert.match(html, /title: \[s\.agent \+ viaHost\(s\), s\.model\]/, "the list cell's tooltip");
    assert.match(html, /fact\("agent", s\.agent \+ \(s\.agentVersion \? " " \+ s\.agentVersion : ""\) \+ viaHost\(s\)\)/, "the header's agent fact");
  });
});
