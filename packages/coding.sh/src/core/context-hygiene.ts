// Long-horizon context degradation and supervision risk telemetry folded into
// Session.stats.contextHygiene. Complements Session.stats.compactionRefetches (core/waste.ts).
// Pure: rules over events, no I/O.
import type { AgentEvent, CompactionRefetchStats, ContextHygieneStats, SupervisionRisk, VerificationStats } from "../schema/index.ts";
import { isFileEditTool, isShellCall } from "../adapters/_shared/tools.ts";
import type { ToolFailure } from "./failures.ts";
import { outText } from "./proof.ts";
// sessions.ts imports this module; read commandOf inside functions only.
import { commandOf } from "./sessions.ts";

const OPEN_MAX = 256;
const RECENT_IDS_MAX = 256;
const FAILED_KEYS_MAX = 256;
const PRE_COMPACT_MAX = 512;
const KEY_MAX = 300;

/** Plain v8-serializable fold state for Session.stats.contextHygiene. */
export interface ContextHygieneState {
  compactions: number;
  postCompactionFailedRepeats: number;
  /** Longest consecutive streak of real failed tool calls across scopes. */
  maxDeadEndStreak: number;
  /** Current consecutive streak of real failed tool calls per scope (`subagentId ?? ""`). */
  streak: Map<string, number>;
  /** Total characters of real failing tool output injected into context. */
  failedOutputChars: number;
  /** Open shell/edit call action keys by toolUseId. */
  open: Map<string, string>;
  /** toolUseIds whose tool.end already folded here (dedupes cross-path copies). */
  endedIds: Set<string>;
  /** Per scope: normalized keys of failed commands/edits in the current context window. */
  currentFailed: Map<string, Set<string>>;
  /** Per scope: normalized keys of failed commands/edits from before a compaction. */
  preCompactFailed: Map<string, Set<string>>;
}

export function contextHygieneState(): ContextHygieneState {
  return {
    compactions: 0,
    postCompactionFailedRepeats: 0,
    maxDeadEndStreak: 0,
    streak: new Map(),
    failedOutputChars: 0,
    open: new Map(),
    endedIds: new Set(),
    currentFailed: new Map(),
    preCompactFailed: new Map(),
  };
}

