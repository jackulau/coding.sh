// §15.2 and §15.3: the minimal MCP client and the MCP tap proxy, against the
// legacy and modern fake servers over stdio and Streamable HTTP.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { connectMcp, resetEraCache, resultText, type McpClient } from "../../src/toolevals/mcp/client.ts";
import { RpcError } from "../../src/toolevals/mcp/jsonrpc.ts";
import type { StdioTransport } from "../../src/toolevals/mcp/stdio.ts";
import { McpTap, startMcpProxy } from "../../src/toolevals/tap/mcp-proxy.ts";
import type { McpTarget, TapRecord, Variant } from "../../src/toolevals/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SERVERS = { legacy: join(FIX, "fake-mcp-legacy.mjs"), modern: join(FIX, "fake-mcp-modern.mjs") } as const;
type Era = keyof typeof SERVERS;

const dirs: string[] = [];
const procs: ChildProcess[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const p of procs) p.kill("SIGKILL");
});
afterEach(() => resetEraCache());
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "csh-mcp-")));
  dirs.push(d);
  return d;
};

async function startHttpFake(era: Era): Promise<string> {
  const p = spawn(process.execPath, [SERVERS[era], "--http", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  procs.push(p);
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    p.stdout!.setEncoding("utf8");
    p.stdout!.on("data", (c: string) => {
      buf += c;
      const m = /listening (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    p.on("exit", () => reject(new Error("fake server exited")));
  });
  return `http://127.0.0.1:${port}/mcp`;
}

const readTap = (f: string): TapRecord[] =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TapRecord);

const pidGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

for (const era of ["legacy", "modern"] as const) {
  for (const transport of ["stdio", "http"] as const) {
    describe(`MCP client: ${era} over ${transport}`, () => {
      const connect = async (): Promise<McpClient> =>
        transport === "stdio" ? connectMcp({ stdio: [process.execPath, SERVERS[era]], discoverTimeoutMs: 3000 }) : connectMcp({ url: await startHttpFake(era) });

      it("detects the era, pages tools/list, calls tools and closes", async () => {
        const c = await connect();
        try {
          assert.equal(c.era, era === "modern" ? "2026-07-28" : "legacy");
          assert.equal(c.protocolVersion, era === "modern" ? "2026-07-28" : "2025-11-25");
          assert.equal(c.serverInfo?.name, `fake-${era}`);
          const tools = await c.listTools();
          assert.deepEqual(
            tools.map((t) => t.name),
            ["echo", "add", "fail", "search_docs"],
          );
          const echo = await c.callTool("echo", { text: "hi there" });
          assert.equal(resultText(echo), "hi there");
          const add = await c.callTool("add", { a: 2, b: 3 });
          assert.equal(resultText(add), JSON.stringify({ sum: 5 }));
          const fail = await c.callTool("fail", {});
          assert.equal(fail.isError, true);
          await assert.rejects(
            () => c.callTool("nope", {}),
            (e: unknown) => e instanceof RpcError && e.code === -32602,
          );
        } finally {
          await c.close();
        }
      });
    });
  }
}

describe("MCP client shutdown", () => {
  it("kills a server that ignores stdin EOF and SIGTERM within 5 s", async () => {
    const c = await connectMcp({ stdio: [process.execPath, SERVERS.legacy, "--stubborn"], discoverTimeoutMs: 3000, graceMs: 1500 });
    const pid = (c as unknown as { t: StdioTransport }).t.child.pid!;
    assert.ok(!pidGone(pid));
    const t0 = Date.now();
    await c.close();
    assert.ok(pidGone(pid), "process still running after close()");
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });

  it("a cooperative server exits on stdin EOF", async () => {
    const c = await connectMcp({ stdio: [process.execPath, SERVERS.modern] });
    const pid = (c as unknown as { t: StdioTransport }).t.child.pid!;
    const t0 = Date.now();
    await c.close();
    assert.ok(pidGone(pid));
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe("McpTap", () => {
  it("counts wire bytes of both directions and rewrites tools/list", () => {
    const recs: TapRecord[] = [];
    const tap = new McpTap({ variant: { descriptions: { echo: "E" } }, record: (r) => recs.push(r) });
    const listReq = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    tap.fromClient(listReq);
    const listRes = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "echo", description: "long description", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } };
    const delivered = tap.fromServer(listRes) as { result: { tools: { description: string }[] } };
    assert.equal(delivered.result.tools[0]!.description, "E");
    const callReq = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: 5 } } };
    tap.fromClient(callReq);
    const callRes = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "5" }] } };
    tap.fromServer(callRes);
    assert.equal(recs.length, 2);
    assert.equal(recs[0]!.class, "meta");
    assert.equal(recs[0]!.requestBytes, Buffer.byteLength(JSON.stringify(listReq)));
    assert.equal(recs[0]!.responseBytes, Buffer.byteLength(JSON.stringify(delivered)));
    assert.equal(recs[1]!.requestBytes, Buffer.byteLength(JSON.stringify(callReq)));
    assert.equal(recs[1]!.responseBytes, Buffer.byteLength(JSON.stringify(callRes)));
    // The server accepted arguments its own schema rejects: still invalid.
    assert.equal(recs[1]!.class, "invalid");
    assert.ok(recs[1]!.schemaViolations?.length);
  });
});

