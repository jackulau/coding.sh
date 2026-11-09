// Every adapter fixture through the conformance checker: each backfill home
// through checkAdapter (as `doctor --conformance` runs it), and each hook or
// plugin spool through checkEvents. Fixtures recorded from real agent
// binaries must be clean. Known exceptions are listed with the reason; a
// TODO names the finding when the exception is a real fidelity gap.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { checkAdapter, checkEvents, score, type AdapterReport, type ConformanceReport } from "../../src/conformance/index.ts";
import { SOURCES } from "../../src/conformance/sources.ts";
import { moreEnv } from "../adapters/more/_helpers.ts";
import { BACKFILL_CASES, normalizeSpool, SPOOL_CASES } from "./_cases.ts";

/** Violations a fixture is known to produce, by rule. Anything not listed must be zero. */
const KNOWN: Record<string, { violations: Record<string, number>; why: string }> = {
  // TODO(F6): a Codex multi-agent child gets its task as inter-agent mail, which fires no
  // UserPromptSubmit hook and which the rollout keeps encrypted: the child has no prompt.
  "codex/hooks.spool.jsonl": { violations: { "session-without-prompt": 1 }, why: "F6: the Codex child thread has no prompt" },
  // An excerpt of tool hooks only: no prompt line, and the code-mode cell's own tool.start
  // comes from the rollout (backfill), so its nested calls' parent is not in the hook data.
  "codex/code-mode/hooks.spool.jsonl": { violations: { "session-without-prompt": 1, "dangling-parent": 7 }, why: "hook excerpt; the cell is only in the rollout" },
  // Hand-written excerpts that leave out lines (PreToolUse, the prompt) on purpose.
  "opencode/v2.spool.jsonl": { violations: { "tool-end-without-start": 1, "session-without-prompt": 2 }, why: "hand-written excerpt without prompt and start lines" },
  "droid/hooks.spool.jsonl": { violations: { "tool-end-without-start": 3 }, why: "hand-written excerpt without PreToolUse lines" },
  "goose/hooks.spool.jsonl": { violations: { "tool-end-without-start": 1 }, why: "hand-written excerpt without a PreToolUse line" },
  "pi/extension.spool.jsonl": { violations: { "tool-end-without-start": 1 }, why: "hand-written excerpt without a tool_execution_start line" },
  // TODO(F6): `droid exec` fires no UserPromptSubmit hook, so a session captured by hooks alone
  // has no prompt (and no title) until a backfill reads the transcript.
  "droid/real/hooks.spool.jsonl": { violations: { "session-without-prompt": 1 }, why: "F6: droid exec sends no prompt hook" },
};

function assertExpected(name: string, real: boolean, r: ConformanceReport): void {
  const known = KNOWN[name];
  const msg = `${name}: ${JSON.stringify(r.examples)}`;
  if (known) assert.deepEqual(r.violations, known.violations, msg);
  else assert.deepEqual(r.violations, {}, msg);
  if (real && known) assert.match(known.why, /^F\d/, `${name} is a real capture: only a named finding may excuse it`);
}

describe("conformance over every adapter fixture", () => {
  describe("backfill homes (checkAdapter)", () => {
    const reports: AdapterReport[] = [];
    for (const c of BACKFILL_CASES) {
      it(`${c.name}${c.real ? " (real)" : ""}`, async () => {
        const env = moreEnv();
        try {
          c.setup(env.root);
          const r = await checkAdapter(c.adapter, { maxExamples: 10 });
          reports.push(r);
          assert.equal(r.adapter, c.adapter.id);
          assert.ok(r.report.counts.events > 0, `${c.name} yields events`);
          assert.ok((r.sources?.files ?? 0) > 0, `${c.name}: the source table finds the files the backfill read`);
          assert.equal(r.truncated, undefined);
          assertExpected(c.name, c.real, r.report);
          assert.equal(r.violations, 0);
        } finally {
          env.restore();
        }
      });
    }
    it("score is 1 over the fixture homes", () => {
      assert.equal(reports.length, BACKFILL_CASES.length);
      assert.equal(score(reports), 1);
    });
  });

  describe("hook and plugin spools (checkEvents)", () => {
    for (const c of SPOOL_CASES) {
      it(`${c.rel}${c.real ? " (real)" : ""}`, async () => {
        const env = moreEnv();
        try {
          c.setup?.();
          const events = await normalizeSpool(c.rel);
          assert.ok(events.length > 0);
          assertExpected(c.rel, c.real, checkEvents(events, { maxExamples: 10 }));
        } finally {
          env.restore();
        }
      });
    }
  });

  it("covers every adapter that has a backfill, and the source table knows each one", () => {
    const withBackfill = ADAPTERS.filter((a) => a.backfill).map((a) => a.id);
    for (const id of withBackfill) assert.ok(SOURCES[id], `src/conformance/sources.ts has no entry for ${id}`);
    const covered = new Set(BACKFILL_CASES.map((c) => c.adapter.id));
    // T3 Code's fixtures are SQLite stores built inside test/adapters/t3code.test.ts.
    const missing = withBackfill.filter((id) => !covered.has(id) && id !== "t3code");
    assert.deepEqual(missing, []);
  });

  it("every real fixture is clean or excused by a named finding", () => {
    const real = [...BACKFILL_CASES.filter((c) => c.real).map((c) => c.name), ...SPOOL_CASES.filter((c) => c.real).map((c) => c.rel)];
    assert.ok(real.length >= 13);
    const excused = real.filter((n) => KNOWN[n]);
    assert.deepEqual(excused, ["droid/real/hooks.spool.jsonl"]);
  });
});
