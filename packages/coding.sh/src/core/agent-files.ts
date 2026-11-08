// Claude Code subagent files (<config>/agents/*.md, <project>/.claude/agents/*.md)
// whose frontmatter Claude Code misreads. The one found so far: `tools:` written
// as OpenCode's map (`edit: false`). Claude Code reads `tools:` as a list of tool
// names, so the subagent ends up with none of the tools it needs, and its model
// writes tool calls out as text instead (the text-tool-call flag, core/sessions.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentFileProblem {
  path: string;
  /** What is wrong, one line. */
  problem: string;
  /** The frontmatter line to use instead; absent when the line should go. */
  fix?: string;
}

/** OpenCode tool keys in Claude Code's spelling. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "Read", edit: "Edit", write: "Write", bash: "Bash", glob: "Glob", grep: "Grep", list: "LS",
  webfetch: "WebFetch", websearch: "WebSearch", multiedit: "MultiEdit", notebookedit: "NotebookEdit", task: "Task", todowrite: "TodoWrite",
};
const MAP_ENTRY = /^[ \t]+([A-Za-z_*][\w*-]*):[ \t]*(true|false)[ \t]*$/;

/** The frontmatter's lines, or undefined when the file has none. */
function frontmatter(text: string): string[] | undefined {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return undefined;
  const end = t.indexOf("\n---", 3);
  return end < 0 ? undefined : t.slice(4, end).split("\n");
}

/** A problem with one agent file's frontmatter, or undefined when Claude Code reads it as meant. */
export function agentFileProblem(text: string): Omit<AgentFileProblem, "path"> | undefined {
  const fm = frontmatter(text);
  if (!fm) return undefined;
  const i = fm.findIndex((l) => /^tools:[ \t]*$/.test(l));
  if (i < 0) return undefined;
  const entries: [string, boolean][] = [];
  for (let j = i + 1; j < fm.length; j++) {
    const m = MAP_ENTRY.exec(fm[j]!);
    if (!m) break;
    entries.push([m[1]!, m[2] === "true"]);
  }
  if (!entries.length) return undefined;
  // OpenCode's map turns named tools on or off from "all on", so only the `false` keys carry over.
  const denied = entries.filter(([, on]) => !on).map(([k]) => TOOL_NAMES[k.toLowerCase()] ?? k);
  return {
    problem: `\`tools:\` is a map (${entries.map(([k, on]) => `${k}: ${on}`).join(", ")}); Claude Code reads a list of tool names, so this subagent gets no tools`,
    ...(denied.length ? { fix: `disallowedTools: ${denied.join(", ")}` } : {}),
  };
}

/** Agent files in these directories that Claude Code misreads. Missing directories are skipped. */
export function agentFileProblems(dirs: readonly string[]): AgentFileProblem[] {
  const out: AgentFileProblem[] = [];
  for (const dir of new Set(dirs)) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const p = agentFileProblem(text);
      if (p) out.push({ path, ...p });
    }
  }
  return out;
}
