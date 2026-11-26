/**
 * The check of spool-glued-*.test.ts: the spool reader (src/core/spool-read.ts), ingest
 * (src/core/ingest.ts) and the scrub of a past day (src/core/spool-scrub.ts) on a spool file whose last
 * line is cut inside a character, with hook.sh's next line glued on.
 *
 * Inputs. Each spool fixture, as the torn checks take them (tornFixtures in _torn.ts), with a note added
 * to its last line's payload: a character of 2, 3 or 4 bytes in UTF-8 (U+00E9, U+20AC, U+1F600), with an
 * AWS secret before it or not. The line is cut inside the character, after 1 to n - 1 of its n bytes, and
 * the same line, holding the secret or not, is glued on: P bytes of lines, a fragment of k bytes, then
 * the glued line from byte P + k. The reference file has the fragment as blank space: k - 1 spaces and a
 * "\n".
 *
 * checkGlued runs the cases its bound takes of one part's fixtures (the parts split them by size, shard
 * in _torn.ts), then seeded cases over the same fixtures, and states for each case: the reader yields the
 * glued line at P + k, read from the fragment's start or from its own, and reports the fragment once,
 * saying the line is kept. Ingest stores what the reference file stores: with the fragment read fresh on a
 * day after the file's, and with it aged on the file's own day and the glued line read on its own. On a
 * day after the file's, ingest scrubs the file: it keeps its size, the secret is in neither the file nor a
 * side file, every line reads from where it started, as the scrubbed reference file reads, a fragment that
 * held the secret is a blank line, and the file ingested again stores events under the ids the scrubbed
 * reference file gives (a line the scrub rewrote can give its events new ids: an id can hash the line).
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpoolRecord } from "../../src/core/spool-read.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { utcDay } from "../../src/spool/write.ts";
import { forAll, gen, type Gen } from "../_prop.ts";
import { tmpEnv } from "../adapters/_helpers.ts";
import { age, aged, assertInvalid, emptyStores, pastNow, read, sameStore, SAMPLE, shard, snapshot, spaces, todayNow, TornHome, tornFixtures, type Stores, type TornFixture } from "./_torn.ts";

/** Characters of 2, 3 and 4 bytes in UTF-8. */
const CHARS = ["é", "€", "\u{1f600}"] as const;
const SECRET = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");
const NL = Buffer.from("\n");
const ALL_CHUNKS = [1, 7, 256, 1 << 16] as const;

interface Case {
  /** Index into the fixtures, smallest first. */
  fixture: number;
  /** Index into CHARS. */
  char: number;
  /** How many of the character's bytes the fragment ends with: 1 to its length - 1. */
  cut: number;
  /** Where the note goes among the payload's fields; past the last field, it is the last. */
  field: number;
  /** The fragment holds the secret. */
  inFragment: boolean;
  /** The glued line holds the secret. */
  inGlued: boolean;
}

/** The line with a note among its payload's fields, at index `field`: the secret if asked, then the character. */
function noted(line: SpoolLine, field: number, ch: string, secret: boolean): SpoolLine {
  const fields = Object.entries(line.raw as Record<string, unknown>);
  const at = Math.min(field, fields.length);
  const note = `${secret ? `AWS_SECRET_ACCESS_KEY=${SECRET} ` : ""}${ch} done`;
  return { ...line, raw: Object.fromEntries([...fields.slice(0, at), ["note", note], ...fields.slice(at)]) };
}

/** The ids of the events the index holds, sorted. */
const eventIds = (s: Stores): string[] => Object.keys((JSON.parse(snapshot(s)) as { index: { events: Record<string, unknown> } }).index.events).sort();

/** A record without the side file its line names: the scrub picks a new name each time it writes one. */
function noRawFile(r: SpoolRecord): SpoolRecord {
  const { rawFile: _name, ...line } = r.line;
  return { ...r, line };
}

