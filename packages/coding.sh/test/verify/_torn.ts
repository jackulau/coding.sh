/**
 * The torn-spool checks of spool-torn-*.test.ts and ingest-torn-*.test.ts: a spool file whose last line
 * is torn at a byte offset, what the reader (src/core/spool-read.ts) and ingest (src/core/ingest.ts) make
 * of it, and what they make of the same file once a writer has come back to it.
 *
 * Inputs. Each spool fixture (test/fixtures/adapters/**\/*.spool.jsonl) is a prefix of P bytes (its lines
 * but the last, each with its "\n"), then a last line of L bytes and its "\n". The torn file is the
 * prefix and the first k bytes of the last line, for a cut k from 1 to L (k = L is the whole line without
 * its "\n"). A writer then comes back in one of three ways (src/spool/write.ts, and the M2 table in
 * docs/design/state-machines.md):
 * - the rest of the line is appended: the write that was cut short finishes;
 * - a node writer appends its next line: appendSpool starts it on a fresh line, with a "\n" first;
 * - hook.sh appends its next line, glued to the fragment.
 * The next line is the last line again, as JSON.stringify writes it, so it is one the adapter reads.
 * tornFixtures asserts what the expected values rely on: the last line ends in "}" and has a payload, no
 * line names a side file, and neither the last line nor the next one holds the start every writer gives a
 * line ('{"v":0,"agent":"') past its first byte. The fixtures are ASCII: spool-glued-*.test.ts cut lines
 * inside a character.
 *
 * checkReader states what readSpoolFile yields at each k it takes, with chunk sizes from 256 bytes up: each
 * k is a segment of one file, its fragment followed by a "\n", by the next line glued on and by the rest of
 * the line, read in one pass; and at some k the torn file itself, read from its start, from the start of
 * the torn line and from the end of the fragment, fresh, aged and after each writer has come back to it.
 * checkIngest states what ingest stores, against an index that holds the prefix and against an empty one:
 * a fragment fresh at each k it takes, and the other cases at a few k.
 *
 * Bounds. Each test file reads its bound, CODING_SH_MODEL_BOUND (0 when unset), and passes it to its check,
 * whose comment says what it takes at each bound. Where bound 1 takes every k, bound 0 takes k = 1, 2,
 * L/2, L - 1 and L and every 13th k (SAMPLE, cutsAt). Bound 2 or more takes every k for every case.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest, spoolInFlightKeys, spoolScrubKey, type IngestError, type IngestResult } from "../../src/core/ingest.ts";
import { paths } from "../../src/core/paths.ts";
import { readSpoolFile, TORN_TAIL_MS, type SpoolReadError, type SpoolRecord } from "../../src/core/spool-read.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { appendSpool, safeAgentId, spoolFile, utcDay, type RedactLine } from "../../src/spool/write.ts";
import { FIXTURES, local, tmpEnv } from "../adapters/_helpers.ts";
import { forAll, gen } from "../_prop.ts";

/** How every writer starts a spool line (spool-read.ts). */
export const LINE_START = Buffer.from('{"v":0,"agent":"');

/** What the reader says of a line that is not JSON and has a whole line glued after a fragment. */
export const KEPT = /^invalid JSON: .*; the whole line after the torn fragment is kept$/s;

/** What the reader says of a fragment at the end of a file untouched for over an hour. */
export const aged = (bytes: number): string => `incomplete last line (${bytes} bytes, unchanged for over an hour): a torn write, skipped`;

export interface TornFixture {
  /** The fixture's path under test/fixtures/adapters, "/"-separated. */
  file: string;
  /** The lines before the last, each with its "\n". */
  prefix: Buffer;
  /** The last line, with its "\n". */
  last: Buffer;
  /** The last line, parsed. */
  line: SpoolLine;
  /** The last line as JSON.stringify writes it, with its "\n": the line a writer appends next. */
  next: Buffer;
}

export function tornFixtures(): TornFixture[] {
  const files = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(sep).join("/"))
    .filter((f) => f.endsWith(".spool.jsonl"))
    .sort();
  assert.ok(files.length > 0, "no spool fixtures");
  return files.map((file) => {
    const lines = readFileSync(join(FIXTURES, file), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => Buffer.from(`${local(l)}\n`));
    assert.ok(lines.length >= 2, `${file}: fewer than two lines`);
    for (const l of lines) assert.equal((JSON.parse(l.toString("utf8")) as SpoolLine).rawFile, undefined, `${file}: a line names a side file`);
    const last = lines.at(-1)!;
    const line = JSON.parse(last.toString("utf8")) as SpoolLine;
    const next = Buffer.from(`${JSON.stringify(line)}\n`);
    assert.equal(last[last.length - 2], 0x7d, `${file}: the last line does not end in "}"`);
    assert.notEqual(line.raw, undefined, `${file}: the last line has no payload`);
    assert.ok(next.subarray(0, LINE_START.length).equals(LINE_START), `${file}: the next line does not start as a writer starts one`);
    assert.equal(last.indexOf(LINE_START, 1), -1, `${file}: the last line holds a line start past its first byte`);
    assert.equal(next.indexOf(LINE_START, 1), -1, `${file}: the next line holds a line start past its first byte`);
    return { file, prefix: Buffer.concat(lines.slice(0, -1)), last, line, next };
  });
}

