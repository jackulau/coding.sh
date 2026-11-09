import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseToml } from "../../src/core/toml.ts";
import type { AgentEvent, EvalTask, Session } from "../../src/core/types.ts";
import { ATIF_VERSION, atifFromStore, toAtif, type AtifTrajectory } from "../../src/eval/atif.ts";
import { exportHarbor, harborTaskName } from "../../src/eval/task.ts";
import { assertGolden, FIXTURES } from "../adapters/_helpers.ts";
import { BUGGY, FakeSnapshots, MemBlobs, MemIndex, tempDir } from "../helpers-eval.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const CHILD = `${SID}:sub:abc123`;

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** The claude-code backfill golden (a real transcript capture) as stored events. */
function golden(): AgentEvent[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, "claude-code/golden/backfill.golden.json"), "utf8")) as Omit<AgentEvent, "v" | "agent">[];
  return raw.map((e) => ({ v: 0, agent: "claude-code", ...e }) as AgentEvent);
}

function sessions(events: readonly AgentEvent[]): { root: Session; child: Session } {
  const stats = { events: 0, turns: 2, toolCalls: 4, toolErrors: 1, filesChanged: 1, testsPassed: 3, testsFailed: 1 };
  const root: Session = { id: SID, agent: "claude-code", agentVersion: "2.1.300", model: "claude-opus-4-5", cwd: "/work/demo", startedAt: Math.min(...events.filter((e) => e.sessionId === SID).map((e) => e.ts)), stats, flags: ["compaction"] };
  const child: Session = { id: CHILD, agent: "claude-code", agentVersion: "2.1.300", startedAt: events.find((e) => e.sessionId === CHILD)!.ts, stats: { ...stats, turns: 1 }, flags: [], parent: { sessionId: SID, subagentId: "abc123", type: "Explore" } };
  return { root, child };
}

// Field lists of the ATIF-v1.8 models (harbor-framework/harbor src/harbor/models/trajectories, all extra="forbid").
const FIELDS = {
  trajectory: ["schema_version", "session_id", "trajectory_id", "agent", "steps", "notes", "final_metrics", "continued_trajectory_ref", "extra", "subagent_trajectories"],
  agent: ["name", "version", "model_name", "tool_definitions", "extra"],
  step: ["step_id", "timestamp", "source", "model_name", "reasoning_effort", "message", "reasoning_content", "tool_calls", "observation", "metrics", "is_copied_context", "llm_call_count", "extra"],
  toolCall: ["tool_call_id", "function_name", "arguments", "extra"],
  observation: ["results"],
  result: ["source_call_id", "content", "subagent_trajectory_ref", "extra"],
  ref: ["trajectory_id", "session_id", "trajectory_path", "extra"],
  metrics: ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd", "prompt_token_ids", "completion_token_ids", "logprobs", "extra"],
  final: ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd", "total_steps", "extra"],
};

