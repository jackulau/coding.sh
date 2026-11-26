// The OTLP receiver over a SQLite store, with numbers SQLite cannot give back as they went in, and with
// nodes changed at random, part 1 of 2.
// This part: the second Copilot CLI capture, otel/agent-runs/turn.json, otel/claude-code-traces.json,
// otel/claude-code-logs.json and otel/devin-logs.json. Part 2 holds the other fixtures and the seeded
// cases, so each part runs about as long; _otlp.ts holds the harness, the contract it checks and the cases.
//
// Inputs, each posted to a receiver over a SQLite index of its own (in memory):
// - each fixture _otlp.ts FIXTURES names, as application/json, with the first number or numeric string at
//   each position set to each of 1e17, -1e17, "100000000000000000" (integers past 2^53, which SQLite gives
//   node only as a BigInt), "99999999999999999999999" (past 2^64), 1e300, 1e400 and -1 (_otlp.ts storeCases);
// - seeded (_otlp.ts jsonEdits): a fixture with one to four nodes set to any of those numbers or the values
//   of otlp-json-1.test.ts and otlp-any.test.ts, to a random JSON value, or left out. 10 cases;
//   CODING_SH_PROP_RUNS raises the count, and a failure is shrunk to its smallest case.
//
// Properties (_otlp.ts runCases, whose header states them in full):
// - the receiver answers 200 or 400, never a 5xx or a dropped response, and no throw reaches onError;
// - a request answered 400 stores nothing;
// - the reads the CLI and the viewer make (listSessions, getSession, listEvents, metricRows, mcpCalls,
//   memoryEvents and search) resolve and give values JSON keeps as they are, and the events and sessions
//   they give pass ingest's check with times in the Date range.
//
// Bounds, by CODING_SH_MODEL_BOUND (_otlp.ts says what each bound posts): at 1, the first number at each
// position, 1,064 requests over both parts (595 in this one); at n, the first n at each position. At 0, the
// default, every 13th of the cases bound 1 posts and the FIXED cases below, 58 requests in this part.
import { test } from "node:test";
import { modelBound } from "./_common.ts";
import { checkCases, fixedFor, loadFixture, sampled, STORE_PART_1, storeCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span start or a log time past what fixed64 holds is read as unset, so the store's reads resolve.
  'adapters/copilot-cli/otel/otlp/001-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/agent-runs/turn.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/claude-code-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = "99999999999999999999999"',
  'otel/devin-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = "99999999999999999999999"',
  // A session whose stats hold a number past 2^53 (a token count, a cost, a time to first token) reads back through metricRows.
  'adapters/copilot-cli/otel/otlp/001-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",8,"value","intValue"] = 100000000000000000',
  'otel/agent-runs/turn.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",12,"value","intValue"] = 100000000000000000',
  'otel/claude-code-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",1,"attributes",6,"value","intValue"] = 100000000000000000',
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",1,"attributes",8,"value","doubleValue"] = 100000000000000000',
  // A Claude Code log whose duration_ms reaches past what a Date holds leaves its session's times in the Date range.
  'otel/claude-code-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",1,"attributes",9,"value","intValue"] = 100000000000000000',
];

for (const name of STORE_PART_1) {
  test(`the receiver and the SQLite store keep their contract with each number of ${name} changed`, async (t) => {
    await checkCases(t, sampled(storeCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)), "sqlite");
  });
}
