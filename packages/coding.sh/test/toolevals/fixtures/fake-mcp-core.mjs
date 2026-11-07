// Shared behavior of the fake MCP servers (legacy and modern eras), over stdio
// or Streamable HTTP. Tools: echo, add, fail (isError), search_docs. tools/list
// comes in 3 pages. An unknown tool is a -32602 protocol error.
import { createServer } from "node:http";

export const MODERN = "2026-07-28";
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META = "io.modelcontextprotocol/";

export const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back. Use this tool to repeat a message verbatim. Example: echo({text: 'hi'}) returns hi.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The text" } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: { type: "object", properties: { a: { type: "number", description: "First addend" }, b: { type: "number", description: "Second addend" } }, required: ["a", "b"] },
  },
  { name: "fail", description: "Always fails with a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "search_docs", description: "Search the documentation.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const PAGES = [TOOLS.slice(0, 2), TOOLS.slice(2, 3), TOOLS.slice(3)];

const err = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  switch (name) {
    case "echo":
      return ok(id, text(String(args.text ?? "")));
    case "add":
      if (typeof args.a !== "number" || typeof args.b !== "number") return ok(id, { ...text("Input validation error: a and b must be numbers"), isError: true });
      return ok(id, { ...text(String(args.a + args.b)), structuredContent: { sum: args.a + args.b } });
    case "fail":
      return ok(id, { ...text("boom: the tool failed"), isError: true });
    case "search_docs":
      return ok(id, text(`docs for ${args.query}`));
    default:
      return err(id, -32602, `Unknown tool: ${name}`);
  }
}

/** Handles one message; returns the response, or null for notifications. */
export function handler(era) {
  let initialized = false;
  return (msg) => {
    if (msg.id === undefined) {
      if (msg.method === "notifications/initialized") initialized = true;
      return null;
    }
    const { id, method, params } = msg;
    if (era === "legacy") {
      if (method === "server/discover") return err(id, -32601, "Method not found: server/discover");
      if (method === "initialize") {
        const v = LEGACY.includes(params?.protocolVersion) ? params.protocolVersion : LEGACY[0];
        return ok(id, { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: "fake-legacy", version: "1.0.0" }, instructions: "legacy fake" });
      }
      if (method === "ping") return ok(id, {});
      if (!initialized && method !== "ping") return err(id, -32600, "Server not initialized");
    } else {
      if (method === "server/discover") return ok(id, { resultType: "complete", supportedVersions: [MODERN], capabilities: { tools: {} }, serverInfo: { name: "fake-modern", version: "2.0.0" }, instructions: "modern fake" });
      const v = params?._meta?.[`${META}protocolVersion`];
      if (v !== MODERN) return err(id, -32022, "Unsupported protocol version", { supported: [MODERN] });
      if (method === "initialize") return err(id, -32601, "Method not found: initialize");
    }
    if (method === "tools/list") {
      const page = params?.cursor === "p2" ? 1 : params?.cursor === "p3" ? 2 : 0;
      return ok(id, { tools: PAGES[page], ...(page < 2 ? { nextCursor: `p${page + 2}` } : {}) });
    }
    if (method === "tools/call") return callTool(id, params);
    if (method === "ping") return ok(id, {});
    return err(id, -32601, `Method not found: ${method}`);
  };
}

export function runStdio(era, { stubborn = false } = {}) {
  const handle = handler(era);
  let buf = "";
  process.stderr.write(`fake-${era} up\n`);
  if (stubborn) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify(err(null, -32700, "Parse error")) + "\n");
        continue;
      }
      const r = handle(msg);
      if (r) process.stdout.write(JSON.stringify(r) + "\n");
    }
  });
  process.stdin.on("end", () => {
    if (!stubborn) process.exit(0);
  });
}

export function runHttp(era, port) {
  const sessions = new Map();
  const modernHandle = handler("modern");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const json = (status, doc, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(doc));
    };
    if (era === "legacy") {
      const sid = req.headers["mcp-session-id"];
      if (req.method === "DELETE") {
        sessions.delete(sid);
        res.writeHead(200).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return json(400, err(null, -32700, "Parse error"));
      }
      if (msg.method === "initialize") {
        const id = `s${Math.random().toString(36).slice(2)}`;
        const h = handler("legacy");
        sessions.set(id, h);
        return json(200, h(msg), { "mcp-session-id": id });
      }
      if (!sid || !sessions.has(sid)) return json(sid ? 404 : 400, err(msg.id ?? null, -32000, "Bad Request: No valid session ID provided"));
      if (msg.method !== undefined && msg.method !== "notifications/initialized" && !LEGACY.includes(req.headers["mcp-protocol-version"])) return json(400, err(msg.id ?? null, -32000, "Bad MCP-Protocol-Version"));
      const r = sessions.get(sid)(msg);
      if (!r) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "tools/call") {
        // SSE reply with a notification first.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\nevent: message\nid: 1\ndata: ${JSON.stringify(r)}\n\n`);
        return;
      }
      return json(200, r);
    }
    // modern
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return json(400, err(null, -32700, "Parse error"));
    }
    if (msg.id !== undefined && msg.method !== "server/discover") {
      const hm = req.headers["mcp-method"];
      if (hm !== msg.method) return json(400, err(msg.id, -32020, `Mcp-Method header ${hm} does not match ${msg.method}`));
      if (msg.method === "tools/call" && req.headers["mcp-name"] !== msg.params?.name) return json(400, err(msg.id, -32020, "Mcp-Name header mismatch"));
    }
    const r = modernHandle(msg);
    if (!r) {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === "tools/call") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\nid: 1\ndata: ${JSON.stringify(r)}\n\n`);
      return;
    }
    return json(200, r);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`listening ${server.address().port}\n`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

export function main(era) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--http");
  if (i >= 0) runHttp(era, Number(argv[i + 1] ?? 0));
  else runStdio(era, { stubborn: argv.includes("--stubborn") });
}
