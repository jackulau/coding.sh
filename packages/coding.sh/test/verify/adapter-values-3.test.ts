// Each adapter's backfill over its fixture homes with one value of one record changed, part 3 of 3.
// This part: the homes of every agent but Claude Code and Codex. The parts are split by agent so each runs
// about as long; _values.ts holds the check (checkValues) and the parts (VALUE_PARTS).
//
// Inputs, properties and bounds as in adapter-values-1.test.ts.
// The default run is 695 changes in 164 records of 25 files, 721 backfills; it takes about 3 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkValues, VALUE_PARTS } from "./_values.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);
const homes = VALUE_PARTS[2]!;

test("each backfill keeps its contract with one value of a record changed to another type or removed (part 3 of 3)", async (t) => {
  const s = await checkValues(homes, bound);
  t.diagnostic(`${s.changes} changes of ${s.names} names in ${s.records} records of ${s.files} files, ${s.repeats} with ids allowed to repeat; ${s.runs} backfills`);
});
