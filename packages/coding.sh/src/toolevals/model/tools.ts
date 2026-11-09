// Tool lists for the model driver (§4.2 step 1):
//   MCP target  → the proxied tools/list, passed through as-is, plus
//                 list_mcp_resources / read_mcp_resource when the server has
//                 resources and get_mcp_prompt when it has prompts (as Claude
//                 Code exposes them)
//   CLI target  → one `shell` tool {command}, `sh -c` in the sandbox (or a
//                 simulated shell, see shell-sim.ts)
//   HTTP target → `http_request` restricted to the tapped base URL, plus `read_doc` over `docs`
// Every result goes through capOutput (cap.ts): 16 KB, structure-aware by default.
import { readFile } from "node:fs/promises";
import { RpcError } from "../mcp/jsonrpc.ts";
import { promptText, resourceText, resultText, type McpClient, type McpProgress } from "../mcp/client.ts";
import { commandEnv, sh } from "../../runner/exec.ts";
import { safeJoin } from "../../runner/fsutil.ts";
import { matchAny } from "../../runner/glob.ts";
import type { Sandbox } from "../sandbox.ts";
import type { Target } from "../types.ts";
import type { SimulatedShell } from "./shell-sim.ts";
import { capOutput, DEFAULT_CAP_BYTES, mergeCuts, type OutputCapConfig, type OutputCut } from "./cap.ts";
import { safeToolName, type ToolCall, type ToolDef } from "./types.ts";

export const OUTPUT_CAP = DEFAULT_CAP_BYTES;
const SHELL_TIMEOUT_MS = 120_000;

export interface ToolExecResult {
  content: string;
  isError: boolean;
  /** Set when the cap changed the output. */
  cut?: OutputCut;
  /** Extra tool.end payload (a simulated shell's model, MCP progress…). */
  meta?: Record<string, unknown>;
}

export interface ToolRuntime {
  defs: ToolDef[];
  exec(call: ToolCall): Promise<ToolExecResult>;
  /** Provider-safe name → original tool name. */
  names: Map<string, string>;
}

