// The model checker (test/_model.ts) on toy models whose answer is known: a non-atomic counter gives its
// shortest counterexample and the atomic one passes; locks taken in opposite orders deadlock and ordered ones
// do not; the counts are exact on a model small enough to count by hand; a bound marks the search incomplete,
// and a raised CODING_SH_MODEL_BOUND lifts the default one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf, check, defaultMaxStates, formatTrace, stableKey, update, type Action, type Model } from "../_model.ts";

interface Counter {
  counter: number;
  pc: ("start" | "read" | "done")[];
  tmp: number[];
}

/** Two processes each add one to a shared counter: read it, then write the read value plus one. */
function counterModel(atomic: boolean): Model<Counter> {
  const actions: Action<Counter>[] = [];
  for (const p of [0, 1]) {
    if (atomic) {
      actions.push({ name: `add p${p}`, guard: (s) => s.pc[p] === "start", effect: (s) => update(s, (d) => ((d.counter += 1), (d.pc[p] = "done"))) });
      continue;
    }
    actions.push({ name: `read p${p}`, guard: (s) => s.pc[p] === "start", effect: (s) => update(s, (d) => ((d.tmp[p] = d.counter), (d.pc[p] = "read"))) });
    actions.push({ name: `write p${p}`, guard: (s) => s.pc[p] === "read", effect: (s) => update(s, (d) => ((d.counter = (d.tmp[p] ?? 0) + 1), (d.pc[p] = "done"))) });
  }
  return {
    init: { counter: 0, pc: ["start", "start"], tmp: [0, 0] },
    actions,
    invariants: { "both adds count": (s) => !s.pc.every((x) => x === "done") || s.counter === 2 || `counter is ${s.counter} after both adds` },
    final: (s) => s.pc.every((x) => x === "done"),
  };
}

test("a non-atomic counter loses an update, and the trace is a shortest one", () => {
  const r = check(counterModel(false));
  assert.equal(r.ok, false);
  assert.equal(r.violation?.invariant, "both adds count");
  assert.equal(r.violation?.message, "counter is 1 after both adds");
  const trace = r.violation?.trace;
  assert.ok(trace);
  assert.deepEqual(actionsOf(trace), ["read p0", "read p1", "write p0", "write p1"]);
  assert.deepEqual(trace.steps.at(-1)?.state, { counter: 1, pc: ["done", "done"], tmp: [0, 0] });
  assert.match(formatTrace(trace), /^init {2}\{"counter":0,.*\n {3}1\. read p0\n/s);
});

test("the atomic counter keeps every update", () => {
  const r = check(counterModel(true));
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  // start/start, done/start, start/done, done/done.
  assert.equal(r.states, 4);
  assert.equal(r.transitions, 4);
  assert.equal(r.depth, 2);
});

interface Locks {
  owner: Record<"A" | "B", number | null>;
  step: number[];
}

/** Process p takes its two locks in `order[p]`, then releases both. */
function lockModel(order: [["A" | "B", "A" | "B"], ["A" | "B", "A" | "B"]]): Model<Locks> {
  const actions: Action<Locks>[] = [];
  for (const p of [0, 1]) {
    const [first, second] = order[p] ?? ["A", "B"];
    actions.push({ name: `p${p} takes ${first}`, guard: (s) => s.step[p] === 0 && s.owner[first] === null, effect: (s) => update(s, (d) => ((d.owner[first] = p), (d.step[p] = 1))) });
    actions.push({ name: `p${p} takes ${second}`, guard: (s) => s.step[p] === 1 && s.owner[second] === null, effect: (s) => update(s, (d) => ((d.owner[second] = p), (d.step[p] = 2))) });
    actions.push({ name: `p${p} releases`, guard: (s) => s.step[p] === 2, effect: (s) => update(s, (d) => ((d.owner[first] = null), (d.owner[second] = null), (d.step[p] = 3))) });
  }
  return {
    init: { owner: { A: null, B: null }, step: [0, 0] },
    actions,
    invariants: { "one owner per lock": () => true },
    final: (s) => s.step.every((x) => x === 3),
  };
}

test("locks taken in opposite orders deadlock after two steps", () => {
  const r = check(lockModel([["A", "B"], ["B", "A"]]));
  assert.equal(r.ok, false);
  assert.equal(r.violation, undefined);
  const trace = r.deadlock?.trace;
  assert.ok(trace);
  assert.deepEqual(actionsOf(trace), ["p0 takes A", "p1 takes B"]);
  // Off, the same model passes: the stuck state is reached, not reported.
  assert.equal(check(lockModel([["A", "B"], ["B", "A"]]), { deadlock: false }).ok, true);
});

test("locks taken in the same order never deadlock", () => {
  const r = check(lockModel([["A", "B"], ["A", "B"]]));
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states > 5);
});

test("an effect with several outcomes explores each, and keys ignore field order", () => {
  type Coin = { flips: number; heads: number };
  const r = check<Coin>({
    init: { flips: 0, heads: 0 },
    actions: [{ name: "flip", guard: (s) => s.flips < 3, effect: (s) => [update(s, (d) => void d.flips++), update(s, (d) => void (d.flips++, d.heads++))] }],
    invariants: { "at most two heads": (s) => s.heads <= 2 },
    final: (s) => s.flips === 3,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(actionsOf(r.violation?.trace ?? { init: { flips: 0, heads: 0 }, steps: [] }), ["flip", "flip", "flip"]);
  assert.equal(stableKey({ b: 1, a: [{ d: 2, c: undefined }] }), stableKey({ a: [{ d: 2 }], b: 1 }));
});

test("a bound marks the search incomplete instead of passing it silently", () => {
  const forever: Model<{ n: number }> = {
    init: { n: 0 },
    actions: [{ name: "inc", effect: (s) => ({ n: s.n + 1 }) }],
    invariants: { "below 1000": (s) => s.n < 1000 },
  };
  const byDepth = check(forever, { maxDepth: 10 });
  assert.equal(byDepth.ok, true);
  assert.equal(byDepth.complete, false);
  assert.equal(byDepth.depth, 10);
  const byStates = check(forever, { maxStates: 50 });
  assert.equal(byStates.complete, false);
  assert.equal(byStates.states, 50);
  assert.equal(check(forever, { maxStates: 2000 }).violation?.trace.steps.length, 1000);
});

test("a raised model bound lifts the default cap on states, and the default run keeps a million", () => {
  assert.equal(defaultMaxStates({}), 1_000_000);
  assert.equal(defaultMaxStates({ CODING_SH_MODEL_BOUND: "0" }), 1_000_000);
  assert.equal(defaultMaxStates({ CODING_SH_MODEL_BOUND: "2" }), 16_000_000);
});

test("a broken initial state is reported with an empty trace", () => {
  const r = check<{ x: number }>({ init: [{ x: 1 }, { x: -1 }], actions: [], invariants: { positive: (s) => s.x > 0 }, final: () => true });
  assert.equal(r.violation?.invariant, "positive");
  assert.deepEqual(r.violation?.trace, { init: { x: -1 }, steps: [] });
});
