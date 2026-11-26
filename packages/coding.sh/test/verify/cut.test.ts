// closeJson (test/verify/_cut.ts), which the adapter checks use to close a cut JSON text.
// Properties: on every prefix of a JSON text, closeJson returns undefined or a JSON text, and on the whole
// text it returns one that parses to the same value. Bounds: the listed cases, and every prefix of 300
// seeded JSON values (CODING_SH_PROP_RUNS raises the count).
import assert from "node:assert/strict";
import { test } from "node:test";
import { forAll, gen } from "../_prop.ts";
import { closeJson } from "./_cut.ts";

test("closeJson closes a cut string, number, array and object, and drops what was cut inside a token", () => {
  const cases: [string, string | undefined][] = [
    ["", undefined],
    ["  ", undefined],
    ["nu", undefined],
    ["-", undefined],
    ["null", "null"],
    ['"ab', '"ab"'],
    ['"ab\\', '"ab"'],
    ['"ab\\"', '"ab\\""'],
    ['"ab\\u00', '"ab"'],
    ['"ab\\u00e9', '"ab\\u00e9"'],
    ['{"a":12', '{"a":12}'],
    ['{"a":1.', '{"a":1}'],
    ['{"a":1.5e+', '{"a":1.5}'],
    ['{"a":-', "{}"],
    ['{"a":tr', "{}"],
    ['{"a":true', '{"a":true}'],
    ['{"a":1,', '{"a":1}'],
    ['{"a":1,"b', '{"a":1}'],
    ['{"a":1,"b"', '{"a":1}'],
    ['{"a":1,"b":', '{"a":1}'],
    ['{"a":1,"b": "x', '{"a":1,"b":"x"}'],
    ['[1,[2,{"c":[', '[1,[2,{"c":[]}]]'],
    ['{"a":{"b":1}', '{"a":{"b":1}}'],
  ];
  for (const [cut, closed] of cases) assert.equal(closeJson(cut), closed, JSON.stringify(cut));
  assert.throws(() => closeJson("{a"), /not the start of a JSON text/);
  assert.throws(() => closeJson("x"), /not the start of a JSON text/);
  assert.throws(() => closeJson("[1 2"), /not the start of a JSON text/);
});

test("closeJson gives a JSON text for every prefix of a JSON text, and the same value for the whole text", async () => {
  await forAll(
    gen.tuple(gen.json(), gen.bool),
    ([value, pretty]) => {
      const text = pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value);
      for (let k = 0; k < text.length; k++) {
        const closed = closeJson(text.slice(0, k));
        if (closed !== undefined) JSON.parse(closed);
      }
      assert.deepEqual(JSON.parse(closeJson(text)!), value);
    },
    { runs: 300, label: "closeJson on prefixes" },
  );
});
