// Short session ids (core/session-ref.ts): the reference coding.sh prints for a session (shortestRef)
// and how a reference is read back (matchRef, findSessionRef, and the session part of a call
// reference, proxy/calls.ts resolveCall). The properties, over sets of ids drawn to collide:
//
// - A printed reference names its session and no other: through matchRef; through findSessionRef on
//   a store that holds the sessions; and in a call reference, where `<ref>#1` is the session's first
//   model call, `<ref>#-1` its last, and the number after the last is not found.
// - A printed alias is `x_` and the first 8 to 14 digits of the first 70 bits of the id's SHA-256 in
//   Crockford's base32, worked out here apart from session-ref.ts, and no stored id starts with it.
// - A printed reference is the one the rules pick, found here by trying every length rather than by
//   bisecting: the whole id when it has 8 characters or fewer; for a top-level id, the shortest prefix
//   of 8 or more characters that names it; for a subagent, the shortest prefix of 8 or more characters
//   of its own id, or its short form (8 characters of each part) when that is shorter and names it.
//   When that is over 40 characters or needs quoting in a shell, the shortest alias that names the id
//   alone and starts no stored id takes its place, unless every alias length is taken.
//
// Ids are drawn from stems that share long prefixes: UUIDs, T3 Code-like thread ids with
// percent-encoding, plain ids over 40 characters, SDK ids under `default/` and other projects, `x_`
// ids, and ids with a space, `&`, `$`, `#` or non-ASCII characters. Some are subagents (nested too),
// some under other parents share or extend another subagent's own id, some are another id cut short
// or grown, so one id is a prefix of another, and some come in pairs whose UTF-8 is the same (a lone
// surrogate and U+FFFD), so they share every alias. The first two properties also run on `x_` ids,
// top-level or a subagent's own id, made from another id's alias, and on subagents with no stored
// parent whose own id starts with the parent's id. The third does not: there the lengths that name
// the id are not one run, so bisecting can miss the shortest, and those cases are with the code's
// owners. The ids `latest` and `last` are left out: findSessionRef reads those words as the newest
// session.
//
// The last test shows each check fails on a mutant of the shortener or of the call resolver.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 200, and 100 with a store);
// CODING_SH_PROP_SEED=s replays one. The last test reads neither.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { findSessionRef, IdSet, matchRef, shortestRef } from "../../src/core/session-ref.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { CallRefError, resolveCall } from "../../src/proxy/calls.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { forAll, gen, PropertyFailure, type Gen } from "../_prop.ts";

const RUNS = 200;
const STORE_RUNS = 100;
const MUTANT_RUNS = 1000;

const SUB = ":sub:";
/** A reference every shell passes on as typed (session-ref.ts PLAIN_REF, from its comment). */
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
/** Crockford's base32, lowercase: the digits and letters but i, l, o and u. */
const CROCKFORD = [..."0123456789abcdefghijklmnopqrstuvwxyz"].filter((c) => !"ilou".includes(c)).join("");
const ALIAS_FORM = new RegExp(`^x_[${CROCKFORD}]{8,14}$`);

const q = (s: string): string => JSON.stringify(s);

/** `x_` and the first `k` base32 digits of the first 70 bits of `id`'s SHA-256 (of its UTF-8). */
function aliasOf(id: string, k: number): string {
  // 18 hex digits are 72 bits; the top 70 are 14 digits of 5 bits.
  const bits = BigInt(`0x${createHash("sha256").update(id).digest("hex").slice(0, 18)}`) >> 2n;
  let digits = "";
  for (let i = 13; i >= 0; i--) digits += CROCKFORD.charAt(Number((bits >> BigInt(5 * i)) & 31n));
  return `x_${digits.slice(0, k)}`;
}

/** True when matchRef takes `ref` to `id` and nothing else. */
function names(set: IdSet, ref: string, id: string): boolean {
  const m = matchRef(set, ref);
  return m !== undefined && "id" in m && m.id === id;
}

/** What matchRef takes `ref` to, for a message. */
function named(set: IdSet, ref: string): string {
  const m = matchRef(set, ref);
  if (!m) return "nothing";
  return "id" in m ? q(m.id) : `${m.ambiguous.length} ids`;
}

/** A subagent's own id: the part after its last `:sub:`, or "" for a top-level id. */
function ownId(id: string): string {
  const cut = id.lastIndexOf(SUB);
  return cut < 0 ? "" : id.slice(cut + SUB.length);
}

const shortForm = (id: string): string =>
  id
    .split(SUB)
    .map((p) => p.slice(0, 8))
    .join(SUB);

