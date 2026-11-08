// Test helpers for the proxy: a scriptable upstream, a client that records
// when each chunk arrived, and a proxy over in-memory stores.
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultConfig } from "../../src/core/config.ts";
import type { Config } from "../../src/core/types.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import type { Recorder } from "../../src/proxy/record.ts";
import { type ProxyServer, startProxy, type Upstreams } from "../../src/proxy/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface Upstream {
  url: string;
  seen: Seen[];
  server: Server;
  close(): Promise<void>;
}

/** An upstream whose handler gets the request and its full body. */
export async function startUpstream(handle: (req: Seen, res: ServerResponse) => void | Promise<void>): Promise<Upstream> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      void handle(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    server,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface ClientResult {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
  /** Each chunk with the time it arrived. */
  chunks: { at: number; data: Buffer }[];
}

export function call(base: string, opts: { method?: string; path: string; body?: string | Buffer; headers?: Record<string, string>; onChunk?: (c: Buffer) => void; signal?: AbortSignal }): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(opts.path, base), { method: opts.method ?? "POST", headers: opts.headers, agent: false, signal: opts.signal }, (res) => {
      const chunks: { at: number; data: Buffer }[] = [];
      res.on("data", (c: Buffer) => {
        chunks.push({ at: Date.now(), data: c });
        opts.onChunk?.(c);
      });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks.map((c) => c.data)), chunks }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

export interface TestProxy {
  proxy: ProxyServer;
  index: MemoryIndexStore;
  blobs: MemoryBlobStore;
  recorder: Recorder;
  errors: Error[];
  events(): Promise<AgentEvent[]>;
  close(): Promise<void>;
}

export async function startTestProxy(upstream: string, o: { config?: Partial<Config["capture"]>; write?: (events: AgentEvent[]) => Promise<void>; upstreams?: Partial<Upstreams> } = {}): Promise<TestProxy> {
  const index = new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  const base = defaultConfig({ HOME: "/nonexistent", CODING_SH_HOME: "/nonexistent/.coding.sh" });
  const config: Config = { ...base, capture: { ...base.capture, ...o.config } };
  const errors: Error[] = [];
  const recorder = recorderFor({ config, index, blobs, env: {}, onError: (e) => errors.push(e), ...(o.write ? { write: o.write } : {}) });
  const proxy = await startProxy({ port: 0, upstreams: { anthropic: upstream, openai: upstream, ...o.upstreams }, recorder });
  return {
    proxy,
    index,
    blobs,
    recorder,
    errors,
    async events() {
      await recorder.flush();
      const out: AgentEvent[] = [];
      for (const s of await index.listSessions()) out.push(...(await index.listEvents(s.id)));
      return out;
    },
    close: () => proxy.close(),
  };
}

/** Every stored byte (events and blobs) as one string, for "never stored" checks. */
export async function everything(t: TestProxy): Promise<string> {
  const parts: string[] = [];
  for (const s of await t.index.listSessions()) {
    parts.push(JSON.stringify(s));
    for (const e of await t.index.listEvents(s.id)) parts.push(JSON.stringify(e));
  }
  for await (const ref of t.blobs.list()) parts.push((await t.blobs.getText(ref)) ?? "");
  return parts.join("\n");
}

export const sse = (events: { event?: string; data: unknown }[]): string[] =>
  events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);

/** A realistic Anthropic Messages stream, as event strings. */
export function anthropicStream(o: { id?: string; model?: string; text?: string; tool?: { name: string; input: unknown } } = {}): string[] {
  const id = o.id ?? "msg_test_1";
  const model = o.model ?? "claude-sonnet-4-5-20250929";
  const ev: { event?: string; data: unknown }[] = [
    { event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 12, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "ping", data: { type: "ping" } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: o.text ?? "Hello" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  ];
  let stop = "end_turn";
  if (o.tool) {
    stop = "tool_use";
    const json = JSON.stringify(o.tool.input);
    ev.push(
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: o.tool.name, input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(5) } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    );
  }
  ev.push(
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return sse(ev);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
