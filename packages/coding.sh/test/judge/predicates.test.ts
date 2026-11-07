// Rule-compliance predicates (Y-20): ran-command, read-path, wrote-identifier, follows-rules.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceEvent } from "../../src/datasets/types.ts";
import { createGrader } from "../../src/graders/index.ts";
import { BUILTIN_PREDICATES, normalizePredicateResult, predicateContext, type PredicateOutcome } from "../../src/judge/index.ts";

const bash = (id: string, command: string): TraceEvent => ({ id, kind: "tool.start", payload: { tool: "Bash", toolUseId: id, input: { command } } });
const done = (id: string, ok: boolean): TraceEvent => ({ id: `${id}-end`, kind: "tool.end", payload: { tool: "Bash", toolUseId: id, ok, output: ok ? "ok" : "1 failing" } });
const readEv = (id: string, file_path: string): TraceEvent => ({ id, kind: "tool.start", payload: { tool: "Read", toolUseId: id, input: { file_path } } });

function check(name: string, args: Record<string, unknown>, trace: TraceEvent[], metadata?: Record<string, unknown>): PredicateOutcome {
  const p = BUILTIN_PREDICATES[name]!;
  p.validateArgs?.(args);
  return normalizePredicateResult(p.test(predicateContext({ input: "", output: "", trace, ...(metadata ? { metadata } : {}) }), args));
}

describe("ran-command", () => {
  it("finds the command and cites it; with ok, needs the paired tool.end to succeed", () => {
    const trace = [bash("b1", "npm  run check"), done("b1", false)];
    assert.deepEqual(check("ran-command", { command: "npm run check" }, trace), { answer: true, explanation: "ran npm run check in b1", eventIds: ["b1"] });
    const failed = check("ran-command", { command: "npm run check", ok: true }, trace);
    assert.equal(failed.answer, false);
    assert.deepEqual(failed.eventIds, ["b1", "b1-end"]);
    const retried = check("ran-command", { command: "npm run check", ok: true }, [...trace, bash("b2", "npm run check"), done("b2", true)]);
    assert.deepEqual([retried.answer, retried.eventIds], [true, ["b2"]]);
    assert.equal(check("ran-command", { pattern: "^npm (run )?test\\b" }, [bash("b1", "npm test -- --watch=false")]).answer, true);
    assert.equal(check("ran-command", { command: "npm test" }, [bash("b1", "ls")]).explanation, "never ran npm test");
    assert.equal(check("ran-command", { command: "npm test", ok: true }, [bash("b1", "npm test")]).answer, false, "ok needs a result");
    assert.equal(check("ran-command", { command: "npm test" }, []).answer, null, "no trace at all is n/a");
    assert.equal(check("read-path", { path: "a.md" }, []).answer, null);
  });

  it("rejects bad args", () => {
    const v = BUILTIN_PREDICATES["ran-command"]!.validateArgs!;
    assert.throws(() => v({}), TypeError);
    assert.throws(() => v({ command: "a", pattern: "b" }), TypeError);
    assert.throws(() => v({ command: "" }), TypeError);
    assert.throws(() => v({ command: "x", ok: "yes" }), TypeError);
  });
});

describe("read-path", () => {
  it("matches a Read at a path boundary or a shell command naming the file", () => {
    assert.deepEqual(check("read-path", { path: "docs/ARCH.md" }, [readEv("r1", "/repo/docs/ARCH.md")]).eventIds, ["r1"]);
    assert.equal(check("read-path", { path: "docs/ARCH.md" }, [bash("b1", "cat docs/ARCH.md")]).answer, true);
    assert.equal(check("read-path", { path: "docs/ARCH.md" }, [readEv("r1", "/repo/mydocs/ARCH.md")]).answer, false);
    assert.throws(() => BUILTIN_PREDICATES["read-path"]!.validateArgs!({}), TypeError);
  });
});

describe("wrote-identifier", () => {
  it("looks in + lines of inline diffs and in Write/Edit content; null when no diff is inline", () => {
    const diff: TraceEvent = { id: "f1", kind: "file.change", payload: { path: "src/a.ts", op: "modify", diff: "@@\n+export function parseFoo() {}\n-function old() {}" } };
    assert.deepEqual(check("wrote-identifier", { identifier: "parseFoo" }, [diff]).eventIds, ["f1"]);
    assert.equal(check("wrote-identifier", { identifier: "old" }, [diff]).answer, false, "a - line is not written");
    const blobOnly: TraceEvent = { id: "f2", kind: "file.change", payload: { path: "src/a.ts", op: "modify", additions: 4 } };
    const n = check("wrote-identifier", { identifier: "parseFoo" }, [blobOnly]);
    assert.equal(n.answer, null);
    assert.match(n.explanation!, /diffs not inline/);
    const edit: TraceEvent = { id: "e1", kind: "tool.start", payload: { tool: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "parseFoo(x)" } } };
    assert.equal(check("wrote-identifier", { identifier: "parseFoo" }, [blobOnly, edit]).answer, true);
  });
});

