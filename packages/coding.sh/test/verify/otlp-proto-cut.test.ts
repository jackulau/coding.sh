// The OTLP receiver over each fixture's protobuf encoding cut short, and with bytes set at random.
//
// Inputs: each fixture _otlp.ts FIXTURES names, encoded as protobuf (test/otel/_encode.ts) and posted to its
// route as application/x-protobuf:
// - cut to each length short of its own (_otlp.ts prefixCases): every prefix, 31,698 in all, so a body
//   ends inside each tag, length, varint, fixed64 and string the encoding holds; and each prefix sent to
//   /v1/metrics, whose decoder checks the wire format of any message and keeps nothing;
// - seeded (_otlp.ts byteEdits): one to four bytes at any offsets set to any values, then cut to any length
//   or not, sent to the fixture's route and to /v1/metrics. 25 cases each; CODING_SH_PROP_RUNS raises the
//   count, and a failure is shrunk to its smallest case.
//
// Properties, for every such body (_otlp.ts runCases, whose header states them in full):
// - the receiver answers 200 or 400, never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 400 stores nothing;
// - every event stored passes ingest's check (core/ingest.ts validEvent) with a ts in the Date range, and
//   events and sessions hold only values JSON keeps as they are.
//
// Bounds, by CODING_SH_MODEL_BOUND: at 1 or more, every prefix of every fixture's encoding, to its route and
// to /v1/metrics, 63,396 requests; at 0, the default, every 13th of them, 4,881 requests. 50 seeded cases.
import { test, type TestContext } from "node:test";
import { forAll } from "../_prop.ts";
import { modelBound } from "./_common.ts";
import { answerList, byteEdits, bytesCase, checkCases, checkOne, FIXTURES, loadFixture, prefixCases, sampled, toMetrics, type Case, type Fixture } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

for (const name of FIXTURES) {
  test(`the receiver keeps its contract with the protobuf encoding of ${name} cut to each length`, async (t) => {
    const f = loadFixture(name);
    await checkCases(t, sampled([...prefixCases(f), ...toMetrics(prefixCases(f))], bound));
  });
}

/** Posts the case `toCase` makes of each of 25 byteEdits values; a failure is shrunk to the smallest value that fails. */
async function seeded(t: TestContext, fixtures: readonly Fixture[], label: string, toCase: (c: Case) => Case): Promise<void> {
  const answers: Record<string, number> = {};
  const r = await forAll(byteEdits(fixtures), (v) => checkOne(toCase(bytesCase(fixtures, v)), "mem", answers), { label, runs: 25 });
  t.diagnostic(`${r.runs} seeded cases (seed ${r.seed}); answers ${answerList(answers)}`);
}

test("the receiver keeps its contract with bytes of a fixture's protobuf encoding set at random", async (t) => {
  const fixtures = FIXTURES.map(loadFixture);
  await seeded(t, fixtures, "otlp protobuf byte edits", (c) => c);
  await seeded(t, fixtures, "otlp protobuf byte edits to metrics", (c) => [...toMetrics([c])][0]!);
});
