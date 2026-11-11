// `coding.sh eval trigger <skill> --draft` from the CLI: refuses to overwrite,
// a model that answers without a draft is a clear error, and the draft reads
// this repo's sessions only unless --repo widens it. Runs src/cli/main.ts with a
// temp HOME; no model is called (provider "mock").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/core/types.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-trigger-draft-")));
const home = join(root, "home");
const skill = join(root, "skills", "pdf");
mkdirSync(home);
mkdirSync(skill, { recursive: true });
writeFileSync(join(skill, "SKILL.md"), "---\nname: pdf\ndescription: Read and merge PDF files.\n---\n# PDF\n");
const env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: process.env.PATH ?? "", NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
const cli = (args: string[], cwd = root) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 60_000 });
after(() => rmSync(root, { recursive: true, force: true }));

describe("eval trigger --draft", () => {
  it("keeps an existing triggers.toml without --force (exit 2)", () => {
    const file = join(skill, "triggers.toml");
    writeFileSync(file, "# mine\n");
    const r = cli(["eval", "trigger", skill, "--draft", "mock", "--no-traces"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /triggers\.toml exists; pass --force/);
    assert.equal(readFileSync(file, "utf8"), "# mine\n");
    rmSync(file);
  });

  it("names the provider when its reply has no draft, after one retry", () => {
    const r = cli(["eval", "trigger", skill, "--draft", "mock", "--no-traces", "--dry-run"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Couldn't draft trigger prompts: mock mock: no JSON draft in 2 replies/);
  });

  it("drafts from this repo's sessions only; --repo names another directory, or all", async () => {
    // Two repos, each with a session that loaded pdf and one that loaded its sibling docx.
    const repoA = join(root, "a");
    const repoB = join(root, "b");
    mkdirSync(join(repoA, "pkg"), { recursive: true });
    mkdirSync(repoB);
    assert.equal(spawnSync("git", ["init", "-q", repoA], { encoding: "utf8" }).status, 0);
    mkdirSync(join(root, "skills", "docx"));
    writeFileSync(join(root, "skills", "docx", "SKILL.md"), "---\nname: docx\ndescription: Write Word documents.\n---\n# DOCX\n");
    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env, cwd: root });
    try {
      let n = 0;
      const put = async (id: string, cwd: string, skillName: string, prompt: string) => {
        const ts = Date.now() - 3_600_000 + n++ * 1000;
        const ev = (i: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id: `${id}-${i}`, v: 0, sessionId: id, ts: ts + i, agent: "claude-code", kind, payload, cwd });
        const events = [ev(0, "session.start", {}), ev(1, "user.message", { text: prompt }), ev(2, "tool.start", { tool: "Skill", toolUseId: `${id}-s`, input: { skill: skillName } }), ev(3, "turn.end", {})];
        await ctx.index.putEvents(events);
        const s = buildSession(events);
        assert.ok(s.flags.includes(`skill:${skillName}`), `${id}: ${s.flags.join(",")}`);
        await ctx.index.upsertSession(s);
      };
      await put("a-pdf", repoA, "pdf", "Merge the invoices in billing");
      await put("a-docx", join(repoA, "pkg"), "docx", "Write the release memo");
      await put("b-pdf", repoB, "pdf", "Fill in the Zebra contract");
      await put("b-docx", repoB, "docx", "Draft the Zebra offer letter");
    } finally {
      await ctx.close();
    }
    // One mined prompt fills each side at --n 1, so the mock model is never asked.
    const draft = (extra: string[], cwd: string) => {
      const r = cli(["eval", "trigger", skill, "--draft", "mock", "--dry-run", "--n", "1", "--json", ...extra], cwd);
      assert.equal(r.status, 0, r.stderr);
      const d = JSON.parse(r.stdout) as { should: { source: string }[]; shouldNot: { source: string }[]; repo: string; calls: number };
      assert.equal(d.calls, 0);
      return { repo: d.repo, sources: [...d.should, ...d.shouldNot].map((p) => p.source).sort() };
    };
    const here = draft([], join(repoA, "pkg"));
    assert.deepEqual(here.sources, ["trace:a-docx", "trace:a-pdf"], "the git root of the cwd, not the cwd alone");
    assert.equal(here.repo, repoA);
    assert.deepEqual(draft(["--repo", repoB], repoA).sources, ["trace:b-docx", "trace:b-pdf"]);
    assert.deepEqual(draft(["--repo", "../b"], repoA).sources, ["trace:b-docx", "trace:b-pdf"], "a relative --repo is read from the cwd");
    assert.deepEqual(draft(["--repo", "all"], repoA).sources, ["trace:a-docx", "trace:a-pdf", "trace:b-docx", "trace:b-pdf"]);
    // A directory with no sessions under it mines nothing, so the model is asked (and the mock can't answer):
    // the other repos' prompts are never the fallback.
    const none = cli(["eval", "trigger", skill, "--draft", "mock", "--dry-run", "--n", "1"], join(root, "skills"));
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stderr, /Couldn't draft trigger prompts/);
    assert.ok(!none.stdout.includes("trace:"));
  });
});
