// Experiment task that runs one dataset case against a local eve agent over
// eve's HTTP API (`eve dev`, default http://127.0.0.1:2000; any deployment
// URL works the same way, but tests and examples only ever use localhost).
//
// Per case it opens a session, sends each message as a follow-up, reads the
// session stream until each delivery settles, and returns the reply. The
// mapped stream events go to graders as `ctx.trace` (withTrace), so graders
// can check tool calls and subagent dispatches, not just the text.
//
// Case input: "text" | { message: "text" } | { messages: ["first", "follow-up", ...] }.
import type { AgentEvent } from "../../schema/index.ts";
import type { FetchLike } from "../../judge/http.ts";
import { withTrace } from "../../experiments/run.ts";
import { type FunctionTask, type TaskContext, TaskError } from "../../experiments/task.ts";
import { EveStreamMapper, type EveStreamLine } from "./stream.ts";

export const EVE_DEV_URL = "http://127.0.0.1:2000";

export interface EveTaskOptions {
  /** Agent base URL (default http://127.0.0.1:2000, `eve dev`'s default). */
  url?: string;
  /** Extra request headers (e.g. a channel's auth header). */
  headers?: Record<string, string>;
  /** Per-case limit across all turns (default 120 s). */
  timeoutMs?: number;
  /** End the session after the last turn (default true). */
  endSession?: boolean;
  fetch?: FetchLike;
  name?: string;
}

export interface EveToolCall {
  tool: string;
  input: unknown;
  ok?: boolean;
  output?: unknown;
  kind?: string;
}

export interface EveTaskOutput {
  /** Reply of the last turn. */
  reply: string;
  /** Reply per turn. */
  replies: string[];
  sessionId: string;
  /** Last delivery's outcome ("handled" when the turn completed). */
  outcome: string;
  /** Tool, control and subagent calls in order (subagent calls have kind "agent"). */
  toolCalls: EveToolCall[];
  subagents: string[];
}

function messagesOf(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.message === "string") return [o.message];
    if (Array.isArray(o.messages) && o.messages.length && o.messages.every((m) => typeof m === "string")) return o.messages as string[];
  }
  throw new TaskError('eve task input must be a string, {message}, or {messages: string[]}');
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new TaskError(`eve ${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new TaskError(`eve ${what}: response is not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Read the session stream from the mapper's cursor until `deliveryId`
 * settles. Reconnects from the cursor when a lease ends.
 */
async function readUntilSettled(
  f: FetchLike,
  base: string,
  headers: Record<string, string>,
  m: EveStreamMapper,
  deliveryId: string,
  sink: AgentEvent[],
  signal: AbortSignal,
): Promise<void> {
  while (!m.deliveryOutcomes.has(deliveryId)) {
    if (m.ended) throw new TaskError(`eve session ${m.sessionId} ended before delivery ${deliveryId} settled`);
    const res = await f(`${base}/eve/v1/session/${encodeURIComponent(m.sessionId)}/stream?startIndex=${m.position}`, { headers, signal });
    if (!res.ok || !res.body) throw new TaskError(`eve stream: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let done = false;
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) {
          // A final line without a trailing newline.
          if (buf.trim()) buf += "\n";
          else break;
          done = true;
        } else buf += chunk.value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          let line: EveStreamLine;
          try {
            line = JSON.parse(raw) as EveStreamLine;
          } catch {
            throw new TaskError(`eve stream: malformed line ${raw.slice(0, 120)}`);
          }
          sink.push(...m.push(line));
          if (m.deliveryOutcomes.has(deliveryId) || m.ended || line.$eve === "stream.lease-ended") {
            done = true;
            break;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/**
 * An experiment task for an eve agent. Example:
 *   runExperiment({ name, dataset, graders, task: eveTask({ url: "http://127.0.0.1:2000" }) })
 */
export function eveTask(opts: EveTaskOptions = {}): FunctionTask {
  const base = (opts.url ?? EVE_DEV_URL).replace(/\/+$/, "");
  const f: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const headers = { ...opts.headers };
  const post = { ...headers, "content-type": "application/json" };

  async function run(input: unknown, ctx: TaskContext): Promise<unknown> {
    const messages = messagesOf(input);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const events: AgentEvent[] = [];
    let m: EveStreamMapper | undefined;
    let outcome = "unknown";
    const replies: string[] = [];
    try {
      for (const [i, message] of messages.entries()) {
        const path = m ? `/eve/v1/session/${encodeURIComponent(m.sessionId)}` : "/eve/v1/session";
        const body = await json(await f(`${base}${path}`, { method: "POST", headers: post, body: JSON.stringify({ message }), signal }), i === 0 ? "create session" : "send message");
        const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : undefined;
        if (!m) {
          if (typeof body.sessionId !== "string") throw new TaskError("eve create session: no sessionId in response");
          m = new EveStreamMapper({ sessionId: body.sessionId });
        }
        if (!deliveryId) throw new TaskError("eve: no deliveryId in response");
        await readUntilSettled(f, base, headers, m, deliveryId, events, signal);
        const settled = m.deliveryOutcomes.get(deliveryId)!;
        outcome = settled.outcome;
        if (outcome !== "handled") throw new TaskError(`eve delivery ${deliveryId} settled "${outcome}"${outcome === "awaiting-input" ? " (the agent asked for approval or input)" : ""}`);
        replies.push(settled.turnId ? (m.replies.get(settled.turnId) ?? "") : "");
      }
    } catch (err) {
      if (signal.aborted && !(err instanceof TaskError)) throw new TaskError(`eve task timed out or was aborted after ${events.length} events`);
      throw err;
    } finally {
      if (m && opts.endSession !== false) {
        await f(`${base}/eve/v1/session/${encodeURIComponent(m.sessionId)}/end`, { method: "POST", headers: post, body: "{}" })
          .then((r) => r.body?.cancel())
          .catch(() => {});
      }
    }

    const toolCalls: EveToolCall[] = [];
    const byId = new Map<string, EveToolCall>();
    for (const e of events) {
      const p = e.payload;
      if (e.kind === "tool.start") {
        const call: EveToolCall = { tool: String(p.tool), input: p.input, kind: typeof p.actionKind === "string" ? p.actionKind : undefined };
        byId.set(String(p.toolUseId), call);
        toolCalls.push(call);
      } else if (e.kind === "tool.end") {
        const call = byId.get(String(p.toolUseId));
        if (call) {
          call.ok = p.ok === true;
          call.output = p.output;
        }
      }
    }
    const output: EveTaskOutput = {
      reply: replies.at(-1) ?? "",
      replies,
      sessionId: m!.sessionId,
      outcome,
      toolCalls,
      subagents: events.filter((e) => e.kind === "subagent.start").map((e) => String(e.payload.type)),
    };
    return withTrace(output, events);
  }

  return { kind: "function", name: opts.name ?? `eve ${base}`, fn: run };
}
