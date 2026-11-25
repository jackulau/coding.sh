import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMutant, mutantsOf, quantifierChanges, selectMutants, tokenize, zeroOf } from "../../scripts/mutate.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/mutate.ts", import.meta.url));

const CLAMP = [
  "export function clamp(n: number, lo: number, hi: number): number {",
  "  if (n < lo) return lo;",
  "  if (n > hi) return hi;",
  "  return n;",
  "}",
  "",
].join("\n");

/** The tokens of `js` as `type:value`. */
const tokens = (js: string): string[] => tokenize(js).map((t) => `${t.type}:${t.value}`);

describe("scripts/mutate.ts", () => {
  it("reads a slash as a regular expression where an expression starts, and as a division after a value", () => {
    assert.deepEqual(tokens("const a = b / c / d;"), ["id:const", "id:a", "punct:=", "id:b", "punct:/", "id:c", "punct:/", "id:d", "punct:;"]);
    assert.deepEqual(tokens("f(a) / 2; x[0] / 2;").filter((t) => t.startsWith("punct:/")), ["punct:/", "punct:/"]);
    assert.deepEqual(tokens("const r = /a\\/b[/]+/g.test(x);").slice(3, 5), ["regex:/a\\/b[/]+/g", "punct:."]);
    assert.deepEqual(tokens("return /y/;"), ["id:return", "regex:/y/", "punct:;"]);
  });

  it("keeps comments out of the tokens and a template's text in tmpl tokens, with its expressions as code", () => {
    assert.deepEqual(tokens('a // x / y\n/* b / c */ d "it\'s // no"'), ["id:a", "id:d", "str:\"it's // no\""]);
    assert.deepEqual(tokens("`a${b / 2}c${`d${e}`}`"), ["tmpl:`a${", "id:b", "punct:/", "num:2", "tmpl:}c${", "tmpl:`d${", "id:e", "tmpl:}`", "tmpl:}`"]);
  });

  it("makes mutants of code only, never of comments, strings or types, each with a line:column id", () => {
    const source = [
      "// if (a < b) return 1;",
      "export function f(a: number, b: number): number {",
      '  const s = "a < b && !c" + `x ${a > 1 ? "<" : ">"} y`;',
      "  type T = Array<1 | 2>; /* a <= b */",
      "  if (!(a < b)) return 1;",
      "  return s.length > 2 ? 3 : 4;",
      "}",
      "const r = /^x_([0-9a-z]{8,14})$/;",
      "",
    ].join("\n");
    const ms = mutantsOf(source);
    assert.deepEqual(
      ms.map((m) => `${m.id} ${source.slice(m.start, m.end)} => ${m.replacement}`),
      [
        "return-zero@2:50  =>  return 0;",
        "cmp-boundary@3:36 > => >=",
        "cmp-negate@3:36 > => <=",
        "num-dec@3:38 1 => 0",
        "num-inc@3:38 1 => 2",
        "drop-stmt@5:3 if (!(a < b)) return 1; => ",
        // The ! that starts the condition is not dropped: negate-cond already covers it.
        "negate-cond@5:7 !(a < b) => !(!(a < b))",
        "cmp-boundary@5:11 < => <=",
        "cmp-negate@5:11 < => >=",
        "num-dec@5:24 1 => 0",
        "num-inc@5:24 1 => 2",
        "drop-stmt@6:3 return s.length > 2 ? 3 : 4; => ",
        "cmp-boundary@6:19 > => >=",
        "cmp-negate@6:19 > => <=",
        "num-dec@6:21 2 => 1",
        "num-inc@6:21 2 => 3",
        "num-dec@6:25 3 => 2",
        "num-inc@6:25 3 => 4",
        "num-dec@6:29 4 => 3",
        "num-inc@6:29 4 => 5",
        "regex-quant@8:24 {8,14} => {9,14}",
        "regex-quant@8:24~2 {8,14} => {7,14}",
        "regex-quant@8:24~3 {8,14} => {8,13}",
        "regex-quant@8:24~4 {8,14} => {8,15}",
      ],
    );
    for (const m of ms) {
      const line = source.split("\n")[m.line - 1] ?? "";
      assert.equal(source.slice(m.start, m.end), line.slice(m.column - 1, m.column - 1 + m.end - m.start), m.id);
      assert.doesNotThrow(() => stripTypeScriptTypes(applyMutant(source, m)), m.id);
    }
  });

  it("changes each quantifier of a regular expression, outside character classes and escapes", () => {
    assert.deepEqual(
      quantifierChanges("[0-9a-z]{8,14}").map((q) => q.to),
      ["{9,14}", "{7,14}", "{8,13}", "{8,15}"],
    );
    // A lazy quantifier turns into the other one, and loses its laziness.
    assert.deepEqual(quantifierChanges("a+?b"), [
      { start: 1, end: 3, to: "*?" },
      { start: 2, end: 3, to: "" },
    ]);
    assert.deepEqual(
      quantifierChanges("[a+*]\\d{2}x{2,}(?:ab)*\\p{L}+\\+").map((q) => q.to),
      ["{1}", "{3}", "{1,}", "{3,}", "+", "*"],
    );
  });

  it("returns the zero of the declared return type, and a plain return where it has none", () => {
    const cases: [string, boolean, string][] = [
      [": number", false, "0"],
      [": bigint", false, "0n"],
      [": string", false, '""'],
      [": boolean", false, "false"],
      [": 42", false, "42"],
      [": string[]", false, "[]"],
      [": readonly Token[]", false, "[]"],
      [": Map<string, number>", false, "new Map()"],
      [": Set<string>", false, "new Set()"],
      [": Record<string, number>", false, "{}"],
      [": { a: number }", false, "{}"],
      [": Session | null", false, "null"],
      [": x is string", false, "false"],
      [": Promise<number>", true, "0"],
      [": Promise<number>", false, "Promise.resolve(0)"],
      [": string | undefined", false, ""],
      [": void", false, ""],
      [": Promise<void>", true, ""],
      [": asserts x", false, ""],
      [": Token", false, ""],
      ["", false, ""],
    ];
    for (const [annotation, isAsync, zero] of cases) assert.equal(zeroOf(annotation, isAsync), zero, `${annotation} (async ${isAsync})`);
  });

  it("selects the same mutants every time, at most the budget, shared between operators and spread over the file", () => {
    const all = [
      ...Array.from({ length: 100 }, (_, i) => ({ op: "a", start: i * 3 })),
      ...Array.from({ length: 10 }, (_, i) => ({ op: "b", start: i * 30 + 1 })),
      ...Array.from({ length: 3 }, (_, i) => ({ op: "c", start: i * 100 + 2 })),
    ].sort((x, y) => x.start - y.start);
    const chosen = selectMutants(all, 30);
    assert.deepEqual(selectMutants(all, 30), chosen);
    assert.equal(chosen.length, 30);
    assert.deepEqual(chosen.map((m) => m.start), [...chosen.map((m) => m.start)].sort((x, y) => x - y));
    const of = (op: string): number[] => chosen.filter((m) => m.op === op).map((m) => m.start);
    // b and c are taken whole; a gets the rest of the budget.
    assert.equal(of("b").length, 10);
    assert.equal(of("c").length, 3);
    assert.equal(of("a").length, 17);
    assert.ok((of("a")[0] ?? Infinity) < 30 && (of("a").at(-1) ?? 0) > 270, `a is not spread over the file: ${of("a").join(" ")}`);
    assert.equal(selectMutants(all, 500).length, all.length);
  });

  it("runs the named tests against each mutant in a copy, leaves the package as it was and removes the copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutate-test-"));
    try {
      const pkg = join(dir, "pkg");
      const tmp = join(dir, "tmp");
      mkdirSync(join(pkg, "src"), { recursive: true });
      mkdirSync(join(pkg, "test"));
      mkdirSync(tmp);
      writeFileSync(join(pkg, "src", "clamp.ts"), CLAMP);
      writeFileSync(
        join(pkg, "test", "clamp.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { clamp } from "../src/clamp.ts";',
          // No test at the bounds themselves, so moving a bound by one goes unseen.
          'test("clamp", () => {',
          "  assert.equal(clamp(-5, 0, 10), 0);",
          "  assert.equal(clamp(50, 0, 10), 10);",
          "  assert.equal(clamp(5, 0, 10), 5);",
          "});",
          "",
        ].join("\n"),
      );
      writeFileSync(join(pkg, "test", "fails.test.ts"), 'import { test } from "node:test";\ntest("fails", () => { throw new Error("no"); });\n');
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
      delete env.NODE_TEST_CONTEXT;
      const mutate = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", SCRIPT, "--package", pkg, "--file", "src/clamp.ts", ...args], { env, encoding: "utf8", timeout: 120_000 });

      const list = mutate("--list", "--max", "4");
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /^src\/clamp\.ts: 10 mutants \(cmp-boundary 2, cmp-negate 2, drop-stmt 3, negate-cond 2, return-zero 1\)$/m);
      assert.match(list.stdout, /^running 4: .*; left out 6: /m);
      assert.equal(list.stdout.split("\n").filter((l) => l.startsWith("* ")).length, 4);
      assert.match(mutate("--list", "--max", "0").stderr, /--max takes a whole number of 1 or more, not 0/);

      const json = join(dir, "run.json");
      const run = mutate("--test", "test/clamp.test.ts", "--jobs", "2", "--json", json);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /kill rate 80\.0%/);
      const saved = JSON.parse(readFileSync(json, "utf8")) as { file: string; tests: string[]; results: { id: string; status: string }[]; left: unknown[] };
      assert.equal(saved.file, "src/clamp.ts");
      assert.deepEqual(saved.tests, ["test/clamp.test.ts"]);
      assert.equal(saved.results.length, 10);
      assert.deepEqual(saved.left, []);
      assert.deepEqual(saved.results.filter((r) => r.status !== "killed").map((r) => `${r.status} ${r.id}`), ["survived cmp-boundary@2:9", "survived cmp-boundary@3:9"]);

      // --survivors runs only the mutants a saved run lists as survived.
      const again = mutate("--test", "test/clamp.test.ts", "--jobs", "2", "--survivors", json);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /^running 2: cmp-boundary 2; left out 8: /m);

      // Tests that fail without a mutant stop the run before any mutant.
      const failing = mutate("--test", "test/fails.test.ts");
      assert.equal(failing.status, 1);
      assert.match(failing.stderr, /the tests fail without a mutant/);

      assert.equal(readFileSync(join(pkg, "src", "clamp.ts"), "utf8"), CLAMP);
      assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("coding-sh-mutate-")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
