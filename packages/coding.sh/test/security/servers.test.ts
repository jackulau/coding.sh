// The local OTLP receiver holds its guards: it listens on loopback unless told otherwise,
// answers only loopback Host names and local page origins, refuses a body over its limit
// before and after decompression and a body that does not decode, and bounds how long a
// client may take to send its headers and its body. The eve evals route it serves for
// the collector refuses a browser page and a foreign Host before it reads anything. The
// receiver a run starts for its agent redacts with the rules the run was given. The MCP
// server answers a tool call that names a folder git can't start in, and stays up; the git
// call fails with an error that says why.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { run as runGit } from "../../src/core/git.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { createEveEvalsHandler, EVE_EVALS_PATH } from "../../src/integrations/eve/evals.ts";
import { type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { startRunReceiver } from "../../src/runner/otel.ts";
import { makeWorld, cleanup as removeWorlds, RawClient } from "../mcp/helpers.ts";
import { otlpSpan, otlpTraces, sAttr } from "../otel/_encode.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

const dirs: string[] = [];
const receivers: Receiver[] = [];
const clients: RawClient[] = [];
after(async () => {
  for (const rx of receivers) await rx.close().catch(() => {});
  for (const c of clients) if (c.child.exitCode === null) await c.close();
  removeWorlds();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function receiver(extra: Partial<Parameters<typeof startReceiver>[0]> = {}): Promise<{ rx: Receiver; store: MemIndex }> {
  const store = new MemIndex();
  const rx = await startReceiver({ port: 0, store, blobs: new MemBlobs(), ...extra });
  receivers.push(rx);
  return { rx, store };
}

function post(rx: Receiver | string, path: string, body: string | Uint8Array, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, typeof rx === "string" ? rx : rx.url), { method: "POST", headers: { "Content-Length": String(Buffer.byteLength(body)), ...headers }, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_TYPE = { "Content-Type": "application/json" };
const EMPTY_TRACES = JSON.stringify({ resourceSpans: [] });

describe("the OTLP receiver", () => {
  it("bounds the time a client may take to send its headers and its body", async () => {
    const { rx } = await receiver();
    const { headersTimeout, requestTimeout } = rx.server;
    assert.ok(headersTimeout > 0 && headersTimeout <= 20_000, `headersTimeout ${headersTimeout}`);
    assert.ok(requestTimeout > 0 && requestTimeout <= 120_000, `requestTimeout ${requestTimeout}`);
    assert.ok(headersTimeout <= requestTimeout);
  });

  it("listens on loopback only unless told otherwise", async () => {
    const store = new MemIndex();
    await assert.rejects(startReceiver({ host: "0.0.0.0", port: 0, store, blobs: new MemBlobs() }), /non-loopback/);
  });

  it("answers only loopback Host names and local page origins", async () => {
    const { rx, store } = await receiver();
    assert.equal(await post(rx, "/v1/traces", EMPTY_TRACES, { ...JSON_TYPE, Host: `rebind.example:${rx.port}` }), 403);
    assert.equal(await post(rx, "/v1/traces", EMPTY_TRACES, { ...JSON_TYPE, Origin: "https://elsewhere.example" }), 403);
    assert.equal(await post(rx, "/v1/traces", EMPTY_TRACES, { ...JSON_TYPE, Origin: "null" }), 403, "an opaque origin");
    assert.equal(await post(rx, "/v1/traces", EMPTY_TRACES, { ...JSON_TYPE, Origin: "http://localhost:5173" }), 200, "a local page");
    assert.equal(await post(rx, "/v1/traces", EMPTY_TRACES, { ...JSON_TYPE, Host: `localhost:${rx.port}` }), 200);
    assert.equal(store.events.size, 0);
  });

  it("refuses a body over its limit, also once decompressed, and a body that does not decode", async () => {
    const { rx, store } = await receiver({ maxBodyBytes: 64 * 1024 });
    assert.equal(await post(rx, "/v1/traces", JSON.stringify({ resourceSpans: [], pad: "x".repeat(70 * 1024) }), JSON_TYPE), 413);
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x20));
    assert.ok(bomb.byteLength < 64 * 1024);
    assert.equal(await post(rx, "/v1/traces", bomb, { ...JSON_TYPE, "Content-Encoding": "gzip" }), 413);
    assert.equal(await post(rx, "/v1/traces", "{\"resourceSpans\": [", JSON_TYPE), 400);
    assert.equal(await post(rx, "/v1/traces", Uint8Array.from([0x0a, 0x7f, 0x01]), { "Content-Type": "application/x-protobuf" }), 400);
    assert.equal(store.events.size, 0);
  });

  it("serves the eve evals route only to a loopback client that is not a browser page", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-sec-servers-"));
    dirs.push(root);
    const index = new MemIndex();
    const { rx } = await receiver({ routes: { [EVE_EVALS_PATH]: createEveEvalsHandler({ store: new FileEvalStore({ root, index }) }) } });
    assert.equal(await post(rx, EVE_EVALS_PATH, "{}", { ...JSON_TYPE, Host: `rebind.example:${rx.port}` }), 403);
    assert.equal(await post(rx, EVE_EVALS_PATH, "{}", { ...JSON_TYPE, Origin: "http://localhost:5173" }), 403, "even a local page");
    assert.equal(await post(rx, EVE_EVALS_PATH, "{}", { ...JSON_TYPE, Origin: "null" }), 403);
    assert.equal(await post(rx, EVE_EVALS_PATH, "{}", { "Content-Type": "text/plain" }), 415, "a body a page could send without asking first");
    assert.deepEqual(readdirSync(root), []);
  });
});

describe("the OTLP receiver a run starts for its agent", () => {
  it("redacts with the rules the run was given, not only the built-in ones", async () => {
    const store = new MemIndex();
    const blobs = new MemBlobs();
    const rx = await startRunReceiver(store, blobs, createRedactor({ redact: ["secrets", "email"], patterns: ["ticket-[0-9]{5}"] }));
    try {
      const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
      const tool = otlpSpan(trace, "a000000000000002", "a000000000000001", "execute_tool Bash", [
        sAttr("gen_ai.operation.name", "execute_tool"),
        sAttr("gen_ai.tool.name", "Bash"),
        sAttr("gen_ai.tool.call.id", "c1"),
        sAttr("gen_ai.tool.call.arguments", JSON.stringify({ command: "gh issue close" })),
        sAttr("gen_ai.tool.call.result", "closed ticket-48151 for dana@example.org"),
      ], 10, 20);
      const root = otlpSpan(trace, "a000000000000001", undefined, "invoke_agent ops", [sAttr("gen_ai.operation.name", "invoke_agent")], 0, 100);
      assert.equal(await post(rx.endpoint, "/v1/traces", JSON.stringify(otlpTraces("agent", [root, tool])), JSON_TYPE), 200);
      const stored = [JSON.stringify(store.all()), ...[...blobs.data.values()].map((b) => Buffer.from(b).toString())].join("\n");
      assert.match(stored, /\[redacted:pattern\]/, "the tool result was stored, redacted");
      assert.doesNotMatch(stored, /ticket-48151/);
      assert.doesNotMatch(stored, /dana@example\.org/);
    } finally {
      await rx.close();
    }
  });
});

describe("the MCP server", () => {
  it("answers a tool call that names a folder git can't start in, and stays up", async () => {
    const w = makeWorld();
    const cwd = join(w.root, "work");
    mkdirSync(cwd);
    // Windows can't start a process in a folder whose path is 259 characters or longer.
    const repos = [join(cwd, "x".repeat(300)), join(cwd, "missing")];
    const c = new RawClient(w.env, cwd);
    clients.push(c);
    let code: number | null | undefined;
    const exited = new Promise<"exited">((r) => c.child.once("exit", (n) => ((code = n), r("exited"))));
    await c.initialize();
    for (const repo of repos) {
      const answer = await Promise.race([c.request("tools/call", { name: "improve", arguments: { repo } }), exited]);
      assert.notEqual(answer, "exited", `the server ended (exit ${code}) on ${repo.length} characters: ${c.stderr.slice(-400)}`);
    }
    const status = await Promise.race([c.request("tools/call", { name: "status", arguments: {} }), exited]);
    assert.notEqual(status, "exited", "the server answers the next call");
    assert.equal(await c.close(), 0);
  });

  it("gets an error that says why when git can't start in a folder", async () => {
    const w = makeWorld();
    await assert.rejects(runGit(["--version"], { cwd: join(w.root, "missing") }), /: no folder /);
    if (process.platform !== "win32") return;
    const deep = join(w.root, "a".repeat(200), "b".repeat(80));
    mkdirSync(deep, { recursive: true });
    await assert.rejects(runGit(["--version"], { cwd: deep }), /: can't start git in a folder whose path is \d+ characters long/);
  });
});
