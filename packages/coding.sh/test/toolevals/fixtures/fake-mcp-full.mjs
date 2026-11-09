#!/usr/bin/env node
// A stub MCP server (2025-11-25) that uses every client feature toolevals
// supports: resources (+ a template), prompts, progress notifications, a
// task-augmented tool, and server → client sampling, elicitation and roots.
// Over stdio (run this file; FAKE_MCP_LOG=<file> appends what it saw) or
// Streamable HTTP (startFullHttp), optionally behind OAuth with a stub
// authorization server on the same origin (/as/...).
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const VERSION = "2025-11-25";
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

export const TOOLS = [
  { name: "search", description: "Search the docs. Reports progress.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "summarize", description: "Summarize text (asks the client's model).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "confirm_delete", description: "Delete a page after asking the user.", inputSchema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] } },
  { name: "list_roots", description: "List the client's roots.", inputSchema: { type: "object", properties: {} } },
  { name: "build_report", description: "Build a report (long-running task).", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }, execution: { taskSupport: "required" } },
];
export const GUIDE = "Release checklist: 1. tag the commit 2. publish the package 3. post the notes";

/** One server's state; `ctx` sends server → client messages for the request being handled. */
export function createServerCore(log = () => {}) {
  const tasks = new Map();
  let seq = 0;
  async function callTool(id, params, ctx) {
    const args = params?.arguments ?? {};
    const token = params?._meta?.progressToken;
    switch (params?.name) {
      case "search":
        if (token !== undefined) {
          ctx.notify("notifications/progress", { progressToken: token, progress: 1, total: 2, message: "indexing" });
          ctx.notify("notifications/progress", { progressToken: token, progress: 2, total: 2, message: "ranking" });
        }
        return ok(id, text(`results for ${args.query}: guide`));
      case "summarize": {
        const r = await ctx.request("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: `Summarize in five words: ${args.text}` } }], maxTokens: 50, systemPrompt: "You summarize." });
        log({ sampling: r });
        return ok(id, text(`summary: ${r?.content?.text ?? "(none)"}`));
      }
      case "confirm_delete": {
        const r = await ctx.request("elicitation/create", { mode: "form", message: `Delete page ${args.page}?`, requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } });
        log({ elicitation: r });
        return ok(id, text(r?.action === "accept" && r.content?.confirm === true ? `deleted ${args.page}` : `kept ${args.page} (${r?.action})`));
      }
      case "list_roots": {
        const r = await ctx.request("roots/list", {});
        log({ roots: r });
        return ok(id, text((r?.roots ?? []).map((x) => x.uri).join("\n")));
      }
      case "build_report": {
        if (!params.task) return err(id, -32600, "build_report must run as a task");
        const taskId = `task-${++seq}`;
        const t = { taskId, status: "working", createdAt: new Date().toISOString(), ttl: params.task.ttl ?? 60000, pollInterval: 20, polls: 0, result: text(`report on ${args.topic}`) };
        tasks.set(taskId, t);
        setTimeout(() => (t.status = "completed"), 60);
        return ok(id, { task: { taskId, status: t.status, createdAt: t.createdAt, ttl: t.ttl, pollInterval: t.pollInterval } });
      }
      default:
        return err(id, -32602, `Unknown tool: ${params?.name}`);
    }
  }
  return async function handle(msg, ctx) {
    if (msg.id === undefined) return null;
    const { id, method, params } = msg;
    switch (method) {
      case "server/discover":
        return err(id, -32601, "Method not found: server/discover");
      case "initialize":
        log({ initialize: params });
        return ok(id, { protocolVersion: VERSION, capabilities: { tools: {}, resources: {}, prompts: {}, logging: {}, tasks: { requests: { tools: { call: {} } } } }, serverInfo: { name: "fake-mcp-full", version: "1.0.0" } });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call":
        return callTool(id, params, ctx);
      case "resources/list":
        return ok(id, { resources: [{ uri: "docs://guide", name: "guide", description: "The release guide", mimeType: "text/plain" }, { uri: "docs://logo", name: "logo", mimeType: "image/png" }] });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [{ uriTemplate: "docs://{page}", name: "page", description: "Any docs page" }] });
      case "resources/read":
        if (params?.uri === "docs://guide") return ok(id, { contents: [{ uri: "docs://guide", mimeType: "text/plain", text: GUIDE }] });
        if (params?.uri === "docs://logo") return ok(id, { contents: [{ uri: "docs://logo", mimeType: "image/png", blob: Buffer.from("png!").toString("base64") }] });
        return err(id, -32002, `Resource not found: ${params?.uri}`);
      case "prompts/list":
        return ok(id, { prompts: [{ name: "release", description: "Prepare release notes", arguments: [{ name: "version", required: true }] }] });
      case "prompts/get":
        if (params?.name !== "release") return err(id, -32602, `Unknown prompt: ${params?.name}`);
        return ok(id, { description: "Prepare release notes", messages: [{ role: "user", content: { type: "text", text: `You are the release manager for version ${params?.arguments?.version ?? "?"}. Follow the docs://guide checklist.` } }] });
      case "tasks/get": {
        const t = tasks.get(params?.taskId);
        if (!t) return err(id, -32602, "unknown task");
        t.polls++;
        return ok(id, { taskId: t.taskId, status: t.status, createdAt: t.createdAt, ttl: t.ttl, pollInterval: t.pollInterval });
      }
      case "tasks/result": {
        const t = tasks.get(params?.taskId);
        if (!t) return err(id, -32602, "unknown task");
        while (t.status !== "completed") await new Promise((r) => setTimeout(r, 10));
        log({ taskPolls: t.polls });
        return ok(id, t.result);
      }
      default:
        return err(id, -32601, `Method not found: ${method}`);
    }
  };
}

