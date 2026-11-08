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
