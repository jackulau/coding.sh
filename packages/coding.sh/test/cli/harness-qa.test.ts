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

describe("harness snapshot --agent claude-code with CLAUDE_CONFIG_DIR, and the MCP servers it loads", () => {
  // Claude Code's config dir moved away from ~/.claude, as CLAUDE_CONFIG_DIR does it.
  const run = (proj: string, cfg: string, args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, CLAUDE_CONFIG_DIR: cfg }, cwd: proj, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  it("reads the user files from CLAUDE_CONFIG_DIR, not the home's .claude, and keeps their ~/.claude/ keys", () => {
    const proj = join(root, "proj-config-dir");
    const cfg = join(root, "config-dir", "claude");
    mkdirSync(proj, { recursive: true });
    put(join(cfg, "CLAUDE.md"), "from the config dir\n@extra.md\n@~/notes/cfg.md\n");
    put(join(cfg, "extra.md"), "extra\n");
    put(join(cfg, "skills", "cfg-only", "SKILL.md"), "---\nname: cfg-only\ndescription: d\n---\n");
    put(join(home, "notes", "cfg.md"), "cfg note\n");
    put(join(home, ".claude", "CLAUDE.md"), "from the home\n@~/notes/home.md\n");
    put(join(home, "notes", "home.md"), "home note\n");
    const r = run(proj, cfg, ["harness", "snapshot", "-a", "claude-code", "--dir", proj, "--name", "cfg", "--json"]);
    const files = (JSON.parse(r.stdout) as { bundle: { files: string[] } }).bundle.files;
    assert.ok(files.includes("~/.claude/CLAUDE.md"), files.join(", "));
    // The config dir's CLAUDE.md was read: its imports came along, the home's did not.
    assert.ok(files.includes("~/notes/cfg.md"), files.join(", "));
    assert.ok(files.includes("~/.claude/extra.md"), files.join(", "));
    assert.ok(files.includes("~/.claude/skills/cfg-only/SKILL.md"), files.join(", "));
    assert.ok(!files.includes("~/notes/home.md"), files.join(", "));
    assert.ok(!files.some((f) => f.startsWith("~/.claude/skills/live/")), "the home's .claude skills are not read");
  });

  it("records each server's name, scope, transport and command or URL, with the keys of its env and headers and never their values", () => {
    const proj = join(root, "proj-mcp");
    const cfg = join(root, "config-mcp");
    mkdirSync(proj, { recursive: true });
    // Claude Code keys a project by its path; on Windows with forward slashes.
    const projectKey = process.platform === "win32" ? proj.replace(/\\/g, "/") : proj;
    put(
      join(cfg, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "https://user:pw-value@mcp.example.test/v1?token=query-value#frag", headers: { Authorization: "Bearer header-value", "X-Team": "t" } },
          shadowed: { command: "user-scope" },
        },
        projects: {
          [projectKey]: { mcpServers: { db: { command: "npx", args: ["-y", "db-mcp", "--password", "arg-value"], env: { DB_PASSWORD: "env-value" } } } },
          [join(root, "elsewhere")]: { mcpServers: { other: { command: "nope" } } },
        },
      }),
    );
    put(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "node", args: ["docs.js"] }, shadowed: { command: "project-scope" } } }));
    const r = run(proj, cfg, ["harness", "snapshot", "-a", "claude-code", "--dir", proj, "--name", "mcp", "--json"]);
    const want = [
      { name: "db", scope: "local", transport: "stdio", command: "npx", envKeys: ["DB_PASSWORD"] },
      { name: "docs", scope: "project", transport: "stdio", command: "node" },
      { name: "shadowed", scope: "project", transport: "stdio", command: "project-scope" },
      { name: "remote", scope: "user", transport: "http", url: "https://mcp.example.test/v1", headerKeys: ["Authorization", "X-Team"] },
    ];
    assert.deepEqual((JSON.parse(r.stdout) as { bundle: { mcpServers: unknown } }).bundle.mcpServers, want);
    assert.doesNotMatch(r.stdout, /-value/, "no env, header, argument, query or password value");

    const list = run(proj, cfg, ["harness", "list", "--json"]);
    const bundle = (JSON.parse(list.stdout) as { bundles: { name: string; mcpServers?: unknown }[] }).bundles.find((b) => b.name === "mcp");
    assert.deepEqual(bundle?.mcpServers, want);
    assert.doesNotMatch(list.stdout, /-value/);
    const text = run(proj, cfg, ["harness", "list"]);
    assert.match(text.stdout, /\bMCP\b/);
    assert.match(text.stdout, /mcp\s+claude-code\s+\d+\s+db, docs, shadowed, remote\b/);
    const ok = run(proj, cfg, ["harness", "snapshot", "-a", "claude-code", "--dir", proj, "--name", "mcp"]);
    assert.match(ok.stderr + ok.stdout, /4 MCP servers recorded \(db, docs, shadowed, remote\)/);
  });
});

