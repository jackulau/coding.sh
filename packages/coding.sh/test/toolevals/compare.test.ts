// §15.6: compareToolArms verdicts, CIs and the regressions list.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mulberry32 } from "../../src/stats/prng.ts";
import { pairedPermutation } from "../../src/stats/tests.ts";
import { compareToolArms, summarizeArms } from "../../src/toolevals/compare.ts";
import { formatToolCompare } from "../../src/toolevals/report.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { SurfaceReport, TrialResult } from "../../src/toolevals/types.ts";
import { trial } from "./helpers.ts";

const D = "model:anthropic/fake";

function arms(nTasks: number, k: number, pBase: number, pCand: number, seed: number): TrialResult[] {
  const rand = mulberry32(seed);
  const out: TrialResult[] = [];
  for (let t = 0; t < nTasks; t++) {
    for (let a = 1; a <= k; a++) {
      out.push(trial(`task${t}`, "base", D, a, rand() < pBase));
      out.push(trial(`task${t}`, "terse", D, a, rand() < pCand));
    }
  }
  return out;
}

describe("compareToolArms", () => {
  it("identical arms → no-difference", () => {
    const base = arms(20, 3, 0.6, 0.6, 7).filter((t) => t.variant === "base");
    const copy = base.map((t) => ({ ...t, id: `${t.id}c`, variant: "copy" }));
    const r = compareToolArms([...base, ...copy], { baseline: `base@${D}`, candidate: `copy@${D}` });
    assert.equal(r.verdict.kind, "no-difference");
    assert.equal(r.diff.mean, 0);
    assert.equal(r.pairedTasks, 20);
    assert.equal(r.k, 3);
    assert.equal(r.comparing, "variant");
    assert.equal(r.regressions.length, 0);
    assert.equal(r.metrics.turns?.verdict, "no-difference");
  });

  it("a seeded 30-point success gap over 20 tasks with k=3 → better, CI excluding 0", () => {
    const r = compareToolArms(arms(20, 3, 0.5, 0.8, 42), { baseline: `base@${D}`, candidate: `terse@${D}`, seed: 1 });
    assert.equal(r.verdict.kind, "better", r.verdict.text);
    assert.ok(r.diff.lo > 0, `CI [${r.diff.lo}, ${r.diff.hi}]`);
    assert.ok(r.diff.mean > 0.15 && r.diff.mean < 0.45, String(r.diff.mean));
    assert.equal(r.mcnemar.n, r.mcnemar.b + r.mcnemar.c);
    assert.ok(r.mcnemar.p < 0.05);
    // AA-22: the permutation p comes from the same per-task diffs as the bootstrap.
    assert.deepEqual(r.permutation, { p: pairedPermutation(r.tasks.map((t) => t.diff), { seed: 1 }).p, method: "exact" });
    assert.ok(r.permutation.p < 0.05);
  });

  it("lists a pass → fail regression at k=1 with session links and first divergence", () => {
    const a = trial("t1", "base", D, 1, true);
    const b = trial("t1", "terse", D, 1, false);
    a.sessionId = "sa";
    b.sessionId = "sb";
    const other = [trial("t2", "base", D, 1, true), trial("t2", "terse", D, 1, true)];
    const mk = (sid: string, tool: string): AgentEvent[] => [{ id: `${sid}1`, v: 0, sessionId: sid, ts: 1, agent: "coding.sh-model", kind: "tool.start", payload: { tool, toolUseId: "x", input: {} } } as AgentEvent];
    const events = new Map([
      [a.id, mk("sa", "shell")],
      [b.id, mk("sb", "http_request")],
    ]);
    const r = compareToolArms([a, b, ...other], { baseline: `base@${D}`, candidate: `terse@${D}`, events });
    const reg = r.regressions.filter((x) => x.kind === "success");
    assert.equal(reg.length, 1);
    assert.equal(reg[0]!.taskId, "t1");
    assert.equal(reg[0]!.detail, "pass → fail");
    assert.deepEqual(reg[0]!.baselineTrials, [{ id: a.id, sessionId: "sa" }]);
    assert.deepEqual(reg[0]!.candidateTrials, [{ id: b.id, sessionId: "sb" }]);
    assert.equal(reg[0]!.firstDivergence?.index, 0);
  });

  it("with k ≥ 2 flags tasks that lose ≥ ⌈k/2⌉ passes", () => {
    const ts = [
      ...[1, 2, 3].map((a) => trial("x", "base", D, a, true)),
      ...[1, 2, 3].map((a) => trial("x", "terse", D, a, a === 1)),
      ...[1, 2, 3].map((a) => trial("y", "base", D, a, true)),
      ...[1, 2, 3].map((a) => trial("y", "terse", D, a, a !== 3)),
    ];
    const r = compareToolArms(ts, { baseline: `base@${D}`, candidate: `terse@${D}` });
    assert.deepEqual(
      r.regressions.filter((x) => x.kind === "success").map((x) => x.taskId),
      ["x"],
    );
  });

  it("flags metric regressions when the CI excludes 0 in the bad direction", () => {
    const ts: TrialResult[] = [];
    for (let t = 0; t < 15; t++) {
      for (let a = 1; a <= 2; a++) {
        ts.push(trial(`t${t}`, "base", D, a, true, { turns: 4 + (t % 3) }));
        ts.push(trial(`t${t}`, "terse", D, a, true, { turns: 9 + (t % 3) }));
      }
    }
    const r = compareToolArms(ts, { baseline: `base@${D}`, candidate: `terse@${D}` });
    assert.equal(r.metrics.turns?.verdict, "worse");
    assert.ok(r.metrics.turns!.diff.lo > 0);
    const m = r.regressions.find((x) => x.kind === "metric" && x.metric === "turns");
    assert.ok(m, "turns regression listed");
    assert.ok(r.metrics.turns!.p < 0.001);
    assert.match(m.detail, /perm p < 0\.001\)/);
  });

  it("+2 turns on 3 tasks is not a regression: the CI is a point, the exact permutation p is 1/4", () => {
    const ts: TrialResult[] = [];
    for (let t = 0; t < 3; t++) {
      ts.push(trial(`t${t}`, "base", D, 1, true, { turns: 4 }));
      ts.push(trial(`t${t}`, "terse", D, 1, true, { turns: 6 }));
    }
    const r = compareToolArms(ts, { baseline: `base@${D}`, candidate: `terse@${D}` });
    const turns = r.metrics.turns!;
    assert.deepEqual([turns.diff.lo, turns.diff.hi], [2, 2]);
    assert.equal(turns.p, 0.25);
    assert.equal(turns.verdict, "inconclusive");
    assert.equal(r.regressions.filter((x) => x.kind === "metric").length, 0);
    assert.ok(r.notes.includes("turns: the CI excludes 0, but the exact permutation test over 3 tasks gives p = 0.250, so it is not called a change"), r.notes.join("\n"));
    // 6 tasks that each take 2 more turns: p = 2/2⁶, a regression.
    const six: TrialResult[] = [];
    for (let t = 0; t < 6; t++) six.push(trial(`t${t}`, "base", D, 1, true, { turns: 4 }), trial(`t${t}`, "terse", D, 1, true, { turns: 6 }));
    const r6 = compareToolArms(six, { baseline: `base@${D}`, candidate: `terse@${D}` });
    assert.equal(r6.metrics.turns!.p, 2 / 64);
    assert.equal(r6.metrics.turns!.verdict, "worse");
  });

  it("compares drivers on one variant, skips llm latency across latency sources, rejects two-factor pairs", () => {
    const ts = [trial("t", "base", "agent:claude-code", 1, true, { latencySource: "hooks", llmP95Ms: 100 }), trial("t", "base", D, 1, true, { llmP95Ms: 50 })];
    const r = compareToolArms(ts, { baseline: "base@agent:claude-code", candidate: `base@${D}` });
    assert.equal(r.comparing, "driver");
    assert.equal(r.metrics.llmP95Ms, undefined);
    assert.ok(r.notes.some((n) => /latency sources differ/.test(n)));
    assert.throws(() => compareToolArms(ts, { baseline: "base@agent:claude-code", candidate: `terse@${D}` }), /both variant and driver/);
  });

  it("reports surface deltas and renders text", () => {
    const s = (variant: string, bytes: number): SurfaceReport => ({ target: "fake", variant, surfaceBytes: bytes * 2, descriptionBytes: bytes, surfaceTokens: bytes / 2, tokensEstimated: true, items: [] });
    const r = compareToolArms(arms(5, 1, 0.5, 0.5, 3), { baseline: `base@${D}`, candidate: `terse@${D}`, surfaces: { baseline: s("base", 1000), candidate: s("terse", 400) } });
    assert.equal(r.surface?.descriptionBytes.delta, -600);
    assert.equal(r.surface?.descriptionBytes.relative, -0.6);
    const text = formatToolCompare(r);
    assert.match(text, /verdict:/);
    assert.match(text, /descriptions/);
    assert.match(text, /p \(perm\) = \d\.\d{3}/);
    const sum = summarizeArms(arms(5, 2, 1, 0, 3));
    assert.deepEqual(
      sum.map((a) => [a.arm, a.passAllK, a.passAnyK]),
      [
        [`base@${D}`, 5, 5],
        [`terse@${D}`, 0, 0],
      ],
    );
  });
});
