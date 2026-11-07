// Agent driver (§4.1): a coding agent through its adapter's headless run().
// cwd is the sandbox work dir; env combines the adapter overlay (isolated
// config home), PATH with the shim first, CODING_SH_RUN_ID and the OTel env;
// flags come from the overlay, the driver and the MCP mount.
import type { Adapter, AgentRunOutput, BlobStore, HarnessBundle } from "../../core/types.ts";
import { applyBundle } from "../../runner/bundle.ts";
import { mountMcp, type McpServerMount } from "../mount.ts";
import type { Sandbox } from "../sandbox.ts";
import type { Driver, ToolTask } from "../types.ts";

export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000;

export interface AgentTrialOpts {
  adapter: Adapter;
  driver: Extract<Driver, { kind: "agent" }>;
  task: ToolTask;
  sandbox: Sandbox;
  bundle?: HarnessBundle;
  blobs: BlobStore;
  trialId: string;
  /** Tapped MCP server to mount (MCP targets). */
  mcp?: McpServerMount;
  /** HTTP target: env var → tap URL. */
  extraEnv?: Record<string, string>;
  /** OTLP/HTTP receiver base URL (e.g. http://127.0.0.1:4318) for model-call latency. */
  otelEndpoint?: string;
}

/** Env that turns on OTel export toward the local receiver (§6.1). */
export function otelEnv(endpoint: string): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  };
}

function emptyBundle(agent: string): HarnessBundle {
  return { id: "toolevals-empty", name: "toolevals-empty", agent, flags: [], env: {}, files: {}, remove: [], createdAt: 0 };
}

export async function runAgentTrial(o: AgentTrialOpts): Promise<AgentRunOutput> {
  const { adapter, sandbox: sb, task } = o;
  if (!adapter.run) throw new Error(`adapter ${adapter.id} has no headless run()`);
  const bundle = o.bundle ?? emptyBundle(adapter.id);
  if (o.bundle) await applyBundle(o.bundle, sb.work, o.blobs, { home: sb.home });
  const overlay = adapter.overlay ? await adapter.overlay(bundle, sb.work, { workDir: sb.work, runRoot: sb.root, home: sb.home }) : { env: {}, flags: [] };
  const mount = o.mcp ? await mountMcp(adapter.id, o.mcp, sb) : { env: {}, flags: [], files: {} };
  const flags = [...bundle.flags, ...overlay.flags, ...(o.driver.flags ?? []), ...mount.flags];
  if (adapter.id === "claude-code") {
    if (task.budget.turns !== undefined && !flags.includes("--max-turns")) flags.push("--max-turns", String(task.budget.turns));
    if (task.budget.costUsd !== undefined && !flags.includes("--max-budget-usd")) flags.push("--max-budget-usd", String(task.budget.costUsd));
  }
  const env: Record<string, string> = {
    ...bundle.env,
    ...overlay.env,
    ...mount.env,
    ...(o.otelEndpoint ? otelEnv(o.otelEndpoint) : {}),
    ...sb.env,
    ...(o.extraEnv ?? {}),
    CODING_SH_RUN_ID: o.trialId,
  };
  return adapter.run({
    cwd: sb.work,
    instruction: task.instruction,
    model: o.driver.model ?? bundle.model,
    env,
    timeoutMs: task.budget.wallMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    flags,
    runId: o.trialId,
  });
}
