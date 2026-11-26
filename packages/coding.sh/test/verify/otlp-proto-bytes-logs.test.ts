// The OTLP receiver over a protobuf encoding of logs with each byte changed. otlp-proto-bytes-traces.test.ts
// states the inputs and the properties; this file posts log fixtures to /v1/logs.
//
// Bounds, by CODING_SH_MODEL_BOUND: at 1, every byte of the shortest log encoding
// (otel/claude-code-agents-logs.json, 1,413 bytes), 5,639 requests; at 2 or more, every byte of each log
// fixture's encoding. At 0, the default, every 13th of the cases bound 1 posts, 434 requests.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { bytesFixtures } from "./_otlp-bytes.ts";
import { byteCases, checkCases, sampled } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

for (const f of bytesFixtures("/v1/logs", bound)) {
  test(`the receiver keeps its contract with each byte of the protobuf encoding of ${f.name} changed`, async (t) => {
    await checkCases(t, sampled(byteCases(f), bound));
  });
}
