// The OTLP receiver over each OTLP/JSON fixture body with one node changed, part 4 of 4.
// This part: otel/claude-code-agents-logs.json, otel/genai-semconv.json, the first Copilot CLI capture and
// otel/genai-semconv-agents.json.
// otlp-json-1.test.ts states the inputs, the properties and the bounds; _otlp.ts holds the checks.
// At CODING_SH_MODEL_BOUND=1 the run is 4,806 requests, and at 0, the default, 376.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, fixedFor, loadFixture, sampled, valueCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span start or a log time past what fixed64 holds is read as unset, so stored times stay in the Date range.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = 1e+300',
  'otel/genai-semconv.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  'adapters/copilot-cli/otel/otlp/000-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  'otel/genai-semconv-agents.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  // A Claude Code log whose duration_ms reaches past what a Date holds leaves its session's times in the Date range.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",10,"value","intValue"] = 1e+300',
];

for (const name of ["otel/claude-code-agents-logs.json", "otel/genai-semconv.json", "adapters/copilot-cli/otel/otlp/000-traces.json", "otel/genai-semconv-agents.json"]) {
  test(`the receiver keeps its contract with each node of ${name} changed`, async (t) => {
    await checkCases(t, sampled(valueCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)));
  });
}
