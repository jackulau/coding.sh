// The cut proposer's edits (src/refine/cut.ts) and the cost drivers it is shown
// (src/refine/drivers.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCut, cutCandidate, cutPrompt, cutSections, parseCut, removedLines } from "../../src/refine/cut.ts";
import { costDrivers, driverRun, inputKey, sections, type DriverRun } from "../../src/refine/drivers.ts";
import { targetPath } from "../../src/refine/target.ts";

const FILE = "# Rules\nNever run `git push --force`.\n\n## Style\nLong essay about style.\nMore essay.\n\n## Tests\nRun npm test.\n";

describe("parseCut", () => {
  it("reads edits from a JSON reply, fenced or not", () => {
    const cut = parseCut('```json\n{"edits":[{"find":"## Style\\n","replace":""}],"rationale":" shorter "}\n```');
    assert.deepEqual(cut, { edits: [{ find: "## Style\n", replace: "" }], rationale: "shorter" });
  });

  it("refuses replies that are not a cut", () => {
    assert.throws(() => parseCut("no"), /not JSON/);
    assert.throws(() => parseCut('{"edits":[]}'), /no edits/);
    assert.throws(() => parseCut('{"edits":[{"find":"","replace":""}]}'), /empty "find"/);
    assert.throws(() => parseCut('{"edits":[{"find":"a"}]}'), /each edit must be/);
    assert.throws(() => parseCut('{"edits":[{"find":"a","replace":"<!-- coding.sh:protect -->"}]}'), /coding\.sh marker/);
    assert.throws(() => parseCut('{"edits":[{"find":"a","section":"## A","replace":""}]}'), /each edit must be/);
    assert.throws(() => parseCut('{"edits":[{"section":" ","replace":""}]}'), /empty "section"/);
  });

  it("reads a section edit", () => {
    assert.deepEqual(parseCut('{"edits":[{"section":"## Style","replace":""}],"rationale":""}').edits, [{ section: "## Style", replace: "" }]);
  });
});

describe("applyCut", () => {
  it("applies each edit once and collapses the blank lines a deleted section leaves", () => {
    const out = applyCut(FILE, [{ find: "## Style\nLong essay about style.\nMore essay.\n", replace: "" }]);
    assert.equal(out, "# Rules\nNever run `git push --force`.\n\n## Tests\nRun npm test.\n");
    assert.deepEqual(removedLines(FILE, out), ["## Style", "Long essay about style.", "More essay."]);
  });

  it("refuses a find that is missing or ambiguous, and overlapping edits", () => {
    assert.throws(() => applyCut(FILE, [{ find: "nope", replace: "" }]), /occurs 0 times/);
    assert.throws(() => applyCut(FILE, [{ find: "essay", replace: "" }]), /occurs 2 times/);
    assert.throws(() => applyCut(FILE, [{ find: "Long essay", replace: "" }, { find: "essay about", replace: "" }]), /overlap/);
  });

  it("deletes or replaces a whole section by its heading, subsections included", () => {
    const doc = "# Rules\nKeep.\n\n## Style\nA.\n### Sub\nB.\n```\n## not a heading\n```\n\n## Tests\nRun npm test.\n";
    assert.equal(applyCut(doc, [{ section: "## Style", replace: "" }]), "# Rules\nKeep.\n\n## Tests\nRun npm test.\n");
    assert.equal(applyCut(doc, [{ section: "## Style", replace: "## Style\nShort." }]), "# Rules\nKeep.\n\n## Style\nShort.\n\n## Tests\nRun npm test.\n");
    assert.equal(applyCut(doc, [{ section: "## Tests", replace: "" }]), "# Rules\nKeep.\n\n## Style\nA.\n### Sub\nB.\n```\n## not a heading\n```\n\n");
    assert.throws(() => applyCut(doc, [{ section: "## not a heading", replace: "" }]), /not a heading/);
    assert.throws(() => applyCut(doc, [{ section: "## Style", replace: "" }, { find: "B.", replace: "" }]), /overlap/);
  });

  it("matches CRLF files as LF and writes CRLF back", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const out = applyCut(crlf, [{ find: "More essay.\n", replace: "" }]);
    assert.equal(out, crlf.replace("More essay.\r\n", ""));
  });

  it("makes a candidate with a stable id, and refuses a cut that changes nothing", () => {
    const cut = { edits: [{ find: "More essay.\n", replace: "" }], rationale: "" };
    const a = cutCandidate({ path: "CLAUDE.md", text: FILE }, cut);
    const b = cutCandidate({ path: "CLAUDE.md", text: FILE }, cut);
    assert.match(a.id, /^r_[0-9a-f]{10}$/);
    assert.equal(a.id, b.id);
    assert.throws(() => cutCandidate({ path: "CLAUDE.md", text: FILE }, { edits: [{ find: "Run npm test.", replace: "Run npm test." }], rationale: "" }), /changes nothing/);
  });
});

describe("cutPrompt", () => {
  it("shows the file, the drivers, the protected lines and earlier rejected cuts", () => {
    const p = cutPrompt({
      target: { path: "CLAUDE.md", text: FILE },
      drivers: ["- 6 runs over 3 tasks"],
      objective: "cost",
      protectedLines: [{ path: "CLAUDE.md", line: 2, text: "Never run `git push --force`.", norm: "never run `git push --force`.", why: "auto" }],
      rejected: [{ id: "r_0123456789", verdict: "reject", reasons: ["quality fell"], removed: ["Run npm test."] }],
    });
    assert.match(p.user, /Long essay about style/);
    assert.match(p.user, /6 runs over 3 tasks/);
    assert.match(p.user, /git push --force/);
    assert.match(p.user, /r_0123456789/);
    assert.match(p.user, /quality fell/);
  });
});

