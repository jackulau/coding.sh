// Which models a session's model calls ran on (Session.stats.models), the
// main thread's hand-over from one model to another (Session.stats.modelSwitch
// and the `model:switch` tag), and refused calls (the `refusal` flag).
// Pure over a session's llm.call events, as a fold (foldModels) live ingest keeps.
//
// Main thread: llm.call events without a subagentId. A switch from model A to
// model B is a hand-over: every main-thread call on A comes before the first
// one on B. A helper model that runs beside the main one (Claude Code's Haiku
// calls for titles and checks, seen over OpenTelemetry) overlaps it and is
// never a switch. Each side needs at least two calls, so a single helper call
// before or after all the others (a title, a summary) is not a switch either,
// unless A's last call was refused or failed, or a /model command came right
// before B's first call: that names the trigger.
import type { AgentEvent, ModelSwitch } from "../schema/index.ts";

/** A tag (namespaced, so failureFlags() leaves it out): the main-thread model changed mid-session. */
export const MODEL_SWITCH = "model:switch";
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
}

export const modelState = (): ModelState => ({ all: new Map(), main: new Map(), n: 0, refusals: 0, command: false });

export function foldModels(s: ModelState, e: AgentEvent): void {
  if (isModelCommand(e)) {
    s.command = true;
    return;
  }
  if (e.kind !== "llm.call") return;
  if (isRefusal(e)) s.refusals++;
  const model = modelOf(e);
  if (!model) return;
  s.all.set(model, (s.all.get(model) ?? 0) + 1);
  if (e.subagentId) return;
  const i = s.n++;
  let use = s.main.get(model);
  if (!use) {
    use = { calls: 0, first: i, last: i, firstTs: e.ts, lastTs: e.ts, afterCommand: s.command };
    s.main.set(model, use);
  }
  use.calls++;
  use.last = i;
  use.lastTs = e.ts;
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
export function modelSwitchOf(s: ModelState): ModelSwitch | undefined {
  const uses = [...s.main].sort((a, b) => a[1].first - b[1].first);
  for (const [to, b] of uses) {
    let best: { from: string; a: ModelUse; trigger?: ModelSwitch["trigger"] } | undefined;
    for (const [from, a] of uses) {
      if (a.last >= b.first) continue;
      const trigger = a.end ?? (b.afterCommand ? "command" : undefined);
      if (!trigger && (a.calls < 2 || b.calls < 2)) continue;
      if (!best || a.last > best.a.last) best = { from, a, ...(trigger ? { trigger } : {}) };
    }
    if (best) return { from: best.from, to, at: b.firstTs, ...(best.trigger ? { trigger: best.trigger } : {}) };
  }
  return undefined;
}

/** Calls by model, when more than one model made them. */
export function modelsOf(s: ModelState): Record<string, number> | undefined {
  return s.all.size > 1 ? Object.fromEntries([...s.all].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) : undefined;
}

/** The model that made most main-thread calls (the earlier one on a tie), or undefined when none named one. */
export function mainModelOf(s: ModelState): string | undefined {
  let best: [string, ModelUse] | undefined;
  for (const u of s.main) if (!best || u[1].calls > best[1].calls || (u[1].calls === best[1].calls && u[1].first < best[1].first)) best = u;
  return best?.[0];
}

/** The `model:switch` tag and the `refusal` flag. */
export function modelFlags(s: ModelState, sw: ModelSwitch | undefined): string[] {
  const flags: string[] = [];
  if (s.refusals > 0) flags.push(REFUSAL);
  if (sw) flags.push(MODEL_SWITCH);
  return flags;
}
