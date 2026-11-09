// Published prompt-cache hit rates (Requesty, Apr 2026): lookup by coding.sh agent id, no guesses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_BASELINES, CACHE_BASELINE_NOTE, cacheBaseline } from "../../src/core/cache-baselines.ts";

test("claude-code is Requesty's 91.9%; an unknown agent has no baseline", () => {
  assert.deepEqual(cacheBaseline("claude-code"), { rate: 0.919, name: "Claude Code", source: "requesty", period: "2026-04", url: "https://www.requesty.ai/data/coding-agent-cache-hit-rate-apr-2026" });
  assert.equal(cacheBaseline("opencode")?.rate, 0.89);
  assert.equal(cacheBaseline("codex"), undefined, "Requesty excludes Codex CLI (too little traffic)");
  assert.equal(cacheBaseline("nope"), undefined);
  assert.equal(cacheBaseline("toString"), undefined, "no prototype keys");
});

test("every rate is in (0, 1] and the table is frozen", () => {
  assert.equal(Object.keys(CACHE_BASELINES).length, 8);
  for (const b of Object.values(CACHE_BASELINES)) {
    assert.ok(b.rate > 0 && b.rate <= 1, b.name);
    assert.ok(Object.isFrozen(b));
  }
  assert.ok(Object.isFrozen(CACHE_BASELINES));
  assert.throws(() => {
    (CACHE_BASELINES["claude-code"] as { rate: number }).rate = 1;
  });
});

test("the note credits the source and states the denominator caveat", () => {
  assert.match(CACHE_BASELINE_NOTE, /Requesty's reported .* Apr 2026/);
  assert.match(CACHE_BASELINE_NOTE, /no sample size or method given/);
  assert.match(CACHE_BASELINE_NOTE, /cacheRead \/ \(input \+ cacheRead \+ cacheWrite\)/);
  assert.match(CACHE_BASELINE_NOTE, /directional/);
});
