// An empty result names the next step: on a store with no sessions, how the first one gets here; on a
// store with sessions, how to widen the window.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as cache from "../../src/cli/commands/cache.ts";
import * as evalCmd from "../../src/cli/commands/eval.ts";
import * as search from "../../src/cli/commands/search.ts";
import * as usage from "../../src/cli/commands/usage.ts";
import * as work from "../../src/cli/commands/work.ts";
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
      // The sandbox sets no MSYSTEM or SHELL: on Windows that is PowerShell or cmd, which run codingsh.
      assert.match(r.stderr, process.platform === "win32" ? /codingsh init/ : /coding\.sh init/);
    });
  }
  test("eval candidates says how the first session gets here, not to look further back", async () => {
    const r = await runCmd(evalCmd, empty, { action: "candidates", flags: { since: "7d" } });
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.match(r.stderr, /(?:coding[.]sh|codingsh) init$/m);
    assert.doesNotMatch(r.stderr, /further back/);
  });
  test("work says how the first session gets here, not to widen the window", async () => {
    const r = await runCmd(work, empty, {});
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.match(r.stdout, /^No agent sessions since 7d[.]$/m);
    assert.match(r.stderr, /(?:coding[.]sh|codingsh) init$/m);
    assert.doesNotMatch(r.stderr, /Widen/);
  });
});

describe("a store with older sessions", () => {
  test("usage and cache doctor offer a wider window", async () => {
    for (const [mod, action, cmd] of [[usage, undefined, "usage --since 90d"], [cache, "doctor", "cache doctor --since 90d"]] as const) {
      const r = await runCmd(mod as never, busy, { action, flags: { since: "7d" } });
      // In PowerShell and cmd the step names `codingsh`.
      assert.match(r.stderr, new RegExp(`(?:coding\\.sh|codingsh) ${cmd}`));
    }
  });
  test("eval candidates names the window and place it searched, and looks further back in the same place", async () => {
    const ran = (flags: Record<string, string | boolean>) => runCmd(evalCmd, busy, { action: "candidates", flags });
    // A window in hours, as typed: not rounded to a number of days.
    let r = await ran({ since: "12h" });
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.match(r.stderr, /^ +No sessions in the last 12h in this repo$/m);
    assert.match(r.stderr, /^ +Look further back, or in every repo:$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) eval candidates --since 90d --repo all$/m);
    // Already 100 days, in every repo, flagged only: twice as far back, with the same --repo and --flagged.
    r = await ran({ since: "100d", repo: "all", flagged: true });
    assert.match(r.stderr, /^ +No flagged sessions in the last 100d$/m);
    assert.match(r.stderr, /^ +Look further back:$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) eval candidates --since 200d --repo all --flagged$/m);
    // Another repo: the step looks there, not in this one.
    r = await ran({ repo: "../other" });
    assert.match(r.stderr, /^ +No sessions in the last 14 days in [.][.][/]other$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) eval candidates --since 90d --repo [.][.][/]other$/m);
  });
  test("work widens a window it has already searched, and keeps --repo and --agent", async () => {
    const ran = (flags: Record<string, string>) => runCmd(work, busy, { flags });
    let r = await ran({});
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.match(r.stdout, /^No agent sessions since 7d[.]$/m);
    assert.match(r.stderr, /^ +Widen the window:$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) work --since 30d$/m);
    // Already 30 days: the step goes further back, not to the same window.
    r = await ran({ since: "30d" });
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) work --since 90d$/m);
    // With filters: the message names them, and the step keeps them.
    r = await ran({ since: "100d", repo: "../other", agent: "claude-code" });
    assert.match(r.stdout, /^No work items from claude-code in .+other since 100d[.]$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) work --since 200d --repo [.][.][/]other --agent claude-code$/m);
    // An agent with no session at all: the step drops --agent and keeps the rest, as a wider window would find nothing.
    r = await ran({ since: "30d", repo: "../other", agent: "codex" });
    assert.match(r.stdout, /^No sessions from codex in the store[.]$/m);
    assert.match(r.stderr, /^ +See every agent's items:$/m);
    assert.match(r.stderr, /^ +(?:coding[.]sh|codingsh) work --since 30d --repo [.][.][/]other$/m);
  });
  test("usage says SESSIONS counts subagents", async () => {
    const r = await runCmd(usage as never, busy, { flags: { since: "900d" } });
    assert.match(r.stderr + r.stdout, /SESSIONS and TOKENS count subagents/);
  });
});