export interface ContextHygieneFacts {
  seen: ReadonlySet<string>;
  failure?: ToolFailure;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function addBoundedSet(set: Set<string>, value: string, max: number): void {
  set.delete(value);
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function setBoundedMap<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Stable JSON serialization with sorted keys for edit-tool input comparison. */
function canonical(v: unknown, depth = 0): string {
  if (depth > 8) return "…";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k], depth + 1)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** FNV-1a 32-bit hash in base36 for compact key comparison. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Normalized key for a shell command or file-edit tool call; undefined for other tools. */
function actionKey(tool: string, input: unknown): string | undefined {
  if (!tool) return undefined;
  if (isShellCall(tool, input)) {
    const cmd = commandOf(input);
    if (!cmd?.trim()) return undefined;
    const norm = cmd.replace(/\s+/g, " ").trim();
    return norm.length <= KEY_MAX ? `cmd:${norm}` : `cmd:${norm.slice(0, KEY_MAX)}:${shortHash(norm)}`;
  }
  if (isFileEditTool(tool)) {
    const body = canonical(input);
    return `edit:${tool.toLowerCase()}:${body.length <= KEY_MAX ? body : `${body.slice(0, KEY_MAX)}:${shortHash(body)}`}`;
  }
  return undefined;
}

function outputCharsOf(payload: Record<string, unknown>): number {
  const out = payload.output !== undefined ? payload.output : payload.error;
  if (out === undefined || out === null) return 0;
  if (typeof out === "string") return out.length;
  const text = outText(out);
  if (text) return text.length;
  try {
    return JSON.stringify(out)?.length ?? 0;
  } catch {
    return 0;
  }
}

function scopeSet(map: Map<string, Set<string>>, scope: string): Set<string> {
  let set = map.get(scope);
  if (!set) {
    set = new Set();
    map.set(scope, set);
  }
  return set;
}

/** Folds the next event in time order into a ContextHygieneState. */
export function foldContextHygiene(s: ContextHygieneState, e: AgentEvent, o: ContextHygieneFacts): void {
  const scope = e.subagentId ?? "";
  if (e.kind === "context.compact") {
    s.compactions++;
    const cur = s.currentFailed.get(scope);
    if (cur?.size) {
      const pre = scopeSet(s.preCompactFailed, scope);
      for (const k of cur) addBoundedSet(pre, k, PRE_COMPACT_MAX);
      cur.clear();
    }
    return;
  }

  const p = e.payload;
  if ((e.kind !== "tool.start" && e.kind !== "tool.end") || p.wrapper === true) return;
  const id = str(p.toolUseId);
  const tool = str(p.tool) ?? "";

  if (e.kind === "tool.start") {
    if (id && o.seen.has(id)) return;
    if (!id) return;
    const key = actionKey(tool, p.input);
    if (key) setBoundedMap(s.open, id, key, OPEN_MAX);
    return;
  }

  // tool.end
  if (id) {
    if (s.endedIds.has(id)) return;
    addBoundedSet(s.endedIds, id, RECENT_IDS_MAX);
  }

  let key = id ? s.open.get(id) : undefined;
  if (id && key !== undefined) s.open.delete(id);
  if (key === undefined && p.input !== undefined) key = actionKey(tool, p.input);

  if (p.ok !== false) {
    s.streak.set(scope, 0);
    if (key) {
      s.currentFailed.get(scope)?.delete(key);
      s.preCompactFailed.get(scope)?.delete(key);
    }
    return;
  }

  // Benign failures (rg no-match, probe, diff) and user interrupts are neither dead ends nor recoveries.
  if (o.failure && o.failure.cls !== "real") return;

  const curStreak = (s.streak.get(scope) ?? 0) + 1;
  s.streak.set(scope, curStreak);
  if (curStreak > s.maxDeadEndStreak) s.maxDeadEndStreak = curStreak;

  s.failedOutputChars += outputCharsOf(p);

  if (key) {
    const pre = s.preCompactFailed.get(scope);
    if (pre?.has(key)) {
      s.postCompactionFailedRepeats++;
      pre.delete(key);
    }
    addBoundedSet(scopeSet(s.currentFailed, scope), key, FAILED_KEYS_MAX);
  }
}

/**
 * Derives Session.stats.contextHygiene from a folded ContextHygieneState and companion stats.
 * Returns undefined when no signal is non-zero and supervision risk is low.
 */
export function contextHygieneOf(
  s: ContextHygieneState,
  o: { verification?: VerificationStats; compactionRefetches?: CompactionRefetchStats } = {},
): ContextHygieneStats | undefined {
  const reasons: string[] = [];
  let high = false;

  const maxUnverified = o.verification?.maxUnverifiedEdits ?? 0;
  const tailUnverified = o.verification?.unverifiedTailEdits ?? 0;
  if (maxUnverified >= 5 || tailUnverified >= 3) {
    reasons.push("unverified-edits");
    if (maxUnverified >= 10 || tailUnverified >= 6) high = true;
  }

  const oscillating = o.verification?.proof?.oscillatingChecks ?? 0;
  if (oscillating >= 2) {
    reasons.push("tactic-oscillation");
    if (oscillating >= 4) high = true;
  }

  if (s.postCompactionFailedRepeats >= 1) {
    reasons.push("post-compaction-repeats");
    if (s.postCompactionFailedRepeats >= 3) high = true;
  }

  if (s.maxDeadEndStreak >= 3) {
    reasons.push("dead-end-loop");
    if (s.maxDeadEndStreak >= 5) high = true;
  }

  const refetchCalls = o.compactionRefetches?.calls ?? 0;
  if (s.compactions >= 2 || (s.compactions >= 1 && refetchCalls >= 3)) {
    reasons.push("compaction-churn");
    if (s.compactions >= 4 || (s.compactions >= 2 && refetchCalls >= 6)) high = true;
  }

  const risk: SupervisionRisk | undefined = reasons.length === 0 ? undefined : high || reasons.length >= 2 ? "high" : "medium";
  const deadEnd = s.maxDeadEndStreak >= 2 ? s.maxDeadEndStreak : 0;

  if (!s.compactions && !s.postCompactionFailedRepeats && !deadEnd && !s.failedOutputChars && !risk) return undefined;

  const out: ContextHygieneStats = {};
  if (s.compactions > 0) out.compactions = s.compactions;
  if (s.postCompactionFailedRepeats > 0) out.postCompactionFailedRepeats = s.postCompactionFailedRepeats;
  if (deadEnd >= 2) out.deadEndStreak = deadEnd;
  if (s.failedOutputChars > 0) out.failedOutputChars = s.failedOutputChars;
  if (risk) {
    out.supervisionRisk = risk;
    out.riskReasons = reasons;
  }
  return out;
}