/** True when `ref`, printed for `id`, is an alias: x_ and alias digits, and not a prefix or the short form of the id. */
function isAlias(ref: string, id: string): boolean {
  if (!ALIAS_FORM.test(ref) || id.startsWith(ref) || ref === shortForm(id)) return false;
  const own = ownId(id);
  return !own || !own.startsWith(ref);
}

/** The reference the rules pick for `id` before any alias, found by trying every length (see the header). */
function shortestForm(set: IdSet, id: string): string {
  if (id.length <= 8) return id;
  if (!id.includes(SUB)) {
    for (let k = 8; k < id.length; k++) if (names(set, id.slice(0, k), id)) return id.slice(0, k);
    return id;
  }
  let best = id;
  const own = ownId(id);
  if (own.length >= 8 && !own.includes(":")) {
    for (let k = 8; k <= own.length; k++) {
      if (names(set, own.slice(0, k), id)) {
        best = own.slice(0, k);
        break;
      }
    }
  }
  const short = shortForm(id);
  if (short.length < best.length && names(set, short, id)) best = short;
  return best;
}

/** What shortestRef should print for `id`: the form, or the alias that takes its place. */
function expected(set: IdSet, id: string): { ref: string; form: string } {
  const form = shortestForm(set, id);
  if (form.length <= 40 && PLAIN.test(form)) return { ref: form, form };
  for (let k = 8; k <= 14; k++) {
    const alias = aliasOf(id, k);
    if (set.withPrefix(alias).length === 0 && names(set, alias, id)) return { ref: alias, form };
  }
  return { ref: form, form };
}

// ---------------------------------------------------------------- ids

/**
 * One step in making a case's ids. A step that starts from another id takes the one at `of` (or
 * `under`, for a parent), modulo the ids so far.
 */
type Step =
  | { kind: "top"; stem: string; tail: string }
  | { kind: "sub"; of: number; agent: string }
  | { kind: "cut"; of: number; keep: number }
  | { kind: "grow"; of: number; tail: string }
  | { kind: "pair"; of: number }
  | { kind: "twin"; of: number; under: number; tail: string }
  | { kind: "aliased"; of: number; digits: number; under: number; tail: string }
  | { kind: "self"; parent: string; keep: number; tail: string };

const STEMS = [
  "",
  "7c3e9d10-",
  "abcd1234",
  "36d2966a-1c53-47f1-891d-aae1827d0e9",
  "run-0123456789012345678901234567890123456789",
  "t3code-thread%3Aproj%253Ademo%253Aabcdefghijabcdefghij",
  "default/tenant-7/conv-",
  "tenant-7/",
  "x_0a9z",
  "my run ",
  "a&b$c#",
  "café-",
  "日本-",
];
/** Characters an id may carry that need quoting or are not ASCII, and `. : / _`. */
const ODD = [" ", "%", "&", "$", "#", "é", ".", ":", "/", "_", "\uD800", "�"];
const TAIL = gen.string({ alphabet: gen.frequency([12, gen.char("0a1b-")], [1, gen.char(ODD)]), maxLength: 6, avgLength: 3 });
/** Agent ids take digits no top-level id is made of, so no top-level id starts with one. */
const DIGITS = "2c3d";
const AGENT: Gen<string> = gen.frequency(
  [4, gen.map(gen.string({ alphabet: DIGITS, minLength: 8, maxLength: 17 }), (s) => `a${s}`)],
  [2, gen.string({ alphabet: DIGITS, minLength: 1, maxLength: 6 })],
  [1, gen.map(gen.string({ alphabet: DIGITS, maxLength: 10 }), (s) => `x_${s}`)],
  [1, gen.map(gen.tuple(gen.pick([".", "-", "/", ":"]), gen.string({ alphabet: DIGITS, maxLength: 9 })), ([c, s]) => `${c}${s}`)],
);
const OF = gen.nat(20);

