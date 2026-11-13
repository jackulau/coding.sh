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

/** One skill as skills/list and skills/get return it (SEP-2640): the SKILL.md URI, its frontmatter and every file. */
export interface SkillEntry {
  uri: string;
  /** The SKILL.md's YAML frontmatter as JSON, every field. */
  frontmatter: Obj;
  resources: { uri: string; digest: string; size: number }[];
}

/** Agent Skills served as resources (the io.modelcontextprotocol/skills extension). */
export interface SkillProvider {
  list(): Promise<SkillEntry[]>;
  /** undefined = no skill has this SKILL.md URI. */
  get(uri: string): Promise<SkillEntry | undefined>;
  /** Each skill's SKILL.md, for the first page of resources/list. */
  resources(): Promise<ResourceDef[]>;
  /** One skill file. undefined = not a skill file. */
  read(uri: string): Promise<{ uri: string; mimeType: string; text: string } | undefined>;
  /** The direct children of a skill directory. undefined = not a directory. */
  directory(uri: string): Promise<ResourceDef[] | undefined>;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** One MCP prompt: a user message template the client offers (Claude Code: a slash command). */
export interface PromptDef {
  name: string;
  title?: string;
  description: string;
  arguments?: PromptArgument[];
  /** The user message for these arguments (required ones are present). */
  render(args: Record<string, string>): string;
}

export interface ServerOptions<C> {
  serverInfo: Implementation;
  /** Called per handshake/discover so it can carry fresh hints (e.g. an available update). */
  instructions(): Promise<string> | string;
  tools: ToolDef<C>[];
  resources?: ResourceProvider;
  /** Needs `resources`: skill files are read through resources/read. */
  skills?: SkillProvider;
  prompts?: PromptDef[];
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
  error: data === undefined ? { code, message: clipText(message) } : { code, message: clipText(message), data },
});

/** Longest error text sent back: an error that quotes a huge argument keeps its start and its advice. */
export const ERROR_TEXT_MAX = 4000;

