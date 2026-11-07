// MCP mount per agent (§5.2): how the tapped server is handed to each agent
// without touching the user's MCP config. Until this moves into the Adapter
// contract as `mountMcp?()`, the table lives here. Every file is written
// inside the sandbox (work/ or home/).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentId } from "../schema/index.ts";
import type { Sandbox } from "./sandbox.ts";

export interface McpServerMount {
  name: string;
  /** argv the agent spawns (the tap relay). */
  stdio?: string[];
  /** Streamable HTTP endpoint (the tap proxy). */
  url?: string;
}

export interface MountResult {
  env: Record<string, string>;
  flags: string[];
  /** Absolute path → content, already written. */
  files: Record<string, string>;
}

/** How each agent names MCP tools in its events, for attribution. "unknown" falls back to the tap. */
export const MCP_EVENT_NAMES: Record<string, { pattern: (server: string, tool: string) => string; certainty: "verified" | "partial" | "unknown" }> = {
  "claude-code": { pattern: (s, t) => `mcp__${s}__${t}`, certainty: "verified" },
  codex: { pattern: (s, t) => `mcp__${s}__${t}`, certainty: "partial" },
  opencode: { pattern: (s, t) => `${s}_${t}`, certainty: "partial" },
  "gemini-cli": { pattern: (s, t) => `mcp_${s}_${t}`, certainty: "partial" },
  antigravity: { pattern: (s, t) => `mcp_${s}_${t}`, certainty: "partial" },
};

export class UnsupportedMountError extends Error {
  constructor(agent: string) {
    super(`no MCP mount is known for agent ${agent}; see docs/TOOL-EVALS.md §5.2`);
    this.name = "UnsupportedMountError";
  }
}

const toml = (s: string) => JSON.stringify(s);

export async function mountMcp(agent: AgentId, server: McpServerMount, sb: Sandbox): Promise<MountResult> {
  if (!server.stdio && !server.url) throw new Error("mountMcp needs stdio or url");
  const files: Record<string, string> = {};
  const put = async (p: string, content: string) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
    files[p] = content;
  };
  const [cmd, ...args] = server.stdio ?? [];
  const n = server.name;
  switch (agent) {
    case "claude-code": {
      const entry = server.url ? { type: "http", url: server.url } : { command: cmd, args };
      const p = join(sb.root, "mcp.claude.json");
      await put(p, JSON.stringify({ mcpServers: { [n]: entry } }, null, 2));
      return { env: {}, flags: ["--strict-mcp-config", "--mcp-config", p], files };
    }
    case "codex": {
      const flags = server.url
        ? ["-c", `mcp_servers.${n}.url=${toml(server.url)}`]
        : ["-c", `mcp_servers.${n}.command=${toml(cmd!)}`, "-c", `mcp_servers.${n}.args=[${args.map(toml).join(",")}]`];
      return { env: {}, flags: [...flags, "--ignore-user-config"], files };
    }
    case "opencode": {
      const entry = server.url ? { type: "remote", url: server.url } : { type: "local", command: [cmd, ...args] };
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { [n]: entry } }, codemode: false }) }, flags: [], files };
    }
    case "gemini-cli":
    case "antigravity": {
      const entry = server.url ? { httpUrl: server.url } : { command: cmd, args };
      await put(join(sb.home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { [n]: entry } }, null, 2));
      return { env: { GEMINI_CLI_HOME: sb.home }, flags: [], files };
    }
    case "cursor": {
      const entry = server.url ? { url: server.url } : { command: cmd, args };
      await put(join(sb.work, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { [n]: entry } }, null, 2));
      return { env: {}, flags: ["--approve-mcps"], files };
    }
    case "copilot-cli": {
      const entry = server.url ? { type: "http", url: server.url, tools: ["*"] } : { type: "local", command: cmd, args, tools: ["*"] };
      const p = join(sb.root, "mcp.copilot.json");
      await put(p, JSON.stringify({ mcpServers: { [n]: entry } }, null, 2));
      return { env: {}, flags: ["--additional-mcp-config", `@${p}`], files };
    }
    case "amp": {
      const entry = server.url ? { url: server.url } : { command: cmd, args };
      return { env: {}, flags: ["--mcp-config", JSON.stringify({ [n]: entry })], files };
    }
    default:
      throw new UnsupportedMountError(agent);
  }
}
