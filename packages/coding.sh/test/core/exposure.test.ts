import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { harnessItem, itemExposure, parseFrontmatter } from "../../src/core/exposure.ts";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ id: `e${++n}`, v: 1, sessionId: "s1", ts: n, agent: "claude-code", kind, payload, ...extra }) as unknown as AgentEvent;
const tool = (tool: string, input: unknown, extra: Record<string, unknown> = {}) => ev("tool.start", { tool, input, ...extra });

describe("parseFrontmatter", () => {
  it("reads scalars, booleans, inline and block lists", () => {
    const text = ["---", "name: \"pdf\"", "alwaysApply: false", "globs: [src/**/*.ts, 'test/*.ts']", "paths:", "  - src/**", "  - lib/*.js", "applyTo: '**/*.py' # comment", "---", "body"].join("\n");
    const { data, bodyStart } = parseFrontmatter(text);
    assert.deepEqual(data, { name: "pdf", alwaysApply: false, globs: ["src/**/*.ts", "test/*.ts"], paths: ["src/**", "lib/*.js"], applyTo: "**/*.py" });
    assert.equal(text.slice(bodyStart), "body");
  });
  it("no frontmatter or an unclosed block gives nothing and never throws", () => {
    assert.deepEqual(parseFrontmatter("# Title\n---\nx: 1\n---").data, {});
    assert.deepEqual(parseFrontmatter("---\nname: x\n").data, {});
    assert.deepEqual(parseFrontmatter("").data, {});
  });
});

describe("harnessItem", () => {
  it("classifies context files, rules, skills, cursor and copilot rules", () => {
    assert.deepEqual(harnessItem("CLAUDE.md", "")?.tier, "always");
    assert.equal(harnessItem("~/.claude/CLAUDE.md", "")?.kind, "context");
    const rule = harnessItem(".claude/rules/clock.md", "---\npaths: src/**, lib/**\n---\nUse the clock helper.")!;
    assert.deepEqual([rule.kind, rule.name, rule.tier, rule.globs], ["rule", "clock", "path", ["src/**", "lib/**"]]);
    assert.equal(harnessItem(".claude/rules/style.md", "No frontmatter")?.tier, "always");
    const skill = harnessItem(".claude/skills/pdf/SKILL.md", "---\nname: pdf-tools\n---\n")!;
    assert.deepEqual([skill.kind, skill.name, skill.tier], ["skill", "pdf-tools", "always"]);
    assert.equal(harnessItem(".cursor/rules/api.mdc", "---\nalwaysApply: true\n---\n")?.tier, "always");
    assert.equal(harnessItem(".cursor/rules/api.mdc", "---\nglobs: src/api/**\n---\n")?.tier, "path");
    assert.equal(harnessItem(".cursor/rules/api.mdc", "")?.tier, "requested");
    assert.equal(harnessItem(".github/instructions/py.instructions.md", "---\napplyTo: '**/*.py'\n---\n")?.tier, "path");
    assert.equal(harnessItem(".github/instructions/all.instructions.md", "---\napplyTo: '**'\n---\n")?.tier, "always");
    assert.equal(harnessItem(".claude/skills/pdf/fill.py", ""), undefined);
    assert.equal(harnessItem(".mcp.json", ""), undefined);
    assert.equal(harnessItem("CLAUDE.md", "")?.id.length, 12);
  });
});

describe("itemExposure", () => {
  const rule = harnessItem(".claude/rules/clock.md", "---\npaths: src/**\n---\n")!;
  const skill = harnessItem(".claude/skills/pdf/SKILL.md", "---\nname: pdf\n---\n")!;

  it("no events → unknown; an always-on item with a trace → in-context", () => {
    assert.equal(itemExposure(rule, []).state, "unknown");
    const ctx = harnessItem("AGENTS.md", "")!;
    assert.deepEqual(itemExposure(ctx, [ev("user.message", { text: "hi" })]), { state: "in-context", via: "always", eventIds: [] });
  });

  it("a path rule fires on a matching Read, a shell path or an @mention, not on other files", () => {
    const hit = tool("Read", { file_path: "/repo/src/clock.ts" });
    const x = itemExposure(rule, [tool("Read", { file_path: "/repo/README.md" }), hit], { cwd: "/repo" });
    assert.deepEqual(x, { state: "in-context", via: "inferred", eventIds: [hit.id] });
    assert.equal(itemExposure(rule, [tool("Bash", { command: "sed -n 1,20p src/time/now.ts" })], { cwd: "/repo" }).state, "in-context");
    assert.equal(itemExposure(rule, [ev("user.message", { text: "look at @src/a.ts please" })]).state, "in-context");
    assert.equal(itemExposure(rule, [tool("Read", { file_path: "/repo/docs/a.md" })], { cwd: "/repo" }).state, "not");
  });

  it("a trace with no tool inputs or user messages leaves a path rule unknown, never 'not'", () => {
    assert.equal(itemExposure(rule, [ev("session.start", {}), ev("llm.call", {})]).state, "unknown");
  });

  it("a skill is in context when opened (Skill tool, payload.skill, reading its dir), else only listed", () => {
    assert.equal(itemExposure(skill, [tool("Skill", { skill: "pdf" })]).state, "in-context");
    assert.equal(itemExposure(skill, [tool("Read", { file_path: "x" }, { skill: "pdf" })]).state, "in-context");
    assert.equal(itemExposure(skill, [tool("Read", { file_path: "/repo/.claude/skills/pdf/fill.py" })], { cwd: "/repo" }).state, "in-context");
    assert.equal(itemExposure(skill, [tool("Skill", { skill: "docx" }), tool("Read", { file_path: "/repo/a.ts" })], { cwd: "/repo" }).state, "listed");
    const gated = harnessItem(".claude/skills/pdf/SKILL.md", "---\npaths: docs/**\n---\n")!;
    assert.equal(itemExposure(gated, [tool("Read", { file_path: "/repo/a.ts" })], { cwd: "/repo" }).state, "not");
    assert.equal(itemExposure(gated, [tool("Read", { file_path: "/repo/docs/a.md" })], { cwd: "/repo" }).state, "listed");
  });
});
