// The spool reader on a file whose last line is torn at a byte, then completed by each kind of writer
// (part 3 of 3: the parts split the spool fixtures by how long their checks take).
//
// Inputs: each spool fixture under test/fixtures/adapters, as its lines before the last (P bytes) and its
// last line (L bytes and a "\n"), with the last line cut to k bytes, for each k from 1 to L. Then, in
// turn: the rest of the line appended, a node writer's next line appended (appendSpool), and hook.sh's
// next line glued on. The next line is the last line again.
// Properties (checkReader in _torn.ts): the lines before the fragment read the same; the fragment yields
// nothing while it is fresh and one error once it is over an hour old (the clock passed to the reader);
// the completed line reads whole from its start, and the rest alone is one invalid line (a blank line at
// k = L); after a node writer's line the fragment is one invalid line and the new line reads from its own
// start; a glued line is reported once and kept at the offset where it starts, read from the fragment or
// from its own start.
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 0, k = 1, 2, L/2, L - 1 and L and every 13th k,
// each k's fragment, glued line and rest written as one segment of a file read in one pass, in chunks of
// 64 KiB and, for three k in four, of 256 bytes, 1 KiB or 4 KiB; and the torn file itself, fresh and aged,
// at k = 1, 2, L/2, L - 1 and L and at each k whose fragment ends on a chunk boundary. At 1, the segments
// at every k, and the torn file a byte either side of each boundary too and at three seeded (k, chunk
// size) pairs (CODING_SH_PROP_RUNS raises the pairs). At 2 or more, the segments in every chunk size and
// the torn file at every k. This part takes about 2 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkReader } from "./_torn.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

test("the spool reader on cuts of each fixture's last line, then that line completed, a node writer's line and a glued line (part 3 of 3)", async (t) => {
  const { fixtures, cuts, bytes, walks, reads } = await checkReader(2, 3, bound);
  t.diagnostic(`${cuts} cuts over ${fixtures} fixtures: ${(bytes / 1e6).toFixed(1)} MB of segments and ${walks} torn files, ${reads} reads`);
});
