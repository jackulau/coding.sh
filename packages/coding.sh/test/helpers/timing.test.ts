// The CPU-time helper the scaling tests use (test/helpers-timing.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuMsPerCall } from "../helpers-timing.ts";

let sink = 0;
// About a third of a millisecond: far too short to time alone on a coarse CPU clock.
const short = (): void => {
  for (let i = 1; i <= 100_000; i++) sink += Math.sqrt(i);
};

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

test("cpuMsPerCall makes one call when no CPU time is asked for", () => {
  let calls = 0;
  const per = cpuMsPerCall(() => void calls++, 0);
  assert.equal(calls, 1);
  assert.ok(per >= 0);
});
