// Where a proxied call sits among sessions: a Claude Code subagent's calls land in
// its child session, Codex calls name their parent and fork, the account is kept
// only as a hash, and CLIProxyAPI's credential index is read from its trace id.
// The headers are the ones real Claude Code 2.1.319 and Codex 0.167.0 send.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { accountHash, callLineage, detectClient, linkCall, ResponseSessions, upstreamAuth } from "../../src/proxy/link.ts";
import { parseRequest } from "../../src/proxy/wire.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { call, everything, startTestProxy, startUpstream } from "./_helpers.ts";

const SESSION = "ae0542f7-7a5f-4564-b51a-0c1b47a46dcc";
const AGENT = "a15ada6cd07ffe541";
const ACCOUNT = "3f6b2c1d-9a8e-4f7b-8c6d-5e4f3a2b1c0d";
const userId = (extra: Record<string, string> = {}) => JSON.stringify({ device_id: "ea4f017e", account_uuid: ACCOUNT, session_id: SESSION, ...extra });
const claude = { "user-agent": "claude-cli/2.1.319 (external, sdk-cli)", "x-app": "cli", "x-claude-code-session-id": SESSION };
const body = (extra: Record<string, string> = {}) => ({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "check notes.txt" }], metadata: { user_id: userId(extra) } });

