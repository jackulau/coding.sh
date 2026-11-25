// The PII rules (core/redact.ts piiRules: capture.redact "pii" or one of its kinds), checked on generated
// text. A case holds one kind: values of that kind, lookalikes that fail one of its checks, decoys
// (versions, ids, addresses, timestamps, a commit hash) and filler words, joined by ", ", "; ", " | ",
// " and ", ". " or a line end, never by a bare space or dash. The values and lookalikes:
//
// - card: a known issuer prefix and length (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay,
//   Maestro) and a Luhn check digit, unbroken, in groups of 4, or 4-6-5 and 4-6-4. Lookalikes: a wrong
//   check digit, a prefix no issuer uses, two kinds of separator.
// - iban: a registry country, its length and the check digits mod 97 gives, unbroken or in groups of 4.
//   Lookalikes: wrong check digits, a country with no IBAN.
// - national-id: a US SSN, a UK National Insurance number, a Canadian SIN. Lookalikes: an SSN area,
//   group or serial that is never issued, an NI prefix or suffix that is never issued, a SIN with a
//   wrong check digit.
// - phone: a + number (a country code, maybe an area code in parentheses, two to five groups), which is
//   a value when it has 8 to 15 digits; a North American number. Lookalike: a North American number
//   with two kinds of separator.
// - email: an address. Lookalikes: a package version after an @, an image name, a decorator, a host
//   with no dot.
//
// The properties: with only that kind on, each value becomes [redacted:<kind>] and the rest comes out
// as it went in, and redacting the output again changes nothing; with "pii" on, no value is left.
// Another test takes every country in IBAN_LENGTHS: an IBAN of its length is redacted, one a
// character shorter or longer is not. The last test shows the property fails on a redactor whose
// check passes every candidate, or with the kind turned off.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, marker, PII_KINDS, type PiiKind, type Redactor, type RedactRule } from "../../src/core/redact.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;
const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";

/** A piece of a case: a value of the case's kind, which its rules redact, or text they leave as it is. */
interface Item {
  text: string;
  value: boolean;
}
const value = (text: string): Item => ({ text, value: true });
const kept = (text: string): Item => ({ text, value: false });

interface Case {
  kind: PiiKind;
  items: Item[];
}
const textOf = (c: Case): string => c.items.map((it) => it.text).join("");

const digits = (n: number): Gen<string> => gen.string({ alphabet: DIGITS, minLength: n, maxLength: n });
const nums = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const range = (lo: number, hi: number): string[] => nums(lo, hi).map(String);
/** `s` in groups of 4 joined by `sep`; the last group takes what is left. */
const fours = (s: string, sep: string): string => s.replace(/.{4}(?!$)/g, `$&${sep}`);

/** The digit that makes `body` followed by it pass the Luhn check. */
function luhnDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** `n` with its last digit moved by `k` (1 to 9), so its Luhn check fails. */
const badCheck = (n: string, k: number): string => n.slice(0, -1) + String((Number(n.slice(-1)) + k) % 10);

// ---------------------------------------------------------------- cards

/** Issuer prefixes and the lengths each uses: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro. */
const ISSUERS: readonly (readonly [prefixes: readonly string[], lengths: readonly number[]])[] = [
  [["4"], [13, 16, 19]],
  [["51", "52", "53", "54", "55", ...range(2221, 2720)], [16]],
  [["34", "37"], [15]],
  [["6011", ...range(644, 649), "65"], nums(16, 19)],
  [range(3528, 3589), nums(16, 19)],
  [[...range(300, 305), "36", "38", "39"], nums(14, 19)],
  [["62"], nums(16, 19)],
  [["5018", "5020", "5038", "6304", "6759", "6761", "6762", "6763"], nums(13, 19)],
];

/** A card number: an issuer's prefix, random digits to one of its lengths, and the Luhn check digit. */
const CARD_NUMBER: Gen<string> = gen.chain(gen.pick(ISSUERS), ([prefixes, lengths]) =>
  gen.chain(gen.tuple(gen.pick(prefixes), gen.pick(lengths)), ([p, len]) => gen.map(digits(len - 1 - p.length), (rest) => p + rest + luhnDigit(p + rest))),
);

/** A card number as people write it: unbroken, in groups of 4, or 4-6-5 and 4-6-4 (Amex, Diners). */
function written(n: string): Gen<string> {
  const forms = [n];
  for (const sep of [" ", "-"]) {
    forms.push(fours(n, sep));
    if (n.length === 14 || n.length === 15) forms.push(`${n.slice(0, 4)}${sep}${n.slice(4, 10)}${sep}${n.slice(10)}`);
  }
  return gen.pick(forms);
}

