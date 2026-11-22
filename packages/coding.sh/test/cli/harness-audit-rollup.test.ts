// harness audit counts top-level sessions and folds each subagent's or delegate's loads, reads
// and writes into the session that started it. With subagents in the window the header says so,
// so a row's WROTE from a delegate is not read as a session the count left out.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, session } from "../query/_seed.ts";

const at = Date.now() - 86_400_000;

const NOTE = /A subagent's or delegate's loads, reads and writes count on the top-level session that started it/;

for (const withDelegate of [true, false]) {
  describe(`harness audit ${withDelegate ? "with" : "without"} a delegate`, () => {
    let env: TmpEnv;
    before(async () => {
      env = tmpEnv();
      const root = session("root", { agent: "t3code", cwd: "/work/demo", startedAt: at, endedAt: at + 60_000 });
      const delegate = session("delegate", { agent: "t3code", cwd: "/work/demo", startedAt: at + 1000, endedAt: at + 30_000, parent: { sessionId: "root", type: "subagent" } });
      await seed(env.dataHome, { sessions: withDelegate ? [root, delegate] : [root] });
    });
    after(() => env.restore());

    test(withDelegate ? "the header says the delegate counts with its root" : "no rollup note", () => {
      const r = ok(["harness", "audit", "--since", "7d"]);
      assert.match(r.stderr, /1 session since 7d/);
      if (withDelegate) assert.match(r.stderr, NOTE);
      else assert.doesNotMatch(r.stderr, NOTE);
    });
  });
}
