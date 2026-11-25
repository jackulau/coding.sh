// Short session ids (core/session-ref.ts): the reference coding.sh prints for a session (shortestRef)
// and how a reference is read back (matchRef, findSessionRef, and the session part of a call
// reference, proxy/calls.ts resolveCall). The properties, over sets of ids drawn to collide:
//
// - A printed reference names its session and no other: through matchRef; through findSessionRef on
//   a store that holds the sessions; and in a call reference, where `<ref>#1` is the session's first
//   model call, `<ref>#-1` its last, and the number after the last is not found.
// - A printed alias is `x_` and the first 8 to 14 digits of the first 70 bits of the id's SHA-256 in
//   Crockford's base32, worked out here apart from session-ref.ts, and no stored id starts with it,
//   unless the id is `latest` or `last` and a stored id starts with every alias length.
// - A printed reference is the one the rules pick, found here by trying every length rather than by
//   bisecting: the whole id when it has 8 characters or fewer; for a top-level id, the shortest prefix
//   of 8 or more characters that names it; for a subagent, the shortest prefix of 8 or more characters
//   of its own id, or its short form (8 characters of each part) when that is shorter and names it.
//   When that is over 40 characters, needs quoting in a shell, or is `latest` or `last` (findSessionRef
//   reads those words as the newest session), the shortest alias that names the id alone and starts
//   no stored id takes its place, unless every alias length is taken. `latest` and `last` then print
//   the shortest alias that names them alone anyway: matchRef reads an alias before a prefix.
// - A reference that is not an alias (`x_` and 8 to 14 alias digits) reads as matchRef's comment
//   says, worked out here by scanning every id: the id itself; else a prefix of 4 or more
//   characters; else, with a `/` and not under `default/`, that id under `default/` or a prefix of
//   one; else, with 4 or more characters and no `:`, an id in which `:sub:` is followed by it; else
//   a short subagent id: as many `:sub:` parts as the id, none empty, the first of 4 or more
//   characters, each a prefix of the id's. The first step that finds ids decides: an id and its
//   subagents are the id, and other ids are all listed. The references read are every prefix of
//   each id, of what follows each `:sub:` in it and of it after `default/`; its parts cut to 1 to 9
//   characters, all of them or the first alone; and `x_` with 1 to 7 of its alias digits.
// - A reference that reads as several sessions makes findSessionRef throw AmbiguousRef, which holds
//   the reference, up to 10 of the sessions, newest first, each with its printed reference, and
//   whether there are more.
// - `latest` and `last` open the session latestSession's comment names, worked out here from the
//   stored sessions, newest first as the store lists them: of the top-level sessions without a run
//   id (of all top-level sessions when each has one), the newest that is not empty
//   (isEmptySession), else the newest. When the one that is not empty is no wrapper and has no
//   snapshot of its own, start or end, they open the newest wrapper that was running when it
//   started (it started at or before then and ended at or after, or runs still), unless both name
//   a directory and the two differ (wrapperAround's code; its comment does not say), and else the
//   session itself.
//
// Ids are drawn from stems that share long prefixes: UUIDs, T3 Code-like thread ids with
// percent-encoding, plain ids over 40 characters, SDK ids under `default/` and other projects, `x_`
// ids, `latest` and `last`, and ids with a space, `&`, `$`, `#` or non-ASCII characters. Some are
// subagents (nested too, and some of an empty id), some under other parents share or extend another
// subagent's own id, some are another id cut short or grown, so one id is a prefix of another, and
// some come in pairs whose UTF-8 is the same (a lone surrogate and U+FFFD), so they share every
// alias. Where a prefix names an id and a longer one does not, bisecting alone can miss the
// shortest: `x_` ids, top-level or a subagent's own id, made from another id's alias; subagents
// whose own id is another id without `default/`; and subagents whose parent is not stored, under
// `default/` or not, whose own id starts with the first characters of the parent's id after
// `default/`.
//
// Latest cases hold Claude Code, Codex and wrapper sessions that start and end on the same few
// seconds, so starts and ends coincide: some empty, some with a run id (a wrapper only where every
// session has one), a start or end snapshot, no end yet, or one of two directories or none; up to
// 200 empty sessions newer than those; and newer subagents that are not empty, which are never the
// latest. A case holds at most 200 top-level sessions without a run id and fewer than 20 wrappers,
// all started within seconds: latestSession reads no further than the newest 200 sessions, and
// looks for the wrapper among the newest 20 of the 6 hours before, bounds its comment does not give.
//
// The last test shows each check fails on a mutant of the shortener, the reader, the call resolver
// or the session lookup.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 200, and 100 in the store and AmbiguousRef tests);
// CODING_SH_PROP_SEED=s replays one. The last test reads neither.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AmbiguousRef, findSessionRef, IdSet, matchRef, shortestRef, type RefMatch } from "../../src/core/session-ref.ts";
import { buildSession, isEmptySession } from "../../src/core/sessions.ts";
import type { IndexStore, Session, SessionFilter } from "../../src/core/types.ts";
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
/** Words findSessionRef reads as the newest session: a session with one as its id prints an alias. */
const WORDS = new Set(["latest", "last"]);
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

