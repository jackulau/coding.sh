import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession, failureFlags } from "../../src/core/sessions.ts";
import { foldSkills, skillFlags, skillState, skillUse } from "../../src/core/skills-use.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

const CWD = "/Users/dev/proj";
const HOME = "/Users/dev";
let n = 0;
let clock = Date.UTC(2026, 10, 7, 9);
const ev = (kind: EventKind, payload: Record<string, unknown> = {}): AgentEvent => {
  clock += 1000;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, cwd: CWD };
};
const start = (tool: string, input: unknown, extra: Record<string, unknown> = {}) => ev("tool.start", { tool, toolUseId: `tu${n + 1}`, input, ...extra });
const bash = (command: string) => start("Bash", { command });
/** skillUse, checking that the events the fold keeps (foldSkills) give the same report. */
const use = (events: AgentEvent[]) => {
  const r = skillUse(events, { cwd: CWD, home: HOME });
  const s = skillState();
  for (const { e } of events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)) foldSkills(s, e);
  assert.deepEqual(skillUse(s.events, { cwd: CWD, home: HOME }), r, "foldSkills keeps every event skillUse reads");
  return r;
};
const brief = (events: AgentEvent[]) => use(events).used.map((u) => [u.name, u.scope, u.via.join("+"), u.beforeFirstChange]);