/** Shard `part` of `parts`: items go largest first, each to the shard with the least weight so far. */
export function shard<T>(items: readonly T[], weight: (x: T) => number, part: number, parts: number): T[] {
  assert.ok(Number.isInteger(part) && part >= 0 && part < parts, `part ${part} of ${parts}`);
  const order = items.map((x, i) => ({ i, w: weight(x) })).sort((a, b) => b.w - a.w || a.i - b.i);
  const loads = Array.from({ length: parts }, () => 0);
  const mine = new Set<number>();
  for (const o of order) {
    let best = 0;
    for (let j = 1; j < parts; j++) if (loads[j]! < loads[best]!) best = j;
    loads[best] = loads[best]! + o.w;
    if (best === part) mine.add(o.i);
  }
  return items.filter((_, i) => mine.has(i));
}

/** At bound 0 a check takes every SAMPLE-th k where bound 1 takes every k, and _glued.ts every SAMPLE-th case. */
export const SAMPLE = 13;

/**
 * The cuts of a last line of L bytes that a check takes where bound 1 takes every k, ascending: at bound 1
 * or more every k from 1 to L; at 0, k = 1, 2, L/2, L - 1 and L and every SAMPLE-th k.
 */
export function cutsAt(L: number, bound: number): number[] {
  if (bound >= 1) return Array.from({ length: L }, (_, i) => i + 1);
  const ks = new Set([1, 2, Math.floor(L / 2), L - 1, L]);
  for (let k = SAMPLE; k <= L; k += SAMPLE) ks.add(k);
  return [...ks].filter((k) => k >= 1 && k <= L).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- stores

export interface Stores {
  index: MemoryIndexStore;
  blobs: MemoryBlobStore;
}

export const emptyStores = (): Stores => ({ index: new MemoryIndexStore(), blobs: new MemoryBlobStore() });

/** A deep copy of both stores: every field cloned. */
export function cloneStores(s: Stores): Stores {
  const c = emptyStores();
  Object.assign(c.index, structuredClone({ ...s.index }));
  Object.assign(c.blobs, structuredClone({ ...s.blobs }));
  return c;
}

function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]));
  if (v instanceof Set) return [...v].map((x) => JSON.stringify(plain(x))).sort();
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));

/**
 * Everything both stores hold, as one string with sorted keys. A blob's mtime is left out: a put of bytes
 * the store holds already sets it to the clock.
 */
export function snapshot(s: Stores): string {
  const { blobs, ...rest } = plain(s.blobs) as { blobs: Record<string, { mtimeMs?: number }> };
  for (const b of Object.values(blobs)) delete b.mtimeMs;
  return canonical({ index: plain(s.index), blobs: { ...rest, blobs } });
}

/** `snap` with these cursors set (a value of 0 or undefined removes the key, as setCursor(key, 0) does). */
export function withCursors(snap: string, set: Record<string, number | undefined>): string {
  const s = JSON.parse(snap) as { index: { cursors: Record<string, number> } };
  for (const [k, v] of Object.entries(set)) {
    if (!v) delete s.index.cursors[k];
    else s.index.cursors[k] = v;
  }
  return canonical(s);
}

