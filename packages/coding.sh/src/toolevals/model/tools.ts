// Tool lists for the model driver (§4.2 step 1):
//   MCP target  → the proxied tools/list, passed through as-is
//   CLI target  → one `shell` tool {command}, `sh -c` in the sandbox, 16 KB output cap
//   HTTP target → `http_request` restricted to the tapped base URL, plus `read_doc` over `docs`
import { readFile } from "node:fs/promises";
import { RpcError } from "../mcp/jsonrpc.ts";
import { resultText, type McpClient } from "../mcp/client.ts";
import { commandEnv, sh } from "../../runner/exec.ts";
import { safeJoin } from "../../runner/fsutil.ts";
import { matchAny } from "../../runner/glob.ts";
import type { Sandbox } from "../sandbox.ts";
import type { Target } from "../types.ts";
import { safeToolName, type ToolCall, type ToolDef } from "./types.ts";

export const OUTPUT_CAP = 16 * 1024;
const SHELL_TIMEOUT_MS = 120_000;

export interface ToolRuntime {
  defs: ToolDef[];
  exec(call: ToolCall): Promise<{ content: string; isError: boolean }>;
  /** Provider-safe name → original tool name. */
  names: Map<string, string>;
}

function cap(s: string): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= OUTPUT_CAP) return s;
  return b.subarray(0, OUTPUT_CAP).toString("utf8") + `\n[truncated ${b.length - OUTPUT_CAP} bytes]`;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function buildToolRuntime(target: Target, sb: Sandbox, o: { mcp?: McpClient; httpUrl?: string; fetch?: typeof fetch } = {}): Promise<ToolRuntime> {
  const names = new Map<string, string>();
  if (target.kind === "mcp") {
    if (!o.mcp) throw new Error("MCP target needs a connected client");
    const tools = await o.mcp.listTools();
    const taken = new Set<string>();
    const defs = tools.map((t) => {
      const safe = safeToolName(t.name, taken);
      names.set(safe, t.name);
      return { name: safe, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } };
    });
    const client = o.mcp;
    return {
      defs,
      names,
      async exec(call) {
        const name = names.get(call.name) ?? call.name;
        try {
          const r = await client.callTool(name, obj(call.input), { timeoutMs: SHELL_TIMEOUT_MS });
          return { content: cap(resultText(r)), isError: r.isError === true };
        } catch (e) {
          return { content: e instanceof RpcError ? `Error ${e.code}: ${e.message}` : `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    };
  }

  if (target.kind === "cli") {
    names.set("shell", "shell");
    const env = { ...commandEnv(sb.env), HOME: sb.home };
    return {
      names,
      defs: [
        {
          name: "shell",
          description: "Run a shell command in the sandbox working directory with sh -c. Returns stdout, stderr and the exit code (output truncated at 16 KB).",
          inputSchema: { type: "object", properties: { command: { type: "string", description: "The command line to run" } }, required: ["command"] },
        },
      ],
      async exec(call) {
        const command = obj(call.input).command;
        if (typeof command !== "string" || !command.trim()) return { content: "Error: `command` (string) is required", isError: true };
        const r = await sh(command, { cwd: sb.work, env, timeoutMs: SHELL_TIMEOUT_MS, tailBytes: OUTPUT_CAP + 1 });
        const parts = [];
        if (r.stdoutTail) parts.push(cap(r.stdoutTail));
        if (r.stderrTail) parts.push(`[stderr]\n${cap(r.stderrTail)}`);
        parts.push(r.timedOut ? "[timed out]" : `[exit code ${r.exitCode}]`);
        return { content: parts.join("\n"), isError: r.exitCode !== 0 };
      },
    };
  }

  // HTTP
  const base = o.httpUrl ?? target.baseUrl;
  const doFetch = o.fetch ?? fetch;
  names.set("http_request", "http_request");
  names.set("read_doc", "read_doc");
  const docs = target.docs ?? [];
  return {
    names,
    defs: [
      {
        name: "http_request",
        description: `Send an HTTP request to the API at ${base}. \`path\` is relative to the base URL and must start with "/".`,
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
            path: { type: "string" },
            query: { type: "object", additionalProperties: { type: "string" } },
            headers: { type: "object", additionalProperties: { type: "string" } },
            body: {},
          },
          required: ["method", "path"],
        },
      },
      {
        name: "read_doc",
        description: `Read a documentation file. Allowed paths match: ${docs.join(", ") || "(none)"}.`,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    async exec(call) {
      const a = obj(call.input);
      if (call.name === "read_doc") {
        const p = typeof a.path === "string" ? a.path.replace(/^\.\//, "") : "";
        if (!p || !matchAny(p, docs)) return { content: `Error: ${JSON.stringify(p)} is not a documentation path`, isError: true };
        try {
          return { content: cap(await readFile(safeJoin(sb.work, p), "utf8")), isError: false };
        } catch (e) {
          return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      }
      const path = typeof a.path === "string" ? a.path : "";
      if (!path.startsWith("/") || path.startsWith("//") || /^[a-z]+:/i.test(path)) return { content: "Error: path must be relative to the base URL and start with /", isError: true };
      const url = new URL(base.replace(/\/$/, "") + path);
      for (const [k, v] of Object.entries(obj(a.query))) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(a.headers))) headers[k] = String(v);
      let body: string | undefined;
      if (a.body !== undefined && a.body !== null) {
        body = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
        headers["content-type"] ??= "application/json";
      }
      try {
        const res = await doFetch(url, { method: typeof a.method === "string" ? a.method.toUpperCase() : "GET", headers, body });
        const text = await res.text();
        return { content: cap(`HTTP ${res.status}\n${text}`), isError: res.status >= 400 };
      } catch (e) {
        return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}
