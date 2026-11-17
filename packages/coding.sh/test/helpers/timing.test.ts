// The CPU-time helper the scaling tests use (test/helpers-timing.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuClockStepMs, cpuMsPerCall } from "../helpers-timing.ts";

let sink = 0;
// About a third of a millisecond: far too short to time alone on a coarse CPU clock.
const short = (): void => {
  for (let i = 1; i <= 100_000; i++) sink += Math.sqrt(i);
};

/**
 * A stand-in thread and its CPU clock. `work(ms)` uses CPU time; reading the clock uses a little
 * too, as a real read does. The clock shows the time used in whole steps, as Windows does with
 * its 15.6 ms timer tick. `usedMs` is the true time, which no real clock shows.
 */
function steppedClock(stepMs: number, startMs = 0): { clock: () => number; work: (ms: number) => void; usedMs: () => number } {
  let used = startMs;
  return {
    clock: () => {
      used += 0.001;
      return Math.floor(used / stepMs) * stepMs;
    },
    work: (ms) => void (used += ms),
    usedMs: () => used,
  };
}

test("cpuMsPerCall repeats a short call until the calls have used the CPU time asked for", () => {
  let calls = 0;
  const per = cpuMsPerCall(() => {
    calls++;
    short();
  }, 20);
  assert.ok(calls >= 2, `${calls} calls`);
  assert.ok(per > 0 && per * calls >= 20 - 1e-6, `${per} ms a call over ${calls} calls`);
  assert.ok(Number.isFinite(sink));
});

test("cpuMsPerCall makes one call when that call alone uses the CPU time asked for", () => {
  const t = steppedClock(0.001);
  let calls = 0;
  const per = cpuMsPerCall(() => (calls++, t.work(5)), 0, t.clock);
  assert.equal(calls, 1);
  assert.ok(Math.abs(per - 5) < 0.01, `${per} ms`);
});

test("cpuMsPerCall reads at most 5% under the true cost and never over it on a clock that moves in 15.6 ms steps, wherever in a step it begins", () => {
  // A 4.3 ms call and a 25 ms one: the two sides of the longrun ratio on a CI runner.
  for (const cost of [4.3, 25]) {
    for (let begin = 0; begin < 15.625; begin += 0.625) {
      const t = steppedClock(15.625, begin);
      const per = cpuMsPerCall(() => t.work(cost), 100, t.clock);
      // The stand-in's clock reads cost 0.001 ms each, one a call: that is all "over" can be.
      assert.ok(per >= cost * 0.95 && per <= cost + 0.002, `a ${cost} ms call that began ${begin} ms into a step read as ${per.toFixed(3)} ms`);
    }
  }
});

test("cpuMsPerCall measures over at least twenty steps of a coarse clock, and no longer than asked on a fine one", () => {
  const coarse = steppedClock(15.625, 7);
  const before = coarse.usedMs();
  cpuMsPerCall(() => coarse.work(1), 100, coarse.clock);
  const used = coarse.usedMs() - before;
  assert.ok(used >= 20 * 15.625 && used < 22 * 15.625, `${used.toFixed(1)} ms on the coarse clock`);

  const fine = steppedClock(0.001);
  const start = fine.usedMs();
  cpuMsPerCall(() => fine.work(1), 100, fine.clock);
  const fineUsed = fine.usedMs() - start;
  assert.ok(fineUsed >= 100 && fineUsed < 102, `${fineUsed.toFixed(1)} ms on the fine clock`);
});

test("cpuClockStepMs is the smallest move this thread's CPU clock makes: over nothing, under 20 ms", () => {
  const step = cpuClockStepMs();
  assert.ok(step > 0 && step < 20, `${step} ms`);
});
