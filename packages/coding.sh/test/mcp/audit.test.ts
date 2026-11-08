// The MCP harness_audit tool over real stdio: the audit of a temp HOME's memory
// files and skills and a temp repo's CLAUDE.md against seeded sessions, the
// refine run command it hands back instead of running, and check: true on the
// repo's uncommitted edits. Made up from scratch: no real sessions or configs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeProjectSlug } from "../../src/core/memory-audit.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";
import { RawClient } from "./helpers.ts";

const SAFE = "Never push to main without asking the user first.";
let root = "";
let home = "";
let repo = "";
let mem = "";
let env: Record<string, string> = {};
let c: RawClient;
let schema: Record<string, unknown> = {};

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-mcp-audit-")));
  home = join(root, "home");
  repo = join(home, "app");
  mem = join(home, ".claude", "projects", claudeProjectSlug(repo), "memory");
  mkdirSync(mem, { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "pdf"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), "- [deploy](deploy.md)\n");
  writeFileSync(join(mem, "deploy.md"), "deploy with make ship\n");
  writeFileSync(join(mem, "stale.md"), "x".repeat(4000));
  writeFileSync(join(home, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Fill PDF forms\n---\n" + "step\n".repeat(200));
  writeFileSync(join(repo, "CLAUDE.md"), `# app\n\n${SAFE}\nKeep answers short.\n`);
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig-none"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    // Two sessions in the repo: one reads deploy.md, neither reads stale.md or invokes the pdf skill.
    await putSession(ctx.index, sessionEvents("s1", { cwd: repo, startedAt: now - 2 * 86_400_000 }, [["user.message", { text: "how do I deploy?" }], ["tool.start", { tool: "Read", toolUseId: "r1", input: { file_path: join(mem, "deploy.md") } }], ["assistant.message", { text: "make ship" }]]));
    await putSession(ctx.index, sessionEvents("s2", { cwd: repo, startedAt: now - 86_400_000 }, [["user.message", { text: "hi" }], ["assistant.message", { text: "hello" }]]));
  } finally {
    await ctx.close();
  }
  c = new RawClient(env, repo);
  const init = await c.initialize();
  assert.match(String(init.result!.instructions), /harness_audit/);
  const tools = (await c.request("tools/list")).result!.tools as { name: string; outputSchema: Record<string, unknown> }[];
  schema = tools.find((t) => t.name === "harness_audit")!.outputSchema;
});

after(async () => {
  await c?.close();
  rmSync(root, { recursive: true, force: true });
});

function git(args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function call(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await c.call("harness_audit", args);
  assert.notEqual(r.isError, true, `harness_audit failed: ${r.content?.[0]?.text}`);
  assert.deepEqual(schemaViolations(r.structuredContent, schema), [], "output matches its outputSchema");
  return r.structuredContent!;
}

type File = { path: string; kind: string; tokens?: number; loaded: number; read: number; loadTokens?: number; flags: string[] };

describe("harness_audit", () => {
  it("lists the unused files first, with absolute paths, load tokens per session and the refine run command", async () => {
    const r = (await call()) as { sessions: number; loadTokensPerSession: number; unused: Record<string, number>; files: File[]; next: string[]; note: string };
    assert.equal(r.sessions, 2);
    assert.deepEqual(r.unused, { neverRead: 1, writeOnly: 0, loadedNotRead: 1 });
    const flagged = r.files.filter((f) => f.flags.length);
    assert.deepEqual(flagged.map((f) => [f.path, f.flags]).sort(), [
      [join(mem, "stale.md"), ["never-read"]],
      [join(home, ".claude", "skills", "pdf", "SKILL.md"), ["loaded-not-read"]],
    ]);
    assert.ok(r.files.indexOf(flagged.at(-1)!) === flagged.length - 1, "flagged files come first");
    const stale = r.files.find((f) => f.path === join(mem, "stale.md"))!;
    assert.deepEqual([stale.tokens, stale.loaded, stale.read], [1000, 0, 0]);
    const claude = r.files.find((f) => f.path === join(repo, "CLAUDE.md"))!;
    assert.equal(claude.loaded, 2, "loaded at start in both sessions");
    assert.ok(r.loadTokensPerSession > 0 && r.loadTokensPerSession < 100);
    // No suite yet: the command names a placeholder and the note says how to get one.
    assert.deepEqual(r.next, ["coding.sh refine run --suite <name> --target CLAUDE.md --objective size"]);
    assert.match(r.note, /eval_init/);
    assert.ok(JSON.stringify(r).length < 3000, `compact: ${JSON.stringify(r).length} bytes`);
  });

  it("names the repo's suite of tasks in the refine command, and caps the list with more", async () => {
    mkdirSync(join(repo, "evals", "fixes"), { recursive: true });
    writeFileSync(join(repo, "evals", "fixes", "suite.json"), JSON.stringify({ name: "fixes", tasks: "tasks" }));
    try {
      const r = (await call({ limit: 1 })) as { files: File[]; more: number; next: string[]; note?: string };
      assert.equal(r.files.length, 1);
      assert.ok(r.more >= 4);
      assert.deepEqual(r.next, ["coding.sh refine run --suite fixes --target CLAUDE.md --objective size"]);
      assert.equal(r.note, undefined);
    } finally {
      rmSync(join(repo, "evals"), { recursive: true, force: true });
    }
  });

  it("check: true passes an edit that keeps the protected line and fails one that drops it", async () => {
    const clean = (await call({ check: true })) as { check: { ok: boolean; changed: boolean; protected: number } };
    assert.deepEqual(clean.check, { ok: true, changed: false, protected: 1, rejections: [] });
    const file = join(repo, "CLAUDE.md");
    const before = readFileSync(file, "utf8");
    try {
      writeFileSync(file, "# app\n\nKeep answers short.\n");
      const cut = (await call({ check: true })) as { check: { ok: boolean; changed: boolean; rejections: { line: string; text: string }[] }; next: string[] };
      assert.equal(cut.check.ok, false);
      assert.equal(cut.check.changed, true);
      assert.deepEqual(
        cut.check.rejections.map((x) => [x.line, x.text]),
        [["CLAUDE.md:3", SAFE]],
      );
      assert.equal(cut.next.at(-1), "coding.sh refine check --allow-protected-edit CLAUDE.md:3");
      writeFileSync(file, `# app\n\n${SAFE}\n`);
      const kept = (await call({ check: true })) as { check: { ok: boolean; changed: boolean } };
      assert.deepEqual([kept.check.ok, kept.check.changed], [true, true]);
    } finally {
      writeFileSync(file, before);
    }
  });

  it("check: true outside a git repo is a tool error that says why", async () => {
    const outside = join(root, "plain");
    mkdirSync(outside, { recursive: true });
    const other = new RawClient(env, outside);
    try {
      await other.initialize();
      const r = await other.call("harness_audit", { check: true });
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /git HEAD/);
    } finally {
      await other.close();
    }
  });
});
