// Text hooks added to the model's context: `notification` events with
// `payload.kind: "hook.context"` (adapters/_shared/claude-transcript.ts),
// folded into Session.stats.hookContext and `hook:<source>` session tags.
import type { AgentEvent, HookContextStats } from "../schema/index.ts";

/** Tag prefix: `hook:plugin:terse`, `hook:settings`, … */
export const HOOK_TAG_PREFIX = "hook:";
/** At most this many sources tagged per session, in first-seen order. */
const HOOK_TAG_MAX = 20;

/** What the fold keeps: totals and per-source totals, in first-seen order. Serializable (node:v8). */
export interface HookContextState {
  count: number;
  tokens: number;
  bySource: Map<string, { count: number; tokens: number }>;
}

export const hookContextState = (): HookContextState => ({ count: 0, tokens: 0, bySource: new Map() });

/** True for a hook.context event. */
export const isHookContext = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.kind === "hook.context";

export function foldHookContext(s: HookContextState, e: AgentEvent): void {
  if (!isHookContext(e)) return;
  const tokens = typeof e.payload.tokens === "number" && e.payload.tokens > 0 ? e.payload.tokens : 0;
  const source = typeof e.payload.hookSource === "string" && e.payload.hookSource ? e.payload.hookSource : "unknown";
  s.count++;
  s.tokens += tokens;
  const b = s.bySource.get(source) ?? { count: 0, tokens: 0 };
  b.count++;
  b.tokens += tokens;
  s.bySource.set(source, b);
}

/** Session.stats.hookContext, or undefined when no hook added context. */
export function hookContextOf(s: HookContextState | undefined): HookContextStats | undefined {
  if (!s?.count) return undefined;
  return { count: s.count, tokens: s.tokens, bySource: Object.fromEntries([...s.bySource].map(([k, v]) => [k, { ...v }])) };
}

/** `hook:<source>` tags, in first-seen order. */
export function hookContextFlags(s: HookContextState | undefined): string[] {
  return s ? [...s.bySource.keys()].slice(0, HOOK_TAG_MAX).map((k) => `${HOOK_TAG_PREFIX}${k}`) : [];
}
