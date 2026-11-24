// An explicit-state model checker for coding.sh's own tests.
//
// A model is an initial state, named actions and invariants. An action has a
// guard (when it may run) and an effect that returns the next state, or
// several when the step has more than one outcome (a crash or not, which file
// a hook picks). check() explores every state reachable from the initial ones,
// breadth first, deduped by a canonical key (stable JSON by default), within a
// depth and a state-count bound. Because the search is breadth first, the
// first broken invariant it meets is at the smallest depth, and the trace it
// returns (action names and the states between) is a shortest one.
//
// A state that is not final and has no enabled action is a deadlock, reported
// the same way. The checker only checks safety: what holds in every reachable
// state. Liveness under fairness ("every event is eventually stored") is out
// of scope; models state it as a safety property of their final states
// instead (once no process can move, every event is stored).

export interface Action<S> {
  name: string;
  /** Whether the action can run in this state (default: always). */
  guard?: (s: S) => boolean;
  /** The next state, or each possible next state. An empty list means the action cannot run here. */
  effect: (s: S) => S | readonly S[];
}

export interface Model<S> {
  /** The initial state, or a list of them. A state is an object, not an array: an array here, or from an effect, is a list of states. */
  init: S | readonly S[];
  actions: readonly Action<S>[];
  /** Each must hold in every reachable state: return true, or false or a message that says what broke. */
  invariants: Readonly<Record<string, (s: S) => boolean | string>>;
  /** States where stopping is fine. A state with no enabled action that is not final is a deadlock. */
  final?: (s: S) => boolean;
  /** Canonical key: states with the same key are one state (default: stableKey). */
  key?: (s: S) => string;
}

export interface CheckOptions {
  /** States deeper than this are not expanded (default unbounded). */
  maxDepth?: number;
  /** Stop after this many distinct states (default defaultMaxStates()). */
  maxStates?: number;
  /** Report deadlocks (default true). */
  deadlock?: boolean;
}

export interface Trace<S> {
  init: S;
  steps: { action: string; state: S }[];
}

export interface CheckResult<S> {
  /** No invariant broke and no deadlock was found in what was explored. */
  ok: boolean;
  /** Distinct states reached. */
  states: number;
  /** Transitions explored (each outcome of each enabled action from each expanded state). */
  transitions: number;
  /** The deepest level reached. */
  depth: number;
  /** False when a bound cut the search short, so `ok` covers only part of the state space. */
  complete: boolean;
  violation?: { invariant: string; message?: string; trace: Trace<S> };
  deadlock?: { trace: Trace<S> };
}

/** JSON with object keys sorted, so equal states get equal keys whatever order their fields were set in. */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return v === undefined ? "null" : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  const entries = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableKey(x)}`).join(",")}}`;
}

/** A copy of `s` changed by `f`: how effects build their next state without touching the current one. */
export function update<S>(s: S, f: (draft: S) => void): S {
  const next = structuredClone(s);
  f(next);
  return next;
}

interface Node<S> {
  state: S;
  parent: string | undefined;
  action: string | undefined;
  depth: number;
}

function traceTo<S>(nodes: Map<string, Node<S>>, key: string): Trace<S> {
  const steps: { action: string; state: S }[] = [];
  let at = nodes.get(key);
  while (at && at.parent !== undefined && at.action !== undefined) {
    steps.push({ action: at.action, state: at.state });
    at = nodes.get(at.parent);
  }
  if (!at) throw new Error("a trace led to an unknown state");
  return { init: at.state, steps: steps.reverse() };
}

/**
 * The cap on distinct states when a check names none: a million, more than any model reaches at its
 * default bounds, or 16 million when CODING_SH_MODEL_BOUND is above 0 and the models grow. A Map holds
 * at most 2^24 entries. Each state takes about 1 to 2.5 KB of heap.
 */
export function defaultMaxStates(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.CODING_SH_MODEL_BOUND ?? "0") > 0 ? 16_000_000 : 1_000_000;
}

/** Explores the model breadth first and reports the first broken invariant or deadlock, with a shortest trace. */
export function check<S>(model: Model<S>, opts: CheckOptions = {}): CheckResult<S> {
  const key = model.key ?? stableKey;
  const maxDepth = opts.maxDepth ?? Infinity;
  const maxStates = opts.maxStates ?? defaultMaxStates();
  const nodes = new Map<string, Node<S>>();
  const queue: string[] = [];
  let transitions = 0;
  let depth = 0;
  let complete = true;
  const result = (extra: Partial<CheckResult<S>> = {}): CheckResult<S> => ({ ok: !extra.violation && !extra.deadlock, states: nodes.size, transitions, depth, complete, ...extra });
  const broken = (s: S): { invariant: string; message?: string } | undefined => {
    for (const [name, inv] of Object.entries(model.invariants)) {
      const r = inv(s);
      if (r === true) continue;
      return typeof r === "string" ? { invariant: name, message: r } : { invariant: name };
    }
    return undefined;
  };
  // Adds a state; returns a violation when the new state breaks an invariant.
  const add = (state: S, parent: string | undefined, action: string | undefined, d: number): CheckResult<S> | undefined => {
    const k = key(state);
    if (nodes.has(k)) return undefined;
    if (nodes.size >= maxStates) {
      complete = false;
      return undefined;
    }
    nodes.set(k, { state, parent, action, depth: d });
    depth = Math.max(depth, d);
    queue.push(k);
    const bad = broken(state);
    return bad ? result({ violation: { ...bad, trace: traceTo(nodes, k) } }) : undefined;
  };
  for (const s of Array.isArray(model.init) ? (model.init as readonly S[]) : [model.init as S]) {
    const r = add(s, undefined, undefined, 0);
    if (r) return r;
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head] as string;
    const node = nodes.get(k);
    if (!node) continue;
    let enabled = false;
    const expand = node.depth < maxDepth;
    for (const a of model.actions) {
      if (a.guard && !a.guard(node.state)) continue;
      const out = a.effect(node.state);
      const nexts = Array.isArray(out) ? (out as readonly S[]) : [out as S];
      if (!nexts.length) continue;
      enabled = true;
      if (!expand) {
        complete = false;
        break;
      }
      for (const n of nexts) {
        transitions++;
        const r = add(n, k, a.name, node.depth + 1);
        if (r) return r;
      }
    }
    if (!enabled && opts.deadlock !== false && !model.final?.(node.state)) return result({ deadlock: { trace: traceTo(nodes, k) } });
  }
  return result();
}

/** A trace as text: one line per step, the action then the state it led to. */
export function formatTrace<S>(trace: Trace<S>, show: (s: S) => string = stableKey): string {
  return [`init  ${show(trace.init)}`, ...trace.steps.map((st, i) => `${String(i + 1).padStart(4)}. ${st.action}\n      ${show(st.state)}`)].join("\n");
}

/** The action names of a trace, in order. */
export function actionsOf<S>(trace: Trace<S>): string[] {
  return trace.steps.map((st) => st.action);
}
