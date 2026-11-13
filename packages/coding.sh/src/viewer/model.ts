// The span model the viewer reads a session through: turns, tool and model
// calls, subagents, compactions and failures, built in one pass over the
// session's time-sorted events (the order IndexStore.listEvents returns).
//
// The model keeps one byte per event (its kind) and the indexes of the events
// that matter, so a 150,000-event session costs about 150 KB and its outline
// is a few kilobytes. Rows are laid out from the model, then only the events a
// page shows are read. Long runs of routine events (model calls, successful
// tool calls) fold into one row; a failure is never inside a fold.
import { failureState, foldFailure } from "../core/failures.ts";
import type { IndexStore } from "../core/types.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { isWeightsEvent, weightsEventText } from "../core/weights.ts";

/** Bump when the model's shape or its rules change: cached models are rebuilt. */
export const MODEL_VERSION = 3; // 2: a weight edit has its own code, so a fold never hides it. 3: a weights checkpoint has that code too.

const KINDS = ["other", "session.start", "session.end", "user.message", "assistant.message", "llm.call", "tool.start", "tool.end", "context.compact", "turn.end", "subagent.start", "subagent.end", "file.change", "test.result", "notification", "span", "error", "weights.edit"] as const;
const CODE = new Map<string, number>(KINDS.map((k, i) => [k, i]));
const C = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<(typeof KINDS)[number], number>;
/** Kinds a fold may hide: routine work. Prompts, replies, compactions, subagent edges, file changes and tests stay rows. */
const QUIET = new Set([C.other, C["llm.call"], C["tool.start"], C["tool.end"], C.span, C.notification, C["turn.end"]]);

export interface TurnSpan {
  n: number;
  /** First and last event index, inclusive. */
  start: number;
  end: number;
  ts: number;
  endTs: number;
  turnId?: string;
  /** The prompt that opened the turn, cut to PROMPT_CHARS. Turn 0 has none when events came before the first prompt. */
  prompt?: string;
  tools: number;
  calls: number;
  failures: number;
  subagents: number;
  compactions: number;
}

export interface SubagentSpan {
  id: string;
  start: number;
  /** -1 while it runs (no subagent.end yet). */
  end: number;
  type?: string;
  childSessionId?: string;
  failed?: true;
}

export interface SessionModel {
  v: number;
  /** What the model was built from (see modelKey); a different key means rebuild. */
  key: string;
  events: number;
  /** One kind code per event index. */
  codes: Uint8Array;
  /** Indexes of failed events: a failed tool call, an error, a failed model call, subagent or test run. Sorted. */
  failed: number[];
  compactions: number[];
  turns: TurnSpan[];
  subagents: SubagentSpan[];
  tools: number;
  calls: number;
}

export const PROMPT_CHARS = 160;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Whether an event is a failure. `toolFailed` is foldFailure's verdict for a tool.end. */
function failedEvent(e: AgentEvent, toolFailed: boolean): boolean {
  const p = e.payload;
  switch (e.kind) {
    case "tool.end":
      return toolFailed || p.ok === false;
    case "error":
      return true;
    case "llm.call":
    case "subagent.end":
      return p.ok === false;
    case "test.result":
      return typeof p.failed === "number" && p.failed > 0;
    default:
      return false;
  }
}

/** The cache key for a session: its event count and time bounds. */
export function modelKey(s: Pick<Session, "id" | "startedAt" | "endedAt" | "stats" | "parseVersion">): string {
  return [s.id, s.stats.events ?? 0, s.startedAt ?? 0, s.endedAt ?? 0, s.parseVersion ?? ""].join(":");
}

/** Builds the model in one pass. `sorted` is in listEvents order. */
export function buildModel(sorted: readonly AgentEvent[], key = ""): SessionModel {
  const b = modelBuilder(key);
  b.add(sorted);
  return b.finish();
}

