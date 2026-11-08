// Replaying logged model calls (coding.sh proxy) against the real API with one
// thing varied: the model, the system prompt, the tools or any request field.
// Each logged call is a case; each arm sends the stored request (redacted, as
// it was stored) with its overrides, and the first action of the reply (a tool
// call or text) is compared with the one the agent got at the time.
import type { Case, Grader } from "../datasets/types.ts";
import { costFrom, lookupPrice, type Prices } from "../core/pricing.ts";
import type { Usage } from "../schema/index.ts";
import type { FetchLike } from "../judge/http.ts";
import { functionGrader } from "../graders/external.ts";
import type { LoadedCall } from "../proxy/calls.ts";
import { joinUpstream } from "../proxy/server.ts";
import { type Api, firstAction, type FirstAction, parseJsonResponse } from "../proxy/wire.ts";
import { actionsDiffer } from "./continuation.ts";
import { type FunctionTask, TaskError } from "./task.ts";

/** One side of the comparison: its name ("a"/"b"), a label, and the request fields it sets. */
export interface ReplayArm {
  name: "a" | "b";
  label: string;
  set: Record<string, unknown>;
}

/** Raw `--vary key=v1[,v2]` values: one value varies B only (A sends the recorded request), two set A and B. */
export function parseVary(flags: readonly string[], readFile: (path: string) => string): [ReplayArm, ReplayArm] {
  if (!flags.length) throw new Error("Pass at least one --vary key=value, e.g. --vary model=claude-haiku-4-5 or --vary system=@prompt.md");
  const a: ReplayArm = { name: "a", label: "", set: {} };
  const b: ReplayArm = { name: "b", label: "", set: {} };
  const la: string[] = [];
  const lb: string[] = [];
  for (const f of flags) {
    const eq = f.indexOf("=");
    if (eq <= 0) throw new Error(`--vary ${JSON.stringify(f)}: expected key=value`);
    const key = f.slice(0, eq).trim();
    if (!/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/.test(key)) throw new Error(`--vary ${JSON.stringify(f)}: bad key ${JSON.stringify(key)}`);
    const raw = f.slice(eq + 1);
    // A JSON object or array is one value; anything else splits on commas.
    const parts = /^\s*[[{]/.test(raw) ? [raw] : raw.split(",");
    if (parts.length > 2) throw new Error(`--vary ${key}: give one value (B; A keeps the recorded one) or two (A,B), not ${parts.length}`);
    const vals = parts.map((p) => value(key, p.trim(), readFile));
    const show = parts.map((p) => (p.trim().startsWith("@") ? p.trim() : short(p.trim())));
    if (vals.length === 2) {
      a.set[key] = vals[0];
      b.set[key] = vals[1];
      la.push(`${key}=${show[0]}`);
      lb.push(`${key}=${show[1]}`);
    } else {
      b.set[key] = vals[0];
      lb.push(`${key}=${show[0]}`);
    }
  }
  a.label = la.length ? la.join(" ") : "recorded";
  b.label = lb.join(" ");
  return [a, b];
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

function value(key: string, raw: string, readFile: (path: string) => string): unknown {
  const text = raw.startsWith("@") ? readFile(raw.slice(1)) : raw;
  if (key === "model" || key === "system" || key === "instructions") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The request body with an arm's fields set. `system` lands where the API keeps the system prompt. */
export function applyArm(api: Api, body: Record<string, unknown>, set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(body);
  for (const [key, v] of Object.entries(set)) {
    if (key === "system") {
      const text = String(v);
      if (api === "responses") out.instructions = text;
      else if (api === "chat") {
        const msgs = Array.isArray(out.messages) ? [...(out.messages as unknown[])] : [];
        const i = msgs.findIndex((m) => isObj(m) && (m.role === "system" || m.role === "developer"));
        if (i >= 0) msgs[i] = { ...(msgs[i] as Record<string, unknown>), content: text };
        else msgs.unshift({ role: "system", content: text });
        out.messages = msgs;
      } else out.system = text;
      continue;
    }
    const path = key.split(".");
    let o: Record<string, unknown> = out;
    for (const p of path.slice(0, -1)) {
      if (!isObj(o[p])) o[p] = {};
      o = o[p] as Record<string, unknown>;
    }
    o[path[path.length - 1]!] = v;
  }
  // One JSON reply: the replay grades the whole turn, and streaming adds nothing.
  out.stream = false;
  delete out.stream_options;
  return out;
}

/** Which key the replay needs, by provider. */
export const REPLAY_KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;

export interface ReplayCase {
  call: LoadedCall;
  provider: "anthropic" | "openai";
  api: Api;
  /** What the agent got at the time. */
  recorded?: FirstAction;
}

/** A logged call, ready to replay; a string says why it can't be. */
export function replayable(call: LoadedCall): ReplayCase | string {
  const r = call.request;
  if (!r) return `${call.event.id.slice(0, 12)}: the request was not stored (capture mode metadata, or not a proxy call)`;
  if (r.api !== "messages" && r.api !== "chat" && r.api !== "responses") return `${call.event.id.slice(0, 12)}: ${r.api} calls can't be replayed`;
  const provider = r.provider === "anthropic" ? "anthropic" : "openai";
  const out: ReplayCase = { call, provider, api: r.api };
  const body = call.response?.body;
  if (body !== undefined && (call.response?.status ?? 200) < 400) {
    const fa = firstAction(r.api, body);
    if (fa.type !== "none") out.recorded = fa;
  }
  return out;
}

/** The case for a logged call: small input (the id and what it asked), the recorded first action as expected. */
export function replayCaseOf(rc: ReplayCase): Case {
  const e = rc.call.event;
  return {
    id: e.id,
    input: { call: e.id, model: e.model ?? rc.call.info?.model, prompt: e.payload.prompt },
    ...(rc.recorded ? { expected: { action: rc.recorded } } : {}),
    metadata: { session: e.sessionId, api: rc.api },
    sourceSessionId: e.sessionId,
  };
}

export interface ReplayOutput {
  model?: string;
  action: FirstAction;
  text: string;
  toolCalls: { name: string; input: unknown }[];
  stopReason?: string;
  usage?: Usage;
  costUsd?: number;
}

/** Tool calls and text of a reply, for the judge and the report. */
function turnOf(api: Api, body: unknown): { text: string; toolCalls: { name: string; input: unknown }[] } {
  const b = isObj(body) ? body : {};
  const texts: string[] = [];
  const calls: { name: string; input: unknown }[] = [];
  const parse = (s: unknown) => {
    if (typeof s !== "string") return s;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  if (api === "messages") {
    for (const c of Array.isArray(b.content) ? b.content : []) {
      if (!isObj(c)) continue;
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
      if (c.type === "tool_use") calls.push({ name: String(c.name ?? "?"), input: c.input });
    }
  } else if (api === "chat") {
    const m = isObj((b.choices as unknown[] | undefined)?.[0]) ? ((b.choices as Record<string, unknown>[])[0]!.message as Record<string, unknown> | undefined) : undefined;
    if (typeof m?.content === "string") texts.push(m.content);
    for (const t of Array.isArray(m?.tool_calls) ? (m.tool_calls as unknown[]) : []) {
      if (isObj(t) && isObj(t.function)) calls.push({ name: String(t.function.name ?? "?"), input: parse(t.function.arguments) });
    }
  } else {
    for (const i of Array.isArray(b.output) ? b.output : []) {
      if (!isObj(i)) continue;
      if (/_call$/.test(String(i.type ?? ""))) calls.push({ name: String(i.name ?? i.type), input: parse(i.arguments) ?? i.action ?? i.input });
      for (const p of Array.isArray(i.content) ? i.content : []) if (isObj(p) && typeof p.text === "string") texts.push(p.text);
    }
  }
  return { text: texts.join("\n"), toolCalls: calls };
}

export interface ReplayTaskOptions {
  cases: ReadonlyMap<string, ReplayCase>;
  arm: ReplayArm;
  upstreams: { anthropic: string; openai: string };
  env: NodeJS.ProcessEnv;
  prices: Prices;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Request headers for a replay: the API version and betas the client sent (never its auth), and the user's key. */
function headersFor(rc: ReplayCase, env: NodeJS.ProcessEnv): Record<string, string> {
  const stored = rc.call.request?.headers ?? {};
  const h: Record<string, string> = { "content-type": "application/json" };
  if (rc.provider === "anthropic") {
    h["x-api-key"] = env[REPLAY_KEY_ENV.anthropic] ?? "";
    h["anthropic-version"] = stored["anthropic-version"] ?? "2023-06-01";
    // Subscription logins send an oauth beta that an API key must not.
    const betas = (stored["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter((s) => s && !/^oauth-/.test(s));
    if (betas.length) h["anthropic-beta"] = betas.join(",");
  } else {
    h.authorization = `Bearer ${env[REPLAY_KEY_ENV.openai] ?? ""}`;
    for (const k of ["openai-organization", "openai-project"]) if (stored[k]) h[k] = stored[k];
  }
  return h;
}

/** The path a replay goes to: the stored one, except ChatGPT-backend Codex calls, which go to the API's /v1/responses. */
function pathFor(rc: ReplayCase): string {
  const p = rc.call.request?.path ?? "";
  if (rc.api === "responses" && !/^\/v1\//.test(p)) return "/v1/responses";
  if (rc.api === "messages" && !/^\/v1\//.test(p)) return "/v1/messages";
  if (rc.api === "chat" && !/^\/v1\//.test(p)) return "/v1/chat/completions";
  return p;
}

/** The arm as a task: replays the case's call with the arm's fields and returns the reply's first action, turn, usage and cost. */
export function replayTask(o: ReplayTaskOptions): FunctionTask {
  const doFetch: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  return {
    kind: "function",
    name: `replay ${o.arm.label}`,
    fn: async (input, ctx): Promise<ReplayOutput> => {
      const id = isObj(input) && typeof input.call === "string" ? input.call : ctx.caseId;
      const rc = o.cases.get(id);
      if (!rc) throw new TaskError(`call ${id} is not loaded`);
      const body = applyArm(rc.api, rc.call.request!.body, o.arm.set);
      const url = joinUpstream(rc.provider === "anthropic" ? o.upstreams.anthropic : o.upstreams.openai, pathFor(rc));
      const timeout = AbortSignal.timeout(o.timeoutMs ?? 600_000);
      const res = await doFetch(url.href, { method: "POST", headers: headersFor(rc, o.env), body: JSON.stringify(body), signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout });
      const text = await res.text();
      const r = parseJsonResponse(rc.api, text);
      if (!res.ok || r.error) {
        const retry = res.headers.get("retry-after");
        throw new TaskError(`HTTP ${res.status}: ${r.error?.message ?? text.slice(0, 300)}${retry ? ` (retry-after ${retry})` : ""}`);
      }
      const model = r.model ?? (typeof body.model === "string" ? body.model : undefined);
      const out: ReplayOutput = { action: firstAction(rc.api, r.body), ...turnOf(rc.api, r.body), ...(model ? { model } : {}), ...(r.stopReason ? { stopReason: r.stopReason } : {}) };
      if (r.usage) {
        out.usage = r.usage;
        const price = lookupPrice(model, o.prices);
        if (price) out.costUsd = costFrom(r.usage, price);
      }
      return out;
    },
  };
}

/** "same-action": passes when the replay's first action is the one the agent got at the time (same tool and input, or both text). */
export function sameActionGrader(): Grader {
  return functionGrader("same-action", (ctx) => {
    const exp = isObj(ctx.expected) && isObj(ctx.expected.action) ? (ctx.expected.action as unknown as FirstAction) : undefined;
    if (!exp) throw new Error("the recorded response has no first action to compare with");
    const got = isObj(ctx.output) && isObj(ctx.output.action) ? (ctx.output.action as unknown as FirstAction) : { type: "none" as const };
    const as = (x: FirstAction) => (x.type === "tool" ? { type: "tool" as const, name: x.name ?? "?", input: x.input } : { type: "text" as const });
    const differ = actionsDiffer(as(exp), as(got));
    const show = (x: FirstAction) => (x.type === "tool" ? `${x.name}` : x.type);
    if (differ === undefined) return { score: 1, pass: true, reason: "text, as recorded" };
    return differ ? { score: 0, pass: false, reason: `${show(got)} instead of ${show(exp)}` } : { score: 1, pass: true, reason: `${show(got)}, as recorded` };
  });
}

/** Rough cost of a replay: each call's recorded input (all of it uncached) and output, at each arm's model price, n times. */
export function estimateReplay(cases: readonly ReplayCase[], arms: readonly ReplayArm[], n: number, prices: Prices): { calls: number; inputTokens: number; usd?: number; unpriced: string[] } {
  let usd = 0;
  let input = 0;
  const unpriced = new Set<string>();
  for (const rc of cases) {
    const u = rc.call.event.usage ?? {};
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    for (const arm of arms) {
      input += tokens * n;
      const model = typeof arm.set.model === "string" ? arm.set.model : (rc.call.event.model ?? rc.call.info?.model);
      const price = lookupPrice(model, prices);
      if (!price) {
        unpriced.add(model ?? "?");
        continue;
      }
      usd += n * costFrom({ inputTokens: tokens, outputTokens: u.outputTokens ?? 0 }, price);
    }
  }
  return { calls: cases.length * arms.length * n, inputTokens: input, ...(unpriced.size ? {} : { usd }), unpriced: [...unpriced] };
}
