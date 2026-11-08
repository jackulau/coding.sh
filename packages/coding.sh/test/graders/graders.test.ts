import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import type { GradeContext } from "../../src/datasets/types.ts";
import {
  coerceGrade,
  commandGrader,
  containsGrader,
  createGrader,
  exactGrader,
  functionGrader,
  jsonPathGrader,
  jsonSchemaGrader,
  levenshtein,
  moduleGrader,
  normalizeText,
  numericGrader,
  queryJsonPath,
  regexGrader,
  runProcess,
  similarity,
  similarityGrader,
  toNumber,
} from "../../src/graders/index.ts";

const ctx = (output: unknown, expected?: unknown, extra: Partial<GradeContext> = {}): GradeContext => ({ input: "q", output, expected, ...extra });
const fixtures = join(import.meta.dirname, "fixtures");
const scorer = (mode: string, timeoutMs?: number) =>
  commandGrader({ command: process.execPath, args: [join(fixtures, "scorer.mjs"), mode], ...(timeoutMs ? { timeoutMs } : {}) });

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codingsh-graders-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("exact", () => {
  it("trims by default and honors normalization options", async () => {
    assert.equal((await exactGrader().grade(ctx(" Paris\n", "Paris"))).pass, true);
    assert.equal((await exactGrader().grade(ctx("paris", "Paris"))).pass, false);
    assert.equal((await exactGrader({ normalize: { caseInsensitive: true } }).grade(ctx("paris", "Paris"))).pass, true);
    const loose = exactGrader({ normalize: { caseInsensitive: true, collapseWhitespace: true, stripPunctuation: true, unicode: true } });
    assert.equal((await loose.grade(ctx("Hello,   WORLD!", "hello world"))).pass, true);
    assert.equal((await loose.grade(ctx("ＡＢＣ", "abc"))).pass, true);
  });

  it("compares JSON values structurally and numbers by text", async () => {
    assert.equal((await exactGrader().grade(ctx({ b: [1], a: 1 }, { a: 1, b: [1] }))).pass, true);
    assert.equal((await exactGrader().grade(ctx({ a: 1 }, { a: 2 }))).pass, false);
    assert.equal((await exactGrader().grade(ctx("42", 42))).pass, true);
    assert.equal((await exactGrader({ value: "x" }).grade(ctx("x"))).pass, true);
    const none = await exactGrader().grade(ctx("x"));
    assert.equal(none.pass, false);
    assert.match(none.reason ?? "", /no expected/);
  });

  it("versions hash the config, not the name", () => {
    assert.equal(exactGrader({ name: "a" }).version, exactGrader({ name: "b" }).version);
    assert.notEqual(exactGrader().version, exactGrader({ normalize: { caseInsensitive: true } }).version);
    assert.equal(exactGrader({ name: "strict" }).id, "strict");
  });
});

describe("contains / regex", () => {
  it("all, any, partial score and negation", async () => {
    const all = await containsGrader({ value: ["alpha", "beta", "gamma"] }).grade(ctx("alpha and beta"));
    assert.equal(all.pass, false);
    assert.ok(Math.abs(all.score - 2 / 3) < 1e-9);
    assert.match(all.reason ?? "", /gamma/);
    assert.equal((await containsGrader({ value: ["x", "beta"], mode: "any" }).grade(ctx("alpha and beta"))).pass, true);
    assert.equal((await containsGrader({ normalize: { caseInsensitive: true } }).grade(ctx("The ANSWER is 4", "answer"))).pass, true);
    assert.equal((await containsGrader({ value: "password", negate: true }).grade(ctx("no secrets here"))).pass, true);
    assert.equal((await containsGrader({ value: "password", negate: true }).grade(ctx("the password is x"))).pass, false);
  });

  it("regex matches, flags, negate, and is not stateful under /g", async () => {
    const g = regexGrader({ pattern: "\\bTODO\\b", flags: "gi" });
    assert.equal((await g.grade(ctx("a todo item"))).pass, true);
    assert.equal((await g.grade(ctx("a todo item"))).pass, true);
    assert.equal((await regexGrader({ pattern: "rm -rf", negate: true }).grade(ctx("rm -rf /"))).pass, false);
    assert.throws(() => regexGrader({ pattern: "(" }));
  });
});

