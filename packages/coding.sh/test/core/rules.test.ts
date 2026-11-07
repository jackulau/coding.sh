import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffDirectives, directiveOutcome, extractDirectives, pathEndsWith, writtenText, type RuleEvent } from "../../src/core/rules.ts";

const one = (line: string, path = "CLAUDE.md") => {
  const ds = extractDirectives(line, path);
  assert.equal(ds.length, 1, `one directive in ${JSON.stringify(line)}`);
  return ds[0]!;
};

const bash = (id: string, command: string, toolUseId = id): RuleEvent => ({ id, kind: "tool.start", payload: { tool: "Bash", toolUseId, input: { command } } });
const read = (id: string, file_path: string): RuleEvent => ({ id, kind: "tool.start", payload: { tool: "Read", toolUseId: id, input: { file_path } } });
const end = (id: string, output: string, ok = true): RuleEvent => ({ id, kind: "tool.end", payload: { tool: "Read", toolUseId: id, ok, output } });

describe("extractDirectives", () => {
  it("reads polarity and token kinds", () => {
    const run = one("- Always run `npm run check` before finishing.");
    assert.equal(run.polarity, "require");
    assert.deepEqual(run.tokens, [{ kind: "command", value: "npm run check" }]);
    assert.equal(run.conditional, true, "before → conditional");
    assert.equal(run.text, "Always run `npm run check` before finishing.");
    assert.equal(run.line, 1);

    const force = one("Never use `git push --force`");
    assert.equal(force.polarity, "forbid");
    assert.equal(force.tokens[0]!.kind, "command");
    assert.equal(force.conditional, false);

    assert.deepEqual(one("Use `--frozen-lockfile`").tokens, [{ kind: "flag", value: "--frozen-lockfile" }]);
    assert.deepEqual(one("1. **Edit** `src/core/types.ts` only through the store").tokens, [{ kind: "path", value: "src/core/types.ts" }]);
    assert.deepEqual(one("Run `pnpm` for installs").tokens, [{ kind: "command", value: "pnpm" }], "a lone word after run is a command");
    assert.deepEqual(one("Prefer `parseFoo` over regex").tokens, [{ kind: "identifier", value: "parseFoo" }]);
    assert.equal(one("Don't import `lodash`").polarity, "forbid");
    assert.equal(one("You MUST call `flushAll` when done").conditional, true);
  });

  it("skips prose, frontmatter, fenced code and stoplisted or short tokens", () => {
    const text = [
      "---",
      "name: x",
      "description: Always run `npm test`",
      "---",
      "This project uses `vitest` for tests.",
      "Always keep `src` tidy.",
      "Run `ls` first.",
      "Use the test runner.",
      "```sh",
      "# Always run `npm run lint`",
      "```",
      "- Avoid `rm -rf` in scripts",
    ].join("\n");
    const ds = extractDirectives(text, "AGENTS.md");
    assert.deepEqual(
      ds.map((d) => [d.line, d.polarity, d.tokens[0]!.value]),
      [[12, "forbid", "rm -rf"]],
    );
  });

  it("keeps the id when a line moves and changes it when a word changes", () => {
    const a = extractDirectives("intro\n- Always run `npm test`.", "CLAUDE.md")[0]!;
    const b = extractDirectives("- Always   run `npm test`.\n\nmore", "CLAUDE.md")[0]!;
    const c = extractDirectives("- Always run `npm test` now.", "CLAUDE.md")[0]!;
    assert.equal(a.id, b.id);
    assert.notEqual(a.line, b.line);
    assert.notEqual(a.id, c.id);
    assert.match(a.id, /^[0-9a-f]{12}$/);
    assert.notEqual(a.id, extractDirectives("- Always run `npm test`.", "AGENTS.md")[0]!.id, "the path is part of the id");
  });
});

describe("diffDirectives", () => {
  it("splits added, removed and unchanged, and marks novel tokens", () => {
    const old = { "CLAUDE.md": "- Always run `npm test`.\n- Use `pnpm` for installs.\nWe deploy with `wrangler`." };
    const neu = { "CLAUDE.md": "- Always run `npm test`.\n- Prefer `wrangler` for deploys.\n" };
    const d = diffDirectives(old, neu);
    assert.equal(d.unchanged.length, 1);
    assert.equal(d.removed.length, 1);
    assert.equal(d.removed[0]!.tokens[0]!.value, "pnpm");
    assert.equal(d.added.length, 1);
    assert.equal(d.added[0]!.novel, false, "wrangler was already in the old prose");
    assert.equal(diffDirectives(old, { "CLAUDE.md": "- Use `bun` for installs." }).added[0]!.novel, true);
  });
});

