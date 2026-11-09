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
