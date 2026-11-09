// The four real-data bugs that started src/conformance (docs/research/round-1-self.md):
// each fixture reproduces what an adapter emitted before the fix (F3: the silent path that
// still runs on an unknown schema), and the checker must catch it under the right rule.
// Rebuild the event fixtures with test/fixtures/conformance/gen.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { opencode } from "../../src/adapters/opencode.ts";
import { checkAdapter, checkEvents } from "../../src/conformance/index.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { PKG_ROOT } from "../adapters/_helpers.ts";
import { moreEnv } from "../adapters/more/_helpers.ts";
import type { TmpEnv } from "../adapters/_helpers.ts";
import { loadDb } from "./_cases.ts";

const DIR = join(PKG_ROOT, "test", "fixtures", "conformance");
const load = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as AgentEvent[];

describe("conformance catches the known real-data bugs", () => {
  it("F1: Claude Code llm.call fragments with one message id collide", () => {
    const r = checkEvents(load("f1-claude-llm-call-fragments.json"));
    assert.deepEqual(r.violations, { "duplicate-id": 1 });
    assert.equal(r.examples[0]!.finding, "F1");
    assert.equal(r.examples[0]!.kind, "llm.call");
    assert.equal(r.counts.duplicateIdsDifferentContent, 1);
  });

  it("F2: a nested subagent linked to the main session points at a tool call that is not there", () => {
    const r = checkEvents(load("f2-claude-nested-subagent-parent.json"));
    assert.deepEqual(r.violations, { "dangling-parent": 2 });
    assert.deepEqual(r.examples.map((v) => v.kind).sort(), ["subagent.end", "subagent.start"]);
    assert.ok(r.examples.every((v) => v.finding === "F2"));
  });

  describe("F3: an OpenCode database in a schema the adapter does not know imports nothing", () => {
    let env: TmpEnv;
    before(() => {
      env = moreEnv();
      loadDb(join(DIR, "f3-opencode-unknown-schema.db.json"), join(env.root, "opencode.db"));
      process.env.OPENCODE_DB = join(env.root, "opencode.db");
      process.env.XDG_DATA_HOME = join(env.root, "empty");
    });
    after(() => env.restore());

    it("the backfill stays silent, and checkAdapter reports empty-backfill", async () => {
      const r = await checkAdapter(opencode);
      assert.equal(r.report.counts.events, 0);
      assert.deepEqual(r.report.violations, { "empty-backfill": 1 });
      assert.equal(r.report.examples[0]!.finding, "F3");
      assert.equal(r.sources?.files, 1);
    });

    it("with --since, a recent file holding only older sessions is still found empty", async () => {
      const r = await checkAdapter(opencode, { since: Date.now() - 86_400_000 });
      assert.deepEqual(r.report.violations, { "empty-backfill": 1 });
    });
  });

  it("F6: a Codex multi-agent child has no task (no user.message, so no title)", () => {
    const r = checkEvents(load("f6-codex-child-without-task.json"));
    assert.deepEqual(r.violations, { "session-without-prompt": 1 });
    assert.equal(r.examples[0]!.finding, "F6");
    assert.equal(r.examples[0]!.sessionId, "0193f6f6-0000-7000-8000-000000000002");
  });

  it("F6: an Antigravity command that exited 1 is recorded as ok", () => {
    const r = checkEvents(load("f6-antigravity-exit-code-ok.json"));
    assert.deepEqual(r.violations, { "exit-code-not-failed": 1 });
    assert.equal(r.examples[0]!.finding, "F6");
  });

  it("the fixed shapes pass: the same events without the bug", () => {
    const f1 = load("f1-claude-llm-call-fragments.json");
    const firstCall = f1.findIndex((e) => e.kind === "llm.call");
    assert.equal(checkEvents(f1.filter((e, i) => e.kind !== "llm.call" || i === firstCall)).ok, true);
    const f6 = load("f6-antigravity-exit-code-ok.json").map((e) => (e.kind === "tool.end" ? { ...e, payload: { ...e.payload, ok: false } } : e));
    assert.equal(checkEvents(f6).ok, true);
  });
});
