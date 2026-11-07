// The MCP harness_compare tool's data: harness A/B experiments listed newest
// first with their arms, and one experiment's report with the ship gate (per
// task group with `by`), the one-item gate scored on exposed tasks, and the
// own-tests split. Seeds a real store: bundles, tasks, runs, and the captured
// sessions of B's runs (Read sum.js on t1 loads the path-scoped rule there only).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext, type Context } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { HarnessBundle } from "../../src/core/types.ts";
import { jobConfig } from "../../src/jobs/config.ts";
import { JobStore } from "../../src/jobs/store.ts";
import { withAudit, type AuditReport } from "../../src/eval/witness.ts";
import { harnessCompareGet, harnessCompareList } from "../../src/mcp/harness.ts";
import { ToolError } from "../../src/mcp/protocol.ts";
import { fixtureBundle, fixtureRun, fixtureTask } from "../../src/store/conformance.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

let w: World;
let ctx: Context;
const T0 = 1_800_000_000_000;

before(async () => {
  w = makeWorld();
  ctx = await openContext({ env: w.env, cwd: w.root });
  const claude = await ctx.blobs.put("Keep changes small.\n");
  const rule = await ctx.blobs.put("---\npaths: sum.js\n---\nsum.js must use +.\n");
  const base: HarnessBundle = fixtureBundle({ id: "b-base", name: "base", files: { "CLAUDE.md": claude } });
  const good: HarnessBundle = fixtureBundle({ id: "b-good", name: "good", files: { "CLAUDE.md": claude, ".claude/rules/sum.md": rule } });
  for (const b of [base, good]) await ctx.index.putBundle(b);
  await ctx.index.putTask(fixtureTask({ id: "t1", name: "sum", tags: ["suite:math"] }));
  await ctx.index.putTask(fixtureTask({ id: "t2", name: "mul", tags: ["suite:core"] }));
  // exp_h1: A fails t1 and solves t2; B (with the rule) solves both. k = 2.
  let n = 0;
  for (const [bundle, task, pass] of [
    [base, "t1", false],
    [base, "t2", true],
    [good, "t1", true],
    [good, "t2", true],
  ] as const) {
    for (const attempt of [1, 2]) {
      const id = `r${++n}`;
      const sessionId = bundle === good ? `s-${id}` : undefined;
      if (sessionId) {
        const cwd = `/runs/${id}/work`;
        const evs: AgentEvent[] = [
          { id: `${id}-0`, v: 0, sessionId, agent: "claude-code", ts: T0 + n * 10, kind: "session.start", payload: {}, cwd },
          { id: `${id}-1`, v: 0, sessionId, agent: "claude-code", ts: T0 + n * 10 + 1, kind: "tool.start", payload: { tool: "Read", toolUseId: "u1", input: { file_path: `${cwd}/${task === "t1" ? "sum" : "mul"}.js` } }, cwd },
        ];
        await ctx.index.putEvents(evs);
        await ctx.index.upsertSession(buildSession(evs));
      }
      await ctx.index.putRun(fixtureRun({ id, experimentId: "exp_h1", taskId: task, bundleId: bundle.id, attempt, pass, verifierExit: pass ? 0 : 1, startedAt: T0 + n * 10, ...(sessionId ? { sessionId } : {}) }));
    }
  }
  // exp_h0: older, no job, so its arm order is unrecorded.
  await ctx.index.putRun(fixtureRun({ id: "r-old1", experimentId: "exp_h0", taskId: "t1", bundleId: base.id, startedAt: T0 - 1000 }));
  await ctx.index.putRun(fixtureRun({ id: "r-old2", experimentId: "exp_h0", taskId: "t1", bundleId: good.id, startedAt: T0 - 900 }));
  // `coding.sh compare base good` names its job "base vs good".
  await JobStore.forEnv(w.env).create({ id: "exp_h1", kind: "compare", name: "base vs good", config: jobConfig({}), total: 8, concurrency: 1 });
});

after(async () => {
  await ctx?.close();
  cleanup();
});

