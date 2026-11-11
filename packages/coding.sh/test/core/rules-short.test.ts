// Short backticked commands and flags (`rm`, `ls`, `-f`) are checkable rules.
// They used to be dropped for being under 3 characters, so "Never run `rm`."
// had no checkable rule and a trace that ran rm was n/a. A short command is
// matched as a whole word, so `npm run format` does not count as rm.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { directiveOutcome, extractDirectives, type RuleEvent } from "../../src/core/rules.ts";
import { BUILTIN_PREDICATES, normalizePredicateResult, predicateContext } from "../../src/judge/index.ts";

const bash = (id: string, command: string): RuleEvent => ({ id, kind: "tool.start", payload: { tool: "Bash", toolUseId: id, input: { command } } });
const followsRules = (text: string, trace: RuleEvent[]) => {
  const p = BUILTIN_PREDICATES["follows-rules"]!;
  return normalizePredicateResult(p.test(predicateContext({ input: "", output: "", trace }), { text }));
};

describe("short rule tokens", () => {
  it("Never run `rm`: a trace that ran rm fails", () => {
    const [d] = extractDirectives("Never run `rm`.", "AGENTS.md");
    assert.ok(d, "the rule is checkable");
    assert.deepEqual(d.tokens, [{ kind: "command", value: "rm" }]);
    assert.equal(directiveOutcome(d, [bash("b1", "rm -rf build")]).acted, false);
    assert.equal(directiveOutcome(d, [bash("b1", "cd x && /bin/rm a.txt")]).acted, false, "after && and as a path");
    assert.equal(followsRules("Never run `rm`.", [bash("b1", "rm -rf build")]).answer, false);
  });

  it("a short command matches whole words only", () => {
    const [d] = extractDirectives("Never run `rm`.", "AGENTS.md");
    assert.equal(directiveOutcome(d!, [bash("b1", "npm run format"), bash("b2", "echo charm")]).acted, true);
  });

  it("Never use `ls` and a short flag are checkable", () => {
    assert.deepEqual(extractDirectives("Never use `ls`.", "AGENTS.md")[0]?.tokens, [{ kind: "command", value: "ls" }]);
    assert.deepEqual(extractDirectives("Never pass `-f` to git.", "AGENTS.md")[0]?.tokens, [{ kind: "flag", value: "-f" }]);
    assert.equal(followsRules("Never use `ls`.", [bash("b1", "ls -la")]).answer, false);
  });

  it("a mixed file counts both rules", () => {
    const r = followsRules("Always run `ls`.\nNever use `git push --force`.", [bash("b1", "ls"), bash("b2", "git status")]);
    assert.equal(r.answer, true);
    assert.match(r.explanation ?? "", /all 2 rule/);
  });

  it("a short word that is not a command stays out", () => {
    assert.deepEqual(extractDirectives("Never set `x` in the config.", "AGENTS.md"), []);
  });
});
