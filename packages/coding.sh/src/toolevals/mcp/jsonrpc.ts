// JSON-RPC 2.0 message shapes and the MCP error codes the client handles (§10).

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: unknown;
  error?: RpcErrorBody;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CAPABILITY: -32021,
  UNSUPPORTED_VERSION: -32022,
} as const;

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** A JSON-RPC error response surfaced as an exception. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(body: RpcErrorBody) {
    super(body.message || `JSON-RPC error ${body.code}`);
    this.name = "RpcError";
    this.code = body.code;
    if (body.data !== undefined) this.data = body.data;
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isRequest(m: unknown): m is RpcRequest {
  return isObj(m) && typeof m.method === "string" && "id" in m && m.id !== undefined && m.id !== null;
}

export function isNotification(m: unknown): m is RpcNotification {
  return isObj(m) && typeof m.method === "string" && !("id" in m && m.id !== undefined && m.id !== null);
}

export function isResponse(m: unknown): m is RpcResponse {
  return isObj(m) && typeof m.method !== "string" && ("result" in m || "error" in m);
}

export function errorResponse(id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Byte length of a message as sent on the wire (compact JSON, UTF-8). */
export function wireBytes(m: unknown): number {
  return Buffer.byteLength(JSON.stringify(m), "utf8");
}

/** Splits a byte stream into newline-delimited JSON messages (stdio transport). */
export class LineSplitter {
  private buf = "";
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  }
}
