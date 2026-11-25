// Counted redaction of an event (core/redact.ts redactEventCounted), checked on generated events. A
// payload is 1 to 5 fields, each one of: text (plain words, vendor tokens from GitHub, Slack or
// AWS, and now and then a marker that was there before), an object with a value under a
// secret-named key, a command line with a value after a secret flag, or a number. Two payloads in
// five are 1 to 3 fields with nothing to redact: words, markers and numbers. An event points at 0
// to 2 blobs; most were remembered (noteBlobHits) with 1 to 3 hits of one or two kinds, some were
// not.
//
// The properties: the input is left as it was, and the event comes out as Redactor.event gives it,
// plus payload.redactions: for each kind, the larger of the payload's count and the sum of its
// blobs' counts; {} when nothing was found but the input held a marker; and no redactions when
// nothing was found and no marker was there. An event that points at no blob comes out of a second
// pass as it went in, counts and all. The last test shows the property fails on Redactor.event
// alone, on a finish that ignores the blobs or drops an empty count, and on a second pass that
// forgets what the first one counted.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, noteBlobHits, redactEventCounted, type Redactor } from "../../src/core/redact.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${UPPER}abcdefghijklmnopqrstuvwxyz0123456789`;
/**
 * `n` characters of `alphabet`, each 7 places on from the one before, plus a draw. A shrunk draw is 0,
 * so a shrunk body is a stride, never a made-up value (00000000) that counts as placeholder-key.
 */
const body = (alphabet: string, n: number): Gen<string> =>
  gen.map(gen.array(gen.int(0, alphabet.length - 1), { minLength: n, maxLength: n }), (ds) => ds.map((d, i) => alphabet[(d + 7 * i) % alphabet.length]).join(""));
const alnum = (min: number, max: number): Gen<string> => gen.string({ alphabet: ALNUM, minLength: min, maxLength: max });

/** A text piece and what redaction counts for it: a kind, a marker that was there before, or nothing. */
type Piece = { text: string; kind?: string; marker?: boolean };
const TOKEN: Gen<Piece> = gen.oneOf<Piece>(
  gen.map(gen.chain(gen.int(36, 40), (n) => body(ALNUM, n)), (b) => ({ text: ["gh", "p_", b].join(""), kind: "github-token" })),
  gen.map(gen.chain(gen.int(10, 24), (n) => body(ALNUM, n)), (b) => ({ text: ["xox", "b-", b].join(""), kind: "slack-token" })),
  gen.map(body(`${UPPER}0123456789`, 16), (b) => ({ text: ["AK", "IA", b].join(""), kind: "aws-access-key" })),
);
const WORD: Gen<Piece> = gen.map(gen.pick(["alpha", "build", "cache", "delta", "event", "field"]), (text) => ({ text }));
const MARKER: Gen<Piece> = gen.map(gen.pick(["[redacted:github-token]", "[redacted:secret-field]", "[redacted:email]"]), (text) => ({ text, marker: true }));

/** A payload field: its value and what redaction counts in it. */
type Field = { value: unknown; kinds: string[]; marker: boolean };
const textField = (piece: Gen<Piece>): Gen<Field> =>
  gen.map(gen.array(piece, { minLength: 1, maxLength: 4 }), (ps) => ({ value: ps.map((p) => p.text).join(" "), kinds: ps.flatMap((p) => (p.kind ? [p.kind] : [])), marker: ps.some((p) => p.marker) }));
const NUMBER: Gen<Field> = gen.map(gen.int(0, 999), (n) => ({ value: n, kinds: [], marker: false }));
const FIELD: Gen<Field> = gen.frequency<Field>(
  [4, textField(gen.frequency([3, WORD], [2, TOKEN], [1, MARKER]))],
  [2, gen.map(gen.tuple(gen.pick(["password", "apiKey", "token", "client_secret"]), alnum(8, 16)), ([k, v]) => ({ value: { [k]: v, note: "alpha" }, kinds: ["secret-field"], marker: false }))],
  [2, gen.map(gen.tuple(gen.pick(["--api-key", "--token", "--db-password"]), alnum(8, 16)), ([flag, v]) => ({ value: ["run", flag, v], kinds: ["secret-flag"], marker: false }))],
  [1, NUMBER],
);
/** A field with nothing to redact: words, markers that were there before, or a number. */
const QUIET_FIELD: Gen<Field> = gen.frequency<Field>([4, textField(gen.frequency([2, WORD], [1, MARKER]))], [1, NUMBER]);

/** A blob the event points at, and the hits remembered for it (none: not remembered). */
type Blob = Record<string, number> | undefined;
const BLOB_KINDS = ["github-token", "slack-token", "aws-access-key", "secret-field", "secret-flag", "email"];
const BLOB: Gen<Blob> = gen.frequency<Blob>(
  [4, gen.map(gen.array(gen.tuple(gen.pick(BLOB_KINDS), gen.int(1, 3)), { minLength: 1, maxLength: 2 }), (hits) => Object.fromEntries(hits))],
  [1, gen.constant(undefined)],
);

