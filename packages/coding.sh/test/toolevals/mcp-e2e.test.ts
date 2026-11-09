// PLAN-7 acceptance: a toolevals case runs end to end, model driver through the
// tap, against a stub MCP server that uses every client feature; `calls`
// checks assert on the resource read and the prompt. The HTTP run sits behind
// OAuth with a stub authorization server.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseDriver, parseTaskMcp } from "../../src/toolevals/config.ts";
import { runTrial, type ToolJob } from "../../src/toolevals/experiment.ts";
import { resetEraCache } from "../../src/toolevals/mcp/client.ts";
import { OAuthSession, parseChallenge } from "../../src/toolevals/mcp/oauth.ts";
import { connectMcp } from "../../src/toolevals/mcp/client.ts";
import { elicitationAnswer } from "../../src/toolevals/model/mcp-handlers.ts";
import type { McpTarget, ToolTask } from "../../src/toolevals/types.ts";
import { MemBlobs, MemIndex } from "../helpers-eval.ts";
import { startFakeProvider, type FakeTurn } from "./fixtures/fake-provider.mjs";
import { startFullHttp } from "./fixtures/fake-mcp-full.mjs";
import { cleanup, FIX, task, tmp } from "./helpers.ts";

after(cleanup);
const FULL = join(FIX, "fake-mcp-full.mjs");

/** The agent model: one tool per turn, then an answer built from what it saw. The server's sampling requests get a short summary. */
function agentScript(body: Record<string, unknown>): FakeTurn {
  if (JSON.stringify(body.system ?? "").includes("You summarize")) return { text: "tag, publish, post notes", usage: { input: 30, output: 6 } };
  const msgs = JSON.stringify(body.messages ?? "");
  const step = msgs.split('"tool_result"').length - 1;
  const plan: FakeTurn[] = [
    { toolCalls: [{ name: "read_mcp_resource", input: { uri: "docs://guide" } }] },
    { toolCalls: [{ name: "search", input: { query: "release" } }] },
    { toolCalls: [{ name: "summarize", input: { text: "the guide" } }] },
    { toolCalls: [{ name: "confirm_delete", input: { page: "old" } }] },
    { toolCalls: [{ name: "list_roots", input: {} }] },
    { toolCalls: [{ name: "build_report", input: { topic: "q3" } }] },
  ];
  if (step < plan.length) return plan[step]!;
  const saw = (s: string) => msgs.includes(s);
  const parts = [saw("version 2.0") ? "Release 2.0" : "no prompt", saw("Release checklist") ? "read the guide" : "", saw("deleted old") ? "deleted old" : saw("kept old") ? "kept old" : "", saw("report on q3") ? "report on q3" : "", saw("summary: tag, publish") ? "summarized" : "", saw("file://") ? "roots ok" : ""];
  return { text: parts.filter(Boolean).join("; ") };
}

const CHECKS: ToolTask["checks"] = [
  { kind: "calls", must: [{ tool: "resources/read", args: { uri: "docs://guide" } }, { tool: "prompts/get", args: { name: "release" } }, { tool: "build_report", args: { topic: "q3" } }, { tool: "confirm_delete", args: { page: "old" } }] },
  { kind: "output", contains: ["Release 2.0", "read the guide", "report on q3", "summarized", "roots ok"] },
];

