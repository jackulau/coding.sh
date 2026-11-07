// MCP tap (§5.3): forwards every JSON-RPC message between a client (an agent
// or the model driver) and the real server, records one TapRecord per
// request, validates tools/call arguments against the tool's inputSchema, and
// applies the variant's overrides (descriptions, paramDescriptions, hideTools)
// to tools/list results.
//
// Hosting: a stdio server is exposed through a relay (`bin/mcp-<name>.mjs`, a
// generated script that pipes stdio to a loopback TCP port served here, one
// upstream process per connection); an HTTP server is exposed as a local
// Streamable HTTP endpoint. Both keep the whole tap in this process, so they
// work from src/ and from the dist bundle alike. `tap/main.ts mcp` runs the
// same tap as a standalone stdio process.
import { spawn } from "../../core/spawn.ts";
import { trackChild } from "../../core/children.ts";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { schemaViolations } from "../jsonschema.ts";
import { errorResponse, isNotification, isObj, isRequest, isResponse, LineSplitter, RPC, wireBytes, type RpcRequest, type RpcResponse } from "../mcp/jsonrpc.ts";
import { parseMcpBody } from "../mcp/http.ts";
import type { McpTarget, McpTool, TapClass, TapRecord, Variant } from "../types.ts";

export const DEFAULT_VALIDATION_PATTERNS = [
  "invalid (argument|arguments|params|parameters|input)",
  "validation (error|failed)",
  "required (property|parameter|field|argument)",
  "unknown (argument|parameter|property)",
  "expected .+ received",
];

/** The tool list as a client sees it under a variant: hidden tools removed, descriptions replaced. */
export function applyToolOverrides(tools: readonly McpTool[], v: Pick<Variant, "descriptions" | "paramDescriptions" | "hideTools">): McpTool[] {
  const hide = new Set(v.hideTools ?? []);
  return tools
    .filter((t) => !hide.has(t.name))
    .map((t) => {
      const out = structuredClone(t);
      const d = v.descriptions?.[t.name];
      if (d !== undefined) out.description = d;
      const pd = v.paramDescriptions?.[t.name];
      if (pd) {
        const props = isObj(out.inputSchema) && isObj((out.inputSchema as Record<string, unknown>).properties) ? ((out.inputSchema as Record<string, unknown>).properties as Record<string, unknown>) : undefined;
        if (props) {
          for (const [param, desc] of Object.entries(pd)) {
            const p = props[param];
            if (!isObj(p)) continue;
            if (desc === "") delete p.description;
            else p.description = desc;
          }
        }
      }
      return out;
    });
}

export interface McpTapOpts {
  variant?: Pick<Variant, "descriptions" | "paramDescriptions" | "hideTools">;
  docTools?: string[];
  validationPatterns?: string[];
  record: (r: TapRecord) => void;
  now?: () => number;
}

interface Pending {
  method: string;
  tool?: string;
  ts: number;
  t0: number;
  requestBytes: number;
  violations?: string[];
  unknownTool?: boolean;
}

const META_METHODS = new Set(["initialize", "server/discover", "tools/list", "ping", "logging/setLevel"]);

/** Message-level tap: feed it every message in both directions. */
export class McpTap {
  /** Upstream tools by name (pre-override), from the last tools/list. */
  readonly tools = new Map<string, McpTool>();
  private readonly pending = new Map<string, Pending>();
  private readonly o: McpTapOpts;
  private readonly hidden: Set<string>;
  private readonly patterns: RegExp[];

  constructor(o: McpTapOpts) {
    this.o = o;
    this.hidden = new Set(o.variant?.hideTools ?? []);
    this.patterns = (o.validationPatterns ?? DEFAULT_VALIDATION_PATTERNS).map((p) => new RegExp(p, "i"));
  }

  private emit(p: Pending, r: Partial<TapRecord> & { class: TapClass }, responseBytes: number): void {
    const rec: TapRecord = {
      ts: p.ts,
      durationMs: Math.round((performance.now() - p.t0) * 1000) / 1000,
      target: "mcp",
      method: p.method,
      requestBytes: p.requestBytes,
      responseBytes,
      ...r,
    };
    if (p.tool !== undefined) rec.tool = p.tool;
    if (p.violations?.length) rec.schemaViolations = p.violations;
    this.o.record(rec);
  }

