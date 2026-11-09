// AE-6: group-coverage rule and coverage-balanced reveal order (arXiv 2607.12338).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { balancedOrder, budgetTasks, coverageFeasible, groupSizesOf, isCovered, mulberry32, requiredPerGroup } from "../../src/stats/index.ts";

const grid = Array.from({ length: 20 }, (_, i) => Math.round((i + 1) * 5) / 100);

function countsOf(labels: readonly (string | undefined)[], idx: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of idx) out[labels[i] ?? ""] = (out[labels[i] ?? ""] ?? 0) + 1;
  return out;
}

describe("requiredPerGroup", () => {
  it("matches the hand-computed table {a:100, b:40, c:10} at b = 0.2", () => {
    assert.deepEqual(requiredPerGroup({ a: 100, b: 40, c: 10 }, 0.2), { N: 150, k: 30, required: { a: 20, b: 8, c: 2 } });
  });

  it("a tiny group floored to 0 still gets 1; an empty group needs 0", () => {
    // k = 15: floor(15·2/150) = 0 → 1.
    assert.deepEqual(requiredPerGroup({ big: 148, tiny: 2, none: 0 }, 0.1).required, { big: 14, tiny: 1, none: 0 });
  });

  it("never asks for more than the group has", () => {
    assert.deepEqual(requiredPerGroup({ a: 3, b: 1 }, 1).required, { a: 3, b: 1 });
  });

  it("slack takes one off, never below 1", () => {
    assert.deepEqual(requiredPerGroup({ a: 100, b: 40, c: 10 }, 0.2, { slack: true }).required, { a: 19, b: 7, c: 1 });
    assert.deepEqual(requiredPerGroup({ big: 148, tiny: 2 }, 0.1, { slack: true }).required, { big: 13, tiny: 1 });
  });

  it("k_b tolerates float noise and rejects b outside (0, 1]", () => {
    assert.equal(budgetTasks(0.15, 100), 15);
    assert.equal(budgetTasks(0.07, 100), 7);
    assert.throws(() => requiredPerGroup({ a: 1 }, 0), RangeError);
    assert.throws(() => requiredPerGroup({ a: 1 }, 1.01), RangeError);
    assert.throws(() => requiredPerGroup({ a: -1 }, 0.5), RangeError);
  });
});

describe("coverageFeasible", () => {
  it("is false for 50 groups of 3 at b = 0.05 (k_b = 8 < 50), true at b = 0.35", () => {
    const sizes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`g${i}`, 3]));
    assert.equal(requiredPerGroup(sizes, 0.05).k, 8);
    assert.equal(coverageFeasible(sizes, 0.05), false);
    assert.equal(coverageFeasible(sizes, 0.3), false); // k = 45 < 50
    assert.equal(coverageFeasible(sizes, 0.35), true); // k = 53 ≥ 50
  });

  it("is true at the edge Σ r_g = k_b", () => {
    assert.equal(coverageFeasible({ a: 100, b: 40, c: 10 }, 0.2), true); // 30 = 30
  });
});

describe("isCovered", () => {
  const sizes = { a: 100, b: 40, c: 10 };
  it("is true iff every minimum is met; a missing group counts 0", () => {
    assert.equal(isCovered({ a: 20, b: 8, c: 2 }, sizes, 0.2), true);
    assert.equal(isCovered({ a: 25, b: 8, c: 2 }, sizes, 0.2), true);
    assert.equal(isCovered({ a: 20, b: 7, c: 3 }, sizes, 0.2), false);
    assert.equal(isCovered({ a: 28, b: 8 }, sizes, 0.2), false);
  });
});

describe("balancedOrder", () => {
  const suites: [string, (string | undefined)[]][] = [
    ["three uneven groups", [...Array(100).fill("a"), ...Array(40).fill("b"), ...Array(10).fill("c")]],
    ["50 groups of 3", Array.from({ length: 150 }, (_, i) => `g${i % 50}`)],
    ["a singleton beside a big group, with ungrouped tasks", [...Array(37).fill("big"), "one", ...Array(5).fill(undefined), ...Array(7).fill("mid")]],
  ];
  const rand = mulberry32(99);
  const random = Array.from({ length: 233 }, () => `r${Math.floor(rand() ** 2 * 9)}`);
  suites.push(["random skewed groups", random]);

  for (const [name, labels] of suites) {
    it(`${name}: every 5% prefix is covered whenever coverage is feasible`, () => {
      const sizes = groupSizesOf(labels);
      for (const seed of [1, 2, 3]) {
        const order = balancedOrder(labels, seed);
        let feasible = 0;
        for (const b of grid) {
          if (!coverageFeasible(sizes, b)) continue;
          feasible++;
          const k = budgetTasks(b, labels.length);
          assert.ok(isCovered(countsOf(labels, order.slice(0, k)), sizes, b), `${name} seed ${seed} b=${b}`);
        }
        assert.ok(feasible > 0);
        // And at every prefix length, not only the grid.
        for (let L = 1; L <= labels.length; L++) {
          const b = L / labels.length;
          if (budgetTasks(b, labels.length) !== L || !coverageFeasible(sizes, b)) continue;
          assert.ok(isCovered(countsOf(labels, order.slice(0, L)), sizes, b), `${name} L=${L}`);
        }
      }
    });
  }

  it("is a permutation and deterministic per seed", () => {
    const labels = suites[0]![1];
    const a = balancedOrder(labels, 5);
    assert.deepEqual(a, balancedOrder(labels, 5));
    assert.notDeepEqual(a, balancedOrder(labels, 6));
    assert.deepEqual([...a].sort((x, y) => x - y), labels.map((_, i) => i));
  });

  it("the first feasible budget is covered at once, and full n is covered", () => {
    const labels = suites[1]![1];
    const sizes = groupSizesOf(labels);
    const first = grid.find((b) => coverageFeasible(sizes, b))!;
    const order = balancedOrder(labels, 1);
    assert.ok(isCovered(countsOf(labels, order.slice(0, budgetTasks(first, labels.length))), sizes, first));
    assert.ok(isCovered(countsOf(labels, order), sizes, 1));
  });

  it("handles empty input", () => {
    assert.deepEqual(balancedOrder([], 1), []);
  });
});
