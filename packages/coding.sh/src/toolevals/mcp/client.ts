// Dual-era MCP client (§10): the 2026-07-28 stateless protocol plus legacy
// 2025-11-25 / 2025-06-18 / 2025-03-26, over stdio or Streamable HTTP. Tools
// (with progress notifications and task-augmented calls), resources, prompts,
// and the server → client requests the caller has handlers for: sampling,
// elicitation and roots. OAuth (mcp/oauth.ts) runs on an HTTP 401.
import type { CallToolResult, McpTool } from "../types.ts";
import { HttpStatusError, HttpTransport } from "./http.ts";
import { errorResponse, isObj, LEGACY_VERSIONS, MODERN_VERSION, RPC, RpcError, type RpcNotification, type RpcRequest, type RpcResponse } from "./jsonrpc.ts";
import type { OAuthSession } from "./oauth.ts";
import { StdioTransport, TimeoutError, type Transport } from "./stdio.ts";

export type { McpTool, CallToolResult };

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  /** base64 */
  blob?: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: string; text?: string; [k: string]: unknown };
}

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

/** Answers to server → client requests. A capability is declared only when its handler is set. */
export interface McpClientHandlers {
  /** sampling/createMessage: params as sent; returns the CreateMessageResult. */
  sampling?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** elicitation/create: returns { action, content? }. */
  elicitation?: (params: Record<string, unknown>) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  /** roots/list */
  roots?: () => Promise<{ uri: string; name?: string }[]>;
  /** Every notification from the server (progress ones too). */
  onNotification?: (m: RpcNotification) => void;
}

export interface CallToolOpts {
  timeoutMs?: number;
  onProgress?: (p: McpProgress) => void;
}

/** Task states that end a task-augmented call (2025-11-25 tasks). */
const TASK_DONE = new Set(["completed", "failed", "cancelled"]);

export interface McpClient {
  era: "2026-07-28" | "legacy";
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  /** The server's declared capabilities (initialize or server/discover). */
  capabilities?: Record<string, unknown>;
  listTools(): Promise<McpTool[]>;
  /** A tool whose execution.taskSupport is "required" (or "optional" on a server with task-augmented tools/call) runs as a task: created, polled with tasks/get, then read with tasks/result. */
  callTool(name: string, args: object, o?: CallToolOpts): Promise<CallToolResult>;
  listResources(): Promise<McpResource[]>;
  listResourceTemplates(): Promise<McpResourceTemplate[]>;
  readResource(uri: string): Promise<McpResourceContents[]>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<{ description?: string; messages: McpPromptMessage[] }>;
  close(): Promise<void>;
  /** stderr head of a stdio server (first 8 KB). */
  readonly stderr?: string;
}

export interface McpConnectSpec {
  stdio?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** stdio: wait this long for a server/discover reply before falling back to legacy (default 5000). */
  discoverTimeoutMs?: number;
  /** stdio shutdown grace per step (default 2000). */
  graceMs?: number;
  clientInfo?: { name: string; version: string };
  /** Server → client requests (sampling, elicitation, roots) and notifications. */
  handlers?: McpClientHandlers;
  /** HTTP: answers a 401 by running OAuth (mcp/oauth.ts), then retries with the token. */
  oauth?: OAuthSession;
}

export class UnsupportedTransportError extends Error {
  readonly reason = "unsupported-transport";
  constructor(msg: string) {
    super(msg);
    this.name = "UnsupportedTransportError";
  }
}

const CLIENT_INFO = { name: "coding.sh-toolevals", version: "0" };
const META = "io.modelcontextprotocol/";

/** Era cache per server (stdio argv or URL), so repeated trials skip detection. */
const eraCache = new Map<string, "modern" | "legacy">();

/** The capabilities a client with these handlers declares. */
export function clientCapabilities(h: McpClientHandlers | undefined): Record<string, unknown> {
  return {
    ...(h?.sampling ? { sampling: {} } : {}),
    ...(h?.elicitation ? { elicitation: { form: {} } } : {}),
    ...(h?.roots ? { roots: { listChanged: false } } : {}),
  };
}

