import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MORE_ADAPTERS } from "../../../src/adapters/more/index.ts";
import type { TmpEnv } from "../_helpers.ts";
import { moreEnv, testCtx } from "./_helpers.ts";

describe("MORE_ADAPTERS", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.PATH = "/nonexistent";
  });
  after(() => env.restore());

  it("has unique ids and the expected agents", () => {
    const ids = MORE_ADAPTERS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ["gemini-cli", "antigravity", "copilot-cli", "amp", "pi", "droid", "goose", "aider", "wrapper"]) assert.ok(ids.includes(id), id);
  });

  for (const a of MORE_ADAPTERS) {
    it(`${a.id}: detect, harnessFiles and backfill work on an empty home`, async () => {
      const d = await a.detect();
      assert.equal(typeof d.installed, "boolean");
      assert.equal(d.hooked, false);
      const h = a.harnessFiles?.();
      if (h) for (const p of [...h.project, ...h.user]) assert.equal(typeof p, "string");
      if (h) for (const p of h.user) assert.ok(p.startsWith("~/"), `${p} is user-level`);
      if (a.backfill) for await (const _ of a.backfill(testCtx().ctx)) assert.fail("nothing to backfill");
      assert.deepEqual(await a.normalize({ v: 0, agent: a.id, event: "SomethingNew", ts: 1, pid: 1, cwd: "/w", raw: "not an object" }, testCtx().ctx).then((e) => e.every((x) => x.v === 0)), true);
    });
  }
});
