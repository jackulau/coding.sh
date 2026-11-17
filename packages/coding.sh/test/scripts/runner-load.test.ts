import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeLoad, runnerLoad } from "../../scripts/runner-load.mjs";

const core = (user: number, sys: number, idle: number, model = "Test CPU ") => ({ model, speed: 0, times: { user, nice: 0, sys, idle, irq: 0 } });

describe("scripts/runner-load.mjs", () => {
  it("the busy share is the time the cores did not idle between the samples", () => {
    const before = [core(100, 50, 1000), core(200, 0, 2000)];
    const after = [core(400, 150, 1100), core(300, 0, 2400)];
    // Core 1: 400 busy of 500. Core 2: 100 busy of 500.
    assert.deepEqual(runnerLoad(before, after), { cores: 2, model: "Test CPU", busy: 0.5 });
  });

  it("the line names the cores, the model, the share and the seconds", () => {
    assert.equal(describeLoad([core(0, 0, 0)], [core(870, 0, 130)], 149.6), "Runner: 1 core (Test CPU), 87% busy over 150 s");
    assert.equal(describeLoad([core(0, 0, 0), core(0, 0, 0)], [core(1, 0, 3), core(1, 0, 3)], 2), "Runner: 2 cores (Test CPU), 25% busy over 2 s");
  });

  it("samples that show no time passing say the load was not measured", () => {
    assert.equal(describeLoad([core(5, 5, 5)], [core(5, 5, 5, "")], 0), "Runner: 1 core (unknown model), load not measured over 0 s");
  });
});
