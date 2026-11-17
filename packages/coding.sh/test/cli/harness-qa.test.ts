// harness QA fixes: a claude-code snapshot carries the files CLAUDE.md pulls in with `@path`
// imports and leaves out Claude Code's skills/.trash, and harness audit stops on Ctrl-C (its
// listing of files on disk gives the event loop turns and honors the abort signal).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { importPaths } from "../../src/cli/commands/harness.ts";
import { listMemoryFiles, listMemoryFilesAsync, memoryAudit } from "../../src/core/memory-files.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
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

describe("harness audit stops on an abort", () => {
  it("memoryAudit rejects with the abort when its signal has fired, instead of finishing", async () => {
    const app = join(home, "audit-app");
    put(join(app, "CLAUDE.md"), "# app\n");
    for (let i = 0; i < 50; i++) put(join(app, `d${i}`, "x", "CLAUDE.md"), "# x\n");
    const index = new MemoryIndexStore();
    await index.upsertSession({ id: "s1", agent: "claude-code", cwd: app, startedAt: 1, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } } as Session);
    const ac = new AbortController();
    ac.abort(new DOMException("stopped", "AbortError"));
    await assert.rejects(memoryAudit(index, { env, signal: ac.signal }), { name: "AbortError" });
    // Without a signal the same audit finishes.
    const a = await memoryAudit(index, { env });
    assert.ok(a.files.some((f) => f.path === "~/audit-app/CLAUDE.md"));
  });

  it("the file listing gives the event loop turns while it walks, so a timer (a signal) runs and stops it", async () => {
    const app = join(home, "walk-app");
    for (let i = 0; i < 30; i++) put(join(app, `d${i}`, "CLAUDE.md"), "# x\n");
    const dirs = { home, claudeDir: join(home, ".claude"), codexDir: join(home, ".codex") };
    const ac = new AbortController();
    let fired = false;
    setImmediate(() => {
      fired = true;
      ac.abort(new DOMException("stopped", "AbortError"));
    });
    await assert.rejects(listMemoryFilesAsync(dirs, [app], { signal: ac.signal, sliceMs: 0 }), { name: "AbortError" });
    assert.ok(fired);
    const all = await listMemoryFilesAsync(dirs, [app], { sliceMs: 0 });
    assert.deepEqual(all.map((f) => f.key).sort(), listMemoryFiles(dirs, [app]).map((f) => f.key).sort(), "same files as the sync listing");
    assert.equal(all.filter((f) => f.key.startsWith("~/walk-app/")).length, 30);
  });
});
