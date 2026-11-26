// Each adapter's backfill over its fixture homes with transcript lines cut short, part 5 of 6.
// This part: the Claude Code home fallback and the Codex homes home and cut.
// The homes are split between adapter-transcript-1 to -6.test.ts so each part runs about as long;
// _transcript.ts holds the checks (checkLines, checkMixes) and the homes (LINE_PARTS).
//
// Inputs: a copy of each fixture home under test/fixtures/adapters, every file in it a day old so each
// session reads as finished, with one transcript F (a JSONL file the backfill reads) changed at a time. A
// record is a line that parses to a JSON object; n is its length through the closing brace.
//
// Properties, for every record L of every F:
// - the backfill does not throw, and yields events that ingest keeps (core/ingest.ts validEvent), each with
//   a 64-hex id, no two with the same one;
// - F with L cut to its first k bytes gives the outcome (events, copies reported, error) F gives with L
//   blank: a line cut short changes no other line's events;
// - F ending k bytes into L, as a file whose writer stopped mid-line, gives the outcome of F ending before L;
// - F ending at L's closing brace gives the outcome of F ending after L's line end;
// - F with L cut and closed into JSON (_cut.ts closeJson) has every session F has with L blank, under its
//   own id or, when the cut fell inside that id, under the part of it the closed line holds.
// And in seeded cases, lines cut short and closed cuts put in among F's lines or in place of some, and a
// cut record at the end with no line end: F so changed gives the outcome it gives with a blank line in
// place of each line cut short and nothing at the end.
//
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset). At 1: k = 1, n/2 and n-1 for every record. No prefix of a
// JSON object text short of its closing brace parses as JSON, so a reader that parses whole lines skips each
// cut as it skips a blank line, and these stand for every k (_transcript.ts says why the one reader that
// looks into such a line does not see them). The closed cuts are at k = 1 and at the end of each top-level
// member of every record, each distinct closed line once; the seeded cases are 20 per transcript. At a bound
// b of 2 or more, also b - 1 values of k spread over each record, and 20b seeded cases per transcript. At 0,
// only each transcript's first and last records, every 13th, and those FIXED_LINES in _transcript.ts names
// (each also cut where its entry says), checked as at 1, and 2 seeded cases per transcript.
// CODING_SH_PROP_RUNS raises the seeded cases.
// The default run is 18 of 134 records in 6 transcripts: 54 cuts, 148 closed cuts and 12 seeded cases, 353
// backfills; it takes about 3 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkLines, checkMixes, LINE_PARTS } from "./_transcript.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);
const homes = LINE_PARTS[4]!;

test("each backfill keeps its contract with transcript lines cut short, torn and closed (part 5 of 6)", async (t) => {
  const s = await checkLines(homes, bound);
  t.diagnostic(`${s.lines} of ${s.records} records in ${s.files} transcripts: ${s.cuts} cuts, ${s.closed} closed cuts, ${s.other} other lines left as they are; ${s.runs} backfills`);
});

test("lines cut short among a transcript's lines change no outcome (part 5 of 6)", async (t) => {
  const s = await checkMixes(homes, bound);
  t.diagnostic(`${s.cases} cases over ${s.files} transcripts; ${s.runs} backfills`);
});