/** What a match names, for a message. */
function shown(m: RefMatch | undefined): string {
  if (!m) return "nothing";
  return "id" in m ? q(m.id) : `${m.ambiguous.length} ids (${m.ambiguous.map(q).join(", ")})`;
}

/** What matchRef takes `ref` to, for a message. */
const named = (set: IdSet, ref: string): string => shown(matchRef(set, ref));

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

/** True when `form`, a prefix of the id or of a subagent's own id, names the id and a longer prefix of the same does not: bisecting alone can miss it. */
function longerMisses(set: IdSet, id: string, form: string): boolean {
  const own = ownId(id);
  const from = own || id;
  if (form === id || form.length < 8 || !from.startsWith(form)) return false;
  for (let k = form.length + 1; k <= (own ? own.length : id.length - 1); k++) if (!names(set, from.slice(0, k), id)) return true;
  return false;
}

/** Why `form` prints as an alias, or undefined when it prints as it is. */
function aliasReason(form: string): string | undefined {
  if (form.length > 40) return "it is over 40 characters";
  if (!PLAIN.test(form)) return "it needs quoting";
  if (WORDS.has(form)) return "the word opens the newest session";
  return undefined;
}

/** The shortest alias of `id` that names it alone and starts no stored id; with `taken`, one that starts a stored id too. */
function aliasFor(set: IdSet, id: string, taken = false): string | undefined {
  for (let k = 8; k <= 14; k++) {
    const alias = aliasOf(id, k);
    if ((taken || set.withPrefix(alias).length === 0) && names(set, alias, id)) return alias;
  }
  return undefined;
}

/** What shortestRef should print for `id`: the form, or the alias that takes its place. */
function expected(set: IdSet, id: string): { ref: string; form: string } {
  const form = shortestForm(set, id);
  if (!aliasReason(form)) return { ref: form, form };
  const alias = aliasFor(set, id) ?? (WORDS.has(form) ? aliasFor(set, id, true) : undefined);
  return { ref: alias ?? form, form };
}

/** The one id `ids` stand for: the shortest when every other is a subagent of it, else all of them. */
function groupOf(ids: readonly string[]): RefMatch {
  const head = ids.reduce((a, b) => (b.length < a.length ? b : a));
  return ids.every((x) => x === head || x.startsWith(`${head}${SUB}`)) ? { id: head } : { ambiguous: [...ids] };
}

/**
 * What `ref`, not an alias, reads as among `ids`, found by scanning them in the order matchRef's
 * comment gives (see the header), and the step that decides. `min` is the shortest prefix read.
 */
function readOf(ids: readonly string[], ref: string, min = 4): { step: string; match?: RefMatch } {
  if (!ref) return { step: "nothing" };
  if (ids.includes(ref)) return { step: "the exact id", match: { id: ref } };
  const scoped = `default/${ref}`;
  const parts = ref.split(SUB);
  const steps: [step: string, applies: boolean, takes: (x: string) => boolean][] = [
    [ref.length === min ? `a ${min}-character prefix` : "a longer prefix", ref.length >= min, (x) => x.startsWith(ref)],
    ["an SDK id without default/", ref.includes("/") && !ref.startsWith("default/"), (x) => x === scoped || (!ids.includes(scoped) && x.startsWith(scoped))],
    ["a subagent's own id", ref.length >= min && !ref.includes(":"), (x) => x.includes(`${SUB}${ref}`)],
    [
      "a short subagent id",
      parts.length >= 2 && parts[0]!.length >= min && parts.every((p) => p),
      (x) => {
        const xs = x.split(SUB);
        return xs.length === parts.length && xs.every((p, i) => p.startsWith(parts[i]!));
      },
    ],
  ];
  for (const [step, applies, takes] of steps) {
    const found = applies ? ids.filter(takes) : [];
    if (found.length) return { step, match: groupOf(found) };
  }
  return { step: "nothing" };
}

/** The references the reads check reads for `ids` (see the header). */
function refsFor(ids: readonly string[]): Set<string> {
  const refs = new Set<string>();
  const prefixes = (s: string): void => {
    for (let k = 1; k <= s.length; k++) refs.add(s.slice(0, k));
  };
  for (const id of ids) {
    prefixes(id);
    for (let at = id.indexOf(SUB); at >= 0; at = id.indexOf(SUB, at + 1)) prefixes(id.slice(at + SUB.length));
    if (id.startsWith("default/")) prefixes(id.slice("default/".length));
    const parts = id.split(SUB);
    for (let k = 1; k <= 9; k++) {
      refs.add(parts.map((p) => p.slice(0, k)).join(SUB));
      refs.add([parts[0]!.slice(0, k), ...parts.slice(1)].join(SUB));
    }
    for (let k = 1; k <= 7; k++) refs.add(aliasOf(id, k));
  }
  return refs;
}

