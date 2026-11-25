// Where a capture script makes its temp folder. Claude Code reads CLAUDE.md files, rules, skills
// and agents from every folder above the project it runs in, and the git repository it finds
// there goes into its context. A capture made below such a folder would record your own
// instructions and skills. Windows keeps the temp folder under your home, next to ~/.claude.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** What Claude Code looks for in the folders above its project. */
export const READ_ABOVE = ["CLAUDE.md", "CLAUDE.local.md", ".claude", ".git"];

/** Each name in READ_ABOVE that exists in `dir` or a folder above it, as a path. */
export function readAbove(dir: string): string[] {
  const found: string[] = [];
  for (let d = realpathSync(dir); ; d = dirname(d)) {
    for (const name of READ_ABOVE) if (existsSync(join(d, name))) found.push(join(d, name));
    if (dirname(d) === d) return found;
  }
}

/**
 * `dir`, when nothing in it or above it would reach a capture. Otherwise throws, naming what
 * Claude Code would read and how to pick another folder (`fix`).
 */
export function tempBase(dir: string, fix = "set TEMP (TMPDIR on Linux and macOS) to a folder that has none of them above it"): string {
  const found = readAbove(dir);
  if (found.length > 0) throw new Error(`Claude Code would read ${found.join(", ")}: ${fix}`);
  return dir;
}
