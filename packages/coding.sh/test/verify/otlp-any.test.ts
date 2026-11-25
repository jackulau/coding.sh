// The OTLP receiver over each OTLP/JSON fixture body with one attribute value changed.
//
// Inputs: each fixture _otlp.ts FIXTURES names, posted to its route as application/json, with the first
// attribute value (an OTLP AnyValue) at each position set to each of _otlp.ts ANY_VALUES: an empty string,
// strings holding {}, [] or a message whose text is a number, int64s of 2^53 + 1, -1 and 1e300, doubles of
// NaN, -Infinity, 1e400 and -1, a bool, an arrayValue, a kvlistValue, bytes, and an AnyValue with no value.
//
// Properties, for every such change (_otlp.ts runCases, whose header states them in full):
// - the receiver answers 200 or 400, never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 400 stores nothing;
// - every event stored passes ingest's check (core/ingest.ts validEvent) with a ts in the Date range, and
//   events and sessions hold only values JSON keeps as they are.
//
// Bounds, by CODING_SH_MODEL_BOUND (_otlp.ts says what each bound posts): at 1, the first attribute value
// at each position (otlp-json-1.test.ts says what a position is), 5,232 requests; at n, the first n. At 0,
// the default, every 13th of the cases bound 1 posts and the FIXED cases below, 417 requests.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { anyCases, checkCases, FIXTURES, fixedFor, loadFixture, sampled } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // An attribute doubleValue of 1e400, which JSON.parse reads as Infinity, is kept as its protojson string.
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",7,"value"] = {"doubleValue":1e400}',
  'otel/codex-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",6,"value"] = {"doubleValue":1e400}',
  'otel/devin-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"body"] = {"doubleValue":1e400}',
  'otel/genai-semconv.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",0,"value"] = {"doubleValue":1e400}',
  'otel/openinference.json ["resourceSpans",0,"scopeSpans",0,"spans",3,"attributes",3,"value"] = {"doubleValue":1e400}',
  'otel/vercel-ai.json ["resourceSpans",0,"scopeSpans",0,"spans",1,"attributes",4,"value"] = {"doubleValue":1e400}',
  'otel/agent-runs/turn.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",6,"value"] = {"doubleValue":1e400}',
  'adapters/copilot-cli/otel/otlp/000-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",0,"value"] = {"doubleValue":1e400}',
  'adapters/copilot-cli/otel/otlp/001-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",0,"value"] = {"doubleValue":1e400}',
  // A Claude Code log whose duration_ms reaches past what a Date holds leaves its session's times in the Date range.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",10,"value"] = {"intValue":"9007199254740993"}',
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",1,"attributes",9,"value"] = {"intValue":"9007199254740993"}',
];

for (const name of FIXTURES) {
  test(`the receiver keeps its contract with each attribute value of ${name} changed`, async (t) => {
    await checkCases(t, sampled(anyCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)));
  });
}