  /** Client → server. Returns what to forward upstream, or a reply to send straight back. */
  fromClient(msg: unknown): { forward?: unknown; reply?: RpcResponse } {
    const now = this.o.now?.() ?? Date.now();
    if (isNotification(msg)) {
      this.o.record({ ts: now, durationMs: 0, target: "mcp", class: "meta", method: msg.method, requestBytes: wireBytes(msg), responseBytes: 0 });
      return { forward: msg };
    }
    if (!isRequest(msg)) return { forward: msg }; // a response to a server → client request
    const p: Pending = { method: msg.method, ts: now, t0: performance.now(), requestBytes: wireBytes(msg) };
    if (msg.method === "tools/call") {
      const params = isObj(msg.params) ? msg.params : {};
      const name = typeof params.name === "string" ? params.name : undefined;
      p.tool = name;
      if (name === undefined || this.hidden.has(name)) {
        const reply = errorResponse(msg.id, RPC.INVALID_PARAMS, `Unknown tool: ${name ?? "(missing name)"}`);
        this.emit(p, { class: "invalid", reason: "unknown-tool", rpcErrorCode: RPC.INVALID_PARAMS }, wireBytes(reply));
        return { reply };
      }
      const tool = this.tools.get(name);
      if (this.tools.size && !tool) p.unknownTool = true;
      if (tool) {
        const v = schemaViolations(params.arguments ?? {}, tool.inputSchema);
        if (v.length) p.violations = v;
      }
    }
    this.pending.set(String(msg.id), p);
    return { forward: msg };
  }

  /** Server → client. Returns the message to deliver (tools/list rewritten). */
  fromServer(msg: unknown): unknown {
    if (!isResponse(msg)) return msg;
    const key = String(msg.id);
    const p = this.pending.get(key);
    if (!p) return msg;
    this.pending.delete(key);
    let out: RpcResponse = msg;
    if (p.method === "tools/list" && isObj(msg.result) && Array.isArray(msg.result.tools)) {
      const tools = (msg.result.tools as unknown[]).filter((t): t is McpTool => isObj(t) && typeof t.name === "string");
      for (const t of tools) this.tools.set(t.name, t);
      out = { ...msg, result: { ...msg.result, tools: applyToolOverrides(tools, this.o.variant ?? {}) } };
    }
    const bytes = wireBytes(out);
    if (msg.error) {
      const code = msg.error.code;
      const invalidCode = code === RPC.INVALID_REQUEST || code === RPC.METHOD_NOT_FOUND || code === RPC.INVALID_PARAMS;
      if (invalidCode || p.unknownTool || p.violations?.length) {
        const reason = p.unknownTool || (code === RPC.INVALID_PARAMS && /unknown tool|tool .*not found|no such tool/i.test(msg.error.message)) ? "unknown-tool" : code === RPC.METHOD_NOT_FOUND ? "unknown-method" : code === RPC.INVALID_REQUEST ? "invalid-request" : "schema";
        this.emit(p, { class: "invalid", reason, rpcErrorCode: code }, bytes);
      } else {
        this.emit(p, { class: META_METHODS.has(p.method) ? "meta" : "failed", reason: `rpc${code}`, rpcErrorCode: code }, bytes);
      }
      return out;
    }
    if (META_METHODS.has(p.method)) {
      this.emit(p, { class: "meta" }, bytes);
      return out;
    }
    const res = isObj(msg.result) ? msg.result : {};
    const isError = res.isError === true;
    if (isError) {
      const text = Array.isArray(res.content) ? (res.content as unknown[]).map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).join("\n") : "";
      if (p.violations?.length || this.patterns.some((r) => r.test(text))) this.emit(p, { class: "invalid", reason: "schema", isError: true }, bytes);
      else this.emit(p, { class: "failed", reason: "tool-error", isError: true }, bytes);
      return out;
    }
    if (p.violations?.length) {
      // The server accepted arguments its own schema rejects: still a misuse.
      this.emit(p, { class: "invalid", reason: "schema" }, bytes);
      return out;
    }
    const help = p.tool !== undefined && (this.o.docTools ?? []).includes(p.tool);
    this.emit(p, { class: help ? "help" : "ok" }, bytes);
    return out;
  }

  /** Requests that never got a reply (server died, client closed): recorded as failed. */
  flush(reason = "no-reply"): void {
    for (const p of this.pending.values()) this.emit(p, { class: META_METHODS.has(p.method) ? "meta" : "failed", reason }, 0);
    this.pending.clear();
  }
}