describe("harness snapshot run twice, or from a folder that holds CLAUDE_CONFIG_DIR", () => {
  const run = (cwd: string, cfg: string, args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "harness", "snapshot", "-a", "claude-code", ...args], { env: { ...env, CLAUDE_CONFIG_DIR: cfg }, cwd, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  type Snap = { outcome: string; bundle: { id: string; files: string[]; createdAt: string } };
  const json = (cwd: string, cfg: string, name: string): Snap => JSON.parse(run(cwd, cfg, ["--name", name, "--json"]).stdout);

  it("records a file in the config dir once, as ~/.claude/…, with the id a run from another folder gets", () => {
    const dir = join(root, "holds-config");
    const cfg = join(dir, "cc");
    const elsewhere = join(root, "holds-nothing");
    mkdirSync(elsewhere, { recursive: true });
    put(join(cfg, "CLAUDE.md"), "user rules\n@notes.md\n@rules/style.md\n");
    put(join(cfg, "notes.md"), "notes\n");
    put(join(cfg, "rules", "style.md"), "style\n");
    const inside = json(dir, cfg, "inner");
    assert.deepEqual(inside.bundle.files, ["~/.claude/CLAUDE.md", "~/.claude/notes.md", "~/.claude/rules/style.md"]);
    const outside = json(elsewhere, cfg, "inner");
    assert.deepEqual(outside.bundle.files, inside.bundle.files);
    assert.equal(outside.bundle.id, inside.bundle.id);
  });

  it("says the bundle already exists when the same setup is snapshotted again, in text and --json", () => {
    const dir = join(root, "twice");
    const cfg = join(root, "twice-config");
    mkdirSync(cfg, { recursive: true });
    put(join(dir, "CLAUDE.md"), "twice\n");
    const first = json(dir, cfg, "twice");
    const second = json(dir, cfg, "twice");
    assert.deepEqual([first.outcome, second.outcome], ["created", "unchanged"]);
    assert.equal(second.bundle.id, first.bundle.id);
    assert.equal(second.bundle.createdAt, first.bundle.createdAt, "it keeps the time it was first stored");
    const text = run(dir, cfg, ["--name", "twice"]);
    assert.match(text.stderr + text.stdout, /twice already exists, unchanged: 1 file\b/);
    assert.ok(text.stdout.includes(first.bundle.id), text.stdout);
    put(join(dir, "CLAUDE.md"), "changed\n");
    const changed = run(dir, cfg, ["--name", "twice"]);
    assert.match(changed.stderr + changed.stdout, /twice: 1 file\b/);
    assert.doesNotMatch(changed.stderr + changed.stdout, /already exists/);
  });
});

describe("harness audit follows @imports", () => {
  it("counts a file a loaded CLAUDE.md imports as loaded, with its size in the load cost", async () => {
    const app = join(home, "import-app");
    put(join(app, "CLAUDE.md"), "@AGENTS.md\n");
    put(join(app, "AGENTS.md"), `# rules\n${"x".repeat(4000)}\n@docs/CLAUDE.md\n`);
    put(join(app, "docs", "CLAUDE.md"), "# deeper\n");
    const index = new MemoryIndexStore();
    const stats = { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 };
    await index.upsertSession({ id: "i1", agent: "claude-code", cwd: app, startedAt: Date.now() - 60_000, stats } as Session);
    await index.upsertSession({ id: "i2", agent: "claude-code", cwd: app, startedAt: Date.now() - 30_000, stats } as Session);
    const a = await memoryAudit(index, { env });
    const row = (p: string) => a.files.find((f) => f.path === p);
    const agents = row("~/import-app/AGENTS.md");
    assert.ok(agents, a.files.map((f) => f.path).join(", "));
    assert.equal(agents.loaded, 2);
    assert.deepEqual(agents.flags, []);
    assert.ok((agents.loadTokens ?? 0) >= 2000, `load tokens ${agents.loadTokens}`);
    // An import of an import loads too.
    assert.equal(row("~/import-app/docs/CLAUDE.md")?.loaded, 2);
    assert.ok(a.totals.loadTokens >= (agents.loadTokens ?? 0) + (row("~/import-app/CLAUDE.md")?.loadTokens ?? 0));
    assert.equal(a.totals.neverRead, 0);
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
