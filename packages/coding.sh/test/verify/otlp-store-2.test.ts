// The OTLP receiver over a SQLite store, with numbers SQLite cannot give back as they went in, and with
// nodes changed at random, part 2 of 2.
// This part: the fixtures of _otlp.ts FIXTURES that part 1 (_otlp.ts STORE_PART_1) leaves out, and the
// seeded cases. otlp-store-1.test.ts states the inputs, the properties and the bounds; _otlp.ts holds the
// checks. At CODING_SH_MODEL_BOUND=1 the run is 469 requests, and at 0, the default, 53; then 10 seeded
// cases.
import { test } from "node:test";
import { forAll } from "../_prop.ts";
import { modelBound } from "./_common.ts";
import { answerList, checkCases, checkOne, editedCase, FIXTURES, fixedFor, jsonEdits, loadFixture, sampled, STORE_PART_1, storeCases } from "./_otlp.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

// The first case that showed each problem these checks found, posted at every bound.
const FIXED = [
  // A span start or a log time past what fixed64 holds is read as unset, so the store's reads resolve.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = "99999999999999999999999"',
  'otel/codex-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"timeUnixNano"] = "99999999999999999999999"',
  'otel/genai-semconv-agents.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/genai-semconv.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/openinference.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'otel/vercel-ai.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  'adapters/copilot-cli/otel/otlp/000-traces.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"startTimeUnixNano"] = "99999999999999999999999"',
  // A session whose stats hold a number past 2^53 (a token count) reads back through metricRows.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",5,"value","intValue"] = 100000000000000000',
  'otel/codex-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",0,"attributes",6,"value","stringValue"] = 100000000000000000',
  'otel/genai-semconv-agents.json ["resourceSpans",0,"scopeSpans",0,"spans",1,"attributes",3,"value","intValue"] = 100000000000000000',
  'otel/genai-semconv.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",4,"value","intValue"] = 100000000000000000',
  'otel/openinference.json ["resourceSpans",0,"scopeSpans",0,"spans",2,"attributes",4,"value","intValue"] = 100000000000000000',
  'otel/vercel-ai.json ["resourceSpans",0,"scopeSpans",0,"spans",0,"attributes",14,"value","intValue"] = 100000000000000000',
  // A Claude Code log whose duration_ms reaches past what a Date holds leaves its session's times in the Date range.
  'otel/claude-code-agents-logs.json ["resourceLogs",0,"scopeLogs",0,"logRecords",2,"attributes",10,"value","intValue"] = 100000000000000000',
];

for (const name of FIXTURES.filter((n) => !STORE_PART_1.includes(n))) {
  test(`the receiver and the SQLite store keep their contract with each number of ${name} changed`, async (t) => {
    await checkCases(t, sampled(storeCases(loadFixture(name), bound), bound, fixedFor(FIXED, name)), "sqlite");
  });
}

test("the receiver and the SQLite store keep their contract with nodes of a fixture changed at random", async (t) => {
  const fixtures = FIXTURES.map(loadFixture);
  const answers: Record<string, number> = {};
  const r = await forAll(jsonEdits(fixtures), (v) => checkOne(editedCase(fixtures, v), "sqlite", answers), { label: "otlp json edits on sqlite", runs: 10 });
  t.diagnostic(`${r.runs} seeded cases (seed ${r.seed}); answers ${answerList(answers)}`);
});
