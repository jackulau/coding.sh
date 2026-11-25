// How the redactor counts vendor tokens (core/redact.ts isPlaceholderSecret and the tally in
// createRedactor), checked on generated tokens: a vendor prefix (Anthropic, GitHub, Hugging Face,
// Groq, xAI, Perplexity, Linear) and a random body, sometimes with a made-up shape in the body:
// EXAMPLE in any case, eight of one character, a chunk three times, eight to ten consecutive
// characters, or (Anthropic) a word like test or stub after the prefix. Each token stands between
// two filler words.
//
// The properties: a token with a random body is redacted and counts once as its vendor kind; with a
// made-up shape it is still redacted but counts as placeholder-key; a string with one run of
// consecutive characters (in any case, at the start or not, ending at 9 or z or not) is a
// placeholder when the run is 8 or longer; a token over 512 characters counts as its vendor kind
// whatever its shape. The last test shows the properties fail on a check that skips a string's
// first character and on a redactor that never asks whether a token is made up.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, isPlaceholderSecret, marker, PLACEHOLDER_KIND, redactionTally, type Redactor, type RedactRule } from "../../src/core/redact.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;
const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = DIGITS + UPPER + LOWER;

const alnum = (n: number): Gen<string> => gen.string({ alphabet: ALNUM, minLength: n, maxLength: n });
/** `s` with each letter in upper or lower case. */
const anyCase = (s: string): Gen<string> =>
  gen.map(gen.array(gen.bool, { minLength: s.length, maxLength: s.length }), (up) => [...s].map((c, i) => (up[i] ? c.toUpperCase() : c.toLowerCase())).join(""));

interface Vendor {
  kind: string;
  prefix: string;
  /** The fewest body characters the rule takes. */
  min: number;
}

/** Vendors whose rule takes a body of letters and digits with no upper bound. Joined, so the source holds no token prefix. */
const VENDORS: readonly Vendor[] = [
  { kind: "anthropic-key", prefix: ["sk", "ant", "api03", ""].join("-"), min: 20 },
  { kind: "github-token", prefix: ["gh", "p_"].join(""), min: 36 },
  { kind: "huggingface-token", prefix: ["hf", ""].join("_"), min: 30 },
  { kind: "groq-key", prefix: ["gsk", ""].join("_"), min: 40 },
  { kind: "xai-key", prefix: ["xai", ""].join("-"), min: 40 },
  { kind: "perplexity-key", prefix: ["pplx", ""].join("-"), min: 32 },
  { kind: "linear-key", prefix: ["lin", "api", ""].join("_"), min: 32 },
];
const ANTHROPIC = VENDORS[0] as Vendor;

interface TokenCase {
  kind: string;
  token: string;
  before: string;
  after: string;
}

const FILLER = gen.pick(["alpha", "build", "cache", "route", "table"]);
const tokenCase = (kind: string, token: Gen<string>): Gen<TokenCase> =>
  gen.map(gen.tuple(token, FILLER, FILLER), ([t, before, after]) => ({ kind, token: t, before, after }));

/** Consecutive digits or letters, `k` of them (8 to 10), each letter in either case. */
const RUN: Gen<string> = gen.chain(gen.tuple(gen.pick([DIGITS, LOWER]), gen.int(8, 10)), ([abc, k]) => gen.chain(gen.int(0, abc.length - k), (f) => anyCase(abc.slice(f, f + k))));

/** A made-up shape of letters and digits, so it fits in any of the bodies. */
const SHAPE: Gen<string> = gen.oneOf(
  anyCase("example"),
  gen.map(gen.pick([...ALNUM]), (c) => c.repeat(8)),
  gen.map(gen.chain(gen.int(3, 6), alnum), (chunk) => chunk.repeat(3)),
  RUN,
);

/** A token of `v` with a body of `n` characters (or the shape's length, if longer) that holds `shape`. */
const shaped = (v: Vendor, n: number, shape: string): Gen<string> => {
  const rest = Math.max(0, n - shape.length);
  return gen.chain(gen.int(0, rest), (left) => gen.map(gen.tuple(alnum(left), alnum(rest - left)), ([a, b]) => v.prefix + a + shape + b));
};