/** The same fold fed in pages, so a long session is read a page at a time. */
export function modelBuilder(key = ""): { add(batch: readonly AgentEvent[]): void; finish(): SessionModel } {
  let n = 0;
  let codes = new Uint8Array(1024);
  const failed: number[] = [];
  const compactions: number[] = [];
  const turns: TurnSpan[] = [];
  const subagents: SubagentSpan[] = [];
  const openSub = new Map<string, SubagentSpan>();
  const seenTurnIds = new Set<string>();
  const fs = failureState();
  let tools = 0;
  let calls = 0;
  let turn: TurnSpan | undefined;
  let own: string | undefined;
  const open = (i: number, e: AgentEvent, prompt?: string) => {
    if (turn) turn.end = i - 1;
    turn = { n: turns.length, start: i, end: i, ts: e.ts, endTs: e.ts, tools: 0, calls: 0, failures: 0, subagents: 0, compactions: 0 };
    if (e.turnId) turn.turnId = e.turnId;
    if (prompt !== undefined) turn.prompt = cut(prompt.replace(/\s+/g, " ").trim(), PROMPT_CHARS);
    turns.push(turn);
  };
  const add = (batch: readonly AgentEvent[]) => {
    for (const e of batch) {
      const i = n++;
      if (i >= codes.length) {
        const grown = new Uint8Array(codes.length * 2);
        grown.set(codes);
        codes = grown;
      }
      const code = isWeightsEvent(e) ? C["weights.edit"] : (CODE.get(e.kind) ?? C.other);
      codes[i] = code;
      const toolFailed = foldFailure(fs, e) !== undefined;
      // A turn opens at the main agent's prompt, or at a turn id not seen before (an agent
      // that marks turns but logs no prompt). Subagent events stay in the turn that ran them.
      // A subagent's own session marks its events with its id: those are its main line.
      if (i === 0 && e.kind === "session.start" && e.subagentId) own = e.subagentId;
      const main = !e.subagentId || e.subagentId === own;
      if (main && code === C["user.message"]) {
        // The first prompt takes in what came before it (session.start, a turn id with no work yet).
        if (turn && turn.prompt === undefined && turn.tools === 0 && turn.calls === 0 && turn.failures === 0) {
          turn.prompt = cut(text(e.payload.text).replace(/\s+/g, " ").trim(), PROMPT_CHARS);
          if (e.turnId && turn.turnId === undefined) turn.turnId = e.turnId;
        } else open(i, e, text(e.payload.text));
      }
      else if (main && e.turnId && !seenTurnIds.has(e.turnId) && turn?.turnId !== undefined && turn.turnId !== e.turnId) open(i, e);
      else if (!turn) open(i, e);
      if (e.turnId) {
        seenTurnIds.add(e.turnId);
        if (turn!.turnId === undefined && main) turn!.turnId = e.turnId;
      }
      const t = turn!;
      t.end = i;
      if (e.ts > t.endTs) t.endTs = e.ts;
      if (code === C["tool.start"]) {
        // A wrapper (a Codex code-mode cell) runs the calls that count; it is not one itself.
        if (e.payload.wrapper !== true) { tools++; t.tools++; }
      } else if (code === C["llm.call"]) {
        calls++;
        t.calls++;
      } else if (code === C["context.compact"]) {
        compactions.push(i);
        t.compactions++;
      } else if (code === C["subagent.start"]) {
        const id = text(e.payload.subagentId) || e.subagentId || e.id;
        const s: SubagentSpan = { id, start: i, end: -1 };
        const type = text(e.payload.type);
        if (type) s.type = type;
        const child = text(e.payload.childSessionId);
        if (child) s.childSessionId = child;
        subagents.push(s);
        openSub.set(id, s);
        t.subagents++;
      } else if (code === C["subagent.end"]) {
        const id = text(e.payload.subagentId) || e.subagentId || "";
        const s = openSub.get(id);
        if (s) {
          s.end = i;
          openSub.delete(id);
          const child = text(e.payload.childSessionId);
          if (child && !s.childSessionId) s.childSessionId = child;
        }
      }
      if (failedEvent(e, toolFailed)) {
        failed.push(i);
        t.failures++;
        if (code === C["subagent.end"]) {
          const s = openSub.get(text(e.payload.subagentId)) ?? subagents.findLast((x) => x.end === i);
          if (s) s.failed = true;
        }
      }
    }
  };
  const finish = (): SessionModel => ({ v: MODEL_VERSION, key, events: n, codes: codes.slice(0, n), failed, compactions, turns, subagents, tools, calls });
  return { add, finish };
}