/** `m` with an ambiguous list sorted, for comparing. */
const sorted = (m: RefMatch | undefined): RefMatch | undefined => (m && "ambiguous" in m ? { ambiguous: [...m.ambiguous].sort() } : m);

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
  | { kind: "self"; parent: string; scoped: boolean; keep: number; tail: string }
  | { kind: "own"; of: number; under: number; tail: string };

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
  "latest",
  "last",
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
/** An `of` of -1 makes a subagent of an empty id: `:sub:<agent>`. */
const sub: Gen<Step> = gen.map(gen.tuple(gen.int(-1, 20), AGENT), ([of, agent]): Step => ({ kind: "sub", of, agent }));
const cut: Gen<Step> = gen.map(gen.tuple(OF, gen.int(1, 60)), ([of, keep]): Step => ({ kind: "cut", of, keep }));
const grow: Gen<Step> = gen.map(gen.tuple(OF, TAIL), ([of, tail]): Step => ({ kind: "grow", of, tail }));
const pair: Gen<Step> = gen.map(OF, (of): Step => ({ kind: "pair", of }));
const twin: Gen<Step> = gen.map(gen.tuple(OF, OF, gen.string({ alphabet: DIGITS, maxLength: 4 })), ([of, under, tail]): Step => ({ kind: "twin", of, under, tail }));
/** A negative `under` makes a top-level id; any other names the parent, so about half are a subagent's own id. */
const aliased: Gen<Step> = gen.map(gen.tuple(OF, gen.int(8, 14), gen.int(-20, 20), TAIL), ([of, digits, under, tail]): Step => ({ kind: "aliased", of, digits, under, tail }));
/** A parent no other id starts with, and not stored itself; some hold a `/`. */
const ORPHAN = gen.map(gen.string({ alphabet: gen.frequency([12, gen.char(DIGITS)], [1, gen.char("/")]), minLength: 7, maxLength: 12 }), (s) => `q${s}`);
/** A subagent of an ORPHAN, under `default/` or not, whose own id starts with the ORPHAN's first 8 to 12 characters. */
const self: Gen<Step> = gen.map(gen.tuple(ORPHAN, gen.bool, gen.int(8, 12), gen.string({ alphabet: DIGITS, maxLength: 4 })), ([parent, scoped, keep, tail]): Step => ({ kind: "self", parent, scoped, keep, tail }));
/** A subagent whose own id is another id (one under `default/` when there is one) without `default/`, grown by a tail. */
const own: Gen<Step> = gen.map(gen.tuple(OF, OF, gen.string({ alphabet: DIGITS, maxLength: 4 })), ([of, under, tail]): Step => ({ kind: "own", of, under, tail }));

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
  /** The first id at or after `of` under `default/`, or the one at `of` when there is none. */
  const scopedAt = (of: number): string => {
    for (let i = 0; i < ids.length; i++) if (at(of + i).startsWith("default/")) return at(of + i);
    return at(of);
  };
  const add = (id: string): void => {
    if (id) ids.push(id);
  };
  for (const st of steps) {
    if (st.kind === "top") add(st.stem + st.tail);
    else if (st.kind === "sub") add(`${st.of < 0 ? "" : at(st.of)}${SUB}${st.agent}`);
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
    } else if (st.kind === "self") add(`${st.scoped ? "default/" : ""}${st.parent}${SUB}${st.parent.slice(0, st.keep)}${st.tail}`);
    else add(`${at(st.under)}${SUB}${scopedAt(st.of).replace(/^default\//, "")}${st.tail}`);
  }
  return ids;
}

/** A case: the ids of one store. */
const CASE: Gen<string[]> = gen.map(
  gen.tuple(top, gen.array(gen.frequency<Step>([4, top], [3, sub], [1, cut], [1, grow], [1, pair], [2, twin], [2, aliased], [2, self], [2, own]), { maxLength: 10, avgLength: 6 })),
  ([first, rest]) => idsOf([first, ...rest]),
);

// ---------------------------------------------------------------- checks

/** What the checks run against: the real shortener, reader, call resolver and session lookup, or a mutant of one. */
interface Subject {
  shorten: (set: IdSet, id: string) => string;
  read: (set: IdSet, ref: string) => RefMatch | undefined;
  call: (index: IndexStore, ref: string) => Promise<AgentEvent>;
  find: (index: IndexStore, ref: string) => Promise<Session | undefined>;
}

const REAL: Subject = { shorten: shortestRef, read: matchRef, call: resolveCall, find: findSessionRef };

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

