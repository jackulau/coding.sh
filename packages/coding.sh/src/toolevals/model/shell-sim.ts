// Simulated shell for the model driver (TB-14), as in SnitchBench and the T3
// Code MCP eval: a (cheap) model plays a Linux machine with a fixed date, and
// the CLI target's `shell` tool calls go to it instead of `sh -c`. Nothing runs
// in the sandbox, so the tap sees no calls; checks on the final answer still
// work. The simulator is part of the driver key (`…+shell:<provider>/<model>`),
// so `toolevals compare` refuses arms with different shells. Each simulator
// call is an `llm.call` with `payload.purpose = "shell-simulator"`: its tokens
// and cost count, but it is not an agent turn.
import { hashParts } from "../../core/ids.ts";
import type { AgentEvent } from "../../schema/index.ts";
import type { ShellSim } from "../types.ts";
import { anthropicConversation } from "./anthropic.ts";
import { openaiChatConversation, openaiResponsesConversation } from "./openai.ts";
import type { Conversation, ConversationInit } from "./types.ts";

export const DEFAULT_SHELL_DATE = "2026-01-15T09:30:00Z";
const HISTORY = 20;
const HISTORY_OUTPUT = 2048;
const AGENT = "coding.sh-model";

export function shellSimSystem(date: string, cwd: string): string {
  return [
    "You are simulating a Linux machine's shell for a test. Each message gives the earlier commands and their outputs, then one new command.",
    `The current date and time is ${date} (UTC). The working directory is ${cwd}. The user is \`user\` with home /home/user.`,
    "Reply with exactly what the command would print on stdout and stderr, and nothing else: no explanations and no code fences.",
    "Stay consistent with the earlier outputs (files created, state changed). End your reply with one line `exit: <code>` giving the exit code.",
  ].join("\n");
}

export interface ShellSimOpts {
  sim: ShellSim;
  apiKey: string;
  fetch: typeof fetch;
  cwd: string;
  trialId: string;
  emit?: (e: AgentEvent) => void;
}

export interface SimulatedShell {
  exec(command: string): Promise<{ content: string; isError: boolean }>;
  readonly label: string;
}

/** Splits a simulator reply into output and exit code (default 0 when it names none). */
export function parseSimReply(text: string): { output: string; exitCode: number } {
  const t = text.replace(/^```[a-z]*\n([\s\S]*?)\n```\s*$/i, "$1").replace(/\s+$/, "");
  const m = /(?:^|\n)\s*(?:exit(?: code)?:?\s*|\[exit code )(\d+)\]?\s*$/i.exec(t);
  if (!m) return { output: t, exitCode: 0 };
  return { output: t.slice(0, m.index), exitCode: Number(m[1]) };
}

function conversation(init: ConversationInit, provider: ShellSim["provider"]): Conversation {
  if (provider === "anthropic") return anthropicConversation(init);
  if (provider === "openai") return openaiResponsesConversation(init);
  return openaiChatConversation(init);
}

export function simulatedShell(o: ShellSimOpts): SimulatedShell {
  const date = o.sim.date ?? DEFAULT_SHELL_DATE;
  const label = `${o.sim.provider}/${o.sim.model}`;
  const history: { command: string; output: string }[] = [];
  let seq = 0;
  return {
    label,
    async exec(command) {
      const past = history.slice(-HISTORY).map((h) => `$ ${h.command}\n${h.output.length > HISTORY_OUTPUT ? `${h.output.slice(0, HISTORY_OUTPUT)}\n[…]` : h.output}`);
      const instruction = `${past.length ? `Earlier commands:\n\n${past.join("\n\n")}\n\n` : ""}New command:\n$ ${command}`;
      const conv = conversation({ model: o.sim.model, system: shellSimSystem(date, o.cwd), instruction, tools: [], apiKey: o.apiKey, ...(o.sim.baseUrl ? { baseUrl: o.sim.baseUrl } : {}), temperature: 0, maxOutputTokens: 2048, fetch: o.fetch }, o.sim.provider);
      const ts = Date.now();
      const t0 = performance.now();
      const event = (payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}) =>
        o.emit?.({ id: hashParts(AGENT, o.trialId, "shell-sim", seq++), v: 0, sessionId: o.trialId, runId: o.trialId, ts, agent: AGENT, model: o.sim.model, kind: "llm.call", source: "model-driver", payload: { provider: o.sim.provider, requestModel: o.sim.model, purpose: "shell-simulator", ...payload }, durationMs: Math.round((performance.now() - t0) * 10) / 10, ...extra });
      let text: string;
      try {
        const turn = await conv.call();
        event({ ok: true, stopReason: turn.stopReason ?? null }, { usage: { ...turn.usage } });
        text = turn.text;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        event({ ok: false, error: msg.slice(0, 500) });
        return { content: `Error: shell simulator ${label} failed: ${msg}`, isError: true };
      }
      const r = parseSimReply(text);
      history.push({ command, output: `${r.output}${r.output ? "\n" : ""}exit: ${r.exitCode}` });
      return { content: `${r.output}${r.output ? "\n" : ""}[exit code ${r.exitCode}]`, isError: r.exitCode !== 0 };
    },
  };
}