/** Checks one case; `full` adds the aged path. Returns the ingests it ran. */
async function check(home: TornHome, fx: TornFixture, c: Case, full: boolean, chunks: readonly number[]): Promise<number> {
  const ch = CHARS[c.char]!;
  const width = Buffer.byteLength(ch);
  assert.ok(c.cut >= 1 && c.cut < width, `a cut after ${c.cut} of ${width} bytes`);
  const bytes = Buffer.from(JSON.stringify(noted(fx.line, c.field, ch, c.inFragment)));
  const char = bytes.indexOf(ch);
  assert.ok(char > 0 && bytes.indexOf(ch, char + 1) === -1, `${fx.file}: the note's character is not in the line once`);
  const k = char + c.cut;
  const fragment = bytes.subarray(0, k);
  const glued = Buffer.from(`${JSON.stringify(noted(fx.line, c.field, ch, c.inGlued))}\n`);
  const P = fx.prefix.length;
  const E = P + k + glued.length;
  const file = Buffer.concat([fx.prefix, fragment, glued]);
  const ref = Buffer.concat([fx.prefix, spaces(k - 1), NL, glued]);
  const { path, source } = home.fileOf(fx.line);
  const rawDir = join(dirname(path), "raw");
  const day = utcDay(fx.line.ts);
  const secret = c.inFragment ? (c.inGlued ? "in both lines" : "in the fragment") : c.inGlued ? "in the glued line" : "in neither line";
  const where = Number.isFinite(c.field) ? `field ${c.field}` : "the last field";
  const what = `${fx.file}, a note at ${where} cut after ${c.cut} of its character's ${width} bytes (k = ${k}), the secret ${secret}`;
  let ingests = 0;
  const run = (s: Stores, now: number) => {
    ingests++;
    return home.ingest(s, now);
  };

  // The reader.
  writeFileSync(path, file);
  const want = { source, line: JSON.parse(glued.toString("utf8")) as SpoolLine, offset: P + k, nextOffset: E };
  for (const size of chunks) {
    const fromFragment = await read(home.spoolDir, path, P, size);
    assertInvalid(fromFragment.errs, { source, offset: P, nextOffset: E, kept: true }, `${what}: read from the fragment in chunks of ${size}`);
    assert.deepEqual({ recs: fromFragment.recs, blanks: fromFragment.blanks }, { recs: [want], blanks: [] }, `${what}: read from the fragment in chunks of ${size}`);
    assert.deepEqual(await read(home.spoolDir, path, P + k, size), { recs: [want], errs: [], blanks: [] }, `${what}: read from the glued line in chunks of ${size}`);
  }

  // The reference, ingested on a day after the file's: what it stores, and how it reads once scrubbed.
  writeFileSync(path, ref);
  let s = emptyStores();
  assert.deepEqual((await run(s, pastNow(day))).errors, [], `${what}: the reference reports errors`);
  const refPast = snapshot(s);
  let refIds = eventIds(s);
  const scrubbedRef = await read(home.spoolDir, path, 0);
  // A line the scrub rewrote can give its events new ids (an id can hash the line): the scrubbed reference, ingested again.
  if (!readFileSync(path).equals(ref)) {
    s = emptyStores();
    await run(s, pastNow(day));
    refIds = eventIds(s);
  }
  rmSync(rawDir, { recursive: true, force: true });

  /** The file once ingest has scrubbed it, then the file ingested again into empty stores. */
  const scrubbed = async (how: string) => {
    const at = `${what}, ${how}, then scrubbed`;
    const now = readFileSync(path);
    assert.equal(now.length, file.length, `${at}: the file changed size`);
    assert.equal(now.indexOf(SECRET), -1, `${at}: the secret is still in the file`);
    for (const f of existsSync(rawDir) ? readdirSync(rawDir) : []) assert.equal(readFileSync(join(rawDir, f)).indexOf(SECRET), -1, `${at}: the secret is in raw/${f}`);
    const r = await read(home.spoolDir, path, 0);
    assert.deepEqual(r.recs.map(noRawFile), scrubbedRef.recs.map(noRawFile), `${at}: the lines read otherwise than the scrubbed reference's`);
    if (c.inFragment) {
      assert.ok(now.subarray(P, P + k).equals(Buffer.concat([spaces(k - 1), NL])), `${at}: the fragment is not a blank line`);
      assert.deepEqual({ errs: r.errs, blanks: r.blanks }, { errs: [], blanks: [P + k] }, `${at}: the fragment`);
    } else {
      assert.ok(now.subarray(P, P + k).equals(fragment), `${at}: the fragment changed`);
      assertInvalid(r.errs, { source, offset: P, nextOffset: E, kept: true }, `${at}: the fragment`);
      assert.deepEqual(r.blanks, [], `${at}: blank lines`);
    }
    // As a re-parse reads the file: from its start, into stores that hold none of it.
    const again = emptyStores();
    await run(again, pastNow(day));
    assert.deepEqual(eventIds(again), refIds, `${at}: ingested again, the file stores other events`);
    rmSync(rawDir, { recursive: true, force: true });
  };

  // Read fresh, on a day after the file's.
  writeFileSync(path, file);
  s = emptyStores();
  const r = await run(s, pastNow(day));
  assertInvalid(r.errors, { source, offset: P, kept: true }, `${what}: read fresh`);
  sameStore(snapshot(s), refPast, `${what}: read fresh`);
  await scrubbed("read fresh");

  if (full) {
    // Aged on the file's own day, then the glued line on its own; the next day, the scrub.
    writeFileSync(path, ref);
    s = emptyStores();
    assert.deepEqual((await run(s, todayNow(day))).errors, [], `${what}: the reference reports errors on the file's day`);
    const refToday = snapshot(s);
    rmSync(rawDir, { recursive: true, force: true });
    writeFileSync(path, Buffer.concat([fx.prefix, fragment]));
    age(path);
    s = emptyStores();
    assert.deepEqual((await run(s, todayNow(day))).errors, [{ source, offset: P, message: aged(k) }], `${what}: an aged fragment`);
    appendFileSync(path, glued);
    assert.deepEqual((await run(s, todayNow(day))).errors, [], `${what}: the glued line after an aged fragment`);
    sameStore(snapshot(s), refToday, `${what}: the glued line after an aged fragment`);
    assert.deepEqual((await run(s, pastNow(day))).errors, [], `${what}: aged, on the next day`);
    await scrubbed("aged");
  }
  return ingests;
}