const top: Gen<Step> = gen.map(gen.tuple(gen.pick(STEMS), TAIL), ([stem, tail]): Step => ({ kind: "top", stem, tail }));
const sub: Gen<Step> = gen.map(gen.tuple(OF, AGENT), ([of, agent]): Step => ({ kind: "sub", of, agent }));
const cut: Gen<Step> = gen.map(gen.tuple(OF, gen.int(1, 60)), ([of, keep]): Step => ({ kind: "cut", of, keep }));
const grow: Gen<Step> = gen.map(gen.tuple(OF, TAIL), ([of, tail]): Step => ({ kind: "grow", of, tail }));
const pair: Gen<Step> = gen.map(OF, (of): Step => ({ kind: "pair", of }));
const twin: Gen<Step> = gen.map(gen.tuple(OF, OF, gen.string({ alphabet: DIGITS, maxLength: 4 })), ([of, under, tail]): Step => ({ kind: "twin", of, under, tail }));
/** A negative `under` makes a top-level id; any other names the parent, so about half are a subagent's own id. */
const aliased: Gen<Step> = gen.map(gen.tuple(OF, gen.int(8, 14), gen.int(-20, 20), TAIL), ([of, digits, under, tail]): Step => ({ kind: "aliased", of, digits, under, tail }));
/** A parent no other id starts with, and not stored itself. */
const ORPHAN = gen.map(gen.string({ alphabet: DIGITS, minLength: 7, maxLength: 12 }), (s) => `q${s}`);
const self: Gen<Step> = gen.map(gen.tuple(ORPHAN, gen.int(8, 12), gen.string({ alphabet: DIGITS, maxLength: 4 })), ([parent, keep, tail]): Step => ({ kind: "self", parent, keep, tail }));

function idsOf(steps: readonly Step[]): string[] {
  const ids: string[] = [];
  const at = (of: number): string => ids[of % Math.max(1, ids.length)] ?? "0a1b2c3d4e";
  /** The own id of the first subagent at or after `of`, or an agent id when there is none. */
  const agentAt = (of: number): string => {
    for (let i = 0; i < ids.length; i++) {
      const own = ownId(at(of + i));
      if (own) return own;
    }
    return "a2c3d2c3d";
  };
  const add = (id: string): void => {
    // findSessionRef reads these words as the newest session before it looks for an id.
    if (id && id !== "latest" && id !== "last") ids.push(id);
  };
  for (const st of steps) {
    if (st.kind === "top") add(st.stem + st.tail);
    else if (st.kind === "sub") add(`${at(st.of)}${SUB}${st.agent}`);
    else if (st.kind === "cut") add(at(st.of).slice(0, st.keep));
    else if (st.kind === "grow") add(at(st.of) + st.tail);
    else if (st.kind === "pair") {
      const base = at(st.of);
      add(`${base}\uD800`);
      add(`${base}�`);
    } else if (st.kind === "twin") add(`${at(st.under)}${SUB}${agentAt(st.of)}${st.tail}`);
    else if (st.kind === "aliased") {
      const own = aliasOf(at(st.of), st.digits) + st.tail;
      add(st.under < 0 ? own : `${at(st.under)}${SUB}${own}`);
    } else add(`${st.parent}${SUB}${st.parent.slice(0, st.keep)}${st.tail}`);
  }
  return ids;
}

/**
 * A case: the ids of one store. `odd` adds `x_` ids and subagent ids made from another id's alias,
 * and subagents with no stored parent whose own id starts with their parent's id.
 */
function caseGen(odd: boolean): Gen<string[]> {
  const steps: [number, Gen<Step>][] = [[4, top], [3, sub], [1, cut], [1, grow], [1, pair], [1, twin]];
  if (odd) steps.push([2, aliased], [1, self]);
  return gen.map(gen.tuple(top, gen.array(gen.frequency(...steps), { maxLength: 10, avgLength: 6 })), ([first, rest]) => idsOf([first, ...rest]));
}

// ---------------------------------------------------------------- checks

/** What the checks run against: the real shortener and call resolver, or a mutant of one. */
interface Subject {
  shorten: (set: IdSet, id: string) => string;
  call: (index: IndexStore, ref: string) => Promise<AgentEvent>;
}

const REAL: Subject = { shorten: shortestRef, call: resolveCall };

const count = (seen: Map<string, number> | undefined, key: string): void => {
  seen?.set(key, (seen.get(key) ?? 0) + 1);
};

/** Each printed reference names its id alone through matchRef. */
function checkNames(s: Subject, ids: readonly string[], seen?: Map<string, number>): void {
  const set = new IdSet(ids);
  for (const id of set.ids) {
    const ref = s.shorten(set, id);
    assert.ok(names(set, ref, id), `${q(ref)}, printed for ${q(id)}, names ${named(set, ref)}`);
    if (id.length > 8 && !names(set, id.slice(0, 8), id)) count(seen, "an id whose first 8 characters do not name it");
  }
}

function callEvent(sessionId: string, id: string, ts: number): AgentEvent {
  return { id, v: 0, sessionId, ts, agent: "claude-code", kind: "llm.call", model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 1 }, payload: {} };
}

