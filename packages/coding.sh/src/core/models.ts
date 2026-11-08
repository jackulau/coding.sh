// Which models a session's model calls ran on (Session.stats.models), the
// session's model switches (Session.stats.modelSwitch, the `model:switch` tag),
// recorded model fallbacks (the `model:fallback` tag), and refused calls (the
// `refusal` flag). Pure over a session's events, as a fold (foldModels) live
// ingest keeps.
//
// A switch is a model change between two consecutive calls of one scope: the
// main thread (calls without a subagentId) or one subagent. It counts when:
// - the agent recorded a fallback for it (a `model.fallback` notification, from
//   Claude Code's model_fallback / model_refusal_fallback): before the change, or
//   after it, since a refusal's notice comes at the end of the turn;
// - it is in a subagent: a subagent runs one model, so a change is a fallback
//   even when the agent left no record of it;
// - on the main thread, it is a hand-over: every main-thread call on model A
//   comes before the first one on B. A helper model that runs beside the main one
//   (Claude Code's Haiku calls for titles and checks, seen over OpenTelemetry)
//   overlaps it and is never a switch. Each side needs at least two calls, so a
//   single helper call before or after all the others (a title, a summary) is not
//   a switch either, unless A's last call was refused or failed, or a /model
//   command came right before B's first call: that names the trigger.
// A switch and back (a fallback lasts one turn in Claude Code) is one switch.
//
// Calls that ran on the model a switch moved to are priced twice from their token
// counts, at that model's list prices and at the list prices of the model the
// switch left: the difference is what the switch cost (ModelSwitch.extraUsd).
import type { AgentEvent, ModelSwitch } from "../schema/index.ts";
import { cacheWrite1h, costFrom, pricesFor, resolvePrice, type Prices } from "./pricing.ts";

/** A tag (namespaced, so failureFlags() leaves it out): a model changed mid-session. */
export const MODEL_SWITCH = "model:switch";
/** A tag: the agent recorded a fallback to another model (Claude Code's model_fallback / model_refusal_fallback). */
export const MODEL_FALLBACK = "model:fallback";
/** A failure flag: a model call stopped on a refusal (or a content filter). */
export const REFUSAL = "refusal";

/** Stop reasons that mean the model, or the provider's filter, declined: Anthropic `refusal`, OpenAI `content_filter`, Gemini `SAFETY`. */
const REFUSAL_STOPS: ReadonlySet<string> = new Set(["refusal", "content_filter", "safety"]);

/** The model that served a call: the response's, else the event's, else the one requested. */
export const modelOf = (e: AgentEvent): string | undefined => {
  for (const m of [e.payload.responseModel, e.model, e.payload.requestModel]) if (typeof m === "string" && m) return m;
  return undefined;
};

export const isRefusal = (e: AgentEvent): boolean => typeof e.payload.stopReason === "string" && REFUSAL_STOPS.has(e.payload.stopReason.toLowerCase());

const failed = (e: AgentEvent): boolean => e.payload.ok === false || (typeof e.payload.statusCode === "number" && e.payload.statusCode >= 400);

