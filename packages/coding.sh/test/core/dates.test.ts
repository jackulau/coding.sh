import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateMs, durationBefore, MAX_DATE_MS } from "../../src/core/dates.ts";

describe("dates", () => {
  it("dateMs keeps a time in the Date range, both ends included, and reads anything else as missing", () => {
    assert.equal(MAX_DATE_MS, 8.64e15);
    for (const ms of [0, 1_790_000_000_000, MAX_DATE_MS, -MAX_DATE_MS]) assert.equal(dateMs(ms), ms);
    for (const ms of [MAX_DATE_MS + 1, -MAX_DATE_MS - 1, 1e308, -1e308, Infinity, -Infinity, NaN, undefined]) assert.equal(dateMs(ms), undefined);
    for (const ms of [MAX_DATE_MS, -MAX_DATE_MS]) assert.equal(new Date(ms).getTime(), ms);
    assert.ok(Number.isNaN(new Date(MAX_DATE_MS + 1).getTime()));
  });

  it("durationBefore keeps a duration whose start is in the Date range", () => {
    assert.equal(durationBefore(1_790_000_000_000, 1500), 1500);
    assert.equal(durationBefore(-MAX_DATE_MS + 10, 10), 10);
    assert.equal(durationBefore(-MAX_DATE_MS + 10, 11), undefined);
    assert.equal(durationBefore(1_790_000_000_000, 1e308), undefined);
    assert.equal(durationBefore(1_790_000_000_000, -1e308), undefined);
    assert.equal(durationBefore(1_790_000_000_000, undefined), undefined);
  });
});
