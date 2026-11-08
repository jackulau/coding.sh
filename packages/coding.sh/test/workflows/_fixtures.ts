// Synthetic workflow fixtures (no real user content, never read from ~/.claude).
//
// writeClaudeWorkflowFixture lays out a Claude Code projects dir the way
// Claude Code v2.1.x writes workflow runs:
//   <projects>/<slug>/<sid>/subagents/workflows/<runId>/journal.jsonl
//   <projects>/<slug>/<sid>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json)
//   <projects>/<slug>/<sid>/workflows/<runId>.json
// The base run "review" has three phases: Find (three parallel agents behind a
// barrier), Fix (a two-item, two-stage pipeline), Verify (one agent returning
// null, one agent whose first StructuredOutput call fails schema validation).
// The resumed run replays Find and Fix from the cache and runs Verify live.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
export const SID = "11111111-2222-4333-8444-555555555555";
export const SLUG = "-work-demo";
export const RUN = "wf_base0001";
export const RESUMED = "wf_resume001";

const iso = (ms: number) => new Date(ms).toISOString();

export interface AgentSpec {
  id: string;
  label: string;
  phase: string;
  start: number;
  end: number;
  /** Agent return value (null → a null agent). */
  result: unknown;
  /** First StructuredOutput call fails schema validation. */
  schemaRetry?: boolean;
  group?: { id: string; kind: "parallel" | "pipeline"; stage?: number; item?: number };
  costUsd?: number;
}

export const SCRIPT = `export const meta = { name: "review" };
export default async function run(args) {
  phase("Find");
  const found = await parallel([
    () => agent({ label: "find-a", prompt: "Find bugs in " + args.target, schema: Findings }),
    () => agent({ label: "find-b", prompt: "Find races in " + args.target, schema: Findings }),
    () => agent({ label: "find-c", prompt: "Find leaks in " + args.target, schema: Findings }),
  ]);
  phase("Fix");
  const fixed = await pipeline(found.slice(0, 2), [
    (f, i) => agent({ label: \`fix-\${i}\`, prompt: "Fix " + f }),
    (f, i) => agent({ label: \`check-\${i}\`, prompt: "Check " + f }),
  ]);
  phase("Verify");
  const nul = await agent({ label: "verify-null", prompt: "Verify" });
  const final = await agent({ label: "verify-schema", prompt: "Summarize", schema: Report });
  return final;
}
`;

export const AGENTS: AgentSpec[] = [
  { id: "a0", label: "find-a", phase: "Find", start: T0 + 0, end: T0 + 10_000, result: { findings: [{ file: "src/a.ts", line: 10, summary: "off by one" }] }, costUsd: 0.1 },
  { id: "a1", label: "find-b", phase: "Find", start: T0 + 100, end: T0 + 20_000, result: { findings: [{ file: "src/b.ts", line: 40, summary: "race" }] }, costUsd: 0.2 },
  { id: "a2", label: "find-c", phase: "Find", start: T0 + 200, end: T0 + 30_000, result: { findings: [] }, costUsd: 0.3 },
  { id: "a3", label: "fix-0", phase: "Fix", start: T0 + 31_000, end: T0 + 36_000, result: "patched a", group: { id: "fix", kind: "pipeline", stage: 0, item: 0 }, costUsd: 0.05 },
  { id: "a4", label: "fix-1", phase: "Fix", start: T0 + 31_100, end: T0 + 41_000, result: "patched b", group: { id: "fix", kind: "pipeline", stage: 0, item: 1 }, costUsd: 0.05 },
  { id: "a5", label: "check-0", phase: "Fix", start: T0 + 36_500, end: T0 + 40_000, result: "ok a", group: { id: "fix", kind: "pipeline", stage: 1, item: 0 }, costUsd: 0.05 },
  { id: "a6", label: "check-1", phase: "Fix", start: T0 + 41_500, end: T0 + 45_000, result: "ok b", group: { id: "fix", kind: "pipeline", stage: 1, item: 1 }, costUsd: 0.05 },
  { id: "a7", label: "verify-null", phase: "Verify", start: T0 + 46_000, end: T0 + 50_000, result: null, costUsd: 0.1 },
  { id: "a8", label: "verify-schema", phase: "Verify", start: T0 + 50_500, end: T0 + 55_000, result: { findings: [{ file: "src/a.ts", line: 11, summary: "off by one" }] }, schemaRetry: true, costUsd: 0.1 },
];

