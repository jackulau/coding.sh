// Tool-call classification from agent events (§5.4). The tap sees every call
// to the target; this sees the work the agent does around it: reading docs
// with its own Read tool, `man`, web fetches, spawning subagents.
import { basename } from "node:path";
import { commandOf } from "../core/sessions.ts";
import type { AgentEvent } from "../schema/index.ts";

export type CallCategory = "shell" | "read" | "web" | "mcp" | "edit" | "subagent" | "other";

export interface Classified {
  category: CallCategory;
  command?: string;
  path?: string;
  url?: string;
  mcp?: { server: string; tool: string };
}

const SHELL = new Set(["bash", "shell", "shell_command", "exec_command", "run_shell_command", "local_shell", "terminal", "run_terminal_cmd", "execute", "sh"]);
const READ = new Set(["read", "read_file", "readfile", "view", "cat", "open_file", "read_many_files"]);
const WEB = new Set(["webfetch", "websearch", "web_fetch", "web_search", "google_web_search", "fetch", "browse"]);
const EDIT = new Set(["edit", "write", "multiedit", "apply_patch", "write_file", "replace", "str_replace_editor", "create_file", "notebookedit"]);
const SUBAGENT = new Set(["agent", "task", "spawn_agent", "subagent", "dispatch_agent"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** MCP tool names as each agent reports them: `mcp__<server>__<tool>` (Claude, Codex), `mcp_<server>_<tool>` (Gemini). */
export function parseMcpToolName(name: string, server?: string): { server: string; tool: string } | undefined {
  let m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1]!, tool: m[2]! };
  m = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (m) return { server: m[1]!, tool: m[2]! };
  if (server) return { server, tool: name };
  return undefined;
}

export function classifyToolStart(e: AgentEvent): Classified {
  const p = e.payload;
  const tool = str(p.tool) ?? "";
  const lower = tool.toLowerCase();
  const input = (typeof p.input === "object" && p.input !== null ? p.input : {}) as Record<string, unknown>;
  const server = str(p.server);
  const mcp = parseMcpToolName(tool, server);
  if (mcp) return { category: "mcp", mcp };
  if (SHELL.has(lower)) {
    const command = commandOf(p.input);
    return command ? { category: "shell", command } : { category: "shell" };
  }
  if (READ.has(lower)) {
    const path = str(input.file_path) ?? str(input.filePath) ?? str(input.absolute_path) ?? str(input.path) ?? str(input.target_file);
    return path ? { category: "read", path } : { category: "read" };
  }
  if (WEB.has(lower)) {
    const url = str(input.url) ?? str(input.query);
    return url ? { category: "web", url } : { category: "web" };
  }
  if (EDIT.has(lower)) return { category: "edit" };
  if (SUBAGENT.has(lower)) return { category: "subagent" };
  // Fallback: anything carrying a shell-like command field.
  const command = commandOf(p.input);
  if (command && /command/i.test(Object.keys(input).join(" "))) return { category: "shell", command };
  return { category: "other" };
}

// ------------------------------------------------------------ shell parsing

/** Splits a shell line into simple-command segments on `&&`, `||`, `;`, `|`, newlines (quotes respected). */
export function shellSegments(command: string): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  let word = "";
  let inWord = false;
  let q: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) cur.push(word);
    word = "";
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      endSeg();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSeg();
  return segs;
}

const PREFIXES = new Set(["env", "command", "exec", "time", "nice", "nohup", "sudo", "xargs", "npx", "bunx"]);

/** The argv of a segment after `env X=…`, `VAR=…` assignments and wrapper words. */
export function effectiveArgv(seg: readonly string[]): string[] {
  let i = 0;
  while (i < seg.length) {
    const w = seg[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (PREFIXES.has(w)) {
      i++;
      while (i < seg.length && seg[i]!.startsWith("-")) i++;
    } else break;
  }
  return seg.slice(i);
}

export interface ShellUse {
  /** Segments whose command word is the binary (by name or by any path ending in it). */
  invocations: number;
  /** Of those, how many went through a path rather than the bare name. */
  byPath: number;
  /** `man <bin>`, `tldr <bin>`, `<bin> help …`, `<bin> … --help`. */
  helpLookups: number;
  /** Of helpLookups, those that are `<bin>` invocations (the tap sees these too). */
  binHelp: number;
}

export function shellUse(command: string, bin: string): ShellUse {
  const u: ShellUse = { invocations: 0, byPath: 0, helpLookups: 0, binHelp: 0 };
  for (const seg of shellSegments(command)) {
    const argv = effectiveArgv(seg);
    const w = argv[0];
    if (!w) continue;
    if ((w === "man" || w === "tldr") && argv.slice(1).includes(bin)) {
      u.helpLookups++;
      continue;
    }
    if (w === bin || (w.includes("/") && basename(w) === bin)) {
      u.invocations++;
      if (w !== bin) u.byPath++;
      const rest = argv.slice(1);
      if (rest.includes("--help") || rest.includes("-h") || rest.filter((a) => !a.startsWith("-"))[0] === "help") {
        u.helpLookups++;
        u.binHelp++;
      }
    }
  }
  return u;
}
