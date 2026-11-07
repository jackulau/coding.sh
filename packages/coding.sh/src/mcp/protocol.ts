// Hand-rolled MCP server core (no SDK): JSON-RPC 2.0 dispatch for a dual-era
// server, plus the newline-delimited stdio transport.
//
// Eras (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning):
// - Modern (2026-07-28): stateless. Every request carries
//   `_meta["io.modelcontextprotocol/protocolVersion"]` and `clientCapabilities`;
//   `server/discover` replaces the handshake; results carry `resultType`.
// - Legacy (2025-11-25, 2025-06-18, 2025-03-26): `initialize` negotiates a
//   version for the rest of the process, then `notifications/initialized`.
// A request with the modern `_meta` key is served statelessly; anything else
// gets legacy semantics. Nothing but protocol frames is written to stdout.

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const META = "io.modelcontextprotocol/";

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Legacy (≤ 2025-11-25) resource-not-found; modern servers use INVALID_PARAMS. */
  RESOURCE_NOT_FOUND: -32002,
  UNSUPPORTED_VERSION: -32022,
} as const;

export type RpcId = string | number;
type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Implementation {
  name: string;
  title?: string;
  version: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One MCP tool: the advertised definition plus its handler. */
export interface ToolDef<C = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: Obj;
  outputSchema: Obj;
  annotations: ToolAnnotations;
  run(args: Obj, ctx: C): Promise<Obj>;
}

/**
 * A failure the model should see and can fix (bad id, missing confirm…): returned as `isError: true`.
 * With `error`, the result also carries `structuredContent: {error: {message, ...error}}` (the
 * tool's outputSchema then declares that `error` property).
 */
export class ToolError extends Error {
  readonly error?: Obj;
  constructor(msg: string, error?: Obj) {
    super(msg);
    this.name = "ToolError";
    if (error) this.error = error;
  }
}