/** A memory store with a session per id, of 1 to 3 model calls, started in an order the ids' order does not give. */
async function storeOf(ids: readonly string[]): Promise<{ index: MemoryIndexStore; calls: Map<string, AgentEvent[]>; sessions: Map<string, Session> }> {
  const key = (id: string): string => `${aliasOf(id, 14)} ${id}`;
  const rank = new Map([...ids].sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((id, r) => [id, r]));
  const index = new MemoryIndexStore();
  const calls = new Map<string, AgentEvent[]>();
  ids.forEach((id, i) => {
    const mine: AgentEvent[] = [];
    for (let j = 0; j <= i % 3; j++) mine.push(callEvent(id, `e${i}.${j}`, 1000 * (rank.get(id) ?? 0) + j));
    calls.set(id, mine);
  });
  await index.putEvents([...calls.values()].flat());
  const sessions = new Map<string, Session>();
  for (const [id, mine] of calls) {
    const session = buildSession(mine);
    sessions.set(id, session);
    await index.upsertSession(session);
  }
  return { index, calls, sessions };
}

/** Each printed reference opens its session, and its first and last calls after `#`. */
async function checkStore(s: Subject, ids: readonly string[]): Promise<void> {
  const set = new IdSet(ids);
  const { index, calls } = await storeOf(set.ids);
  for (const id of set.ids) {
    const ref = s.shorten(set, id);
    const found = await s.find(index, ref);
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
    if (starts.length > 0 && WORDS.has(id) && aliasFor(set, id) === undefined) {
      count(seen, "a word whose every alias starts a stored id");
      continue;
    }
    assert.equal(starts.length, 0, `${q(ref)}, printed for ${q(id)}, starts the stored id ${q(starts[0] ?? "")}`);
  }
}

/** What a case's expected reference is, for the counts the shortest check reports. */
function kindOf(id: string, want: { ref: string; form: string }): string {
  if (WORDS.has(id)) return "latest or last";
  if (want.ref !== want.form) return want.ref.length > 10 ? "a longer alias" : "an alias";
  if (aliasReason(want.form)) return "no free alias";
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
    if (longerMisses(set, id, want.form)) count(seen, "a prefix that names the id where a longer one does not");
    if (id.startsWith(SUB) && ownId(id).length >= 8) count(seen, "a subagent of an empty id");
    if (ref === want.ref) continue;
    const alias = want.ref !== want.form;
    if (alias && !isAlias(ref, id)) assert.fail(`${q(ref)}, printed for ${q(id)}, needs an alias (${aliasReason(want.form)}), and ${q(want.ref)} names the id alone`);
    if (!alias && isAlias(ref, id)) assert.fail(`the alias ${q(ref)}, printed for ${q(id)}, is not needed: ${q(want.form)} names the id`);
    assert.fail(`${q(ref)}, printed for ${q(id)}, is not the reference the rules pick: ${q(want.ref)}`);
  }
}

/** Each reference that is not an alias reads as the scan finds (readOf). */
function checkReads(s: Subject, ids: readonly string[], seen?: Map<string, number>): void {
  const set = new IdSet(ids);
  for (const ref of refsFor(set.ids)) {
    if (ALIAS_FORM.test(ref)) continue;
    const want = readOf(set.ids, ref);
    count(seen, want.step);
    if (want.match && "ambiguous" in want.match) count(seen, "several ids");
    const got = s.read(set, ref);
    assert.deepEqual(sorted(got), sorted(want.match), `${q(ref)} reads as ${shown(got)}, not ${shown(want.match)} (${want.step})`);
  }
}

/** Each reference that reads as several sessions makes the lookup throw AmbiguousRef: the reference, up to 10 of them newest first as they print, and whether there are more. */
async function checkAmbiguous(s: Subject, ids: readonly string[], seen?: Map<string, number>): Promise<void> {
  const set = new IdSet(ids);
  const { index, sessions } = await storeOf(set.ids);
  const done = new Set<string>();
  for (const ref of refsFor(set.ids)) {
    const m = matchRef(set, ref);
    if (!m || !("ambiguous" in m) || WORDS.has(ref)) continue;
    const key = m.ambiguous.join("\n");
    if (done.has(key)) continue;
    done.add(key);
    const n = m.ambiguous.length;
    count(seen, n > 10 ? "more than 10 sessions" : "2 to 10 sessions");
    const e: unknown = await s.find(index, ref).then(
      (found) => assert.fail(`${q(ref)}, which reads as ${n} ids, opens ${found ? q(found.id) : "nothing"}`),
      (x: unknown) => x,
    );
    assert.ok(e instanceof AmbiguousRef, `${q(ref)}, which reads as ${n} ids, throws ${String(e)}`);
    const of = `the error for ${q(ref)}`;
    assert.equal(e.ref, ref, `${of} holds the reference ${q(String(e.ref))}`);
    assert.equal(e.more, n > 10, `${of} says there are${e.more ? "" : " no"} more than it lists, of ${n}`);
    assert.equal(e.candidates.length, Math.min(n, 10), `${of} lists ${e.candidates.length} of its ${n} sessions`);
    assert.equal(new Set(e.candidates.map((c) => c.id)).size, e.candidates.length, `${of} lists a session twice`);
    for (const c of e.candidates) {
      const stored = sessions.get(c.id);
      assert.ok(stored && m.ambiguous.includes(c.id), `${of} lists ${q(c.id)}, which the reference does not read as`);
      assert.equal(c.shortId, s.shorten(set, c.id), `${of} lists ${q(c.id)} as ${q(c.shortId)}, not as it prints`);
      assert.deepEqual([c.agent, c.startedAt, c.title], [stored.agent, stored.startedAt, stored.title], `${of} lists ${q(c.id)} with another agent, start or title`);
    }
    const starts = e.candidates.map((c) => c.startedAt);
    assert.ok(
      starts.every((t, i) => i === 0 || starts[i - 1]! >= t),
      `${of} lists its sessions started at ${starts.join(", ")}, not newest first`,
    );
  }
}