export const RUN_OUTPUT = {
  findings: [
    { file: "src/a.ts", line: 11, summary: "off by one in loop" },
    { file: "src/b.ts", line: 40, summary: "race on counter" },
    { file: "src/c.ts", line: 99, summary: "spurious" },
  ],
  candidates: [
    { file: "src/a.ts", line: 11, summary: "off by one in loop", survived: true, votes: [true, true] },
    { file: "src/b.ts", line: 40, summary: "race on counter", survived: false, votes: [false, true] },
    { file: "src/c.ts", line: 99, summary: "spurious", survived: true, votes: [true, false] },
    { file: "src/d.ts", line: 5, summary: "also spurious", survived: false, votes: [false, false] },
  ],
};

function transcript(a: AgentSpec, sid: string): string {
  const base = { sessionId: sid, cwd: "/work/demo", version: "2.1.319", gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: true, agentId: a.id };
  const usage = (i: number, o: number, cost?: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(cost !== undefined ? { cost_usd: cost } : {}) });
  const lines: unknown[] = [{ ...base, type: "user", uuid: `${a.id}-u0`, parentUuid: null, timestamp: iso(a.start), message: { role: "user", content: `Task: ${a.label}` } }];
  const mid = a.start + Math.floor((a.end - a.start) / 3);
  // This run reports a cost on every call, so the retry carries one too (a share
  // of the agent's cost); the agent's total is unchanged.
  const retryCost = a.schemaRetry && a.costUsd !== undefined ? a.costUsd / 5 : undefined;
  if (a.schemaRetry) {
    lines.push(
      { ...base, type: "assistant", uuid: `${a.id}-a1`, parentUuid: null, timestamp: iso(mid), message: { id: `msg_${a.id}_1`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `toolu_${a.id}_1`, name: "StructuredOutput", input: { bad: true } }], stop_reason: "tool_use", usage: usage(500, 50, retryCost) } },
      { ...base, type: "user", uuid: `${a.id}-u1`, parentUuid: null, timestamp: iso(mid + 100), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${a.id}_1`, content: "Output does not match schema: findings is required", is_error: true }] } },
    );
  }
  const t2 = a.end - 500;
  const finalCost = retryCost !== undefined && a.costUsd !== undefined ? a.costUsd - retryCost : a.costUsd;
  lines.push(
    { ...base, type: "assistant", uuid: `${a.id}-a2`, parentUuid: null, timestamp: iso(t2), message: { id: `msg_${a.id}_2`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `toolu_${a.id}_2`, name: "StructuredOutput", input: a.result ?? {} }], stop_reason: "tool_use", usage: usage(1000, 100, finalCost) } },
    { ...base, type: "user", uuid: `${a.id}-u2`, parentUuid: null, timestamp: iso(a.end), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${a.id}_2`, content: "Structured output provided successfully" }] } },
  );
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function writeRun(projects: string, runId: string, opts: { agents: AgentSpec[]; cachedPrefix?: AgentSpec[]; resumeFrom?: string; record: Record<string, unknown> }): string {
  const sessionDir = join(projects, SLUG, SID);
  const runDir = join(sessionDir, "subagents", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  const journal: unknown[] = [{ type: "launched", runId, ...(opts.resumeFrom ? { resumeFromRunId: opts.resumeFrom } : {}) }];
  for (const a of opts.cachedPrefix ?? []) journal.push({ type: "result", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase, result: a.result, toolsUsed: ["StructuredOutput"] });
  for (const a of opts.agents) {
    journal.push({ type: "started", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase, ...(a.group ? { group: a.group } : {}) });
  }
  for (const a of opts.agents) {
    journal.push({ type: "result", key: `v2:${a.id}`, agentId: a.id, result: a.result, toolsUsed: ["StructuredOutput"], remoteControlDeviceReport: null });
    writeFileSync(join(runDir, `agent-${a.id}.jsonl`), transcript(a, SID));
    writeFileSync(join(runDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: a.label, workflowPhase: a.phase, spawnDepth: 1, pickedEffortModel: "claude-sonnet-4-5" }));
  }
  writeFileSync(join(runDir, "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
  writeFileSync(join(sessionDir, "workflows", `${runId}.json`), JSON.stringify({ runId, ...opts.record }));
  return runDir;
}

/** Writes the base run and the resumed run; returns their run dirs. */
export function writeClaudeWorkflowFixture(projects: string): { base: string; resumed: string; sessionDir: string } {
  const record = (start: number, duration: number) => ({
    timestamp: iso(start),
    taskId: "task-1",
    script: SCRIPT,
    scriptPath: "/work/demo/.claude/workflows/review.js",
    args: { target: "src" },
    result: RUN_OUTPUT,
    agentCount: AGENTS.length,
    durationMs: duration,
    workflowName: "review",
    status: "completed",
    startTime: start,
    phases: [{ title: "Find", detail: "" }, { title: "Fix", detail: "" }, { title: "Verify", detail: "" }],
    defaultModel: "claude-sonnet-4-5",
  });
  const base = writeRun(projects, RUN, { agents: AGENTS, record: record(T0 - 1000, 57_000) });
  // Resumed: the first seven calls come back from the cache; Verify runs live, an hour later.
  const H = 3_600_000;
  const live = AGENTS.slice(7).map((a) => ({ ...a, id: `r${a.id}`, start: a.start + H, end: a.end + H }));
  const resumed = writeRun(projects, RESUMED, { agents: live, cachedPrefix: AGENTS.slice(0, 7), resumeFrom: RUN, record: record(T0 + H + 45_000, 11_000) });
  return { base, resumed, sessionDir: join(projects, SLUG, SID) };
}

// ------------------------------------------------------------ a run resumed in place

// Claude Code resumes a stopped workflow in the same run dir: the journal keeps growing (one
// "launched" line, no timestamps), the record holds only the last segment, and calls the last
// segment replayed from the journal are marked `cached` in its workflowProgress.
//
//   segment 1  0s–30s   plan (Plan); review-x, review-y (Review); the operator stops review-y
//   segment 2  40s–50s  qa-one, qa-two (QA); the operator stops both
//   segment 3  60s–100s the script dropped Review; plan replays from the journal, qa-one and
//                       qa-two run again, then fix (Fix)
export const INPLACE = "wf_inplace01";
export const T1 = Date.UTC(2026, 10, 2, 9, 0, 0);
const S = 1000;

interface InPlaceSpec extends AgentSpec {
  /** No result line: the transcript ends with the operator's interrupt. */
  stopped?: "[Request interrupted by user]" | "[Request interrupted by user for tool use]";
  /** Replayed from the journal in the last segment (record workflowProgress cached: true). */
  replayed?: boolean;
  /** Runs in the last segment (record workflowProgress has it). */
  last?: boolean;
}

export const INPLACE_AGENTS: InPlaceSpec[] = [
  { id: "p0", label: "plan", phase: "Plan", start: T1, end: T1 + 10 * S, result: { steps: 2 }, costUsd: 0.4, replayed: true },
  { id: "r0", label: "review-x", phase: "Review", start: T1 + 11 * S, end: T1 + 20 * S, result: { findings: [] }, costUsd: 0.1 },
  { id: "r1", label: "review-y", phase: "Review", start: T1 + 11 * S, end: T1 + 30 * S, result: null, costUsd: 0.1, stopped: "[Request interrupted by user]" },
  { id: "q0", label: "qa-one", phase: "QA", start: T1 + 40 * S, end: T1 + 50 * S, result: null, costUsd: 0.05, stopped: "[Request interrupted by user for tool use]" },
  { id: "q1", label: "qa-two", phase: "QA", start: T1 + 40 * S, end: T1 + 50 * S, result: null, costUsd: 0.05, stopped: "[Request interrupted by user for tool use]" },
  { id: "q2", label: "qa-one", phase: "QA", start: T1 + 61 * S, end: T1 + 80 * S, result: { findings: [{ file: "src/a.ts", line: 1, summary: "a" }, { file: "src/b.ts", line: 2, summary: "b" }] }, costUsd: 0.2, last: true },
  { id: "q3", label: "qa-two", phase: "QA", start: T1 + 61 * S, end: T1 + 75 * S, result: { findings: [] }, costUsd: 0.2, last: true },
  { id: "f0", label: "fix", phase: "Fix", start: T1 + 81 * S, end: T1 + 100 * S, result: "patched", costUsd: 0.3, last: true },
];

function stoppedTranscript(a: InPlaceSpec, sid: string): string {
  const base = { sessionId: sid, cwd: "/work/demo", version: "2.1.319", userType: "external", isSidechain: true, agentId: a.id };
  const mid = a.start + Math.floor((a.end - a.start) / 2);
  return (
    [
      { ...base, type: "user", uuid: `${a.id}-u0`, parentUuid: null, timestamp: iso(a.start), message: { role: "user", content: `Task: ${a.label}` } },
      { ...base, type: "assistant", uuid: `${a.id}-a1`, parentUuid: null, timestamp: iso(mid), message: { id: `msg_${a.id}_1`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: `toolu_${a.id}_1`, name: "Bash", input: { command: "npm test" } }], stop_reason: "tool_use", usage: { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: a.costUsd } } },
      { ...base, type: "user", uuid: `${a.id}-u1`, parentUuid: null, timestamp: iso(a.end), message: { role: "user", content: [{ type: "text", text: a.stopped }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
}

/** Writes the run resumed in place; returns its run dir. */
export function writeInPlaceFixture(projects: string): string {
  const sessionDir = join(projects, SLUG, SID);
  const runDir = join(sessionDir, "subagents", "workflows", INPLACE);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  // Journal lines in the order the run wrote them (starts of a group, then its results).
  const started = (a: InPlaceSpec) => ({ type: "started", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase });
  const result = (a: InPlaceSpec) => ({ type: "result", key: `v2:${a.id}`, agentId: a.id, result: a.result, toolsUsed: ["StructuredOutput"], remoteControlDeviceReport: false });
  const [p0, r0, r1, q0, q1, q2, q3, f0] = INPLACE_AGENTS as [InPlaceSpec, InPlaceSpec, InPlaceSpec, InPlaceSpec, InPlaceSpec, InPlaceSpec, InPlaceSpec, InPlaceSpec];
  const journal = [{ type: "launched" }, started(p0), result(p0), started(r0), started(r1), result(r0), started(q0), started(q1), started(q2), started(q3), result(q3), result(q2), started(f0), result(f0)];
  writeFileSync(join(runDir, "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
  for (const a of INPLACE_AGENTS) {
    writeFileSync(join(runDir, `agent-${a.id}.jsonl`), a.stopped ? stoppedTranscript(a, SID) : transcript(a, SID));
    writeFileSync(join(runDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: a.label, workflowPhase: a.phase }));
  }
  const segStart = T1 + 60 * S;
  const progress: unknown[] = [
    { type: "workflow_phase", index: 1, title: "Plan" },
    { type: "workflow_phase", index: 2, title: "QA" },
    { type: "workflow_phase", index: 3, title: "Fix" },
  ];
  let index = 1;
  for (const a of INPLACE_AGENTS) {
    if (a.replayed) progress.push({ type: "workflow_agent", index: index++, label: a.label, phaseTitle: a.phase, agentId: a.id, state: "done", startedAt: segStart, lastProgressAt: segStart, cached: true });
    else if (a.last) progress.push({ type: "workflow_agent", index: index++, label: a.label, phaseTitle: a.phase, agentId: a.id, state: "done", startedAt: a.start, lastProgressAt: a.end, durationMs: a.end - a.start });
  }
  const record = {
    runId: INPLACE,
    timestamp: iso(T1 + 100 * S),
    script: `phase("Plan"); phase("QA"); phase("Fix");`,
    scriptPath: "/work/demo/.claude/workflows/improve.js",
    durationMs: 40 * S,
    workflowName: "improve",
    status: "completed",
    startTime: segStart,
    // The last segment's script: Review was removed before the final resume.
    phases: [{ title: "Plan" }, { title: "QA" }, { title: "Fix" }],
    workflowProgress: progress,
  };
  writeFileSync(join(sessionDir, "workflows", `${INPLACE}.json`), JSON.stringify(record));
  return runDir;
}

// ------------------------------------------------------------ OTLP JSON

type AttrValue = string | number | boolean;

function attr(key: string, v: AttrValue) {
  if (typeof v === "string") return { key, value: { stringValue: v } };
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
}

export interface SpanSpec {
  id: string;
  parent?: string;
  name: string;
  /** ms offsets from T0. */
  start: number;
  end: number;
  attrs?: Record<string, AttrValue>;
  error?: string;
}

const nano = (ms: number) => `${BigInt(T0 + ms) * 1_000_000n}`;

/** One OTLP/JSON trace export from a single scope. Span ids are padded to 16 hex chars. */
export function otlp(traceId: string, scope: string, service: string, spans: SpanSpec[]): Record<string, unknown> {
  const sid = (s: string) => s.padStart(16, "0");
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", service)] },
        scopeSpans: [
          {
            scope: { name: scope, version: "1.0.0" },
            spans: spans.map((s) => ({
              traceId,
              spanId: sid(s.id),
              ...(s.parent ? { parentSpanId: sid(s.parent) } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: nano(s.start),
              endTimeUnixNano: nano(s.end),
              attributes: Object.entries(s.attrs ?? {}).map(([k, v]) => attr(k, v)),
              ...(s.error ? { status: { code: 2, message: s.error } } : {}),
            })),
          },
        ],
      },
    ],
  };
}

const chat = (id: string, parent: string, start: number, end: number, model = "gpt-4o", inTok = 100, outTok = 20): SpanSpec => ({
  id,
  parent,
  name: `chat ${model}`,
  start,
  end,
  attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": model, "gen_ai.response.model": model, "gen_ai.usage.input_tokens": inTok, "gen_ai.usage.output_tokens": outTok },
});

/** OpenAI Agents SDK: triage agent hands off to a billing agent, which calls a tool. */
export const HANDOFF_TRACE = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export function agentsSdkHandoff(): Record<string, unknown> {
  return otlp(HANDOFF_TRACE, "openai.agents", "support-bot", [
    { id: "1", name: "Support workflow", start: 0, end: 9000, attrs: { "gen_ai.operation.name": "invoke_workflow" } },
    { id: "2", parent: "1", name: "invoke_agent triage", start: 100, end: 3000, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "triage" } },
    chat("3", "2", 200, 2500),
    { id: "4", parent: "1", name: "handoff triage -> billing", start: 3000, end: 3050, attrs: { "handoff.from_agent": "triage", "handoff.to_agent": "billing" } },
    { id: "5", parent: "1", name: "invoke_agent billing", start: 3100, end: 8900, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "billing" } },
    chat("6", "5", 3200, 5000, "gpt-4o", 300, 40),
    { id: "7", parent: "5", name: "execute_tool lookup_invoice", start: 5000, end: 6000, attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup_invoice" } },
    chat("8", "5", 6100, 8800, "gpt-4o", 400, 60),
  ]);
}

/** LangGraph: plan → (research ∥ draft) → review, each node a chain span with langgraph_node metadata. */
export const GRAPH_TRACE = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export function langGraph(): Record<string, unknown> {
  const node = (id: string, name: string, step: number, start: number, end: number): SpanSpec => ({
    id,
    parent: "1",
    name,
    start,
    end,
    attrs: { "openinference.span.kind": "CHAIN", metadata: JSON.stringify({ langgraph_node: name, langgraph_step: step }) },
  });
  return otlp(GRAPH_TRACE, "openinference.instrumentation.langchain", "graph-app", [
    { id: "1", name: "LangGraph", start: 0, end: 12_000, attrs: { "openinference.span.kind": "CHAIN" } },
    node("2", "plan", 1, 100, 2000),
    chat("3", "2", 200, 1900),
    node("4", "research", 2, 2100, 8000),
    chat("5", "4", 2200, 7900, "gpt-4o", 500, 100),
    node("6", "draft", 2, 2150, 6000),
    chat("7", "6", 2250, 5900),
    node("8", "review", 3, 8100, 11_900),
    chat("9", "8", 8200, 11_800),
  ]);
}

// ------------------------------------------------------------ cases

export const BUG_PATCH = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function last(xs: number[]) {
-  return xs[xs.length - 1];
+  return xs[xs.length];
 }
`;

/**
 * evals/workflows/review/cases: seeded-1 (dev, inline bugs + a patch file),
 * seeded-2 (heldout, bugs in a hidden JSON file), verify-1 (dev, verifier).
 * RUN_OUTPUT finds b1 and b2 of seeded-1 plus one spurious finding.
 */
export function writeReviewCases(dir: string): void {
  mkdirSync(join(dir, "bugs"), { recursive: true });
  mkdirSync(join(dir, "..", "hidden"), { recursive: true });
  writeFileSync(join(dir, "bugs", "b1.patch"), BUG_PATCH);
  writeFileSync(
    join(dir, "seeded-1.toml"),
    `id = "seeded-1"
split = "dev"
args = '{"target":"src","seeded":"seeded-1"}'
threshold = 0.5

[truth]
kind = "seeded-bugs"

[[truth.bugs]]
id = "b1"
file = "src/a.ts"
lines = [10, 12]
category = "logic"
severity = "P0"
patch = "bugs/b1.patch"

[[truth.bugs]]
id = "b2"
file = "src/b.ts"
lines = [40, 40]
category = "concurrency"
severity = "P1"

[[truth.bugs]]
id = "b3"
file = "src/e.ts"
lines = [1, 3]
category = "leak"
severity = "P2"
`,
  );
  writeFileSync(join(dir, "..", "hidden", "seeded-2.json"), JSON.stringify({ bugs: [{ id: "h1", file: "src/b.ts", lines: [41, 41], category: "logic", severity: "P1" }] }));
  writeFileSync(
    join(dir, "seeded-2.toml"),
    `id = "seeded-2"
split = "heldout"

[args]
target = "lib"

[truth]
kind = "seeded-bugs"
file = "../hidden/seeded-2.json"
`,
  );
  writeFileSync(
    join(dir, "verify-1.toml"),
    `id = "verify-1"
split = "dev"
[truth]
kind = "verifier"
command = "exit 0"
`,
  );
}
