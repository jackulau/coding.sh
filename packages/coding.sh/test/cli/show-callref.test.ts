// `show <session>#<n>` says what is wrong with the call number instead of "can't find session".
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

let sb: Sandbox;
before(async () => {
  sb = sandbox();
  await sb.seed([mkSession("0f3a9c1e-aaaa-4bbb-8ccc-123456789012", Date.now() - 1000)]);
});
after(() => sb.cleanup());

test("latest#-1 on a session with no model calls names the session and the count", async () => {
  const r = await runCmd(show, sb, { positionals: ["latest#-1"] });
  assert.match(r.error?.message, /Session 0f3a9c1e-aaaa-4bbb-8ccc-123456789012 has 0 model calls; no #-1/);
});

test("an id with a call number past the end gives the count", async () => {
  const r = await runCmd(show, sb, { positionals: ["0f3a9c1e#999"] });
  assert.match(r.error?.message, /has 0 model calls; no #999/);
});

test("a session that does not exist is still not found", async () => {
  const r = await runCmd(show, sb, { positionals: ["ffffffff#1"] });
  assert.equal(r.error?.reason, "not_found");
  assert.match(r.error?.message, /Can't find session/);
});