// ---------------------------------------------------------------- the newest session

/** Directories a latest case's sessions ran in: none, or one of two. */
const CWDS = [undefined, "/work/demo", "/work/other"];
/** The first second of a latest case. */
const T0 = Date.UTC(2026, 0, 1);

/** A session of a latest case. */
interface Row {
  agent: string;
  /** Its start, in seconds after T0. */
  at: number;
  /** How many seconds it ran, or null when it has not ended. */
  ran: number | null;
  /** A run id, unless it is a wrapper (a case with `trials` gives every session one). */
  run: boolean;
  /** A turn: with neither one nor a start snapshot, the session is empty. */
  work: boolean;
  /** A snapshot at its start (repo.snapshot). */
  start: boolean;
  /** A snapshot at its end (endSnapshot). */
  end: boolean;
  /** Its directory, from CWDS. */
  cwd: number;
}

/**
 * A latest case: its sessions, how many empty sessions without a run id are newer, how many
 * subagents are newer still, and whether every top-level session has a run id (then none is newer).
 */
interface Latest {
  rows: Row[];
  lead: number;
  subs: number;
  trials: boolean;
}

/**
 * A session of a latest case. Wrappers are seldom other than empty, so the newest that is not is
 * often an agent's, and some start a second after every agent session.
 */
const ROW: Gen<Row> = gen.chain(gen.frequency<string>([3, gen.constant("claude-code")], [1, gen.constant("codex")], [2, gen.constant("wrapper")]), (agent) => {
  const wrapper = agent === "wrapper";
  return gen.record<Row>({
    agent: gen.constant(agent),
    at: gen.int(0, wrapper ? 4 : 3),
    ran: gen.frequency<number | null>([3, gen.int(0, 2)], [1, gen.constant(null)]),
    run: gen.weighted(0.15),
    work: gen.weighted(wrapper ? 0.2 : 0.6),
    start: gen.weighted(wrapper ? 0.1 : 0.2),
    end: gen.weighted(0.2),
    cwd: gen.int(0, 2),
  });
});
/** Up to 16 sessions, so fewer than 20 wrappers; the empty ones ahead of them number about 50, about 150 or near 200 now and then, where latestSession's reads of 50 at a time end. */
const LATEST: Gen<Latest> = gen.record<Latest>({
  rows: gen.array(ROW, { maxLength: 16, avgLength: 10 }),
  lead: gen.frequency([10, gen.constant(0)], [3, gen.int(1, 3)], [1, gen.int(47, 53)], [1, gen.int(147, 153)], [1, gen.int(190, 200)]),
  subs: gen.frequency([3, gen.constant(0)], [1, gen.int(1, 2)]),
  trials: gen.weighted(0.1),
});

/** The session of row `r`. */
function rowSession(id: string, r: Row): Session {
  const startedAt = T0 + r.at * 1000;
  const s: Session = { id, agent: r.agent, startedAt, flags: [], stats: { events: 1, turns: r.work ? 1 : 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } };
  if (r.ran !== null) s.endedAt = startedAt + r.ran * 1000;
  if (r.run && r.agent !== "wrapper") s.runId = "run-1";
  const cwd = CWDS[r.cwd];
  if (cwd) s.cwd = cwd;
  if (r.start) s.repo = { root: "/work/demo", head: "0".repeat(40), snapshot: "1".repeat(40) };
  if (r.end) s.endSnapshot = "2".repeat(40);
  return s;
}