// ------------------------------------------------------------ stdio

function runStdio() {
  const logFile = process.env.FAKE_MCP_LOG;
  const handle = createServerCore((e) => logFile && appendFileSync(logFile, JSON.stringify(e) + "\n"));
  const pending = new Map();
  let out = 0;
  const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const ctx = {
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `s${++out}`;
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      }),
  };
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === undefined && msg.id !== undefined) {
        const p = pending.get(String(msg.id));
        pending.delete(String(msg.id));
        if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        continue;
      }
      void handle(msg, ctx).then(
        (r) => r && write(r),
        (e) => write(err(msg.id, -32603, e.message)),
      );
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// ------------------------------------------------------------ HTTP (+ OAuth)

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Streamable HTTP on /mcp; with `oauth`, a Bearer token from the stub AS under /as is required. */
export async function startFullHttp({ oauth = false } = {}) {
  const log = [];
  const handle = createServerCore((e) => log.push(e));
  const pending = new Map();
  const clients = new Map();
  const codes = new Map();
  const tokens = new Set();
  const oauthLog = [];
  let out = 0;
  let origin = "";
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    // --- stub authorization server
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ["docs:read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server/as")
      return json(res, 200, { issuer: `${origin}/as`, authorization_endpoint: `${origin}/as/authorize`, token_endpoint: `${origin}/as/token`, registration_endpoint: `${origin}/as/register`, code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "client_credentials"] });
    if (url.pathname === "/as/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const id = `client-${clients.size + 1}`;
      const secret = body.token_endpoint_auth_method === "none" ? undefined : b64url(randomBytes(12));
      clients.set(id, { redirect: body.redirect_uris?.[0], secret });
      oauthLog.push({ register: body.client_name });
      return json(res, 201, { client_id: id, ...(secret ? { client_secret: secret } : {}), redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/as/authorize") {
      const q = Object.fromEntries(url.searchParams);
      const c = clients.get(q.client_id);
      if (!c || q.redirect_uri !== c.redirect || q.code_challenge_method !== "S256" || !q.code_challenge) return json(res, 400, { error: "invalid_request" });
      const code = b64url(randomBytes(12));
      codes.set(code, { challenge: q.code_challenge, client: q.client_id, resource: q.resource, redirect: q.redirect_uri });
      oauthLog.push({ authorize: { resource: q.resource, scope: q.scope } });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` });
      return res.end();
    }
    if (url.pathname === "/as/token" && req.method === "POST") {
      const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
      if (f.grant_type === "authorization_code") {
        const c = codes.get(f.code);
        codes.delete(f.code);
        if (!c || c.client !== f.client_id || c.redirect !== f.redirect_uri) return json(res, 400, { error: "invalid_grant" });
        if (b64url(createHash("sha256").update(f.code_verifier ?? "").digest()) !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        if (f.resource !== `${origin}/mcp`) return json(res, 400, { error: "invalid_target" });
      } else if (f.grant_type === "client_credentials") {
        const c = clients.get(f.client_id);
        if (!c || !c.secret || c.secret !== f.client_secret) return json(res, 401, { error: "invalid_client" });
      } else return json(res, 400, { error: "unsupported_grant_type" });
      const token = b64url(randomBytes(16));
      tokens.add(token);
      oauthLog.push({ token: f.grant_type });
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    // --- MCP endpoint
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (oauth) {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !tokens.has(auth.slice(7))) {
        await readBody(req);
        return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="docs:read"` });
      }
    }
    if (req.method === "DELETE") return res.writeHead(200).end();
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(await readBody(req));
    if (msg.method === undefined && msg.id !== undefined) {
      const p = pending.get(String(msg.id));
      pending.delete(String(msg.id));
      if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return res.writeHead(202).end();
    }
    if (msg.id === undefined) return res.writeHead(202).end();
    // Every request is answered on an SSE stream, so server → client messages can come first.
    res.writeHead(200, { "content-type": "text/event-stream", ...(msg.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}) });
    const send = (m) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    const ctx = {
      notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
      request: (method, params) =>
        new Promise((resolve, reject) => {
          const id = `s${++out}`;
          pending.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        }),
    };
    const r = await handle(msg, ctx).catch((e) => err(msg.id, -32603, e.message));
    if (r) send(r);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    log,
    oauthLog,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runStdio();
