// The property-test helper (test/_prop.ts) on properties whose answer is known: shrinking reaches the smallest
// counterexample, a seed replays the same cases, and a passing property runs the cases it was asked for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assume, forAll, formatValue, gen, PropertyFailure, replay, sample, xoshiro128ss, type ForAllOptions, type Gen } from "../_prop.ts";

/** No CODING_SH_PROP_* from the shell that runs the tests: these assert exact counts and seeds. */
const ENV = {};

async function failure<T>(g: Gen<T>, prop: (v: T) => void | boolean | Promise<void | boolean>, opts: ForAllOptions = {}): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, { env: ENV, ...opts });
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail("expected the property to fail");
}

test("xoshiro128** matches the reference outputs for state [1, 2, 3, 4]", () => {
  const next = xoshiro128ss([1, 2, 3, 4]);
  assert.deepEqual([next(), next(), next()], [11520, 0, 5927040]);
});

test("int draws map to values by distance from the origin, inside the range", () => {
  const g = gen.int(-5, 3);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => replay(g, [d])),
    [0, 1, -1, 2, -2, 3, -3, -4, -5],
  );
  // Past the end of the range a replayed draw is clamped; past the end of the draws it is 0.
  assert.equal(replay(g, [1_000]), -5);
  assert.equal(replay(gen.int(5, 9), []), 5);
  assert.equal(replay(gen.int(-9, -5), [1]), -6);
  const values = sample(g, 500, 7);
  assert.ok(values.every((v) => v >= -5 && v <= 3));
  assert.ok(values.includes(-5) && values.includes(3), "edges are drawn");
});

test("shrinking finds the smallest failing number", async () => {
  const f = await failure(gen.int(0, 10_000), (n) => n < 500, { label: "n < 500" });
  assert.equal(f.counterexample, 500);
  assert.ok(f.shrinks > 0);
  assert.match(f.message, /seed \d+/);
  assert.match(f.message, /input: 500\n/);
  assert.match(f.message, /CODING_SH_PROP_SEED=\d+ node --no-warnings --test \S*prop\.test\.ts/);
});

test("shrinking removes array items whole and lowers what is left", async () => {
  const items = await failure(gen.array(gen.int(0, 1000)), (xs) => xs.every((x) => x < 50), { label: "every item below 50" });
  assert.deepEqual(items.counterexample, [50]);
  const length = await failure(gen.array(gen.int(0, 1000)), (xs) => xs.length < 3, { label: "fewer than 3 items" });
  assert.deepEqual(length.counterexample, [0, 0, 0]);
});

test("shrinking strings: toward the alphabet's first character, and to the one that matters", async () => {
  const short = await failure(gen.string(), (s) => s.length < 4, { label: "short ASCII" });
  assert.equal(short.counterexample, "aaaa");
  const noB = await failure(gen.string({ alphabet: "xyzb" }), (s) => !s.includes("b"), { label: "no b" });
  assert.equal(noB.counterexample, "b");
});

test("shrinking goes through chain: the length and the items shrink together", async () => {
  const g = gen.chain(gen.int(0, 10), (n) => gen.map(gen.array(gen.int(0, 100), { minLength: n, maxLength: n }), (xs) => ({ n, xs })));
  const f = await failure(g, ({ xs }) => xs.length < 3 || (xs[2] ?? 0) < 5, { label: "third item below 5" });
  assert.deepEqual(f.counterexample, { n: 3, xs: [0, 0, 5] });
});

test("shrinking through oneOf, records and JSON reaches the simplest failing shape", async () => {
  const shape = gen.record({ name: gen.string(), tags: gen.array(gen.oneOf(gen.constant("a"), gen.string({ minLength: 2 }))) });
  const f = await failure(shape, (r) => r.tags.length === 0 || r.tags.every((t) => t.length < 2), { label: "short tags" });
  assert.deepEqual(f.counterexample, { name: "", tags: ["aa"] });
  const j = await failure(gen.json(), (v) => !Array.isArray(v) || v.length === 0, { label: "no nonempty array" });
  assert.deepEqual(j.counterexample, [null]);
});

test("a thrown error fails the case like false does, and becomes the cause", async () => {
  const f = await failure(gen.int(0, 100), async (n) => {
    await Promise.resolve();
    assert.ok(n < 10, `n is ${n}`);
  }, { label: "async throw" });
  assert.equal(f.counterexample, 10);
  assert.ok(f.cause instanceof Error);
  assert.match(f.message, /n is 10/);
});

test("a seed replays the same cases; CODING_SH_PROP_SEED overrides the run's seed", async () => {
  const g = gen.array(gen.unicodeString());
  assert.deepEqual(sample(g, 30, 42), sample(g, 30, 42));
  assert.notDeepEqual(sample(g, 30, 42), sample(g, 30, 43));
  const seen = async (opts: ForAllOptions) => {
    const out: unknown[] = [];
    const r = await forAll(g, (v) => void out.push(v), { runs: 25, ...opts });
    return { out, seed: r.seed };
  };
  const byOption = await seen({ env: ENV, seed: 1234 });
  const byEnv = await seen({ env: { CODING_SH_PROP_SEED: "1234" }, seed: 99 });
  assert.equal(byEnv.seed, 1234);
  assert.deepEqual(byEnv.out, byOption.out);
  // The default seed comes from the label, so a run is the same every time.
  assert.deepEqual((await seen({ env: ENV, label: "same" })).out, (await seen({ env: ENV, label: "same" })).out);
});

