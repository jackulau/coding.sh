// fitAnswer and the replay pagers: an answer is cut to the character limit by one budget allocation,
// only when it does not fit, never in the ids and paths, and without a retry loop that can stall.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitAnswer, pageIndex, pageRange, pageStep } from "../../src/mcp/replay-page.ts";

type Obj = Record<string, any>;
const CAP = 24_940;
const len = (v: unknown) => JSON.stringify(v).length;
const step = { n: 2, ts: 1, kind: "edit", label: "Edit src/a.ts", eventId: "e" };
const view = (detail: Obj, extra: Obj = {}) => ({ sessionId: "s", steps: 3, step, detail, tree: [], changes: [], ...extra }) as never;
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};

describe("fitAnswer", () => {
  it("leaves an answer that fits alone, with no note", () => {
    const a = { x: "y".repeat(1000), list: [1, 2, 3] };
    assert.equal(fitAnswer(a, CAP), a);
  });

  it("fits 2,000 short keys, whatever their count, without cutting ids or the note", () => {
    const input: Obj = {};
    for (let i = 0; i < 2000; i++) input[`key${i}`] = "v".repeat(20);
    const tree = [{ path: `src/${"d".repeat(80)}.ts`, status: "modified", edits: 1, lastStep: 2 }];
    const p = pageStep(view({ input }, { tree }), 0, 100, CAP) as Obj;
    assert.ok(len(p) <= CAP, `${len(p)} characters`);
    assert.equal(p.truncated, true);
    assert.match(p.note, /^Text and lists were cut .* one file's content\.$/);
    assert.equal(p.noteTruncated, undefined);
    assert.equal(p.tree[0].path, tree[0]!.path, "a path is never cut");
    assert.equal(p.detail.inputTruncated, true);
    assert.equal(p.detail.input.truncatedKeys, undefined, "nothing is written inside a recorded input");
    assert.ok(Object.keys(p.detail.input).length > 100, "the first keys are kept whole");
  });

  it("cuts text nested 12 levels (and 100 KB strings in nested arrays)", () => {
    for (const depth of [1, 9, 10, 12, 40]) {
      let o: unknown = { text: "z".repeat(100_000) };
      for (let i = 0; i < depth; i++) o = { child: o };
      const p = pageStep(view({ input: o as Obj }), 0, 100, CAP) as Obj;
      assert.ok(len(p) <= CAP, `depth ${depth}: ${len(p)}`);
      assert.equal(p.detail.inputTruncated, true);
    }
    let a: unknown = "z".repeat(100_000);
    for (let i = 0; i < 12; i++) a = [a];
    assert.ok(len(pageStep(view({ input: { a } }), 0, 100, CAP)) <= CAP);
  });

  it("stays fast with thousands of keys holding small arrays (no quadratic retry)", () => {
    for (const n of [1000, 4000, 20_000]) {
      const input: Obj = {};
      for (let i = 0; i < n; i++) input[`k${i}`] = { tags: ["a", "b", "c", "d"] };
      const [p, ms] = timed(() => pageStep(view({ input }), 0, 100, CAP));
      assert.ok(len(p) <= CAP, `${n} keys: ${len(p)}`);
      assert.ok(ms < 5000, `${n} keys took ${Math.round(ms)} ms`);
    }
    const [p, ms] = timed(() => pageStep(view({ input: { content: "x".repeat(5_000_000) } }), 0, 100, CAP));
    assert.ok(len(p) <= CAP && ms < 5000, `5 MB string: ${Math.round(ms)} ms`);
  });

  it("keeps a cut item of a list whose first item is large (two 8 KB edits; an 18 KB fork trial)", () => {
    const edits = [0, 1].map((i) => ({ old_string: `old${i}`.padEnd(8000, "o"), new_string: `new${i}`.padEnd(8000, "n") }));
    const p = pageStep(view({ input: { file_path: "src/b.ts", edits } }), 0, 100, CAP) as Obj;
    assert.ok(len(p) <= CAP);
    assert.equal(p.detail.input.edits.length, 2, "both edits stay, cut");
    assert.ok(p.detail.input.edits[0].old_string.length > 1000);
    const fork = {
      sessionId: "s",
      recorded: { action: { name: "Write", input: { file_path: "src/a.ts", content: "r".repeat(9000) } } },
      trials: [{ action: { name: "Write", input: { file_path: "src/a.ts", content: "f".repeat(18_000) } }, label: "Write src/a.ts", differs: true }],
    };
    const q = fitAnswer(structuredClone(fork), CAP) as Obj;
    assert.ok(len(q) <= CAP);
    assert.equal(q.trials.length, 1, "the trial stays, cut");
    assert.equal(q.trials[0].action.input.content.length > 1000, true);
    assert.equal(q.trials[0].action.input.file_path, "src/a.ts");
  });

  it("uses the budget: eight 16 KB diffs get about a third of the answer each", () => {
    const diffs = Array.from({ length: 8 }, (_, i) => ({ name: `d${i}`, diff: "d".repeat(16_000) }));
    const p = fitAnswer({ sessionId: "s", diffs }, CAP) as Obj;
    assert.ok(len(p) <= CAP);
    assert.ok(len(p) >= CAP * 0.9, `${len(p)} of ${CAP} used`);
    const each = p.diffs.map((d: Obj) => d.diff.length);
    assert.ok(Math.min(...each) >= 2800, `each diff keeps ${Math.min(...each)} characters`);
    assert.ok(p.diffs.every((d: Obj) => d.diffTruncated === true));
  });

  it("counts JSON escapes: 40 KB of lines is cut to what fits, not far below it", () => {
    const p = pageStep(view({ output: "a\n".repeat(20_000) }), 0, 100, CAP) as Obj;
    assert.ok(len(p) <= CAP);
    assert.ok(len(p) >= CAP - 700, `${len(p)} characters of ${CAP}`);
    assert.ok(p.detail.output.length > 8000, `kept ${p.detail.output.length} characters of 40,000`);
    assert.equal(p.detail.outputTruncated, true);
  });

  it("cuts between characters: no half of an emoji", () => {
    for (const s of ["😀".repeat(20_000), "漢".repeat(40_000), "a😀".repeat(15_000)]) {
      const p = pageStep(view({ output: s }), 0, 100, CAP) as Obj;
      assert.ok(len(p) <= CAP);
      assert.doesNotMatch(p.detail.output as string, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("falls back to replacing the largest entry when protected text alone is too long", () => {
    const p = fitAnswer({ sessionId: "s".repeat(30_000), detail: { output: "x".repeat(500) }, n: 3 }, CAP) as Obj;
    assert.ok(len(p) <= CAP, `${len(p)} characters`);
    assert.deepEqual(p.sessionId, { truncated: true, chars: 30_002 });
    assert.equal(p.truncated, true);
    assert.equal(p.n, 3);
  });
});

describe("the replay pagers choose whole rows first", () => {
  it("a step list with fewer rows than asked keeps its rows uncut and says limitUsed", () => {
    const steps = Array.from({ length: 150 }, (_, i) => ({ n: i + 1, ts: 1, kind: "shell", label: `$ cd packages/app && npm run test -- --filter ${"some-long-feature-name/".repeat(3)}Widget${i}.test.tsx --reporter=dot`.padEnd(400, "!"), eventId: `e${i}`, files: [{ path: `src/f${i}.ts`, op: "add" }] }));
    const files = Array.from({ length: 150 }, (_, i) => `packages/app/src/features/some-long-feature-name/components/Widget${i}.tsx`);
    const index = { sessionId: "s", steps, files, baseline: "none" } as never;
    const seen: number[] = [];
    let offset = 0;
    for (let g = 0; g < 20; g++) {
      const p = pageIndex(index, offset, 100, CAP) as Obj;
      assert.ok(len(p) <= CAP);
      if (g === 0) assert.ok(p.limitUsed > 0 && p.limitUsed < 100, `limitUsed ${p.limitUsed}`);
      assert.equal(p.truncated, undefined, "no cut when whole rows fit");
      assert.ok(p.steps.every((s: Obj, i: number) => s.label === steps[offset + i]!.label && s.labelTruncated === undefined));
      seen.push(...p.steps.map((s: Obj) => s.n));
      if (!p.nextCursor) break;
      offset = Number(p.nextCursor);
    }
    assert.equal(new Set(seen).size, 150);
  });

  it("a step page never cuts a tree path, and later pages are short", () => {
    const tree = Array.from({ length: 150 }, (_, i) => ({ path: `packages/app/src/features/some-long-feature-name/components/Widget${String(i).padStart(4, "0")}.tsx`, status: "modified", edits: 1, lastStep: 2 }));
    const v = view({ output: "o".repeat(9000) }, { tree });
    const p = pageStep(v, 0, 1000, CAP) as Obj;
    assert.ok(len(p) <= CAP);
    assert.ok(p.limitUsed > 0 && p.limitUsed < 150);
    assert.equal(p.truncated, undefined, "fewer rows, not cut text");
    assert.ok(p.tree.every((t: Obj, i: number) => t.path === tree[i]!.path));
    assert.equal(p.detail.output.length, 9000);
  });

  it("a range page takes as many whole diffs as fit, and one that is too long alone is cut", () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, op: "modify", steps: [2], diff: "d".repeat(6000), exact: true }));
    const p = pageRange({ sessionId: "s", from: 1, to: 3, files, unchanged: [] } as never, 0, 100, CAP) as Obj;
    assert.equal(p.files.length, 4);
    assert.equal(p.limitUsed, 4);
    assert.equal(p.nextCursor, "4");
    assert.equal(p.truncated, undefined);
    const big = [{ path: "src/big.ts", op: "modify", steps: [2], diff: "d".repeat(60_000), exact: true }];
    const q = pageRange({ sessionId: "s", from: 1, to: 3, files: big, unchanged: [] } as never, 0, 100, CAP) as Obj;
    assert.ok(len(q) <= CAP);
    assert.equal(q.files[0].diffTruncated, true);
    assert.equal(q.files[0].path, "src/big.ts");
    assert.equal(q.truncated, true);
  });
});
