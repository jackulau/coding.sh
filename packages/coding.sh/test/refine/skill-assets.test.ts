import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessPath, isInstructionHarnessPath } from "../../src/core/harness-paths.ts";
import { harnessFilesIn } from "../../src/cli/commands/exp-ab.ts";
import { runCritics } from "../../src/refine/critics.ts";
import { checkProtected, protectedLines } from "../../src/refine/protect.ts";

test("a skill's scripts and references are harness files; SKILL.md stays the only instruction file", () => {
  assert.equal(isHarnessPath(".claude/skills/s/scripts/a.mjs"), true);
  assert.equal(isHarnessPath(".agents/skills/s/references/r.md"), true);
  assert.equal(isHarnessPath(".claude/skills/s/node_modules/x/index.js"), false);
  assert.equal(isHarnessPath(".claude/skills/s/.DS_Store"), false);
  assert.equal(isHarnessPath(".claude/skills/README.md"), false);
  assert.equal(isInstructionHarnessPath(".claude/skills/s/scripts/a.mjs"), false);
  assert.equal(isInstructionHarnessPath(".claude/skills/s/SKILL.md"), true);
});

test("harnessFilesIn carries a skill's text files and leaves binary and large ones out", () => {
  const d = mkdtempSync(join(tmpdir(), "skill-assets-"));
  const s = join(d, ".claude/skills/s");
  mkdirSync(join(s, "scripts"), { recursive: true });
  mkdirSync(join(s, "docs"), { recursive: true });
  writeFileSync(join(s, "SKILL.md"), "---\nname: s\n---\nRun scripts/a.mjs.\n");
  writeFileSync(join(s, "scripts/a.mjs"), "console.log(1);\n");
  writeFileSync(join(s, "docs/x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(s, "docs/big.json"), "x".repeat(1_000_001));
  assert.deepEqual(harnessFilesIn(d).map((f) => f.path), [".claude/skills/s/SKILL.md", ".claude/skills/s/scripts/a.mjs"]);
});

test("critics and protected lines ignore a skill's scripts", () => {
  const skill = { path: ".claude/skills/s/SKILL.md", text: "# S\n\nNever push to main.\n" };
  const before = [skill, { path: ".claude/skills/s/scripts/a.mjs", text: "// NEVER delete this guard\nconst a = 1;\n" }];
  const after = [skill, { path: ".claude/skills/s/scripts/a.mjs", text: "const a = 2;\nconst a = 2;\nconst a = 2;\n" }];
  assert.ok(protectedLines(before).every((l) => !l.path.includes("scripts/")));
  assert.equal(checkProtected(before, after).rejections?.length ?? 0, 0);
  const c = runCritics(before, after);
  assert.equal(JSON.stringify(c).includes("scripts/a.mjs"), false);
});
