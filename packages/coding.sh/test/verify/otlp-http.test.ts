// The OTLP receiver's answer to each content type, encoding, Host, Origin, method and route; to bodies past
// its limit; to values nested deeper than its decoders and mappers allow; and to times past what fixed64 or a
// Date holds.
//
// Inputs:
// - each fixture _otlp.ts FIXTURES names with each of the 24 header and route variants of _otlp.ts
//   headerCases (a charset, application/protobuf, text/plain, no content type; gzip, deflate and br, a body
//   said to be compressed and not, content-encoding compress, a gzip stream cut short; JSON said to be
//   protobuf and the reverse; Host and Origin from elsewhere and from localhost; GET, PUT and OPTIONS; a
//   query, a trailing slash, an unknown path), and sent as JSON and as protobuf to each other route;
// - a body of 16 MiB and a byte, and a gzipped body that inflates to that (_otlp.ts limitCases);
// - a chat span whose message attributes (gen_ai.input.messages and nine others a mapper reads as JSON)
//   hold a document nested 3,000, 12,000 and 60,000 deep, in five shapes (_otlp.ts deepCases);
// - a chat span with an attribute that is an arrayValue or a kvlistValue nested 32, 33, 1,000 and 100,000
//   deep, as JSON, and as protobuf up to 1,000 (_otlp.ts nestedCases);
// - a span start and a Claude Code log time, in a trace and not, past what fixed64 holds, negative, and past
//   what a Date holds (_otlp.ts timeCases);
// - a metrics body that is each value of otlp-json-1.test.ts, and whose resourceMetrics, or the first of
//   them, is (_otlp.ts metricsCases).
//
// Properties (_otlp.ts runCases, whose header states them in full):
// - each request gets the answer its headers call for: 415 for a type or an encoding the receiver does not
//   read, 413 past the limit, 403 for a Host or an Origin that is not local, 405 for a method other than
//   POST and OPTIONS, 404 for another path, 400 for a body that does not decode, and 200 or 400 for a
//   change of content; never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 4xx stores nothing;
// - every event stored passes ingest's check (core/ingest.ts validEvent) with a ts in the Date range, and
//   events and sessions hold only values JSON keeps as they are.
//
// Bounds: every variant above but the deep ones. CODING_SH_MODEL_BOUND=1 or more posts every deep case,
// 577 requests in all; at 0, the default, every 13th deep case and the FIXED case below, 440 in all.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, deepCases, FIXTURES, headerCases, limitCases, loadFixture, metricsCases, nestedCases, sampled, timeCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span whose messages are nested 12,000 deep is stored.
  'a span whose gen_ai.output.messages holds {"kwargs": nested 12000 deep',
];

test("the receiver answers each content type, encoding, Host, Origin, method and route as its headers call for", async (t) => {
  await checkCases(t, FIXTURES.flatMap((name) => [...headerCases(loadFixture(name))]));
});

test("the receiver answers 413 to a body past its limit, as sent or once inflated", async (t) => {
  await checkCases(t, limitCases());
});

test("the receiver keeps its contract with message attributes nested thousands deep", async (t) => {
  await checkCases(t, sampled(deepCases([3000, 12000, 60000]), bound, FIXED));
});

test("the receiver keeps its contract with attribute values nested past what its decoders read", async (t) => {
  await checkCases(t, nestedCases([32, 33, 1000, 100000]));
});

test("the receiver keeps its contract with times past what fixed64 or a Date holds", async (t) => {
  await checkCases(t, timeCases());
});

test("the receiver answers 200 or 400 to a metrics body of any shape", async (t) => {
  await checkCases(t, metricsCases());
});