/** A memory store with a latest case's sessions, and every session as it lists them, newest first. */
async function latestStore(c: Latest): Promise<{ index: MemoryIndexStore; listed: Session[] }> {
  const index = new MemoryIndexStore();
  const sessions = c.rows.map((r, i) => rowSession(`row-${i}`, r));
  if (c.trials) for (const s of sessions) s.runId = "run-1";
  // At most 200 top-level sessions without a run id (see the header).
  const lead = c.trials ? 0 : Math.min(c.lead, 200 - sessions.filter((s) => s.runId === undefined).length);
  for (let i = 0; i < lead; i++) sessions.push(rowSession(`lead-${i}`, { agent: "claude-code", at: 6 + (i % 3), ran: 1, run: false, work: false, start: false, end: false, cwd: i % 3 }));
  for (let i = 0; i < c.subs; i++) {
    const sub = rowSession(`sub-${i}`, { agent: "claude-code", at: 9, ran: null, run: false, work: true, start: false, end: false, cwd: 1 });
    sub.parent = { sessionId: i === 0 && sessions[0] ? sessions[0].id : "gone" };
    sessions.push(sub);
  }
  for (const s of sessions) await index.upsertSession(s);
  return { index, listed: await index.listSessions() };
}

/** True when wrapper `w` was running when `s` started: it started at or before then, and ended at or after or runs still. */
const runningAt = (w: Session, s: Session): boolean => w.startedAt <= s.startedAt && (w.endedAt === undefined || w.endedAt >= s.startedAt);
/** False only when both name a directory and the two differ. */
const sameDir = (w: Session, s: Session): boolean => !w.cwd || !s.cwd || w.cwd === s.cwd;

/** What `latest` should open among `listed` (every session, newest first), and why (see the header). */
interface LatestPick {
  want: Session | undefined;
  why: string;
  /** The newest session that is not empty, of those that count. */
  hit?: Session;
  /** How many sessions that count are newer than `hit`. */
  at: number;
  /** True when every top-level session has a run id. */
  runs: boolean;
}

function latestOf(listed: readonly Session[]): LatestPick {
  const top = listed.filter((s) => !s.parent);
  const organic = top.filter((s) => s.runId === undefined);
  const runs = organic.length === 0 && top.length > 0;
  const pool = runs ? top : organic;
  const of = runs ? " (every session has a run id)" : "";
  const at = pool.findIndex((s) => !isEmptySession(s));
  const hit = pool[at];
  if (!hit) return { want: pool[0], why: `every session is empty, so the newest${of}`, at, runs };
  const own = hit.agent === "wrapper" ? "it is a wrapper" : hit.repo?.snapshot || hit.endSnapshot ? "it has a snapshot of its own" : undefined;
  if (own) return { want: hit, why: `the newest session that is not empty${of}; ${own}`, hit, at, runs };
  const wrapper = top.find((w) => w.agent === "wrapper" && runningAt(w, hit) && sameDir(w, hit));
  if (wrapper) return { want: wrapper, why: `the newest wrapper running when ${q(hit.id)}, the newest session that is not empty${of}, started`, hit, at, runs };
  return { want: hit, why: `the newest session that is not empty${of}; no wrapper was running when it started`, hit, at, runs };
}

/** `latest` and `last` open the session latestOf names. */
async function checkLatest(s: Subject, c: Latest, seen?: Map<string, number>): Promise<void> {
  const { index, listed } = await latestStore(c);
  const { want, why, hit, at, runs } = latestOf(listed);
  if (runs) count(seen, "only sessions with a run id");
  if (listed.some((x) => x.parent)) count(seen, "a newer subagent");
  if (!hit) count(seen, "only empty sessions");
  else {
    if (at > 0) count(seen, "a newer empty session");
    if (at >= 50) count(seen, "at least 50 newer empty sessions");
    if (at >= 150) count(seen, "at least 150 newer empty sessions");
    const wrappers = listed.filter((w) => w.agent === "wrapper" && !w.parent && w !== hit);
    if (hit.agent === "wrapper") count(seen, "a wrapper that is not empty");
    else if (wrappers.some((w) => runningAt(w, hit) && sameDir(w, hit))) {
      if (hit.repo?.snapshot && !hit.endSnapshot) count(seen, "a session in a wrapper with only a start snapshot of its own");
      if (!hit.repo?.snapshot && hit.endSnapshot) count(seen, "a session in a wrapper with only an end snapshot of its own");
    }
    if (want && want !== hit) {
      count(seen, "a session in a wrapper");
      if (want.startedAt === hit.startedAt) count(seen, "a session that started with its wrapper");
      if (want.endedAt === hit.startedAt) count(seen, "a wrapper that ended as its session started");
      if (want.endedAt === undefined) count(seen, "a wrapper still running");
      if (!want.cwd !== !hit.cwd) count(seen, "a wrapper or a session with no directory");
      if (want.cwd && want.cwd === hit.cwd) count(seen, "a wrapper in the session's directory");
    }
    if (hit.agent !== "wrapper" && !hit.repo?.snapshot && !hit.endSnapshot) {
      if (wrappers.some((w) => runningAt(w, hit) && !sameDir(w, hit))) count(seen, "a wrapper in another directory");
      if (wrappers.some((w) => w.startedAt > hit.startedAt && sameDir(w, hit))) count(seen, "a wrapper that started after the session");
      if (wrappers.some((w) => w.endedAt !== undefined && w.endedAt < hit.startedAt && sameDir(w, hit))) count(seen, "a wrapper that ended before the session started");
    }
  }
  for (const word of WORDS) {
    const got = await s.find(index, word);
    assert.equal(got?.id, want?.id, `${q(word)} opens ${got ? q(got.id) : "nothing"}, not ${want ? q(want.id) : "nothing"}: ${why}`);
  }
}