const CARD: Gen<Item> = gen.map(gen.chain(CARD_NUMBER, written), value);

const CARD_LOOKALIKE: Gen<Item> = gen.map(
  gen.oneOf(
    // A wrong check digit.
    gen.chain(gen.tuple(CARD_NUMBER, gen.int(1, 9)), ([n, k]) => written(badCheck(n, k))),
    // A prefix no issuer uses, with a check digit that passes.
    gen.chain(gen.tuple(gen.pick(["0", "1", "7", "8", "9"]), gen.int(13, 19)), ([p, len]) =>
      gen.chain(digits(len - 2), (rest) => written(p + rest + luhnDigit(p + rest))),
    ),
    // Groups of 4 split by spaces and dashes in turn.
    gen.map(CARD_NUMBER, (n) => n.replace(/.{4}(?!$)/g, (g: string, at: number) => g + (at % 8 ? "-" : " "))),
  ),
  kept,
);

// ---------------------------------------------------------------- IBANs

/** IBAN lengths by country, from the ISO 13616 registry. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24,
  ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31,
  SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};
const COUNTRIES = Object.entries(IBAN_LENGTHS);
/** Countries that issue no IBAN. */
const NO_IBAN = ["US", "CA", "AU", "JP", "CN", "IN", "MX", "ZA"];

/** The remainder mod 97 of `s` read as one number, each letter as two digits (A = 10 to Z = 35). */
function mod97(s: string): number {
  let rem = 0;
  for (const c of s) for (const d of String(parseInt(c, 36))) rem = (rem * 10 + Number(d)) % 97;
  return rem;
}

/** An IBAN's check digits: 98 minus the remainder of the BBAN, the country and "00". From 2 to 98. */
const ibanCheck = (country: string, bban: string): number => 98 - mod97(`${bban}${country}00`);
const ibanOf = (country: string, check: number, bban: string): string => `${country}${String(check).padStart(2, "0")}${bban}`;
const bbanOf = (n: number): Gen<string> => gen.string({ alphabet: DIGITS + UPPER, minLength: n, maxLength: n });
const ibanWritten = (s: string): Gen<string> => gen.pick([s, fours(s, " ")]);

const IBAN: Gen<Item> = gen.map(
  gen.chain(gen.pick(COUNTRIES), ([cc, len]) => gen.chain(bbanOf(len - 4), (b) => ibanWritten(ibanOf(cc, ibanCheck(cc, b), b)))),
  value,
);

const IBAN_LOOKALIKE: Gen<Item> = gen.map(
  gen.oneOf(
    // Other check digits from 2 to 98: they differ from the right ones by less than 97, so mod 97 fails.
    gen.chain(gen.tuple(gen.pick(COUNTRIES), gen.int(1, 96)), ([[cc, len], k]) =>
      gen.chain(bbanOf(len - 4), (b) => ibanWritten(ibanOf(cc, 2 + ((ibanCheck(cc, b) - 2 + k) % 97), b))),
    ),
    // A country with no IBAN, with check digits that pass.
    gen.chain(gen.tuple(gen.pick(NO_IBAN), gen.int(15, 32)), ([cc, len]) => gen.chain(bbanOf(len - 4), (b) => ibanWritten(ibanOf(cc, ibanCheck(cc, b), b)))),
  ),
  kept,
);

// ---------------------------------------------------------------- national ids

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const ssn = (area: number, group: number, serial: number): string => `${pad(area, 3)}-${pad(group, 2)}-${pad(serial, 4)}`;
/** An SSN area that is issued: 001 to 899, but not 666. */
const SSN_AREA: Gen<number> = gen.map(gen.int(1, 898), (a) => (a >= 666 ? a + 1 : a));

const SSN: Gen<Item> = gen.map(gen.tuple(SSN_AREA, gen.int(1, 99), gen.int(1, 9999)), ([a, g, s]) => value(ssn(a, g, s)));

const SSN_UNISSUED: Gen<Item> = gen.map(
  gen.oneOf(
    // Area 000, 666 or 900 to 999.
    gen.map(gen.tuple(gen.oneOf(gen.constant(0), gen.constant(666), gen.int(900, 999)), gen.int(1, 99), gen.int(1, 9999)), ([a, g, s]) => ssn(a, g, s)),
    // Group 00.
    gen.map(gen.tuple(SSN_AREA, gen.int(1, 9999)), ([a, s]) => ssn(a, 0, s)),
    // Serial 0000.
    gen.map(gen.tuple(SSN_AREA, gen.int(1, 99)), ([a, g]) => ssn(a, g, 0)),
  ),
  kept,
);