/** Append-only tap.jsonl writer. */
export function tapWriter(file: string): (r: TapRecord) => void {
  return (r) => {
    try {
      appendFileSync(file, JSON.stringify(r) + "\n");
    } catch {
      // the trial dir is gone; nothing to record into
    }
  };
}

// ------------------------------------------------------------ stdio bridge

export interface UpstreamStdio {
  command: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Pipes a newline-delimited JSON client stream through `tap` into a spawned
 * stdio server. Resolves when both sides are done. Closing the client input
 * closes the server's stdin, then SIGTERM/SIGKILL after `graceMs` each.
 */
export function bridgeStdio(tap: McpTap, client: { input: Readable; output: Writable }, up: UpstreamStdio, o: { graceMs?: number; record?: (r: TapRecord) => void } = {}): Promise<void> {
  const [file, ...args] = up.command;
  if (!file) return Promise.reject(new Error("MCP command is empty"));
  const grace = o.graceMs ?? 2000;
  const child = spawn(file, args, { cwd: up.cwd, env: (up.env ?? process.env) as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  trackChild(child);
  let stderr = "";
  const write = (stream: Writable, m: unknown) => {
    if (stream.writable) stream.write(JSON.stringify(m) + "\n");
  };
  return new Promise((resolve) => {
    let exited = false;
    const fromClient = new LineSplitter();
    client.input.setEncoding("utf8");
    client.input.on("data", (chunk: string) =>
      fromClient.push(chunk, (line) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          write(client.output, errorResponse(null, RPC.PARSE_ERROR, "Parse error"));
          return;
        }
        const r = tap.fromClient(msg);
        if (r.reply) write(client.output, r.reply);
        if (r.forward !== undefined) write(child.stdin, r.forward);
      }),
    );
    const endUpstream = () => {
      if (exited) return;
      child.stdin.end();
      const t1 = setTimeout(() => {
        if (!exited) child.kill("SIGTERM");
        const t2 = setTimeout(() => !exited && child.kill("SIGKILL"), grace);
        t2.unref();
      }, grace);
      t1.unref();
    };
    client.input.on("end", endUpstream);
    client.input.on("close", endUpstream);
    client.input.on("error", endUpstream);
    client.output.on("error", () => {});
    const fromServer = new LineSplitter();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) =>
      fromServer.push(chunk, (line) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        write(client.output, tap.fromServer(msg));
      }),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 8192) stderr = (stderr + c).slice(0, 8192);
    });
    child.stdin.on("error", () => {});
    const done = () => {
      if (exited) return;
      exited = true;
      tap.flush("server-exited");
      if (stderr && o.record) o.record({ ts: Date.now(), durationMs: 0, target: "mcp", class: "meta", method: "server/stderr", serverStderr: stderr });
      client.output.end();
      resolve();
    };
    child.on("exit", done);
    child.on("error", (e) => {
      stderr += e.message;
      done();
    });
  });
}

// ------------------------------------------------------------ hosting

export interface McpProxyHandle {
  /** argv an MCP client spawns for stdio (relay script). */
  stdio?: string[];
  /** Streamable HTTP endpoint. */
  url?: string;
  close(): Promise<void>;
}

export interface McpProxyOpts {
  target: McpTarget;
  variant: Variant;
  tapLog: string;
  /** Where the relay script goes (sandbox bin dir). */
  binDir: string;
  env?: Record<string, string>;
  cwd?: string;
  graceMs?: number;
  fetch?: typeof fetch;
}