const LATEST_KINDS = [
  "only sessions with a run id",
  "a newer subagent",
  "only empty sessions",
  "a newer empty session",
  "at least 50 newer empty sessions",
  "at least 150 newer empty sessions",
  "a wrapper that is not empty",
  "a session in a wrapper with only a start snapshot of its own",
  "a session in a wrapper with only an end snapshot of its own",
  "a session in a wrapper",
  "a session that started with its wrapper",
  "a wrapper that ended as its session started",
  "a wrapper still running",
  "a wrapper or a session with no directory",
  "a wrapper in the session's directory",
  "a wrapper in another directory",
  "a wrapper that started after the session",
  "a wrapper that ended before the session started",
];

/** Fails unless every kind in `kinds` was seen; reports the counts. */
function covered(t: { diagnostic: (m: string) => void }, seen: Map<string, number>, kinds: readonly string[]): void {
  t.diagnostic([...seen].map(([k, n]) => `${k}: ${n}`).join(", "));
  for (const k of kinds) assert.ok((seen.get(k) ?? 0) > 0, `no case had ${k}`);
}

// ---------------------------------------------------------------- the properties

test("a printed reference names its session and no other", async (t) => {
  const seen = new Map<string, number>();
  await forAll(CASE, (ids) => checkNames(REAL, ids, seen), { runs: RUNS, label: "names" });
  covered(t, seen, ["an id whose first 8 characters do not name it"]);
});

test("a printed reference opens its session through findSessionRef, and `<ref>#1` and `<ref>#-1` are its first and last model calls", async () => {
  await forAll(CASE, (ids) => checkStore(REAL, ids), { runs: STORE_RUNS, label: "store" });
});

test("a printed alias is x_ and the first digits of the id's SHA-256 in base32, and starts no stored id", async (t) => {
  const seen = new Map<string, number>();
  await forAll(CASE, (ids) => checkAliases(REAL, ids, seen), { runs: RUNS, label: "aliases" });
  covered(t, seen, ["an alias", "a longer alias"]);
});

test("a printed reference is the shortest the rules allow, and an alias only where the prefix is over 40 characters, needs quoting, or is latest or last", async (t) => {
  const seen = new Map<string, number>();
  await forAll(CASE, (ids) => checkShortest(REAL, ids, seen), { runs: RUNS, label: "shortest" });
  covered(t, seen, ["the whole id", "an 8-character prefix", "a prefix over 8 characters", "a prefix of a subagent's own id", "a short subagent form", "an alias", "no free alias", "latest or last", "a prefix that names the id where a longer one does not", "a subagent of an empty id"]);
});

test("a reference that is not an alias reads as the first of matchRef's steps that finds ids", async (t) => {
  const seen = new Map<string, number>();
  await forAll(CASE, (ids) => checkReads(REAL, ids, seen), { runs: RUNS, label: "reads" });
  covered(t, seen, ["the exact id", "a 4-character prefix", "a longer prefix", "an SDK id without default/", "a subagent's own id", "a short subagent id", "nothing", "several ids"]);
});

test("a reference that reads as several sessions throws AmbiguousRef: the reference, up to 10 of them newest first, and whether there are more", async (t) => {
  const seen = new Map<string, number>();
  await forAll(CASE, (ids) => checkAmbiguous(REAL, ids, seen), { runs: STORE_RUNS, label: "ambiguous" });
  covered(t, seen, ["2 to 10 sessions"]);
});

test("`latest` and `last` open the newest top-level session that is not empty, or the wrapper it ran in, and sessions with a run id only when there are no others", async (t) => {
  const seen = new Map<string, number>();
  await forAll(LATEST, (c) => checkLatest(REAL, c, seen), { runs: RUNS, label: "latest" });
  covered(t, seen, LATEST_KINDS);
});

