// Ingest over a spool file whose last line is torn at a byte, then completed by each kind of writer
// (part 3 of 4: the parts split the spool fixtures by the length of their last line).
//
// Inputs: each spool fixture under test/fixtures/adapters, as its lines before the last (P bytes) and its
// last line (L bytes and a "\n"), with the last line cut to k bytes, fresh or over an hour old. Then, in
// turn: the rest of the line appended, a node writer's next line appended (appendSpool), and hook.sh's next
// line glued on. Ingest runs in memory stores, at a clock on a day after the file's (ingest then scrubs the
// file once it has read it to its end) and on the file's own day.
// Properties (checkIngest in _torn.ts): a fresh fragment stores nothing, reports nothing and moves no
// cursor, over the stores of the lines before it, and from empty stores what those lines store; an aged
// fragment is reported once and skipped, with the cursors moved past it; the rest of the line after an
// aged fragment is reported (when it is not just the "\n") and skipped, with the cursors at the end; after
// a fresh fragment the completed line stores what the whole file ingested at once stores; a node writer's
// line, and a glued line, store what the same file stores with the fragment it skips as blank space.
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 0, the fresh fragment at k = 1, 2, L/2, L - 1 and L
// and every 13th k on the later day; the other cases at k = L on the later day on this part's smallest
// fixture, and at two seeded (fixture, k, clock) cases. At 1, the fresh fragment at every k on the later
// day; the other cases at k = 1, 2, L/2, L - 1 and L on the later day, and at three seeded (k, clock)
// pairs per fixture. CODING_SH_PROP_RUNS raises the seeded cases. At 2 or more, every case at every k on
// both clocks. This part takes about 2 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkIngest } from "./_torn.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

test("ingest on cuts of each fixture's last line, fresh and aged, then that line completed, a node writer's line and a glued line (part 3 of 4)", async (t) => {
  const { fixtures, quiet, cases, ingests } = await checkIngest(2, 4, bound);
  t.diagnostic(`${quiet} fresh fragments and ${cases} cases over ${fixtures} fixtures, ${ingests} ingests`);
});
