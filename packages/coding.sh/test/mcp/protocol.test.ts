// The MCP core against the spec rules a client can observe: caching hints on
// 2026-07-28 list and read results, cancellation, invalid cursors, a null id,
// 2025-03-26 batches and error text kept short when an argument is huge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { clipText, cutChars, McpServer, serveStdio, ToolError, type ToolDef } from "../../src/mcp/protocol.ts";

type Msg = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } };

const META = "io.modelcontextprotocol/";
const modern = { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientCapabilities`]: {} };

/** A server with a `slow` tool that waits for release(), an `echo` tool that fails with its input, and one resource. */
function world() {
  const gates: (() => void)[] = [];
  const slow: ToolDef<unknown> = {
    name: "slow",
    title: "Slow",
    description: "Waits until the test releases it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    run: () => new Promise((r) => gates.push(() => r({ done: true }))),
  };
  const echo: ToolDef<unknown> = {
    name: "echo",
    title: "Echo",
    description: "Fails with a message that quotes its input.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    run: (a) => Promise.reject(new ToolError(`No session with id ${JSON.stringify(a.text)}. Find ids with sessions_list.`)),
  };
  const server = new McpServer<unknown>({
    serverInfo: { name: "t", version: "0" },
    instructions: () => "test",
    tools: [slow, echo],
    resources: {
      list: async () => ({ resources: [{ uri: "t://one", name: "one" }] }),
      templates: () => [{ uriTemplate: "t://{id}", name: "by id" }],
      read: async (uri) => (uri === "t://one" ? { uri, mimeType: "text/plain", text: "one" } : undefined),
    },
    prompts: [{ name: "p", description: "A prompt.", render: () => "hi" }],
    context: () => undefined,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const out: Msg[] = [];
  /** Batch replies: one array line each. */
  const batches: Msg[][] = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const m = JSON.parse(buf.slice(0, i)) as Msg | Msg[];
      if (Array.isArray(m)) batches.push(m);
      else out.push(m);
      buf = buf.slice(i + 1);
    }
  });
  const done = serveStdio(server, { input, output });
  const send = (m: unknown) => input.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
  const tick = () => new Promise((r) => setTimeout(r, 20));
  /** Waits until a reply with this id arrives (or 20 s pass: the machine may be loaded). */
  const reply = async (id: unknown): Promise<Msg | undefined> => {
    for (let i = 0; i < 1000; i++) {
      const m = out.find((x) => JSON.stringify(x.id) === JSON.stringify(id));
      if (m) return m;
      await tick();
    }
    return undefined;
  };
  /** Waits for the signal that a tool is running: it has registered its gate. */
  const started = async () => {
    for (let i = 0; i < 1000 && !gates.length; i++) await tick();
    assert.ok(gates.length, "the tool started");
  };
  /** Two turns of the event loop: input written so far has been read. */
  const settle = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
  const release = async () => {
    for (let i = 0; i < 1000 && !gates.length; i++) await tick();
    gates.shift()!();
  };
  return { server, send, out, batches, reply, tick, started, settle, release, close: async () => (input.end(), done) };
}

describe("caching hints (2026-07-28)", () => {
  it("every list, read and discover result carries ttlMs and cacheScope", async () => {
    const w = world();
    const cases: [string, Record<string, unknown>, string][] = [
      ["server/discover", {}, "public"],
      ["tools/list", {}, "public"],
      ["prompts/list", {}, "public"],
      ["resources/templates/list", {}, "public"],
      ["resources/list", {}, "private"],
      ["resources/read", { uri: "t://one" }, "private"],
    ];
    let id = 0;
    for (const [method, params, scope] of cases) {
      w.send({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: modern } });
      const r = await w.reply(id);
      assert.equal(r?.result?.resultType, "complete", method);
      assert.equal(typeof r?.result?.ttlMs, "number", `${method} ttlMs`);
      assert.ok((r!.result!.ttlMs as number) >= 0, `${method} ttlMs >= 0`);
      assert.equal(r?.result?.cacheScope, scope, `${method} cacheScope`);
      if (method === "server/discover") assert.equal(r?.result?.ttlMs, 300_000, "discover carries a per-call update notice, so it is cached for 5 minutes");
    }
    // Legacy results stay as they were.
    w.send({ jsonrpc: "2.0", id: "legacy", method: "tools/list" });
    const legacy = await w.reply("legacy");
    assert.equal(legacy?.result?.ttlMs, undefined);
    await w.close();
  });
});

describe("cancellation (notifications/cancelled)", () => {
  it("a request cancelled before it runs gets no reply", async () => {
    const w = world();
    w.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } });
    w.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    w.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } });
    await w.release();
    assert.ok(await w.reply(1), "the running request is answered");
    w.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.ok(await w.reply(3), "later requests are answered");
    assert.equal(w.out.find((m) => m.id === 2), undefined, "the cancelled request got no reply");
    await w.close();
  });

  it("a request cancelled while it runs gets no reply", async () => {
    const w = world();
    w.send({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "slow" } });
    await w.started();
    w.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "a" } });
    await w.settle();
    await w.release();
    w.send({ jsonrpc: "2.0", id: "b", method: "ping" });
    assert.ok(await w.reply("b"));
    assert.equal(w.out.find((m) => m.id === "a"), undefined, "the cancelled request got no reply");
    // A cancel for an unknown or finished request is ignored.
    w.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "b" } });
    w.send({ jsonrpc: "2.0", id: "c", method: "ping" });
    assert.ok(await w.reply("c"));
    await w.close();
  });
});

describe("cancellation while a tool holds the event loop", () => {
  // A synchronous store read blocks the loop, so a cancel sits unread in the pipe until it ends.
  it("reads the cancel before it answers or starts the next request", async () => {
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./_blocking-server.ts", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
    const ids: unknown[] = [];
    const marks: string[] = [];
    let buf = "";
    let errBuf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        ids.push((JSON.parse(buf.slice(0, i)) as Msg).id);
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      errBuf += c;
      let i: number;
      while ((i = errBuf.indexOf("\n")) !== -1) {
        marks.push(errBuf.slice(0, i));
        errBuf = errBuf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    // Waits for the child's signal, not for a time: the machine may be loaded.
    const until = async (what: string, done: () => boolean) => {
      for (let i = 0; i < 3000 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(done(), `timed out waiting for ${what}`);
    };
    const exited = new Promise((r) => child.on("exit", r));
    send({ jsonrpc: "2.0", id: "warm", method: "ping" });
    await until("warm", () => ids.includes("warm"));
    // "run" is cancelled while it blocks; "queued" is cancelled while it waits behind "first".
    send({ jsonrpc: "2.0", id: "run", method: "tools/call", params: { name: "block", arguments: { ms: 1500 } } });
    await until("run to block", () => marks.length === 1);
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "run" } });
    await until("run to end", () => marks.length === 2);
    send({ jsonrpc: "2.0", id: "first", method: "tools/call", params: { name: "block", arguments: { ms: 1500 } } });
    await until("first to block", () => marks.length === 3);
    send({ jsonrpc: "2.0", id: "queued", method: "ping" });
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "queued" } });
    await until("first to end", () => marks.length === 4);
    await until("first's reply", () => ids.includes("first"));
    send({ jsonrpc: "2.0", id: "last", method: "ping" });
    await until("last", () => ids.includes("last"));
    child.stdin.end();
    await exited;
    assert.deepEqual(ids, ["warm", "first", "last"]);
  });
});

describe("JSON-RPC edges", () => {
  it("rejects a cursor on lists that have one page", async () => {
    const w = world();
    for (const [i, method] of ["tools/list", "prompts/list", "resources/templates/list"].entries()) {
      w.send({ jsonrpc: "2.0", id: i, method, params: { cursor: "not-a-cursor" } });
      const r = await w.reply(i);
      assert.equal(r?.error?.code, -32602, `${method}: ${JSON.stringify(r)}`);
    }
    await w.close();
  });

  it("answers a request whose id is null with an invalid-request error", async () => {
    const w = world();
    w.send({ jsonrpc: "2.0", id: null, method: "tools/list" });
    const r = await w.reply(null);
    assert.equal(r?.error?.code, -32600);
    await w.close();
  });

  it("handles a null id on a notifications/ method as a notification", async () => {
    const w = world();
    const n = w.out.length;
    w.send({ jsonrpc: "2.0", id: null, method: "notifications/initialized" });
    w.send({ jsonrpc: "2.0", id: null, method: "notifications/cancelled", params: { requestId: 9 } });
    w.send({ jsonrpc: "2.0", id: "after", method: "ping" });
    assert.ok(await w.reply("after"));
    assert.equal(w.out.length, n + 1, "the notifications got no reply");
    assert.equal(w.server.initialized, true);
    w.send({ jsonrpc: "2.0", id: null, method: "ping" });
    assert.equal((await w.reply(null))?.error?.code, -32600, "other null-id requests stay invalid");
    await w.close();
  });

  it("ignores a cancel for initialize", async () => {
    const w = world();
    w.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    w.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "init" } });
    assert.ok((await w.reply("init"))?.result?.protocolVersion, "initialize is still answered");
    await w.close();
  });

  it("clips text without splitting a surrogate pair", () => {
    const e = "\u{1F600}";
    for (let pad = 0; pad < 2; pad++) {
      const s = "a".repeat(pad) + e.repeat(100);
      const clipped = clipText(s, 100);
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped), `no lone surrogate (pad ${pad})`);
    }
    assert.equal(cutChars("a\u{1F600}", 2), "a");
    assert.equal(cutChars("ab", 5), "ab");
  });

  it("accepts batches after a 2025-03-26 handshake, and only then", async () => {
    const w = world();
    w.send([{ jsonrpc: "2.0", id: "x", method: "ping" }]);
    const before = await w.reply(null);
    assert.equal(before?.error?.code, -32600, "no batches before the handshake");
    w.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal((await w.reply(0))?.result?.protocolVersion, "2025-03-26");
    const n = w.out.length;
    w.send([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "no/such" }]);
    for (let i = 0; i < 100 && !w.batches.length; i++) await w.tick();
    // The reply is one array line with a response per request, none for the notification.
    const batch = w.batches[0]!;
    assert.ok(batch, "a batch reply");
    assert.deepEqual(batch.map((m) => m.id), [1, 2]);
    assert.deepEqual(batch[0]!.result, {});
    assert.equal(batch[1]!.error!.code, -32601);
    w.send([]);
    for (let i = 0; i < 100 && w.out.length === n; i++) await w.tick();
    assert.equal(w.out[n]!.error?.code, -32600, "an empty batch is invalid");
    await w.close();
  });

  it("keeps error text short when an argument is huge", async () => {
    const w = world();
    const huge = "h".repeat(1_000_000);
    w.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: huge } } });
    const tool = await w.reply(1);
    const text = (tool!.result!.content as { text: string }[])[0]!.text;
    assert.equal(tool!.result!.isError, true);
    assert.ok(text.length < 5000, `tool error is ${text.length} chars`);
    assert.match(text, /^No session with id "hhh/);
    assert.match(text, /Find ids with sessions_list\.$/, "the advice at the end survives");
    w.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: huge } });
    const rpc = await w.reply(2);
    assert.equal(rpc!.error!.code, -32602);
    assert.ok(rpc!.error!.message.length < 5000, `rpc error is ${rpc!.error!.message.length} chars`);
    w.send({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: `t://${huge}` } });
    const res = await w.reply(3);
    assert.ok(JSON.stringify(res).length < 10_000, `resource error is ${JSON.stringify(res).length} chars`);
    await w.close();
  });
});
