// Which repo files make up an agent's harness: the context files, rules and
// skills it loads. exp ab and refine test edits to them; improve reads their
// git history.

/** Harness files, as repo-relative paths: the context files, rules and skills an agent loads. */
export function isHarnessPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return /^(?:CLAUDE|AGENTS|GEMINI)\.md$/.test(p) || /^\.claude\/rules\/.+\.md$/.test(p) || /^\.cursor\/rules\/.+\.mdc?$/.test(p) || /^\.(?:claude|agents)\/skills\/[^/]+\/SKILL\.md$/.test(p);
}

/** Directories that hold harness files (besides the context files at the root). */
export const HARNESS_DIRS = [".claude/rules", ".cursor/rules", ".claude/skills", ".agents/skills"];

/** Git pathspecs that cover every harness file (and some that isHarnessPath then drops). */
export const HARNESS_PATHSPECS = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ...HARNESS_DIRS];