describe("json-schema grader", () => {
  const g = jsonSchemaGrader({ schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } });
  it("validates objects and JSON text (even fenced)", async () => {
    assert.equal((await g.grade(ctx({ city: "Paris" }))).pass, true);
    assert.equal((await g.grade(ctx('{"city":"Paris"}'))).pass, true);
    assert.equal((await g.grade(ctx('Sure!\n```json\n{"city": "Paris"}\n```'))).pass, true);
    const r = await g.grade(ctx({ town: "Paris" }));
    assert.equal(r.pass, false);
    assert.match(r.reason ?? "", /missing required property "city"/);
  });
  it("rejects a broken schema at construction", () => {
    assert.throws(() => jsonSchemaGrader({ schema: { $ref: "#/nope" } }), /not found/);
  });
});

describe("json-path", () => {
  const doc = { answer: { city: "Paris", tags: ["a", "b"] }, "odd key": 1, items: [{ id: 1 }, { id: 2 }] };
  it("queries the supported subset", () => {
    assert.deepEqual(queryJsonPath(doc, "$.answer.city"), ["Paris"]);
    assert.deepEqual(queryJsonPath(doc, "$['odd key']"), [1]);
    assert.deepEqual(queryJsonPath(doc, "$.answer.tags[-1]"), ["b"]);
    assert.deepEqual(queryJsonPath(doc, "$.items[*].id"), [1, 2]);
    assert.deepEqual(queryJsonPath(doc, "$..id"), [1, 2]);
    assert.deepEqual(queryJsonPath(doc, "answer.city"), ["Paris"]);
    assert.deepEqual(queryJsonPath(doc, "$.missing.x"), []);
    assert.throws(() => queryJsonPath(doc, "$[?(@.id)]"), /unsupported/);
  });
  it("compares against equals, the same path in expected, or expected itself", async () => {
    assert.equal((await jsonPathGrader({ path: "$.answer.city", equals: "Paris" }).grade(ctx(doc))).pass, true);
    assert.equal((await jsonPathGrader({ path: "$.answer.city" }).grade(ctx(JSON.stringify(doc), { answer: { city: "Paris" } }))).pass, true);
    assert.equal((await jsonPathGrader({ path: "$.answer.city" }).grade(ctx(doc, "Paris"))).pass, true);
    assert.equal((await jsonPathGrader({ path: "$.items[*].id" }).grade(ctx(doc, [1, 2]))).pass, true);
    const miss = await jsonPathGrader({ path: "$.nope", equals: 1 }).grade(ctx(doc));
    assert.match(miss.reason ?? "", /not found/);
    assert.equal((await jsonPathGrader({ path: "$.answer.city", equals: "paris", normalize: { caseInsensitive: true } }).grade(ctx(doc))).pass, true);
  });
});

describe("numeric", () => {
  it("parses numbers out of text", () => {
    assert.equal(toNumber("1,234.5"), 1234.5);
    assert.equal(toNumber("The answer is $42."), 42);
    assert.equal(toNumber("-3e2"), -300);
    assert.equal(toNumber("none"), undefined);
    assert.equal(toNumber(Number.NaN), undefined);
  });
  it("absolute and relative tolerance", async () => {
    assert.equal((await numericGrader().grade(ctx("42", 42))).pass, true);
    assert.equal((await numericGrader().grade(ctx(42.001, 42))).pass, false);
    assert.equal((await numericGrader({ abs: 0.01 }).grade(ctx(42.001, 42))).pass, true);
    assert.equal((await numericGrader({ rel: 0.05 }).grade(ctx(104, 100))).pass, true);
    assert.equal((await numericGrader({ rel: 0.05 }).grade(ctx(106, 100))).pass, false);
    assert.equal((await numericGrader().grade(ctx(0.1 + 0.2, 0.3))).pass, true);
    assert.equal((await numericGrader({ path: "$.total" }).grade(ctx({ total: "7" }, { total: 7 }))).pass, true);
    assert.match((await numericGrader().grade(ctx("n/a", 1))).reason ?? "", /no number/);
  });
});

