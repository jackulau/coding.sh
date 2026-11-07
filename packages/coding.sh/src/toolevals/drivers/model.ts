// Model driver (§4.2): a raw model through the built-in tool-use loop, with
// no agent harness in between. Events go straight to the store as agent
// `coding.sh-model` with sessionId = trialId; this is the only driver with
// exact TTFT for every call.
import { buildSession } from "../../core/sessions.ts";
import type { AgentRunOutput, IndexStore } from "../../core/types.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { connectMcp, type McpClient, type McpConnectSpec } from "../mcp/client.ts";
import { runModelLoop, type LoopResult } from "../model/loop.ts";
import { buildToolRuntime } from "../model/tools.ts";
import type { Sandbox } from "../sandbox.ts";
import type { Driver, Prices, Target, ToolTask } from "../types.ts";

export interface ModelTrialOpts {
  driver: Extract<Driver, { kind: "model" }>;
  task: ToolTask;
  target: Target;
  sandbox: Sandbox;
  index: IndexStore;
  trialId: string;
  fetch?: typeof fetch;
  /** MCP target: how to reach the tapped server (relay argv or proxy URL). */
  mcp?: McpConnectSpec;
  /** HTTP target: the tap proxy URL. */
  httpUrl?: string;
  prices?: Prices;
  env?: NodeJS.ProcessEnv;
}

export type ModelTrialOutput = AgentRunOutput & { finalText: string; loop: LoopResult; events: AgentEvent[] };

export async function runModelTrial(o: ModelTrialOpts): Promise<ModelTrialOutput> {
  const started = Date.now();
  const env = o.env ?? process.env;
  const apiKey = env[o.driver.apiKeyEnv];
  if (!apiKey) throw new Error(`model driver needs $${o.driver.apiKeyEnv}`);
  const doFetch = o.fetch ?? fetch;
  let client: McpClient | undefined;
  const events: AgentEvent[] = [];
  try {
    if (o.target.kind === "mcp") {
      if (!o.mcp) throw new Error("MCP target needs the tap proxy (mcp spec)");
      client = await connectMcp({ ...o.mcp, fetch: o.mcp.fetch ?? doFetch });
    }
    const tools = await buildToolRuntime(o.target, o.sandbox, { mcp: client, httpUrl: o.httpUrl, fetch: doFetch });
    const loop = await runModelLoop({
      driver: o.driver,
      instruction: o.task.instruction,
      tools,
      apiKey,
      fetch: doFetch,
      budget: o.task.budget,
      trialId: o.trialId,
      cwd: o.sandbox.work,
      prices: o.prices,
      emit: (e) => events.push(e),
    });
    if (events.length) {
      await o.index.putEvents(events);
      await o.index.upsertSession(buildSession(events));
    }
    return {
      exitCode: loop.stopped === "error" ? 1 : 0,
      timedOut: loop.budgetExceeded === "wallMs",
      durationMs: Date.now() - started,
      sessionId: o.trialId,
      usage: loop.usage,
      stdoutTail: loop.finalText.slice(-8192),
      stderrTail: loop.error ?? "",
      finalText: loop.finalText,
      loop,
      events,
    };
  } finally {
    await client?.close().catch(() => {});
  }
}