/** National Insurance prefix letters HMRC issues: never D, F, I, Q, U or V, and never O second. */
const NI_FIRST = [..."ABCEGHJKLMNOPRSTWXYZ"];
const NI_SECOND = [..."ABCEGHJKLMNPRSTWXYZ"];
/** Prefixes HMRC does not issue although their letters are allowed. */
const NI_UNISSUED = ["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"];
const NI_PREFIX: Gen<string> = gen.filter(
  gen.map(gen.tuple(gen.pick(NI_FIRST), gen.pick(NI_SECOND)), ([a, b]) => a + b),
  (p) => !NI_UNISSUED.includes(p),
);
const nino = (prefix: string, d: string, suffix: string, spaced: boolean): string =>
  spaced ? `${prefix} ${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)} ${suffix}` : `${prefix}${d}${suffix}`;

const NINO: Gen<Item> = gen.map(gen.tuple(NI_PREFIX, digits(6), gen.pick([..."ABCD"]), gen.bool), ([p, d, s, spaced]) => value(nino(p, d, s, spaced)));

const NINO_UNISSUED: Gen<Item> = gen.map(
  gen.oneOf(
    // A letter that is never issued in its place, or a prefix that is never issued.
    gen.map(
      gen.tuple(
        gen.oneOf(
          gen.map(gen.tuple(gen.pick([..."DFIQUV"]), gen.pick(NI_SECOND)), ([a, b]) => a + b),
          gen.map(gen.tuple(gen.pick(NI_FIRST), gen.pick([..."DFIOQUV"])), ([a, b]) => a + b),
          gen.pick(NI_UNISSUED),
        ),
        digits(6),
        gen.pick([..."ABCD"]),
        gen.bool,
      ),
      ([p, d, s, spaced]) => nino(p, d, s, spaced),
    ),
    // A suffix other than A to D.
    gen.map(gen.tuple(NI_PREFIX, digits(6), gen.pick([..."EFGHIJKLMNOPQRSTUVWXYZ"]), gen.bool), ([p, d, s, spaced]) => nino(p, d, s, spaced)),
  ),
  kept,
);

/** A SIN's nine digits: a first digit from 1 to 9 and a Luhn check digit. */
const SIN_NUMBER: Gen<string> = gen.map(gen.tuple(gen.int(1, 9), digits(7)), ([f, rest]) => `${f}${rest}${luhnDigit(`${f}${rest}`)}`);
const sin = (n: string, sep: string): string => `${n.slice(0, 3)}${sep}${n.slice(3, 6)}${sep}${n.slice(6)}`;

const SIN: Gen<Item> = gen.map(gen.tuple(SIN_NUMBER, gen.pick([" ", "-"])), ([n, sep]) => value(sin(n, sep)));
const SIN_LOOKALIKE: Gen<Item> = gen.map(gen.tuple(SIN_NUMBER, gen.int(1, 9), gen.pick([" ", "-"])), ([n, k, sep]) => kept(sin(badCheck(n, k), sep)));

// ---------------------------------------------------------------- phone numbers

const PHONE_SEPS = ["", " ", ".", "-"];
const COUNTRY_CODE: Gen<string> = gen.map(gen.tuple(gen.int(1, 9), gen.chain(gen.int(0, 2), digits)), ([f, rest]) => `${f}${rest}`);
const AREA_CODE: Gen<string> = gen.frequency(
  [3, gen.constant("")],
  [1, gen.map(gen.tuple(gen.pick(PHONE_SEPS), gen.chain(gen.int(1, 4), digits)), ([sep, d]) => `${sep}(${d})`)],
);
const PHONE_GROUPS: Gen<string[]> = gen.array(
  gen.map(gen.tuple(gen.pick(PHONE_SEPS), gen.chain(gen.int(1, 5), digits)), ([sep, d]) => sep + d),
  { minLength: 2, maxLength: 5 },
);

/** A + number: a value with 8 to 15 digits (E.164 allows 15), a lookalike with fewer or more. */
const PLUS_PHONE: Gen<Item> = gen.map(gen.tuple(COUNTRY_CODE, AREA_CODE, PHONE_GROUPS), ([cc, area, groups]) => {
  const s = `+${cc}${area}${groups.join("")}`;
  const n = s.replace(/\D/g, "").length;
  return n >= 8 && n <= 15 ? value(s) : kept(s);
});

