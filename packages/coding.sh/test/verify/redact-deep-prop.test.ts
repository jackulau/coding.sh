// Redaction at depth (core/redact.ts Redactor.value), checked on generated values up to 300 levels
// deep. The walk follows a value 64 levels down and redacts the objects and arrays below from a
// copy, so depth must not change what comes out. A case is a leaf and a path to it. The leaf is a
// vendor token (GitHub, Slack or AWS) between words, an object with a value under a secret-named
// key, a command line with a value after a secret flag, or a plain word. The path is 0 to 300
// levels, most often 60 to 70 or 100 to 300; each level is an object, with the next level under a
// plain key among plain words, numbers, booleans and nulls, or an array, with the next level among
// them.
//
// The properties: the leaf at the end of the path comes out as it does alone, the rest comes out as
// it went in, the tally counts what the leaf alone counts, and redacting the output again changes
// nothing. The last test shows the property fails on a walk that leaves the objects and arrays
// below 64 levels as they are.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, isSecretAttrKey, redactionTally, type RedactionTally } from "../../src/core/redact.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;
/** Objects and arrays this many levels down or more are redacted from a copy. */
const WALK_DEPTH = 65;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${UPPER}abcdefghijklmnopqrstuvwxyz0123456789`;
const alnum = (min: number, max: number): Gen<string> => gen.string({ alphabet: ALNUM, minLength: min, maxLength: max });

const WORDS = ["alpha", "build", "cache", "delta", "event", "field", "graph", "hello"];
const WORD = gen.pick(WORDS);
const TOKEN: Gen<string> = gen.oneOf(
  gen.map(gen.tuple(gen.pick(["p", "o", "u", "s", "r"]), alnum(36, 40)), ([c, body]) => ["gh", c, "_", body].join("")),
  gen.map(alnum(10, 24), (body) => ["xox", "b-", body].join("")),
  gen.map(gen.string({ alphabet: `${UPPER}0123456789`, minLength: 16, maxLength: 16 }), (body) => ["AK", "IA", body].join("")),
);
const SECRET_KEYS = ["password", "apiKey", "token", "client_secret"];
const LEAF: Gen<unknown> = gen.frequency<unknown>(
  [3, gen.map(gen.tuple(WORD, TOKEN, WORD), (p) => p.join(" "))],
  [2, gen.map(gen.tuple(gen.pick(SECRET_KEYS), alnum(8, 16)), ([k, v]) => ({ [k]: v, note: "alpha" }))],
  [2, gen.map(gen.tuple(gen.pick(["--api-key", "--token", "--db-password"]), alnum(8, 16)), ([flag, v]) => ["run", flag, v])],
  [1, WORD],
);

/** One level of the path: an object with the next level under `key`, or an array with it among the others. */
type Level = { key: string; before: unknown[]; after: unknown[] } | { key?: undefined; before: unknown[]; after: unknown[] };
type DeepCase = [path: Level[], leaf: unknown];

/** Keys no rule takes for a secret's name. The other entries of an object are a0, a1, z0 and z1. */
const PLAIN_KEYS = ["data", "items", "next", "child", "node", "body", "meta", "list"];
const FILLER: Gen<unknown> = gen.frequency<unknown>([3, WORD], [1, gen.int(0, 99)], [1, gen.bool], [1, gen.constant(null)]);
const FILLERS = gen.array(FILLER, { maxLength: 2 });
const LEVEL: Gen<Level> = gen.oneOf<Level>(
  gen.map(gen.tuple(gen.pick(PLAIN_KEYS), FILLERS, FILLERS), ([key, before, after]) => ({ key, before, after })),
  gen.map(gen.tuple(FILLERS, FILLERS), ([before, after]) => ({ before, after })),
);
const DEPTH = gen.frequency([2, gen.int(0, 10)], [3, gen.int(60, 70)], [3, gen.int(100, 300)]);
const CASE: Gen<DeepCase> = gen.chain(DEPTH, (n) => gen.tuple(gen.array(LEVEL, { minLength: n, maxLength: n }), LEAF));

/** `leaf` at the end of `path`. */
function wrap(path: readonly Level[], leaf: unknown): unknown {
  let v = leaf;
  for (let i = path.length - 1; i >= 0; i--) {
    const { key, before, after } = path[i]!;
    if (key === undefined) {
      v = [...before, v, ...after];
      continue;
    }
    const o: Record<string, unknown> = {};
    before.forEach((x, j) => (o[`a${j}`] = x));
    o[key] = v;
    after.forEach((x, j) => (o[`z${j}`] = x));
    v = o;
  }
  return v;
}

const redactor = createRedactor();
type Value = (v: unknown, tally: RedactionTally) => unknown;
const value: Value = (v, tally) => redactor.value(v, tally);

/** Fails unless the leaf at the end of the path comes out, and counts, as it does alone, and a second pass changes nothing. */
function expectDeep([path, leaf]: DeepCase, redact: Value): void {
  const alone = redactionTally();
  const want = wrap(path, redact(leaf, alone));
  const tally = redactionTally();
  const got = redact(wrap(path, leaf), tally);
  assert.deepEqual(got, want, `a value ${path.length} levels deep comes out other than it does alone`);
  assert.deepEqual(tally, alone, `a value ${path.length} levels deep counts other than it does alone`);
  assert.deepEqual(redact(got, redactionTally()), got, "redacting the output again changed it");
}

test("a value comes out and counts at any depth as it does alone", async (t) => {
  for (const k of PLAIN_KEYS) assert.ok(!isSecretAttrKey(k), `${k} names a secret`);
  for (const k of SECRET_KEYS) assert.ok(isSecretAttrKey(k), `${k} names no secret`);
  let deep = 0;
  await forAll(
    CASE,
    (c) => {
      expectDeep(c, value);
      if (c[0].length > WALK_DEPTH && JSON.stringify(value(c[1], redactionTally())) !== JSON.stringify(c[1])) deep++;
    },
    { runs: RUNS, label: "deep" },
  );
  t.diagnostic(`${deep} secrets more than ${WALK_DEPTH} levels down redacted`);
});

test("the property fails on a walk that leaves the objects and arrays below 64 levels as they are", async (t) => {
  const f = await failure(CASE, (c) => expectDeep(c, shallow), { env: {}, runs: 300, label: "shallow" });
  assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), /comes out other than it does alone/);
  t.diagnostic(`failed on case ${f.caseIndex + 1}`);
});

/** `v` redacted to WALK_DEPTH levels, with the objects and arrays at that depth left as they are. */
function shallow(v: unknown, tally: RedactionTally): unknown {
  const below: unknown[] = [];
  const cut = (x: unknown, d: number): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (d >= WALK_DEPTH) return `\u0000${below.push(x) - 1}`;
    return Array.isArray(x) ? x.map((y) => cut(y, d + 1)) : Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cut(y, d + 1)]));
  };
  const fill = (x: unknown): unknown => {
    if (typeof x === "string" && x.startsWith("\u0000")) return below[Number(x.slice(1))];
    if (x === null || typeof x !== "object") return x;
    return Array.isArray(x) ? x.map(fill) : Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fill(y)]));
  };
  return fill(value(cut(v, 0), tally));
}

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure<T>(g: Gen<T>, prop: (v: T) => void, opts: ForAllOptions): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, opts);
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${opts.label ?? "the property"} passed`);
}
