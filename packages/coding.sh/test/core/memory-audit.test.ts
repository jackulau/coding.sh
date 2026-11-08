// harness audit (TB-1): which memory and instruction files sessions loaded,
// read and wrote. Synthetic sessions for the flags, the real Claude Code
// capture for loads (nested_memory, dynamic_skill, skill) and reads, and a
// temp store and HOME for the CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { auditMemory, claudeProjectSlug, homeKey, memoryKind, shellPaths, skillListingBytes, type MemoryFileInfo, type MemorySession } from "../../src/core/memory-audit.ts";
import { listMemoryFiles, memoryAudit } from "../../src/core/memory-files.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { pathOf } from "../_bin.ts";
import { FIXTURES, collect, testCtx, tmpEnv } from "../adapters/_helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const HOME = "/home/me";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown>, ts = ++n): Pick<AgentEvent, "kind" | "ts" | "payload"> => ({ kind: kind as AgentEvent["kind"], ts, payload });
const read = (path: string) => ev("tool.start", { tool: "Read", input: { file_path: path } });
const bash = (command: string) => ev("tool.start", { tool: "Bash", input: { command } });
const edit = (path: string) => ev("tool.start", { tool: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } });
const session = (id: string, events: MemorySession["events"], over: Partial<MemorySession> = {}): MemorySession => ({ id, agent: "claude-code", cwd: "/home/me/app", startedAt: 1, events, ...over });
const file = (key: string, bytes = 400, over: Partial<MemoryFileInfo> = {}): MemoryFileInfo => ({ key, bytes, ...over });
const row = (a: ReturnType<typeof auditMemory>, path: string) => {
  const r = a.files.find((f) => f.path === path);
  assert.ok(r, `no row for ${path}: ${a.files.map((f) => f.path).join(", ")}`);
  return r;
};

describe("memory audit: helpers", () => {
  it("kinds", () => {
    assert.equal(memoryKind("~/.claude/projects/-home-me-app/memory/MEMORY.md"), "memory");
    assert.equal(memoryKind("/repo/sub/CLAUDE.md"), "context");
    assert.equal(memoryKind("/repo/AGENTS.md"), "context");
    assert.equal(memoryKind("/repo/.claude/rules/tests.md"), "rule");
    assert.equal(memoryKind("~/.claude/skills/pdf/SKILL.md"), "skill");
    assert.equal(memoryKind("/repo/README.md"), undefined);
    assert.equal(memoryKind("/repo/.claude/skills/pdf/scripts/a.py"), undefined);
  });

  it("keys paths under any home as ~/", () => {
    assert.equal(homeKey("/Users/ann/.claude/CLAUDE.md"), "~/.claude/CLAUDE.md");
    assert.equal(homeKey("/home/user/x/AGENTS.md"), "~/x/AGENTS.md");
    assert.equal(homeKey("C:\\Users\\ann\\repo\\CLAUDE.md"), "~/repo/CLAUDE.md");
    assert.equal(homeKey("/tmp/h/a/CLAUDE.md", "/tmp/h"), "~/a/CLAUDE.md");
    assert.equal(homeKey("/work/demo/CLAUDE.md"), "/work/demo/CLAUDE.md");
    assert.equal(claudeProjectSlug("/Users/ann/my.app"), "-Users-ann-my-app");
  });

  it("shell reads and writes", () => {
    assert.deepEqual(shellPaths("cat a.md && head -n 5 b.md | grep x"), { reads: ["a.md", "b.md"], writes: [] });
    assert.deepEqual(shellPaths("sed -i 's/a/b/' m.md"), { reads: [], writes: ["m.md"] });
    assert.deepEqual(shellPaths("echo hi >> notes/m.md; cat x.md > y.md"), { reads: ["x.md"], writes: ["notes/m.md", "y.md"] });
    assert.deepEqual(shellPaths("cat <<'EOF' > m.md\nbody\nEOF"), { reads: [], writes: ["m.md"] });
  });
});