/** A slash command that changes the model: Claude Code's `/model` (a local command, a prompt echo or an OTel user_prompt). */
const isModelCommand = (e: AgentEvent): boolean => {
  if (e.subagentId || (e.kind !== "notification" && e.kind !== "user.message")) return false;
  const c = e.payload.command;
  if (typeof c === "string") return c.replace(/^\//, "") === "model";
  return e.kind === "user.message" && typeof e.payload.text === "string" && /^\s*(?:<command-name>\s*)?\/model\b/.test(e.payload.text);
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Token totals of some calls, to price them at any model's rates. */
interface Tokens {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

const noTokens = (): Tokens => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });

function addTokens(t: Tokens, e: AgentEvent | Tokens): void {
  if ("kind" in e) {
    const u = e.usage ?? {};
    t.calls++;
    t.input += num(u.inputTokens);
    t.output += num(u.outputTokens);
    t.cacheRead += num(u.cacheReadTokens);
    t.cacheWrite += num(u.cacheWriteTokens);
    t.cacheWrite1h += cacheWrite1h(e.payload);
    return;
  }
  t.calls += e.calls;
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  t.cacheWrite1h += e.cacheWrite1h;
}

/** One model's main-thread calls: how many, the first and last by order (index) and time. */
interface ModelUse {
  calls: number;
  first: number;
  last: number;
  firstTs: number;
  lastTs: number;
  /** How its latest call ended, when that was a refusal or a failure. */
  end?: "refusal" | "error";
  /** A /model command came after the previous main-thread call and before this model's first. */
  afterCommand: boolean;
  /** Its calls' tokens, to price a hand-over to it. */
  tokens: Tokens;
}

/** A model change that counts as a switch. */
interface Change {
  from: string;
  to: string;
  at: number;
  trigger?: ModelSwitch["trigger"];
  reason?: string;
  subagent: boolean;
}

/** One scope's calls: the main thread ("") or one subagent. */
interface Scope {
  /** The last call's model, and how it ended when that was a refusal or a failure. */
  model?: string;
  end?: "refusal" | "error";
  /** A recorded fallback since the last call, for the change it announces. */
  record?: { reason: string; from?: string; to?: string };
  /** The main thread's last change, while nothing has qualified it yet: a recorded fallback that comes after it still can. */
  pending?: Change & { tokens: Tokens };
  /** Off the scope's model since a switch: the model the switch left. Calls on any other model are switched calls until the scope returns to it. */
  ref?: string;
}

export interface ModelState {
  /** Calls by model, every llm.call with a model (a subagent's too, when it is in the session). */
  all: Map<string, number>;
  /** Main-thread calls by model. */
  main: Map<string, ModelUse>;
  /** Main-thread calls folded (the next one's index). */
  n: number;
  refusals: number;
  /** A /model command since the last main-thread call. */
  command: boolean;
  /** Per-scope state, keyed by subagentId ("" for the main thread). */
  scopes: Map<string, Scope>;
  /** Switches found as the calls came (recorded fallbacks and subagent changes), and the first of them. */
  switches: number;
  first?: Change;
  /** One of them was on the main thread (a hand-over found at the end is then not counted again). */
  mainSwitched: boolean;
  /** Switched calls' tokens, by the model the switch left and the model they ran on ("from\0to"). */
  off: Map<string, Tokens>;
  /** Recorded fallbacks (model.fallback notifications). */
  fallbacks: number;
}

export const modelState = (): ModelState => ({ all: new Map(), main: new Map(), n: 0, refusals: 0, command: false, scopes: new Map(), switches: 0, mainSwitched: false, off: new Map(), fallbacks: 0 });

const offKey = (from: string, to: string) => `${from}\u0000${to}`;

function addOff(s: ModelState, from: string, to: string, t: AgentEvent | Tokens): void {
  const k = offKey(from, to);
  let o = s.off.get(k);
  if (!o) s.off.set(k, (o = noTokens()));
  addTokens(o, t);
}

/** Notes a switch: counted, the first kept, and the scope now off the model it left. */
function switched(s: ModelState, sc: Scope, c: Change): void {
  s.switches++;
  if (!c.subagent) s.mainSwitched = true;
  if (!s.first || c.at < s.first.at) s.first = c;
  sc.ref ??= c.from;
}

/** A model.fallback notification: it qualifies the change it announces, or the one it reports after the fact. */
function foldFallback(s: ModelState, e: AgentEvent): void {
  s.fallbacks++;
  const sc = scopeOf(s, e);
  const rec = { reason: str(e.payload.trigger) ?? "unknown", from: str(e.payload.from), to: str(e.payload.to) };
  const p = sc.pending;
  if (p && (!rec.to || rec.to === p.to || rec.from === p.to)) {
    sc.pending = undefined;
    switched(s, sc, { from: p.from, to: p.to, at: p.at, trigger: "fallback", reason: rec.reason, subagent: p.subagent });
    if (p.tokens.calls) addOff(s, p.from, p.to, p.tokens);
    return;
  }
  // A subagent's change already counted: the record names its reason.
  if (s.first && !s.first.reason && s.first.subagent === Boolean(e.subagentId) && (s.first.to === rec.to || s.first.to === rec.from)) {
    s.first.trigger = "fallback";
    s.first.reason = rec.reason;
    return;
  }
  sc.record = rec;
}

function scopeOf(s: ModelState, e: AgentEvent): Scope {
  const k = e.subagentId ?? "";
  let sc = s.scopes.get(k);
  if (!sc) s.scopes.set(k, (sc = {}));
  return sc;
}

/** A call on `model` in its scope: a change from the scope's last model counts as a switch, or waits (pending) for a record. */
function foldScope(s: ModelState, e: AgentEvent, model: string): void {
  const sc = scopeOf(s, e);
  const subagent = Boolean(e.subagentId);
  const from = sc.model;
  if (from !== undefined && from !== model) {
    const rec = sc.record && (!sc.record.to || sc.record.to === model || sc.record.from === model) ? sc.record : undefined;
    sc.pending = undefined;
    if (sc.ref !== undefined && model === sc.ref) sc.ref = undefined;
    else if (rec || subagent) {
      const trigger = rec ? "fallback" : sc.end;
      const c: Change = { from, to: model, at: e.ts, subagent, ...(trigger ? { trigger } : {}), ...(rec ? { reason: rec.reason } : {}) };
      switched(s, sc, c);
    } else if (sc.ref === undefined) sc.pending = { from, to: model, at: e.ts, subagent, tokens: noTokens() };
  }
  sc.record = undefined;
  if (sc.ref !== undefined && model !== sc.ref) addOff(s, sc.ref, model, e);
  else if (sc.pending) addTokens(sc.pending.tokens, e);
  sc.model = model;
  const end = isRefusal(e) ? "refusal" : failed(e) ? "error" : undefined;
  if (end) sc.end = end;
  else delete sc.end;
}

export function foldModels(s: ModelState, e: AgentEvent): void {
  if (isModelCommand(e)) {
    s.command = true;
    return;
  }
  if (e.kind === "notification" && e.payload.kind === "model.fallback") return foldFallback(s, e);
  if (e.kind !== "llm.call") return;
  if (isRefusal(e)) s.refusals++;
  const model = modelOf(e);
  if (!model) return;
  s.all.set(model, (s.all.get(model) ?? 0) + 1);
  foldScope(s, e, model);
  if (e.subagentId) return;
  const i = s.n++;
  let use = s.main.get(model);
  if (!use) {
    use = { calls: 0, first: i, last: i, firstTs: e.ts, lastTs: e.ts, afterCommand: s.command, tokens: noTokens() };
    s.main.set(model, use);
  }
  use.calls++;
  use.last = i;
  use.lastTs = e.ts;
  addTokens(use.tokens, e);
  const end = isRefusal(e) ? "refusal" : failed(e) ? "error" : undefined;
  if (end) use.end = end;
  else delete use.end;
  s.command = false;
}

/**
 * The first hand-over on the main thread, or undefined. For each model B in
 * the order first used, the models whose calls all came before B's first;
 * of those that qualify (see the file comment), the one used last hands over.
 */
function handOver(s: ModelState): Change | undefined {
  const uses = [...s.main].sort((a, b) => a[1].first - b[1].first);
  for (const [to, b] of uses) {
    let best: { from: string; a: ModelUse; trigger?: ModelSwitch["trigger"] } | undefined;
    for (const [from, a] of uses) {
      if (a.last >= b.first) continue;
      const trigger = a.end ?? (b.afterCommand ? "command" : undefined);
      if (!trigger && (a.calls < 2 || b.calls < 2)) continue;
      if (!best || a.last > best.a.last) best = { from, a, ...(trigger ? { trigger } : {}) };
    }
    if (best) return { from: best.from, to, at: b.firstTs, subagent: false, ...(best.trigger ? { trigger: best.trigger } : {}) };
  }
  return undefined;
}

/** USD for some calls' tokens at a model's standard list rates; undefined when the model has no price. */
function priced(t: Tokens, model: string, prices: Prices): number | undefined {
  const p = resolvePrice(model, prices)?.price;
  return p ? costFrom({ inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite }, p, t.cacheWrite1h) : undefined;
}

/**
 * Session.stats.modelSwitch: the first switch, how many there were, and what the
 * switched calls cost over the model they replaced (list prices from `prices`,
 * the built-in table by default). Undefined when nothing switched.
 */
export function modelSwitchOf(s: ModelState, prices: Prices = pricesFor()): ModelSwitch | undefined {
  let first = s.first;
  let count = s.switches;
  const off = new Map(s.off);
  const h = s.mainSwitched ? undefined : handOver(s);
  if (h) {
    count++;
    if (!first || h.at < first.at) first = h;
    const t = s.main.get(h.to)?.tokens;
    if (t?.calls) off.set(offKey(h.from, h.to), t);
  }
  if (!first) return undefined;
  let calls = 0;
  let extra: number | undefined = 0;
  for (const [k, t] of off) {
    const [from, to] = k.split("\u0000") as [string, string];
    calls += t.calls;
    const ran = priced(t, to, prices);
    const would = priced(t, from, prices);
    extra = extra === undefined || ran === undefined || would === undefined ? undefined : extra + ran - would;
  }
  return {
    from: first.from,
    to: first.to,
    at: first.at,
    ...(first.trigger ? { trigger: first.trigger } : {}),
    ...(first.reason ? { reason: first.reason } : {}),
    ...(first.subagent ? { subagent: true } : {}),
    ...(count > 1 ? { count } : {}),
    ...(calls ? { switchedCalls: calls, ...(extra !== undefined ? { extraUsd: Math.round(extra * 1e6) / 1e6 } : {}) } : {}),
  };
}

/** Calls by model, when more than one model made them. */
export function modelsOf(s: ModelState): Record<string, number> | undefined {
  return s.all.size > 1 ? Object.fromEntries([...s.all].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) : undefined;
}

/**
 * The model that made most main-thread calls (the earlier one on a tie); in a
 * session with no main-thread calls (a subagent's own session), the one that made
 * most calls. Undefined when none named one.
 */
export function mainModelOf(s: ModelState): string | undefined {
  let best: [string, ModelUse] | undefined;
  for (const u of s.main) if (!best || u[1].calls > best[1].calls || (u[1].calls === best[1].calls && u[1].first < best[1].first)) best = u;
  if (best) return best[0];
  let most: [string, number] | undefined;
  for (const u of s.all) if (!most || u[1] > most[1]) most = u;
  return most?.[0];
}

/** The `model:switch` and `model:fallback` tags and the `refusal` flag. */
export function modelFlags(s: ModelState, sw: ModelSwitch | undefined): string[] {
  const flags: string[] = [];
  if (s.refusals > 0) flags.push(REFUSAL);
  if (sw) flags.push(MODEL_SWITCH);
  if (s.fallbacks > 0) flags.push(MODEL_FALLBACK);
  return flags;
}
