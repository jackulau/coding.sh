import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadCases, parseCase } from "../../src/workflows/cases.ts";
import { extractFindings, matchFindings, sameFile } from "../../src/workflows/score/findings.ts";
import { verifyConfusion } from "../../src/workflows/score/verify.ts";
import { buildSeededTree, locatePatch, validateSeededTree } from "../../src/workflows/seed/bugs.ts";
import type { SeededBug } from "../../src/workflows/types.ts";
import { MemBlobs } from "../otel/_memstore.ts";
import { BUG_PATCH, RUN_OUTPUT, writeReviewCases } from "./_fixtures.ts";

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-score-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const bug = (id: string, file: string, lines: [number, number], severity: SeededBug["severity"] = "P1"): SeededBug => ({ id, file, lines, category: "logic", severity, patch: "" });

describe("findings matching", () => {
  it("matches by file and line window, one finding per bug, and reports precision/recall/F1", () => {
    const bugs = [bug("b1", "src/a.ts", [10, 12], "P0"), bug("b2", "src/b.ts", [40, 40]), bug("b3", "src/e.ts", [1, 3], "P2")];
    const s = matchFindings(extractFindings(RUN_OUTPUT), bugs);
    assert.deepEqual(s.matches, [
      [0, "b1"],
      [1, "b2"],
    ]);
    assert.equal(s.precision, 2 / 3);
    assert.equal(s.recall, 2 / 3);
    assert.ok(Math.abs(s.f1 - 2 / 3) < 1e-12);
    assert.equal(s.weightedRecall, 5 / 6);
    assert.deepEqual(s.unmatched, [2]);
    assert.deepEqual(s.missed, ["b3"]);
  });

  it("counts a second finding on a taken bug as a duplicate, closest one wins", () => {
    const s = matchFindings(
      [
        { file: "src/a.ts", line: 20, summary: "far" },
        { file: "./src/a.ts", line: 11, summary: "near" },
      ],
      [bug("b1", "src/a.ts", [10, 12])],
      { slack: 10 },
    );
    assert.deepEqual(s.matches, [[1, "b1"]]);
    assert.equal(s.duplicates, 1);
    assert.equal(s.duplicateRate, 0.5);
  });

  it("uses the judge only for findings without a line, and respects slack", () => {
    const bugs = [bug("b1", "pkg/src/a.ts", [10, 12])];
    assert.equal(matchFindings([{ file: "src/a.ts", line: 18, summary: "x" }], bugs).matches.length, 0);
    assert.equal(matchFindings([{ file: "src/a.ts", line: 18, summary: "x" }], bugs, { slack: 6 }).matches.length, 1);
    assert.equal(matchFindings([{ file: "src/a.ts", summary: "off by one" }], bugs).matches.length, 0);
    assert.equal(matchFindings([{ file: "src/a.ts", summary: "off by one" }], bugs, { judge: (f) => /off by one/.test(f.summary) }).matches.length, 1);
    assert.ok(sameFile("/abs/repo/src/a.ts", "src/a.ts"));
    assert.ok(!sameFile("src/xa.ts", "a.ts"));
  });

  it("extracts findings from arrays, wrapper objects, JSON strings and file:line locations", () => {
    assert.deepEqual(extractFindings([{ location: "src/x.ts:7:3", title: "t" }]), [{ file: "src/x.ts", line: 7, summary: "t" }]);
    assert.deepEqual(extractFindings(JSON.stringify({ issues: [{ path: "a", lines: [3, 4], description: "d", severity: "P0" }] })), [{ file: "a", line: 3, summary: "d", severity: "P0" }]);
    assert.deepEqual(extractFindings({ review: { findings: [{ file: "b" }] } }), [{ file: "b", summary: "" }]);
    assert.deepEqual(extractFindings("not json"), []);
    assert.deepEqual(extractFindings(null), []);
  });

  it("scores an empty answer on an empty truth as perfect and an empty answer otherwise as zero", () => {
    assert.equal(matchFindings([], []).f1, 1);
    assert.equal(matchFindings([], [bug("b", "f", [1, 1])]).f1, 0);
  });
});

describe("verify confusion", () => {
  it("compares what verify kept against what was real, per skeptic too", () => {
    const entered = RUN_OUTPUT.candidates.map((c, i) => ({ findingIdx: i, survived: c.survived, votes: c.votes }));
    const v = verifyConfusion(entered, new Set([0, 1]));
    assert.deepEqual(v.confusion, { realKept: 1, realRefuted: 1, spuriousKept: 1, spuriousRefuted: 1 });
    assert.equal(v.refuteAccuracy, 0.5);
    assert.equal(v.falseKillRate, 0.5);
    assert.equal(v.falseKeepRate, 0.5);
    assert.equal(v.kappa, 0);
    // Truth is [real, real, spurious, spurious]; skeptic 0 voted [keep, refute, keep, refute], skeptic 1 [keep, keep, refute, refute].
    assert.deepEqual(
      v.perSkeptic.map((p) => [p.skeptic, p.n, p.accuracy]),
      [
        [0, 4, 0.5],
        [1, 4, 1],
      ],
    );
    assert.ok(Number.isNaN(verifyConfusion([{ findingIdx: 0, survived: true }], new Set()).falseKillRate));
  });
});