function diff(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)?.slice(0, 160)} != ${JSON.stringify(b)?.slice(0, 160)}`);
  return out;
}

/** Fails with the first paths where two snapshots differ. */
export function sameStore(actual: string, expected: string, what: string): void {
  if (actual === expected) return;
  const d = diff(JSON.parse(actual), JSON.parse(expected));
  assert.fail(`${what}: the stores differ (actual != expected)\n  ${d.slice(0, 8).join("\n  ")}${d.length > 8 ? `\n  …and ${d.length - 8} more` : ""}`);
}

// ---------------------------------------------------------------- a home

/** A coding.sh home of its own (a data dir and a user home), for one fixture's files. */
export class TornHome {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spoolDir: string;
  readonly config: ReturnType<typeof defaultConfig>;
  readonly adapters = new Map(ADAPTERS.map((a) => [a.id, a]));

  constructor(parent: string) {
    this.root = mkdtempSync(join(parent, "torn-"));
    const home = join(this.root, "home");
    const data = join(this.root, "csh");
    mkdirSync(home, { recursive: true });
    mkdirSync(data, { recursive: true });
    this.env = { HOME: home, CODING_SH_HOME: data };
    this.spoolDir = paths(this.env).spool;
    this.config = defaultConfig(this.env);
  }

  /** The spool file a writer appends `line` to, made ready to write, and its cursor key. */
  fileOf(line: SpoolLine): { path: string; source: string } {
    const path = spoolFile(safeAgentId(line.agent), line.ts, this.env, line.pid);
    mkdirSync(dirname(path), { recursive: true });
    return { path, source: relative(this.spoolDir, path).split(sep).join("/") };
  }

  ingest(s: Stores, now: number): Promise<IngestResult> {
    return ingest({ config: this.config, index: s.index, blobs: s.blobs, adapters: this.adapters, env: this.env, spoolDir: this.spoolDir, lock: false, now: () => now });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Writes the line as given: the fixtures hold nothing to redact, and the checks compare against them. */
const identity: RedactLine = (line, rawText) => ({ line, rawText });

/** Sets the file's times two hours back, by the clock ingest's reader uses. */
export function age(path: string): void {
  const old = new Date(Date.now() - 2 * TORN_TAIL_MS);
  utimesSync(path, old, old);
}

/** A clock on the file's day, late enough that no fixture session ended within ten minutes of it. */
export const todayNow = (day: string): number => Date.parse(`${day}T23:59:00.000Z`);
/** A clock on the next day: the file's day has passed, and ingest scrubs the file once it has read it all. */
export const pastNow = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) + 36 * 3_600_000;

export const spaces = (n: number): Buffer => Buffer.alloc(n, " ");

export interface Read {
  recs: SpoolRecord[];
  errs: SpoolReadError[];
  /** What onBlank reported: the offset past each blank line skipped. */
  blanks: number[];
}

export async function read(spoolDir: string, path: string, from: number, chunkSize?: number, now?: number): Promise<Read> {
  const recs: SpoolRecord[] = [];
  const errs: SpoolReadError[] = [];
  const blanks: number[] = [];
  const clock = now === undefined ? undefined : () => now;
  for await (const r of readSpoolFile(spoolDir, path, from, { onError: (e) => errs.push(e), onBlank: (n) => blanks.push(n), chunkSize, now: clock })) recs.push(r);
  return { recs, errs, blanks };
}

const NOTHING: Read = { recs: [], errs: [], blanks: [] };

/** One "invalid JSON" error over [offset, nextOffset), kept or not. */
export function assertInvalid(errs: readonly (SpoolReadError | IngestError)[], want: { source: string; offset: number; nextOffset?: number; kept: boolean }, what: string): void {
  assert.equal(errs.length, 1, `${what}: errors ${JSON.stringify(errs)}`);
  const { message, ...at } = errs[0]!;
  const { kept, ...where } = want;
  assert.deepEqual(at, where, what);
  if (kept) assert.match(message, KEPT, what);
  else {
    assert.match(message, /^invalid JSON: /s, what);
    assert.doesNotMatch(message, /; the whole line after the torn fragment is kept$/, what);
  }
}

const CHUNKS = [256, 1024, 4096, 1 << 16] as const;

// ---------------------------------------------------------------- the reader

const NL = Buffer.from("\n");

/** What a read reports, in order, one string each: a line it yields, an error, the end of a blank line it skips. */
async function items(spoolDir: string, path: string, from: number, chunkSize: number, source: string, line: string): Promise<string[]> {
  const out: string[] = [];
  const kind = (m: string) => (KEPT.test(m) ? "kept" : /^invalid JSON: /.test(m) ? "invalid" : JSON.stringify(m));
  const where = (s: string) => (s === source ? "" : ` in ${s}`);
  const opts = {
    chunkSize,
    onError: (e: SpoolReadError) => out.push(`error ${e.offset}-${e.nextOffset} ${kind(e.message)}${where(e.source)}`),
    onBlank: (n: number) => out.push(`blank ${n}`),
  };
  for await (const r of readSpoolFile(spoolDir, path, from, opts)) {
    const json = JSON.stringify(r.line);
    out.push(`line ${r.offset}-${r.nextOffset}${where(r.source)}${json === line ? "" : ` ${json.slice(0, 160)}`}`);
  }
  return out;
}

/**
 * The cuts `ks` of one fixture as segments of one file after its prefix, read from the end of the prefix in
 * chunks of each size in `chunks`. Segment k holds what a reader meets after a write cut short at k, in each
 * way a writer comes back to it:
 *   last[0, k) "\n"   a node writer starts its next line on a fresh line: the fragment is one invalid line
 *                     (at k = L the fragment is the whole line, and reads as it);
 *   next              that next line;
 *   last[0, k) next   hook.sh's next line glued on: one invalid line that says the glued line is kept, then
 *                     that line from where it starts;
 *   last[k, L] "\n"   the rest of the write, read from where the fragment ends: one invalid line, or at k = L
 *                     the "\n" alone, a blank line.
 * Returns the bytes of the segments.
 */
async function checkSegments(home: TornHome, fx: TornFixture, file: { path: string; source: string }, ks: readonly number[], chunks: readonly number[]): Promise<number> {
  const P = fx.prefix.length;
  const L = fx.last.length - 1;
  const N = fx.next.length;
  const parts: Buffer[] = [fx.prefix];
  const want: string[] = [];
  /** The k each wanted item belongs to. */
  const owner: number[] = [];
  let s0 = P;
  for (const k of ks) {
    const frag = fx.last.subarray(0, k);
    parts.push(frag, NL, fx.next, frag, fx.next, fx.last.subarray(k));
    const s1 = s0 + k + 1 + N;
    const s2 = s1 + k + N;
    const end = s2 + L + 1 - k;
    want.push(k < L ? `error ${s0}-${s0 + k + 1} invalid` : `line ${s0}-${s0 + k + 1}`, `line ${s0 + k + 1}-${s1}`, `error ${s1}-${s2} kept`, `line ${s1 + k}-${s2}`, k < L ? `error ${s2}-${end} invalid` : `blank ${end}`);
    owner.push(k, k, k, k, k);
    s0 = end;
  }
  writeFileSync(file.path, Buffer.concat(parts));
  const line = JSON.stringify(fx.line);
  for (const c of chunks) {
    const got = await items(home.spoolDir, file.path, P, c, file.source, line);
    let i = 0;
    while (i < want.length && got[i] === want[i]) i++;
    if (i < want.length || got.length > want.length) {
      const k = owner[Math.min(i, owner.length - 1)];
      const show = (xs: string[]) => xs.slice(i, i + 3).join(" | ") || "(nothing)";
      assert.fail(`${fx.file}, its last line cut to ${k} of ${L} bytes, read in chunks of ${c}: the segments read differently at item ${i}\n  want ${show(want)}\n  got  ${show(got)}`);
    }
  }
  return s0 - P;
}

/**
 * The cuts the walk takes at every bound, each with the chunk size its reads use: k = 1, 2, L/2, L - 1 and
 * L; and for each chunk size c, the k where the fragment ends on the first chunk boundary a read meets past
 * the prefix: k = c for a read from the fragment's start, and P + k a multiple of c for a read from the
 * file's start. With `either`, a byte either side of each boundary too.
 */
function walkCuts(P: number, L: number, either: boolean): [k: number, chunk: number][] {
  const out = new Map<string, [number, number]>();
  const add = (k: number, c: number) => {
    if (k >= 1 && k <= L) out.set(`${k} ${c}`, [k, c]);
  };
  for (const k of [1, 2, Math.floor(L / 2), L - 1, L]) add(k, CHUNKS[k % CHUNKS.length]!);
  for (const c of CHUNKS) {
    const b = (Math.floor(P / c) + 1) * c - P;
    for (const d of either ? [-1, 0, 1] : [0]) {
      add(c + d, c);
      add(b + d, c);
    }
  }
  return [...out.values()];
}

/**
 * About what checkReader spends on a fixture, in milliseconds on the machine it was measured on: its
 * segments come to about 1.5 L² + 2 N L bytes, read at about 8 MB a second, and its walk and its home take
 * about 250 ms.
 */
const readerWeight = (f: TornFixture): number => {
  const L = f.last.length - 1;
  return (L * (1.5 * L + 2 * f.next.length)) / 8_000 + 250;
};

/**
 * The reader on each fixture in the shard, in two parts.
 *
 * Segments, at each k cutsAt gives (every k at bound 1 or more): checkSegments over four files, one for
 * each k mod 4, each read in chunks of 256 bytes, 1 KiB, 4 KiB or 64 KiB (by its k mod 4) and in chunks of
 * 64 KiB, the size ingest reads with; at bound 2 or more, in all four.
 *
 * The walk, on the torn file itself, at each cut walkCuts gives, a byte either side of each boundary too at
 * bound 1 or more. At bound 1, at three seeded (k, chunk size) pairs too (CODING_SH_PROP_RUNS raises the
 * pairs); at bound 2 or more, at every k too. With the fragment's mtime set to T:
 * 1. read from 0 at T, the file yields the prefix's records as the prefix alone does, and nothing else;
 * 2. read from P, it yields nothing at T + 1 h, and at T + 1 h + 1 ms one error over [P, P + k), the aged one;
 * 3. the rest appended, a read from P yields the whole line at P; a read from P + k one "invalid JSON" error
 *    over the rest (k < L), or the "\n" as a blank line (k = L);
 * 4. a node writer's line appended instead (appendSpool, a "\n" at P + k first), a read from P yields an
 *    "invalid JSON" error over the fragment and its "\n" then the new line (k < L), or both lines (k = L);
 *    from P + k, the "\n" as a blank line, then the new line;
 * 5. hook.sh's line glued on instead, a read from P yields one "invalid JSON" error over the whole line,
 *    saying the glued line is kept, then that line at P + k; from P + k, the same record and no error.
 */
export async function checkReader(part: number, parts: number, bound: number, env: NodeJS.ProcessEnv = process.env): Promise<{ fixtures: number; cuts: number; bytes: number; walks: number; reads: number }> {
  const tmp = tmpEnv();
  const fixtures = shard(tornFixtures(), readerWeight, part, parts);
  let cuts = 0;
  let bytes = 0;
  let walks = 0;
  let reads = 0;
  const T = 1_800_000_000;
  try {
    for (const fx of fixtures) {
      const home = new TornHome(tmp.root);
      try {
        const file = home.fileOf(fx.line);
        const { path, source } = file;
        const P = fx.prefix.length;
        const L = fx.last.length - 1;

        const taken = cutsAt(L, bound);
        for (let m = 0; m < CHUNKS.length; m++) {
          const ks = taken.filter((k) => k % CHUNKS.length === m);
          const chunks = bound >= 2 ? CHUNKS : [...new Set([CHUNKS[m]!, 1 << 16])];
          bytes += await checkSegments(home, fx, file, ks, chunks);
          cuts += ks.length;
          reads += chunks.length;
        }

        writeFileSync(path, fx.prefix);
        const before = await read(home.spoolDir, path, 0);
        assert.deepEqual({ errs: before.errs, blanks: before.blanks }, { errs: [], blanks: [] }, `${fx.file}: the prefix reads with errors or blank lines`);
        assert.equal(before.recs.at(-1)?.nextOffset, P, `${fx.file}: the prefix does not read to its end`);
        const whole = { source, line: fx.line, offset: P, nextOffset: P + L + 1 };
        const walk = async (k: number, cs: number) => {
          const at = `${fx.file}, its last line cut to ${k} of ${L} bytes, read in chunks of ${cs}`;
          walks++;
          reads += 9;

          writeFileSync(path, Buffer.concat([fx.prefix, fx.last.subarray(0, k)]));
          utimesSync(path, T, T);
          assert.deepEqual(await read(home.spoolDir, path, 0, cs, T * 1000), { ...NOTHING, recs: before.recs }, `${at}: the lines before it`);
          assert.deepEqual(await read(home.spoolDir, path, P, cs, T * 1000 + TORN_TAIL_MS), NOTHING, `${at}: the fragment, an hour old`);
          const old = await read(home.spoolDir, path, P, cs, T * 1000 + TORN_TAIL_MS + 1);
          assert.deepEqual(old, { ...NOTHING, errs: [{ source, offset: P, nextOffset: P + k, message: aged(k) }] }, `${at}: the fragment, over an hour old`);

          appendFileSync(path, fx.last.subarray(k));
          assert.deepEqual(await read(home.spoolDir, path, P, cs), { ...NOTHING, recs: [whole] }, `${at}: the rest appended, read from the line's start`);
          const rest = await read(home.spoolDir, path, P + k, cs);
          if (k < L) {
            assert.deepEqual({ recs: rest.recs, blanks: rest.blanks }, { recs: [], blanks: [] }, `${at}: the rest appended, read from the fragment's end`);
            assertInvalid(rest.errs, { source, offset: P + k, nextOffset: P + L + 1, kept: false }, `${at}: the rest appended, read from the fragment's end`);
          } else assert.deepEqual(rest, { ...NOTHING, blanks: [P + L + 1] }, `${at}: the "\\n" appended, read from the line's end`);

          truncateSync(path, P + k);
          assert.equal(appendSpool(structuredClone(fx.line), home.env, { redact: identity }), path, `${at}: appendSpool wrote another file`);
          const onDisk = readFileSync(path);
          assert.equal(onDisk[P + k], 0x0a, `${at}: appendSpool did not start its line on a fresh line`);
          const written = JSON.parse(onDisk.toString("utf8", P + k + 1)) as SpoolLine;
          const wLine = written.rawFile === undefined ? fx.line : { ...fx.line, rawFile: written.rawFile };
          const wRec = { source, line: wLine, offset: P + k + 1, nextOffset: onDisk.length };
          const node = await read(home.spoolDir, path, P, cs);
          if (k < L) {
            assert.deepEqual({ recs: node.recs, blanks: node.blanks }, { recs: [wRec], blanks: [] }, `${at}: a node writer's line appended`);
            assertInvalid(node.errs, { source, offset: P, nextOffset: P + k + 1, kept: false }, `${at}: a node writer's line appended`);
          } else assert.deepEqual(node, { ...NOTHING, recs: [whole, wRec] }, `${at}: a node writer's line appended`);
          assert.deepEqual(await read(home.spoolDir, path, P + k, cs), { ...NOTHING, recs: [wRec], blanks: [P + k + 1] }, `${at}: a node writer's line appended, read from the fragment's end`);
          rmSync(join(dirname(path), "raw"), { recursive: true, force: true });

          truncateSync(path, P + k);
          appendFileSync(path, fx.next);
          const end = P + k + fx.next.length;
          const glued = { source, line: fx.line, offset: P + k, nextOffset: end };
          const hook = await read(home.spoolDir, path, P, cs);
          assert.deepEqual({ recs: hook.recs, blanks: hook.blanks }, { recs: [glued], blanks: [] }, `${at}: hook.sh's line glued on`);
          assertInvalid(hook.errs, { source, offset: P, nextOffset: end, kept: true }, `${at}: hook.sh's line glued on`);
          assert.deepEqual(await read(home.spoolDir, path, P + k, cs), { ...NOTHING, recs: [glued] }, `${at}: hook.sh's line glued on, read from the fragment's end`);
        };

        const walked = new Set<string>();
        const once = async (k: number, cs: number) => {
          if (walked.has(`${k} ${cs}`)) return;
          walked.add(`${k} ${cs}`);
          await walk(k, cs);
        };
        for (const [k, cs] of walkCuts(P, L, bound >= 1)) await once(k, cs);
        if (bound >= 2) for (let k = 1; k <= L; k++) await once(k, CHUNKS[k % CHUNKS.length]!);
        else if (bound === 1) await forAll(gen.tuple<[number, number]>(gen.int(1, L), gen.int(0, CHUNKS.length - 1)), ([k, m]) => walk(k, CHUNKS[m]!), { runs: 3, label: `torn read ${fx.file}`, env });
      } finally {
        home.remove();
      }
    }
  } finally {
    tmp.restore();
  }
  return { fixtures: fixtures.length, cuts, bytes, walks, reads };
}

