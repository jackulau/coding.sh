// The OTLP receiver over each OTLP/JSON fixture body with one node changed, part 3 of 4.
// This part: otel/openinference.json, otel/claude-code-traces.json and otel/vercel-ai.json.
// otlp-json-1.test.ts states the inputs, the properties and the bounds; _otlp.ts holds the checks.
// At CODING_SH_MODEL_BOUND=1 the run is 3,989 requests, and at 0, the default, 311.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, fixedFor, loadFixture, sampled, valueCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span start past what fixed64 holds is read as unset, so stored times stay in the Date range.
  'otel/openinference.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  'otel/claude-code-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  'otel/vercel-ai.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
];

for (const name of ["otel/openinference.json", "otel/claude-code-traces.json", "otel/vercel-ai.json"]) {
  test(`the receiver keeps its contract with each node of ${name} changed`, async (t) => {
    await checkCases(t, sampled(valueCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)));
  });
}
