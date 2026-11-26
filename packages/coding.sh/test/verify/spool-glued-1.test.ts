// The spool reader, ingest and the scrub of a past day on a spool file whose last line is cut inside a
// character, with hook.sh's next line glued on (part 1 of 3: the parts split the spool fixtures by size).
//
// Inputs: each spool fixture under test/fixtures/adapters, with a note added to its last line's payload: a
// character of 2, 3 or 4 bytes in UTF-8 (U+00E9, U+20AC, U+1F600), with an AWS secret before it or not.
// The line is cut inside the character, after 1 to n - 1 of its n bytes, and the same line, holding the
// secret or not, is glued on: P bytes of lines, a fragment of k bytes, then the glued line from byte P + k.
// Properties (checkGlued in _glued.ts): the reader yields the glued line at P + k, read from the
// fragment's start or from its own, and reports the fragment once, saying the line is kept. Ingest stores
// what the file stores with the fragment as blank space: with the fragment read fresh on a day after the
// file's, and with it aged on the file's own day and the glued line read on its own. On a day after the
// file's, ingest scrubs the file: it keeps its size, the secret is in neither the file nor a side file,
// every line reads from where it started, as the scrubbed reference file reads, a fragment that held the
// secret is a blank line, and the file ingested again stores events under the ids the scrubbed reference
// file gives (a line the scrub rewrote can give its events new ids: an id can hash the line).
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 0, this part's first three cases and every 13th
// case from the first, each with the note as the payload's last field, read in chunks of 7 bytes and
// 64 KiB and ingested fresh. Then 2 seeded cases that also put the note among the payload's fields, read
// in chunks of 1, 7 and 256 bytes and 64 KiB, and take the aged path. The first three cut U+00E9 after its
// first byte on the smallest fixture, with the secret in neither line, in the glued line and in the
// fragment. At 1, every case: each fixture of this part, character, cut and place of the secret (neither
// line, the fragment, the glued line, both), read and ingested so, then 14 seeded cases. At 2 or more, the
// aged path and every chunk size on every case too. CODING_SH_PROP_RUNS raises the seeded cases. This
// part takes about 2 s.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkGlued } from "./_glued.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

test("the reader, ingest and the scrub on each fixture's last line cut inside a character, with a line glued on (part 1 of 3)", async (t) => {
  const { fixtures, cases, seeded, ingests } = await checkGlued(0, 3, bound);
  t.diagnostic(`${cases} cases over ${fixtures} fixtures and ${seeded} seeded ones, ${ingests} ingests`);
});