describe("memory audit: synthetic sessions", () => {
  const MEM = "~/.claude/projects/-home-me-app/memory";
  const files = [
    file(`${MEM}/MEMORY.md`, 800),
    file(`${MEM}/deploy.md`, 1200),
    file(`${MEM}/stale.md`, 200),
    file(`${MEM}/notes.md`, 300),
    file("~/app/CLAUDE.md", 4000),
    file("~/app/.claude/rules/tests.md", 100, { scoped: true }),
    file("~/.claude/skills/pdf/SKILL.md", 600, { loadBytes: 80 }),
  ];
  const a = auditMemory(
    [
      // Writes notes.md, then reads deploy.md with cat.
      session("s1", [edit(`${HOME}/.claude/projects/-home-me-app/memory/notes.md`), bash(`cat ${HOME}/.claude/projects/-home-me-app/memory/deploy.md`)]),
      // Reads notes.md back in its own session only; writes a new file with a heredoc.
      session("s2", [read(`${HOME}/.claude/projects/-home-me-app/memory/notes.md`), edit(`${HOME}/.claude/projects/-home-me-app/memory/notes.md`), bash(`cat > ${HOME}/.claude/projects/-home-me-app/memory/new.md <<'EOF'\nx\nEOF`)]),
      // A session elsewhere: none of the app's files load.
      session("s3", [], { cwd: "/srv/other" }),
      // Codex in the app: CLAUDE.md is not its file.
      session("s4", [], { agent: "codex" }),
    ],
    files,
    { home: HOME },
  );

  it("counts sessions that loaded, read and wrote each file", () => {
    assert.equal(a.sessions, 4);
    const claude = row(a, "~/app/CLAUDE.md");
    assert.deepEqual([claude.loaded, claude.loadedAtStart, claude.read, claude.wrote], [2, 2, 0, 0]);
    assert.equal(claude.tokens, 1000);
    assert.equal(claude.loadTokens, 2000);
    assert.deepEqual(claude.flags, []);
    const index = row(a, `${MEM}/MEMORY.md`);
    assert.equal(index.loaded, 2, "the project's MEMORY.md loads at start");
    const deploy = row(a, `${MEM}/deploy.md`);
    assert.deepEqual([deploy.loaded, deploy.read, deploy.wrote], [0, 1, 0]);
    assert.equal(deploy.lastRead, 2);
  });

  it("a skill's load costs its name and description, not the whole file", () => {
    const pdf = row(a, "~/.claude/skills/pdf/SKILL.md");
    assert.deepEqual([pdf.loaded, pdf.tokens, pdf.loadTokens], [3, 150, 60]);
    assert.equal(skillListingBytes("---\nname: pdf\ndescription: Fill PDF forms\n---\nbody"), "pdf: Fill PDF forms".length);
    assert.equal(skillListingBytes("no frontmatter"), undefined);
  });

  it("flags never-read and write-only files", () => {
    assert.deepEqual(row(a, `${MEM}/stale.md`).flags, ["never-read"]);
    // notes.md: written by s1 and s2; s2 read it, but s2 wrote it too.
    assert.deepEqual(row(a, `${MEM}/notes.md`).flags, ["write-only"]);
    const created = row(a, `${MEM}/new.md`);
    assert.equal(created.exists, false);
    assert.deepEqual(created.flags, ["write-only"]);
    assert.deepEqual(row(a, "~/app/.claude/rules/tests.md").flags, ["never-read"], "a path-scoped rule does not load at start");
    assert.deepEqual(row(a, "~/.claude/skills/pdf/SKILL.md").flags, ["loaded-not-read"]);
    assert.equal(a.totals.neverRead, 2);
    assert.equal(a.totals.writeOnly, 2);
    assert.equal(a.totals.loadedNotRead, 1);
    assert.equal(a.totals.sessionsWriting, 2);
    assert.equal(a.totals.sessionsReading, 2);
  });

  it("a read in a session that did not write it clears write-only", () => {
    const b = auditMemory([session("w", [edit(`${HOME}/.claude/projects/-home-me-app/memory/notes.md`)]), session("r", [bash(`head ${HOME}/.claude/projects/-home-me-app/memory/notes.md`)])], [file(`${MEM}/notes.md`)], { home: HOME });
    assert.deepEqual(row(b, `${MEM}/notes.md`).flags, []);
  });

  it("a subagent counts as its root session, with its own directory", () => {
    const b = auditMemory(
      [session("root", []), session("sub", [read("notes/CLAUDE.md")], { rootId: "root", cwd: "/home/me/wt" })],
      [file("~/app/CLAUDE.md"), file("~/wt/CLAUDE.md"), file("~/wt/notes/CLAUDE.md")],
      { home: HOME },
    );
    assert.equal(b.sessions, 1);
    assert.equal(row(b, "~/app/CLAUDE.md").loaded, 1);
    assert.equal(row(b, "~/wt/CLAUDE.md").loaded, 1, "the subagent's worktree CLAUDE.md");
    assert.equal(row(b, "~/wt/notes/CLAUDE.md").read, 1, "a relative path resolves against the subagent's cwd");
    assert.equal(b.totals.sessionsLoading, 1);
  });

  it("Codex loads AGENTS.md from the repo root down to its cwd", () => {
    const b = auditMemory([session("c", [], { agent: "codex", cwd: "/home/me/repo/pkg", repoRoot: "/home/me/repo" })], [file("~/repo/AGENTS.md"), file("~/repo/pkg/AGENTS.md"), file("~/AGENTS.md"), file("~/.codex/AGENTS.md")], { home: HOME });
    assert.equal(row(b, "~/repo/AGENTS.md").loaded, 1);
    assert.equal(row(b, "~/repo/pkg/AGENTS.md").loaded, 1);
    assert.equal(row(b, "~/.codex/AGENTS.md").loaded, 1);
    assert.deepEqual(row(b, "~/AGENTS.md").flags, ["never-read"], "above the repo root");
  });

  it("is empty when there are no memory files", () => {
    const b = auditMemory([session("x", [read("/home/me/app/src/a.ts"), bash("cat README.md")])], [], { home: HOME });
    assert.deepEqual(b.files, []);
    assert.deepEqual(b.totals, { files: 0, bytes: 0, loadTokens: 0, sessionsLoading: 0, sessionsReading: 0, sessionsWriting: 0, neverRead: 0, writeOnly: 0, loadedNotRead: 0 });
  });
});