/** `s` within `max` characters: its start and end, with how much was cut between them. */
export function clipText(s: string, max = ERROR_TEXT_MAX): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 40) / 2);
  const head = cutChars(s, keep);
  const tail = s.slice(-keep).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head} … [${s.length - head.length - tail.length} characters cut] … ${tail}`;
}

/** The first `max` characters of `s`, without half of a surrogate pair at the cut. */
export function cutChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * Caching hints on 2026-07-28 results (https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching):
 * the tool, prompt and template lists are fixed for the life of the process and hold no user data;
 * resources are the user's sessions and change with every capture. server/discover carries the
 * instructions, which hold a per-call update notice, so it is cached for less time.
 */
const CACHE_HINTS: Record<string, { ttlMs: number; cacheScope: "public" | "private" }> = {
  "server/discover": { ttlMs: 300_000, cacheScope: "public" },
  "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/templates/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/list": { ttlMs: 0, cacheScope: "private" },
  "resources/read": { ttlMs: 0, cacheScope: "private" },
  // The skill list is cached like the tool list. An entry, a file and a folder listing are read
  // fresh: a host refreshes a stale entry with skills/get, and after an upgrade it must check the
  // new digests against the new bytes.
  "skills/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "skills/get": { ttlMs: 0, cacheScope: "public" },
  "resources/directory/read": { ttlMs: 0, cacheScope: "public" },
};

/** The Agent Skills extension (SEP-2640): skills/list, skills/get and, with directoryRead, resources/directory/read. */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** A skill file holds no user data, unlike a session digest. It is read fresh, as its entry is. */
const SKILL_FILE_CACHE = { ttlMs: 0, cacheScope: "public" } as const;

/** These lists come back in one page, so any cursor is one this server never issued. */
function noCursor(method: string, params: Obj): void {
  if (params.cursor === undefined || params.cursor === null || params.cursor === "") return;
  throw new RpcFailure(RPC.INVALID_PARAMS, `Invalid cursor: ${method} returns everything in one page; call it without a cursor.`);
}

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

  /** Skills are served only next to resources: the extension requires the resources capability. */
  private get skills(): SkillProvider | undefined {
    return this.o.resources ? this.o.skills : undefined;
  }

  private capabilities(): Obj {
    const caps: Obj = {
      tools: { listChanged: false },
      ...(this.o.resources ? { resources: { listChanged: false, subscribe: false } } : {}),
      ...(this.o.prompts?.length ? { prompts: { listChanged: false } } : {}),
    };
    if (this.skills) caps.extensions = { [SKILLS_EXTENSION]: { directoryRead: true } };
    return caps;
  }

  /**
   * Handles one decoded message. Returns the response, or null for notifications and stray responses.
   * A batch (an array) is served only in a 2025-03-26 session, the one version whose spec has them;
   * its reply is the array of its responses, or null when it held only notifications.
   */
  handle(msg: Obj): Promise<RpcResponse | null>;
  handle(msg: unknown): Promise<RpcResponse | RpcResponse[] | null>;
  async handle(msg: unknown): Promise<RpcResponse | RpcResponse[] | null> {
    if (Array.isArray(msg)) {
      if (this.legacyVersion !== "2025-03-26") return errorResponse(null, RPC.INVALID_REQUEST, "JSON-RPC batches are not supported; send one message per line");
      if (!msg.length) return errorResponse(null, RPC.INVALID_REQUEST, "Invalid request: empty batch");
      const replies: RpcResponse[] = [];
      for (const m of msg) {
        const r = Array.isArray(m) ? errorResponse(null, RPC.INVALID_REQUEST, "Invalid request: a batch holds JSON-RPC objects") : await this.handleOne(m);
        if (r) replies.push(r);
      }
      return replies.length ? replies : null;
    }
    return this.handleOne(msg);
  }

  private async handleOne(msg: unknown): Promise<RpcResponse | null> {
    if (!isObj(msg)) return errorResponse(null, RPC.INVALID_REQUEST, "Invalid request: expected a JSON-RPC object");
    // A null id is still a request (JSON-RPC 2.0) and gets an answer; MCP ids are strings or numbers.
    const hasId = "id" in msg && msg.id !== undefined;
    const idOk = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
    if (typeof msg.method !== "string") {
      // A response to a server→client request (we send none) or garbage.
      if ("result" in msg || "error" in msg) return null;
      return errorResponse(idOk ? (msg.id as RpcId) : null, RPC.INVALID_REQUEST, "Invalid request: missing method");
    }
    // A null id on a notifications/ method is still a notification: no reply.
    if (!hasId || (msg.id === null && msg.method.startsWith("notifications/"))) {
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
      return { jsonrpc: "2.0", id, result: modern ? this.modernResult(msg.method, result) : result };
    } catch (e) {
      if (e instanceof RpcFailure) return errorResponse(id, e.code, e.message, e.data);
      this.o.log?.(`internal error in ${msg.method}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return errorResponse(id, RPC.INTERNAL_ERROR, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private notification(method: string): void {
    if (method === "notifications/initialized") this.initialized = true;
    // notifications/cancelled is handled by the transport (serveStdio); roots/list_changed…: nothing to do.
  }

  private modernResult(method: string, r: Obj): Obj {
    const meta = isObj(r._meta) ? r._meta : {};
    return { resultType: "complete", ...CACHE_HINTS[method], ...r, _meta: { ...meta, [`${META}serverInfo`]: this.o.serverInfo } };
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
        noCursor(method, params);
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
        // An empty cursor is the first page, as it is for the provider.
        const cursor = typeof params.cursor === "string" && params.cursor ? params.cursor : undefined;
        const page = await r.list(cursor);
        // Each skill's SKILL.md closes the first page, after the sessions a client listed before
        // there were skills; a skill's other files are in its skills/list entry.
        const skillMds = cursor === undefined ? ((await this.skills?.resources()) ?? []) : [];
        return { resources: [...page.resources, ...skillMds], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }
      case "resources/templates/list": {
        const r = this.o.resources;
        if (!r) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/templates/list");
        noCursor(method, params);
        return { resourceTemplates: r.templates() };
      }
      case "resources/read": {
        const r = this.o.resources;
        if (!r) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/read");
        if (typeof params.uri !== "string" || !params.uri) throw new RpcFailure(RPC.INVALID_PARAMS, "resources/read needs a uri");
        const file = await this.skills?.read(params.uri);
        if (file) return modern ? { contents: [file], ...SKILL_FILE_CACHE } : { contents: [file] };
        const c = await r.read(params.uri);
        if (!c) throw new RpcFailure(modern ? RPC.INVALID_PARAMS : RPC.RESOURCE_NOT_FOUND, `Resource not found: ${params.uri}`, { uri: clipText(params.uri, 1000) });
        return { contents: [c] };
      }
      case "skills/list": {
        const s = this.skills;
        if (!s) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: skills/list");
        noCursor(method, params);
        return { skills: await s.list() };
      }
      case "skills/get": {
        const s = this.skills;
        if (!s) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: skills/get");
        if (typeof params.uri !== "string" || !params.uri) throw new RpcFailure(RPC.INVALID_PARAMS, "skills/get needs the uri of a skill's SKILL.md");
        const skill = await s.get(params.uri);
        if (!skill) throw new RpcFailure(RPC.INVALID_PARAMS, `No skill at ${params.uri}. Call skills/list for the skills this server serves.`, { uri: clipText(params.uri, 1000) });
        return { skill };
      }
      case "resources/directory/read": {
        const s = this.skills;
        if (!s) throw new RpcFailure(RPC.METHOD_NOT_FOUND, "Method not found: resources/directory/read");
        if (typeof params.uri !== "string" || !params.uri) throw new RpcFailure(RPC.INVALID_PARAMS, "resources/directory/read needs a directory uri");
        noCursor(method, params);
        const resources = await s.directory(params.uri);
        if (!resources) throw new RpcFailure(RPC.INVALID_PARAMS, `Not a directory: ${params.uri}. A skill's directory is its SKILL.md URI without /SKILL.md.`, { uri: clipText(params.uri, 1000) });
        return { resources };
      }
      case "prompts/list":
        noCursor(method, params);
        return { prompts: (this.o.prompts ?? []).map((p) => ({ name: p.name, ...(p.title ? { title: p.title } : {}), description: p.description, ...(p.arguments ? { arguments: p.arguments } : {}) })) };
      case "prompts/get":
        return this.getPrompt(params);
      case "logging/setLevel":
        return {};
      default:
        throw new RpcFailure(RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private getPrompt(params: Obj): Obj {
    const name = params.name;
    if (typeof name !== "string") throw new RpcFailure(RPC.INVALID_PARAMS, "prompts/get needs a prompt name");
    const p = (this.o.prompts ?? []).find((x) => x.name === name);
    if (!p) throw new RpcFailure(RPC.INVALID_PARAMS, `Unknown prompt: ${name}. Call prompts/list for the available prompts`);
    const raw = isObj(params.arguments) ? params.arguments : {};
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) args[k] = v.trim();
    const missing = (p.arguments ?? []).filter((a) => a.required && !args[a.name]).map((a) => a.name);
    if (missing.length) throw new RpcFailure(RPC.INVALID_PARAMS, `Prompt ${name} needs ${missing.join(", ")}`);
    return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.render(args) } }] };
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
      if (e instanceof ToolError) return e.error ? { ...errorResult(e.message), structuredContent: { error: { message: clipText(e.message), ...e.error } } } : errorResult(e.message);
      this.o.log?.(`tool ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function errorResult(text: string): Obj {
  return { content: [{ type: "text", text: clipText(text) }], isError: true };
}

// ------------------------------------------------------------ stdio

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Serves newline-delimited JSON-RPC on the streams until input ends. Requests
 * run one at a time in arrival order (handlers share one store connection).
 * `notifications/cancelled` takes effect on arrival: a waiting request is
 * skipped and a running one's reply is dropped, since the stdio transport says
 * a cancelled request gets no further messages
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).
 */
export function serveStdio<C>(server: McpServer<C>, io: StdioStreams, log: (m: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let chain = Promise.resolve();
    let ended = false;
    const write = (m: RpcResponse | RpcResponse[]) => {
      try {
        io.output.write(JSON.stringify(m) + "\n");
      } catch (e) {
        log(`write failed: ${(e as Error).message}`);
      }
    };
    // Requests waiting or running, by id. A cancel marks the entry; a marked request is never answered.
    const pending = new Map<string, { cancelled: boolean; method: string }>();
    // A synchronous store read holds the event loop, so a cancel sent meanwhile is still unread in the
    // pipe. Two turns of the loop include one poll for input, which reads it before we start or answer.
    const readInput = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
    const onLine = (line: string) => {
      let msg: unknown;
      let parsed = true;
      try {
        msg = JSON.parse(line);
      } catch {
        parsed = false;
      }
      if (parsed && isObj(msg) && msg.method === "notifications/cancelled" && msg.id === undefined) {
        const id = isObj(msg.params) ? msg.params.requestId : undefined;
        const entry = typeof id === "string" || typeof id === "number" ? pending.get(JSON.stringify(id)) : undefined;
        // initialize can not be cancelled (lifecycle spec).
        if (entry && entry.method !== "initialize") entry.cancelled = true;
        return;
      }
      const key = parsed && isObj(msg) && typeof msg.method === "string" && (typeof msg.id === "string" || typeof msg.id === "number") ? JSON.stringify(msg.id) : undefined;
      const entry = { cancelled: false, method: isObj(msg) && typeof msg.method === "string" ? msg.method : "" };
      if (key) pending.set(key, entry);
      chain = chain
        .then(async () => {
          if (!parsed) return write(errorResponse(null, RPC.PARSE_ERROR, "Parse error: each line must be one JSON-RPC message"));
          if (key) await readInput();
          if (entry.cancelled) return;
          const r = await server.handle(msg);
          if (key && r) await readInput();
          if (r && !entry.cancelled) write(r);
        })
        .catch((e: unknown) => log(`request failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          if (key && pending.get(key) === entry) pending.delete(key);
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
