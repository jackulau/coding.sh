// Which repo files make up an agent's harness: the context files, rules and
// skills it loads. exp ab and refine test edits to them; improve reads their
// git history.

/** Instruction files, as repo-relative paths: the context files, rules and SKILL.md files an agent reads as text. */
export function isInstructionHarnessPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return /^(?:CLAUDE|AGENTS|GEMINI)\.md$/.test(p) || /^\.claude\/rules\/.+\.md$/.test(p) || /^\.cursor\/rules\/.+\.mdc?$/.test(p) || /^\.(?:claude|agents)\/skills\/[^/]+\/SKILL\.md$/.test(p);
}

/**
 * Harness files, as repo-relative paths: the instruction files, plus every file a skill ships
 * next to its SKILL.md (scripts/, references/, templates), which the agent runs or reads when it
 * uses the skill. A skill tested without them is a different skill.
 */
export function isHarnessPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return isInstructionHarnessPath(p) || /^\.(?:claude|agents)\/skills\/[^/]+\/(?!\.)[^]+$/.test(p) && !/(^|\/)(\.git|node_modules)\//.test(p);
}

/** Directories that hold harness files (besides the context files at the root). */
export const HARNESS_DIRS = [".claude/rules", ".cursor/rules", ".claude/skills", ".agents/skills"];

/** Git pathspecs that cover every harness file (and some that isHarnessPath then drops). */
export const HARNESS_PATHSPECS = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ...HARNESS_DIRS];

/** Display names of the agents whose loaded files {@link loadedBy} knows. */
export const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

/**
 * Whether `agent` loads this repo-relative harness file, by the table harness
 * audit uses (core/memory-audit.ts): Claude Code reads CLAUDE.md,
 * CLAUDE.local.md, .claude/CLAUDE.md, .claude/rules and .claude/skills; Codex
 * reads AGENTS.md (or AGENTS.override.md) and .agents/skills. Undefined for an
 * agent the table does not cover, or a file that is not a harness file.
 */
export function loadedBy(agent: string | undefined, rel: string): boolean | undefined {
  const p = rel.replace(/\\/g, "/");
  if (!isHarnessPath(p) && !/^(?:CLAUDE\.local|AGENTS\.override)\.md$|^\.claude\/CLAUDE\.md$/.test(p)) return undefined;
  if (agent === "claude-code") return /^(?:CLAUDE|CLAUDE\.local)\.md$|^\.claude\//.test(p);
  if (agent === "codex") return /^AGENTS(?:\.override)?\.md$|^\.agents\/skills\//.test(p);
  return undefined;
}

/**
 * The repo files that `@path` imports pull into the files `agent` loads (Claude Code's
 * memory imports: a CLAUDE.md of `@AGENTS.md` loads AGENTS.md), followed through up to 5 hops
 * as Claude Code does. Paths resolve against the importing file's folder; code spans and
 * fences are skipped, and only files in `files` count.
 */
export function importedBy(agent: string | undefined, files: readonly { path: string; text: string }[]): Set<string> {
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, "/"), f.text]));
  const out = new Set<string>();
  let frontier = [...byPath.keys()].filter((p) => loadedBy(agent, p) === true);
  for (let hop = 0; hop < 5 && frontier.length; hop++) {
    const next: string[] = [];
    for (const from of frontier) {
      const text = (byPath.get(from) ?? "").replace(/```[^]*?```/g, "").replace(/`[^`\n]*`/g, "");
      const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
      for (const m of text.matchAll(/(?:^|\s)@((?:\.{1,2}\/)*[\w.-][\w./-]*)/g)) {
        const to = normalizeRel(dir + m[1]!);
        if (to && byPath.has(to) && !out.has(to) && loadedBy(agent, to) !== true) {
          out.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return out;
}

function normalizeRel(p: string): string | undefined {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
