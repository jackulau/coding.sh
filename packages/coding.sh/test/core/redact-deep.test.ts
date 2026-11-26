// A value nested deeper than redaction walks is still redacted: past that depth the subtree is
// redacted as JSON text, so no secret is kept because of where it sits.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor, redactBlobValue, redactEventCounted, redactionTally } from "../../src/core/redact.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const KEY = "sk-ant-api03-" + "Q7x".repeat(30);
const r = createRedactor({ redact: ["secrets"] });

function nest(leaf: unknown, depth: number, arrays = false): unknown {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = arrays ? [v] : { n: v };
  return v;
}

/** What `f` gives, and how many characters JSON.stringify gave while it ran. */
function serialized<T>(f: () => T): { out: T; chars: number } {
  const real = JSON.stringify;
  let chars = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const s = real(...args);
    chars += s?.length ?? 0;
    return s;
  }) as typeof JSON.stringify;
  try {
    return { out: f(), chars };
  } finally {
    JSON.stringify = real;
  }
}

describe("redaction past the walk depth", () => {
  for (const depth of [63, 64, 65, 70, 200]) {
    for (const arrays of [false, true]) {
      it(`a key in a string and a secret field ${depth} ${arrays ? "arrays" : "objects"} deep`, () => {
        const out = JSON.stringify(r.value(nest({ text: `use ${KEY}`, password: "hunter2hunter2" }, depth, arrays)));
        assert.ok(!out.includes(KEY), "the key is gone");
        assert.ok(!out.includes("hunter2hunter2"), "the password field is gone");
      });
    }
  }
  it("a deep subtree with nothing to redact keeps its shape", () => {
    const v = nest({ text: "nothing here" }, 100);
    assert.deepEqual(r.value(v), v);
  });
  it("an event counts what it redacted deep down", () => {
    const e: AgentEvent = { id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "tool.end", payload: { output: nest(`token ${KEY}`, 90) } };
    const out = redactEventCounted(r, e);
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.ok(Object.keys((out.payload as { redactions?: object }).redactions ?? {}).length > 0, "the hit is counted");
  });
  it("a blob of a deep value is redacted", () => {
    const text = redactBlobValue(r, nest({ out: `X=1\nkey ${KEY}` }, 90), redactionTally());
    assert.ok(!text.includes(KEY));
  });
  // As JSON text a newline is the two characters \n, so a rule that starts at a word boundary,
  // as NAME=value does, would not match there: deep values are redacted as values, not text.
  it("a value too deep for the stack is replaced, not kept and not thrown", () => {
    const out = JSON.stringify(r.value(nest({ text: `use ${KEY}` }, 20_000)) ?? null);
    assert.ok(!out.includes(KEY));
  });
  // Past the walk depth a subtree is copied once from its JSON text, and the copy is followed to its
  // end.
  for (const arrays of [false, true]) {
    it(`a value 1,500 ${arrays ? "arrays" : "objects"} deep is serialized a few times over`, () => {
      const v = nest({ text: `use ${KEY}`, password: "hunter2hunter2" }, 1500, arrays);
      const size = JSON.stringify(v).length;
      const value = serialized(() => r.value(v));
      const blob = serialized(() => redactBlobValue(r, v, redactionTally()));
      for (const [what, out] of [["value", JSON.stringify(value.out)], ["blob", blob.out]] as const) {
        assert.ok(!out.includes(KEY), `the key is gone from the ${what}`);
        assert.ok(!out.includes("hunter2hunter2"), `the password field is gone from the ${what}`);
      }
      assert.ok(value.chars <= 4 * size, `the value walk serialized ${(value.chars / size).toFixed(1)} times its size`);
      assert.ok(blob.chars <= 8 * size, `the blob serialized ${(blob.chars / size).toFixed(1)} times its size`);
    });
  }
  it("a value 1,000 deep with nothing to redact keeps its shape", () => {
    for (const arrays of [false, true]) {
      const v = nest({ text: "nothing here" }, 1000, arrays);
      // As JSON text: assert.deepEqual runs out of stack this deep.
      assert.equal(JSON.stringify(r.value(v)), JSON.stringify(v));
      assert.equal(redactBlobValue(r, v, redactionTally()), JSON.stringify(v));
    }
  });
  for (const depth of [70, 200]) {
    it(`NAME=value on its own line ${depth} levels deep`, () => {
      const leaf = { out: "X=1\nDB_PASSWORD=hunter2hunter2xyz" };
      assert.ok(!JSON.stringify(r.value(nest(leaf, 3))).includes("hunter2hunter2xyz"), "the rule matches near the top");
      assert.ok(!JSON.stringify(r.value(nest(leaf, depth))).includes("hunter2hunter2xyz"));
      assert.ok(!redactBlobValue(r, nest(leaf, depth), redactionTally()).includes("hunter2hunter2xyz"));
      const e: AgentEvent = { id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "tool.end", payload: { output: nest(leaf, depth) } };
      assert.ok(!JSON.stringify(redactEventCounted(r, e)).includes("hunter2hunter2xyz"));
    });
  }
});