describe("follows-rules", () => {
  const text = "Always run `npm test`.\nNever use `git push --force`.";

  it("fails on a broken forbid rule, names it and cites the push", () => {
    const r = check("follows-rules", { text }, [bash("b1", "npm test"), bash("b2", "git push --force origin main")]);
    assert.equal(r.answer, false);
    assert.match(r.explanation!, /1 of 2 rule\(s\) not followed: [0-9a-f]{12} broke "Never use `git push --force`\."/);
    assert.deepEqual(r.eventIds, ["b2"]);
  });

  it("passes when every rule was acted on", () => {
    const r = check("follows-rules", { text }, [bash("b1", "npm test"), bash("b2", "git push origin main")]);
    assert.deepEqual([r.answer, r.explanation, r.eventIds], [true, "acted on all 2 rule(s)", ["b1"]]);
  });

  it("skips path-scoped rules that never came into scope (Cursor globs, Claude Code paths)", () => {
    const instructions = {
      "CLAUDE.md": "Always run `npm test`.",
      ".cursor/rules/sql.mdc": '---\nglobs: "db/**/*.sql"\n---\nNever run `psql`.',
      ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\nAlways run `npm run api:check`.",
    };
    const r = check("follows-rules", {}, [bash("b1", "npm test"), bash("b2", "psql -c 'select 1'")], { instructions });
    assert.deepEqual([r.answer, r.explanation], [true, "acted on all 1 rule(s) (2 scoped rule(s) never came into scope)"]);
    const api = check("follows-rules", {}, [readEv("r1", "/repo/src/api/users.ts"), bash("b1", "npm test")], { instructions });
    assert.equal(api.answer, false);
    assert.match(api.explanation!, /1 of 2 rule\(s\) not followed: [0-9a-f]{12} skipped "Always run `npm run api:check`\."/);
    const idle = check("follows-rules", { text: instructions[".cursor/rules/sql.mdc"], path: ".cursor/rules/sql.mdc" }, [bash("b1", "psql")]);
    assert.deepEqual([idle.answer, idle.explanation], [null, "no rule in scope: 1 scoped rule(s) never triggered"]);
  });

  it("is n/a with no rules or no tool calls", () => {
    assert.equal(check("follows-rules", { text: "" }, [bash("b1", "ls")]).answer, null);
    assert.equal(check("follows-rules", { text }, [{ id: "m", kind: "assistant.message", payload: { text: "hi" } }]).answer, null);
    assert.equal(check("follows-rules", {}, [bash("b1", "ls")]).answer, null, "no text and no metadata.instructions");
  });

  it("reads metadata.instructions, filters by polarity, and flags conditional rules as low confidence", () => {
    const instructions = { "CLAUDE.md": "- Always run `npm run lint` after edits.", "AGENTS.md": "- Never run `rm -rf /`" };
    const r = check("follows-rules", {}, [bash("b1", "ls")], { instructions });
    assert.equal(r.answer, false);
    assert.match(r.explanation!, /skipped "Always run `npm run lint` after edits\." \(conditional, low confidence\)/);
    assert.equal(check("follows-rules", { only: "forbid" }, [bash("b1", "ls")], { instructions }).answer, true);
    assert.equal(check("follows-rules", { skipConditional: true }, [bash("b1", "ls")], { instructions }).answer, true);
    assert.equal(check("follows-rules", {}, [bash("b1", "ls")], { instructions: text }).answer, false, "a string works too");
    assert.throws(() => BUILTIN_PREDICATES["follows-rules"]!.validateArgs!({ only: "some" }), TypeError);
  });

  it("grades an llm-checklist of rule predicates with zero model calls", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      throw new Error("no model call expected");
    };
    const g = await createGrader(
      {
        kind: "llm-checklist",
        name: "rules",
        items: [
          { id: "ran-tests", question: "Ran the tests?", check: { name: "ran-command", args: { command: "npm test", ok: true } } },
          { id: "rules", question: "Followed CLAUDE.md?", critical: true, check: { name: "follows-rules", args: { text } } },
        ],
      },
      { fetch, env: {} },
    );
    assert.equal(g.calibration, undefined, "deterministic: nothing to calibrate");
    const pass = await g.grade({ input: "", output: "", trace: [bash("b1", "npm test"), done("b1", true)] });
    assert.equal(pass.pass, true);
    const fail = await g.grade({ input: "", output: "", trace: [bash("b1", "npm test"), done("b1", true), bash("b2", "git push --force")] });
    assert.equal(fail.pass, false);
    assert.deepEqual((fail as unknown as { gatedBy: string[] }).gatedBy, ["rules"]);
    assert.equal(calls, 0);
  });
});
