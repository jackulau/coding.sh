// The OTLP receiver over each OTLP/JSON fixture body with one node changed, part 1 of 4.
// This part: otel/agent-runs/turn.json and otel/claude-code-logs.json.
// The fixtures are split between otlp-json-1 to -4.test.ts so each part runs about as long; _otlp.ts
// holds the harness, the contract it checks and the cases.
//
// Inputs: each fixture of the part posted to its route (/v1/traces or /v1/logs) as application/json, with
// one node set to each of null, true, "", "x", [], {}, -1, 1e300, "99999999999999999999999" (past what a
// fixed64 holds) and the number 1e400 (past what a double holds), or left out.
//
// Properties, for every such change (_otlp.ts runCases):
// - the receiver answers 200 or 400, never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 400 stores nothing;
// - every event stored passes ingest's check (core/ingest.ts validEvent) with a ts in the Date range, and
//   events and sessions hold only values JSON keeps as they are.
//
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 1, the first node at each position (a node's path
// with array indexes left out and an attribute named by its key), 4,217 requests; at n, the first n nodes
// at each position. At 0, every 13th of the cases bound 1 posts, from the first, and the FIXED cases below,
// 328 requests. A request goes to a new receiver over an empty in-memory store, unless the one before it
// was refused before it reached the store.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, fixedFor, loadFixture, sampled, valueCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span start or a log time past what fixed64 holds is read as unset, so stored times stay in the Date range.
  'otel/agent-runs/turn.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = 1e+300',
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = 1e+300',
  // A Claude Code log whose duration_ms reaches past what a Date holds leaves its session's times in the Date range.
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",1,"attributes",9,"value","intValue"] = 1e+300',
];

for (const name of ["otel/agent-runs/turn.json", "otel/claude-code-logs.json"]) {
  test(`the receiver keeps its contract with each node of ${name} changed`, async (t) => {
    await checkCases(t, sampled(valueCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)));
  });
}