describe("similarity", () => {
  it("levenshtein over code points", () => {
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(levenshtein("flaw", "lawn"), 2);
    assert.equal(levenshtein("😀a", "😀b"), 1);
    assert.equal(similarity("", ""), 1);
    assert.ok(Math.abs(similarity("kitten", "sitting") - (1 - 3 / 7)) < 1e-12);
  });
  it("passes at the threshold with the similarity as score", async () => {
    const r = await similarityGrader({ threshold: 0.5 }).grade(ctx("kitten", "sitting"));
    assert.equal(r.pass, true);
    assert.ok(Math.abs(r.score - 4 / 7) < 1e-12);
    assert.equal((await similarityGrader().grade(ctx("kitten", "sitting"))).pass, false);
    assert.throws(() => similarityGrader({ threshold: 2 }), /threshold/);
  });
  it("normalizeText order: punctuation before whitespace collapse", () => {
    assert.equal(normalizeText("  a , b  ", { stripPunctuation: true, collapseWhitespace: true }), "a b");
  });
});

describe("coerceGrade", () => {
  it("accepts booleans, numbers and objects; clamps scores", () => {
    assert.deepEqual(coerceGrade(true), { score: 1, pass: true });
    assert.deepEqual(coerceGrade(0.4), { score: 0.4, pass: false });
    assert.deepEqual(coerceGrade(7), { score: 1, pass: true });
    assert.deepEqual(coerceGrade({ pass: false }), { score: 0, pass: false });
    assert.deepEqual(coerceGrade({ score: 0.9, reason: "r", citations: [{ quote: "q", eventId: "e1" }, { bad: 1 }] }), {
      score: 0.9,
      pass: true,
      reason: "r",
      citations: [{ quote: "q", eventId: "e1" }],
    });
    assert.throws(() => coerceGrade({ ok: 1 }), /without "score" or "pass"/);
    assert.throws(() => coerceGrade("yes"), /expected boolean/);
  });
});

