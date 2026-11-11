#!/usr/bin/env node
// Writes the static Claude Code workflow run under ./workflow/projects that the
// task workflow-agent-cost imports. Synthetic: no real session content.
//
//   node make-workflow.mjs        rewrites ./workflow (commit the result)
//
// Layout, as Claude Code v2.1.x writes a workflow run:
//   projects/<slug>/<sid>/subagents/workflows/<runId>/journal.jsonl
//   projects/<slug>/<sid>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json)
//   projects/<slug>/<sid>/workflows/<runId>.json
// The run "review" has three phases: Find (three parallel agents), Fix (two
// agents) and Verify (one agent). Every model call reports its own cost, so the
// per-agent costs below are the answers; the task file repeats them.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "workflow", "projects");
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const SID = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const SLUG = "-work-demo";
const RUN = "wf_review0001";
const MODEL = "claude-sonnet-4-5";

const AGENTS = [
  { id: "a0", label: "find-bugs", phase: "Find", start: 0, end: 10_000, costUsd: 0.12, result: { findings: [{ file: "src/a.ts", line: 10, summary: "off by one" }] } },
  { id: "a1", label: "find-races", phase: "Find", start: 100, end: 20_000, costUsd: 0.21, result: { findings: [{ file: "src/b.ts", line: 40, summary: "race on counter" }] } },
  { id: "a2", label: "find-leaks", phase: "Find", start: 200, end: 30_000, costUsd: 0.34, result: { findings: [] } },
  { id: "a3", label: "fix-0", phase: "Fix", start: 31_000, end: 36_000, costUsd: 0.06, result: { patched: "src/a.ts" } },
  { id: "a4", label: "fix-1", phase: "Fix", start: 31_100, end: 41_000, costUsd: 0.07, result: { patched: "src/b.ts" } },
  { id: "a5", label: "verify", phase: "Verify", start: 42_000, end: 50_000, costUsd: 0.15, result: { ok: true } },
];

const SCRIPT = `export const meta = { name: "review" };
export default async function run(args) {
  phase("Find");
  const found = await parallel([
    () => agent({ label: "find-bugs", prompt: "Find bugs in " + args.target }),
    () => agent({ label: "find-races", prompt: "Find races in " + args.target }),
    () => agent({ label: "find-leaks", prompt: "Find leaks in " + args.target }),
  ]);
  phase("Fix");
  await parallel(found.slice(0, 2).map((f, i) => () => agent({ label: \`fix-\${i}\`, prompt: "Fix " + f })));
  phase("Verify");
  return agent({ label: "verify", prompt: "Run the tests" });
}
`;

const iso = (ms) => new Date(T0 + ms).toISOString();

function transcript(a) {
  const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.319", gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: true, agentId: a.id };
  return (
    [
      { ...base, type: "user", uuid: `${a.id}-u0`, parentUuid: null, timestamp: iso(a.start), message: { role: "user", content: `Task: ${a.label}` } },
      { ...base, type: "assistant", uuid: `${a.id}-a1`, parentUuid: null, timestamp: iso(a.end - 500), message: { id: `msg_${a.id}_1`, type: "message", role: "assistant", model: MODEL, content: [{ type: "tool_use", id: `toolu_${a.id}_1`, name: "StructuredOutput", input: a.result }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: a.costUsd } } },
      { ...base, type: "user", uuid: `${a.id}-u1`, parentUuid: null, timestamp: iso(a.end), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${a.id}_1`, content: "Structured output provided successfully" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
}

rmSync(dirname(OUT), { recursive: true, force: true });
const sessionDir = join(OUT, SLUG, SID);
const runDir = join(sessionDir, "subagents", "workflows", RUN);
mkdirSync(runDir, { recursive: true });
mkdirSync(join(sessionDir, "workflows"), { recursive: true });
const journal = [{ type: "launched", runId: RUN }];
for (const a of AGENTS) journal.push({ type: "started", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase });
for (const a of AGENTS) {
  journal.push({ type: "result", key: `v2:${a.id}`, agentId: a.id, result: a.result, toolsUsed: ["StructuredOutput"], remoteControlDeviceReport: null });
  writeFileSync(join(runDir, `agent-${a.id}.jsonl`), transcript(a));
  writeFileSync(join(runDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: a.label, workflowPhase: a.phase, spawnDepth: 1, pickedEffortModel: MODEL }) + "\n");
}
writeFileSync(join(runDir, "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
writeFileSync(
  join(sessionDir, "workflows", `${RUN}.json`),
  JSON.stringify({
    runId: RUN,
    timestamp: iso(-1000),
    taskId: "task-1",
    script: SCRIPT,
    scriptPath: "/work/demo/.claude/workflows/review.js",
    args: { target: "src" },
    result: { ok: true },
    agentCount: AGENTS.length,
    durationMs: 52_000,
    workflowName: "review",
    status: "completed",
    startTime: T0 - 1000,
    phases: [{ title: "Find", detail: "" }, { title: "Fix", detail: "" }, { title: "Verify", detail: "" }],
    defaultModel: MODEL,
  }) + "\n",
);
process.stdout.write(`${OUT}\n`);
