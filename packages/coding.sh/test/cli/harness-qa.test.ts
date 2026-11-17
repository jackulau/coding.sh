// harness QA fixes: a claude-code snapshot carries the files CLAUDE.md pulls in with `@path`
// imports and leaves out Claude Code's skills/.trash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { importPaths } from "../../src/cli/commands/harness.ts";
import { removeTestDir } from "../_rm.ts";
import { CLI } from "../_cli.ts";

let root = "";
let home = "";
let env: NodeJS.ProcessEnv = {};

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-harness-qa-")));
  home = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  env = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };
});
after(() => removeTestDir(root));

function snapshot(dir: string, agent = "claude-code"): string[] {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, "harness", "snapshot", "-a", agent, "--dir", dir, "--name", "t", "--json"], { env, cwd: dir, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).bundle.files;
}

describe("harness snapshot --agent claude-code", () => {
  it("carries the files CLAUDE.md imports with @path, followed through imports of imports", () => {
    const proj = join(root, "proj-imports");
    put(join(proj, "CLAUDE.md"), "@AGENTS.md\nSee @docs/style.md.\n`@not/this.md` and an email user@example.test\n```\n@nor/this.md\n```\n");
    put(join(proj, "AGENTS.md"), "# rules\nuse tabs\n@docs/deeper.md\n");
    put(join(proj, "docs", "style.md"), "style\n");
    put(join(proj, "docs", "deeper.md"), "@../missing.md\n");
    put(join(proj, "not", "this.md"), "x\n");
    put(join(proj, "nor", "this.md"), "x\n");
    put(join(home, "notes", "me.md"), "mine\n");
    put(join(home, ".claude", "CLAUDE.md"), "@~/notes/me.md\n");
    const files = snapshot(proj);
    assert.deepEqual(files.filter((f) => !f.startsWith("~/.claude/skills/")).sort(), ["AGENTS.md", "CLAUDE.md", "docs/deeper.md", "docs/style.md", "~/.claude/CLAUDE.md", "~/notes/me.md"].sort());
  });

  it("leaves out dot dirs under skills/ (Claude Code's .trash of deleted skills)", () => {
    const proj = join(root, "proj-trash");
    mkdirSync(proj, { recursive: true });
    put(join(home, ".claude", "skills", ".trash", "x", "y", "pdf", "SKILL.md"), "---\nname: pdf\n---\nold\n");
    put(join(home, ".claude", "skills", "live", "SKILL.md"), "---\nname: live\ndescription: d\n---\nx\n");
    put(join(proj, ".claude", "skills", ".trash", "old", "SKILL.md"), "---\nname: old\n---\n");
    put(join(proj, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
    const files = snapshot(proj);
    assert.ok(files.includes("~/.claude/skills/live/SKILL.md"), files.join(", "));
    assert.ok(files.includes(".claude/skills/mine/SKILL.md"), files.join(", "));
    assert.deepEqual(files.filter((f) => f.includes(".trash")), []);
  });

  it("finds imports only outside code, without trailing punctuation", () => {
    assert.deepEqual(importPaths("@AGENTS.md\nsee @a/b.md, then `@c.md`\n```\n@d.md\n```\nuser@example.test @~/z.md."), ["AGENTS.md", "a/b.md", "~/z.md"]);
  });
});