describe("memory audit: a real Claude Code capture", () => {
  // scripts/e2e/claude-transcript-capture.mjs: Claude Code in /work/demo, HOME /home/user.
  let events: AgentEvent[] = [];
  before(async () => {
    const env = tmpEnv();
    try {
      process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
      events = await collect(claudeCode.backfill!(testCtx().ctx));
    } finally {
      env.restore();
    }
  });

  it("counts the nested CLAUDE.md load, the skill loads and the SKILL.md read", () => {
    const s: MemorySession = { id: "real", agent: "claude-code", cwd: "/work/demo", startedAt: 0, events };
    const files = [
      file("/work/demo/CLAUDE.md"),
      file("/work/demo/sub/CLAUDE.md"),
      file("/work/demo/.claude/skills/greet/SKILL.md"),
      file("/work/demo/sub/.claude/skills/subskill/SKILL.md"),
      file("~/.claude/skills/hello/SKILL.md"),
      file("~/.claude/projects/-work-demo/memory/MEMORY.md"),
      file("~/.claude/projects/-work-demo/memory/unused.md"),
    ];
    const a = auditMemory([s], files, { home: "/somewhere/else" });
    const at = (p: string) => {
      const r = row(a, p);
      return { loaded: r.loaded, atStart: r.loadedAtStart, read: r.read, wrote: r.wrote, flags: r.flags };
    };
    assert.deepEqual(at("/work/demo/sub/CLAUDE.md"), { loaded: 1, atStart: 0, read: 0, wrote: 0, flags: [] }, "nested_memory");
    assert.deepEqual(at("/work/demo/CLAUDE.md"), { loaded: 1, atStart: 1, read: 0, wrote: 0, flags: [] });
    assert.deepEqual(at("/work/demo/.claude/skills/greet/SKILL.md"), { loaded: 1, atStart: 1, read: 1, wrote: 0, flags: [] }, "the Skill call");
    assert.deepEqual(at("/work/demo/sub/.claude/skills/subskill/SKILL.md"), { loaded: 1, atStart: 0, read: 0, wrote: 0, flags: ["loaded-not-read"] }, "dynamic_skill");
    assert.deepEqual(at("~/.claude/skills/hello/SKILL.md"), { loaded: 1, atStart: 1, read: 1, wrote: 0, flags: [] }, "Read of /home/user/.claude/skills/hello/SKILL.md");
    assert.deepEqual(at("~/.claude/projects/-work-demo/memory/MEMORY.md"), { loaded: 1, atStart: 1, read: 0, wrote: 0, flags: [] });
    assert.deepEqual(at("~/.claude/projects/-work-demo/memory/unused.md").flags, ["never-read"]);
    assert.equal(a.totals.sessionsWriting, 0);
  });
});