/** A TypeScript port of the pydantic models' checks: allowed keys, required fields, types and the model validators. */
function validateAtif(t: AtifTrajectory, at = "trajectory"): string[] {
  const errs: string[] = [];
  const keys = (o: object, allowed: string[], where: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${where}.${k}: not an ATIF field`);
    for (const [k, v] of Object.entries(o)) if (v === null) errs.push(`${where}.${k}: null (omit it)`);
  };
  keys(t, FIELDS.trajectory, at);
  if (!/^ATIF-v1\.[0-8]$/.test(t.schema_version)) errs.push(`${at}.schema_version`);
  keys(t.agent, FIELDS.agent, `${at}.agent`);
  if (typeof t.agent.name !== "string" || typeof t.agent.version !== "string") errs.push(`${at}.agent: name and version are required`);
  if (!Array.isArray(t.steps) || !t.steps.length) errs.push(`${at}.steps: at least one`);
  for (const [i, s] of t.steps.entries()) {
    const w = `${at}.steps[${i}]`;
    keys(s, FIELDS.step, w);
    if (s.step_id !== i + 1) errs.push(`${w}.step_id: expected ${i + 1}`);
    if (!["system", "user", "agent"].includes(s.source)) errs.push(`${w}.source`);
    if (typeof s.message !== "string") errs.push(`${w}.message: required`);
    if (s.timestamp !== undefined && Number.isNaN(Date.parse(s.timestamp))) errs.push(`${w}.timestamp`);
    if (s.source !== "agent") for (const f of ["model_name", "reasoning_effort", "reasoning_content", "tool_calls", "metrics"] as const) if ((s as unknown as Record<string, unknown>)[f] !== undefined) errs.push(`${w}.${f}: agent steps only`);
    if (s.llm_call_count === 0 && s.metrics) errs.push(`${w}: metrics with llm_call_count 0`);
    const ids = new Set<string>();
    for (const [j, c] of (s.tool_calls ?? []).entries()) {
      keys(c, FIELDS.toolCall, `${w}.tool_calls[${j}]`);
      if (typeof c.tool_call_id !== "string" || typeof c.function_name !== "string" || !c.arguments || typeof c.arguments !== "object" || Array.isArray(c.arguments)) errs.push(`${w}.tool_calls[${j}]: shape`);
      ids.add(c.tool_call_id);
    }
    if (s.observation) {
      keys(s.observation, FIELDS.observation, `${w}.observation`);
      for (const [j, r] of s.observation.results.entries()) {
        keys(r, FIELDS.result, `${w}.observation.results[${j}]`);
        if (r.source_call_id !== undefined && !ids.has(r.source_call_id)) errs.push(`${w}.observation.results[${j}].source_call_id: not a tool_call_id of this step`);
        for (const ref of r.subagent_trajectory_ref ?? []) {
          keys(ref, FIELDS.ref, `${w}.observation.results[${j}].subagent_trajectory_ref`);
          if (!ref.trajectory_id && !ref.trajectory_path) errs.push(`${w}: unresolvable subagent ref`);
        }
      }
    }
    if (s.metrics) {
      keys(s.metrics, FIELDS.metrics, `${w}.metrics`);
      for (const [k, v] of Object.entries(s.metrics)) if (k !== "extra" && k !== "cost_usd" && !Number.isInteger(v)) errs.push(`${w}.metrics.${k}: int`);
    }
  }
  if (t.final_metrics) keys(t.final_metrics, FIELDS.final, `${at}.final_metrics`);
  const subIds = new Set<string>();
  for (const [i, sub] of (t.subagent_trajectories ?? []).entries()) {
    if (!sub.trajectory_id) errs.push(`${at}.subagent_trajectories[${i}].trajectory_id: required`);
    else if (subIds.has(sub.trajectory_id)) errs.push(`${at}.subagent_trajectories[${i}].trajectory_id: not unique`);
    else subIds.add(sub.trajectory_id);
    errs.push(...validateAtif(sub, `${at}.subagent_trajectories[${i}]`));
  }
  return errs;
}

describe("toAtif", () => {
  const events = golden();
  const { root, child } = sessions(events);
  const children = new Map([[CHILD, { session: child, events: events.filter((e) => e.sessionId === CHILD) }]]);
  const t = toAtif(root, events.filter((e) => e.sessionId === SID), { children });

  it("matches the golden trajectory of the claude-code capture", () => {
    assertGolden("../eval/atif-claude-code.golden.json", t);
  });

  it("is ATIF-v1.8: sequential steps, one observation per tool call, prompt ≥ cached tokens, nothing outside the field lists", () => {
    assert.equal(t.schema_version, ATIF_VERSION);
    assert.equal(ATIF_VERSION, "ATIF-v1.8");
    assert.deepEqual(validateAtif(t), []);
    assert.deepEqual(t.steps.map((s) => s.step_id), t.steps.map((_, i) => i + 1));
    for (const s of t.steps) {
      const calls = (s.tool_calls ?? []).map((c) => c.tool_call_id);
      const results = (s.observation?.results ?? []).map((r) => r.source_call_id);
      assert.deepEqual(results, calls, `step ${s.step_id}: one observation result per tool call, in order`);
      if (s.metrics?.prompt_tokens !== undefined) assert.ok(s.metrics.prompt_tokens >= (s.metrics.cached_tokens ?? 0), `step ${s.step_id}`);
    }
    assert.deepEqual(t.steps.map((s) => s.source), ["user", "agent", "agent", "agent", "agent", "agent", "system", "user", "agent"]);
    assert.equal(t.steps[1]!.message, "I'll create sum.js.");
    assert.deepEqual(t.steps[1]!.metrics, { prompt_tokens: 9700, completion_tokens: 90, cached_tokens: 8000, extra: { coding_sh: { cache_write_tokens: 500 } } });
    assert.equal(t.steps[2]!.observation!.results[0]!.content!.startsWith("Error: Exit code 1"), true);
    assert.equal(t.final_metrics!.total_steps, t.steps.length);
  });

  it("embeds the subagent's trajectory under the Agent call's ref", () => {
    const agentCall = t.steps.find((s) => s.tool_calls?.some((c) => c.function_name === "Agent"))!;
    const ref = agentCall.observation!.results.find((r) => r.subagent_trajectory_ref)!.subagent_trajectory_ref![0]!;
    assert.equal(ref.trajectory_id, CHILD);
    assert.equal(t.subagent_trajectories?.length, 1);
    const sub = t.subagent_trajectories![0]!;
    assert.equal(sub.trajectory_id, ref.trajectory_id);
    assert.equal(sub.steps[0]!.message, "List files that import sum.js");
    assert.equal(sub.agent.model_name, "claude-haiku-4-5");
    // Without the child events: the ref stays, nothing is embedded.
    const flat = toAtif(root, events.filter((e) => e.sessionId === SID));
    assert.equal(flat.subagent_trajectories, undefined);
    assert.deepEqual(validateAtif(flat), []);
  });

  it("redacts secrets, and drops text in metadata mode", () => {
    const key = ["sk-ant-api03-", "A".repeat(90), "AA"].join("");
    const evs: AgentEvent[] = [
      { id: "u", v: 0, sessionId: "s", ts: 1, agent: "codex", kind: "user.message", payload: { text: `use ${key}` } },
      { id: "t", v: 0, sessionId: "s", ts: 2, agent: "codex", kind: "tool.start", payload: { tool: "shell", toolUseId: "c1", input: ["bash", "-lc", `curl -H ${key}`] } },
      { id: "e", v: 0, sessionId: "s", ts: 3, agent: "codex", kind: "tool.end", payload: { tool: "shell", toolUseId: "c1", ok: true, output: "ok" } },
    ];
    const s: Session = { id: "s", agent: "codex", startedAt: 1, stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 }, flags: [] };
    const full = JSON.stringify(toAtif(s, evs));
    assert.ok(!full.includes(key));
    assert.match(full, /\[redacted:anthropic-key\]/);
    const meta = toAtif(s, evs, { mode: "metadata" });
    assert.equal(meta.steps[0]!.message, "");
    assert.deepEqual(meta.steps[1]!.tool_calls![0]!.arguments, {});
    assert.deepEqual(validateAtif(meta), []);
    // A session with no messages still has one step.
    assert.deepEqual(toAtif(s, []).steps.map((x) => x.source), ["system"]);
  });

  it("atifFromStore loads subagents from the index", async () => {
    const index = new MemIndex();
    await index.upsertSession(root);
    await index.upsertSession(child);
    await index.putEvents(events);
    const fromStore = await atifFromStore(index, SID);
    assert.deepEqual(fromStore, t);
  });
});

describe("exportHarbor 1.4", () => {
  it("writes task.toml schema 1.4 with an explicit shared verifier, and the trajectory under solution/", async () => {
    const blobs = new MemBlobs();
    const git = new FakeSnapshots().add("start", BUGGY);
    const task: EvalTask = {
      id: "task_0123456789abcdef",
      name: "Fix add & mul!",
      status: "validated",
      sourceSessionId: SID,
      start: { repoRoot: "/work/demo", snapshot: "start", head: "h" },
      instruction: "fix add and mul\nboth are wrong",
      setup: ["npm ci"],
      verifier: { command: "node test/add.test.js", hiddenFiles: {}, timeoutMs: 120_000 },
      referencePatch: await blobs.put("diff --git a/x b/x\n"),
      tags: ["from-session"],
      createdAt: 0,
    };
    const dir = await tempDir();
    dirs.push(dir);
    const events = golden();
    const trajectory = toAtif(sessions(events).root, events);
    await exportHarbor(task, dir, blobs, { git, trajectory });
    const toml = parseToml(await readFile(join(dir, "task.toml"), "utf8"));
    assert.equal(toml.schema_version, "1.4");
    assert.equal(toml.version, undefined);
    assert.deepEqual(toml.task, { name: "coding-sh/fix-add-mul", description: "fix add and mul", keywords: ["from-session"] });
    assert.match(String((toml.task as Record<string, unknown>).name), /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    assert.deepEqual(toml.verifier, { timeout_sec: 120, environment_mode: "shared" });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "solution/trajectory.json"), "utf8")), JSON.parse(JSON.stringify(trajectory)));
    assert.equal(harborTaskName({ id: "task_x", name: "..." }), "coding-sh/task_x");
    assert.equal(harborTaskName({ id: "task_x", name: "a..b" }), "coding-sh/a.b");

    // Harbor's own loader (TaskConfig) and trajectory validator, when harbor is installed (CODING_SH_HARBOR_PYTHON=<python with harbor>).
    const py = process.env.CODING_SH_HARBOR_PYTHON;
    if (py && spawnSync(py, ["-c", "import harbor"]).status === 0) {
      const script = join(dir, "check.py");
      await writeFile(
        script,
        [
          "import json, sys",
          "from harbor.models.task.config import TaskConfig",
          "from harbor.models.trajectories import Trajectory",
          "cfg = TaskConfig.model_validate_toml(open(sys.argv[1]).read())",
          "assert cfg.schema_version == '1.4' and cfg.verifier.environment_mode.value == 'shared', cfg",
          "Trajectory.model_validate(json.load(open(sys.argv[2])))",
          "print('ok')",
        ].join("\n"),
      );
      assert.equal(execFileSync(py, [script, join(dir, "task.toml"), join(dir, "solution/trajectory.json")], { encoding: "utf8" }).trim(), "ok");
    }
  });
});
