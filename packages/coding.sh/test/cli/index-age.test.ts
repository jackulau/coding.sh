// How old the index is (core/ingest-health.ts, ingest-last.json): `status` says it, and `work`
// judges waits and stalls as of the last ingest while it is old, so an ingest that stopped does not
// read as a fleet of stalled agents.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as status from "../../src/cli/commands/status.ts";
import * as work from "../../src/cli/commands/work.ts";
import { recordLastIngest } from "../../src/core/ingest-health.ts";
import { workItemId } from "../../src/core/work.ts";
import type { Session } from "../../src/core/types.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const MIN = 60e3;
const HOUR = 60 * MIN;

/** A session with no end recorded whose last activity was `lastAt`. */
const open = (id: string, lastAt: number): Session => mkSession(id, lastAt - 10 * MIN, { endedAt: undefined, cwd: "/work/demo", title: `edit ${id}`, stats: { latency: { wallMs: 10 * MIN } } as Partial<Session["stats"]> });

describe("an index whose last ingest finished 3h ago", () => {
  let sb: Sandbox;
  const lastIngest = Date.now() - 3 * HOUR;
  before(async () => {
    sb = sandbox();
    // Active 5 minutes before the last ingest: running as of then, stalled by the clock.
    await sb.seed([open("busy", lastIngest - 5 * MIN)]);
    recordLastIngest(sb.env.CODING_SH_HOME!, "0.0.0", lastIngest);
  });
  after(() => sb.cleanup());

  test("work prints the header and does not call the agent stalled", async () => {
    const r = await runCmd(work, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /index updated 3h ago: waits and stalls are as of then; run coding\.sh ingest/);
    assert.doesNotMatch(r.stdout, /Stalled/);
    const j = await runCmd(work, sb, { json: true, flags: { all: true } });
    assert.equal(j.json.counts.stalled, 0);
    assert.equal(j.json.indexUpdatedAt, new Date(lastIngest).toISOString());
    assert.equal(j.json.asOf, new Date(lastIngest).toISOString());
    const [item] = j.json.items;
    assert.equal(item.id, workItemId("busy"));
    assert.equal(item.running, true);
  });

  test("work show judges the item as of the last ingest too", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: ["busy"], json: true });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.equal(r.json.bucket, undefined);
    assert.equal(r.json.asOf, new Date(lastIngest).toISOString());
  });

  test("status gives the age in the warn style and index.updatedAt in --json", async () => {
    const r = await runCmd(status, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /! Index +updated 3h ago; run (?:coding\.sh|codingsh) ingest/);
    assert.match(r.stdout, /Work +nothing needs you/i);
    const j = await runCmd(status, sb, { json: true });
    assert.deepEqual(j.json.index, { updatedAt: new Date(lastIngest).toISOString(), stale: true });
    assert.equal(j.json.work.stalled, 0);
  });
});

describe("a fresh record or none changes nothing", () => {
  let sb: Sandbox;
  const now = Date.now();
  before(async () => {
    sb = sandbox();
    await sb.seed([open("quiet", now - 3 * HOUR)]);
  });
  after(() => sb.cleanup());

  test("with no record work calls a session quiet for 3h stalled, and status has no index", async () => {
    const r = await runCmd(work, sb, { json: true });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.equal(r.json.counts.stalled, 1);
    assert.equal(r.json.indexUpdatedAt, undefined);
    assert.equal(r.json.asOf, undefined);
    const s = await runCmd(status, sb, { json: true });
    assert.equal(s.json.index, undefined);
    assert.doesNotMatch((await runCmd(status, sb, {})).stdout, /Index/);
  });

  test("with a record a minute old the same session is stalled, with no header", async () => {
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    recordLastIngest(sb.env.CODING_SH_HOME!, "0.0.0", Date.now() - MIN);
    const r = await runCmd(work, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.doesNotMatch(r.stdout, /index updated/);
    assert.match(r.stdout, /Stalled/);
    const j = await runCmd(work, sb, { json: true });
    assert.equal(j.json.counts.stalled, 1);
    assert.equal(j.json.asOf, undefined);
    const st = await runCmd(status, sb, {});
    assert.match(st.stdout, /^ +Index +updated 1m ago$/m);
    assert.equal((await runCmd(status, sb, { json: true })).json.index.stale, undefined);
  });
});

test("a store named by CODING_SH_STORE_URL is not judged by this home's record", async () => {
  const sb = sandbox();
  try {
    await sb.seed([open("remote", Date.now() - 3 * HOUR)]);
    recordLastIngest(sb.env.CODING_SH_HOME!, "0.0.0", Date.now() - 4 * HOUR);
    sb.env.CODING_SH_STORE_URL = `sqlite://${join(sb.env.CODING_SH_HOME!, "index.db")}`;
    const j = await runCmd(work, sb, { json: true });
    assert.equal(j.error, undefined, j.error?.stack);
    assert.equal(j.json.asOf, undefined);
    assert.equal(j.json.counts.stalled, 1);
  } finally {
    sb.cleanup();
  }
});