// ---------------------------------------------------------------- outline

export const MINIMAP_BUCKETS = 120;
export const OUTLINE_LIST_CAP = 100;
export const OUTLINE_TURNS_CAP = 2000;

/** The additive outline fields: turns, failures, compactions, subagents and a minimap, sized for one response. */
export function modelOutline(m: SessionModel) {
  const cap = <T>(xs: readonly T[], n: number) => (xs.length > n ? xs.slice(0, n) : xs);
  const buckets = Math.min(MINIMAP_BUCKETS, m.events);
  const size = buckets ? Math.ceil(m.events / buckets) : 0;
  // [events, failures, tool calls, compactions] per bucket of `size` events.
  const rows: [number, number, number, number][] = [];
  for (let b = 0; b * size < m.events; b++) rows.push([Math.min(size, m.events - b * size), 0, 0, 0]);
  for (const i of m.failed) rows[Math.floor(i / size)]![1]++;
  for (const i of m.compactions) rows[Math.floor(i / size)]![3]++;
  for (let i = 0; i < m.events; i++) if (m.codes[i] === C["tool.start"]) rows[Math.floor(i / size)]![2]++;
  return {
    turns: {
      count: m.turns.length,
      // Events per turn; a turn's first event index is the sum of the lengths before it.
      lengths: cap(m.turns, OUTLINE_TURNS_CAP).map((t) => t.end - t.start + 1),
      failed: m.turns.filter((t) => t.failures > 0).map((t) => t.n).slice(0, OUTLINE_LIST_CAP),
      ...(m.turns.length > OUTLINE_TURNS_CAP ? { truncated: true } : {}),
    },
    failures: { count: m.failed.length, at: cap(m.failed, OUTLINE_LIST_CAP) },
    compactions: cap(m.compactions, OUTLINE_LIST_CAP),
    subagents: { count: m.subagents.length, items: cap(m.subagents, 50) },
    minimap: { size, rows },
  };
}

// ---------------------------------------------------------------- rows

/** A run of this many routine events folds; its first and last FOLD_EDGE stay rows. */
export const FOLD_MIN = 12;
export const FOLD_EDGE = 3;
export const ROWS_LIMIT = 200;
export const ROWS_MAX = 1000;

export interface EventRow {
  i: number;
  id: string;
  kind: string;
  ts: number;
  label: string;
  failed?: true;
  subagentId?: string;
  parentId?: string;
  durationMs?: number;
  blobs?: unknown;
}
export interface FoldRow {
  fold: { from: number; to: number; events: number; tools: number; calls: number };
}
export type Row = EventRow | FoldRow;

type Slot = { i: number } | { from: number; to: number };

