// clampDescription keeps meta descriptions under the limit without cutting
// inside a word: the dot in "coding.sh", "v0.1.2" or "AGENTS.md" is not the
// end of a sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampDescription } from "../src/lib/clamp.ts";

/** The clamped text starts the input and stops at a space (after any , ; or :) or the end, never mid-token. */
function assertWholeWords(input, out) {
  const kept = out.endsWith("…") ? out.slice(0, -1) : out;
  assert.ok(input.startsWith(kept), `not a prefix of the input: ${out}`);
  assert.match(input.slice(kept.length), /^[,;:]?(\s|$)/, `cut inside a token after "${kept.slice(-20)}"`);
}

test("a dot inside a word does not end a sentence", () => {
  const input =
    "What changed in coding.sh v0.1.2, page 4 of 5: every change to Experiments, Gateways, SDKs, Durable workflows, Viewer, Cost, Workflows and Production, one line each.";
  const out = clampDescription(input);
  assert.ok(out.length <= 155, `${out.length} characters`);
  assert.ok(out.startsWith("What changed in coding.sh v0.1.2,"), out);
  assertWholeWords(input, out);
});

test("whole sentences are kept, and the cut stops before --help is split", () => {
  const input =
    "Improve AGENTS.md and skills in tested rounds, and keep their safety rules in place. Every option of coding.sh refine and its subcommands, from its own --help.";
  const out = clampDescription(input);
  assert.ok(input.length > 155);
  assert.ok(out.length <= 155, `${out.length} characters`);
  assert.ok(out.startsWith("Improve AGENTS.md and skills"), out);
  assertWholeWords(input, out);
});

test("a text over the limit ends with an ellipsis after a whole word", () => {
  const input = `${"word ".repeat(40)}end`;
  const out = clampDescription(input);
  assert.ok(out.length <= 155, `${out.length} characters`);
  assert.ok(out.endsWith("…"), out);
  assertWholeWords(input, out);
});

test("a short text comes back unchanged, whitespace collapsed", () => {
  assert.equal(clampDescription("Run coding.sh v0.1.5 locally."), "Run coding.sh v0.1.5 locally.");
  assert.equal(clampDescription("  two\n  lines  "), "two lines");
});