function modernMeta(clientInfo: { name: string; version: string }, caps: Record<string, unknown> = {}): Record<string, unknown> {
  return { [`${META}protocolVersion`]: MODERN_VERSION, [`${META}clientCapabilities`]: caps, [`${META}clientInfo`]: clientInfo };
}

/** Text of a prompt's messages, one block per message (`role: text`). */
export function promptText(messages: readonly McpPromptMessage[]): string {
  return messages
    .map((m) => {
      const c = m.content;
      const body = c.type === "text" && typeof c.text === "string" ? c.text : c.type === "resource" && isObj(c.resource) && typeof c.resource.text === "string" ? c.resource.text : `[${c.type}]`;
      return messages.length === 1 && m.role === "user" ? body : `${m.role}: ${body}`;
    })
    .join("\n\n");
}

/** Text of a resource read: text contents as-is, binary ones as a marker. */
export function resourceText(contents: readonly McpResourceContents[]): string {
  return contents.map((c) => (typeof c.text === "string" ? c.text : `[${c.mimeType ?? "binary"} ${c.blob ? Buffer.from(c.blob, "base64").length : 0} bytes at ${c.uri}]`)).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Text the model sees for a tool result: structuredContent JSON, else text blocks; images become a marker. */
export function resultText(r: CallToolResult): string {
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof (c as { text?: unknown }).text === "string") parts.push((c as { text: string }).text);
    else if (c.type === "image") parts.push(`[image ${String((c as { mimeType?: unknown }).mimeType ?? "")}]`);
    else if (c.type === "resource_link") parts.push(`[resource ${String((c as { uri?: unknown }).uri ?? "")}]`);
    else if (c.type === "resource") {
      const res = (c as { resource?: { uri?: string; text?: string } }).resource;
      parts.push(res?.text ?? `[resource ${res?.uri ?? ""}]`);
    }
  }
  return parts.join("\n");
}

function unwrap(r: RpcResponse): unknown {
  if (r.error) throw new RpcError(r.error);
  return r.result;
}

function supportedFrom(v: unknown): string[] {
  if (isObj(v) && Array.isArray(v.supported)) return v.supported.filter((x): x is string => typeof x === "string");
  if (isObj(v) && Array.isArray(v.supportedVersions)) return v.supportedVersions.filter((x): x is string => typeof x === "string");
  return [];
}

class Client implements McpClient {
  era: "2026-07-28" | "legacy" = "legacy";
  protocolVersion = "";
  serverInfo?: { name: string; version: string };
  instructions?: string;
  capabilities?: Record<string, unknown>;
  private nextId = 1;
  private progressSeq = 0;
  readonly t: Transport;
  private readonly clientInfo: { name: string; version: string };
  private readonly handlers: McpClientHandlers;
  private readonly caps: Record<string, unknown>;
  private readonly progress = new Map<string, (p: McpProgress) => void>();
  /** Tools from the last tools/list, for execution.taskSupport. */
  private readonly toolInfo = new Map<string, McpTool>();

  constructor(t: Transport, clientInfo: { name: string; version: string }, handlers: McpClientHandlers = {}) {
    this.t = t;
    this.clientInfo = clientInfo;
    this.handlers = handlers;
    this.caps = clientCapabilities(handlers);
  }