export interface ToolRuntimeOpts {
  mcp?: McpClient;
  httpUrl?: string;
  fetch?: typeof fetch;
  outputCap?: OutputCapConfig;
  /** CLI target: shell calls go to this simulator instead of `sh -c`. */
  shellSim?: SimulatedShell;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function buildToolRuntime(target: Target, sb: Sandbox, o: ToolRuntimeOpts = {}): Promise<ToolRuntime> {
  const names = new Map<string, string>();
  const capCfg = o.outputCap ?? {};
  const maxBytes = capCfg.maxBytes ?? OUTPUT_CAP;
  const capped = (text: string, isError: boolean, meta?: Record<string, unknown>): ToolExecResult => {
    const r = capOutput(text, capCfg);
    return { content: r.text, isError, ...(r.cut ? { cut: r.cut } : {}), ...(meta ? { meta } : {}) };
  };
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
    const caps = client.capabilities ?? {};
    const synthetic = new Map<string, "list" | "read" | "prompt">();
    const addSynthetic = (name: string, kind: "list" | "read" | "prompt", description: string, inputSchema: object) => {
      const safe = safeToolName(name, taken);
      synthetic.set(safe, kind);
      defs.push({ name: safe, description, inputSchema });
    };
    if (caps.resources !== undefined) {
      const resources = await client.listResources().catch(() => []);
      const templates = await client.listResourceTemplates().catch(() => []);
      const listed = [...resources.slice(0, 50).map((r) => `- ${r.uri}${r.name ? ` (${r.name})` : ""}${r.description ? `: ${r.description}` : ""}`), ...templates.slice(0, 20).map((t) => `- ${t.uriTemplate} (template)${t.description ? `: ${t.description}` : ""}`)];
      addSynthetic("list_mcp_resources", "list", "List the resources the MCP server offers (uri, name, description).", { type: "object", properties: {} });
      addSynthetic("read_mcp_resource", "read", `Read a resource from the MCP server by URI.${listed.length ? `\nResources:\n${listed.join("\n")}` : ""}`, { type: "object", properties: { uri: { type: "string", description: "Resource URI" } }, required: ["uri"] });
    }
    if (caps.prompts !== undefined) {
      const prompts = await client.listPrompts().catch(() => []);
      const listed = prompts.slice(0, 50).map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ""}${p.arguments?.length ? ` (arguments: ${p.arguments.map((a) => `${a.name}${a.required ? "" : "?"}`).join(", ")})` : ""}`);
      addSynthetic("get_mcp_prompt", "prompt", `Get a prompt template from the MCP server, filled in with arguments.${listed.length ? `\nPrompts:\n${listed.join("\n")}` : ""}`, { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: { type: "string" } } }, required: ["name"] });
    }
    const errText = (e: unknown) => (e instanceof RpcError ? `Error ${e.code}: ${e.message}` : `Error: ${e instanceof Error ? e.message : String(e)}`);
    return {
      defs,
      names,
      async exec(call) {
        const kind = synthetic.get(call.name);
        const input = obj(call.input);
        try {
          if (kind === "list") {
            const rs = await client.listResources();
            return capped(JSON.stringify(rs), false);
          }
          if (kind === "read") {
            if (typeof input.uri !== "string") return { content: "Error: `uri` (string) is required", isError: true };
            return capped(resourceText(await client.readResource(input.uri)), false);
          }
          if (kind === "prompt") {
            if (typeof input.name !== "string") return { content: "Error: `name` (string) is required", isError: true };
            const args = Object.fromEntries(Object.entries(obj(input.arguments)).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
            return capped(promptText((await client.getPrompt(input.name, args)).messages), false);
          }
          const name = names.get(call.name) ?? call.name;
          let progress: McpProgress | undefined;
          let updates = 0;
          const r = await client.callTool(name, input, {
            timeoutMs: SHELL_TIMEOUT_MS,
            onProgress: (p) => {
              updates++;
              progress = p;
            },
          });
          return capped(resultText(r), r.isError === true, updates ? { progress: { updates, last: progress } } : undefined);
        } catch (e) {
          return { content: errText(e), isError: true };
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
          description: `Run a shell command in the sandbox working directory with sh -c. Returns stdout, stderr and the exit code (output truncated at ${Math.round(maxBytes / 1024)} KB).`,
          inputSchema: { type: "object", properties: { command: { type: "string", description: "The command line to run" } }, required: ["command"] },
        },
      ],
      async exec(call) {
        const command = obj(call.input).command;
        if (typeof command !== "string" || !command.trim()) return { content: "Error: `command` (string) is required", isError: true };
        if (o.shellSim) {
          const r = await o.shellSim.exec(command);
          return capped(r.content, r.isError, { simulated: true, shellModel: o.shellSim.label });
        }
        // The shell keeps a tail of each stream; a structure cut needs more than the cap to cut from.
        const r = await sh(command, { cwd: sb.work, env, timeoutMs: SHELL_TIMEOUT_MS, tailBytes: capCfg.mode === "none" ? 4 * maxBytes : Math.max(4 * maxBytes, 64 * 1024) });
        const parts = [];
        let cut: OutputCut | undefined;
        if (r.stdoutTail) {
          const c = capOutput(r.stdoutTail, capCfg);
          parts.push(c.text);
          cut = c.cut;
        }
        if (r.stderrTail) {
          const c = capOutput(r.stderrTail, capCfg);
          parts.push(`[stderr]\n${c.text}`);
          cut = mergeCuts(cut, c.cut);
        }
        parts.push(r.timedOut ? "[timed out]" : `[exit code ${r.exitCode}]`);
        return { content: parts.join("\n"), isError: r.exitCode !== 0, ...(cut ? { cut } : {}) };
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
          return capped(await readFile(safeJoin(sb.work, p), "utf8"), false);
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
        // The status line stays outside the cut so a JSON body is capped as JSON.
        const status = `HTTP ${res.status}\n`;
        const c = capOutput(text, { ...capCfg, maxBytes: Math.max(1, maxBytes - Buffer.byteLength(status)) });
        return { content: status + c.text, isError: res.status >= 400, ...(c.cut ? { cut: c.cut } : {}) };
      } catch (e) {
        return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}