/** The page's layout from the model alone: event indexes and folds, up to `limit` rows from `from`. */
export function layoutRows(m: SessionModel, t: TurnSpan, from: number, limit: number, fold = true): { slots: Slot[]; next?: number } {
  const failed = new Set<number>();
  for (const i of m.failed) if (i >= from && i <= t.end) failed.add(i);
  const quiet = (i: number) => QUIET.has(m.codes[i]!) && !failed.has(i);
  const slots: Slot[] = [];
  let i = from;
  while (i <= t.end && slots.length < limit) {
    if (fold && quiet(i)) {
      let j = i;
      while (j + 1 <= t.end && quiet(j + 1)) j++;
      if (j - i + 1 >= FOLD_MIN) {
        const head = i + FOLD_EDGE - 1;
        for (let k = i; k <= head && slots.length < limit; k++) slots.push({ i: k });
        if (slots.length >= limit) return { slots, next: (slots[slots.length - 1] as { i: number }).i + 1 };
        slots.push({ from: head + 1, to: j - FOLD_EDGE });
        for (let k = j - FOLD_EDGE + 1; k <= j && slots.length < limit; k++) slots.push({ i: k });
        const last = slots[slots.length - 1]!;
        i = ("i" in last ? last.i : last.to) + 1;
        if (slots.length >= limit) break;
        continue;
      }
    }
    slots.push({ i });
    i++;
  }
  return i <= t.end ? { slots, next: i } : { slots };
}

/** One line for an event row. */
export function rowLabel(e: AgentEvent): string {
  const p = e.payload;
  switch (e.kind) {
    case "user.message":
    case "assistant.message":
      return cut(text(p.text).replace(/\s+/g, " ").trim(), 200);
    case "tool.start":
    case "tool.end": {
      const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : undefined;
      const arg = input ? text(input.command) || text(input.file_path) || text(input.path) || text(input.pattern) || text(input.url) || text(input.description) : "";
      return cut([text(p.tool) || "tool", arg.replace(/\s+/g, " ")].filter(Boolean).join(" "), 200);
    }
    case "llm.call":
      return text(p.responseModel) || text(p.requestModel) || e.model || "model call";
    case "subagent.start":
    case "subagent.end":
      return cut([text(p.type) || "subagent", text(p.description)].filter(Boolean).join(": "), 200);
    case "file.change":
      return [text(p.op), text(p.path)].filter(Boolean).join(" ");
    case "test.result":
      return `${typeof p.passed === "number" ? p.passed : 0} passed, ${typeof p.failed === "number" ? p.failed : 0} failed`;
    case "context.compact":
      return `compacted (${text(p.trigger) || "auto"})`;
    case "error":
      return cut(text(p.message), 200);
    case "span":
      return text(p.name);
    case "notification": {
      const weights = weightsEventText(p);
      return weights !== undefined ? cut(weights, 200) || "weights.edit" : e.kind;
    }
    default:
      return e.kind;
  }
}

/** Reads the events behind `slots` in contiguous runs and returns the page's rows. */
export async function readRows(index: Pick<IndexStore, "listEvents">, sessionId: string, m: SessionModel, slots: Slot[]): Promise<Row[]> {
  const failed = new Set(m.failed);
  const at = new Map<number, AgentEvent>();
  const wanted = slots.flatMap((s) => ("i" in s ? [s.i] : []));
  for (let a = 0; a < wanted.length; ) {
    let b = a;
    while (b + 1 < wanted.length && wanted[b + 1] === wanted[b]! + 1) b++;
    const evs = await index.listEvents(sessionId, { offset: wanted[a], limit: b - a + 1 });
    evs.forEach((e, k) => at.set(wanted[a]! + k, e));
    a = b + 1;
  }
  const rows: Row[] = [];
  for (const s of slots) {
    if ("from" in s) {
      let tools = 0;
      let calls = 0;
      for (let k = s.from; k <= s.to; k++) {
        if (m.codes[k] === C["tool.start"]) tools++;
        else if (m.codes[k] === C["llm.call"]) calls++;
      }
      rows.push({ fold: { from: s.from, to: s.to, events: s.to - s.from + 1, tools, calls } });
      continue;
    }
    const e = at.get(s.i);
    if (!e) continue;
    const r: EventRow = { i: s.i, id: e.id, kind: e.kind, ts: e.ts, label: rowLabel(e) };
    if (failed.has(s.i)) r.failed = true;
    if (e.subagentId) r.subagentId = e.subagentId;
    if (e.parentId) r.parentId = e.parentId;
    if (typeof e.durationMs === "number") r.durationMs = e.durationMs;
    if (e.blobs && (e.blobs as unknown[]).length) r.blobs = e.blobs;
    rows.push(r);
  }
  return rows;
}

