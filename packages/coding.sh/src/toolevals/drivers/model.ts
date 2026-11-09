// Model driver (§4.2): a raw model through the built-in tool-use loop, with
// no agent harness in between. Events go straight to the store as agent
// `coding.sh-model` with sessionId = trialId; this is the only driver with
// exact TTFT for every call.
import { currentAbortSignal } from "../../core/children.ts";
import { buildSession } from "../../core/sessions.ts";
import type { AgentRunOutput, IndexStore } from "../../core/types.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { connectMcp, promptText, type McpClient, type McpConnectSpec } from "../mcp/client.ts";
import { OAuthSession } from "../mcp/oauth.ts";
import { mcpHandlers } from "../model/mcp-handlers.ts";
import { runModelLoop, type LoopResult } from "../model/loop.ts";
import { buildToolRuntime } from "../model/tools.ts";
import { simulatedShell, type SimulatedShell } from "../model/shell-sim.ts";
import type { Sandbox } from "../sandbox.ts";
import type { Driver, Prices, Target, ToolTask, Variant } from "../types.ts";

type ModelDriver = Extract<Driver, { kind: "model" }>;

/** The driver a variant runs with: its outputCap and promptCache win over the driver's. The driver key does not change. */
export function effectiveModelDriver(d: ModelDriver, v: Pick<Variant, "outputCap" | "promptCache">): ModelDriver {
  const out: ModelDriver = { ...d };
  if (v.outputCap) out.outputCap = { ...(d.outputCap ?? {}), ...v.outputCap };
  if (v.promptCache !== undefined) out.promptCache = v.promptCache;
  return out;
}

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
  /** Cancels the trial: every HTTP request it makes (model, MCP, HTTP target) is aborted. Default: the ambient signal (withAbortSignal). */
  signal?: AbortSignal;
}

/** `f` with `signal` added to every request, alongside any signal the caller passes. */
function fetchWithSignal(f: typeof fetch, signal: AbortSignal | undefined): typeof fetch {
  if (!signal) return f;
  return (input, init) => f(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/** OAuth sessions per HTTP target, so the client registers once per run. */
const oauthSessions = new Map<string, OAuthSession>();

function oauthFor(target: Target, env: NodeJS.ProcessEnv, f: typeof fetch): OAuthSession | undefined {
  if (target.kind !== "mcp" || target.transport !== "http") return undefined;
  const cfg = target.oauth ?? {};
  const key = JSON.stringify([target.url, cfg]);
  let s = oauthSessions.get(key);
  if (!s) {
    const secret = cfg.clientSecretEnv ? env[cfg.clientSecretEnv] : undefined;
    if (cfg.clientSecretEnv && !secret) throw new Error(`MCP target ${target.name} oauth needs $${cfg.clientSecretEnv}`);
    s = new OAuthSession({ ...(cfg.clientId ? { clientId: cfg.clientId } : {}), ...(secret ? { clientSecret: secret } : {}), ...(cfg.scope ? { scope: cfg.scope } : {}), ...(cfg.grant ? { grant: cfg.grant } : {}), ...(cfg.redirectUri ? { redirectUri: cfg.redirectUri } : {}), fetch: f });
    oauthSessions.set(key, s);
  }
  return s;
}

export type ModelTrialOutput = AgentRunOutput & { finalText: string; loop: LoopResult; events: AgentEvent[] };

export async function runModelTrial(o: ModelTrialOpts): Promise<ModelTrialOutput> {
  const started = Date.now();
  const env = o.env ?? process.env;
  const apiKey = env[o.driver.apiKeyEnv];
  if (!apiKey) throw new Error(`model driver needs $${o.driver.apiKeyEnv}`);
  const signal = o.signal ?? currentAbortSignal();
  const doFetch = fetchWithSignal(o.fetch ?? fetch, signal);
  let client: McpClient | undefined;
  const events: AgentEvent[] = [];
  try {
    if (o.target.kind === "mcp") {
      if (!o.mcp) throw new Error("MCP target needs the tap proxy (mcp spec)");
      const handlers = mcpHandlers({ driver: o.driver, apiKey, fetch: doFetch, trialId: o.trialId, work: o.sandbox.work, ...(o.task.mcp ? { mcp: o.task.mcp } : {}), emit: (e) => events.push(e) });
      const oauth = o.mcp.url ? oauthFor(o.target, env, doFetch) : undefined;
      client = await connectMcp({ ...o.mcp, fetch: o.mcp.fetch ?? doFetch, handlers, ...(oauth ? { oauth } : {}) });
    }
    let instruction = o.task.instruction;
    if (o.task.mcp?.prompt) {
      if (!client) throw new Error(`task ${o.task.id}: mcp.prompt needs an MCP target`);
      const p = await client.getPrompt(o.task.mcp.prompt.name, o.task.mcp.prompt.arguments ?? {});
      instruction = `${promptText(p.messages)}\n\n${instruction}`;
    }
    let shellSim: SimulatedShell | undefined;
    if (o.driver.shell) {
      if (o.target.kind !== "cli") throw new Error(`a simulated shell needs a CLI target; ${o.target.name} is ${o.target.kind}`);
      const key = env[o.driver.shell.apiKeyEnv];
      if (!key) throw new Error(`shell model ${o.driver.shell.provider}/${o.driver.shell.model} needs $${o.driver.shell.apiKeyEnv}`);
      shellSim = simulatedShell({ sim: o.driver.shell, apiKey: key, fetch: doFetch, cwd: o.sandbox.work, trialId: o.trialId, emit: (e) => events.push(e) });
    }
    const tools = await buildToolRuntime(o.target, o.sandbox, { mcp: client, httpUrl: o.httpUrl, fetch: doFetch, ...(o.driver.outputCap ? { outputCap: o.driver.outputCap } : {}), ...(shellSim ? { shellSim } : {}) });
    const loop = await runModelLoop({
      driver: o.driver,
      instruction,
      tools,
      apiKey,
      fetch: doFetch,
      budget: o.task.budget,
      trialId: o.trialId,
      cwd: o.sandbox.work,
      prices: o.prices,
      emit: (e) => events.push(e),
      ...(signal ? { signal } : {}),
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
