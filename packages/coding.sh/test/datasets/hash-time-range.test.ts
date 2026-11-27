import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { canonicalJson } from "../../src/datasets/hash.ts";

describe("datasets/hash date range handling", () => {
  it("encodes an out-of-range Date as null and keeps valid Dates as ISO strings", () => {
    const out = canonicalJson({ bad: new Date(MAX_DATE_MS + 1), good: new Date(0) });
    assert.equal(out, '{"bad":null,"good":"1970-01-01T00:00:00.000Z"}');
  });
});
