// Property-based testing for coding.sh's own tests: seeded generators, forAll,
// and shrinking that works for every generator, `chain` included.
//
// A generator is a function of a Source. Each random choice it makes is one
// `draw(bound)`, a whole number in [0, bound), and the Source records it. A
// failing case is shrunk the way Hypothesis does it: by replaying shorter or
// smaller draw sequences. The shrinker deletes a span of draws (an array
// element, a field, a whole value), zeroes a span, deletes small blocks, then
// lowers single draws. Every generator maps draw 0 to its simplest value (0,
// false, the first choice, the end of an array), so a smaller sequence is a
// simpler input. A candidate is kept only when the draws it used are shorter,
// or as long and smaller in order, so shrinking always ends.
//
// forAll runs 100 cases by default. CODING_SH_PROP_RUNS raises the count for
// a longer run. A failure names its seed; CODING_SH_PROP_SEED=<seed> replays
// the run exactly, and CODING_SH_PROP_SEED=random picks a new seed.
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import { inspect } from "node:util";

/** Where a generator gets its randomness. Each draw is recorded, so a case can be replayed and shrunk. */
export interface Source {
  /**
   * A whole number in [0, bound); 0 is the simplest choice. `fresh` picks the value for a new case (to favour
   * edge values, say): it gets a uniform draw and returns a number in [0, bound). Replays ignore it.
   */
  draw(bound: number, fresh?: (uniform: (bound: number) => number) => number): number;
  /** Runs a generator as one span: the shrinker deletes or zeroes a span whole. */
  run<T>(gen: Gen<T>): T;
}

export type Gen<T> = (s: Source) => T;

/** Rejects the case: thrown by a generator (`filter`) or a property (`assume`), it counts as discarded, not failed. */
export class Discard extends Error {}

/** Discards the case unless `cond` holds. */
export function assume(cond: boolean): asserts cond {
  if (!cond) throw new Discard("assumption failed");
}

// ---------------------------------------------------------------- PRNG

const TWO_32 = 0x1_0000_0000;

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * xoshiro128**: returns uint32s. A number seeds the 128-bit state through splitmix32; four numbers set it
 * directly (the reference test vectors use [1, 2, 3, 4]).
 */
