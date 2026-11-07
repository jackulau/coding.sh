// §15.4: the model driver against the fake SSE provider (Anthropic Messages,
// OpenAI Responses, Chat Completions): llm.call events with ttftMs and usage,
// a tool round trip through the tapped tool, and the turn budget.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { runModelTrial } from "../../src/toolevals/drivers/model.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import { startMcpProxy } from "../../src/toolevals/tap/mcp-proxy.ts";
import type { Driver, McpTarget, TapRecord } from "../../src/toolevals/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startFakeProvider, type FakeTurn } from "./fixtures/fake-provider.mjs";
import { cleanup, cliTarget, FAKE_MCP, task, tmp } from "./helpers.ts";

after(cleanup);

const readTap = (f: string): TapRecord[] =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TapRecord);

type Provider = "anthropic" | "openai" | "openai-chat";
const driverFor = (provider: Provider, baseUrl: string): Extract<Driver, { kind: "model" }> => ({
  kind: "model",
  provider,
  model: "fake-model",
  baseUrl: provider === "anthropic" ? baseUrl : `${baseUrl}/v1`,
  apiKeyEnv: "FAKE_KEY",
});

async function cliRun(provider: Provider, script: FakeTurn[], budget = {}) {
  const p = await startFakeProvider(script);
  try {
    const t = task({ budget });
    const target = cliTarget();
    const sb = await prepareSandbox(t, target, { name: "base" }, `trial_${provider}`, tmp());
    const index = new MemoryIndexStore();
    const out = await runModelTrial({ driver: driverFor(provider, p.url), task: t, target, sandbox: sb, index, trialId: `trial_${provider}_${Date.now()}`, env: { FAKE_KEY: "k" } });
    return { out, sb, index, requests: p.requests };
  } finally {
    await p.close();
  }
}

for (const provider of ["anthropic", "openai", "openai-chat"] as const) {
  describe(`model driver: ${provider}`, () => {
    it("streams llm.call events with ttftMs and usage, and round-trips a shell tool call", async () => {
      const { out, sb, index, requests } = await cliRun(provider, [
        { toolCalls: [{ name: "shell", input: { command: "fake-cli greet --name bob" } }], usage: { input: 120, output: 15 } },
        { text: "The CLI said: hello bob", usage: { input: 200, output: 10 } },
      ]);
      assert.equal(out.loop.stopped, "final");
      assert.equal(out.finalText, "The CLI said: hello bob");
      const llm = out.events.filter((e) => e.kind === "llm.call");
      assert.equal(llm.length, 2);
      for (const e of llm) {
        assert.equal(e.payload.ok, true);
        assert.equal(typeof e.payload.ttftMs, "number");
        assert.ok((e.usage?.outputTokens ?? 0) > 0);
        assert.equal(e.source, "model-driver");
        assert.equal(e.agent, "coding.sh-model");
      }
      assert.equal(llm[0]!.usage!.inputTokens, 120);
      assert.equal(out.usage?.outputTokens, 25);
      const end = out.events.find((e) => e.kind === "tool.end")!;
      assert.match(String(end.payload.output), /hello bob/);
      // The tool result went back to the model on the second request.
      assert.match(JSON.stringify(requests[1]!.body), /hello bob/);
      // The call went through the tapped shim.
      const tap = readTap(sb.tapLog);
      assert.equal(tap.length, 1);
      assert.equal(tap[0]!.class, "ok");
      // Events and the session are in the store under the trial id.
      const sessions = await index.listSessions({ runId: out.sessionId });
      assert.equal(sessions.length, 1);
      assert.equal((await index.listEvents(out.sessionId!)).length, out.events.length);
    });

    it("stops at the turn budget", async () => {
      const { out } = await cliRun(provider, [{ toolCalls: [{ name: "shell", input: { command: "fake-cli greet" } }] }], { turns: 2 });
      assert.equal(out.loop.stopped, "budget");
      assert.equal(out.loop.budgetExceeded, "turns");
      assert.equal(out.events.filter((e) => e.kind === "llm.call").length, 2);
    });
  });
}

describe("model driver: retries and MCP tools", () => {
  it("retries a 429 and records the failed attempt as llm.call ok:false", async () => {
    const { out } = await cliRun("anthropic", [{ status: 429 }, { text: "fine" }]);
    assert.equal(out.finalText, "fine");
    const llm = out.events.filter((e) => e.kind === "llm.call");
    assert.deepEqual(
      llm.map((e) => e.payload.ok),
      [false, true],
    );
    assert.equal(llm[0]!.payload.status, 429);
  });

  it("needs the API key", async () => {
    const t = task();
    const sb = await prepareSandbox(t, cliTarget(), { name: "base" }, "trial_nokey", tmp());
    await assert.rejects(() => runModelTrial({ driver: driverFor("anthropic", "http://127.0.0.1:9"), task: t, target: cliTarget(), sandbox: sb, index: new MemoryIndexStore(), trialId: "trial_nokey", env: {} }), /FAKE_KEY/);
  });

  it("exposes an MCP target's tools through the tap proxy (Responses API)", async () => {
    const p = await startFakeProvider([{ toolCalls: [{ name: "echo", input: { text: "ping" } }] }, { text: "server said ping" }]);
    const target: McpTarget = { name: "fake", kind: "mcp", transport: "stdio", command: [process.execPath, FAKE_MCP.modern] };
    const t = task({ target: "fake", checks: [{ kind: "output", contains: ["ping"] }] });
    const sb = await prepareSandbox(t, target, { name: "base" }, "trial_mcp", tmp());
    const proxy = await startMcpProxy({ target, variant: { name: "base", hideTools: ["fail"] }, tapLog: sb.tapLog, binDir: sb.bin, graceMs: 500 });
    try {
      const out = await runModelTrial({ driver: driverFor("openai", p.url), task: t, target, sandbox: sb, index: new MemoryIndexStore(), trialId: "trial_mcp", env: { FAKE_KEY: "k" }, mcp: { stdio: proxy.stdio! } });
      assert.equal(out.finalText, "server said ping");
      const tools = (p.requests[0]!.body.tools as { name: string }[]).map((x) => x.name);
      assert.deepEqual(tools, ["echo", "add", "search_docs"]);
    } finally {
      await proxy.close();
      await p.close();
    }
    const calls = readTap(sb.tapLog).filter((r) => r.method === "tools/call");
    assert.deepEqual(
      calls.map((r) => [r.tool, r.class]),
      [["echo", "ok"]],
    );
  });
});

describe("model driver: cancellation", () => {
  it("an abort cancels the in-flight model request and stops the loop", async () => {
    // A provider that accepts the request and never answers.
    let closed!: () => void;
    const requestClosed = new Promise<void>((r) => (closed = r));
    let requests = 0;
    const server = createServer((req) => {
      requests++;
      req.resume();
      req.socket.on("close", closed);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const t = task();
      const sb = await prepareSandbox(t, cliTarget(), { name: "base" }, "trial_cancel", tmp());
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const t0 = Date.now();
      const out = await runModelTrial({ driver: driverFor("anthropic", url), task: t, target: cliTarget(), sandbox: sb, index: new MemoryIndexStore(), trialId: "trial_cancel", env: { FAKE_KEY: "k" }, signal: ac.signal });
      assert.ok(Date.now() - t0 < 5000, `returned in ${Date.now() - t0}ms`);
      assert.equal(out.loop.stopped, "error");
      assert.equal(out.loop.error, "cancelled");
      assert.equal(out.timedOut, false, "a cancel is not a wall-budget timeout");
      assert.equal(requests, 1, "no retry after the abort");
      await requestClosed; // the client dropped the connection
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
