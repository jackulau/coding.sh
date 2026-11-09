// Score checks that the API and CLI tests don't reach: bounds, coercions, ids, and stores without scores.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ScoreConfig } from "../../src/core/types.ts";
import { addScore, checkValue, defaultScoreId, parseScore, parseScoreConfig, ScoreError, scoreFilter } from "../../src/scores/scores.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

const d = { by: "me", source: "api" as const, now: 1000 };
const range: ScoreConfig = { id: "r", name: "r", dataType: "numeric", min: 0, max: 1, ts: 0 };
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ScoreError ? e.status : -1;
  }
  return 0;
};

describe("scores", () => {
  it("bounds are inclusive; NaN and Infinity are not numbers", () => {
    assert.equal(checkValue("numeric", 0, range), 0);
    assert.equal(checkValue("numeric", 1, range), 1);
    assert.equal(status(() => checkValue("numeric", 1.0001, range)), 400);
    assert.equal(status(() => checkValue("numeric", Number.NaN)), 400);
    assert.equal(status(() => checkValue("numeric", Number.POSITIVE_INFINITY)), 400);
  });

  it("booleans take 0 and 1; text may be empty; a category may not", () => {
    assert.equal(checkValue("boolean", 1), true);
    assert.equal(checkValue("boolean", 0), false);
    assert.equal(status(() => checkValue("boolean", 2)), 400);
    assert.equal(checkValue("text", ""), "");
    assert.equal(status(() => checkValue("categorical", " ")), 400);
    assert.equal(status(() => checkValue("text", "x".repeat(4001))), 400);
  });

  it("a person's session score has the viewer label's id; other scores get their own", () => {
    const label = createHash("sha256").update("label\0s1\0outcome\0me").digest("hex");
    assert.equal(defaultScoreId({ target: "session", targetId: "s1", name: "outcome", source: "human", by: "me" }), label);
    assert.notEqual(defaultScoreId({ target: "session", targetId: "s1", name: "outcome", source: "judge", by: "me" }), label);
    assert.notEqual(defaultScoreId({ target: "case", targetId: "s1", name: "outcome", source: "human", by: "me" }), label);
  });

  it("parseScore fills defaults and finds the config by name", () => {
    const s = parseScore({ sessionId: "s1", name: "r", value: 0.5 }, d, [range]);
    assert.deepEqual(s, { id: defaultScoreId(s), target: "session", targetId: "s1", sessionId: "s1", name: "r", dataType: "numeric", value: 0.5, source: "api", configId: "r", by: "me", ts: 1000 });
    assert.equal(parseScore({ targetId: "s1", configId: "r", value: 1 }, d, [range]).name, "r", "the name comes from the config");
    assert.equal(status(() => parseScore({ sessionId: "s1", name: "r", value: 0.5, by: "mallory" }, d, [range])), 0);
    assert.equal(parseScore({ sessionId: "s1", name: "r", value: 0.5, by: "mallory" }, d, [range]).by, "me", "by never comes from the body");
    assert.equal(status(() => parseScore({ sessionId: "s1", name: "r", value: 0.5, calibrated: "yes" }, d, [])), 400);
    assert.equal(status(() => parseScore({ sessionId: "s1", name: "r", value: 0.5, id: "" }, d, [])), 400);
    assert.equal(status(() => parseScore({ sessionId: "s1", name: "r", value: 0.5, comment: 5 }, d, [])), 400);
  });

  it("configs: id defaults to the name; numeric bounds are optional", () => {
    assert.deepEqual(parseScoreConfig({ name: "q", dataType: "numeric", max: 10 }, 5), { id: "q", name: "q", dataType: "numeric", max: 10, ts: 5 });
    assert.deepEqual(parseScoreConfig({ name: "ok", dataType: "boolean" }, 5), { id: "ok", name: "ok", dataType: "boolean", ts: 5 });
  });

  it("filters from query parameters are checked", () => {
    assert.deepEqual(scoreFilter((k) => ({ target: "event", since: "5", name: "x" })[k]), { target: "event", name: "x", since: 5 });
    assert.equal(status(() => scoreFilter((k) => ({ since: "yesterday" })[k])), 400);
    assert.equal(status(() => scoreFilter((k) => ({ source: "robot" })[k])), 400);
  });

  it("a store without scores answers 501", async () => {
    const index = new MemoryIndexStore() as unknown as Record<string, unknown>;
    const bare = Object.assign(Object.create(Object.getPrototypeOf(index)), index, { putScore: undefined, listScores: undefined });
    await assert.rejects(addScore(bare, { target: "run", targetId: "r", name: "x", value: 1 }, d), (e) => e instanceof ScoreError && e.status === 501);
  });
});