// ---------------------------------------------------------------- ingest

interface Variant {
  name: "past" | "today";
  now: number;
  /** The day has passed: ingest scrubs the file once it has read it to its end, and sets its scrub cursor. */
  scrub: boolean;
}

interface Base {
  /** The prefix ingested into empty stores: kept as it is, and cloned for each case. */
  stores: Stores;
  snap: string;
  /** The prefix and the whole last line ingested into empty stores. */
  whole: string;
}

function assertQuiet(r: IngestResult, what: string): void {
  assert.deepEqual({ lines: r.lines, events: r.events, errors: r.errors }, { lines: 0, events: 0, errors: [] }, what);
}

/**
 * Ingest on each fixture in the shard, at the clock of a day that has passed (past) and of the file's own
 * day (today). R0 is the prefix ingested into empty stores. Each case below starts from a copy of R0 unless
 * it says "from empty", and "the reference" is the file a case ends with, rewritten as the bytes a reader
 * takes it for (a fragment it skips becomes spaces and a "\n"), ingested into empty stores.
 * - quiet: at each k, a fresh fragment ingested over R0 stores nothing, reports nothing and moves no
 *   cursor; R0 is the same after each k of the fixture (past; today too at bound 2 or more);
 * - fresh from empty: the prefix and a fresh fragment store what R0 stores, without the scrub cursor;
 * - aged: an aged fragment is reported once at P and skipped, from R0 or from empty, and the stores are
 *   R0's with the cursors moved past it;
 * - aged, then the rest: the rest is reported as invalid JSON (k < L) and skipped; the stores are R0's with
 *   the cursors past the whole line;
 * - fresh, then the rest: the stores are those of the whole file ingested at once;
 * - fresh, then a node writer's line: the fragment is reported (k < L) and the new line stored, as the
 *   reference stores them; aged, then a node writer's line: the same with nothing reported;
 * - hook.sh's line glued on: reported once, saying the line is kept, and stored as the reference stores it;
 *   aged, then hook.sh's line: the same with nothing reported.
 * Bounds: at bound 0, the quiet case at each k cutsAt gives (past), and the others at k = L (past) on the
 * shard's smallest fixture and at two seeded (fixture, k, variant) cases. At 1, the quiet case at every k
 * (past), and the others at k = 1, 2, L/2, L - 1 and L (past) and at three seeded (k, variant) pairs per
 * fixture. CODING_SH_PROP_RUNS raises the seeded cases. At 2 or more, every case at every k on both clocks.
 */
