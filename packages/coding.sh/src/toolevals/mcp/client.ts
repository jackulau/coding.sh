// Minimal dual-era MCP client (§10): the 2026-07-28 stateless protocol plus
// legacy 2025-11-25 / 2025-06-18 / 2025-03-26, over stdio or Streamable HTTP.
// Only tools: no resources, prompts, sampling, elicitation, roots or OAuth.
import type { CallToolResult, McpTool } from "../types.ts";
import { HttpStatusError, HttpTransport } from "./http.ts";
import { isObj, LEGACY_VERSIONS, MODERN_VERSION, RPC, RpcError, type RpcResponse } from "./jsonrpc.ts";
import { StdioTransport, TimeoutError, type Transport } from "./stdio.ts";

export type { McpTool, CallToolResult };

export interface McpClient {
  era: "2026-07-28" | "legacy";
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: object, o?: { timeoutMs?: number }): Promise<CallToolResult>;
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

function modernMeta(clientInfo: { name: string; version: string }): Record<string, unknown> {
  return { [`${META}protocolVersion`]: MODERN_VERSION, [`${META}clientCapabilities`]: {}, [`${META}clientInfo`]: clientInfo };
}

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
  private nextId = 1;
  readonly t: Transport;
  private readonly clientInfo: { name: string; version: string };

  constructor(t: Transport, clientInfo: { name: string; version: string }) {
    this.t = t;
    this.clientInfo = clientInfo;
  }

  get stderr(): string | undefined {
    return this.t instanceof StdioTransport ? this.t.stderrHead : undefined;
  }

  async rpc(method: string, params: Record<string, unknown> = {}, o: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    const p = this.era === MODERN_VERSION ? { ...params, _meta: { ...(isObj(params._meta) ? params._meta : {}), ...modernMeta(this.clientInfo) } } : params;
    return this.t.request({ jsonrpc: "2.0", id: this.nextId++, method, params: p }, o);
  }

  async initializeLegacy(): Promise<void> {
    this.era = "legacy";
    const r = unwrap(await this.rpc("initialize", { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: this.clientInfo }));
    const res = isObj(r) ? r : {};
    const v = typeof res.protocolVersion === "string" ? res.protocolVersion : "";
    if (!(LEGACY_VERSIONS as readonly string[]).includes(v)) {
      await this.t.close();
      throw new Error(`MCP server negotiated unsupported protocol version ${JSON.stringify(v)}`);
    }
    this.protocolVersion = v;
    if (isObj(res.serverInfo)) this.serverInfo = { name: String(res.serverInfo.name ?? ""), version: String(res.serverInfo.version ?? "") };
    if (typeof res.instructions === "string") this.instructions = res.instructions;
    if (this.t instanceof HttpTransport) this.t.protocolVersion = v;
    await this.t.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  setModern(result: unknown): void {
    this.era = MODERN_VERSION;
    this.protocolVersion = MODERN_VERSION;
    const res = isObj(result) ? result : {};
    if (isObj(res.serverInfo)) this.serverInfo = { name: String(res.serverInfo.name ?? ""), version: String(res.serverInfo.version ?? "") };
    if (typeof res.instructions === "string") this.instructions = res.instructions;
    if (this.t instanceof HttpTransport) {
      this.t.modern = true;
      this.t.protocolVersion = MODERN_VERSION;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = unwrap(await this.rpc("tools/list", cursor ? { cursor } : {}));
      const res = isObj(r) ? r : {};
      for (const t of Array.isArray(res.tools) ? res.tools : []) if (isObj(t) && typeof t.name === "string") tools.push(t as unknown as McpTool);
      cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: object, o: { timeoutMs?: number } = {}): Promise<CallToolResult> {
    const r = unwrap(await this.rpc("tools/call", { name, arguments: args }, o));
    const res = isObj(r) ? r : {};
    const out: CallToolResult = { content: Array.isArray(res.content) ? (res.content as CallToolResult["content"]) : [] };
    if (res.structuredContent !== undefined) out.structuredContent = res.structuredContent;
    if (res.isError === true) out.isError = true;
    return out;
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
    const t = new StdioTransport(spec.stdio, { env: spec.env ? { ...process.env, ...spec.env } : undefined, cwd: spec.cwd, graceMs: spec.graceMs });
    const c = new Client(t, clientInfo);
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
          { jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: modernMeta(clientInfo) } },
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
  const t = new HttpTransport(spec.url, { headers: spec.headers, fetch: spec.fetch });
  const c = new Client(t, clientInfo);
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
  const r = await t.post({ jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: modernMeta(clientInfo) } });
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
