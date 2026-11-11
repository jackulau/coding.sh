// An empty result names the next step: on a store with no sessions, how the first one gets here; on a
// store with sessions, how to widen the window.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as cache from "../../src/cli/commands/cache.ts";
import * as search from "../../src/cli/commands/search.ts";
import * as usage from "../../src/cli/commands/usage.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

let empty: Sandbox;
let busy: Sandbox;
before(async () => {
  empty = sandbox();
  busy = sandbox();
  await empty.seed([]);
  await busy.seed([mkSession("9b8a7c6d-aaaa-4bbb-8ccc-123456789012", Date.now() - 400 * 86_400_000)]);
});
after(() => {
  empty.cleanup();
  busy.cleanup();
});

describe("empty store", () => {
  for (const [name, mod, flags, pos] of [["usage", usage, { since: "7d" }, []], ["search", search, {}, ["anything"]], ["cache doctor", cache, { since: "7d" }, []]] as const) {
    test(`${name} says how the first session gets here`, async () => {
      const r = await runCmd(mod as never, empty, { action: name === "cache doctor" ? "doctor" : undefined, flags: flags as never, positionals: pos as never });
      assert.equal(r.error, undefined, String(r.error?.message));
      assert.match(r.stderr, /coding\.sh init/);
    });
  }
});

describe("a store with older sessions", () => {
  test("usage and cache doctor offer a wider window", async () => {
    for (const [mod, action, cmd] of [[usage, undefined, "coding.sh usage --since 90d"], [cache, "doctor", "coding.sh cache doctor --since 90d"]] as const) {
      const r = await runCmd(mod as never, busy, { action, flags: { since: "7d" } });
      assert.match(r.stderr, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
  test("usage says SESSIONS counts subagents", async () => {
    const r = await runCmd(usage as never, busy, { flags: { since: "900d" } });
    assert.match(r.stderr + r.stdout, /SESSIONS and TOKENS count subagents/);
  });
});