  /** A server → client request: answered from the handlers (ping always). */
  async onRequest(msg: RpcRequest): Promise<RpcResponse> {
    const params = isObj(msg.params) ? msg.params : {};
    const h = this.handlers;
    try {
      if (msg.method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
      if (msg.method === "sampling/createMessage" && h.sampling) return { jsonrpc: "2.0", id: msg.id, result: await h.sampling(params) };
      if (msg.method === "elicitation/create" && h.elicitation) return { jsonrpc: "2.0", id: msg.id, result: await h.elicitation(params) };
      if (msg.method === "roots/list" && h.roots) return { jsonrpc: "2.0", id: msg.id, result: { roots: await h.roots() } };
    } catch (e) {
      return errorResponse(msg.id, RPC.INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
    return errorResponse(msg.id, RPC.METHOD_NOT_FOUND, `client does not support ${msg.method}`);
  }

  onNotification(m: RpcNotification): void {
    if (m.method === "notifications/progress" && isObj(m.params)) {
      const cb = this.progress.get(String(m.params.progressToken));
      if (cb && typeof m.params.progress === "number") cb({ progress: m.params.progress, ...(typeof m.params.total === "number" ? { total: m.params.total } : {}), ...(typeof m.params.message === "string" ? { message: m.params.message } : {}) });
    }
    this.handlers.onNotification?.(m);
  }

  get stderr(): string | undefined {
    return this.t instanceof StdioTransport ? this.t.stderrHead : undefined;
  }

  async rpc(method: string, params: Record<string, unknown> = {}, o: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    const p = this.era === MODERN_VERSION ? { ...params, _meta: { ...(isObj(params._meta) ? params._meta : {}), ...modernMeta(this.clientInfo, this.caps) } } : params;
    return this.t.request({ jsonrpc: "2.0", id: this.nextId++, method, params: p }, o);
  }

  async initializeLegacy(): Promise<void> {
    this.era = "legacy";
    const r = unwrap(await this.rpc("initialize", { protocolVersion: LEGACY_VERSIONS[0], capabilities: this.caps, clientInfo: this.clientInfo }));
    const res = isObj(r) ? r : {};
    const v = typeof res.protocolVersion === "string" ? res.protocolVersion : "";
    if (!(LEGACY_VERSIONS as readonly string[]).includes(v)) {
      await this.t.close();
      throw new Error(`MCP server negotiated unsupported protocol version ${JSON.stringify(v)}`);
    }
    this.protocolVersion = v;
    if (isObj(res.capabilities)) this.capabilities = res.capabilities;
    if (isObj(res.serverInfo)) this.serverInfo = { name: String(res.serverInfo.name ?? ""), version: String(res.serverInfo.version ?? "") };
    if (typeof res.instructions === "string") this.instructions = res.instructions;
    if (this.t instanceof HttpTransport) this.t.protocolVersion = v;
    await this.t.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  setModern(result: unknown): void {
    this.era = MODERN_VERSION;
    this.protocolVersion = MODERN_VERSION;
    const res = isObj(result) ? result : {};
    if (isObj(res.capabilities)) this.capabilities = res.capabilities;
    if (isObj(res.serverInfo)) this.serverInfo = { name: String(res.serverInfo.name ?? ""), version: String(res.serverInfo.version ?? "") };
    if (typeof res.instructions === "string") this.instructions = res.instructions;
    if (this.t instanceof HttpTransport) {
      this.t.modern = true;
      this.t.protocolVersion = MODERN_VERSION;
    }
  }

  /** Every page of a paginated list method. */
  private async pages<T>(method: string, key: string, keep: (v: Record<string, unknown>) => boolean): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = unwrap(await this.rpc(method, cursor ? { cursor } : {}));
      const res = isObj(r) ? r : {};
      for (const t of Array.isArray(res[key]) ? (res[key] as unknown[]) : []) if (isObj(t) && keep(t)) out.push(t as unknown as T);
      cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async listTools(): Promise<McpTool[]> {
    const tools = await this.pages<McpTool>("tools/list", "tools", (t) => typeof t.name === "string");
    this.toolInfo.clear();
    for (const t of tools) this.toolInfo.set(t.name, t);
    return tools;
  }

  /** Whether a call of this tool runs as a task. */
  private taskMode(name: string): boolean {
    const exec = (this.toolInfo.get(name) as { execution?: { taskSupport?: unknown } } | undefined)?.execution;
    if (exec?.taskSupport === "required") return true;
    const caps = this.capabilities;
    const serverTasks = isObj(caps?.tasks) && isObj(caps.tasks.requests) && isObj(caps.tasks.requests.tools) && isObj(caps.tasks.requests.tools.call);
    return exec?.taskSupport === "optional" && serverTasks;
  }

  async callTool(name: string, args: object, o: CallToolOpts = {}): Promise<CallToolResult> {
    const started = Date.now();
    const params: Record<string, unknown> = { name, arguments: args };
    let token: string | undefined;
    if (o.onProgress) {
      token = `p${++this.progressSeq}`;
      this.progress.set(token, o.onProgress);
      params._meta = { progressToken: token };
    }
    const asTask = this.taskMode(name);
    if (asTask) params.task = { ttl: Math.max(60_000, o.timeoutMs ?? 0) };
    try {
      let r = unwrap(await this.rpc("tools/call", params, o));
      let res = isObj(r) ? r : {};
      const task = isObj(res.task) && typeof res.task.taskId === "string" && res.content === undefined ? res.task : undefined;
      if (task) {
        const taskId = task.taskId as string;
        let status = typeof task.status === "string" ? task.status : "working";
        let wait = typeof task.pollInterval === "number" ? task.pollInterval : 200;
        while (!TASK_DONE.has(status) && status !== "input_required") {
          if (o.timeoutMs && Date.now() - started > o.timeoutMs) throw new TimeoutError(`task ${taskId} of ${name}`, o.timeoutMs);
          await sleep(Math.min(1000, Math.max(20, wait)));
          const g = unwrap(await this.rpc("tasks/get", { taskId }, o));
          const gt = isObj(g) ? g : {};
          status = typeof gt.status === "string" ? gt.status : status;
          if (typeof gt.pollInterval === "number") wait = gt.pollInterval;
        }
        // tasks/result blocks until the task ends (input_required: the server asks for input meanwhile).
        r = unwrap(await this.rpc("tasks/result", { taskId }, o));
        res = isObj(r) ? r : {};
      }
      const out: CallToolResult = { content: Array.isArray(res.content) ? (res.content as CallToolResult["content"]) : [] };
      if (res.structuredContent !== undefined) out.structuredContent = res.structuredContent;
      if (res.isError === true) out.isError = true;
      return out;
    } finally {
      if (token) this.progress.delete(token);
    }
  }

  listResources(): Promise<McpResource[]> {
    return this.pages<McpResource>("resources/list", "resources", (r) => typeof r.uri === "string");
  }

  listResourceTemplates(): Promise<McpResourceTemplate[]> {
    return this.pages<McpResourceTemplate>("resources/templates/list", "resourceTemplates", (r) => typeof r.uriTemplate === "string");
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    const r = unwrap(await this.rpc("resources/read", { uri }));
    const res = isObj(r) ? r : {};
    return (Array.isArray(res.contents) ? res.contents : []).filter((c): c is McpResourceContents => isObj(c) && typeof c.uri === "string");
  }

  listPrompts(): Promise<McpPrompt[]> {
    return this.pages<McpPrompt>("prompts/list", "prompts", (p) => typeof p.name === "string");
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<{ description?: string; messages: McpPromptMessage[] }> {
    const r = unwrap(await this.rpc("prompts/get", { name, arguments: args }));
    const res = isObj(r) ? r : {};
    const messages = (Array.isArray(res.messages) ? res.messages : []).filter((m): m is McpPromptMessage => isObj(m) && isObj(m.content) && typeof m.content.type === "string");
    return { ...(typeof res.description === "string" ? { description: res.description } : {}), messages };
  }

  close(): Promise<void> {
    return this.t.close();
  }
}

/** Decides from a server/discover reply whether to speak modern, legacy, or give up. */
function eraFromDiscover(r: RpcResponse): "modern" | "legacy" {
  if (r.error) {
    if (r.error.code === RPC.UNSUPPORTED_VERSION) {
      const sup = supportedFrom(r.error.data);
      if (sup.includes(MODERN_VERSION)) return "modern";
      if (sup.some((v) => (LEGACY_VERSIONS as readonly string[]).includes(v))) return "legacy";
      throw new Error(`MCP server supports none of our protocol versions (${sup.join(", ") || "none listed"})`);
    }
    if (r.error.code === RPC.HEADER_MISMATCH || r.error.code === RPC.MISSING_CAPABILITY) return "modern";
    return "legacy";
  }
  const res = isObj(r.result) ? r.result : {};
  const sup = supportedFrom(res);
  if (sup.length && !sup.includes(MODERN_VERSION)) return "legacy";
  return "modern";
}

export async function connectMcp(spec: McpConnectSpec): Promise<McpClient> {
  const clientInfo = spec.clientInfo ?? CLIENT_INFO;
  if (spec.stdio) {
    const key = `stdio:${JSON.stringify(spec.stdio)}`;
    let c: Client | undefined;
    const t = new StdioTransport(spec.stdio, { env: spec.env ? { ...process.env, ...spec.env } : undefined, cwd: spec.cwd, graceMs: spec.graceMs, onRequest: (m) => c!.onRequest(m), onNotification: (m) => c?.onNotification(m) });
    c = new Client(t, clientInfo, spec.handlers);
    try {
      const cached = eraCache.get(key);
      if (cached === "legacy") {
        await c.initializeLegacy();
        return c;
      }
      let era: "modern" | "legacy" = "legacy";
      let result: unknown;
      try {
        const r = await t.request(
          { jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: modernMeta(clientInfo, clientCapabilities(spec.handlers)) } },
          { timeoutMs: spec.discoverTimeoutMs ?? 5000 },
        );
        era = eraFromDiscover(r);
        result = r.result;
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        era = "legacy";
      }
      eraCache.set(key, era);
      if (era === "modern") c.setModern(result);
      else await c.initializeLegacy();
      return c;
    } catch (e) {
      await t.close().catch(() => {});
      throw e;
    }
  }
  if (!spec.url) throw new Error("connectMcp needs stdio or url");
  const t = new HttpTransport(spec.url, { headers: spec.headers, fetch: spec.fetch, ...(spec.oauth ? { oauth: spec.oauth } : {}) });
  const c = new Client(t, clientInfo, spec.handlers);
  t.onRequest = (m) => c.onRequest(m);
  t.onNotification = (m) => {
    if (isObj(m) && typeof m.method === "string" && !("id" in m && m.id !== undefined && m.id !== null)) c.onNotification(m as unknown as RpcNotification);
  };
  t.onSessionExpired = () => c.initializeLegacy();
  const key = `http:${spec.url}`;
  const legacy = async () => {
    t.modern = false;
    try {
      await c.initializeLegacy();
    } catch (e) {
      if (e instanceof HttpStatusError && [400, 404, 405].includes(e.status)) {
        const g = await t.probeGet();
        if (g.contentType.includes("text/event-stream") && /event:\s*endpoint/.test(g.head)) {
          throw new UnsupportedTransportError("MCP server speaks the 2024-11-05 HTTP+SSE transport, which is not supported (unsupported-transport)");
        }
      }
      throw e;
    }
    eraCache.set(key, "legacy");
  };
  if (eraCache.get(key) === "legacy") {
    await legacy();
    return c;
  }
  t.modern = true;
  const r = await t.post({ jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: modernMeta(clientInfo, clientCapabilities(spec.handlers)) } });
  const reply = r.messages.find((m) => isObj(m) && String(m.id) === "0") as RpcResponse | undefined;
  if (r.status >= 200 && r.status < 300 && reply) {
    if (eraFromDiscover(reply) === "modern") {
      eraCache.set(key, "modern");
      c.setModern(reply.result);
      return c;
    }
    await legacy();
    return c;
  }
  if (r.status === 400) {
    let code: number | undefined;
    try {
      const b = JSON.parse(r.text) as unknown;
      if (isObj(b) && isObj(b.error) && typeof b.error.code === "number") code = b.error.code;
    } catch {
      // not JSON
    }
    if (code !== undefined && code <= -32020 && code >= -32029) {
      const era = eraFromDiscover({ jsonrpc: "2.0", id: 0, error: { code, message: "", data: (JSON.parse(r.text) as { error?: { data?: unknown } }).error?.data } });
      if (era === "modern") {
        eraCache.set(key, "modern");
        c.setModern(undefined);
        return c;
      }
    }
  }
  await legacy();
  return c;
}

/** For tests: forget cached eras. */
export function resetEraCache(): void {
  eraCache.clear();
}
