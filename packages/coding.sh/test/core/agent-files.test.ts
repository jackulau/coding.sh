import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { agentFileProblem, agentFileProblems } from "../../src/core/agent-files.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const agent = (fm: string) => `---\nname: reviewer\ndescription: Reviews a diff\n${fm}\nmodel: opus\n---\n\nYou review diffs.\n`;

describe("agentFileProblem", () => {
  it("flags an OpenCode-style tools: map and turns its false keys into disallowedTools", () => {
    assert.deepEqual(agentFileProblem(agent("tools:\n  edit: false\n  write: false\n  bash: false")), {
      problem: "`tools:` is a map (edit: false, write: false, bash: false); Claude Code reads a list of tool names, so this subagent gets no tools",
      fix: "disallowedTools: Edit, Write, Bash",
    });
    assert.equal(agentFileProblem(agent("tools:\n  read: true\n  bash: true"))?.fix, undefined, "all on: drop the map");
    assert.equal(agentFileProblem(agent("tools:\n  webfetch: false").replace(/\n/g, "\r\n"))?.fix, "disallowedTools: WebFetch", "CRLF");
  });

  it("leaves Claude Code's own forms alone", () => {
    for (const fm of ["tools: Read, Grep, Glob", "tools:\n  - Read\n  - Grep", "disallowedTools: Edit, Write", ""]) assert.equal(agentFileProblem(agent(fm)), undefined, fm);
    assert.equal(agentFileProblem("tools:\n  edit: false\n"), undefined, "no frontmatter");
    assert.equal(agentFileProblem("---\nname: x\n---\ntools:\n  edit: false\n"), undefined, "in the body");
  });
});

describe("harness audit names misread subagent files", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-agentfiles-")));
    const home = join(root, "home");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    mkdirSync(join(home, "app", ".claude", "agents"), { recursive: true });
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(home, ".claude", "agents", "hunter.md"), agent("tools:\n  edit: false\n  write: false"));
    writeFileSync(join(home, ".claude", "agents", "fine.md"), agent("disallowedTools: Edit"));
    writeFileSync(join(home, "app", ".claude", "agents", "local.md"), agent("tools:\n  bash: false"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("scans the user's and the project's agents folders, skipping missing ones", () => {
    const home = env.HOME!;
    const found = agentFileProblems([join(home, ".claude", "agents"), join(home, "app", ".claude", "agents"), join(home, "nope")]);
    assert.deepEqual(found.map((f) => [f.path, f.fix]), [
      [join(home, ".claude", "agents", "hunter.md"), "disallowedTools: Edit, Write"],
      [join(home, "app", ".claude", "agents", "local.md"), "disallowedTools: Bash"],
    ]);
  });

  it("prints a warning with the fix per file, and --json carries agentFiles; another agent's audit skips them", () => {
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: join(env.HOME!, "app"), encoding: "utf8", timeout: 60_000 });
    const text = cli(["harness", "audit"]);
    assert.equal(text.status, 0, text.stderr);
    const all = text.stdout + text.stderr;
    assert.match(all, /2 subagent files give `tools:` as a map/);
    assert.match(all, /hunter\.md: use `disallowedTools: Edit, Write`/);
    assert.match(all, /local\.md: use `disallowedTools: Bash`/);
    const doc = JSON.parse(cli(["harness", "audit", "--json"]).stdout) as { agentFiles?: { path: string }[] };
    assert.equal(doc.agentFiles?.length, 2);
    const codex = JSON.parse(cli(["harness", "audit", "--agent", "codex", "--json"]).stdout) as { agentFiles?: unknown };
    assert.equal(codex.agentFiles, undefined);
  });
});