export function xoshiro128ss(seed: number | readonly [number, number, number, number]): () => number {
  let a: number, b: number, c: number, d: number;
  if (typeof seed === "number") {
    const sm = splitmix32(seed);
    [a, b, c, d] = [sm(), sm(), sm(), sm()];
  } else [a, b, c, d] = seed;
  if ((a | b | c | d) === 0) a = 1;
  return () => {
    const r = Math.imul(b, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return result;
  };
}

/** A uniform whole number in [0, bound), bound at most 2^53, by rejection sampling. */
function uniform(next: () => number, bound: number): number {
  if (bound <= TWO_32) {
    const limit = TWO_32 - (TWO_32 % bound);
    for (;;) {
      const x = next();
      if (x < limit) return x % bound;
    }
  }
  const span = 2 ** 53;
  const limit = span - (span % bound);
  for (;;) {
    const x = (next() & 0x1f_ffff) * TWO_32 + next();
    if (x < limit) return x % bound;
  }
}

/** FNV-1a over a string's UTF-16 units: the default seed of a labelled property. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// ---------------------------------------------------------------- recording

/** Draws one case may make; past it the case is discarded (a generator that never stops). */
const MAX_DRAWS = 100_000;

class Overrun extends Error {}

interface Span {
  start: number;
  end: number;
}

/** A Source that draws fresh values from a PRNG, or replays `prefix` (clamped to each bound, 0 past its end). */
class Recorder implements Source {
  readonly draws: number[] = [];
  readonly spans: Span[] = [];
  readonly #prefix: readonly number[] | undefined;
  readonly #next: (() => number) | undefined;

  constructor(prefix: readonly number[] | undefined, next: (() => number) | undefined) {
    this.#prefix = prefix;
    this.#next = next;
  }

  draw(bound: number, fresh?: (uniform: (bound: number) => number) => number): number {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new RangeError(`a draw needs a whole bound of at least 1, got ${bound}`);
    if (bound === 1) return 0;
    if (this.draws.length >= MAX_DRAWS) throw new Overrun(`more than ${MAX_DRAWS} draws`);
    let v: number;
    if (this.#prefix) v = Math.min(this.#prefix[this.draws.length] ?? 0, bound - 1);
    else {
      const next = this.#next;
      if (!next) throw new Error("a fresh Recorder needs a PRNG");
      const u = (b: number) => uniform(next, b);
      v = fresh ? fresh(u) : u(bound);
      if (!Number.isInteger(v) || v < 0 || v >= bound) throw new RangeError(`a fresh draw gave ${v}, outside [0, ${bound})`);
    }
    this.draws.push(v);
    return v;
  }

  run<T>(gen: Gen<T>): T {
    const start = this.draws.length;
    const v = gen(this);
    // A span of one draw is a block of one: the block and value passes cover it.
    if (this.draws.length - start > 1) this.spans.push({ start, end: this.draws.length });
    return v;
  }
}

/** The value `gen` makes from these draws (0 past their end): how the shrinker sees a candidate. */
export function replay<T>(gen: Gen<T>, draws: readonly number[]): T {
  return new Recorder(draws, undefined).run(gen);
}

/** `n` values from `gen` for a seed, as forAll's first cases would be (discarded ones skipped). */
export function sample<T>(gen: Gen<T>, n: number, seed: number): T[] {
  const next = xoshiro128ss(seed);
  const out: T[] = [];
  for (let tries = 0; out.length < n && tries < n * 10 + 10; tries++) {
    try {
      out.push(new Recorder(undefined, next).run(gen));
    } catch (e) {
      if (!(e instanceof Discard || e instanceof Overrun)) throw e;
    }
  }
  return out;
}

// ---------------------------------------------------------------- generators

/** A whole number in [lo, hi]. It shrinks toward the value nearest 0, then outward one step at a time. */
function int(lo: number, hi: number): Gen<number> {
  const bound = hi - lo + 1;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi || !Number.isSafeInteger(bound)) throw new RangeError(`int(${lo}, ${hi}) is not a safe range`);
  const origin = Math.min(Math.max(0, lo), hi);
  const up = hi - origin;
  const down = origin - lo;
  const m = Math.min(up, down);
  // Draw i is the i-th value by distance from the origin: origin, +1, -1, +2, -2, …, then the longer side.
  const toValue = (i: number): number => {
    if (i === 0) return origin;
    if (i <= 2 * m) {
      const k = Math.ceil(i / 2);
      return i % 2 === 1 ? origin + k : origin - k;
    }
    const r = i - 2 * m;
    return up > down ? origin + m + r : origin - m - r;
  };
  const toIndex = (v: number): number => {
    const d = v - origin;
    const k = Math.abs(d);
    if (k <= m) return d > 0 ? 2 * k - 1 : d < 0 ? 2 * k : 0;
    return 2 * m + (k - m);
  };
  const edges = [...new Set([lo, hi, origin, origin + 1, origin - 1])].filter((v) => v >= lo && v <= hi).map(toIndex);
  // New cases: one in ten an edge value, two in ten near the origin, the rest uniform.
  const fresh = (u: (b: number) => number): number => {
    const r = u(10);
    if (r === 0) return edges[u(edges.length)] ?? 0;
    if (r < 3) return u(Math.min(bound, 64));
    return u(bound);
  };
  return (s) => toValue(s.draw(bound, fresh));
}

const bool: Gen<boolean> = (s) => s.draw(2) === 1;

/** True with probability `p` in a new case; it shrinks to false. */
function weighted(p: number): Gen<boolean> {
  const cut = Math.round(Math.min(1, Math.max(0, p)) * TWO_32);
  return (s) => s.draw(2, (u) => (u(TWO_32) < cut ? 1 : 0)) === 1;
}

/** An index into `weights` with probability proportional to its weight in a new case; it shrinks to 0. */
function weightedIndex(weights: readonly number[]): (u: (b: number) => number) => number {
  const total = weights.reduce((a, w) => a + w, 0);
  return (u) => {
    let r = u(total);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] ?? 0;
      if (r < w) return i;
      r -= w;
    }
    return 0;
  };
}

/** One of `items`; it shrinks toward the first. */
function pick<T>(items: readonly T[]): Gen<T> {
  if (!items.length) throw new RangeError("pick() needs at least one item");
  return (s) => items[s.draw(items.length)] as T;
}

/** One of the generators, chosen evenly; it shrinks toward the first. */
function oneOf<T>(...gens: readonly Gen<T>[]): Gen<T> {
  return frequency(...gens.map((g): [number, Gen<T>] => [1, g]));
}