for (const era of ["legacy", "modern"] as const) {
  for (const transport of ["stdio", "http"] as const) {
    describe(`MCP proxy: ${era} over ${transport}`, () => {
      it("applies overrides and classifies calls", async () => {
        const d = tmp();
        const tapLog = join(d, "tap.jsonl");
        writeFileSync(tapLog, "");
        const target: McpTarget =
          transport === "stdio"
            ? { name: "fake", kind: "mcp", transport: "stdio", command: [process.execPath, SERVERS[era]] }
            : { name: "fake", kind: "mcp", transport: "http", url: await startHttpFake(era) };
        const variant: Variant = { name: "v", descriptions: { echo: "ECHO!" }, paramDescriptions: { add: { a: "" } }, hideTools: ["search_docs"] };
        const proxy = await startMcpProxy({ target, variant, tapLog, binDir: join(d, "bin"), graceMs: 1000 });
        try {
          const c = await connectMcp(proxy.stdio ? { stdio: proxy.stdio, discoverTimeoutMs: 3000 } : { url: proxy.url! });
          try {
            const tools = await c.listTools();
            assert.deepEqual(
              tools.map((t) => t.name),
              ["echo", "add", "fail"],
            );
            assert.equal(tools[0]!.description, "ECHO!");
            const addProps = (tools[1]!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
            assert.equal(addProps.a!.description, undefined);
            assert.equal(addProps.b!.description, "Second addend");

            assert.equal(resultText(await c.callTool("echo", { text: "x" })), "x");
            const bad = await c.callTool("add", { a: "one", b: 2 });
            assert.equal(bad.isError, true);
            await assert.rejects(() => c.callTool("nope", {}), (e: unknown) => e instanceof RpcError && e.code === -32602);
            await assert.rejects(() => c.callTool("search_docs", { query: "q" }), (e: unknown) => e instanceof RpcError && e.code === -32602);
            const f = await c.callTool("fail", {});
            assert.equal(f.isError, true);
          } finally {
            await c.close();
          }
        } finally {
          await proxy.close();
        }
        const calls = readTap(tapLog).filter((r) => r.method === "tools/call");
        assert.deepEqual(
          calls.map((r) => [r.tool, r.class, r.reason ?? null]),
          [
            ["echo", "ok", null],
            ["add", "invalid", "schema"],
            ["nope", "invalid", "unknown-tool"],
            ["search_docs", "invalid", "unknown-tool"],
            ["fail", "failed", "tool-error"],
          ],
        );
        assert.ok(calls[1]!.schemaViolations?.some((v) => /a/.test(v)));
        assert.equal(calls[2]!.rpcErrorCode, -32602);
        for (const r of calls) {
          assert.ok(r.requestBytes! > 0 && r.responseBytes! > 0, JSON.stringify(r));
          assert.equal(r.target, "mcp");
        }
        const list = readTap(tapLog).filter((r) => r.method === "tools/list");
        assert.ok(list.length >= 3 && list.every((r) => r.class === "meta"));
      });
    });
  }
}