const caseOf = (fixtures: number): Gen<Case> =>
  gen.chain(gen.tuple<[number, number]>(gen.int(0, fixtures - 1), gen.int(0, CHARS.length - 1)), ([fixture, char]) =>
    gen.map(gen.tuple<[number, number, boolean, boolean]>(gen.int(1, Buffer.byteLength(CHARS[char]!) - 1), gen.int(0, 16), gen.bool, gen.bool), ([cut, field, inFragment, inGlued]): Case => ({ fixture, char, cut, field, inFragment, inGlued })),
  );

/**
 * A rough cost of a fixture's cases, to split them into parts: the bytes each ingest reads, and a share
 * for the work an ingest does whatever their length. The adapter matters too: three parts of about equal
 * bytes took 20, 20 and 12 s.
 */
const weight = (fx: TornFixture): number => fx.prefix.length + fx.last.length + 4000;

/**
 * Checks part `part` of `parts` at `bound`, then seeded cases over the part's fixtures. The cases put the
 * note as the payload's last field, are read in chunks of 7 bytes and 64 KiB and are ingested fresh: at
 * bound 0, the part's first three cases and every SAMPLE-th case from the first, then 2 seeded cases; at
 * 1, every case, then 14 seeded; at 2 or more, every case also aged and in every chunk size, then 14
 * seeded. The first three cases cut U+00E9 after its first byte on the part's smallest fixture, with the
 * secret in neither line, in the glued line and in the fragment: the first case that showed each problem
 * these checks found. The seeded cases take the aged path too, put the note among the payload's fields and
 * read in chunks of 1, 7 and 256 bytes and 64 KiB; CODING_SH_PROP_RUNS raises them.
 */
export async function checkGlued(part: number, parts: number, bound: number, env: NodeJS.ProcessEnv = process.env): Promise<{ fixtures: number; cases: number; seeded: number; ingests: number }> {
  const tmp = tmpEnv();
  const fixtures = shard(tornFixtures(), weight, part, parts).sort((a, b) => weight(a) - weight(b));
  const homes = new Map<number, TornHome>();
  const homeOf = (i: number): TornHome => {
    let h = homes.get(i);
    if (!h) homes.set(i, (h = new TornHome(tmp.root)));
    return h;
  };
  let cases = 0;
  let ingests = 0;
  /** The number of cases the loop has come to, taken or not. */
  let n = 0;
  try {
    for (const [i, fx] of fixtures.entries()) {
      assert.equal((fx.line.raw as Record<string, unknown>).note, undefined, `${fx.file}: the payload has a note already`);
      for (let char = 0; char < CHARS.length; char++) {
        for (let cut = 1; cut < Buffer.byteLength(CHARS[char]!); cut++) {
          for (const inFragment of [false, true]) {
            for (const inGlued of [false, true]) {
              const take = bound >= 1 || n < 3 || n % SAMPLE === 0;
              n++;
              if (!take) continue;
              ingests += await check(homeOf(i), fx, { fixture: i, char, cut, field: Infinity, inFragment, inGlued }, bound >= 2, bound >= 2 ? ALL_CHUNKS : [7, 1 << 16]);
              cases++;
            }
          }
        }
      }
    }
    // A failing case reruns while it shrinks: each run is about eight ingests.
    const seeded = await forAll(caseOf(fixtures.length), async (c) => {
      ingests += await check(homeOf(c.fixture), fixtures[c.fixture]!, c, true, ALL_CHUNKS);
    }, { runs: bound >= 1 ? 14 : 2, label: `a glued line after a cut character, part ${part + 1} of ${parts}`, env, maxShrinks: 200 });
    return { fixtures: fixtures.length, cases, seeded: seeded.runs, ingests };
  } finally {
    for (const h of homes.values()) h.remove();
    tmp.restore();
  }
}