type EventCase = { fields: Field[]; blobs: Blob[] };
const CASE: Gen<EventCase> = gen.record({
  fields: gen.frequency([3, gen.array(FIELD, { minLength: 1, maxLength: 5 })], [2, gen.array(QUIET_FIELD, { minLength: 1, maxLength: 3 })]),
  blobs: gen.frequency([3, gen.constant([])], [2, gen.array(BLOB, { minLength: 1, maxLength: 2 })]),
});

/** Each case's blobs get refs of their own, so hits remembered for one case never reach another. */
let serial = 0;
function eventOf(c: EventCase): AgentEvent {
  const id = ++serial;
  const e: AgentEvent = { id: `e${id}`, v: 0, sessionId: "s", ts: 1, agent: "fake", kind: "tool.end", payload: Object.fromEntries(c.fields.map((f, i) => [`f${i}`, f.value])) };
  if (c.blobs.length) e.blobs = c.blobs.map((hits, j) => {
    const ref = `blob-${id}-${j}`;
    if (hits) noteBlobHits(ref, hits);
    return ref;
  });
  return e;
}

/** payload.redactions the finish must write: undefined when it must write none. */
function wantedCounts(c: EventCase): Record<string, number> | undefined {
  const inline: Record<string, number> = {};
  for (const k of c.fields.flatMap((f) => f.kinds)) inline[k] = (inline[k] ?? 0) + 1;
  const inBlobs: Record<string, number> = {};
  for (const hits of c.blobs) for (const [k, n] of Object.entries(hits ?? {})) inBlobs[k] = (inBlobs[k] ?? 0) + n;
  const counts = { ...inline };
  for (const [k, n] of Object.entries(inBlobs)) counts[k] = Math.max(counts[k] ?? 0, n);
  if (Object.keys(counts).length) return counts;
  return c.fields.some((f) => f.marker) ? {} : undefined;
}

type Finish = (r: Redactor, e: AgentEvent) => AgentEvent;
const redactor = createRedactor();

/** Fails unless `finish` leaves the input as it was and gives what Redactor.event gives with the counts the case calls for, and a second pass keeps it. */
function expectCounted(c: EventCase, finish: Finish): void {
  const e = eventOf(c);
  const before = structuredClone(e);
  const out = finish(redactor, e);
  assert.deepEqual(e, before, "the input changed");
  const { redactions, ...payload } = out.payload;
  assert.deepEqual({ ...out, payload }, redactor.event(e), "the event comes out other than Redactor.event gives it");
  const want = wantedCounts(c);
  if (want === undefined) assert.ok(!("redactions" in out.payload), `the payload has redactions ${JSON.stringify(redactions)} with nothing found`);
  else assert.deepEqual(redactions, want, `the payload counts ${JSON.stringify(redactions)}, not ${JSON.stringify(want)}`);
  if (!e.blobs) assert.deepEqual(finish(redactor, out), out, "a second pass changed the event");
}

test("an event comes out redacted with the count of each kind, and a second pass keeps the counts", async (t) => {
  const seen = { counted: 0, blobs: 0, markersOnly: 0, nothing: 0 };
  await forAll(
    CASE,
    (c) => {
      expectCounted(c, redactEventCounted);
      const want = wantedCounts(c);
      if (c.blobs.length) seen.blobs++;
      if (want === undefined) seen.nothing++;
      else if (Object.keys(want).length) seen.counted++;
      else seen.markersOnly++;
    },
    { runs: RUNS, label: "counted" },
  );
  t.diagnostic(`${seen.counted} events counted (${seen.blobs} with blobs), ${seen.markersOnly} with markers alone, ${seen.nothing} with nothing`);
});

test("the property fails on Redactor.event alone, a finish that ignores the blobs or drops an empty count, and a second pass that forgets the first count", async (t) => {
  const mutants: [string, Finish, RegExp][] = [
    ["Redactor.event alone", (r, e) => r.event(e), /the payload counts/],
    [
      "a finish that ignores the blobs",
      (r, { blobs, ...e }) => {
        const out = redactEventCounted(r, e);
        return blobs ? { ...out, blobs } : out;
      },
      /the payload counts/,
    ],
    [
      "a finish that drops an empty count",
      (r, e) => {
        const out = redactEventCounted(r, e);
        const { redactions, ...payload } = out.payload;
        return redactions && !Object.keys(redactions).length ? { ...out, payload } : out;
      },
      /the payload counts/,
    ],
    [
      "a second pass that forgets the first count",
      (r, e) => {
        const { redactions: _, ...payload } = e.payload;
        return redactEventCounted(r, { ...e, payload });
      },
      /a second pass changed the event/,
    ],
  ];
  for (const [label, finish, why] of mutants) {
    const f = await failure(CASE, (c) => expectCounted(c, finish), { env: {}, runs: 300, label });
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
