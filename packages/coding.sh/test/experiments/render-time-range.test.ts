import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { renderSessionSummary } from "../../src/experiments/render.ts";

describe("experiments/render date range handling", () => {
  it("renders a placeholder for an out-of-range timeline timestamp and keeps valid entries", () => {
    const out = renderSessionSummary(
      { id: "es_1", name: "prompt-tuning" },
      [
        { kind: "note", at: MAX_DATE_MS + 1, text: "out of range note" },
        { kind: "note", at: Date.parse("2026-11-01T10:30:00Z"), text: "valid note" },
      ],
      { color: false },
    );
    assert.ok(out.includes("out of range note"));
    assert.ok(out.includes("2026-11-01 10:30  note  valid note"));
    assert.ok(out.includes("-                 note  out of range note"));
  });
});
