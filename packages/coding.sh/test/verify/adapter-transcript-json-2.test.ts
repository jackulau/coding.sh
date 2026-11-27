// Each adapter's backfill over its fixture homes with a JSON file cut short, part 2 of 2.
// This part: the JSON files of the Droid homes home and real (session .settings.json sidecars), the Gemini
// CLI home (projects.json and a chat saved as JSON) and the OpenCode store (sessions, messages and parts).
// The homes are split between adapter-transcript-json-1 and -2.test.ts so each part runs about as long;
// _transcript.ts holds the check (checkJsonFiles) and the homes (JSON_PARTS).
//
// Inputs: a copy of each fixture home under test/fixtures/adapters, every file in it a day old so each
// session reads as finished, with one JSON file F the backfill reads changed at a time; n is F's length
// through its last value.
//
// Properties, for every F:
// - the backfill does not throw, and yields events that ingest keeps (core/ingest.ts validEvent), each with
//   a 64-hex id, no two with the same one;
// - F cut to its first k bytes gives the outcome (events, copies reported, error) F gives left empty;
// - F cut and closed into JSON (_cut.ts closeJson) has every session F has left empty, under its own id
//   or, when the cut fell inside that id, under the part of it the closed text holds.
//
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 1 or more, every k in 1..n-1, exhaustively; at 0,
// k = 1, n/2, n-1, every 13th k and the cuts FIXED_JSON in _transcript.ts names. Each distinct closed
// cut is checked once.
// The default run is 11 files: 261 cuts and 199 closed cuts, 479 backfills; it takes about 3 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkJsonFiles, JSON_PARTS } from "./_transcript.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

test("each backfill keeps its contract with a JSON file cut short or closed (part 2 of 2)", async (t) => {
  const s = await checkJsonFiles(JSON_PARTS[1]!, bound);
  t.diagnostic(`${s.files} JSON files: ${s.cuts} cuts, ${s.closed} closed cuts; ${s.runs} backfills`);
});