describe("skill use", () => {
  it("Skill tool, then a read of a personal skill, then an edit: both used before the first change, pdf first", () => {
    const events = [start("Skill", { skill: "pdf" }), start("Read", { file_path: `${HOME}/.claude/skills/pdf-tools/SKILL.md` }), start("Edit", { file_path: `${CWD}/a.ts` })];
    const r = use(events);
    assert.equal(r.first, "pdf");
    assert.deepEqual(brief(events), [
      ["pdf", "unknown", "invoke", true],
      ["pdf-tools", "personal", "read", true],
    ]);
    assert.equal(r.used[1]!.root, `${HOME}/.claude/skills/pdf-tools`);
  });

  it("running a skill's script is use via run, scoped to the project", () => {
    const events = [ev("file.change", { path: "a.pdf", op: "modify" }), bash("python3 .claude/skills/pdf/scripts/fill.py a.pdf")];
    const u = use(events).used;
    assert.deepEqual(brief(events), [["pdf", "project", "run", false]]);
    assert.equal(u[0]!.root, `${CWD}/.claude/skills/pdf`);
    assert.deepEqual(brief([bash("./.claude/skills/pdf/scripts/fill.sh")]).map((b) => b[2]), ["run"]);
    assert.deepEqual(brief([bash("cd x && node /Users/dev/proj/.claude/skills/pdf/a.js")]).map((b) => b[1]), ["project"]);
  });

  it("reading both the project and the personal copy is two uses and a copy conflict", () => {
    const events = [start("Read", { file_path: `${CWD}/.claude/skills/pdf/SKILL.md` }), bash(`cat ${HOME}/.claude/skills/pdf/SKILL.md`)];
    const r = use(events);
    assert.deepEqual(
      r.used.map((u) => [u.name, u.scope, u.root]),
      [
        ["pdf", "project", `${CWD}/.claude/skills/pdf`],
        ["pdf", "personal", `${HOME}/.claude/skills/pdf`],
      ],
    );
    assert.deepEqual(skillFlags(r), ["skill:pdf", "skill-copy-conflict"]);
  });

  it("plugin and nested skills get their scope; plugin names are qualified", () => {
    const plugin = `${HOME}/.claude/plugins/cache/caveman/caveman/1.2.0/skills/caveman/SKILL.md`;
    // A plugin named for its one skill is not doubled (`caveman:caveman`).
    assert.deepEqual(brief([start("Read", { file_path: plugin })]), [["caveman", "plugin", "read", true]]);
    assert.deepEqual(brief([start("Read", { file_path: `${HOME}/.claude/plugins/cache/acme/tools/2.0.0/skills/lint/SKILL.md` })]), [["tools:lint", "plugin", "read", true]]);
    assert.deepEqual(brief([start("Read", { file_path: `${HOME}/.claude/plugins/marketplaces/acme/plugins/design/skills/design/SKILL.md` })]), [["design", "plugin", "read", true]]);
    assert.deepEqual(brief([start("Read", { file_path: `${CWD}/packages/web/.claude/skills/ui/SKILL.md` })]), [["ui", "nested", "read", true]]);
    assert.deepEqual(brief([start("Skill", { skill: "vercel:deploy" })]), [["vercel:deploy", "plugin", "invoke", true]]);
    assert.deepEqual(brief([start("Skill", { skill: "design:design" })]), [["design", "plugin", "invoke", true]]);
  });

  it("only installed skills count: no skills/ folder in a repo, no heredoc text, no writes, no bare file under skills/", () => {
    const none = [
      // A heredoc body is data: a test fixture that mentions a skill path.
      `cat >> test/a.test.ts <<'EOF'\nconst files = { ".claude/skills/pdf/SKILL.md": "x" };\ncat .claude/skills/pdfx/SKILL.md\nEOF`,
      `python3 - <<'EOF'\nopen('.claude/skills/x/SKILL.md').read()\nEOF`,
      // Writing a skill file is not using it.
      "mkdir -p .claude/skills/x && cat > .claude/skills/x/SKILL.md",
      // skills/ folders in source trees and reference checkouts.
      "cat crates/goose/src/skills/mod.rs",
      "cd /tmp/ref && cat claude-code/skills/off/SKILL.md codex/skills/judgment/SKILL.md",
      "cat skills/judges/SKILL.md",
      "cat .claude/skills/mod.rs",
    ];
    for (const cmd of none) assert.deepEqual(use([bash(cmd)]).used, [], cmd);
    assert.deepEqual(use([start("Read", { file_path: `${CWD}/src/skills/parse/index.ts` })]).used, []);
    assert.deepEqual(use([start("Read", { file_path: `${CWD}/.claude/skills/pdf…/SKILL.md` })]).used, []);
  });

  it("container folders inside a skills dir name no skill: Codex's .system/ and synced/<id>/", () => {
    assert.deepEqual(brief([bash(`cat ${HOME}/.codex/skills/.system/imagegen/SKILL.md`)]), [["imagegen", "personal", "read", true]]);
    assert.deepEqual(brief([bash(`sed -n 1,80p ${HOME}/.agents/skills/synced/0a1b2c_3d4e5f/computer-use/SKILL.md`)]), [["computer-use", "personal", "read", true]]);
    assert.deepEqual(brief([start("Read", { file_path: `${HOME}/.config/opencode/skills/review/SKILL.md` })]), [["review", "personal", "read", true]]);
  });

  it("substitutions, deletes and parent-relative paths are not use", () => {
    for (const cmd of ["cat $(cat .claude/skills/x/SKILL.md)", "rm -rf .claude/skills/x", "cat ../skills/x/SKILL.md", "sed -i s/a/b/ .claude/skills/x/SKILL.md", "cat .claude/skills/*/SKILL.md"]) {
      assert.deepEqual(use([bash(cmd)]).used, [], cmd);
    }
  });

  it("Claude Code's skill load places a Skill call: the base directory's root and scope", () => {
    const events = [
      start("Skill", { skill: "greet" }),
      ev("notification", { kind: "harness.loaded", loadedBy: "skill", skills: ["greet"], sources: [`${CWD}/.claude/skills/greet`], toolUseId: "tu1" }),
      bash("node .claude/skills/greet/scripts/hi.js"),
    ];
    const u = use(events).used;
    assert.equal(u.length, 1);
    assert.deepEqual([u[0]!.name, u[0]!.scope, u[0]!.root, u[0]!.via, u[0]!.calls], ["greet", "project", `${CWD}/.claude/skills/greet`, ["invoke", "run"], 2]);
  });

  it("a skill restored after compaction counts as invoked when its Skill call is not in the events", () => {
    const restored = () => ev("notification", { kind: "harness.loaded", loadedBy: "invoked_skills", skills: ["deploy"], sources: ["userSettings:deploy"] });
    assert.deepEqual(brief([restored()]), [["deploy", "personal", "invoke", true]]);
    const again = [start("Skill", { skill: "deploy" }), restored()];
    assert.equal(use(again).used[0]!.calls, 1, "the Skill call already counted it");
  });

  it("buildSession tags skill:<name> in first-use order, and skill tags are not failures", () => {
    const events = [ev("session.start", {}), start("Read", { file_path: `${CWD}/.claude/skills/b/SKILL.md` }), start("Skill", { skill: "a" })];
    const s = buildSession(events);
    assert.deepEqual(
      s.flags.filter((f) => f.startsWith("skill:")),
      ["skill:b", "skill:a"],
    );
    assert.deepEqual(failureFlags(s.flags).filter((f) => f.startsWith("skill")), []);
    assert.deepEqual(buildSession(events).flags, s.flags, "recompute is identical");
    assert.ok(!buildSession([ev("session.start", {}), start("Read", { file_path: `${CWD}/src/a.ts` })]).flags.some((f) => f.startsWith("skill")));
  });

  it("at most 10 skill tags", () => {
    const events = Array.from({ length: 12 }, (_, i) => start("Skill", { skill: `s${i}` }));
    assert.equal(skillFlags(use(events)).length, 10);
  });
});
