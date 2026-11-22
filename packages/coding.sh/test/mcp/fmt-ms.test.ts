// The MCP digest and timeline print durations with fmtMs. It prints what the CLI prints for the
// same value (cli/output.ts duration()): the whole value rounds to the unit shown before it splits,
// so 119.6 s is 2m00s, not 1m60s, and 8,975,379 ms is 2h30m, not 2h29m.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { duration } from "../../src/cli/output.ts";
import { fmtMs } from "../../src/mcp/data.ts";

describe("fmtMs", () => {
  it("rounds before it splits, so a carry moves up a unit", () => {
    assert.equal(fmtMs(119_600), "2m00s");
    assert.equal(fmtMs(8_975_379), "2h30m");
    assert.equal(fmtMs(59_600), "1m00s");
    assert.equal(fmtMs(3_599_600), "1h00m");
    assert.equal(fmtMs(9_960), "10s");
    assert.equal(fmtMs(999.6), "1.0s");
  });

  it("keeps the short forms, and a dash for an unknown value", () => {
    assert.equal(fmtMs(850), "850ms");
    assert.equal(fmtMs(4_200), "4.2s");
    assert.equal(fmtMs(42_000), "42s");
    assert.equal(fmtMs(187_000), "3m07s");
    assert.equal(fmtMs(7_500_000), "2h05m");
    assert.equal(fmtMs(undefined), "-");
    assert.equal(fmtMs(Number.NaN), "-");
  });

  it("prints what the CLI prints for the same value", () => {
    const values = [0, 0.4, 999.4, 999.5, 9_949, 9_950, 59_499, 59_500, 119_499, 119_500, 3_599_499, 3_599_500, 3_629_999, 3_630_000, 8_975_379, 86_399_999, 90_061_000];
    for (let ms = 0; ms < 3 * 3600e3; ms += 997) values.push(ms);
    for (const ms of values) assert.equal(fmtMs(ms), duration(ms), `${ms} ms`);
  });
});
