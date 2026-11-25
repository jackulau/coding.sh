// The prose-secret rule (core/redact.ts redactProseSecrets), checked against its own regex on
// generated text. A hand-written scanner applies the rule, and the code says it gives what
// `s.replace(rule.pattern, rule.replace)` gives. The text is 1 to 12 segments, each: a secret word
// (PAT, token, password, api key and the rest, in any case, or a near miss like tokens or
// my_token), a gap of 0 to 25 characters (now and then a newline, a bracket, a colon or an equals
// sign), often one character from an edge of [0-9A-Za-z_] (/, 0, 9, @, A, Z, ^, _, `, a, z, {),
// ":", "=" or "is" in any case (now and then none, "-", ">" or "was"), whitespace (sometimes none,
// a tab, a newline or a non-ASCII space), a value, and an end (a space, punctuation, a quote, a
// line end or nothing). A value is random text of 1 to 20 characters, most often 6 to 10, digits
// around one letter (a, z, A or Z), or letters around one digit (0 or 9), sometimes after $ or [.
//
// The property: the scanner and the regex give the same text. The last test shows the property
// fails against a regex that takes a gap of 23 characters at most, values of 9 characters or more,
// a value after $ or [, "is" right after a letter or digit, "is" right before one, or a colon or a
// closing bracket in the gap.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, type RedactRule } from "../../src/core/redact.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;

/** `s` with each letter in upper or lower case. */
const anyCase = (s: string): Gen<string> =>
  gen.map(gen.array(gen.bool, { minLength: s.length, maxLength: s.length }), (up) => [...s].map((c, i) => (up[i] ? c.toUpperCase() : c.toLowerCase())).join(""));
const text = (alphabet: string, length: Gen<number>): Gen<string> => gen.chain(length, (n) => gen.string({ alphabet, minLength: n, maxLength: n }));

const WORDS = ["PAT", "personal access token", "token", "password", "passwd", "passcode", "pass phrase", "passphrase", "api key", "api_key", "api-key", "apikey", "secret"];
/** No secret word stands alone in these. */
const NEAR_MISSES = ["pattern", "tokens", "xtoken", "my_token", "secrets", "api  key", "passwords"];
const WORD: Gen<string> = gen.chain(gen.frequency([6, gen.pick(WORDS)], [1, gen.pick(NEAR_MISSES)]), anyCase);

/** A gap character: mostly letters, digits and punctuation, now and then one the rule's gap does not take. */
const GAP_CHAR: Gen<string> = gen.frequency([30, gen.pick([..." bcxyBCXY0189.,-/@^_`{}()#"])], [1, gen.pick(["\n", "[", "]", ":", "="])]);
const GAP: Gen<string> = gen.chain(gen.frequency([5, gen.int(0, 3)], [2, gen.int(4, 21)], [3, gen.int(22, 25)]), (n) =>
  gen.map(gen.array(GAP_CHAR, { minLength: n, maxLength: n }), (cs) => cs.join("")),
);
/** The characters on either side of an edge of [0-9A-Za-z_], less ":" and "[", which end a gap. */
const EDGES = "/09@AZ^_`az{";
const LEAD: Gen<string> = gen.frequency([1, gen.constant("")], [1, gen.constant(" ")], [8, gen.pick([...EDGES])]);
const SEP: Gen<string> = gen.frequency([2, gen.constant(":")], [2, gen.constant("=")], [6, anyCase("is")], [1, gen.pick(["", "-", ">", "was"])]);
const SPACE: Gen<string> = gen.frequency([5, gen.constant(" ")], [3, gen.constant("")], [1, gen.pick(["  ", "\t", "\n", "\u00a0", "\u3000", " \r\n"])]);

const VALUE: Gen<string> = gen.map(
  gen.tuple(
    gen.frequency([8, gen.constant("")], [1, gen.constant("$")], [1, gen.constant("[")]),
    gen.frequency(
      [6, text("abxyzABXYZ0189-_./+~!@#%^&*:", gen.frequency([4, gen.int(8, 10)], [2, gen.int(6, 7)], [1, gen.int(1, 5)], [2, gen.int(11, 20)]))],
      [2, gen.map(gen.tuple(text("0123456789", gen.int(3, 6)), gen.pick(["a", "z", "A", "Z"]), text("0123456789", gen.int(3, 6))), (p) => p.join(""))],
      [2, gen.map(gen.tuple(text("bcxyBCXY", gen.int(3, 6)), gen.pick(["0", "9"]), text("bcxyBCXY", gen.int(3, 6))), (p) => p.join(""))],
    ),
  ),
  ([pre, v]) => pre + v,
);
const TAIL: Gen<string> = gen.pick([" ", ", ", "; ", ")", ".", "\n", "", "'", '"', "`", ",x9"]);

const SEGMENT: Gen<string> = gen.map(gen.tuple(WORD, GAP, LEAD, SEP, SPACE, VALUE, TAIL), (p) => p.join(""));
const TEXT: Gen<string> = gen.map(gen.array(gen.tuple(gen.pick(["", " ", "\n", ". "]), SEGMENT), { minLength: 1, maxLength: 12, avgLength: 9 }), (xs) =>
  xs.map(([before, s]) => before + s).join(""),
);

/** A redactor with the prose-secret rule alone: it runs the scanner. */
const scanner = createRedactor();
const rules = scanner.rules as RedactRule[];
const PROSE = rules.find((x) => x.kind === "prose-secret") as RedactRule;
rules.splice(0, rules.length, PROSE);
const replace = PROSE.replace as (m: string, ...g: string[]) => string;

function expectSame(s: string, re: RegExp): void {
  assert.equal(scanner.string(s), s.replace(re, replace), `the scanner and the regex differ on ${JSON.stringify(s)}`);
}

test("the prose-secret scanner gives the same text as the rule's regex", async (t) => {
  let changed = 0;
  let markers = 0;
  await forAll(
    TEXT,
    (s) => {
      expectSame(s, PROSE.pattern);
      const n = scanner.string(s).split("[redacted:prose-secret]").length - 1;
      if (n) changed++;
      markers += n;
    },
    { runs: RUNS, label: "prose" },
  );
  t.diagnostic(`${changed} texts changed, ${markers} values redacted`);
});

test("the property fails against a regex that differs at a gap of 24, a value of 8, $ or [, the edges of is, or a colon in the gap", async (t) => {
  const src = PROSE.pattern.source;
  const mutants: [string, string, string][] = [
    ["a gap of 23 characters at most", "{0,24}?", "{0,23}?"],
    ["values of 9 characters or more", "{8,}", "{9,}"],
    ["a value after $ or [", "(?![$[])", ""],
    ["is right after a letter or digit", "\\bis\\b", "is\\b"],
    ["is right before a letter or digit", "\\bis\\b", "\\bis"],
    ["a colon or a closing bracket in the gap", "[^\\n[\\]:=]", "[^\\n[=]"],
  ];
  for (const [label, from, to] of mutants) {
    assert.ok(src.includes(from), `the regex holds ${from}`);
    const re = new RegExp(src.replace(from, to), PROSE.pattern.flags);
    const f = await failure(TEXT, (s) => expectSame(s, re), { env: {}, runs: 300, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), /the scanner and the regex differ/, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

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
