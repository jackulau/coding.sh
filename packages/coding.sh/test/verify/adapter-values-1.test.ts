// Each adapter's backfill over its fixture homes with one value of one record changed, part 1 of 3.
// This part: the Claude Code homes. The parts are split by agent so each runs about as long; _values.ts
// holds the check (checkValues) and the parts (VALUE_PARTS).
//
// Inputs: the transcripts and JSON files of each home (_transcript.ts LINE_PARTS and JSON_PARTS), with one
// value of one record set to null, 0, -1, 1e308, -1e308, "", "x", true, [], [null] or {}, or removed. Properties:
// the backfill does not throw, and yields events ingest keeps, each with a 64-hex id, no two alike unless
// the change can make the file hold one thing twice (_values.ts). Bounds, by CODING_SH_MODEL_BOUND (0 when
// unset): at b, the first b changes of each name (the agent, the record's kind, the path without its indexes
// and the new value); at 0, every 13th of the changes bound 1 checks.
// The default run is 443 changes in 506 records of 24 files, 461 backfills; it takes about 3 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkValues, VALUE_PARTS } from "./_values.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);
const homes = VALUE_PARTS[0]!;

test("each backfill keeps its contract with one value of a record changed to another type or removed (part 1 of 3)", async (t) => {
  const s = await checkValues(homes, bound);
  t.diagnostic(`${s.changes} changes of ${s.names} names in ${s.records} records of ${s.files} files, ${s.repeats} with ids allowed to repeat; ${s.runs} backfills`);
});
