import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExperimentResult, Split } from "../../src/datasets/types.ts";
import { plateau, plateauLine, renderPlateau } from "../../src/experiments/plateau.ts";
import { eDetector } from "../../src/stats/edetector.ts";

const caseIds = (n: number) => Array.from({ length: n }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);

/** A stored experiment over `n` cases that passes exactly `pass` (case numbers, 1-based). */
function exp(i: number, pass: number[], opts: { n?: number; version?: string; split?: Split; metadata?: Record<string, unknown> } = {}): ExperimentResult {
  const ok = new Set(pass);
  const runs = caseIds(opts.n ?? 12).map((caseId, k) => ({ caseId, trial: 0, latencyMs: 1, grades: [], pass: ok.has(k + 1), startedAt: i }));
  return {
    id: `exp_${i}`,
    name: `v${i}`,
    dataset: { id: "ds_1", name: "loop", version: opts.version ?? "1", ...(opts.split ? { split: opts.split } : {}) },
    task: { kind: "command" },
    graders: [],
    trials: 1,
    createdAt: i,
    finishedAt: i,
    runs,
    summary: {},
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  } as unknown as ExperimentResult;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const without = (xs: number[], drop: number[]) => xs.filter((x) => !drop.includes(x));

// The X-17 degrading series as experiments: two rounds each fix 3 of 12 cases,
// then every candidate breaks 2 of the incumbent's 6 passes (a different 2 each time).
const degrading = (split?: Split) => [
  exp(0, [], split ? { split } : {}),
  exp(1, range(1, 3), split ? { split } : {}),
  exp(2, range(1, 6), split ? { split } : {}),
  ...Array.from({ length: 10 }, (_, k) => exp(3 + k, without(range(1, 6), [1 + (k % 6), 1 + ((k + 1) % 6)]), split ? { split } : {})),
];

describe("plateau", () => {
  it("degrading series: stops at round 6 (7 with mixture) and ships version 2", () => {
    const p = plateau(degrading());
    assert.equal(p.status, "stop");
    assert.deepEqual([p.alarmRound, p.changePoint], [6, 3]);
    assert.deepEqual(p.recommend, { version: 2, id: "exp_2", name: "v2" });
    // Same paired diffs as the X-17 reference series: same wealth.
    const mk = (w: number, l: number) => [...Array(w).fill(1), ...Array(l).fill(-1), ...Array(12 - w - l).fill(0)] as number[];
    const ref = eDetector([mk(3, 0), mk(3, 0), ...Array.from({ length: 10 }, () => mk(0, 2))], { eps: 0.05 });
    assert.ok(Math.abs(p.detector.logWealth - ref.logWealth) < 1e-12);
    assert.ok(Math.abs(Math.exp(p.detector.logWealth) - 42.66969143798015) < 1e-9);
    // Greedy kept v2 through every bad round: v2 is also the incumbent.
    assert.deepEqual(
      p.rounds.slice(0, 4).map((r) => [r.round, r.incumbent, r.accepted]),
      [
        [1, "exp_0", true],
        [2, "exp_1", true],
        [3, "exp_2", false],
        [4, "exp_2", false],
      ],
    );
    assert.equal(p.incumbent.id, "exp_2");
    const mix = plateau(degrading(), { bet: "mixture" });
    assert.deepEqual([mix.alarmRound, mix.changePoint, mix.recommend?.version], [7, 3, 2]);
    const text = renderPlateau(p, { color: false, series: "loop" });
    assert.match(text, /stop: the loop stopped gaining 0\.05 per round at round 3; alarm at round 6/);
    assert.match(text, /ship v2 exp_2 \(version 2, the incumbent before the plateau\)/);
    assert.match(plateauLine("loop", p), /^series loop: stop, ship v2 exp_2 \(version 2; the plateau began at round 3\)/);
  });

  it("chain gate: keeps every candidate, so the version to ship is earlier than the incumbent", () => {
    // 30 cases; two rounds fix 3 each, then every version breaks 2 more of its predecessor's passes.
    const series = [exp(0, range(1, 10), { n: 30 }), exp(1, range(1, 13), { n: 30 }), exp(2, range(1, 16), { n: 30 })];
    for (let k = 3; k <= 9; k++) series.push(exp(k, range(1, 16 - 2 * (k - 2)), { n: 30 }));
    const chain = plateau(series, { gate: "chain" });
    assert.equal(chain.status, "stop");
    assert.equal(chain.changePoint, 3);
    assert.equal(chain.recommend?.id, "exp_2");
    assert.ok(chain.rounds.every((r) => r.accepted && r.incumbent === `exp_${r.round - 1}`));
    assert.ok(chain.recommend!.version < chain.incumbent.version, "chain ships an earlier version than its head");
    const greedy = plateau(series);
    assert.equal(greedy.recommend?.id, "exp_2");
    assert.equal(greedy.incumbent.id, "exp_2", "greedy already holds the version to ship");
  });

  it("steady gains: continue, incumbent is the newest version", () => {
    const series = Array.from({ length: 9 }, (_, k) => exp(k, range(1, 4 * k), { n: 40 }));
    const p = plateau(series);
    assert.equal(p.status, "continue");
    assert.equal(p.recommend, undefined);
    assert.equal(p.incumbent.id, "exp_8");
    assert.ok(p.rounds.every((r) => r.accepted && Math.abs(r.meanDiff - 0.1) < 1e-12));
    assert.equal(p.floor, Math.ceil(Math.log(20) / (40 * Math.log1p(0.5 * 0.05))));
    assert.match(plateauLine("s", p), /^series s: continue, incumbent v8 exp_8 \(round 8 \+10\.0pp, 40 cases, kept\)$/);
  });

  it("one experiment is insufficient", () => {
    const p = plateau([exp(0, [1])]);
    assert.equal(p.status, "insufficient");
    assert.deepEqual(p.rounds, []);
    assert.ok(p.warnings.some((w) => /at least two experiments/.test(w)));
    assert.equal(plateau([]).status, "insufficient");
    assert.match(plateauLine("s", p), /1 experiment, run another/);
  });

  it("warns on a dataset version change, a split change and thin rounds", () => {
    const p = plateau([exp(0, [1]), exp(1, [1, 2], { version: "2" }), exp(2, [1, 2, 3], { version: "2", split: "dev" })]);
    assert.ok(p.warnings.some((w) => /changed version at round 1 \(1 → 2\)/.test(w)));
    assert.ok(p.warnings.some((w) => /split changed at round 2 \(all → dev\)/.test(w)));
    const thin = plateau([exp(0, [], { n: 6 }), exp(1, [1], { n: 6 })]);
    assert.ok(thin.warnings.some((w) => /round 1 pairs fewer than 10 cases/.test(w)));
  });

  it("metadata.accepted overrides the gate", () => {
    const series = degrading();
    series[3]!.metadata = { accepted: true };
    const p = plateau(series);
    assert.deepEqual([p.rounds[2]!.accepted, p.rounds[2]!.decidedBy], [true, "metadata"]);
    assert.equal(p.rounds[3]!.incumbent, "exp_3", "the loop's own accept moved the incumbent");
    const refused = plateau([exp(0, []), exp(1, [1, 2, 3], { metadata: { accepted: false } }), exp(2, [1])]);
    assert.equal(refused.rounds[1]!.incumbent, "exp_0");
  });

  it("a stop selected on dev says to confirm on test", () => {
    const p = plateau(degrading("dev"));
    assert.equal(p.status, "stop");
    assert.ok(p.warnings.some((w) => w === "the loop selected on the dev split: confirm v2 (exp_2) on test before shipping it"));
    assert.ok(!plateau(degrading("test")).warnings.some((w) => /confirm/.test(w)));
  });

  it("rounds with no shared case are left out of the detector", () => {
    const other = exp(1, [1]);
    other.runs = other.runs.map((r) => ({ ...r, caseId: `x${r.caseId}` }));
    const p = plateau([exp(0, []), other]);
    assert.equal(p.status, "insufficient");
    assert.equal(p.rounds[0]!.counted, false);
    assert.ok(p.warnings.some((w) => /round 1 shares no case/.test(w)));
  });

  it("warns once the loop passes the 1/δ average run length", () => {
    const series = Array.from({ length: 22 }, (_, k) => exp(k, range(1, k), { n: 400 }));
    const p = plateau(series, { eps: 0.001 });
    assert.ok(p.warnings.some((w) => /past the 20-round average run length/.test(w)));
  });
});