/** One of the generators, chosen by weight in a new case; it shrinks toward the first. */
function frequency<T>(...choices: readonly (readonly [number, Gen<T>])[]): Gen<T> {
  if (!choices.length) throw new RangeError("frequency() needs at least one choice");
  const fresh = weightedIndex(choices.map(([w]) => w));
  const gens = choices.map(([, g]) => g);
  return (s) => s.run((s2) => (gens[s2.draw(gens.length, fresh)] as Gen<T>)(s2));
}

function constant<T>(value: T): Gen<T> {
  return () => value;
}

function map<T, U>(gen: Gen<T>, f: (v: T) => U): Gen<U> {
  return (s) => f(gen(s));
}

/** A generator picked by a drawn value: both draws are recorded, so the pair shrinks together. */
function chain<T, U>(gen: Gen<T>, f: (v: T) => Gen<U>): Gen<U> {
  return (s) => s.run(f(s.run(gen)));
}

/** A value that passes `pred`, from up to three tries; otherwise the case is discarded. */
function filter<T>(gen: Gen<T>, pred: (v: T) => boolean): Gen<T> {
  return (s) => {
    for (let i = 0; i < 3; i++) {
      const v = s.run(gen);
      if (pred(v)) return v;
    }
    throw new Discard("filter() rejected three values");
  };
}

export interface ArrayOptions {
  minLength?: number;
  /** Default: 64, or minLength when that is larger. */
  maxLength?: number;
  /** Mean length of a new case (default minLength + 4, at most maxLength). */
  avgLength?: number;
}

/**
 * An array. After the first minLength items, a weighted flag says whether another follows: each flag and its
 * item are one span, so the shrinker removes items whole, and a 0 flag ends the array.
 */
function array<T>(item: Gen<T>, opts: ArrayOptions = {}): Gen<T[]> {
  const min = opts.minLength ?? 0;
  const max = opts.maxLength ?? Math.max(min, 64);
  if (!Number.isInteger(min) || min < 0 || max < min) throw new RangeError(`array length ${min}..${max} is not a range`);
  const extra = Math.max(0, Math.min(max, opts.avgLength ?? min + 4) - min);
  const more = weighted(extra / (extra + 1));
  return (s) => {
    const out: T[] = [];
    while (out.length < min) out.push(s.run(item));
    let open = true;
    while (open && out.length < max) {
      s.run((s2) => {
        if (more(s2)) out.push(s2.run(item));
        else open = false;
      });
    }
    return out;
  };
}

function tuple<T extends unknown[]>(...gens: { [K in keyof T]: Gen<T[K]> }): Gen<T> {
  return (s) => {
    const out: unknown[] = [];
    for (const g of gens) out.push(s.run(g));
    return out as T;
  };
}

/** An object with a field per generator, drawn in key order. */
function record<T extends object>(shape: { [K in keyof T]: Gen<T[K]> }): Gen<T> {
  const keys = Object.keys(shape) as (keyof T)[];
  return (s) => {
    const out: Partial<T> = {};
    for (const k of keys) out[k] = s.run(shape[k]);
    return out as T;
  };
}

/** An object with drawn keys (a later duplicate wins). Keys are own properties even when one is `__proto__`. */
function dict<V>(key: Gen<string>, value: Gen<V>, opts: ArrayOptions = {}): Gen<Record<string, V>> {
  const pairs = array(tuple<[string, V]>(key, value), { maxLength: 8, ...opts });
  return map(pairs, (ps) => {
    const out: Record<string, V> = {};
    for (const [k, v] of ps) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    return out;
  });
}

// ---------------------------------------------------------------- strings

/** Printable ASCII plus tab, newline and carriage return, lowercase first so text shrinks to "a…". */
export const ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~\t\n\r";

/** One character of `alphabet` (split by code point); it shrinks toward the first. */
function char(alphabet: string | readonly string[]): Gen<string> {
  const chars = typeof alphabet === "string" ? Array.from(alphabet) : alphabet;
  return pick(chars);
}

/** A code point in [from, to] as a string; a value in the surrogate range comes out as a lone surrogate. */
function codePoint(from: number, to: number): Gen<string> {
  return (s) => {
    const cp = from + s.draw(to - from + 1);
    return cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
  };
}

/** Characters that break naive text handling: line and paragraph separators, BOM, zero-width ones, U+FFFD. */
const TRICKY = [" ", " ", "﻿", "​", "‍", "�", "­", "\\", '"', "\u0000"];

export interface UnicodeOptions {
  /** Include lone surrogates (default true): text that is not well-formed UTF-16. */
  loneSurrogates?: boolean;
}

