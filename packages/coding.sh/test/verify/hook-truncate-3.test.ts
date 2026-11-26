// The hook on truncations of every payload the spool fixtures carry, part 3 of 3 (the fixture files
// are split between hook-truncate-1, -2 and -3.test.ts by size, so each part runs about as long).
// Each payload in test/fixtures/adapters/**/*.spool.jsonl goes to the hook's work
// (src/spool/hook-run.ts runHook, called in-process with a fake stdin and stdout) cut to its first k
// bytes. Over every k, the cuts fall inside strings, numbers and escapes. Few fixture payloads have a
// multi-byte character or run past the 1023 bytes a line holds inline, and not every part has one:
// hook-entry.test.ts pads and cuts payloads for those cases.
//
// For each of those inputs, the call keeps the contract in src/spool/hook.ts as test/verify/_hook.ts
// states it:
// - it resolves and prints nothing (the hook exits 0 and is silent without --reply or --echo-continue);
// - it writes one spool line, which ingest's reader reads back in call order with the payload as the
//   hook got it (the JSON it parses to, else the text), redacted by the rules (the spec runs them on every
//   payload, and reports one they would change that spool/gate.ts lets through as it is);
// - the line holds the payload when it fits in 1023 bytes and the hook got no more than that; otherwise it
//   names a side file under spool/<agent>/raw, and every side file is named by a line;
// - nothing is written outside the spool, and spool/errors.log gets no entry.
//
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset), for a payload of n bytes: at 0, k = 0, 1, n/2, n-1, n,
// 1023, 1024 and every 13th k; at 1 or more, every k from 0 to n; at a bound b of 2 or more, also every
// input with a run of 1 to b - 1 bytes deleted at any offset. A prefix that an earlier payload of the same
// agent and event has too is the same call, and runs once.
// The default run is 2,041 calls; it takes about 3 s. Bound 1 is 22,487 calls and takes about 20 s,
// most of it in each call's file writes.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkTruncations } from "./_hook.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

test("the hook keeps its contract on truncations of the spool fixtures' payloads (part 3 of 3)", async (t) => {
  const { calls, payloads } = await checkTruncations(2, 3, bound);
  t.diagnostic(`${calls} calls over ${payloads} payloads`);
});
