// `show` prints how often and how long a session waited on the person (stats.waits), and on
// what, in one header row; a session that never waited prints none.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import * as show from "../../src/cli/commands/show.ts";
import { duration } from "../../src/cli/output.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import { normalizeFixture } from "../adapters/more/_helpers.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const waits = (id: string, w: NonNullable<Session["stats"]["waits"]>) => mkSession(id, T0, { stats: { waits: w } });

let sb: Sandbox;
let gemini: Session;
before(async () => {
  sb = sandbox();
  // The Gemini CLI hook capture ends on a ToolPermission prompt nobody answered.
  const events = await normalizeFixture(geminiCliAdapter, "gemini-cli/hooks.spool.jsonl");
  gemini = buildSession(events);
  await sb.seed([
    waits("waited", {
      count: 4,
      ms: 23 * MIN,
      medianMs: 4 * MIN,
      byKind: { question: { count: 1, ms: 5 * MIN }, turn: { count: 3, ms: 18 * MIN, medianMs: 4 * MIN, open: 1 } },
      open: { count: 1, ms: 10 * MIN },
      agent: { count: 2, ms: 3 * MIN },
      steers: 2,
      capped: 1,
    }),
    waits("steered", { count: 0, ms: 0, byKind: {}, steers: 1 }),
    mkSession("never", T0),
    gemini,
  ], events);
});
after(() => sb.cleanup());

const row = async (id: string) => (await runCmd(show, sb, { positionals: [id] })).stdout.split("\n").filter((l) => l.startsWith("  Waited on you"));

test("the row counts the waits, their time, the median wait and their kinds, then what is still unanswered, capped and the steers", async () => {
  assert.deepEqual(await row("waited"), ["  Waited on you 4 times, 23m00s, median 4m00s (1 question, 3 turns); 1 unanswered; 1 capped at 12h; 2 steers"]);
});

test("a session the person only steered says so", async () => {
  assert.deepEqual(await row("steered"), ["  Waited on you 0 times; 1 steer"]);
});

test("a session that never waited on the person has no row", async () => {
  assert.deepEqual(await row("never"), []);
});

test("a recorded capture: the Gemini CLI session ends on a permission prompt nobody answered", async () => {
  const w = gemini.stats.waits!;
  assert.equal(w.count, 1);
  assert.deepEqual(await row(gemini.id), [`  Waited on you 1 time, ${duration(w.ms)} (1 permission prompt); 1 unanswered`]);
});

test("show --json carries stats.waits as stored, and none for a session that never waited", async () => {
  const r = await runCmd(show, sb, { positionals: ["waited"], json: true });
  assert.equal(r.json.session.stats.waits.count, 4);
  assert.deepEqual(r.json.session.stats.waits.agent, { count: 2, ms: 3 * MIN });
  const none = await runCmd(show, sb, { positionals: ["never"], json: true });
  assert.equal(none.json.session.stats.waits, undefined);
});