/**
 * One character from across Unicode: mostly ASCII, then Latin-1, the rest of the BMP, astral code points
 * (surrogate pairs), combining marks, control characters, a few tricky ones, and lone surrogates.
 */
function unicodeChar(opts: UnicodeOptions = {}): Gen<string> {
  const bmpLow = 0xd7ff - 0x0100 + 1;
  const bmp: Gen<string> = (s) => {
    const i = s.draw(bmpLow + (0xfffd - 0xe000 + 1));
    return String.fromCharCode(i < bmpLow ? 0x0100 + i : 0xe000 + i - bmpLow);
  };
  const control: Gen<string> = (s) => {
    const i = s.draw(32 + 33);
    return String.fromCharCode(i < 32 ? i : 0x7f + i - 32);
  };
  const parts: [number, Gen<string>][] = [
    [40, char(ASCII)],
    [8, codePoint(0xa0, 0xff)],
    [8, bmp],
    [6, codePoint(0x1_0000, 0x10_ffff)],
    [6, codePoint(0x0300, 0x036f)],
    [5, control],
    [4, pick(TRICKY)],
  ];
  if (opts.loneSurrogates !== false) parts.push([2, codePoint(0xd800, 0xdfff)]);
  return frequency(...parts);
}

export interface StringOptions extends ArrayOptions {
  /** Characters to draw from: a string or list (it shrinks toward the first), or a generator. Default ASCII. */
  alphabet?: string | readonly string[] | Gen<string>;
}

/** A string of drawn characters; lengths count characters, not UTF-16 units. Defaults: up to 64, about 8. */
function string(opts: StringOptions = {}): Gen<string> {
  const c = typeof opts.alphabet === "function" ? opts.alphabet : char(opts.alphabet ?? ASCII);
  const chars = array(c, { maxLength: 64, avgLength: (opts.minLength ?? 0) + 8, ...opts });
  return map(chars, (cs) => cs.join(""));
}

/** A string from across Unicode (see unicodeChar). */
function unicodeString(opts: ArrayOptions & UnicodeOptions = {}): Gen<string> {
  return string({ ...opts, alphabet: unicodeChar(opts) });
}

// ---------------------------------------------------------------- JSON

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A finite number with up to six decimals, never -0. */
const float: Gen<number> = map(tuple<[number, number]>(int(-1_000_000_000, 1_000_000_000), pick([1, 10, 100, 1000, 1_000_000])), ([n, d]) => n / d || 0);

export interface JsonOptions {
  /** Nesting depth (default 3). */
  maxDepth?: number;
  /** String values (default unicodeString up to 16 characters). */
  string?: Gen<string>;
  /** Object keys (default ASCII up to 8 characters). */
  key?: Gen<string>;
}

/** A JSON value: null first, then scalars, arrays and objects. JSON.parse(JSON.stringify(v)) equals v. */
function json(opts: JsonOptions = {}): Gen<Json> {
  const str = opts.string ?? unicodeString({ maxLength: 16 });
  const key = opts.key ?? string({ maxLength: 8, avgLength: 4 });
  const scalar = frequency<Json>([1, constant(null)], [1, bool], [2, int(-1e15, 1e15)], [1, float], [3, str]);
  const at = (depth: number): Gen<Json> => {
    if (depth <= 0) return scalar;
    const inner = at(depth - 1);
    return frequency<Json>([4, scalar], [1, array(inner, { maxLength: 6, avgLength: 2 })], [1, dict(key, inner, { maxLength: 6, avgLength: 2 })]);
  };
  return at(opts.maxDepth ?? 3);
}

/** The generators. Every one shrinks toward its simplest value. */
export const gen = {
  int,
  nat: (max = 1000): Gen<number> => int(0, max),
  bool,
  weighted,
  pick,
  oneOf,
  frequency,
  constant,
  map,
  chain,
  filter,
  array,
  tuple,
  record,
  dict,
  char,
  codePoint,
  unicodeChar,
  string,
  unicodeString,
  float,
  json,
};

// ---------------------------------------------------------------- forAll

export interface ForAllOptions {
  /** Cases that must pass (default 100). CODING_SH_PROP_RUNS raises it, never lowers it. */
  runs?: number;
  /** The run's seed (a uint32). CODING_SH_PROP_SEED overrides it. Default: a hash of the label. */
  seed?: number;
  /** Names the property in a failure, and picks the default seed. */
  label?: string;
  /** Where CODING_SH_PROP_RUNS and CODING_SH_PROP_SEED are read (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Replays the shrinker may try (default 2000). */
  maxShrinks?: number;
  /** Discarded cases allowed before forAll gives up (default 10 per case asked for). */
  maxDiscards?: number;
}