/** A memory store with a session of 1 to 3 model calls per id: each printed reference opens its session, and its first and last calls after `#`. */
async function checkStore(s: Subject, ids: readonly string[]): Promise<void> {
  const set = new IdSet(ids);
  const index = new MemoryIndexStore();
  const calls = new Map<string, AgentEvent[]>();
  set.ids.forEach((id, i) => {
    const mine: AgentEvent[] = [];
    for (let j = 0; j <= i % 3; j++) mine.push(callEvent(id, `e${i}.${j}`, 1000 * i + j));
    calls.set(id, mine);
  });
  await index.putEvents([...calls.values()].flat());
  for (const mine of calls.values()) await index.upsertSession(buildSession(mine));
  for (const id of set.ids) {
    const ref = s.shorten(set, id);
    const found = await findSessionRef(index, ref);
    assert.equal(found?.id, id, `findSessionRef opens ${found ? q(found.id) : "nothing"} for ${q(ref)}, printed for ${q(id)}`);
    const mine = calls.get(id) ?? [];
    for (const [n, want] of [[1, mine[0]], [-1, mine[mine.length - 1]]] as const) {
      const got = await s.call(index, `${ref}#${n}`);
      assert.equal(got.id, want?.id, `${q(`${ref}#${n}`)} names call ${q(got.id)} of ${q(got.sessionId)}, not ${q(want?.id ?? "")} of ${q(id)}`);
    }
    const past = `${ref}#${mine.length + 1}`;
    await assert.rejects(s.call(index, past), (e: unknown) => e instanceof CallRefError && e.reason === "not_found", `${q(past)} names a call after the last`);
  }
}

/** Each printed alias is the id's own and starts no stored id. */
function checkAliases(s: Subject, ids: readonly string[], seen?: Map<string, number>): void {
  const set = new IdSet(ids);
  for (const id of set.ids) {
    const ref = s.shorten(set, id);
    if (!isAlias(ref, id)) continue;
    count(seen, ref.length > 10 ? "a longer alias" : "an alias");
    assert.equal(ref, aliasOf(id, ref.length - 2), `${q(ref)}, printed for ${q(id)}, is not the first ${ref.length - 2} digits of its SHA-256 in base32`);
    const starts = set.withPrefix(ref);
    assert.equal(starts.length, 0, `${q(ref)}, printed for ${q(id)}, starts the stored id ${q(starts[0] ?? "")}`);
  }
}

/** What a case's expected reference is, for the counts the shortest check reports. */
function kindOf(id: string, want: { ref: string; form: string }): string {
  if (want.ref !== want.form) return want.ref.length > 10 ? "a longer alias" : "an alias";
  if (want.form.length > 40 || !PLAIN.test(want.form)) return "no free alias";
  if (want.form === id) return "the whole id";
  if (want.form.includes(SUB)) return "a short subagent form";
  if (id.startsWith(want.form)) return want.form.length > 8 ? "a prefix over 8 characters" : "an 8-character prefix";
  return "a prefix of a subagent's own id";
}

/** Each printed reference is the one the rules pick (expected). */
function checkShortest(s: Subject, ids: readonly string[], seen?: Map<string, number>): void {
  const set = new IdSet(ids);
  for (const id of set.ids) {
    const ref = s.shorten(set, id);
    const want = expected(set, id);
    count(seen, kindOf(id, want));
    if (ref === want.ref) continue;
    const alias = want.ref !== want.form;
    if (alias && !isAlias(ref, id)) assert.fail(`${q(ref)}, printed for ${q(id)}, needs an alias (${want.form.length > 40 ? "it is over 40 characters" : "it needs quoting"}), and ${q(want.ref)} names the id alone`);
    if (!alias && isAlias(ref, id)) assert.fail(`the alias ${q(ref)}, printed for ${q(id)}, is not needed: ${q(want.form)} names the id`);
    assert.fail(`${q(ref)}, printed for ${q(id)}, is not the reference the rules pick: ${q(want.ref)}`);
  }
}

/** Fails unless every kind in `kinds` was seen; reports the counts. */
function covered(t: { diagnostic: (m: string) => void }, seen: Map<string, number>, kinds: readonly string[]): void {
  t.diagnostic([...seen].map(([k, n]) => `${k}: ${n}`).join(", "));
  for (const k of kinds) assert.ok((seen.get(k) ?? 0) > 0, `no case had ${k}`);
}

// ---------------------------------------------------------------- the properties

test("a printed reference names its session and no other", async (t) => {
  const seen = new Map<string, number>();
  await forAll(caseGen(true), (ids) => checkNames(REAL, ids, seen), { runs: RUNS, label: "names" });
  covered(t, seen, ["an id whose first 8 characters do not name it"]);
});

test("a printed reference opens its session through findSessionRef, and `<ref>#1` and `<ref>#-1` are its first and last model calls", async () => {
  await forAll(caseGen(true), (ids) => checkStore(REAL, ids), { runs: STORE_RUNS, label: "store" });
});

test("a printed alias is x_ and the first digits of the id's SHA-256 in base32, and starts no stored id", async (t) => {
  const seen = new Map<string, number>();
  await forAll(caseGen(true), (ids) => checkAliases(REAL, ids, seen), { runs: RUNS, label: "aliases" });
  covered(t, seen, ["an alias", "a longer alias"]);
});

test("a printed reference is the shortest the rules allow, and an alias only where the prefix is over 40 characters or needs quoting", async (t) => {
  const seen = new Map<string, number>();
  await forAll(caseGen(false), (ids) => checkShortest(REAL, ids, seen), { runs: RUNS, label: "shortest" });
  covered(t, seen, ["the whole id", "an 8-character prefix", "a prefix over 8 characters", "a prefix of a subagent's own id", "a short subagent form", "an alias", "no free alias"]);
});

test("each check fails on a mutant of the shortener or the call resolver", async (t) => {
  const eight: Subject = { ...REAL, shorten: (_set, id) => id.slice(0, 8) };
  const oneShort: Subject = {
    ...REAL,
    shorten: (set, id) => {
      const r = shortestRef(set, id);
      return r.length > 8 && !isAlias(r, id) ? r.slice(0, -1) : r;
    },
  };
  const fromZero: Subject = { ...REAL, call: (index, ref) => resolveCall(index, ref.replace(/#(\d+)$/, (_m, n: string) => `#${Number(n) + 1}`)) };
  const sha1: Subject = {
    ...REAL,
    shorten: (set, id) => {
      const r = shortestRef(set, id);
      return isAlias(r, id) ? `x_${createHash("sha1").update(id).digest("hex").slice(0, r.length - 2)}` : r;
    },
  };
  const firstAlias: Subject = {
    ...REAL,
    shorten: (set, id) => {
      const r = shortestRef(set, id);
      return isAlias(r, id) ? aliasOf(id, 8) : r;
    },
  };
  const oneLong: Subject = {
    ...REAL,
    shorten: (set, id) => {
      const r = shortestRef(set, id);
      return !isAlias(r, id) && r.length < id.length && id.startsWith(r) ? id.slice(0, r.length + 1) : r;
    },
  };
  const noAlias: Subject = {
    ...REAL,
    shorten: (set, id) => {
      const r = shortestRef(set, id);
      return isAlias(r, id) ? shortestForm(set, id) : r;
    },
  };
  const allAlias: Subject = { ...REAL, shorten: (_set, id) => aliasOf(id, 8) };
  const mutants: [string, () => Promise<PropertyFailure>, RegExp][] = [
    ["names, a shortener that prints 8 characters", () => failure(caseGen(true), (ids) => checkNames(eight, ids), "eight"), /printed for .*, names (nothing|\d+ ids|")/],
    ["names, a shortener one character short", () => failure(caseGen(true), (ids) => checkNames(oneShort, ids), "one short"), /printed for .*, names (nothing|\d+ ids|")/],
    ["store, a call resolver that counts from 0", () => failure(caseGen(true), (ids) => checkStore(fromZero, ids), "from zero"), /names call|model call/],
    ["aliases, the digits of another hash", () => failure(caseGen(true), (ids) => checkAliases(sha1, ids), "sha1"), /is not the first \d+ digits/],
    ["aliases, the first alias even where a stored id starts with it", () => failure(caseGen(true), (ids) => checkAliases(firstAlias, ids), "first alias"), /starts the stored id/],
    ["shortest, a shortener one character long", () => failure(caseGen(false), (ids) => checkShortest(oneLong, ids), "one long"), /is not the reference the rules pick/],
    ["shortest, a shortener that never prints an alias", () => failure(caseGen(false), (ids) => checkShortest(noAlias, ids), "no alias"), /needs an alias/],
    ["shortest, a shortener that always prints an alias", () => failure(caseGen(false), (ids) => checkShortest(allAlias, ids), "all alias"), /is not needed/],
  ];
  for (const [label, run, why] of mutants) {
    const f = await run();
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure<T>(g: Gen<T>, prop: (v: T) => void | Promise<void>, label: string): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, { env: {}, runs: MUTANT_RUNS, label });
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${label} passed`);
}