describe("rejected cuts", () => {
  it("names the sections a large cut took lines from instead of listing its first lines", () => {
    const before = `# Start\nRead docs/A.md first.\n\n## Rule\nErrors start with "x: ".\n\n## Style\n${Array.from({ length: 20 }, (_, i) => `- s${i}`).join("\n")}\n`;
    const after = "## Style\n- s0\n";
    const sections = cutSections(before, after);
    assert.deepEqual(sections, [
      { heading: "# Start", removed: 2, lines: 2 },
      { heading: "## Rule", removed: 2, lines: 2 },
      { heading: "## Style", removed: 19, lines: 21 },
    ]);
    const removed = removedLines(before, after);
    const p = cutPrompt({ target: { path: "CLAUDE.md", text: before }, drivers: [], objective: "cost", protectedLines: [], rejected: [{ id: "r_0123456789", verdict: "reject", reasons: ["hard regression"], removed: removed.slice(0, 40), removedCount: removed.length, sections }] });
    assert.match(p.user, /removed 23 lines: all of "# Start" \(2\), all of "## Rule" \(2\), 19 of 21 lines in "## Style"/);
    assert.doesNotMatch(p.user, /    - Read docs\/A\.md first\./, "a large cut's first lines are not shown as if they were the cut");
  });
});

describe("costDrivers", () => {
  const run = (task: string, wall: number, tools: DriverRun["tools"], extra: Partial<DriverRun> = {}): DriverRun => ({ task, pass: true, wall, tools, ...extra });

  it("names the slowest tasks, repeated calls, long outputs and the file's largest sections", () => {
    const read = { tool: "Read", key: "Read src/big.ts", outChars: 40_000 };
    const runs = [
      run("slow", 30_000, [read, read, read], { cost: 0.3, turns: 9 }),
      run("fast", 5_000, [{ tool: "Bash", key: "Bash npm test", outChars: 200 }], { cost: 0.05, turns: 3 }),
    ];
    const lines = costDrivers(runs, { path: "CLAUDE.md", text: FILE });
    const text = lines.join("\n");
    assert.match(lines[0]!, /2 runs over 2 tasks, 100% passed\. Per run: cost \$0\.1750/);
    assert.match(text, /Slowest tasks: slow \(30\.0 s, 9\.0 turns, 3\.0 tool calls\)/);
    assert.match(text, /Read src\/big\.ts/);
    assert.match(text, /CLAUDE\.md/);
    assert.match(text, /## Style/);
  });

  it("still describes the file when there are no runs yet", () => {
    const lines = costDrivers([], { path: "CLAUDE.md", text: FILE });
    assert.ok(lines.length > 0);
    assert.match(lines.join("\n"), /CLAUDE\.md/);
  });

  it("splits sections by heading, ignoring headings in code fences", () => {
    const s = sections("# A\nx\n```\n# not a heading\n```\n## B\nyy\n");
    assert.deepEqual(s.map((x) => x.heading).sort(), ["# A", "## B"]);
    assert.equal(inputKey({ file_path: "a.ts", limit: 3 }), "a.ts");
    assert.equal(inputKey({ command: "npm   test" }), "npm test");
  });

  it("keys calls relative to the run's workspace, so reads of different files in different runs stay apart", () => {
    const ws = "/data/runs/run_01M6WM832H1NEGT57STFSE99TS/work";
    assert.equal(inputKey({ file_path: `${ws}/docs/HISTORY.md` }, ws), "docs/HISTORY.md");
    assert.equal(inputKey({ command: `cat ${ws}/src/a.ts` }, `${ws}/`), "cat src/a.ts");
    const long = `/x/${"d".repeat(100)}/GLOSSARY.md`;
    assert.match(inputKey({ file_path: long }), /^….*\/GLOSSARY\.md$/, "a long path keeps its file name");
  });

  it("counts a clipped output at its full length", () => {
    const events = [
      { kind: "tool.start", payload: { tool: "Read", toolUseId: "t1", input: { file_path: "/w/docs/HISTORY.md" } } },
      { kind: "tool.end", payload: { tool: "Read", toolUseId: "t1", output: "x".repeat(1536) } },
    ] as never;
    const session = { cwd: "/w", stats: { turns: 1 } } as never;
    const r = driverRun("t", true, 1000, session, events, { outChars: new Map([["t1", 40_960]]) });
    assert.deepEqual(r.tools, [{ tool: "Read", key: "Read docs/HISTORY.md", outChars: 40_960 }]);
    assert.match(costDrivers([r]).join("\n"), /Long tool outputs: "Read docs\/HISTORY\.md" ≥ 40960 chars/);
  });
});

describe("targetPath", () => {
  it("maps a skill directory to its SKILL.md", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "cs-target-"));
    try {
      mkdirSync(join(root, ".claude/skills/pdf"), { recursive: true });
      writeFileSync(join(root, ".claude/skills/pdf/SKILL.md"), "---\nname: pdf\n---\n");
      assert.equal(targetPath(".claude/skills/pdf", root), ".claude/skills/pdf/SKILL.md");
      assert.equal(targetPath("CLAUDE.md", root), "CLAUDE.md");
      assert.equal(targetPath(undefined, root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