describe("MCP features end to end (model driver)", () => {
  it("stdio: prompt, resource read, progress, sampling, elicitation, roots and a task in one trial; calls checks see the resource and the prompt", async () => {
    resetEraCache();
    const agent = await startFakeProvider(agentScript);
    try {
      const driver = parseDriver("model:anthropic/agent-model", { "model:anthropic/agent-model": { baseUrl: agent.url, apiKeyEnv: "AGENT_KEY" } });
      const target: McpTarget = { name: "full", kind: "mcp", transport: "stdio", command: [process.execPath, FULL] };
      const mcp = parseTaskMcp({ prompt: { name: "release", arguments: { version: "2.0" } }, elicitation: [{ match: "Delete page", action: "accept", content: { confirm: true } }], roots: ["."] }, "test");
      const t = task({ target: "full", instruction: "Prepare the release.", mcp, checks: [...CHECKS, { kind: "output", contains: ["deleted old"] }] });
      const job: ToolJob = { task: t, variant: { name: "base" }, driver, attempt: 1 };
      const index = new MemIndex();
      const r = await runTrial({ job, target, experimentId: "texp_mcp", expDir: tmp(), index, blobs: new MemBlobs(), adapterFor: () => { throw new Error("no agent"); }, env: { AGENT_KEY: "a" }, keep: false });
      assert.equal(r.error, undefined);
      assert.equal(r.pass, true, JSON.stringify(r.checks));
      const events = await index.listEvents(r.sessionId!);
      // The server's sampling request went to the driver's model: usage counts, not a turn.
      const sampling = events.filter((e) => e.kind === "llm.call" && e.payload.purpose === "mcp-sampling");
      assert.equal(sampling.length, 1);
      assert.equal(r.metrics.turns, 7);
      const ends = events.filter((e) => e.kind === "tool.end");
      const search = ends.find((e) => e.payload.tool === "search")!;
      assert.deepEqual(search.payload.progress, { updates: 2, last: { progress: 2, total: 2, message: "ranking" } });
      const roots = ends.find((e) => e.payload.tool === "list_roots")!;
      assert.match(String(roots.payload.output), /^file:\/\/.+work/);
      // The prompt's text went before the instruction.
      assert.match(JSON.stringify(agent.requests[0]!.body), /release manager for version 2\.0[\s\S]*Prepare the release\./);
    } finally {
      await agent.close();
    }
  });

  it("HTTP behind OAuth: the client registers, gets a token with PKCE through the tap, and declines an unscripted elicitation", async () => {
    resetEraCache();
    const agent = await startFakeProvider(agentScript);
    const srv = await startFullHttp({ oauth: true });
    try {
      const driver = parseDriver("model:anthropic/agent-model", { "model:anthropic/agent-model": { baseUrl: agent.url, apiKeyEnv: "AGENT_KEY" } });
      const target: McpTarget = { name: "full-http", kind: "mcp", transport: "http", url: srv.url };
      const t = task({ target: "full-http", instruction: "Prepare the release.", mcp: { prompt: { name: "release", arguments: { version: "2.0" } } }, checks: [...CHECKS, { kind: "output", contains: ["kept old"] }] });
      const r = await runTrial({ job: { task: t, variant: { name: "base" }, driver, attempt: 1 }, target, experimentId: "texp_mcp", expDir: tmp(), index: new MemIndex(), blobs: new MemBlobs(), adapterFor: () => { throw new Error("no agent"); }, env: { AGENT_KEY: "a" }, keep: false });
      assert.equal(r.error, undefined);
      assert.equal(r.pass, true, JSON.stringify(r.checks));
      assert.deepEqual(srv.oauthLog.map((e) => Object.keys(e)[0]), ["register", "authorize", "token"]);
      assert.deepEqual(srv.oauthLog[1], { authorize: { resource: srv.url, scope: "docs:read" } });
      assert.ok(srv.log.some((e) => JSON.stringify(e.elicitation) === JSON.stringify({ action: "decline" })));
    } finally {
      await srv.close();
      await agent.close();
    }
  });
});

describe("MCP OAuth", () => {
  it("a 401 without OAuth fails; client_credentials works with a registered secret", async () => {
    resetEraCache();
    const srv = await startFullHttp({ oauth: true });
    try {
      await assert.rejects(connectMcp({ url: srv.url }), /401/);
      const c = await connectMcp({ url: srv.url, oauth: new OAuthSession({ grant: "client_credentials" }) });
      assert.equal((await c.listTools()).length, 5);
      await c.close();
      assert.deepEqual(srv.oauthLog.map((e) => Object.values(e)[0]), ["coding.sh toolevals", "client_credentials"]);
    } finally {
      await srv.close();
    }
  });

  it("parses Bearer challenges; scripted elicitation answers match in order", () => {
    assert.deepEqual(parseChallenge('Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write", error=invalid_token'), { resource_metadata: "https://a.example/.well-known/oauth-protected-resource", scope: "read write", error: "invalid_token" });
    const mcp = parseTaskMcp({ elicitation: [{ match: "^Delete", action: "decline" }, { action: "accept", content: { ok: true } }] }, "t");
    assert.deepEqual(elicitationAnswer(mcp, "Delete page x?"), { action: "decline" });
    assert.deepEqual(elicitationAnswer(mcp, "Your name?"), { action: "accept", content: { ok: true } });
    assert.deepEqual(elicitationAnswer(undefined, "anything"), { action: "decline" });
    assert.throws(() => parseTaskMcp({ elicitation: [{ action: "maybe" }] }, "t"), /accept, decline or cancel/);
    assert.throws(() => parseTaskMcp({ prompt: { arguments: {} } }, "t"), /mcp.prompt needs name/);
    assert.throws(() => parseTaskMcp({ sampling: true }, "t"), /unknown key mcp.sampling/);
  });
});