function relaySource(port: number): string {
  return `#!${process.execPath}
// coding.sh MCP tap relay (generated): pipes this process's stdio to the tap on 127.0.0.1:${port}.
import { connect } from "node:net";
const s = connect(${port}, "127.0.0.1");
process.stdin.pipe(s);
s.pipe(process.stdout);
s.on("error", (e) => { process.stderr.write("coding.sh tap relay: " + e.message + "\\n"); process.exit(1); });
s.on("close", () => process.exit(0));
`;
}

function makeTap(o: McpProxyOpts, record: (r: TapRecord) => void): McpTap {
  return new McpTap({ variant: o.variant, docTools: o.target.docTools, validationPatterns: o.target.validationPatterns, record });
}

/** Starts the tap for one trial. stdio targets get a relay command; HTTP targets a local URL. */
export async function startMcpProxy(o: McpProxyOpts): Promise<McpProxyHandle> {
  const record = tapWriter(o.tapLog);
  if (o.target.transport === "stdio") {
    const command = o.variant.command ?? o.target.command;
    const sockets = new Set<Socket>();
    const bridges = new Set<Promise<void>>();
    const server = createNetServer((sock) => {
      sockets.add(sock);
      const b = bridgeStdio(makeTap(o, record), { input: sock, output: sock }, { command, env: { ...process.env, ...(o.env ?? {}) }, cwd: o.cwd }, { graceMs: o.graceMs, record }).finally(() => {
        sock.destroy();
        sockets.delete(sock);
        bridges.delete(b);
      });
      bridges.add(b);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    await mkdir(o.binDir, { recursive: true });
    const relay = join(o.binDir, `mcp-${o.target.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.mjs`);
    await writeFile(relay, relaySource(port), "utf8");
    await chmod(relay, 0o755);
    return {
      stdio: [process.execPath, relay],
      async close() {
        for (const s of sockets) s.end();
        await Promise.race([Promise.all([...bridges]), new Promise((r) => setTimeout(r, (o.graceMs ?? 2000) * 2 + 500).unref())]);
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  // HTTP target: a local Streamable HTTP endpoint that forwards to the real one.
  const upstream = o.variant.url ?? o.target.url;
  const tap = makeTap(o, record);
  const doFetch = o.fetch ?? fetch;
  const server = createHttpServer((req, res) => void handleHttp(req, res));
  const PASS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id"];
  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = { ...(o.target.transport === "http" ? (o.target.headers ?? {}) : {}) };
      for (const h of PASS) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      if (req.method !== "POST") {
        const r = await doFetch(upstream, { method: req.method, headers });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(errorResponse(null, RPC.PARSE_ERROR, "Parse error")));
        return;
      }
      const t = tap.fromClient(msg);
      if (t.reply) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(t.reply));
        return;
      }
      const r = await doFetch(upstream, { method: "POST", headers, body: JSON.stringify(t.forward) });
      const ct = r.headers.get("content-type") ?? "";
      const text = await r.text();
      const msgs = parseMcpBody(ct, text).map((m) => tap.fromServer(m));
      const outHeaders: Record<string, string> = {};
      const sid = r.headers.get("mcp-session-id");
      if (sid) outHeaders["mcp-session-id"] = sid;
      if (!msgs.length) {
        if (isRequest(msg)) tap.fromServer(errorResponse((msg as RpcRequest).id, RPC.INTERNAL_ERROR, `HTTP ${r.status}`));
        if (ct) outHeaders["content-type"] = ct;
        res.writeHead(r.status, outHeaders);
        res.end(text);
        return;
      }
      if (ct.includes("text/event-stream")) {
        outHeaders["content-type"] = "text/event-stream";
        res.writeHead(r.status, outHeaders);
        res.end(msgs.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
      } else {
        outHeaders["content-type"] = "application/json";
        res.writeHead(r.status, outHeaders);
        res.end(JSON.stringify(msgs.length === 1 ? msgs[0] : msgs));
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify(errorResponse(null, RPC.INTERNAL_ERROR, `tap proxy: ${e instanceof Error ? e.message : String(e)}`)));
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      tap.flush("closed");
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
