// PLAN-7: the MCP client beyond tools, against a stub server that uses every
// feature (fixtures/fake-mcp-full.mjs) over stdio, Streamable HTTP and the tap
// proxy: resources, prompts, progress, task-augmented calls, and sampling,
// elicitation and roots answered by the client's handlers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { connectMcp, promptText, resetEraCache, resourceText, type McpClient, type McpClientHandlers, type McpProgress } from "../../src/toolevals/mcp/client.ts";
import { startMcpProxy } from "../../src/toolevals/tap/mcp-proxy.ts";
import type { McpTarget, TapRecord } from "../../src/toolevals/types.ts";
import { GUIDE, startFullHttp } from "./fixtures/fake-mcp-full.mjs";
import { cleanup, FIX, tmp } from "./helpers.ts";

after(cleanup);
const FULL = join(FIX, "fake-mcp-full.mjs");

function handlers(seen: string[]): McpClientHandlers {
  return {
    sampling: async (p) => {
      seen.push(`sampling:${JSON.stringify(p.messages)}`);
      return { role: "assistant", content: { type: "text", text: "tag, publish, post notes" }, model: "stub", stopReason: "endTurn" };
    },
    elicitation: async (p) => {
      seen.push(`elicitation:${String(p.message)}`);
      return { action: "accept", content: { confirm: true } };
    },
    roots: async () => [{ uri: "file:///work/demo", name: "work" }],
  };
}

const text = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

/** Every feature, through one connected client. */
async function exercise(c: McpClient, seen: string[]): Promise<void> {
  assert.ok(c.capabilities && "resources" in c.capabilities && "prompts" in c.capabilities);
  const resources = await c.listResources();
  assert.deepEqual(resources.map((r) => r.uri), ["docs://guide", "docs://logo"]);
  assert.deepEqual((await c.listResourceTemplates()).map((t) => t.uriTemplate), ["docs://{page}"]);
  assert.equal(resourceText(await c.readResource("docs://guide")), GUIDE);
  assert.equal(resourceText(await c.readResource("docs://logo")), "[image/png 4 bytes at docs://logo]");
  const prompts = await c.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["release"]);
  const p = await c.getPrompt("release", { version: "2.0" });
  assert.match(promptText(p.messages), /release manager for version 2\.0/);

  await c.listTools();
  const progress: McpProgress[] = [];
  assert.equal(text(await c.callTool("search", { query: "release" }, { onProgress: (x) => progress.push(x) })), "results for release: guide");
  assert.deepEqual(progress, [{ progress: 1, total: 2, message: "indexing" }, { progress: 2, total: 2, message: "ranking" }]);
  assert.equal(text(await c.callTool("summarize", { text: "the guide" })), "summary: tag, publish, post notes");
  assert.equal(text(await c.callTool("confirm_delete", { page: "old" })), "deleted old");
  assert.equal(text(await c.callTool("list_roots", {})), "file:///work/demo");
  // build_report has execution.taskSupport = "required": created, polled, then read.
  assert.equal(text(await c.callTool("build_report", { topic: "q3" }, { timeoutMs: 10_000 })), "report on q3");
  assert.ok(seen.some((s) => s.startsWith("sampling:") && s.includes("Summarize in five words")));
  assert.ok(seen.includes("elicitation:Delete page old?"));
}

describe("MCP client features", () => {
  it("stdio: resources, prompts, progress, tasks, sampling, elicitation, roots; declares only the capabilities it has handlers for", async () => {
    resetEraCache();
    const log = join(tmp(), "server.jsonl");
    const seen: string[] = [];
    const c = await connectMcp({ stdio: [process.execPath, FULL], env: { FAKE_MCP_LOG: log }, handlers: handlers(seen), discoverTimeoutMs: 2000 });
    try {
      await exercise(c, seen);
    } finally {
      await c.close();
    }
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, { capabilities?: unknown; taskPolls?: number }>);
    assert.deepEqual(lines.find((l) => l.initialize)!.initialize!.capabilities, { sampling: {}, elicitation: { form: {} }, roots: { listChanged: false } });
    assert.ok((lines.find((l) => l.taskPolls !== undefined)!.taskPolls as unknown as number) >= 1, "the client polled tasks/get");

    // No handlers: no capabilities, and a sampling request is refused (the tool fails, the client stays up).
    resetEraCache();
    const bare = await connectMcp({ stdio: [process.execPath, FULL], discoverTimeoutMs: 2000 });
    try {
      await bare.listTools();
      await assert.rejects(bare.callTool("summarize", { text: "x" }, { timeoutMs: 5000 }));
      assert.equal(text(await bare.callTool("search", { query: "q" })), "results for q: guide");
    } finally {
      await bare.close();
    }
  });

  it("Streamable HTTP: server → client requests on the reply stream are answered while it stays open", async () => {
    resetEraCache();
    const srv = await startFullHttp();
    const seen: string[] = [];
    try {
      const c = await connectMcp({ url: srv.url, handlers: handlers(seen) });
      await exercise(c, seen);
      await c.close();
    } finally {
      await srv.close();
    }
  });

  for (const transport of ["stdio", "http"] as const) {
    it(`tap proxy (${transport}): resource reads and prompt use are recorded with their uri and name; a task-augmented call once; server requests as meta`, async () => {
      resetEraCache();
      const srv = transport === "http" ? await startFullHttp() : undefined;
      const dir = tmp();
      const tapLog = join(dir, "tap.jsonl");
      const target: McpTarget = transport === "http" ? { name: "full", kind: "mcp", transport: "http", url: srv!.url } : { name: "full", kind: "mcp", transport: "stdio", command: [process.execPath, FULL] };
      const proxy = await startMcpProxy({ target, variant: { name: "base" }, tapLog, binDir: join(dir, "bin"), graceMs: 200 });
      const seen: string[] = [];
      try {
        const c = await connectMcp(transport === "http" ? { url: proxy.url!, handlers: handlers(seen) } : { stdio: proxy.stdio!, handlers: handlers(seen), discoverTimeoutMs: 2000 });
        await exercise(c, seen);
        await c.close();
      } finally {
        await proxy.close();
        await srv?.close();
      }
      const tap = readFileSync(tapLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as TapRecord);
      const calls = tap.filter((r) => r.class !== "meta");
      assert.deepEqual(
        calls.map((r) => [r.tool ?? r.method, r.class]),
        [["resources/read", "ok"], ["resources/read", "ok"], ["prompts/get", "ok"], ["search", "ok"], ["summarize", "ok"], ["confirm_delete", "ok"], ["list_roots", "ok"], ["build_report", "ok"]],
      );
      assert.deepEqual(calls[0]!.args, { uri: "docs://guide" });
      assert.deepEqual(calls[2]!.args, { name: "prompts/get" === calls[2]!.method ? "release" : "", arguments: { version: "2.0" } });
      assert.deepEqual(calls[7]!.args, { topic: "q3" });
      assert.ok(calls[7]!.durationMs >= 40, "the task's record spans creation to result");
      const server = tap.filter((r) => r.direction === "server").map((r) => r.method);
      assert.deepEqual(server, ["sampling/createMessage", "elicitation/create", "roots/list"]);
      assert.ok(tap.some((r) => r.method === "tasks/get" && r.class === "meta"));
    });
  }
});