describe("proxy: call lineage", () => {
  it("routes a Claude Code subagent's calls to its child session and keeps the account as a hash", () => {
    const h = { ...claude, "x-claude-code-agent-id": AGENT };
    const client = detectClient(h);
    const req = parseRequest("messages", body());
    const l = callLineage(h, client, req);
    assert.deepEqual(l, { agentId: AGENT, accountHash: accountHash(ACCOUNT) });
    assert.match(l.accountHash!, /^[0-9a-f]{16}$/);
    const link = linkCall(h, client, req, undefined, new ResponseSessions(), l);
    assert.deepEqual(link, { sessionId: `${SESSION}:sub:${AGENT}`, agent: "claude-code", linkedBy: "header", subagentId: AGENT, parentSessionId: SESSION });
    // The main loop's calls stay in the session.
    assert.equal(linkCall(claude, client, req, undefined, new ResponseSessions(), callLineage(claude, client, req)).sessionId, SESSION);
    // An explicit session wins over everything.
    assert.equal(linkCall({ ...h, "x-coding-sh-session": "my-run" }, client, req, undefined, new ResponseSessions(), l).sessionId, "my-run");
  });

  it("reads a parent session, parent agent and agent type when Claude Code sends them", () => {
    const h = { ...claude, "x-claude-code-agent-id": AGENT, "x-claude-code-parent-agent-id": "a0000000000000001", "x-claude-code-agent-type": "subagent" };
    const l = callLineage(h, detectClient(h), parseRequest("messages", body({ parent_session_id: "11111111-2222-4333-8444-555555555555" })));
    assert.equal(l.parentAgentId, "a0000000000000001");
    assert.equal(l.agentType, "subagent");
    assert.equal(l.parentSessionId, "11111111-2222-4333-8444-555555555555");
    assert.equal(callLineage({ ...claude, "x-claude-code-agent-id": "../../x" }, detectClient(claude), undefined).agentId, undefined, "ids must be plain");
  });

  it("reads Codex's parent thread, fork, subagent kind and ChatGPT account", () => {
    const parent = "019a1b8d-1d73-7f00-9df8-82f7ad50858d";
    const h = {
      "user-agent": "codex_exec/0.167.0 (Linux; x86_64)",
      originator: "codex_exec",
      "session-id": "019a1b8d-0000-7000-8000-000000000002",
      "x-codex-parent-thread-id": parent,
      "x-openai-subagent": "review",
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "t1", forked_from_thread_id: "019a1b8d-0000-7000-8000-000000000003" }),
      "chatgpt-account-id": "acct-1234",
    };
    const client = detectClient(h);
    const l = callLineage(h, client, undefined);
    assert.deepEqual(l, { parentSessionId: parent, forkedFromSessionId: "019a1b8d-0000-7000-8000-000000000003", subagentKind: "review", accountHash: accountHash("acct-1234") });
    // A Codex child thread is its own session (as its rollouts are): only the parent is named.
    assert.equal(linkCall(h, client, undefined, undefined, new ResponseSessions(), l).sessionId, "019a1b8d-0000-7000-8000-000000000002");
    // The parent can also come from the turn metadata alone.
    const meta = { ...h, "x-codex-parent-thread-id": "", "x-codex-turn-metadata": JSON.stringify({ parent_thread_id: parent, subagent_kind: "collab_spawn" }) };
    assert.deepEqual(callLineage(meta, client, undefined), { parentSessionId: parent, subagentKind: "review", accountHash: accountHash("acct-1234") });
  });

  it("reads the credential index from CLIProxyAPI's trace id", () => {
    assert.equal(upstreamAuth({ "x-cpa-trace-id": "20261107153012-9F86D081884C7D65-a1b2c3" }), "9f86d081884c7d65");
    assert.equal(upstreamAuth({ "x-cpa-trace-id": "garbage" }), undefined);
    assert.equal(upstreamAuth({}), undefined);
  });

  it("records a subagent's call in the child session, linked to its parent, with no raw account id stored", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-cpa-trace-id": "20261107153012-9f86d081884c7d65-req1" });
      res.end(JSON.stringify({ id: "msg_s", type: "message", model: "claude-sonnet-4-5", content: [{ type: "text", text: "sub done" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }));
    });
    const t = await startTestProxy(up.url);
    try {
      const headers = { ...claude, "content-type": "application/json", "x-api-key": "sk-stub", "x-claude-code-agent-id": AGENT };
      await call(t.proxy.url, { path: "/v1/messages?beta=true", body: JSON.stringify(body()), headers });
      await call(t.proxy.url, { path: "/v1/messages?beta=true", body: JSON.stringify(body()), headers: { ...headers, "x-claude-code-agent-id": "" } });
      const events = await t.events();
      const sub = events.find((e) => e.sessionId === `${SESSION}:sub:${AGENT}`);
      const main = events.find((e) => e.sessionId === SESSION);
      assert.ok(sub && main, events.map((e) => e.sessionId).join(", "));
      assert.equal(sub.subagentId, AGENT);
      assert.equal(sub.payload.parentSessionId, SESSION);
      assert.equal(sub.payload.agentId, AGENT);
      assert.equal(sub.payload.accountHash, accountHash(ACCOUNT));
      assert.equal(sub.payload.upstreamAuth, "9f86d081884c7d65");
      assert.equal(main.payload.parentSessionId, undefined, "the main loop has no parent");
      assert.equal(main.payload.agentId, undefined);
      // Seen only through the proxy, the child session is still linked to its parent.
      assert.deepEqual(buildSession([sub]).parent, { sessionId: SESSION, subagentId: AGENT });
      assert.ok(!(await everything(t)).includes(ACCOUNT), "the account id is stored nowhere");
    } finally {
      await t.close();
      await up.close();
    }
  });

  it("a session.start's parent wins over a proxied call's", () => {
    const start: AgentEvent = { id: "s", v: 0, sessionId: "c", ts: 2000, agent: "claude-code", kind: "session.start", payload: { parentSessionId: "p-hook", subagentType: "Explore" } };
    const proxied: AgentEvent = { id: "p", v: 0, sessionId: "c", ts: 1000, agent: "claude-code", kind: "llm.call", source: "proxy", payload: { parentSessionId: "p-proxy", ok: true } };
    assert.deepEqual(buildSession([proxied, start]).parent, { sessionId: "p-hook", type: "Explore" });
    assert.deepEqual(buildSession([proxied]).parent, { sessionId: "p-proxy" });
  });
});
