// Wall-clock checks that hold on a loaded machine (the parallel suite, other
// jobs on the box). Each one compares against a baseline measured in the same
// process at the same moment, so load stretches both sides, and still fails on
// the order-of-magnitude regressions the checks exist for.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Milliseconds `fn` takes. */
export const timeMs = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

/**
 * CPU milliseconds this thread has used so far. Unlike wall time it does not
 * count time spent waiting for a core, so a busy machine barely moves it.
 */
export const threadCpuMs = (): number => {
  const u = (process.threadCpuUsage ?? process.cpuUsage)(); // threadCpuUsage: Node 23.9 / 22.16+
  return (u.user + u.system) / 1000;
};

/** CPU milliseconds this thread spends in `fn`. */
export const cpuMs = (fn: () => unknown): number => {
  const start = threadCpuMs();
  fn();
  return threadCpuMs() - start;
};

/**
 * Spins until the clock shows a new value. Returns that value and how far it moved: the clock's
 * step. Measured for a thread's CPU clock: 0.002 ms on a Mac, 1 ms on a Linux CI runner, and a
 * timer tick of 15.6 ms on Windows.
 */
const nextStep = (clock: () => number): { at: number; step: number } => {
  const from = clock();
  let at = from;
  while (at === from) at = clock();
  return { at, step: at - from };
};

/** The step of this thread's CPU clock, in milliseconds. */
export const cpuClockStepMs = (): number => nextStep(threadCpuMs).step;

/** How many steps of the clock a measurement covers at least, so one step is at most 5% of it. */
const MIN_STEPS = 20;

/**
 * CPU milliseconds one call of `fn` costs this thread, from as many calls as it takes to use
 * `minMs` of CPU. One short call can't be timed this way: on a clock that moves in 15.6 ms steps
 * a 4 ms call reads as 0 or 15.6.
 *
 * The same steps put a 100 ms measurement off by up to 14% either way: it can begin anywhere
 * inside one step and end anywhere inside another. So the measurement begins on a step and runs
 * for at least `MIN_STEPS` of them, which leaves it under by less than one step in twenty. That is
 * 313 ms on Windows; with a step of 1 ms or less `minMs` is the longer of the two.
 */
export const cpuMsPerCall = (fn: () => unknown, minMs = 100, clock: () => number = threadCpuMs): number => {
  const { at: start, step } = nextStep(clock);
  const enough = Math.max(minMs, MIN_STEPS * step);
  let calls = 0;
  let used = 0;
  do {
    fn();
    calls++;
    used = clock() - start;
  } while (used < enough);
  return used / calls;
};

let sink = 0;

/**
 * A fixed amount of float math (a million logs and exps) to time code against:
 * about 10 ms on an idle laptop. Returns a running total so it can't be optimized away.
 */
export const referenceWork = (): number => {
  let s = 0;
  for (let i = 1; i <= 1_000_000; i++) s += Math.log(i) * Math.exp(-i / 1_000_000);
  return (sink += s);
};

/**
 * The median ratio of `a` to `b` over `pairs` pairs run back to back, taking turns at
 * going first; each returns the milliseconds it took. Load at the moment of a pair
 * stretches both its sides, so it cancels in the pair's ratio, while each side's own
 * times swing with it. `a` and `b` are each side's times, in pair order.
 */
export function pairedRatio(a: () => number, b: () => number, pairs: number): { ratio: number; a: number[]; b: number[] } {
  const as: number[] = [];
  const bs: number[] = [];
  const ratios: number[] = [];
  for (let i = 0; i < pairs; i++) {
    let x: number;
    let y: number;
    if (i % 2) {
      y = b();
      x = a();
    } else {
      x = a();
      y = b();
    }
    as.push(x);
    bs.push(y);
    ratios.push(x / y);
  }
  return { ratio: median(ratios), a: as, b: bs };
}

/**
 * A CLI start (`run`) against a bare `node -e ''` spawned right after it, over 7
 * interleaved pairs after one warm-up run. Passes when the median extra time is
 * under `extraMs` (idle machine) or the median ratio to bare node is under
 * `ratio` (busy machine: load stretches both). Returns the warm-up result.
 */
export function assertStartupBudget(label: string, run: () => SpawnSyncReturns<string>, extraMs = 170, ratio = 4): SpawnSyncReturns<string> {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const extra: number[] = [];
  const ratios: number[] = [];
  const runs: string[] = [];
  for (let i = 0; i < 7; i++) {
    let r: SpawnSyncReturns<string> | undefined;
    const cli = timeMs(() => (r = run()));
    assert.equal(r!.status, 0, r!.stderr);
    const bare = timeMs(() => spawnSync(process.execPath, ["-e", ""]));
    extra.push(cli - bare);
    ratios.push(cli / bare);
    runs.push(`${cli.toFixed(0)}/${bare.toFixed(0)}`);
  }
  assert.ok(median(extra) < extraMs || median(ratios) < ratio, `${label} vs bare node, ms per run: ${runs.join(", ")}`);
  return first;
}