describe("harness audit over a store and a temp HOME", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-audit-")));
    home = join(root, "home");
    const mem = join(home, ".claude", "projects", claudeProjectSlug(join(home, "app")), "memory");
    mkdirSync(mem, { recursive: true });
    mkdirSync(join(home, "app", "pkg", "deep"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "pdf"), { recursive: true });
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(mem, "MEMORY.md"), "- [deploy](deploy.md)\n");
    writeFileSync(join(mem, "deploy.md"), "deploy with make ship\n");
    writeFileSync(join(mem, "stale.md"), "x".repeat(4000));
    writeFileSync(join(home, "app", "CLAUDE.md"), "# app\n");
    writeFileSync(join(home, "app", "pkg", "deep", "CLAUDE.md"), "# deep\n");
    writeFileSync(join(home, "app", "README.md"), "not memory\n");
    writeFileSync(join(home, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Fill PDF forms\n---\n" + "step\n".repeat(200));
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

  it("lists memory files on disk, nested CLAUDE.md included, nothing else", () => {
    const keys = listMemoryFiles({ home, claudeDir: join(home, ".claude"), codexDir: join(home, ".codex") }, [join(home, "app")])
      .map((f) => f.key)
      .sort();
    const slug = claudeProjectSlug(join(home, "app"));
    const pdf = listMemoryFiles({ home, claudeDir: join(home, ".claude"), codexDir: join(home, ".codex") }, []).find((f) => f.key === "~/.claude/skills/pdf/SKILL.md");
    assert.deepEqual(pdf, { key: "~/.claude/skills/pdf/SKILL.md", bytes: 1046, loadBytes: 19 }, "a skill loads its listing");
    assert.deepEqual(keys, ["~/.claude/projects/" + slug + "/memory/MEMORY.md", `~/.claude/projects/${slug}/memory/deploy.md`, `~/.claude/projects/${slug}/memory/stale.md`, "~/.claude/skills/pdf/SKILL.md", "~/app/CLAUDE.md", "~/app/pkg/deep/CLAUDE.md"].sort());
  });

  it("skips a path it can't stat (a symlink loop here, an unreadable junction on Windows) instead of failing", (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
    const root = mkdtempSync(join(tmpdir(), "cs-memloop-"));
    try {
      mkdirSync(join(root, "app", "pkg"), { recursive: true });
      writeFileSync(join(root, "app", "pkg", "CLAUDE.md"), "# pkg\n");
      symlinkSync(join(root, "app", "b"), join(root, "app", "a"));
      symlinkSync(join(root, "app", "a"), join(root, "app", "b"));
      const keys = listMemoryFiles({ home: root, claudeDir: join(root, ".claude"), codexDir: join(root, ".codex") }, [join(root, "app")]).map((f) => f.key);
      assert.deepEqual(keys, ["~/app/pkg/CLAUDE.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits stored sessions (subagents folded into their root) since a time", async () => {
    const index = new MemoryIndexStore();
    const slug = claudeProjectSlug(join(home, "app"));
    const s = (id: string, startedAt: number, parent?: string, cwd = join(home, "app")): Session => ({ id, agent: "claude-code", cwd, startedAt, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, ...(parent ? { parent: { sessionId: parent } } : {}) }) as Session;
    const e = (sessionId: string, i: number, payload: Record<string, unknown>): AgentEvent => ({ id: `${sessionId}-${i}`, sessionId, agent: "claude-code", kind: "tool.start", ts: 1000 + i, payload, schemaVersion: 1, source: "test" }) as unknown as AgentEvent;
    await index.upsertSession(s("old", 1));
    await index.upsertSession(s("root", 2000));
    await index.upsertSession(s("child", 2001, "root", join(home, "app", "pkg", "deep")));
    await index.putEvents([e("old", 1, { tool: "Read", input: { file_path: join(home, ".claude", "projects", slug, "memory", "stale.md") } }), e("child", 2, { tool: "Read", input: { file_path: join(home, ".claude", "projects", slug, "memory", "deploy.md") } })]);
    const a = await memoryAudit(index, { since: 1500, env });
    assert.equal(a.sessions, 1, "the child counts as its root; the old session is out of the window");
    const deploy = a.files.find((f) => f.path.endsWith("/memory/deploy.md"))!;
    assert.equal(deploy.read, 1);
    assert.deepEqual(a.files.find((f) => f.path.endsWith("/memory/stale.md"))!.flags, ["never-read"]);
    assert.equal(a.files.find((f) => f.path === "~/app/pkg/deep/CLAUDE.md")!.loaded, 1, "the child ran in pkg/deep");
    assert.equal(a.files.find((f) => f.path === "~/app/CLAUDE.md")!.loaded, 1, "root and child are one session");
  });

  it("coding.sh harness audit prints the table and --json the report", () => {
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 60_000 });
    const empty = cli(["harness", "audit", "--json"]);
    assert.equal(empty.status, 0, empty.stderr);
    const doc = JSON.parse(empty.stdout) as { sessions: number; files: { path: string; flags: string[] }[] };
    assert.equal(doc.sessions, 0);
    // No sessions: the user-dir files are still listed, never read.
    assert.ok(doc.files.some((f) => f.path.endsWith("/memory/stale.md") && f.flags.includes("never-read")));
    const text = cli(["harness", "audit"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /stale\.md/);
    assert.match(text.stdout + text.stderr, /never read/);
    assert.match(cli(["harness", "audit", "--since", "nope"]).stderr, /--since/);
  });
});