// ---------------------------------------------------------------- cache

/** Sessions this long are kept in the store's kv too, so a restarted viewer does not fold them again. */
export const PERSIST_MIN_EVENTS = 5000;
/** Events read per page while building a model. */
export const BUILD_PAGE = 5000;
const KV_PREFIX = "viewer.model:";

function encode(m: SessionModel): string {
  return JSON.stringify({ ...m, codes: Buffer.from(m.codes.buffer, m.codes.byteOffset, m.codes.byteLength).toString("base64") });
}
function decode(s: string): SessionModel | undefined {
  try {
    const o = JSON.parse(s) as Omit<SessionModel, "codes"> & { codes: string };
    if (o.v !== MODEL_VERSION) return undefined;
    return { ...o, codes: new Uint8Array(Buffer.from(o.codes, "base64")) };
  } catch {
    return undefined;
  }
}

/** Models by session, newest use last; at most `size` kept in memory. */
export class ModelCache {
  readonly size: number;
  private map = new Map<string, SessionModel>();
  private pending = new Map<string, Promise<SessionModel>>();
  constructor(size = 8) {
    this.size = size;
  }
  /** The model when it is ready without folding the session (in memory or in the kv), else undefined. */
  async peek(index: Pick<IndexStore, "kvGet">, s: Pick<Session, "id" | "startedAt" | "endedAt" | "stats" | "parseVersion">): Promise<SessionModel | undefined> {
    const key = modelKey(s);
    const hit = this.map.get(s.id);
    if (hit && hit.key === key) return this.touch(s.id, hit);
    const m = await this.stored(index, s, key);
    return m ? this.touch(s.id, m) : undefined;
  }
  private touch(id: string, m: SessionModel): SessionModel {
    this.map.delete(id);
    this.map.set(id, m);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
    return m;
  }
  private async stored(index: Pick<IndexStore, "kvGet">, s: Pick<Session, "id" | "stats">, key: string): Promise<SessionModel | undefined> {
    if ((s.stats.events ?? 0) < PERSIST_MIN_EVENTS || !index.kvGet) return undefined;
    const raw = await index.kvGet(KV_PREFIX + s.id).catch(() => undefined);
    const m = raw ? decode(raw) : undefined;
    return m && m.key === key ? m : undefined;
  }
  async get(index: Pick<IndexStore, "listEvents" | "kvGet" | "kvSet">, s: Pick<Session, "id" | "startedAt" | "endedAt" | "stats" | "parseVersion">): Promise<SessionModel> {
    const key = modelKey(s);
    const hit = this.map.get(s.id);
    if (hit && hit.key === key) return this.touch(s.id, hit);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const big = (s.stats.events ?? 0) >= PERSIST_MIN_EVENTS && !!index.kvGet && !!index.kvSet;
      const kept = big ? await this.stored(index, s, key) : undefined;
      if (kept) return kept;
      // A page at a time, yielding between pages: a SQLite read is synchronous, and the
      // viewer keeps answering other requests while a 150k-event session folds.
      const b = modelBuilder(key);
      for (let offset = 0; ; offset += BUILD_PAGE) {
        const page = await index.listEvents(s.id, { offset, limit: BUILD_PAGE });
        b.add(page);
        if (page.length < BUILD_PAGE) break;
        await new Promise((r) => setImmediate(r));
      }
      const m = b.finish();
      if (big) await index.kvSet!(KV_PREFIX + s.id, encode(m)).catch(() => undefined);
      return m;
    })();
    this.pending.set(key, p);
    try {
      return this.touch(s.id, await p);
    } finally {
      this.pending.delete(key);
    }
  }
}
