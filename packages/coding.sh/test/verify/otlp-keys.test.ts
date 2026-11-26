// The OTLP receiver over OTLP/JSON fixture bodies with attributes named as a plain object's own members,
// and with one node changed inside a JSON document that a string attribute holds.
//
// Inputs, for each fixture _otlp.ts FIXTURES names, posted to its route as application/json:
// - at the first attribute list at each position (the attributes of a resource, scope, span, event or log,
//   or a kvlistValue's values): an attribute named each of toString, valueOf, __proto__, constructor,
//   hasOwnProperty, toJSON and then, holding a string, an int, a kvlist of attributes with those names, or
//   an array of that kvlist; and each attribute's value set to that kvlist and to that array
//   (_otlp.ts keyCases);
// - at the first string at each position that holds a JSON object or array (gen_ai.input.messages and
//   the like): each node of that document set to each of null, true, 5, "", "x", [], {} and an object
//   with a member named toString (_otlp.ts innerCases).
//
// Properties: those otlp-any.test.ts lists (_otlp.ts runCases).
//
// Bounds, by CODING_SH_MODEL_BOUND (_otlp.ts says what each bound posts): at 1, the first attribute list
// and the first such string at each position, and every node of each document such a string holds, 2,145
// requests; at n, the first n lists and strings at each position. At 0, the default, every 13th of the
// cases bound 1 posts, 170 requests.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, FIXTURES, innerCases, keyCases, loadFixture, sampled } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

for (const name of FIXTURES) {
  test(`the receiver keeps its contract with attributes of ${name} named as an object's members, and with the JSON its strings hold changed`, async (t) => {
    const f = loadFixture(name);
    await checkCases(t, sampled([...keyCases(f, bound), ...innerCases(f, bound)], bound));
  });
}
