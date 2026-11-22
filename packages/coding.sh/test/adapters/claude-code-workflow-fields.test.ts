// A Claude Code workflow agent's own session names its run: session.start carries workflowId,
// workflowName, workflowPhase and workflowLabel (core/sessions.ts reads them into Session.parent).
// The run is test/fixtures/workflows/claude-code-running, copied to a temp dir and never modified.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { assertWellFormed, collect, testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));
const SID = "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f";
const RUN = "wf_7d3c2a10-5be";
const AGENT = "a3c5e7f9b1d2e4f60";
const WORKFLOW_FIELDS = ["workflowId", "workflowName", "workflowPhase", "workflowLabel"];

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const base = { sessionId: SID, cwd: "/work/demo", version: "2.1.319" };
const at = (iso: string) => ({ ...base, timestamp: iso });

let env: TmpEnv;
let root = "";
let projects = "";
beforeEach(() => {
  env = tmpEnv();
  root = mkdtempSync(join(tmpdir(), "csh-wf-fields-"));
  projects = join(root, "claude", "projects");
  cpSync(FIXTURE, projects, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
});
afterEach(() => {
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

const startOf = (events: AgentEvent[], sessionId: string) => events.find((e) => e.kind === "session.start" && e.sessionId === sessionId)!;
const fields = (e: AgentEvent) => Object.fromEntries(WORKFLOW_FIELDS.filter((k) => k in e.payload).map((k) => [k, e.payload[k]]));

/** The parent transcript: a Workflow call (input as given) whose result names the run's transcript dir. */
function parentTranscript(input: Record<string, unknown>): void {
  const dir = join(projects, "-work-demo", SID, "subagents", "workflows", RUN);
  writeFile(
    join(projects, "-work-demo", `${SID}.jsonl`),
    jsonl([
      { ...at("2026-11-01T09:59:00.000Z"), type: "user", uuid: "p1", promptId: "p1", message: { role: "user", content: "review the demo repo" } },
      { ...at("2026-11-01T09:59:30.000Z"), type: "assistant", uuid: "p2", message: { id: "msg_p2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_wf_demo", name: "Workflow", input }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { ...at("2026-11-01T09:59:31.000Z"), type: "user", uuid: "p3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wf_demo", content: `Workflow launched in background.\nTranscript dir: ${dir}` }] } },
    ]),
  );
}

describe("claude-code workflow agents: run fields on their session.start", () => {
  it("a workflow agent carries its run, phase and label; a plain subagent carries none", async () => {
    // A plain (Agent-tool) subagent of the same session, next to the run.
    writeFile(
      join(projects, "-work-demo", SID, "subagents", "agent-plain1.jsonl"),
      jsonl([
        { ...at("2026-11-01T10:00:00.000Z"), type: "user", uuid: "x1", isSidechain: true, agentId: "plain1", message: { role: "user", content: "find the config" } },
        { ...at("2026-11-01T10:00:01.000Z"), type: "assistant", uuid: "x2", isSidechain: true, agentId: "plain1", message: { id: "msg_x2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "found it" }], usage: { input_tokens: 4, output_tokens: 2 } } },
      ]),
    );
    const events = await collect(claudeCode.backfill!(testCtx().ctx));
    assertWellFormed(events);
    // The fixture has no parent transcript, so no Workflow call names the workflow.
    assert.deepEqual(fields(startOf(events, `${SID}:sub:${AGENT}`)), { workflowId: RUN, workflowPhase: "Review", workflowLabel: "review:docs" });
    assert.deepEqual(fields(startOf(events, `${SID}:sub:plain1`)), {});
  });

  it("names the workflow from the Workflow call's inline script meta", async () => {
    parentTranscript({ script: "export const meta = {\n  name: 'demo-review',\n  phases: [{ title: 'Review' }],\n}\nphase('Review')\n" });
    const events = await collect(claudeCode.backfill!(testCtx().ctx));
    assert.deepEqual(fields(startOf(events, `${SID}:sub:${AGENT}`)), { workflowId: RUN, workflowName: "demo-review", workflowPhase: "Review", workflowLabel: "review:docs" });
    assert.equal(events.find((e) => e.kind === "subagent.start" && e.payload.subagentId === AGENT)?.payload.toolUseId, "toolu_wf_demo");
  });

  it("an input name wins over the script's meta, and a call with neither names nothing", async () => {
    parentTranscript({ name: "nightly-review", script: "export const meta = { name: 'demo-review' }" });
    let events = await collect(claudeCode.backfill!(testCtx().ctx));
    assert.equal(startOf(events, `${SID}:sub:${AGENT}`).payload.workflowName, "nightly-review");
    parentTranscript({ args: { round: 2 } });
    events = await collect(claudeCode.backfill!(testCtx().ctx));
    assert.ok(!("workflowName" in startOf(events, `${SID}:sub:${AGENT}`).payload));
  });
});