describe("workflow cases", () => {
  it("loads TOML cases: inline bugs with patch files, hidden truth files, verifier, splits", async () => {
    const dir = join(root, "evals", "workflows", "review", "cases");
    writeReviewCases(dir);
    const blobs = new MemBlobs();
    const all = await loadCases(dir, "review", blobs);
    assert.deepEqual(all.map((c) => c.id), ["seeded-1", "seeded-2", "verify-1"]);
    const [s1, s2, v1] = all;
    assert.deepEqual(s1!.args, { target: "src", seeded: "seeded-1" });
    assert.equal(s1!.threshold, 0.5);
    assert.equal(s1!.truth.kind, "seeded-bugs");
    const bugs = (s1!.truth as { bugs: SeededBug[] }).bugs;
    assert.deepEqual(bugs.map((b) => [b.id, b.file, b.lines, b.severity]), [
      ["b1", "src/a.ts", [10, 12], "P0"],
      ["b2", "src/b.ts", [40, 40], "P1"],
      ["b3", "src/e.ts", [1, 3], "P2"],
    ]);
    assert.equal(await blobs.getText(bugs[0]!.patch), BUG_PATCH);
    assert.equal(bugs[1]!.patch, "");
    assert.equal(s2!.split, "heldout");
    assert.deepEqual(s2!.args, { target: "lib" });
    assert.deepEqual((s2!.truth as { bugs: SeededBug[] }).bugs.map((b) => b.id), ["h1"]);
    assert.deepEqual(v1!.truth, { kind: "verifier", command: "exit 0" });
    assert.deepEqual((await loadCases(dir, "review", blobs, "heldout")).map((c) => c.id), ["seeded-2"]);
  });

  it("rejects malformed cases with the file name", async () => {
    const blobs = new MemBlobs();
    await assert.rejects(parseCase(`[truth]\nkind = "verifier"\n`, "/x/bad.toml", "w", blobs), /bad\.toml: truth\.command/);
    await assert.rejects(parseCase(`[truth]\nkind = "nope"\n`, "/x/bad2.toml", "w", blobs), /unknown truth\.kind/);
    await assert.rejects(parseCase(`[[truth.bugs]]\nid = "b"\nfile = "f"\nlines = [1, 2]\npatch = "missing.patch"\n`, "/x/c.toml", "w", blobs), /can't read patch/);
    const c = await parseCase(`args = "plain"\n`, "/x/plain.toml", "w", blobs);
    assert.equal(c.id, "plain");
    assert.equal(c.args, "plain");
  });
});

describe("seeded bugs", () => {
  it("locates the changed lines of a bug patch", () => {
    assert.deepEqual(locatePatch(BUG_PATCH), { file: "src/a.ts", lines: [2, 2] });
    const deletion = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,2 @@\n one\n-two\n three\n";
    assert.deepEqual(locatePatch(deletion), { file: "f.txt", lines: [1, 2] });
    assert.throws(() => locatePatch("not a patch"), /no textual hunks/);
  });

  it("builds a seeded tree and validates each bug fails seeded and passes reverted", async () => {
    const clean = join(root, "clean");
    mkdirSync(join(clean, "src"), { recursive: true });
    writeFileSync(join(clean, "src", "a.ts"), "export function last(xs: number[]) {\n  return xs[xs.length - 1];\n}\n");
    mkdirSync(join(clean, ".git"));
    writeFileSync(join(clean, ".git", "HEAD"), "ref: refs/heads/main\n");
    const out = join(root, "seeded");
    const blobs = new MemBlobs();
    const spec = { id: "b1", patch: BUG_PATCH, category: "logic", severity: "P0" as const, test: "grep -q 'xs.length - 1' src/a.ts" };
    const truth = await buildSeededTree({ cleanDir: clean, outDir: out, bugs: [spec], blobs });
    assert.deepEqual(truth.map((b) => [b.id, b.file, b.lines, b.test]), [["b1", "src/a.ts", [2, 2], spec.test]]);
    assert.equal(await blobs.getText(truth[0]!.patch), BUG_PATCH);
    assert.match(readFileSync(join(out, "src", "a.ts"), "utf8"), /xs\[xs\.length\];/);
    assert.throws(() => readFileSync(join(out, ".git", "HEAD")), /ENOENT/);

    const v = await validateSeededTree({ dir: out, bugs: [spec, { ...spec, id: "b2", test: "true" }, { ...spec, id: "b3", test: undefined }] });
    assert.deepEqual(
      v.map((x) => [x.id, x.failsSeeded, x.passesReverted, x.ok]),
      [
        ["b1", true, true, true],
        ["b2", false, true, false],
        ["b3", false, false, false],
      ],
    );
    // The tree is left seeded.
    assert.match(readFileSync(join(out, "src", "a.ts"), "utf8"), /xs\[xs\.length\];/);
    await assert.rejects(buildSeededTree({ cleanDir: clean, outDir: join(root, "seeded2"), bugs: [{ ...spec, patch: BUG_PATCH.replace("xs.length - 1", "nope") }], blobs }), /git apply failed/);
  });
});