describe("command grader", () => {
  it("uses JSON stdout when present", async () => {
    const g = scorer("json");
    assert.deepEqual(await g.grade(ctx("a", "a")), { score: 1, pass: true, reason: "match" });
    assert.deepEqual(await g.grade(ctx("a", "b")), { score: 0.25, pass: false, reason: "want b" });
  });
  it("takes a bare number from the last line", async () => {
    assert.deepEqual(await scorer("number").grade(ctx("a", "a")), { score: 0.75, pass: true });
  });
  it("falls back to the exit code, with stderr as the reason", async () => {
    const g = scorer("exit");
    assert.equal((await g.grade(ctx("a", "a"))).pass, true);
    const r = await g.grade(ctx("a", "b"));
    assert.equal(r.pass, false);
    assert.match(r.reason ?? "", /exited 1: mismatch/);
  });
  it("receives the case id on stdin", async () => {
    assert.equal((await scorer("echo-case").grade(ctx("x", "y", { caseId: "c1" }))).pass, true);
  });
  it("a timeout is an error, not a fail", async () => {
    await assert.rejects(scorer("sleep", 300).grade(ctx("a", "a")), /timed out after 300 ms/);
  });
  it("a missing executable is an error", async () => {
    await assert.rejects(commandGrader({ command: "/nonexistent/scorer-bin" }).grade(ctx("a")), /could not start/);
  });
  // EXP-4: a stdout grade counts only from a clean exit; a signal or abort is an unknown grade.
  const nodeGrader = (script: string) => commandGrader({ command: process.execPath, args: ["-e", script] });
  it("a grade printed before a non-zero exit is a fail, not a pass", async () => {
    const r = await nodeGrader("console.log(1); process.exitCode = 3").grade(ctx("a"));
    assert.equal(r.pass, false);
    assert.match(r.reason ?? "", /exited 3/);
    assert.equal((await nodeGrader(`console.log('{"pass":true}'); process.exitCode = 1`).grade(ctx("a"))).pass, false);
  });
  // Windows has no signal exits: a process killing itself just exits with code 1.
  it("a grader killed by a signal is an error, even after printing a grade", { skip: process.platform === "win32" && "no signal exits on Windows" }, async () => {
    const g = nodeGrader("process.stdout.write('true\\n', () => process.kill(process.pid, 'SIGKILL'))");
    await assert.rejects(g.grade(ctx("a")), (e: Error) => e.name === "GraderError" && /SIGKILL/.test(e.message));
  });
  it("an aborted grade is an error, not a fail", async () => {
    const ac = new AbortController();
    const p = nodeGrader("setTimeout(() => {}, 30000)").grade(ctx("a", undefined, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, (e: Error) => e.name === "GraderError" && /aborted/.test(e.message));
  });
  it("env values stay out of the version hash", () => {
    const a = commandGrader({ command: "x", env: { TOKEN: "secret-1" } });
    const b = commandGrader({ command: "x", env: { TOKEN: "secret-2" } });
    assert.equal(a.version, b.version);
  });
});

describe("runProcess", () => {
  it("caps output and reports truncation", async () => {
    const r = await runProcess({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(5000))"], maxOutputBytes: 100 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.length, 100);
    assert.equal(r.truncated, true);
  });
});

describe("module grader", () => {
  it("loads a file:// module's default export with options", async () => {
    const url = pathToFileURL(join(fixtures, "grader.mjs")).href;
    const g = await moduleGrader({ module: url, options: { upper: true } });
    assert.equal(g.kind, "module");
    assert.deepEqual(await g.grade(ctx("ABC", "abc")), { score: 1, pass: true, reason: "compared with ABC" });
    const named = await moduleGrader({ module: join(fixtures, "grader.mjs"), export: "lengthy" });
    assert.equal((await named.grade(ctx("abcd"))).pass, true);
    await assert.rejects(moduleGrader({ module: url, export: "nope" }), /no function export "nope"/);
    await assert.rejects(moduleGrader({ module: "https://example.com/g.mjs" }), /only loads local files/);
  });

  it("changes version (and reloads) when the module's code changes", async () => {
    const f = join(dir, "g.mjs");
    await writeFile(f, "export default () => true;\n");
    const g1 = await moduleGrader({ module: f });
    await writeFile(f, "export default () => false;\n");
    const g2 = await moduleGrader({ module: f });
    assert.notEqual(g1.version, g2.version);
    assert.equal((await g1.grade(ctx("x"))).pass, true);
    assert.equal((await g2.grade(ctx("x"))).pass, false);
  });

  it("functionGrader wraps an in-process function", async () => {
    const g = functionGrader("len", (c) => String(c.output).length / 10);
    assert.deepEqual(await g.grade(ctx("abcdef")), { score: 0.6, pass: true });
  });
});

describe("createGrader", () => {
  it("builds every deterministic kind from a spec, matching the direct constructor version", async () => {
    const spec = { kind: "exact" as const, normalize: { caseInsensitive: true } };
    assert.equal((await createGrader(spec)).version, exactGrader({ normalize: { caseInsensitive: true } }).version);
    for (const s of [
      { kind: "contains", value: "a" },
      { kind: "regex", pattern: "a" },
      { kind: "json-schema", schema: { type: "string" } },
      { kind: "json-path", path: "$.a" },
      { kind: "numeric", abs: 1 },
      { kind: "similarity" },
      { kind: "executability", kinds: ["schema", "state"], maxInvalid: 1 },
      { kind: "command", command: "true" },
      { kind: "module", module: "grader.mjs" },
    ] as const) {
      const g = await createGrader(s, { baseDir: fixtures });
      assert.equal(g.kind, s.kind);
    }
    await assert.rejects(createGrader({ kind: "nope" } as never), /unknown grader kind/);
  });

  it("an llm spec yields an uncalibrated judge grader", async () => {
    const g = await createGrader({ kind: "llm", name: "helpful", rubric: "Is it helpful?" }, { env: {} });
    assert.equal(g.kind, "llm");
    assert.match(g.version, /^helpful@[0-9a-f]{12}$/);
    assert.equal(g.calibration?.state, "uncalibrated");
    await assert.rejects(g.grade(ctx("x")), /set ANTHROPIC_API_KEY/);
  });

  it("an llm-checklist spec yields a checklist grader (QA: exp run rejected the kind)", async () => {
    const spec = { kind: "llm-checklist", name: "cl", items: [{ id: "num", question: "Is the output a single integer?" }] } as const;
    const g = await createGrader(spec, { env: {} });
    assert.equal(g.kind, "llm-checklist");
    assert.match(g.version, /^cl@[0-9a-f]{12}$/);
    assert.equal(g.calibration?.state, "uncalibrated");
    // Real provider by default: needs a key, so the grade fails loudly rather than faking a verdict.
    await assert.rejects(g.grade(ctx("4")), /set ANTHROPIC_API_KEY/);
    await assert.rejects(createGrader({ kind: "llm-checklist", name: "empty", items: [] }), /at least one item/);
    await assert.rejects(createGrader({ ...spec, mode: "nope" as never }), /mode must be/);
  });

  it("an all-predicate llm-checklist needs no provider and is deterministic", async () => {
    const g = await createGrader({ kind: "llm-checklist", name: "det", provider: "openai", items: [{ id: "ok", question: "Are the final tests green?", check: "final-tests-green" }] });
    assert.equal(g.kind, "llm-checklist");
    assert.equal(g.calibration, undefined);
  });

  it('provider "mock" grades offline, deterministically, and never touches the verdict cache', async () => {
    let fetched = 0;
    const fetch = (async () => {
      fetched++;
      throw new Error("network");
    }) as never;
    const writes: string[] = [];
    const judgeCache = { get: async () => undefined, set: async (v: string) => void writes.push(v) };
    const deps = { env: {}, fetch, judgeCache };
    const items = [
      { id: "num", question: "Is the output a single integer?" },
      { id: "short", question: "Is it short?", critical: true },
    ];
    for (const mode of ["per-item", "batched"] as const) {
      const yes = await createGrader({ kind: "llm-checklist", name: "cl", provider: "mock", mode, items }, deps);
      const r = await yes.grade(ctx("4"));
      assert.equal(r.pass, true, mode);
      assert.equal(r.score, 1, mode);
      const no = await createGrader({ kind: "llm-checklist", name: "cl", provider: "mock", mockAnswer: "no", mode, items }, deps);
      const rn = (await no.grade(ctx("4"))) as { pass: boolean; score: number; gatedBy: string[] };
      assert.equal(rn.pass, false, mode);
      assert.equal(rn.score, 0, mode);
      assert.deepEqual(rn.gatedBy, ["short"], mode);
      assert.notEqual(yes.version, no.version, "the mock answer is part of the version");
    }
    const llm = await createGrader({ kind: "llm", name: "helpful", rubric: "Helpful?", provider: "mock" }, deps);
    assert.match(llm.version, /^helpful@[0-9a-f]{12}$/);
    assert.equal(llm.calibration?.state, "uncalibrated");
    const v = await llm.grade(ctx("x"));
    assert.equal(v.pass, true);
    assert.match(String(v.reason), /mock/);
    const real = await createGrader({ kind: "llm", name: "helpful", rubric: "Helpful?" }, deps);
    assert.notEqual(real.version, llm.version, "mock and real judges never share a version");
    assert.equal(fetched, 0);
    assert.deepEqual(writes, []);
  });

  it("an unknown provider is rejected instead of silently falling back", async () => {
    await assert.rejects(createGrader({ kind: "llm", name: "x", rubric: "r", provider: "gemini" as never }), /unknown provider "gemini"/);
    await assert.rejects(createGrader({ kind: "llm", name: "x", rubric: "r", provider: "mock", mockAnswer: "maybe" as never }), /answer must be "yes" or "no"/);
  });
});
