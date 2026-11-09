import assert from "node:assert/strict";
import { test } from "node:test";
import { blankJs, lineOf, lineStarts, skipType, stringsOnly } from "../lib/source.mjs";

test("blankJs keeps length and newlines, blanks comments and literal text", () => {
  const src = 'const a = "x as unknown as y"; // as unknown as\n/* block\n as any as */ const b = \'q\';\n';
  const b = blankJs(src);
  assert.equal(b.length, src.length);
  assert.equal(b.split("\n").length, src.split("\n").length);
  assert.doesNotMatch(b, /unknown|any|block|q/);
  assert.match(b, /const a = " +";/);
  assert.match(b, /const b = ' ';/);
});

test("blankJs keeps template expressions as code, including nested templates", () => {
  const src = "const t = `a ${x as unknown as T} b ${`in ${y}`} c`; z;";
  const b = blankJs(src);
  assert.match(b, /x as unknown as T/);
  assert.match(b, /\by\b/);
  assert.doesNotMatch(b, /\ba\b|\bb\b|\bc\b|\bin\b/);
  assert.match(b, /z;$/);
});

test("blankJs tells a regex from a division", () => {
  const b = blankJs("const r = /as unknown as/g; const d = a / b / c; return /x/.test(s);");
  assert.doesNotMatch(b, /unknown/);
  assert.match(b, /a \/ b \/ c/);
  assert.doesNotMatch(b, /\/x\//);
});

test("blankJs handles object braces inside template expressions", () => {
  const b = blankJs("const s = `${fn({ a: 1 })} tail`; after;");
  assert.match(b, /fn\(\{ a: 1 \}\)/);
  assert.doesNotMatch(b, /tail/);
  assert.match(b, /after;$/);
});

test("stringsOnly keeps literal text and nothing else", () => {
  const s = stringsOnly('// planned\nconst x = "coming soon"; const r = /planned/;\n');
  assert.match(s, /coming soon/);
  assert.doesNotMatch(s, /planned|const/);
});

test("skipType walks unions, generics, objects and function types", () => {
  const cases = [
    ["Map<string, Array<number>> as X", "Map<string, Array<number>>"],
    ["{ id: string } | null as X", "{ id: string } | null"],
    ["() => void as X", "() => void"],
    ["string[] as X", "string[]"],
    ["keyof T as X", "keyof T"],
    ["A || b", "A"],
  ];
  for (const [src, type] of cases) assert.equal(src.slice(0, skipType(src, 0)), type, src);
});

test("lineOf maps offsets to 1-based lines", () => {
  const s = "a\nbb\n\nccc";
  const starts = lineStarts(s);
  assert.deepEqual([0, 1, 2, 4, 5, 6, 9].map((o) => lineOf(starts, o)), [1, 1, 2, 2, 3, 4, 4]);
});