const NANP_DIGITS = gen.tuple(digits(3), digits(3), digits(4));
const NANP: Gen<Item> = gen.map(
  gen.chain(NANP_DIGITS, ([a, b, c]) => gen.pick([`(${a}) ${b}-${c}`, `(${a})${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`])),
  value,
);
const NANP_MIXED: Gen<Item> = gen.map(gen.chain(NANP_DIGITS, ([a, b, c]) => gen.pick([`${a}-${b}.${c}`, `${a}.${b}-${c}`])), kept);

// ---------------------------------------------------------------- email

const WORD = gen.string({ alphabet: LOWER, minLength: 2, maxLength: 8 });
const LOCAL = gen.string({ alphabet: `${LOWER}${UPPER}${DIGITS}._%+-`, minLength: 1, maxLength: 16 });
const LABEL = gen.map(gen.tuple(gen.pick([...LOWER + UPPER]), gen.string({ alphabet: `${LOWER}${DIGITS}-`, minLength: 0, maxLength: 9 })), ([a, rest]) => a + rest);
const TLD = gen.string({ alphabet: LOWER + UPPER, minLength: 2, maxLength: 6 });

const EMAIL: Gen<Item> = gen.map(gen.tuple(LOCAL, gen.array(LABEL, { minLength: 1, maxLength: 3 }), TLD), ([local, labels, tld]) => value(`${local}@${[...labels, tld].join(".")}`));

const EMAIL_LOOKALIKE: Gen<Item> = gen.map(
  gen.oneOf(
    // A package and its version.
    gen.map(gen.tuple(WORD, gen.array(gen.map(gen.int(0, 99), String), { minLength: 2, maxLength: 3 })), ([w, v]) => `${w}@${v.join(".")}`),
    // An image at a pixel density.
    gen.map(gen.tuple(WORD, gen.int(1, 4), gen.pick(["png", "jpg", "webp", "svg"])), ([w, n, ext]) => `${w}@${n}x.${ext}`),
    // A decorator.
    gen.map(gen.tuple(WORD, WORD), ([a, b]) => `@${a}.${b}`),
    // A host with no dot.
    gen.map(gen.tuple(LOCAL, WORD), ([a, b]) => `${a}@${b}`),
  ),
  kept,
);

// ---------------------------------------------------------------- cases

/** Text no PII rule takes: versions, ids, addresses, timestamps, amounts. */
const DECOYS = [
  "1.2.3", "v10.24.1", "1.0.0+20130313144700", "550e8400-e29b-41d4-a716-446655440000", "localhost:3000", "127.0.0.1:8080",
  "2026-11-24T03:09:00.000Z", "+05:30", "ts=1731060000000", "192.168.1.1", "coding.sh@0.1.3", "icon@2x.png", "$1,234,567.89",
  "ISBN 978-3-16-148410-0", "0x7fffffff", "issue #12345", "id 1234567890", "3.14159265358979", "ORD-2026-000123",
  "node:22.15.0-alpine", "HTTP/1.1 200 OK", "AB123456", "+1 23", "000-12-3456",
];
const DECOY: Gen<Item> = gen.map(gen.oneOf(gen.pick(DECOYS), gen.string({ alphabet: "0123456789abcdef", minLength: 40, maxLength: 40 })), kept);
const FILLERS = ["alpha", "build", "cache", "delta", "event", "field", "graph", "hello", "index", "merge", "order", "query", "route", "stage", "table", "vector"];
const FILLER: Gen<Item> = gen.map(gen.pick(FILLERS), kept);
const SEPS = [", ", "; ", "\n", " | ", " and ", ". "];

/** Each kind's values and lookalikes. */
const ITEMS: Readonly<Record<PiiKind, readonly [Gen<Item>, Gen<Item>]>> = {
  email: [EMAIL, EMAIL_LOOKALIKE],
  phone: [gen.oneOf(PLUS_PHONE, NANP), gen.oneOf(PLUS_PHONE, NANP_MIXED)],
  card: [CARD, CARD_LOOKALIKE],
  iban: [IBAN, IBAN_LOOKALIKE],
  "national-id": [gen.oneOf(SSN, NINO, SIN), gen.oneOf(SSN_UNISSUED, NINO_UNISSUED, SIN_LOOKALIKE)],
};