/** A JSON-RPC error raised from a handler. */
export class RpcFailure extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, msg: string, data?: unknown) {
    super(msg);
    this.name = "RpcFailure";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface ResourceDef {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceProvider {
  list(cursor: string | undefined): Promise<{ resources: ResourceDef[]; nextCursor?: string }>;
  templates(): ResourceTemplateDef[];
  /** undefined = not found. */
  read(uri: string): Promise<{ uri: string; mimeType: string; text: string } | undefined>;
}

export interface ServerOptions<C> {
  serverInfo: Implementation;
  /** Called per handshake/discover so it can carry fresh hints (e.g. an available update). */
  instructions(): Promise<string> | string;
  tools: ToolDef<C>[];
  resources?: ResourceProvider;
  /** Handler context, created per tool call. */
  context(): C;
  /** Validates tool arguments; returns human-readable violations ([] = valid). */
  validate?(args: unknown, schema: Obj): string[];
  log?(msg: string): void;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: Obj;
  error?: { code: number; message: string; data?: unknown };
}

const errorResponse = (id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/** Compact text for a structured tool result (the spec's backward-compatible TextContent). */
export function toolText(structured: unknown): string {
  return JSON.stringify(structured);
}

export class McpServer<C> {
  /** Legacy version negotiated by `initialize`, scoped to this process. */
  legacyVersion?: string;
  initialized = false;
  private readonly o: ServerOptions<C>;
  private readonly byName: Map<string, ToolDef<C>>;

  constructor(o: ServerOptions<C>) {
    this.o = o;
    this.byName = new Map(o.tools.map((t) => [t.name, t]));
  }

  private capabilities(): Obj {
    return { tools: { listChanged: false }, ...(this.o.resources ? { resources: { listChanged: false, subscribe: false } } : {}) };
  }

  /** Handles one decoded message. Returns the response, or null for notifications and stray responses. */
  async handle(msg: unknown): Promise<RpcResponse | null> {
    if (Array.isArray(msg)) return errorResponse(null, RPC.INVALID_REQUEST, "JSON-RPC batches are not supported; send one message per line");
    if (!isObj(msg)) return errorResponse(null, RPC.INVALID_REQUEST, "Invalid request: expected a JSON-RPC object");
    const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
    const idOk = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
    if (typeof msg.method !== "string") {
      // A response to a server→client request (we send none) or garbage.
      if ("result" in msg || "error" in msg) return null;
      return errorResponse(idOk ? (msg.id as RpcId) : null, RPC.INVALID_REQUEST, "Invalid request: missing method");
    }
    if (!hasId) {
      this.notification(msg.method);
      return null;
    }
    if (!idOk) return errorResponse(null, RPC.INVALID_REQUEST, "Invalid request: id must be a string or number");
    const id = msg.id as RpcId;
    if (msg.jsonrpc !== "2.0") return errorResponse(id, RPC.INVALID_REQUEST, 'Invalid request: jsonrpc must be "2.0"');
    if (msg.params !== undefined && !isObj(msg.params)) return errorResponse(id, RPC.INVALID_PARAMS, "params must be an object");
    const params = (msg.params ?? {}) as Obj;
    const meta = isObj(params._meta) ? params._meta : {};
    const requested = meta[`${META}protocolVersion`];
    const modern = requested !== undefined;
    try {
      if (modern) {
        if (requested !== MODERN_VERSION) {
          return errorResponse(id, RPC.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MODERN_VERSION], requested });
        }
        if (!isObj(meta[`${META}clientCapabilities`])) {
          return errorResponse(id, RPC.INVALID_PARAMS, `Missing required _meta["${META}clientCapabilities"]`);
        }
        if (msg.method === "initialize") {
          return errorResponse(id, RPC.INVALID_REQUEST, `initialize is not used in protocol ${MODERN_VERSION}; call server/discover or send requests directly`);
        }
      }
      const result = await this.dispatch(msg.method, params, modern);
      return { jsonrpc: "2.0", id, result: modern ? this.modernResult(result) : result };
    } catch (e) {
      if (e instanceof RpcFailure) return errorResponse(id, e.code, e.message, e.data);
      this.o.log?.(`internal error in ${msg.method}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return errorResponse(id, RPC.INTERNAL_ERROR, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private notification(method: string): void {
    if (method === "notifications/initialized") this.initialized = true;
    // notifications/cancelled, roots/list_changed…: requests finish quickly; nothing to do.
  }

  private modernResult(r: Obj): Obj {
    const meta = isObj(r._meta) ? r._meta : {};
    return { resultType: "complete", ...r, _meta: { ...meta, [`${META}serverInfo`]: this.o.serverInfo } };
  }

  private async dispatch(method: string, params: Obj, modern: boolean): Promise<Obj> {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const v = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0];
        this.legacyVersion = v;
        return { protocolVersion: v, capabilities: this.capabilities(), serverInfo: this.o.serverInfo, instructions: await this.o.instructions() };
      }
      case "server/discover":
        // serverInfo also sits at the top level (besides _meta) for clients built on spec drafts.
        return { supportedVersions: [MODERN_VERSION], capabilities: this.capabilities(), serverInfo: this.o.serverInfo, instructions: await this.o.instructions() };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.o.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
          })),
        };
      case "tools/call":
        return this.callTool(params);
      case "resources/list": {
        const r = this.o.resources;
        if (!r) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/list");
        const page = await r.list(typeof params.cursor === "string" ? params.cursor : undefined);
        return { resources: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }
      case "resources/templates/list": {
        const r = this.o.resources;
        if (!r) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/templates/list");
        return { resourceTemplates: r.templates() };
      }
      case "resources/read": {
        const r = this.o.resources;
        if (!r) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/read");
        if (typeof params.uri !== "string" || !params.uri) throw new RpcFailure(RPC.INVALID_PARAMS, "resources/read needs a uri");
        const c = await r.read(params.uri);
        if (!c) throw new RpcFailure(modern ? RPC.INVALID_PARAMS : RPC.RESOURCE_NOT_FOUND, `Resource not found: ${params.uri}`, { uri: params.uri });
        return { contents: [c] };
      }
      case "prompts/list":
        return { prompts: [] };
      case "logging/setLevel":
        return {};
      default:
        throw new RpcFailure(RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private async callTool(params: Obj): Promise<Obj> {
    const name = params.name;
    if (typeof name !== "string") throw new RpcFailure(RPC.INVALID_PARAMS, "tools/call needs a tool name");
    const tool = this.byName.get(name);
    if (!tool) throw new RpcFailure(RPC.INVALID_PARAMS, `Unknown tool: ${name}. Call tools/list for the available tools`);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObj(args)) return errorResult("Invalid arguments: arguments must be an object");
    const problems = this.o.validate?.(args, tool.inputSchema) ?? [];
    if (problems.length) return errorResult(`Invalid arguments for ${name}: ${problems.join("; ")}. Fix the arguments and call again.`);
    try {
      const structured = await tool.run(args, this.o.context());
      return { content: [{ type: "text", text: toolText(structured) }], structuredContent: structured };
    } catch (e) {
      if (e instanceof ToolError) return e.error ? { ...errorResult(e.message), structuredContent: { error: { message: e.message, ...e.error } } } : errorResult(e.message);
      this.o.log?.(`tool ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function errorResult(text: string): Obj {
  return { content: [{ type: "text", text }], isError: true };
}

// ------------------------------------------------------------ stdio

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Serves newline-delimited JSON-RPC on the streams until input ends. Requests
 * run one at a time in arrival order (handlers share one store connection).
 */
export function serveStdio<C>(server: McpServer<C>, io: StdioStreams, log: (m: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let chain = Promise.resolve();
    let ended = false;
    const write = (m: RpcResponse) => {
      try {
        io.output.write(JSON.stringify(m) + "\n");
      } catch (e) {
        log(`write failed: ${(e as Error).message}`);
      }
    };
    const onLine = (line: string) => {
      chain = chain.then(async () => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          write(errorResponse(null, RPC.PARSE_ERROR, "Parse error: each line must be one JSON-RPC message"));
          return;
        }
        const r = await server.handle(msg);
        if (r) write(r);
      });
    };
    io.output.on?.("error", (e: Error) => log(`stdout: ${e.message}`));
    io.input.setEncoding?.("utf8");
    const onData = (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    };
    const detach = () => {
      io.input.off?.("data", onData);
      io.input.off?.("end", finish);
      io.input.off?.("close", finish);
      signal?.removeEventListener("abort", interrupt);
    };
    const finish = () => {
      if (ended) return;
      ended = true;
      detach();
      if (buf.trim()) onLine(buf);
      buf = "";
      void chain.then(() => resolve());
    };
    // Interrupted (Ctrl-C): stop reading and return now; a request still in
    // flight is abandoned, and its rejection is swallowed.
    const interrupt = () => {
      if (ended) return;
      ended = true;
      detach();
      io.input.pause?.();
      chain.catch(() => {});
      resolve();
    };
    io.input.on("data", onData);
    io.input.on("end", finish);
    io.input.on("close", finish);
    if (signal?.aborted) interrupt();
    else signal?.addEventListener("abort", interrupt, { once: true });
  });
}