describe("harness_compare", () => {
  it("lists harness A/B experiments newest first, arms in recorded order", async () => {
    const l = (await harnessCompareList(ctx, w.env, 0, 10)) as { experiments: { id: string; baseline?: string; candidate?: string; arms: { bundle: string; runs: number; passes: number }[]; tasks: number }[]; nextCursor?: string };
    assert.deepEqual(l.experiments.map((e) => e.id), ["exp_h1", "exp_h0"]);
    const [h1, h0] = l.experiments;
    assert.equal(h1!.baseline, "base");
    assert.equal(h1!.candidate, "good");
    assert.deepEqual(h1!.arms.map((a) => [a.bundle, a.runs, a.passes]), [["base", 4, 2], ["good", 4, 4]]);
    assert.equal(h1!.tasks, 2);
    assert.equal(h0!.baseline, undefined, "no job: order unknown");
    const p1 = (await harnessCompareList(ctx, w.env, 0, 1)) as { experiments: unknown[]; nextCursor?: string };
    assert.equal(p1.experiments.length, 1);
    assert.equal(p1.nextCursor, "1");
  });

  it("returns the report with the ship gate, the one-item gate and the own-tests split", async () => {
    const r = (await harnessCompareGet(ctx, w.env, "exp_h1", { limit: 10 })) as Record<string, any>;
    assert.equal(r.baseline.bundle, "base");
    assert.equal(r.candidate.passes, 4);
    assert.equal(r.pairedTasks, 2);
    assert.equal(r.diff.mean, 0.5);
    assert.ok(["ship", "hold", "dont-ship"].includes(r.gate.verdict));
    assert.match(r.gate.summary, /^(Ship it|Hold|Don't ship)/);
    // B adds a path-scoped rule; it reached B's context on t1 only (Read sum.js).
    assert.equal(r.itemGate.mode, "add");
    assert.deepEqual(r.itemGate.item, { path: ".claude/rules/sum.md", kind: "rule", tier: "path" });
    assert.deepEqual(r.itemGate.exposedTasks, ["t1"]);
    assert.deepEqual([r.itemGate.fired, r.itemGate.rollouts], [2, 4]);
    assert.equal(r.itemGate.verdict, "KEEP");
    assert.match(r.itemGate.summary, /^item gate k=2 τ=\.34 m=2: KEEP · G=1\.00 net \+2 runs/);
    assert.deepEqual(r.changes, { added: [".claude/rules/sum.md"], removed: [], changed: [] });
    assert.equal(r.ownTests.baseline.fails, 2);
    assert.equal(r.ownTests.candidate.fails, 0);
    assert.ok(Array.isArray(r.warnings));
  });

  it("gates each task group with by, and names prefixes the tasks have when none match", async () => {
    const r = (await harnessCompareGet(ctx, w.env, "exp_h1", { by: "suite:", limit: 10 })) as Record<string, any>;
    assert.deepEqual(r.gate.strata.map((s: { group: string; tasks: number }) => [s.group, s.tasks]), [["suite:core", 1], ["suite:math", 1]]);
    await assert.rejects(harnessCompareGet(ctx, w.env, "exp_h1", { by: "lang:", limit: 10 }), (e: Error) => e instanceof ToolError && /by lang:: no task has a tag starting with it; prefixes seen: suite:/.test(e.message));
  });

  it("takes baseline when the order is unrecorded, flips arms with it, and names what is wrong", async () => {
    await assert.rejects(harnessCompareGet(ctx, w.env, "exp_h0", { limit: 10 }), (e: Error) => e instanceof ToolError && /doesn't record which arm is A: pass baseline, (base or good|good or base)/.test(e.message));
    const flipped = (await harnessCompareGet(ctx, w.env, "exp_h1", { baseline: "good", limit: 10 })) as Record<string, any>;
    assert.equal(flipped.baseline.bundle, "good");
    assert.equal(flipped.itemGate.mode, "remove");
    await assert.rejects(harnessCompareGet(ctx, w.env, "exp_h1", { baseline: "nope", limit: 10 }), /neither arm of exp_h1: /);
    await assert.rejects(harnessCompareGet(ctx, w.env, "exp_missing", { limit: 10 }), /No harness A\/B experiment "exp_missing"/);
  });

  it("links each tampered pass to the tool call that changed the test, split disclosed/stealth", async () => {
    // exp_h2 (seeded here, after the listing test): B passes t1 twice by editing the test file; once it says so.
    const flag = { flagged: true, flags: [{ kind: "edit" as const, path: "test/sum.test.js", why: "test-glob" as const }] };
    for (const [id, bundleId, pass, say] of [
      ["h2a1", "b-base", false, undefined],
      ["h2a2", "b-base", false, undefined],
      ["h2b1", "b-good", true, "The test expecting 5 is wrong; update the expected value."],
      ["h2b2", "b-good", true, "Refactor helpers."],
    ] as const) {
      const sessionId = say ? `s-${id}` : undefined;
      if (sessionId) {
        const cwd = `/runs/${id}/work`;
        const at = (i: number) => T0 + 5000 + i;
        const e = (i: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id: `${id}-${i}`, v: 0, sessionId, agent: "claude-code", ts: at(i), kind, payload, cwd });
        const evs = [
          e(0, "session.start", {}),
          e(1, "test.result", { passed: 0, failed: 1 }),
          e(2, "assistant.message", { text: say }),
          e(3, "tool.start", { tool: "Edit", toolUseId: "u1", input: { file_path: `${cwd}/test/sum.test.js` } }),
          e(4, "file.change", { path: `${cwd}/test/sum.test.js`, op: "modify", toolUseId: "u1", diff: "-  assert.equal(sum(2, 3), 5);\n+  assert.equal(sum(2, 3), 6);" }),
          e(5, "tool.end", { tool: "Edit", toolUseId: "u1", ok: true }),
          e(6, "test.result", { passed: 1, failed: 0 }),
        ];
        await ctx.index.putEvents(evs);
        await ctx.index.upsertSession(buildSession(evs));
      }
      await ctx.index.putRun(fixtureRun({ id, experimentId: "exp_h2", taskId: "t1", bundleId, attempt: id.endsWith("1") ? 1 : 2, pass, verifierExit: pass ? 0 : 1, startedAt: T0 + 5000, ...(pass ? { tamper: flag } : {}), ...(sessionId ? { sessionId } : {}) }));
    }
    const r = (await harnessCompareGet(ctx, w.env, "exp_h2", { baseline: "base", limit: 10 })) as Record<string, any>;
    assert.deepEqual(r.tamper.baseline, { runs: 0, passes: 0 });
    assert.deepEqual(r.tamper.candidate, { runs: 2, passes: 2, disclosed: 1, stealth: 1 });
    const byRun = Object.fromEntries(r.tamper.passes.map((p: { run: string }) => [p.run, p]));
    assert.deepEqual(byRun.h2b1, { run: "h2b1", arm: "candidate", task: "t1", disclosure: "disclosed", change: "edit test/sum.test.js", tool: "Edit", eventId: "h2b1-4", intent: "The test expecting 5 is wrong; update the expected value." });
    assert.equal(byRun.h2b2.disclosure, "stealth");
    assert.equal(byRun.h2b2.intent, "Refactor helpers.");
    const h1 = (await harnessCompareGet(ctx, w.env, "exp_h1", { limit: 10 })) as Record<string, any>;
    assert.equal("tamper" in h1, false, "no tampered run, no tamper field");
  });

  it("adds each audited arm's refuted passes and audited pass rate from the task's witness audit (AA-13)", async () => {
    const plain = (await harnessCompareGet(ctx, w.env, "exp_h1", { limit: 10 })) as Record<string, any>;
    assert.equal("auditedPassRate" in plain.candidate, false, "no audit, no audit fields");
    const t2 = await ctx.index.getTask("t2");
    const report: AuditReport = {
      taskId: "t2",
      experimentId: "exp_h1",
      method: "manual",
      witnesses: ["w1"],
      runs: [
        { runId: "r3", bundleId: "b-base", status: "clean" },
        { runId: "r4", bundleId: "b-base", status: "clean" },
        { runId: "r7", bundleId: "b-good", status: "refuted", witnessId: "w1", refutedBy: ["w1"], countsAsRefuted: true },
        { runId: "r8", bundleId: "b-good", status: "clean" },
      ],
      ambiguous: [],
      ts: T0,
    };
    await ctx.index.putTask(withAudit(t2!, "exp_h1", report));
    try {
      const r = (await harnessCompareGet(ctx, w.env, "exp_h1", { limit: 10 })) as Record<string, any>;
      assert.deepEqual([r.baseline.refuted, r.baseline.audited, r.baseline.auditedPassRate], [0, 2, 0.5]);
      assert.deepEqual([r.candidate.passes, r.candidate.refuted, r.candidate.audited, r.candidate.auditedPassRate], [4, 1, 2, 0.75]);
    } finally {
      await ctx.index.putTask(t2!);
    }
  });
});