const REAL: Gen<TokenCase> = gen.chain(gen.pick(VENDORS), (v) => tokenCase(v.kind, gen.map(gen.chain(gen.int(v.min, v.min + 30), alnum), (body) => v.prefix + body)));

const PLACEHOLDER_WORDS = ["test", "fake", "dummy", "example", "stub", "mock", "placeholder", "sample", "xxx", "xxxxxx"];

const MADE_UP: Gen<TokenCase> = gen.frequency(
  [4, gen.chain(gen.tuple(gen.pick(VENDORS), SHAPE), ([v, shape]) => tokenCase(v.kind, gen.chain(gen.int(v.min, v.min + 30), (n) => shaped(v, n, shape))))],
  // A word after the prefix, as in sk-ant-test-...
  [1, tokenCase(ANTHROPIC.kind, gen.map(gen.tuple(gen.chain(gen.pick(PLACEHOLDER_WORDS), anyCase), alnum(40)), ([w, body]) => `${ANTHROPIC.prefix}${w}-${body}`))],
);

/** A made-up token of 505 to 1200 characters. */
const LONG: Gen<TokenCase> = gen.chain(gen.tuple(gen.pick(VENDORS), SHAPE, gen.frequency([3, gen.int(505, 520)], [1, gen.int(521, 1200)])), ([v, shape, length]) =>
  tokenCase(v.kind, shaped(v, length - v.prefix.length, shape)),
);

/** Fails unless `r` redacts the token and counts it once, as `want`. */
function expectTally(r: Redactor, c: TokenCase, want: string): void {
  const tally = redactionTally();
  const out = r.string(`${c.before} ${c.token} ${c.after}`, tally);
  assert.equal(out, `${c.before} ${marker(c.kind)} ${c.after}`, `the ${c.kind} is not redacted`);
  assert.deepEqual(tally.kinds, { [want]: 1 }, `the ${c.kind} ${JSON.stringify(c.token)} counts as ${JSON.stringify(tally.kinds)}, not as ${want}`);
}

/** No two of these are consecutive characters, in either case. */
const SPACED = "acegikmoqsuwy02468";

interface RunCase {
  s: string;
  /** The length of the one run of consecutive characters in `s`. */
  k: number;
}

/** Up to 10 characters of SPACED, none twice, so the background holds no other made-up shape (a chunk three times, eight of one character). */
const background = (min: number): Gen<string> =>
  gen.chain(
    gen.map(gen.array(gen.pick([...SPACED]), { minLength: min, maxLength: 10 }), (cs) => [...new Set(cs)].join("")),
    anyCase,
  );

/**
 * A run of `k` consecutive digits or letters (3 to 12; most often 7 or 8), at the start of the
 * string or after other characters, starting at 0 or a, ending at 9 or z, or neither.
 */
const RUN_CASE: Gen<RunCase> = gen.chain(
  gen.tuple(gen.pick([DIGITS, LOWER]), gen.frequency([3, gen.constant(7)], [3, gen.constant(8)], [2, gen.int(3, 12)]), gen.pick(["low", "high", "any"]), gen.bool),
  ([abc, want, align, atStart]) => {
    const k = Math.min(want, abc.length);
    const from = align === "low" ? gen.constant(0) : align === "high" ? gen.constant(abc.length - k) : gen.int(0, abc.length - k);
    return gen.chain(from, (f) =>
      gen.map(gen.tuple(anyCase(abc.slice(f, f + k)), atStart ? gen.constant("") : background(1), background(0)), ([run, before, after]) => {
        // A neighbour that continues the run would make it longer: swap it for one of the other class.
        const other = abc === DIGITS ? "a" : "0";
        const first = abc.charCodeAt(f);
        const last = abc.charCodeAt(f + k - 1);
        const b = before && (before.charCodeAt(before.length - 1) | 32) === first - 1 ? before.slice(0, -1) + other : before;
        const a = after && (after.charCodeAt(0) | 32) === last + 1 ? other + after.slice(1) : after;
        return { s: b + run + a, k };
      }),
    );
  },
);