export interface ForAllResult {
  /** Cases that passed. */
  runs: number;
  seed: number;
  discarded: number;
}

export type Property<T> = (value: T) => void | boolean | Promise<void | boolean>;

/** What forAll throws: the seed, the shrunk input and how to replay it. `cause` is the shrunk case's error. */
export class PropertyFailure extends Error {
  readonly seed: number;
  /** 0-based index of the first failing case in the run. */
  readonly caseIndex: number;
  /** The shrunk input. */
  readonly counterexample: unknown;
  /** Smaller failing inputs the shrinker found on the way. */
  readonly shrinks: number;

  constructor(message: string, details: { cause: unknown; seed: number; caseIndex: number; counterexample: unknown; shrinks: number }) {
    super(message, { cause: details.cause });
    this.name = "PropertyFailure";
    this.seed = details.seed;
    this.caseIndex = details.caseIndex;
    this.counterexample = details.counterexample;
    this.shrinks = details.shrinks;
  }
}

type Outcome<T> = { kind: "pass" } | { kind: "discard" } | { kind: "fail"; value: T; error: unknown };

interface Failed<T> {
  draws: number[];
  spans: Span[];
  value: T;
  error: unknown;
}

async function attempt<T>(rec: Recorder, gen: Gen<T>, prop: Property<T>): Promise<Outcome<T>> {
  let value: T;
  try {
    value = rec.run(gen);
  } catch (e) {
    if (e instanceof Discard || e instanceof Overrun) return { kind: "discard" };
    throw e;
  }
  try {
    if ((await prop(value)) === false) return { kind: "fail", value, error: new Error("the property returned false") };
    return { kind: "pass" };
  } catch (e) {
    if (e instanceof Discard) return { kind: "discard" };
    return { kind: "fail", value, error: e };
  }
}

/** Shorter first, then smaller in order: the order shrinking descends, so it always ends. */
function shortlexLess(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function shrink<T>(first: Failed<T>, gen: Gen<T>, prop: Property<T>, budget: number): Promise<{ best: Failed<T>; shrinks: number }> {
  let best = first;
  let shrinks = 0;
  let tries = 0;
  // Every replay is deterministic, so a sequence tried once never needs trying again.
  const tried = new Set<string>();
  const attemptDraws = async (draws: number[]): Promise<boolean> => {
    if (tries >= budget || !shortlexLess(draws, best.draws)) return false;
    const key = draws.join(",");
    if (tried.has(key)) return false;
    tried.add(key);
    tries++;
    const rec = new Recorder(draws, undefined);
    const out = await attempt(rec, gen, prop);
    if (out.kind !== "fail" || !shortlexLess(rec.draws, best.draws)) return false;
    best = { draws: rec.draws, spans: rec.spans, value: out.value, error: out.error };
    shrinks++;
    return true;
  };
  const without = (start: number, end: number) => [...best.draws.slice(0, start), ...best.draws.slice(end)];
  const withValue = (i: number, v: number) => {
    const d = best.draws.slice();
    d[i] = v;
    return d;
  };
  const passes: (() => Promise<boolean>)[] = [
    // Delete a span, largest first: an element, a field, a whole value.
    async () => {
      for (const sp of [...best.spans].sort((x, y) => y.end - y.start - (x.end - x.start))) if (await attemptDraws(without(sp.start, sp.end))) return true;
      return false;
    },
    // Zero a span: its simplest value in place.
    async () => {
      for (const sp of [...best.spans].sort((x, y) => y.end - y.start - (x.end - x.start))) {
        if (best.draws.slice(sp.start, sp.end).every((v) => v === 0)) continue;
        const d = best.draws.slice();
        d.fill(0, sp.start, sp.end);
        if (await attemptDraws(d)) return true;
      }
      return false;
    },
    // Delete a block of 8, 4, 2 or 1 draws anywhere.
    async () => {
      for (const k of [8, 4, 2, 1]) for (let i = 0; i + k <= best.draws.length; i++) if (await attemptDraws(without(i, i + k))) return true;
      return false;
    },
    // Lower each draw: to 0, else the smallest value that still fails (a binary search).
    async () => {
      let improved = false;
      for (let i = 0; i < best.draws.length; i++) {
        const v = best.draws[i] ?? 0;
        if (v === 0) continue;
        if (await attemptDraws(withValue(i, 0))) {
          improved = true;
          continue;
        }
        let lo = 0;
        let hi = v;
        while (hi - lo > 1 && tries < budget) {
          const mid = lo + Math.floor((hi - lo) / 2);
          if (await attemptDraws(withValue(i, mid))) {
            hi = mid;
            improved = true;
          } else lo = mid;
        }
      }
      return improved;
    },
  ];
  let progress = true;
  while (progress && tries < budget) {
    progress = false;
    for (const pass of passes) {
      if (await pass()) {
        progress = true;
        break;
      }
    }
  }
  return { best, shrinks };
}

/** The test file that called forAll, relative to the working directory, for the replay hint. */
function callerFile(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n")) {
    const m = /((?:file:\/\/)?[^\s()]+\.test\.[cm]?[jt]s)(?::\d+)*/.exec(line);
    if (!m?.[1]) continue;
    const path = m[1].startsWith("file:") ? fileURLToPath(m[1]) : m[1];
    const rel = relative(process.cwd(), path);
    return (rel && !rel.startsWith("..") ? rel : path).split(sep).join("/");
  }
  return "<test file>";
}

