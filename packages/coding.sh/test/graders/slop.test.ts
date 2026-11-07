import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentSlopGrader } from "../../src/graders/builtin.ts";
import { createGrader } from "../../src/graders/index.ts";
import { DEFAULT_SLOP_RULE_IDS, SLOP_RULE_IDS, SLOP_RULES, selectSlopRules, slopFindings, slopScore, traceDiffs } from "../../src/graders/slop.ts";

/** A diff that adds `lines` to a new file at `path`. */
const added = (path: string, ...lines: string[]) => `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const rulesOf = (patch: string, opts: Parameters<typeof slopFindings>[1] = {}) => slopFindings(patch, opts).findings.map((f) => f.rule);

// Each default rule: [rule, path, a line it flags, a near miss it must not flag].
const CASES: [string, string, string[], string[]][] = [
  ["elided-code", "src/a.ts", ["  // ... rest of the code"], ["  // ...args are passed through", "const all = [...rest];"]],
  ["elided-code", "app/views.py", ["    # ... existing code unchanged"], ["    # see the existing code in utils for context"]],
  ["elided-code", "src/App.tsx", ["      {/* ... */}"], ["      {/* the header */}"]],
  ["todo-implement", "src/a.ts", ["  // TODO: implement"], ["  // TODO: handle Windows paths"]],
  ["todo-implement", "app/svc.py", ["    # implementation goes here"], ["    # the implementation is in svc_impl.py"]],
  ["not-implemented", "src/a.ts", ['  throw new Error("Not implemented");'], ['  throw new Error("not found");']],
  ["not-implemented", "src/lib.rs", ["    todo!()"], ["    // todo list"]],
  ["as-any", "src/a.ts", ["const x = y as any;"], ['const s = "such as any other";', "// we treat it as any other value", "const t = k as anyOf;"]],
  ["as-unknown-as", "src/a.ts", ["const x = y as unknown as Foo;"], ["const x = y as unknown;"]],
  ["ts-ignore", "src/a.ts", ["  // @ts-ignore"], ["  // @ts-expect-error: the upstream type is wrong"]],
  ["lint-disable", "src/a.js", ["/* eslint-disable */"], ["  // eslint-disable-next-line no-control-regex", "const eslintDisabled = true;"]],
  ["lint-disable", "src/a.ts", ["  // eslint-disable-next-line"], ["  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK type is wrong"]],
  ["lint-disable", "app/a.py", ["import support  # noqa"], ["import support  # noqa: F401", 'x = "noqa"']],
  ["type-ignore", "app/a.py", ["x = compute()  # type: ignore"], ["x = compute()  # type: ignore[attr-defined]"]],
  ["empty-catch", "src/a.ts", ["try { f(); } catch {}"], ["try { f(); } catch (e) { log(e); }", "try { f(); } catch {} // best effort: the cache is optional"]],
  ["empty-catch", "src/a.ts", ["  } catch (e) {", "  }"], ["  } catch {", "    // not JSON: read it as text", "  }"]],
  ["empty-catch", "src/a.ts", ["p.catch(() => {});"], ["p.catch((e) => report(e));"]],
  ["empty-catch", "app/a.py", ["    except Exception:", "        pass"], ["    except ValueError:", "        return None"]],
  ["debugger", "src/a.ts", ["  debugger;"], ["const debuggerUrl = url;"]],
  ["debugger", "app/a.py", ["    breakpoint()"], ["    set_breakpoint(line)"]],
  ["debug-print", "src/a.ts", ['  console.log("here", x);'], ['  logger.log("x");', '  const s = "console.log(1)";']],
  ["debug-print", "lib/a.js", ['console.log("built");'], []],
  ["debug-print", "app/a.py", ['    print("DEBUG", x)'], ['    print("Saved 3 files")']],
  ["focused-test", "test/a.test.ts", ['it.only("works", () => {});'], ['it("only works when online", () => {});']],
  ["skipped-test", "tests/test_a.py", ["@pytest.mark.skip"], ["@pytest.mark.parametrize('x', [1])", '@pytest.mark.skipif(sys.platform == "win32", reason="posix only")', '@unittest.skipUnless(HAS_OPENAI, "openai not installed")']],
  ["skipped-test", "src/a.spec.js", ['describe.skip("slow", () => {});'], ['describe("skip list", () => {});', 'if (!gitBin) return t.skip("needs git");']],
  ["skipped-test", "test/a.test.ts", ['test("slow", { skip: true }, () => {});'], ['const r = check("follows-rules", { only: "forbid" });', 'run({ skip: "cache" });']],
  ["barrel-export", "src/index.ts", ['export * from "./a.ts";'], ['export { a } from "./a.ts";']],
  ["placeholder-text", "src/App.tsx", ["  <p>Coming soon</p>"], ["  const comingSoonFlag = flags.soon;"]],
  ["placeholder-text", "site/index.html", ["<p>Lorem ipsum dolor sit amet</p>"], ["<p>Welcome</p>"]],
  ["narrating-comment", "src/a.ts", ["  // increment i"], ["  // increment the retry budget only after a 429"]],
  ["changelog-comment", "src/a.ts", ["  // New: retry on 429"], ["  // Newline handling differs on Windows", "  // new: the failed tool step, pushed after the step's other events"]],
  ["changelog-comment", "src/a.ts", ["  return x; // <- added"], ["  return x; // the added total"]],
  ["changelog-comment", "app/a.py", ["# Added by Claude"], ["# Added in 2.0 for the CSV export"]],
];

describe("slop rules", () => {
  for (const [rule, path, hit, miss] of CASES) {
    it(`${rule} flags ${JSON.stringify(hit.join(" / "))} in ${path} and not ${JSON.stringify(miss.join(" / "))}`, () => {
      assert.ok(rulesOf(added(path, ...hit)).includes(rule), `expected ${rule}`);
      assert.ok(!rulesOf(added(path, ...miss)).includes(rule), `unexpected ${rule}`);
    });
  }

  it("every default rule has a positive case above", () => {
    const covered = new Set(CASES.map((c) => c[0]));
    assert.deepEqual(DEFAULT_SLOP_RULE_IDS.filter((id) => !covered.has(id)), []);
  });

  it("only reads added lines: removed and context lines never count", () => {
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n const y = z as any;\n-const x = y as any;\n+const x = y as Foo;\n console.log(x);\n";
    const r = slopFindings(patch);
    assert.deepEqual(r.findings, []);
    assert.equal(r.addedLines, 1);
  });

  it("reports the new file's line number, the path and the trimmed line", () => {
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,3 @@\n const a = 1;\n+  const x = y as any;\n const b = 2;\n";
    assert.deepEqual(slopFindings(patch).findings, [{ rule: "as-any", path: "src/a.ts", line: 11, text: "const x = y as any;", severity: "error" }]);
  });

  it("test-only rules ignore non-test paths, and placeholder text is allowed in tests and fixtures", () => {
    assert.deepEqual(rulesOf(added("src/a.ts", 'it.only("x", () => {});', 'it.skip("y", () => {});')), []);
    assert.deepEqual(rulesOf(added("src/__tests__/a.ts", 'it.only("x", () => {});')), ["focused-test"]);
    assert.deepEqual(rulesOf(added("test/app.test.tsx", "<p>Coming soon</p>")), []);
    assert.deepEqual(rulesOf(added("src/fixtures/page.tsx", "<p>Lorem ipsum</p>")), []);
  });

  it("debug prints count outside tests and scripts only", () => {
    assert.deepEqual(rulesOf(added("test/a.test.ts", 'console.log("x");')), []);
    assert.deepEqual(rulesOf(added("scripts/build.mjs", 'console.log("built dist/cli.mjs");')), []);
  });

  it("comment rules skip markdown, and dependencies and minified files are never read", () => {
    assert.deepEqual(rulesOf(added("README.md", "<!-- TODO: implement -->", "// ... rest of the code", "x as any", "Coming soon")), []);
    assert.deepEqual(rulesOf(added("node_modules/x/index.ts", "const a = b as any;")), []);
    assert.deepEqual(rulesOf(added("public/app.min.js", "debugger;")), []);
  });

  it("a block comment spanning lines is all comment", () => {
    assert.deepEqual(rulesOf(added("src/a.ts", "/*", "   ... rest of the code", "*/")), ["elided-code"]);
    assert.deepEqual(rulesOf(added("src/a.ts", "/*", "   an example: x as any", "*/")), []);
  });

  it("opt-in rules are off by default and run when named", () => {
    const patch = added("src/a.ts", "const o = { ...(x ? { a } : {}) };", "function f(v: unknown) {}", "const k: unknown = 1;");
    assert.deepEqual(rulesOf(patch), []);
    assert.deepEqual(rulesOf(patch, { rules: ["default", "conditional-empty-spread", "unknown-param"] }), ["conditional-empty-spread", "unknown-param"]);
    assert.deepEqual(rulesOf(patch, { rules: ["all"], exclude: ["unknown-param"] }), ["conditional-empty-spread"]);
    for (const r of SLOP_RULES.filter((x) => x.optIn)) assert.ok(!DEFAULT_SLOP_RULE_IDS.includes(r.id));
  });

  it("selectSlopRules: rules replace the defaults, exclude drops, unknown ids throw", () => {
    assert.deepEqual(selectSlopRules().map((r) => r.id), DEFAULT_SLOP_RULE_IDS);
    assert.deepEqual(selectSlopRules(["as-any"]).map((r) => r.id), ["as-any"]);
    assert.deepEqual(selectSlopRules(["all"]).map((r) => r.id), SLOP_RULE_IDS);
    assert.ok(!selectSlopRules(undefined, ["debug-print"]).some((r) => r.id === "debug-print"));
    assert.throws(() => selectSlopRules(["as-anything"]), /unknown slop rule "as-anything"/);
    assert.throws(() => selectSlopRules(undefined, ["nope"]), /unknown slop rule "nope"/);
  });

  it("slopScore: 1 with no findings, findings per 100 added lines (short diffs count as 100), pass on maxErrors and maxWarnings", () => {
    assert.deepEqual(slopScore({ errors: 0, warnings: 0, addedLines: 5 }), { score: 1, pass: true });
    assert.deepEqual(slopScore({ errors: 1, warnings: 0, addedLines: 10 }), { score: 0.5, pass: false });
    assert.deepEqual(slopScore({ errors: 0, warnings: 1, addedLines: 10 }), { score: 0.8, pass: true });
    assert.equal(slopScore({ errors: 1, warnings: 0, addedLines: 200 }).score.toFixed(3), "0.667");
    assert.equal(slopScore({ errors: 1, warnings: 0, addedLines: 10 }, { maxErrors: 1 }).pass, true);
    assert.equal(slopScore({ errors: 0, warnings: 3, addedLines: 10 }, { maxWarnings: 2 }).pass, false);
  });
});

describe("traceDiffs", () => {
  it("collects file.change diffs, adds a header to a bare hunk, reads a cut diff whole from its blob, and counts the rest", async () => {
    const full = added("src/big.ts", "const a = 1;", "const b = c as any;");
    const events = [
      { kind: "tool.start", payload: { tool: "Edit" } },
      { kind: "file.change", payload: { path: "src/a.ts", diff: "@@ -1,0 +1,1 @@\n+debugger;\n" } },
      { kind: "file.change", payload: { path: "src/b.ts" } },
      { kind: "file.change", payload: { path: "src/big.ts", diff: full.split("\n").slice(0, 4).join("\n") + "\n", diffTruncated: true }, blobs: ["raw", "blob-1"] },
      { kind: "file.change", payload: { path: "src/lost.ts", diff: added("src/lost.ts", "x"), diffTruncated: true }, blobs: ["gone"] },
    ];
    const d = await traceDiffs(events, async (ref) => (ref === "blob-1" ? full : undefined));
    assert.equal(d.patches.length, 3);
    assert.equal(d.missing, 1);
    assert.equal(d.truncated, 1);
    assert.deepEqual(slopFindings(d.patches).findings.map((f) => [f.rule, f.path]), [
      ["debugger", "src/a.ts"],
      ["as-any", "src/big.ts"],
    ]);
  });
});

describe("agent-slop grader", () => {
  const dirty = added("src/a.ts", "const x = y as any;", 'console.log("x");');

  it("version is a hash of the spec; createGrader builds the same grader", async () => {
    const a = agentSlopGrader();
    assert.equal(a.kind, "agent-slop");
    assert.equal(a.id, "agent-slop");
    assert.equal((await createGrader({ kind: "agent-slop" })).version, a.version);
    assert.notEqual(agentSlopGrader({ maxErrors: 1 }).version, a.version);
    assert.notEqual(agentSlopGrader({ exclude: ["debug-print"] }).version, a.version);
    assert.equal(agentSlopGrader({ name: "slop" }).version, a.version, "the name is not part of the rule");
    assert.throws(() => agentSlopGrader({ rules: ["nope"] }), /unknown slop rule/);
    assert.throws(() => agentSlopGrader({ maxErrors: -1 }), /maxErrors/);
  });

  it("grades ctx.diff first, then an output that is a diff, then the trace's file changes", async () => {
    const g = agentSlopGrader();
    const fromDiff = await g.grade({ input: "", output: dirty, diff: added("src/a.ts", "const ok = 1;") });
    assert.equal(fromDiff.pass, true);
    assert.match(fromDiff.reason ?? "", /0 errors, 0 warnings in 1 added line \(from the diff\)/);
    const fromOutput = await g.grade({ input: "", output: dirty });
    assert.equal(fromOutput.pass, false);
    assert.match(fromOutput.reason ?? "", /1 error, 1 warning in 2 added lines: as-any src\/a\.ts:1, debug-print src\/a\.ts:2 \(from the output\)/);
    const fromTrace = await g.grade({ input: "", output: "Done.", trace: [{ id: "e1", kind: "file.change", payload: { path: "src/a.ts", diff: dirty } }] });
    assert.equal(fromTrace.pass, false);
    assert.match(fromTrace.reason ?? "", /\(from the trace\)/);
    const none = await g.grade({ input: "", output: "Done." });
    assert.deepEqual([none.pass, none.score], [false, 0]);
    assert.match(none.reason ?? "", /no diff to grade/);
  });

  it("maxErrors and maxWarnings set the pass line; an empty diff passes", async () => {
    assert.equal((await agentSlopGrader({ maxErrors: 1 }).grade({ input: "", output: dirty })).pass, true);
    assert.equal((await agentSlopGrader({ maxErrors: 1, maxWarnings: 0 }).grade({ input: "", output: dirty })).pass, false);
    const empty = await agentSlopGrader().grade({ input: "", output: "", diff: "" });
    assert.deepEqual([empty.pass, empty.score], [true, 1]);
  });
});
