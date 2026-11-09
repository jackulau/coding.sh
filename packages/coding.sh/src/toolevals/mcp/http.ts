// MCP Streamable HTTP transport (§10). Every message is a POST; the reply is
// JSON or an SSE stream whose event with the matching id is the response
// (earlier events are notifications, or server → client requests, which are
// answered with a POST while the stream stays open). Legacy mode keeps
// Mcp-Session-Id and MCP-Protocol-Version; modern mode adds Mcp-Method /
// Mcp-Name and has no sessions. A 401 runs OAuth once when an OAuthSession is
// set (mcp/oauth.ts), then the request is sent again with the token.
import { parseSse, SseParser } from "../model/sse.ts";
import { isNotification, isObj, isRequest, isResponse, type RpcNotification, type RpcRequest, type RpcResponse } from "./jsonrpc.ts";
import type { OAuthSession } from "./oauth.ts";
import { TimeoutError, type Transport } from "./stdio.ts";

export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  constructor(status: number, text: string) {
    super(`MCP HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.text = text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    this.body = body;
  }
  /** JSON-RPC error code in the body, when there is one. */
  get rpcCode(): number | undefined {
    const b = this.body;
    if (isObj(b) && isObj(b.error) && typeof b.error.code === "number") return b.error.code;
    return undefined;
  }
}

export interface HttpPostResult {
  status: number;
  headers: Headers;
  messages: unknown[];
  text: string;
}

/** Parses an MCP HTTP reply body (JSON, a JSON batch, or SSE) into messages. */
export function parseMcpBody(contentType: string, text: string): unknown[] {
  if (!text.trim()) return [];
  if (contentType.includes("text/event-stream")) {
    const out: unknown[] = [];
    for (const e of parseSse(text)) {
      if (e.event && e.event !== "message") continue;
      try {
        out.push(JSON.parse(e.data));
      } catch {
        // skip non-JSON events
      }
    }
    return out;
  }
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

export class HttpTransport implements Transport {
  readonly kind = "http" as const;
  sessionId?: string;
  protocolVersion?: string;
  modern = false;
  /** Called on a 404 with a session id (legacy): re-initialize once, then the request is retried. */
  onSessionExpired?: () => Promise<void>;
  onNotification?: (m: unknown) => void;
  /** Server → client requests that arrive on a reply stream; the answer is POSTed back. */
  onRequest?: (m: RpcRequest) => Promise<RpcResponse>;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly oauth?: OAuthSession;

  constructor(url: string, opts: { headers?: Record<string, string>; fetch?: typeof fetch; oauth?: OAuthSession } = {}) {
    this.url = url;
    this.headers = opts.headers ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.oauth) this.oauth = opts.oauth;
  }

  private buildHeaders(msg: RpcRequest | RpcNotification | RpcResponse): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...this.headers };
    const bearer = this.oauth?.authorization(this.url);
    if (bearer) h.Authorization = bearer;
    if (!("method" in msg) || typeof msg.method !== "string") {
      if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
      if (this.protocolVersion) h["MCP-Protocol-Version"] = this.protocolVersion;
      return h;
    }
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion && msg.method !== "initialize") h["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.modern) {
      h["Mcp-Method"] = msg.method;
      if (msg.method === "tools/call" && typeof msg.params?.name === "string") h["Mcp-Name"] = msg.params.name;
    }
    return h;
  }

  async post(msg: RpcRequest | RpcNotification | RpcResponse, o: { timeoutMs?: number } = {}, authRetried = false): Promise<HttpPostResult> {
    const ctrl = new AbortController();
    const timer = o.timeoutMs ? setTimeout(() => ctrl.abort(), o.timeoutMs) : undefined;
    try {
      const res = await this.fetchImpl(this.url, { method: "POST", headers: this.buildHeaders(msg), body: JSON.stringify(msg), signal: ctrl.signal });
      if (res.status === 401 && this.oauth && !authRetried) {
        await res.body?.cancel().catch(() => {});
        await this.oauth.authorize(this.url, res.headers.get("www-authenticate") ?? "");
        if (timer) clearTimeout(timer);
        return await this.post(msg, o, true);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream") && res.body) {
        // Read the stream as it comes: a server → client request on it waits for our answer.
        const parser = new SseParser();
        const dec = new TextDecoder();
        const messages: unknown[] = [];
        let text = "";
        const take = (events: { event?: string; data: string }[]) => {
          for (const e of events) {
            if (e.event && e.event !== "message") continue;
            let m: unknown;
            try {
              m = JSON.parse(e.data);
            } catch {
              continue;
            }
            if (isNotification(m)) {
              this.onNotification?.(m);
              continue;
            }
            if (isRequest(m) && this.onRequest) {
              void this.onRequest(m).then((reply) => this.post(reply).catch(() => undefined));
              continue;
            }
            messages.push(m);
          }
        };
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const s = dec.decode(chunk, { stream: true });
          text += s;
          take(parser.push(s));
        }
        take(parser.end());
        return { status: res.status, headers: res.headers, messages, text };
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, messages: parseMcpBody(ct, text), text };
    } catch (e) {
      if (ctrl.signal.aborted) throw new TimeoutError("method" in msg ? msg.method : "reply", o.timeoutMs ?? 0);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async request(msg: RpcRequest, o: { timeoutMs?: number } = {}, retried = false): Promise<RpcResponse> {
    const r = await this.post(msg, o);
    if (r.status === 404 && this.sessionId && !this.modern && this.onSessionExpired && !retried) {
      this.sessionId = undefined;
      await this.onSessionExpired();
      return this.request(msg, o, true);
    }
    const sid = r.headers.get("mcp-session-id");
    if (sid && msg.method === "initialize") this.sessionId = sid;
    const found = r.messages.find((m) => isResponse(m) && String(m.id) === String(msg.id));
    for (const m of r.messages) if (m !== found) this.onNotification?.(m);
    if (found) return found as RpcResponse;
    if (r.status >= 400) throw new HttpStatusError(r.status, r.text);
    throw new HttpStatusError(r.status, r.text || "no JSON-RPC response in reply");
  }

  async notify(msg: RpcNotification): Promise<void> {
    await this.post(msg); // 202 expected; any body is ignored
  }

  /** Raw GET (legacy HTTP+SSE detection). Returns the first chunk of the body. */
  async probeGet(timeoutMs = 2000): Promise<{ status: number; contentType: string; head: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { method: "GET", headers: { Accept: "text/event-stream", ...this.headers }, signal: ctrl.signal });
      let head = "";
      if (res.body) {
        const reader = res.body.getReader();
        const { value } = await reader.read();
        head = value ? new TextDecoder().decode(value) : "";
        await reader.cancel().catch(() => {});
      }
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", head };
    } catch {
      return { status: 0, contentType: "", head: "" };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.modern && this.sessionId) {
      const sid = this.sessionId;
      this.sessionId = undefined;
      try {
        await this.fetchImpl(this.url, { method: "DELETE", headers: { "Mcp-Session-Id": sid, ...this.headers } }).then((r) => r.body?.cancel());
      } catch {
        // 405 or network: ignored
      }
    }
  }
}