/** The input as JSON where it can be (lone surrogates come out escaped), otherwise as util.inspect shows it. */
export function formatValue(v: unknown): string {
  try {
    const text = JSON.stringify(v, (_k, x: unknown) => {
      if (x === undefined) return "<undefined>";
      if (typeof x === "bigint") return `${x}n`;
      if (typeof x === "number" && (!Number.isFinite(x) || Object.is(x, -0))) return Object.is(x, -0) ? "-0" : String(x);
      return x;
    });
    if (text !== undefined) return text;
  } catch {
    // circular: fall through
  }
  return inspect(v, { depth: 8, breakLength: Infinity });
}

function seedFrom(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.CODING_SH_PROP_SEED?.trim();
  if (!raw) return fallback;
  if (raw === "random") return Math.floor(Math.random() * TWO_32);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= TWO_32) throw new RangeError(`CODING_SH_PROP_SEED must be a whole number below 2^32 or "random", got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Checks `prop` on `runs` generated cases. A case fails when the property throws (other than Discard) or returns
 * false. The first failure is shrunk, then thrown as a PropertyFailure with the seed and the shrunk input.
 */
export async function forAll<T>(gen: Gen<T>, prop: Property<T>, opts: ForAllOptions = {}): Promise<ForAllResult> {
  const where = new Error().stack;
  const env = opts.env ?? process.env;
  const envRuns = Number(env.CODING_SH_PROP_RUNS);
  const runs = Math.max(opts.runs ?? 100, Number.isInteger(envRuns) && envRuns > 0 ? envRuns : 0);
  const seed = seedFrom(env, (opts.seed ?? hash32(opts.label ?? String(prop))) >>> 0);
  const maxDiscards = opts.maxDiscards ?? runs * 10;
  const next = xoshiro128ss(seed);
  let passed = 0;
  let discarded = 0;
  for (let caseIndex = 0; passed < runs; caseIndex++) {
    const rec = new Recorder(undefined, next);
    const out = await attempt(rec, gen, prop);
    if (out.kind === "pass") {
      passed++;
      continue;
    }
    if (out.kind === "discard") {
      if (++discarded > maxDiscards) throw new Error(`forAll${opts.label ? ` "${opts.label}"` : ""} gave up: ${discarded} cases discarded for ${passed} that passed (seed ${seed})`);
      continue;
    }
    const { best, shrinks } = await shrink({ draws: rec.draws, spans: rec.spans, value: out.value, error: out.error }, gen, prop, opts.maxShrinks ?? 2000);
    // Shown from a fresh replay: the property may have changed the value it was given.
    const counterexample = replay(gen, best.draws);
    const reason = best.error instanceof Error ? best.error.message : String(best.error);
    const message = [
      `Property${opts.label ? ` "${opts.label}"` : ""} failed on case ${caseIndex + 1} (seed ${seed}); shrunk ${shrinks} times to:`,
      `  input: ${formatValue(counterexample)}`,
      `  error: ${reason.split("\n").join("\n         ")}`,
      `Replay: CODING_SH_PROP_SEED=${seed} node --no-warnings --test ${callerFile(where)}`,
    ].join("\n");
    throw new PropertyFailure(message, { cause: best.error, seed, caseIndex, counterexample, shrinks });
  }
  return { runs: passed, seed, discarded };
}
