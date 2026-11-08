// `refine --target`: a harness file, or a skill directory that stands for its
// SKILL.md. A skill's own eval suite (evals/<skill name>) is the fitness a
// climb on it uses when --suite is not given.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SKILL_DIR = /(?:^|\/)\.(?:claude|agents)\/skills\/([^/]+)$/;

/** The repo path `--target` names: a skill directory becomes its SKILL.md. */
export function targetPath(target: string | undefined, root: string): string | undefined {
  if (!target) return undefined;
  const t = target.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  if (SKILL_DIR.test(t)) return `${t}/SKILL.md`;
  try {
    if (statSync(resolve(root, t)).isDirectory() && existsSync(join(resolve(root, t), "SKILL.md"))) return `${t}/SKILL.md`;
  } catch {
    // not on disk: a harness path taken as given
  }
  return t;
}

/** The skill a target path belongs to (`.claude/skills/pdf/SKILL.md` → pdf). */
export function skillOf(path: string | undefined): string | undefined {
  return /(?:^|\/)\.(?:claude|agents)\/skills\/([^/]+)\/SKILL\.md$/.exec(path ?? "")?.[1];
}