function caseOf(kind: PiiKind): Gen<Case> {
  const [values, lookalikes] = ITEMS[kind];
  const item = gen.frequency<Item>([4, values], [3, lookalikes], [2, DECOY], [1, FILLER]);
  return gen.map(gen.array(gen.tuple(item, gen.pick(SEPS)), { minLength: 1, maxLength: 8 }), (xs) => ({
    kind,
    items: xs.flatMap(([it, sep], i) => (i ? [kept(sep), it] : [it])),
  }));
}

const CASE: Gen<Case> = gen.chain(gen.pick(PII_KINDS), caseOf);

/** Fails unless `r` turns each value into a marker of its kind and leaves the rest as it is. Returns the output. */
function expectRedacted(r: Redactor, c: Case): string {
  const out = r.string(textOf(c));
  let at = 0;
  for (const it of c.items) {
    const want = it.value ? marker(c.kind) : it.text;
    if (!out.startsWith(want, at)) assert.fail(`${it.value ? `the ${c.kind} ${JSON.stringify(it.text)} is not redacted` : `${JSON.stringify(it.text)} is not kept`}: ${JSON.stringify(out)}`);
    at += want.length;
  }
  assert.equal(at, out.length, `the output is longer than the text with its values redacted: ${JSON.stringify(out)}`);
  return out;
}

const ONE_KIND = new Map(PII_KINDS.map((k) => [k, createRedactor({ redact: [k] })]));

class Seen {
  values = 0;
  kept = 0;
  kinds = new Set<string>();

  note(c: Case): void {
    this.kinds.add(c.kind);
    for (const it of c.items) if (it.value) this.values++;
    else this.kept++;
  }

  toString(): string {
    return `${this.values} values and ${this.kept} other pieces in ${this.kinds.size} kinds`;
  }
}

test("with only its kind on, each value is redacted, the rest comes out as it went in, and a second pass changes nothing", async (t) => {
  const seen = new Seen();
  await forAll(
    CASE,
    (c) => {
      seen.note(c);
      const r = must(ONE_KIND.get(c.kind));
      const out = expectRedacted(r, c);
      assert.equal(r.string(out), out, "redacting the output again changed it");
    },
    { runs: RUNS, label: "pii one kind" },
  );
  t.diagnostic(String(seen));
});

test('with "pii" on, no value of any kind is left, and a second pass changes nothing', async () => {
  const r = createRedactor({ redact: ["pii"] });
  await forAll(
    CASE,
    (c) => {
      const out = r.string(textOf(c));
      for (const it of c.items) {
        if (!it.value || !out.includes(it.text) || c.items.some((o) => o !== it && o.text.includes(it.text))) continue;
        assert.fail(`the ${c.kind} ${JSON.stringify(it.text)} is left: ${JSON.stringify(out)}`);
      }
      assert.equal(r.string(out), out, "redacting the output again changed it");
    },
    { runs: RUNS, label: "pii all kinds" },
  );
});

test("every country in IBAN_LENGTHS: an IBAN of its length is redacted, one a character shorter or longer is not", () => {
  const r = createRedactor({ redact: ["iban"] });
  const filler = "NWBK60161331926819WEST0123456789ABCDEF";
  for (const [cc, len] of COUNTRIES) {
    for (const n of [len - 1, len, len + 1]) {
      const b = filler.slice(0, n - 4);
      const s = ibanOf(cc, ibanCheck(cc, b), b);
      assert.equal(r.string(`IBAN ${s}.`), n === len ? `IBAN ${marker("iban")}.` : `IBAN ${s}.`, `${cc}, ${n} characters (its length is ${len})`);
    }
  }
});

test("the property fails on a redactor whose check passes every candidate, or with the kind turned off", async (t) => {
  const passAll = (kind: PiiKind): Redactor => {
    const r = createRedactor({ redact: [kind] });
    const rules = r.rules as RedactRule[];
    rules.splice(0, rules.length, ...rules.map((x) => ({ ...x, replace: () => marker(kind) })));
    return r;
  };
  const mutants: [string, PiiKind, Redactor, RegExp][] = [
    ["card, every number passes", "card", passAll("card"), /is not kept/],
    ["iban, every candidate passes", "iban", passAll("iban"), /is not kept/],
    ["phone, every digit count passes", "phone", passAll("phone"), /is not kept/],
    ["national-id, every SIN passes", "national-id", passAll("national-id"), /is not kept/],
    ["national-id, only email on", "national-id", createRedactor({ redact: ["email"] }), /is not redacted/],
  ];
  for (const [label, kind, r, why] of mutants) {
    const f = await failure(caseOf(kind), (c) => void expectRedacted(r, c), { env: {}, runs: 300, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
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

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