test("a failure's seed replays the same failure", async () => {
  const prop = (xs: number[]) => xs.reduce((a, x) => Math.max(a, x), 0) < 700;
  const g = gen.array(gen.int(0, 1000));
  const first = await failure(g, prop, { label: "max below 700" });
  const again = await failure(g, prop, { env: { CODING_SH_PROP_SEED: String(first.seed) } });
  assert.equal(again.seed, first.seed);
  assert.equal(again.caseIndex, first.caseIndex);
  assert.deepEqual(again.counterexample, first.counterexample);
  await assert.rejects(forAll(gen.bool, () => true, { env: { CODING_SH_PROP_SEED: "-3" } }), /CODING_SH_PROP_SEED must be/);
});

test("a failure past the default count names the run's CODING_SH_PROP_RUNS, and its hint replays it", async () => {
  const g = gen.int(0, 2 ** 30);
  const seed = 77;
  const values = sample(g, 1000, seed);
  // The first case past the default 100 whose value no earlier case had: the property first fails there.
  const k = values.findIndex((v, i) => i >= 100 && !values.slice(0, i).includes(v));
  assert.ok(k >= 100);
  const prop = (n: number) => n !== values[k];
  const f = await failure(g, prop, { seed, env: { CODING_SH_PROP_RUNS: "1000" } });
  assert.equal(f.caseIndex, k);
  const vars = /Replay: ((?:CODING_SH_PROP_\w+=\S+ )+)node /.exec(f.message)?.[1];
  assert.ok(vars, f.message);
  const env = Object.fromEntries(vars.trim().split(" ").map((v) => v.split("=")));
  assert.deepEqual(env, { CODING_SH_PROP_SEED: "77", CODING_SH_PROP_RUNS: "1000" });
  const again = await failure(g, prop, { env });
  assert.equal(again.caseIndex, k);
  assert.deepEqual(again.counterexample, f.counterexample);
  // The seed alone stops at the default count, before the failing case.
  assert.equal((await forAll(g, prop, { env: { CODING_SH_PROP_SEED: "77" } })).runs, 100);
});

test("a passing property runs the cases asked for; CODING_SH_PROP_RUNS raises the count, never lowers it", async () => {
  const count = async (opts: ForAllOptions) => {
    let n = 0;
    const r = await forAll(gen.int(0, 9), () => void n++, opts);
    assert.equal(r.runs, n);
    return n;
  };
  assert.equal(await count({ env: ENV }), 100);
  assert.equal(await count({ env: ENV, runs: 37 }), 37);
  assert.equal(await count({ env: { CODING_SH_PROP_RUNS: "60" }, runs: 10 }), 60);
  assert.equal(await count({ env: { CODING_SH_PROP_RUNS: "5" }, runs: 50 }), 50);
});

test("discarded cases do not count as runs, and too many make forAll give up", async () => {
  let evens = 0;
  const r = await forAll(gen.int(0, 1000), (n) => {
    assume(n % 2 === 0);
    evens++;
  }, { env: ENV, runs: 40 });
  assert.equal(r.runs, 40);
  assert.equal(evens, 40);
  assert.ok(r.discarded > 0);
  await assert.rejects(forAll(gen.filter(gen.int(0, 10), () => false), () => true, { env: ENV, runs: 5 }), /gave up/);
});

test("the unicode generator makes surrogate pairs, combining marks, control characters and lone surrogates", () => {
  // With the u flag a surrogate pair is one code point, so this class matches only a lone surrogate.
  const lone = /[\ud800-\udfff]/u;
  const all = sample(gen.unicodeString(), 400, 5).join("");
  assert.match(all, /[\u{10000}-\u{10ffff}]/u, "an astral code point");
  assert.match(all, /[̀-ͯ]/, "a combining mark");
  assert.match(all, /[\u0000-\u001f]/, "a control character");
  assert.match(all, lone, "a lone surrogate");
  const wellFormed = sample(gen.unicodeString({ loneSurrogates: false }), 400, 5);
  assert.ok(wellFormed.every((s) => !lone.test(s)));
});

test("generated JSON survives a round trip through JSON text", async () => {
  await forAll(gen.json({ maxDepth: 4 }), (v) => {
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
  }, { env: ENV, label: "json round trip" });
});

test("formatValue shows what JSON would hide", () => {
  assert.equal(formatValue(-0), '"-0"');
  assert.equal(formatValue([undefined, Number.NaN]), '["<undefined>","NaN"]');
  assert.equal(formatValue("\ud800"), '"\\ud800"');
  const loop: { self?: unknown } = {};
  loop.self = loop;
  assert.match(formatValue(loop), /Circular/);
});