export async function checkIngest(part: number, parts: number, bound: number, env: NodeJS.ProcessEnv = process.env): Promise<{ fixtures: number; quiet: number; cases: number; ingests: number }> {
  const tmp = tmpEnv();
  const fixtures = shard(tornFixtures(), (f) => f.last.length + 300, part, parts);
  let quiet = 0;
  let cases = 0;
  let ingests = 0;
  /** Each fixture's home, removed at the end: bound 0's seeded cases run once every fixture has had its quiet case. */
  const homes: TornHome[] = [];
  /** Each fixture's cases, for bound 0: `check(k, today)` runs the cases at k on that clock. */
  const later: { fx: TornFixture; L: number; check: (k: number, today: boolean) => Promise<void> }[] = [];
  try {
    for (const fx of fixtures) {
      const home = new TornHome(tmp.root);
      homes.push(home);
      const { path, source } = home.fileOf(fx.line);
      const P = fx.prefix.length;
      const L = fx.last.length - 1;
      const day = utcDay(fx.line.ts);
      const [inflightA, inflightB] = spoolInFlightKeys(source);
      const scrubKey = spoolScrubKey(source);
      const variants: Variant[] = [
        { name: "past", now: pastNow(day), scrub: true },
        { name: "today", now: todayNow(day), scrub: false },
      ];
      const run = async (s: Stores, v: Variant) => {
        ingests++;
        return home.ingest(s, v.now);
      };
      /** Stores of `bytes` ingested from empty. */
      const fromEmpty = async (bytes: Buffer, v: Variant, what: string) => {
        writeFileSync(path, bytes);
        const s = emptyStores();
        const r = await run(s, v);
        assert.deepEqual(r.errors, [], `${what}: the reference reports errors`);
        return snapshot(s);
      };
      const bases = new Map<string, Base>();
      const baseOf = async (v: Variant): Promise<Base> => {
        const have = bases.get(v.name);
        if (have) return have;
        const whole = await fromEmpty(Buffer.concat([fx.prefix, fx.last]), v, `${fx.file} (${v.name})`);
        writeFileSync(path, fx.prefix);
        const stores = emptyStores();
        const r = await run(stores, v);
        assert.deepEqual(r.errors, [], `${fx.file} (${v.name}): the prefix reports errors`);
        assert.equal(await stores.index.getCursor(source), P, `${fx.file} (${v.name}): the prefix's cursor`);
        const base = { stores, snap: snapshot(stores), whole };
        bases.set(v.name, base);
        return base;
      };
      /** R0 with the file's cursors at `to`: the local one, both in-flight keys and, on a past day, the scrub cursor. */
      const moved = (base: Base, to: number, v: Variant) => {
        const set: Record<string, number> = { [source]: to, [inflightA]: to, [inflightB]: to };
        if (v.scrub) set[scrubKey] = to;
        return withCursors(base.snap, set);
      };
      const torn = (k: number) => Buffer.concat([fx.prefix, fx.last.subarray(0, k)]);

      for (const v of variants) {
        if (v.name === "today" && bound < 2) continue;
        const base = await baseOf(v);
        for (const k of cutsAt(L, bound)) {
          const at = `${fx.file} (${v.name}), its last line cut to ${k} of ${L} bytes`;
          writeFileSync(path, torn(k));
          assertQuiet(await run(base.stores, v), `${at}: a fresh fragment`);
          assert.equal(await base.stores.index.getCursor(source), P, `${at}: a fresh fragment moved the cursor`);
          if (v.scrub) assert.equal(await base.stores.index.getCursor(scrubKey), P, `${at}: a fresh fragment moved the scrub cursor`);
          quiet++;
        }
        sameStore(snapshot(base.stores), base.snap, `${fx.file} (${v.name}): R0 after a fresh fragment at each k`);
      }

      const check = async (k: number, v: Variant) => {
        const at = `${fx.file} (${v.name}), its last line cut to ${k} of ${L} bytes`;
        const base = await baseOf(v);
        const clone = () => cloneStores(base.stores);
        cases++;

        // Fresh, from empty.
        writeFileSync(path, torn(k));
        let s = emptyStores();
        assert.deepEqual((await run(s, v)).errors, [], `${at}: a fresh fragment, from empty`);
        sameStore(snapshot(s), withCursors(base.snap, { [scrubKey]: undefined }), `${at}: a fresh fragment, from empty`);

        // Aged, from empty and from R0.
        age(path);
        s = emptyStores();
        let r = await run(s, v);
        assert.deepEqual(r.errors, [{ source, offset: P, message: aged(k) }], `${at}: an aged fragment, from empty`);
        sameStore(snapshot(s), moved(base, P + k, v), `${at}: an aged fragment, from empty`);
        s = clone();
        r = await run(s, v);
        assert.deepEqual({ lines: r.lines, events: r.events, errors: r.errors }, { lines: 0, events: 0, errors: [{ source, offset: P, message: aged(k) }] }, `${at}: an aged fragment`);
        sameStore(snapshot(s), moved(base, P + k, v), `${at}: an aged fragment`);

        // Aged, then the rest.
        appendFileSync(path, fx.last.subarray(k));
        r = await run(s, v);
        assert.deepEqual({ lines: r.lines, events: r.events }, { lines: 0, events: 0 }, `${at}: the rest after an aged fragment`);
        if (k < L) assertInvalid(r.errors, { source, offset: P + k, kept: false }, `${at}: the rest after an aged fragment`);
        else assert.deepEqual(r.errors, [], `${at}: the "\\n" after an aged fragment`);
        sameStore(snapshot(s), moved(base, P + L + 1, v), `${at}: the rest after an aged fragment`);

        // Fresh, then the rest.
        writeFileSync(path, torn(k));
        s = clone();
        assertQuiet(await run(s, v), `${at}: a fresh fragment`);
        appendFileSync(path, fx.last.subarray(k));
        assert.deepEqual((await run(s, v)).errors, [], `${at}: the rest after a fresh fragment`);
        sameStore(snapshot(s), base.whole, `${at}: the rest after a fresh fragment`);

        // Fresh, then a node writer's line.
        writeFileSync(path, torn(k));
        s = clone();
        assert.ok(appendSpool(structuredClone(fx.line), home.env, { redact: identity }) === path, `${at}: appendSpool wrote another file`);
        let bytes = readFileSync(path);
        assert.equal(bytes[P + k], 0x0a, `${at}: appendSpool did not start its line on a fresh line`);
        r = await run(s, v);
        if (k < L) assertInvalid(r.errors, { source, offset: P, kept: false }, `${at}: a node writer's line after a fresh fragment`);
        else assert.deepEqual(r.errors, [], `${at}: a node writer's line after the whole line`);
        let actual = snapshot(s);
        const ref = k < L ? Buffer.concat([fx.prefix, spaces(k), bytes.subarray(P + k)]) : bytes;
        sameStore(actual, await fromEmpty(ref, v, at), `${at}: a node writer's line after a fresh fragment`);
        rmSync(join(dirname(path), "raw"), { recursive: true, force: true });

        // Aged, then a node writer's line: the fragment was skipped, whole or not.
        writeFileSync(path, torn(k));
        age(path);
        s = clone();
        assert.deepEqual((await run(s, v)).errors, [{ source, offset: P, message: aged(k) }], `${at}: an aged fragment`);
        assert.ok(appendSpool(structuredClone(fx.line), home.env, { redact: identity }) === path, `${at}: appendSpool wrote another file`);
        bytes = readFileSync(path);
        assert.equal(bytes[P + k], 0x0a, `${at}: appendSpool did not start its line on a fresh line`);
        assert.deepEqual((await run(s, v)).errors, [], `${at}: a node writer's line after an aged fragment`);
        actual = snapshot(s);
        sameStore(actual, await fromEmpty(Buffer.concat([fx.prefix, spaces(k), bytes.subarray(P + k)]), v, at), `${at}: a node writer's line after an aged fragment`);
        rmSync(join(dirname(path), "raw"), { recursive: true, force: true });

        // hook.sh's line glued on, then the same after an aged fragment.
        const ref7 = await fromEmpty(Buffer.concat([fx.prefix, spaces(k - 1), Buffer.from("\n"), fx.next]), v, at);
        writeFileSync(path, Buffer.concat([torn(k), fx.next]));
        s = clone();
        r = await run(s, v);
        assertInvalid(r.errors, { source, offset: P, kept: true }, `${at}: hook.sh's line glued on`);
        sameStore(snapshot(s), ref7, `${at}: hook.sh's line glued on`);
        writeFileSync(path, torn(k));
        age(path);
        s = clone();
        assert.deepEqual((await run(s, v)).errors, [{ source, offset: P, message: aged(k) }], `${at}: an aged fragment`);
        appendFileSync(path, fx.next);
        assert.deepEqual((await run(s, v)).errors, [], `${at}: hook.sh's line after an aged fragment`);
        sameStore(snapshot(s), ref7, `${at}: hook.sh's line after an aged fragment`);
      };

      if (bound >= 2) {
        for (const v of variants) for (let k = 1; k <= L; k++) await check(k, v);
      } else if (bound === 1) {
        for (const k of new Set([1, 2, Math.floor(L / 2), L - 1, L])) await check(k, variants[0]!);
        // A failing case reruns up to 40 times while it shrinks: each run is about 15 ingests.
        await forAll(gen.tuple<[number, boolean]>(gen.int(1, L), gen.bool), async ([k, today]) => check(k, variants[today ? 1 : 0]!), { runs: 3, label: `torn ingest ${fx.file}`, env, maxShrinks: 40 });
      } else later.push({ fx, L, check: (k, today) => check(k, variants[today ? 1 : 0]!) });
    }
    if (bound === 0) {
      // k = L: the rest is the "\n" alone, a blank line that ends the file. On the smallest fixture, the quickest to ingest.
      const size = (f: TornFixture) => f.prefix.length + f.last.length;
      const small = later.reduce((a, b) => (size(b.fx) < size(a.fx) ? b : a));
      await small.check(small.L, false);
      // A failing case reruns up to 40 times while it shrinks: each run is about 15 ingests.
      const cut = gen.chain(gen.int(0, later.length - 1), (i) => gen.tuple<[number, number, boolean]>(gen.constant(i), gen.int(1, later[i]!.L), gen.bool));
      await forAll(cut, async ([i, k, today]) => later[i]!.check(k, today), { runs: 2, label: `torn ingest, part ${part + 1} of ${parts}`, env, maxShrinks: 40 });
    }
  } finally {
    for (const h of homes) h.remove();
    tmp.restore();
  }
  return { fixtures: fixtures.length, quiet, cases, ingests };
}
