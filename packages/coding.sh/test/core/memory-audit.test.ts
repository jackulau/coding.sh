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
import { MEMORY_EVENT_KINDS, MEMORY_INPUT_KEYS, MEMORY_PAYLOAD_KEYS, memoryEventOf, type MemoryEvent } from "../../src/core/memory-events.ts";
import { listMemoryFiles, memoryAudit, memoryEventsOf, memoryUseFolded } from "../../src/core/memory-files.ts";
import { foldMemoryUse, memoryUseOf, memoryUseOfEvents, memoryUseState } from "../../src/core/memory-use.ts";
import { REFOLD_CURSOR } from "../../src/core/ingest.ts";
import { buildSession, foldStamp } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import type { AgentEvent, MemoryUse, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
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

  it("a file added after every session started is not flagged never-read; one added before them is", () => {
    const sessions = [session("s1", [], { startedAt: 10 }), session("s2", [], { startedAt: 50 })];
    const late = "~/app/.claude/skills/demo/SKILL.md";
    const early = "~/app/.claude/rules/tests.md";
    const a = auditMemory(sessions, [file(late, 400, { since: 100 }), file(early, 400, { since: 20, scoped: true })], { home: HOME });
    assert.deepEqual(row(a, late).flags, []);
    assert.equal(row(a, late).loaded, 0);
    assert.deepEqual(row(a, early).flags, ["never-read"], "s2 started after it was added and did not read it");
    assert.equal(a.totals.neverRead, 1);
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

  it("a skill committed after a session started was not loaded at that session's start", async () => {
    const repo = join(home, "repo");
    mkdirSync(join(repo, ".claude", "skills", "demo"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nsteps\n");
    const added = Date.UTC(2026, 10, 5) / 1000;
    const git = (...a: string[]) =>
      assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: `${added} +0000`, GIT_COMMITTER_DATE: `${added} +0000` } }).status, 0, a.join(" "));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "add the skill");
    const index = new MemoryIndexStore();
    const s = (id: string, startedAt: number): Session => ({ id, agent: "claude-code", cwd: repo, repo: { root: repo }, startedAt, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }) as Session;
    await index.upsertSession(s("before", added * 1000 - 86400_000));
    await index.upsertSession(s("after", added * 1000 + 86400_000));
    const a = await memoryAudit(index, { env });
    const demo = a.files.find((f) => f.path.endsWith("/repo/.claude/skills/demo/SKILL.md"));
    assert.ok(demo, a.files.map((f) => f.path).join(", "));
    assert.equal(demo.loaded, 1, "only the session that started after the commit");
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

describe("harness audit: the narrow read (IndexStore.memoryEvents)", () => {
  const APP = "/home/me/app";
  const MEM = "/home/me/.claude/projects/-home-me-app/memory";
  let root = "";
  let real: AgentEvent[] = [];
  let all: AgentEvent[] = [];
  let sessions: Session[] = [];
  const stores: IndexStore[] = [];

  // Every field the audit reads, on events it uses and on events it has no use for.
  const synthetic = (): AgentEvent[] => {
    let i = 0;
    const e = (sessionId: string, kind: string, payload: Record<string, unknown>, ts?: number): AgentEvent => {
      i++;
      return { id: `syn-${i}`, v: 0, sessionId, agent: "claude-code", kind: kind as AgentEvent["kind"], ts: ts ?? 5000 + i, payload };
    };
    const tool = (sessionId: string, name: unknown, input: unknown, more: Record<string, unknown> = {}) => e(sessionId, "tool.start", { tool: name, input, callId: `c${i}`, ...more });
    const loaded = (sessionId: string, payload: Record<string, unknown>) => e(sessionId, "notification", { kind: "harness.loaded", hook: "InstructionsLoaded", ...payload });
    return [
      tool("x1", "Read", { file_path: `${APP}/CLAUDE.md`, offset: 3, limit: 5 }),
      tool("x1", "Edit", { file_path: ".claude/rules/tests.md", old_string: "aaa", new_string: "bbb" }),
      tool("x1", "Write", { filePath: `${APP}/src/a.ts`, content: "see CLAUDE.md" }),
      tool("x1", "view", { path: `${MEM}/deploy.md` }),
      tool("x1", "str_replace_editor", { absolute_path: `${MEM}/notes.md`, command: "str_replace" }),
      tool("x1", "edit_file", { target_file: `${APP}/AGENTS.md` }),
      tool("x1", "NotebookRead", { notebook_path: `${APP}/nb.ipynb`, note: "not CLAUDE.md" }),
      tool("x1", "Read", { file_path: null, path: `${APP}/GEMINI.md` }, { wrapper: null }),
      tool("x1", "Bash", { command: `cat ${MEM}/deploy.md`, description: "read the deploy notes" }),
      tool("x1", "shell", { cmd: ["cat", "AGENTS.override.md"] }),
      tool("x1", "exec", { script: `echo x > ${MEM}/new.md` }),
      tool("x1", "run", { commandLine: "sed -i s/a/b/ .claude/rules/style.md" }),
      tool("x1", "shell", `tee ${MEM}/teed.md`),
      tool("x1", "REPL", { code: `bash("cat ${MEM}/cell.md")` }),
      tool("x1", "Bash", { command: `cat ${MEM}/wrapped.md` }, { wrapper: true }),
      tool("x1", "Skill", { skill: "pdf" }),
      tool("x1", "skill", { name: "greet", args: "x" }),
      tool("x1", "SKILL", { command: "tools:pdf" }),
      tool("x1", "Skill", "pdf"),
      tool("x1", "Bash", ["cat CLAUDE.md"]),
      tool("x1", undefined, { command: "cat CLAUDE.local.md" }),
      // No use to the audit: nothing names a memory or instruction file.
      tool("x1", "Bash", { command: "ls -la" }),
      tool("x1", "Read", { path: "notes.txt" }),
      tool("x1", "Bash", null),
      e("x1", "tool.end", { tool: "Read", output: `${APP}/CLAUDE.md` }),
      e("x1", "message.assistant", { text: "I read CLAUDE.md" }),
      e("x1", "notification", { kind: "permission", message: "harness.loaded CLAUDE.md" }),
      e("x1", "file.change", { path: "src/a.ts", op: "modify" }),
      e("x1", "file.change", { path: `${APP}/CLAUDE.md`, op: "modify", additions: 3 }),
      e("x1", "file.change", { path: "old.txt", movedTo: ".claude/rules/moved.md", op: "rename" }),
      loaded("x1", { loadedBy: "nested_memory", paths: [`${APP}/pkg/CLAUDE.md`, `${APP}/pkg/deep/CLAUDE.md`] }),
      loaded("x1", { loadedBy: "dynamic_skill", dir: `${APP}/pkg/.claude/skills`, skills: ["lint"] }),
      loaded("x1", { loadedBy: "skill", sources: ["/home/me/.claude/skills/pdf"], skills: ["pdf"] }),
      loaded("x1", { loadedBy: "invoked_skills", skills: ["tools:greet"] }),
      // Two events at one time keep the order they were stored in.
      tool("x2", "Edit", { file_path: `${MEM}/tie.md` }, { ts: 0 }),
      e("x2", "file.change", { path: `${MEM}/tie.md` }, 9000),
      e("x2", "tool.start", { tool: "Read", input: { file_path: `${MEM}/tie.md` } }, 9000),
      e("x2", "tool.start", { tool: "Read", input: { file_path: `${MEM}/early.md` } }, 4000),
      e("x3", "message.user", { text: "nothing for the audit" }),
    ];
  };
  const files = [
    file("~/app/CLAUDE.md"),
    file("~/app/pkg/CLAUDE.md"),
    file("~/.claude/projects/-home-me-app/memory/deploy.md"),
    file("~/.claude/projects/-home-me-app/memory/unused.md"),
    file("~/.claude/skills/pdf/SKILL.md", 600, { loadBytes: 80 }),
    file("~/.claude/skills/greet/SKILL.md", 600, { loadBytes: 80 }),
    file("/work/demo/CLAUDE.md"),
    file("/work/demo/.claude/skills/greet/SKILL.md"),
    file("~/.claude/skills/hello/SKILL.md"),
  ];
  const memorySessions = (events: (id: string) => MemorySession["events"]): MemorySession[] => sessions.map((s) => ({ id: s.id, agent: s.agent, startedAt: s.startedAt, cwd: s.cwd!, events: events(s.id) }));

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-audit-narrow-")));
    mkdirSync(join(root, "home"));
    const env = tmpEnv();
    try {
      process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
      real = await collect(claudeCode.backfill!(testCtx().ctx));
    } finally {
      env.restore();
    }
    all = [...real, ...synthetic()];
    const ids = [...new Set(all.map((e) => e.sessionId))];
    sessions = ids.map((id, i) => ({ id, agent: "claude-code", cwd: /^x\d$/.test(id) ? APP : "/work/demo", startedAt: 100 + i, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] }));
    for (const store of [new MemoryIndexStore(), await SqliteIndexStore.open(join(root, "index.db"))]) {
      for (const s of sessions) await store.upsertSession(s);
      await store.putEvents(all);
      stores.push(store);
    }
  });
  after(async () => {
    for (const s of stores) await s.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("the fixtures hold events of every kind the audit reads, and the real capture", () => {
    assert.ok(real.some((e) => e.kind === "notification" && e.payload.kind === "harness.loaded"), "the real capture's loads");
    for (const kind of MEMORY_EVENT_KINDS) assert.ok(all.some((e) => e.kind === kind), kind);
    assert.equal(stores.length, 2);
    assert.ok(stores.every((s) => typeof s.memoryEvents === "function"), "both stores have the narrow read");
  });

  it("gives the events the audit can use, with only the fields it reads, in listEvents order", async () => {
    const ids = [...sessions.map((s) => s.id), "no-such-session"];
    for (const store of stores) {
      const name = store.constructor.name;
      const got = new Map<string, MemoryEvent[]>(ids.map((id) => [id, []]));
      for (const e of await store.memoryEvents!(ids)) got.get(e.sessionId)!.push(e);
      for (const id of ids) {
        const whole = await store.listEvents(id, { kinds: MEMORY_EVENT_KINDS });
        assert.deepEqual(got.get(id), whole.flatMap((e) => memoryEventOf(e) ?? []), `${name}: ${id}`);
      }
      const x1 = got.get("x1")!;
      assert.equal(x1.length, 27, `${name}: 21 tool calls, 2 file changes and 4 loads of x1; not ls, notes.txt, a null input, the other notification or src/a.ts`);
      assert.deepEqual(x1[1]!.payload, { tool: "Edit", input: { file_path: ".claude/rules/tests.md" } }, `${name}: an edit's text is left out`);
      assert.deepEqual(x1[2]!.payload, { tool: "Write", input: { filePath: `${APP}/src/a.ts` } }, `${name}: a file's content is left out`);
      assert.deepEqual(x1[7]!.payload, { tool: "Read", input: { path: `${APP}/GEMINI.md` } }, `${name}: a null is not a value`);
      assert.deepEqual(x1[12]!.payload, { tool: "shell", input: `tee ${MEM}/teed.md` }, `${name}: a bare command`);
      assert.deepEqual(x1[14]!.payload, { tool: "Bash", wrapper: true, input: { command: `cat ${MEM}/wrapped.md` } }, `${name}: wrapper stays a boolean`);
      assert.deepEqual(x1[19]!.payload, { tool: "Bash" }, `${name}: an input that is a list has nothing the audit reads`);
      assert.deepEqual(x1.at(-4)!.payload, { kind: "harness.loaded", loadedBy: "nested_memory", paths: [`${APP}/pkg/CLAUDE.md`, `${APP}/pkg/deep/CLAUDE.md`] }, name);
      assert.deepEqual(got.get("x2")!.map((e) => [e.ts, e.kind, (e.payload.input as { file_path?: string } | undefined)?.file_path ?? e.payload.path]), [[4000, "tool.start", `${MEM}/early.md`], [5035, "tool.start", `${MEM}/tie.md`], [9000, "file.change", `${MEM}/tie.md`], [9000, "tool.start", `${MEM}/tie.md`]], `${name}: by time, then as stored`);
      assert.deepEqual(got.get("x3"), [], name);
      assert.deepEqual(await store.memoryEvents!([]), [], name);
      assert.deepEqual((await store.memoryEvents!(["x2"])).map((e) => e.sessionId), ["x2", "x2", "x2", "x2"], `${name}: only the sessions asked for`);
    }
  });

  it("the audit over the narrow read equals the audit over whole events", async () => {
    const opts = { home: "/home/me" };
    const reports = [];
    for (const store of stores) {
      const name = store.constructor.name;
      const whole = new Map<string, AgentEvent[]>();
      for (const s of sessions) whole.set(s.id, await store.listEvents(s.id));
      const narrow = await memoryEventsOf(store, sessions.map((s) => s.id));
      const full = auditMemory(memorySessions((id) => whole.get(id)!), files, opts);
      assert.deepEqual(auditMemory(memorySessions((id) => narrow.get(id)!), files, opts), full, name);
      // The same again through a store with no narrow read: listEvents, one session at a time.
      const plain = Object.create(store) as IndexStore;
      plain.memoryEvents = undefined;
      const byList = await memoryEventsOf(plain, sessions.map((s) => s.id));
      assert.deepEqual([...byList], [...narrow], `${name}: the listEvents path gives the same events`);
      const env = { HOME: join(root, "home") };
      assert.deepEqual(await memoryAudit(store, { env }), await memoryAudit(plain, { env }), name);
      reports.push(full);
    }
    assert.deepEqual(reports[1], reports[0], "SQLite and memory stores agree");
    const a = reports[0]!;
    // The report is a real one: loads, reads and writes from both the synthetic sessions and the capture.
    const at = (p: string) => {
      const r = row(a, p);
      return { loaded: r.loaded, read: r.read, wrote: r.wrote };
    };
    assert.deepEqual(at("~/app/CLAUDE.md"), { loaded: 3, read: 1, wrote: 1 }, "x1, x2 and x3 ran in the app");
    assert.deepEqual(at("~/app/pkg/CLAUDE.md"), { loaded: 1, read: 0, wrote: 0 });
    assert.deepEqual(at("~/.claude/projects/-home-me-app/memory/deploy.md"), { loaded: 0, read: 1, wrote: 0 });
    assert.deepEqual(at("~/.claude/projects/-home-me-app/memory/cell.md"), { loaded: 0, read: 1, wrote: 0 });
    assert.deepEqual(at("~/.claude/projects/-home-me-app/memory/teed.md"), { loaded: 0, read: 0, wrote: 1 });
    assert.deepEqual(at("~/.claude/projects/-home-me-app/memory/tie.md"), { loaded: 0, read: 1, wrote: 1 });
    assert.deepEqual(at("~/app/.claude/rules/moved.md"), { loaded: 0, read: 0, wrote: 1 });
    assert.deepEqual(at("~/.claude/skills/pdf/SKILL.md"), { loaded: sessions.length, read: 1, wrote: 0 }, "a user skill is listed in every session");
    assert.equal(a.files.some((f) => f.path.endsWith("/wrapped.md")), false, "a wrapper's call is not the agent's");
    assert.equal(row(a, "/work/demo/.claude/skills/greet/SKILL.md").read, 2, "the capture's Skill call, and x1's invoked_skills load by name");
  });

  it("the audit reads no payload field the narrow read leaves out", () => {
    const seen = { payload: new Map<string, Set<string>>(), input: new Set<string>() };
    const spy = <T extends object>(o: T, keys: Set<string>): T => new Proxy(o, { get: (t, k, r) => (typeof k === "string" && keys.add(k), Reflect.get(t, k, r)) });
    const events = (id: string) =>
      all
        .filter((e) => e.sessionId === id)
        .map((e) => {
          const keys = seen.payload.get(e.kind) ?? seen.payload.set(e.kind, new Set()).get(e.kind)!;
          const input = e.payload.input;
          const payload = { ...e.payload };
          if (input && typeof input === "object" && !Array.isArray(input)) payload.input = spy(input, seen.input);
          return { kind: e.kind, ts: e.ts, payload: spy(payload, keys) };
        });
    auditMemory(memorySessions(events), files, { home: "/home/me" });
    for (const [kind, keys] of seen.payload) {
      const read = [...keys].filter((k) => k !== "input" && k !== "kind");
      assert.deepEqual(read.filter((k) => !(MEMORY_PAYLOAD_KEYS[kind] ?? []).includes(k)), [], `${kind}: fields the audit read that MEMORY_PAYLOAD_KEYS lacks`);
    }
    assert.ok(seen.payload.get("tool.start")!.has("input") && seen.payload.get("file.change")!.has("movedTo") && seen.payload.get("notification")!.has("sources"), "the audit did read the events");
    assert.deepEqual([...seen.input].filter((k) => !MEMORY_INPUT_KEYS.includes(k)), [], "input fields the audit read that MEMORY_INPUT_KEYS lacks");
    assert.deepEqual([...MEMORY_INPUT_KEYS].filter((k) => !seen.input.has(k)), [], "and every field in MEMORY_INPUT_KEYS is one it reads");
  });

  // EZ-6: the session fold keeps what the audit reads (stats.memoryUse), so the audit reads session rows.
  it("the audit over the sessions' stats.memoryUse equals the audit over whole events", async () => {
    const opts = { home: "/home/me" };
    for (const store of stores) {
      const name = store.constructor.name;
      const whole = new Map<string, AgentEvent[]>();
      for (const s of sessions) whole.set(s.id, await store.listEvents(s.id));
      // The rows as ingest writes them: folded from the stored events (the synthetic ones carry no cwd: the row's stands).
      const folded = sessions.map((s) => buildSession(whole.get(s.id)!, s));
      const list = (from: (s: Session) => Partial<MemorySession>): MemorySession[] => folded.map((s) => ({ id: s.id, agent: s.agent, startedAt: s.startedAt, cwd: s.cwd!, events: [], ...from(s) }));
      const full = auditMemory(list((s) => ({ events: whole.get(s.id)! })), files, opts);
      assert.deepEqual(auditMemory(list((s) => ({ uses: s.stats.memoryUse ?? [] })), files, opts), full, name);
      assert.ok(full.files.some((f) => f.read > 0) && full.files.some((f) => f.wrote > 0) && full.files.some((f) => f.loaded > f.loadedAtStart), `${name}: a real report`);
      const x1 = folded.find((s) => s.id === "x1")!.stats.memoryUse!;
      assert.ok(x1.every((u) => (u.path !== undefined) !== (u.skill !== undefined)), "a path or a skill name");
      assert.ok(x1.every((u) => u.path === undefined || (/^\/home\/me\//.test(u.path) && memoryKind(u.path))), "only memory and instruction files, resolved against the session's directory");
      assert.deepEqual(x1.filter((u) => u.skill).map((u) => [u.skill, u.by]), [["greet", "tool"], ["pdf", "tool"], ["greet", "harness"]], "pdf, greet, then tools:pdf: a skill named twice is kept where it was last named");
      assert.equal(folded.find((s) => s.id === "x3")!.stats.memoryUse, undefined, "absent when the events name none");
    }
  });

  it("memoryAudit reads the session rows once the store is folded by this build, and no events", async () => {
    const env = { HOME: join(root, "home") };
    for (const store of [new MemoryIndexStore(), await SqliteIndexStore.open(join(root, "folded.db"))]) {
      const name = store.constructor.name;
      try {
        await store.putEvents(all);
        for (const s of sessions) await store.upsertSession(buildSession(await store.listEvents(s.id), s));
        assert.equal(await memoryUseFolded(store), false, `${name}: a store whose rows may predate the fold`);
        const fromEvents = await memoryAudit(store, { env });
        await store.setCursor(REFOLD_CURSOR, foldStamp());
        const rowsOnly = Object.create(store) as IndexStore;
        rowsOnly.listEvents = () => Promise.reject(new Error("read the events"));
        rowsOnly.memoryEvents = () => Promise.reject(new Error("read the events"));
        assert.deepEqual(await memoryAudit(rowsOnly, { env }), fromEvents, name);
        assert.ok(fromEvents.totals.sessionsReading > 0 && fromEvents.totals.sessionsWriting > 0, name);
        // Rows another fold wrote are not trusted.
        await store.setCursor(REFOLD_CURSOR, foldStamp() + 1);
        await assert.rejects(memoryAudit(rowsOnly, { env }), /read the events/, name);
      } finally {
        await store.close?.();
      }
    }
  });
});

describe("stats.memoryUse: what the fold keeps of a session's events", () => {
  const MEM = "/home/me/.claude/projects/-home-me-app/memory";
  let i = 0;
  const e = (kind: string, payload: Record<string, unknown>, ts: number): AgentEvent => ({ id: `mu-${++i}`, v: 0, sessionId: "s", agent: "claude-code", kind: kind as AgentEvent["kind"], ts, payload });
  const tool = (name: string, input: unknown, ts: number) => e("tool.start", { tool: name, input }, ts);
  const fold = (events: AgentEvent[], cwd: (i: number) => string | undefined, final: string | undefined): MemoryUse[] | undefined => {
    const s = memoryUseState();
    events.forEach((ev, n) => foldMemoryUse(s, ev, cwd(n)));
    return memoryUseOf(s, final);
  };

  it("one entry per use of a file, at its first place with its last time; files that are no memory are left out", () => {
    const events = [
      tool("Read", { file_path: `${MEM}/a.md` }, 10),
      tool("Write", { file_path: "/home/me/app/docs/guide.md", content: "x" }, 11),
      tool("Edit", { file_path: `${MEM}/a.md` }, 12),
      tool("Bash", { command: `cat ${MEM}/b.md ${MEM}/a.md` }, 13),
      tool("Read", { file_path: "/home/me/app/src/a.ts" }, 14),
      e("file.change", { path: `${MEM}/a.md` }, 15),
      tool("Read", { file_path: "/home/me/app/CLAUDE.md/" }, 16),
    ];
    assert.deepEqual(memoryUseOfEvents(events, "/home/me/app"), [
      { use: "read", path: `${MEM}/a.md`, ts: 13 },
      { use: "wrote", path: `${MEM}/a.md`, ts: 15 },
      { use: "read", path: `${MEM}/b.md`, ts: 13 },
      { use: "read", path: "/home/me/app/CLAUDE.md/", ts: 16 },
    ]);
    assert.equal(memoryUseOfEvents([tool("Read", { file_path: "/home/me/app/src/a.ts" }, 1), e("user.message", { text: "CLAUDE.md" }, 2)], "/home/me/app"), undefined);
  });

  it("a relative path waits for the session's directory, and joins the same file named in full", () => {
    const events = [tool("Read", { file_path: "CLAUDE.md" }, 1), tool("Read", { file_path: "notes.md" }, 2), tool("Read", { file_path: "/home/me/app/CLAUDE.md" }, 3), tool("Edit", { file_path: ".claude/rules/x.md" }, 4)];
    const want = [
      { use: "read", path: "/home/me/app/CLAUDE.md", ts: 3 },
      { use: "wrote", path: "/home/me/app/.claude/rules/x.md", ts: 4 },
    ];
    // The directory known from the third event on, from the start, and only when the session is built (a previous row's).
    assert.deepEqual(fold(events, (n) => (n >= 2 ? "/home/me/app" : undefined), "/home/me/app"), want);
    assert.deepEqual(fold(events, () => "/home/me/app", "/home/me/app"), want);
    assert.deepEqual(fold(events, () => undefined, "/home/me/app"), want);
    assert.deepEqual(fold(events, () => undefined, undefined), [{ use: "read", path: "/home/me/app/CLAUDE.md", ts: 3 }], "no directory: only paths written in full");
    // In a memory directory, any .md is a memory file.
    assert.deepEqual(fold([tool("Read", { file_path: "notes.md" }, 2)], () => undefined, MEM), [{ use: "read", path: `${MEM}/notes.md`, ts: 2 }]);
  });

  it("the state survives the fold's save and is the same shape as a fresh one", () => {
    const s = memoryUseState();
    foldMemoryUse(s, tool("Read", { file_path: `${MEM}/a.md` }, 10), "/home/me/app");
    foldMemoryUse(s, tool("Skill", { skill: "tools:pdf" }, 11), "/home/me/app");
    const back = JSON.parse(JSON.stringify(s)) as typeof s;
    foldMemoryUse(back, tool("Read", { file_path: `${MEM}/a.md` }, 12), "/home/me/app");
    assert.deepEqual(memoryUseOf(back, "/home/me/app"), [
      { use: "read", path: `${MEM}/a.md`, ts: 12 },
      { use: "read", skill: "pdf", by: "tool", ts: 11 },
    ]);
  });
});