describe("directiveOutcome", () => {
  const run = one("Always run `npm run check` before finishing.");
  const force = one("Never use `git push --force`");

  it("cites the event that acted on a require rule, and fails without it", () => {
    assert.deepEqual(directiveOutcome(run, [bash("e1", "ls"), bash("e2", "npm  run check")]), { acted: true, eventIds: ["e2"], seen: "inline" });
    assert.equal(directiveOutcome(run, [bash("e1", "npm test")]).acted, false);
  });

  it("cites the violation of a forbid rule", () => {
    assert.deepEqual(directiveOutcome(force, [bash("e1", "git push --force origin main")]), { acted: false, eventIds: ["e1"], seen: "inline" });
    assert.equal(directiveOutcome(force, [bash("e1", "git push origin main")]).acted, true);
  });

  it("matches flags as standalone arguments, paths at a boundary, identifiers in written text", () => {
    const flag = one("Use `--frozen-lockfile`");
    assert.equal(directiveOutcome(flag, [bash("e1", "pnpm install --frozen-lockfile")]).acted, true);
    assert.equal(directiveOutcome(flag, [bash("e1", "pnpm install --frozen-lockfile-x")]).acted, false);
    const path = one("Read `docs/ARCH.md` first");
    assert.equal(directiveOutcome(path, [read("e1", "/repo/docs/ARCH.md")]).acted, true);
    assert.equal(directiveOutcome(path, [read("e1", "/repo/olddocs/ARCH.md")]).acted, false);
    assert.equal(directiveOutcome(path, [bash("e1", "x"), { id: "f1", kind: "file.change", payload: { path: "/repo/docs/ARCH.md", op: "modify" } }]).acted, true);
    const ident = one("Use `fooBar` for parsing");
    const diff = { id: "f1", kind: "file.change", payload: { path: "a.ts", op: "modify", diff: "--- a/a.ts\n+++ b/a.ts\n+import { fooBar } from './x';\n-old" } };
    assert.deepEqual(directiveOutcome(ident, [bash("e1", "x"), diff]).eventIds, ["f1"]);
    const edit = { id: "w1", kind: "tool.start", payload: { tool: "MultiEdit", input: { file_path: "a.ts", edits: [{ old_string: "a", new_string: "fooBar()" }] } } };
    assert.equal(directiveOutcome(ident, [edit]).acted, true);
  });

  it("says null when the trace has no tool calls", () => {
    assert.deepEqual(directiveOutcome(run, [{ id: "m1", kind: "assistant.message", payload: { text: "done" } }]), { acted: null, eventIds: [], seen: "inline" });
  });

  it("tells whether a SKILL.md rule was on screen", () => {
    const rule = one("- Always run `make lint` after edits.", ".claude/skills/lint/SKILL.md");
    const full = "     1→---\n     5→- Always run `make lint` after edits.\n";
    const cut = "     1→---\n     2→name: lint\n…[truncated]";
    assert.equal(directiveOutcome(rule, [read("r1", "/repo/.claude/skills/lint/SKILL.md"), end("r1", full)]).seen, "displayed");
    assert.equal(directiveOutcome(rule, [read("r1", "/repo/.claude/skills/lint/SKILL.md"), end("r1", cut)]).seen, "not-displayed");
    assert.equal(directiveOutcome(rule, [read("r1", "/repo/src/a.ts"), end("r1", "code")]).seen, "not-loaded");
    assert.equal(directiveOutcome(rule, [{ id: "s1", kind: "tool.start", payload: { tool: "Skill", input: { skill: "lint" } } }, end("s1", "Launching skill")]).seen, "not-displayed");
    assert.equal(directiveOutcome(rule, [bash("e1", "make lint")]).seen, "unknown", "no tool output at all");
    assert.equal(one("Run `make` now", ".cursor/rules/build.mdc").path, ".cursor/rules/build.mdc");
    assert.equal(directiveOutcome(one("Run `make` now", ".cursor/rules/build.mdc"), []).seen, "inline");
  });
});

describe("helpers", () => {
  it("pathEndsWith respects path boundaries", () => {
    assert.equal(pathEndsWith("/repo/docs/A.md", "docs/A.md"), true);
    assert.equal(pathEndsWith("/repo/docs/A.md", "./docs/A.md"), true);
    assert.equal(pathEndsWith("/repo/xdocs/A.md", "docs/A.md"), false);
    assert.equal(pathEndsWith("C:\\repo\\docs\\A.md", "docs/A.md"), true);
  });

  it("writtenText is undefined for a blob-only diff", () => {
    assert.equal(writtenText({ id: "f", kind: "file.change", payload: { path: "a", op: "modify", additions: 3 } }), undefined);
    assert.equal(writtenText({ id: "w", kind: "tool.start", payload: { tool: "Write", input: { file_path: "a", content: "x = 1" } } }), "x = 1");
  });
});