test("each check fails on a mutant of the shortener, the reader, the call resolver or the session lookup", async (t) => {
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
  const from3: Subject = { ...REAL, read: (set, ref) => readOf(set.ids, ref, 3).match };
  const from5: Subject = { ...REAL, read: (set, ref) => readOf(set.ids, ref, 5).match };
  const sevenDigits: Subject = {
    ...REAL,
    read: (set, ref) => {
      const ids = /^x_.{7}$/.test(ref) ? set.byAlias(ref.slice(2)) : [];
      if (ids.length) return ids.length === 1 ? { id: ids[0]! } : { ambiguous: ids };
      return matchRef(set, ref);
    },
  };
  /** The real lookup, with the AmbiguousRef it throws changed by `edit`. */
  const editAmbiguous = (edit: (e: AmbiguousRef) => AmbiguousRef): Subject => ({
    ...REAL,
    find: (index, ref) =>
      findSessionRef(index, ref).catch((e: unknown) => {
        throw e instanceof AmbiguousRef ? edit(e) : e;
      }),
  });
  const oldestFirst = editAmbiguous((e) => new AmbiguousRef(e.ref, [...e.candidates].reverse(), e.more));
  const wholeIds = editAmbiguous((e) => new AmbiguousRef(e.ref, e.candidates.map((c) => ({ ...c, shortId: c.id })), e.more));
  const noRef = editAmbiguous((e) => new AmbiguousRef("", e.candidates, e.more));
  /** The real lookup on a store that changes each listSessions filter with `edit`. */
  const editFilter = (edit: (f: SessionFilter) => SessionFilter): Subject => ({
    ...REAL,
    find: (index, ref) =>
      findSessionRef(
        new Proxy(index, {
          get: (o, k) => {
            if (k === "listSessions") return (f: SessionFilter = {}) => o.listSessions(edit(f));
            const v: unknown = Reflect.get(o, k);
            return typeof v === "function" ? v.bind(o) : v;
          },
        }),
        ref,
      ),
  });
  const runsCount = editFilter((f) => ({ ...f, runId: undefined }));
  const subagentsCount = editFilter((f) => ({ ...f, parentSessionId: undefined }));
  const noWrapper = editFilter((f) => (f.agent === "wrapper" ? { ...f, agent: "none" } : f));
  const newestOfAll: Subject = { ...REAL, find: async (index, ref) => (WORDS.has(ref) ? (await index.listSessions({ parentSessionId: null, limit: 1 }))[0] : findSessionRef(index, ref)) };
  const mutants: [string, () => Promise<PropertyFailure>, RegExp][] = [
    ["names, a shortener that prints 8 characters", () => failure(CASE, (ids) => checkNames(eight, ids), "eight"), /printed for .*, names (nothing|\d+ ids|")/],
    ["names, a shortener one character short", () => failure(CASE, (ids) => checkNames(oneShort, ids), "one short"), /printed for .*, names (nothing|\d+ ids|")/],
    ["store, a call resolver that counts from 0", () => failure(CASE, (ids) => checkStore(fromZero, ids), "from zero"), /names call|model call/],
    ["aliases, the digits of another hash", () => failure(CASE, (ids) => checkAliases(sha1, ids), "sha1"), /is not the first \d+ digits/],
    ["aliases, the first alias even where a stored id starts with it", () => failure(CASE, (ids) => checkAliases(firstAlias, ids), "first alias"), /starts the stored id/],
    ["shortest, a shortener one character long", () => failure(CASE, (ids) => checkShortest(oneLong, ids), "one long"), /is not the reference the rules pick/],
    ["shortest, a shortener that never prints an alias", () => failure(CASE, (ids) => checkShortest(noAlias, ids), "no alias"), /needs an alias/],
    ["shortest, a shortener that always prints an alias", () => failure(CASE, (ids) => checkShortest(allAlias, ids), "all alias"), /is not needed/],
    ["reads, a reader that takes 3-character prefixes", () => failure(CASE, (ids) => checkReads(from3, ids), "from 3"), /reads as/],
    ["reads, a reader that takes prefixes from 5 characters", () => failure(CASE, (ids) => checkReads(from5, ids), "from 5"), /reads as/],
    ["reads, a reader that takes x_ and 7 digits for an alias", () => failure(CASE, (ids) => checkReads(sevenDigits, ids), "seven digits"), /reads as/],
    ["ambiguous, a lookup that lists the sessions oldest first", () => failure(CASE, (ids) => checkAmbiguous(oldestFirst, ids), "oldest first"), /not newest first/],
    ["ambiguous, a lookup that lists each session by its whole id", () => failure(CASE, (ids) => checkAmbiguous(wholeIds, ids), "whole ids"), /not as it prints/],
    ["ambiguous, a lookup whose error drops the reference", () => failure(CASE, (ids) => checkAmbiguous(noRef, ids), "no ref"), /holds the reference/],
    ["latest, a lookup that opens the newest session, empty or not", () => failure(LATEST, (c) => checkLatest(newestOfAll, c), "newest of all"), /opens .*, not /],
    ["latest, a lookup that counts sessions with a run id like the others", () => failure(LATEST, (c) => checkLatest(runsCount, c), "runs count"), /opens .*, not /],
    ["latest, a lookup that counts subagents", () => failure(LATEST, (c) => checkLatest(subagentsCount, c), "subagents count"), /opens .*, not /],
    ["latest, a lookup that never opens the wrapper", () => failure(LATEST, (c) => checkLatest(noWrapper, c), "no wrapper"), /opens .*, not .*: the newest wrapper/],
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
