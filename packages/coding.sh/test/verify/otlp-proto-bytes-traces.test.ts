// The OTLP receiver over a protobuf encoding of traces with each byte changed. otlp-proto-bytes-logs.test.ts
// does the same for logs.
//
// Inputs: a trace fixture of _otlp.ts FIXTURES, encoded as protobuf (test/otel/_encode.ts) and posted to
// /v1/traces as application/x-protobuf, with each byte set to 0x00 and to 0xff, and with its low bit and its
// high bit flipped (_otlp.ts byteCases): each tag, length, varint, fixed64 and string byte changed so a field
// changes its number or wire type, a length reaches past the body or short of its field, a varint ends early
// or runs on, and a string stops being UTF-8.
//
// Properties, for every such body (_otlp.ts runCases, whose header states them in full):
// - the receiver answers 200 or 400, never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 400 stores nothing;
// - every event stored passes ingest's check (core/ingest.ts validEvent) with a ts in the Date range, and
//   events and sessions hold only values JSON keeps as they are.
//
// Bounds, by CODING_SH_MODEL_BOUND: at 1, every byte of the shortest trace encoding (the first Copilot CLI
// capture, 935 bytes), 3,729 requests; at 2 or more, every byte of each trace fixture's encoding. At 0, the
// default, every 13th of the cases bound 1 posts, 287 requests.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { bytesFixtures } from "./_otlp-bytes.ts";
import { byteCases, checkCases, sampled } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

for (const f of bytesFixtures("/v1/traces", bound)) {
  test(`the receiver keeps its contract with each byte of the protobuf encoding of ${f.name} changed`, async (t) => {
    await checkCases(t, sampled(byteCases(f), bound));
  });
}