function expectRun(c: RunCase, isPlaceholder: (s: string) => boolean): void {
  assert.equal(isPlaceholder(c.s), c.k >= 8, `${JSON.stringify(c.s)} has a run of ${c.k} consecutive characters`);
}

test("a vendor token with a random body is redacted and counts as its vendor kind", async (t) => {
  const r = createRedactor();
  const kinds = new Set<string>();
  await forAll(
    REAL,
    (c) => {
      kinds.add(c.kind);
      assert.equal(isPlaceholderSecret(c.token), false, `${JSON.stringify(c.token)} is taken for a made-up value`);
      expectTally(r, c, c.kind);
    },
    // No shrinking: a shrunk body runs toward 0000…, which is made up, so the case reported would fail for another reason.
    { runs: RUNS, label: "real tokens", maxShrinks: 0 },
  );
  t.diagnostic(`${kinds.size} vendor kinds`);
});

test("the same token with a made-up shape in it is still redacted, and counts as placeholder-key", async () => {
  const r = createRedactor();
  await forAll(
    MADE_UP,
    (c) => {
      assert.equal(isPlaceholderSecret(c.token), true, `${JSON.stringify(c.token)} is not taken for a made-up value`);
      expectTally(r, c, PLACEHOLDER_KIND);
    },
    { runs: RUNS, label: "made-up tokens" },
  );
});

test("a string with a run of 8 or more consecutive characters is a placeholder; with 7 or fewer it is not", async (t) => {
  const seen = { atStart: 0, eight: 0, seven: 0 };
  await forAll(
    RUN_CASE,
    (c) => {
      if (c.k === 8) seen.eight++;
      if (c.k === 7) seen.seven++;
      // No two background characters are consecutive, so the first two are only when the run starts the string.
      if ((c.s.charCodeAt(1) | 32) === (c.s.charCodeAt(0) | 32) + 1) seen.atStart++;
      expectRun(c, isPlaceholderSecret);
    },
    { runs: RUNS, label: "runs" },
  );
  t.diagnostic(`${seen.eight} runs of 8, ${seen.seven} of 7, ${seen.atStart} at the start`);
});

test("a made-up token over 512 characters counts as its vendor kind; up to 512 it counts as placeholder-key", async (t) => {
  const r = createRedactor();
  let over = 0;
  await forAll(
    LONG,
    (c) => {
      const long = c.token.length > 512;
      if (long) over++;
      assert.equal(isPlaceholderSecret(c.token), !long, `a made-up token of ${c.token.length} characters is ${long ? "" : "not "}taken for a made-up value`);
      expectTally(r, c, long ? c.kind : PLACEHOLDER_KIND);
    },
    { runs: RUNS, label: "long tokens" },
  );
  t.diagnostic(`${over} tokens over 512 characters`);
});

test("the properties fail on a check that skips a string's first character, and on a redactor that never asks whether a token is made up", async (t) => {
  const skip = await failure(RUN_CASE, (c) => expectRun(c, (s) => isPlaceholderSecret(s.slice(1))), { env: {}, runs: 300, label: "first character skipped" });
  assert.match(message(skip), /has a run of 8 /);
  t.diagnostic(`first character skipped: failed on case ${skip.caseIndex + 1}`);

  const neverAsks = createRedactor();
  const rules = neverAsks.rules as RedactRule[];
  rules.splice(0, rules.length, ...rules.map((x) => (x.replace ? x : { ...x, replace: () => marker(x.kind) })));
  const asks = await failure(MADE_UP, (c) => expectTally(neverAsks, c, PLACEHOLDER_KIND), { env: {}, runs: 300, label: "never asks" });
  assert.match(message(asks), /counts as \{".+":1\}, not as placeholder-key/);
  t.diagnostic(`never asks: failed on case ${asks.caseIndex + 1}`);
});

const message = (f: PropertyFailure): string => (f.cause instanceof Error ? f.cause.message : String(f.cause));

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
