// Building blocks for normalize()/backfill(): an event emitter with
// deterministic ids, payload clipping (large values → blobs), usage mapping
// and small type guards for untyped agent JSON.
import type { AgentEvent, AgentId, BlobRef, EventKind, Usage } from "../../schema/index.ts";
import { SCHEMA_VERSION } from "../../schema/index.ts";
import type { BackfillFile, NormalizeContext, SpoolLine } from "../../core/types.ts";
import { resolveRaw } from "../../spool/write.ts";

// ---------------------------------------------------------------- guards

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The spool line's payload (reads the side file for oversized payloads). */
export function lineRaw(line: SpoolLine): unknown {
  if (line.raw !== undefined || !line.rawFile) return line.raw;
  try {
    return resolveRaw(line);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- clipping

/** Per-field inline budget: keeps a payload well under the 4 KB convention. */
export function fieldLimit(ctx: NormalizeContext, share = 1536): number {
  return Math.max(64, Math.min(ctx.maxInlineBytes || share, share));
}

function cutUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let out = Buffer.from(s).subarray(0, maxBytes).toString("utf8");
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

export interface Clipped<T> {
  value: T;
  /** Blob holding the full value when it was clipped. */
  blob?: BlobRef;
  truncated: boolean;
}

/** Clip a string to `limit` bytes; the full text goes to a blob when clipped. */
export async function clipText(ctx: NormalizeContext, s: string, limit = fieldLimit(ctx)): Promise<Clipped<string>> {
  if (Buffer.byteLength(s) <= limit) return { value: s, truncated: false };
  const blob = await ctx.blob(s);
  return { value: `${cutUtf8(s, limit)}…`, blob, truncated: true };
}

/**
 * Clip any JSON value: small values stay as-is. A large object or array keeps
 * its shape, with its longest strings cut until it fits (so consumers still
 * read input.command / input.description); the full JSON goes to a blob. Only
 * when cutting strings cannot make it fit does it become a string preview.
 */
export async function clipValue(ctx: NormalizeContext, v: unknown, limit = fieldLimit(ctx)): Promise<Clipped<unknown>> {
  if (v === undefined) return { value: undefined, truncated: false };
  if (typeof v === "string") return clipText(ctx, v, limit);
  const json = JSON.stringify(v) ?? "";
  if (Buffer.byteLength(json) <= limit) return { value: v, truncated: false };
  const blob = await ctx.blob(json);
  const shrunk = typeof v === "object" && v !== null ? shrinkStrings(v, limit) : undefined;
  return { value: shrunk ?? `${cutUtf8(json, limit)}…`, blob, truncated: true };
}

const MIN_STRING = 32;

/**
 * A copy of `v` whose JSON fits `limit` bytes, made by cutting its longest
 * strings and then, if still too big, dropping the tail of its longest arrays
 * (a "…N more" marker stays); undefined if that is not enough.
 */
function shrinkStrings(v: object, limit: number): unknown {
  const copy = structuredClone(v) as Record<string, unknown> | unknown[];
  const leaves: { holder: Record<string | number, unknown>; key: string | number; bytes: number }[] = [];
  const arrays: unknown[][] = [];
  const walk = (o: unknown, depth: number) => {
    if (depth > 32 || typeof o !== "object" || o === null) return;
    if (Array.isArray(o)) arrays.push(o);
    for (const [k, x] of Object.entries(o)) {
      const key = Array.isArray(o) ? Number(k) : k;
      if (typeof x === "string") leaves.push({ holder: o as Record<string | number, unknown>, key, bytes: Buffer.byteLength(JSON.stringify(x)) });
      else walk(x, depth + 1);
    }
  };
  walk(copy, 0);
  leaves.sort((a, b) => b.bytes - a.bytes);
  let excess = Buffer.byteLength(JSON.stringify(copy)) - limit;
  // Cut the longest strings first, each down to what the remaining excess needs (never below MIN_STRING).
  for (const l of leaves) {
    if (excess <= 0) break;
    if (l.bytes <= MIN_STRING) break;
    const s = l.holder[l.key] as string;
    const keep = Math.max(MIN_STRING, Buffer.byteLength(s) - excess - 8);
    const cut = `${cutUtf8(s, keep)}…`;
    l.holder[l.key] = cut;
    excess -= l.bytes - Buffer.byteLength(JSON.stringify(cut));
  }
  if (excess > 0) {
    const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
    arrays.sort((a, b) => size(b) - size(a));
    for (const a of arrays) {
      let dropped = 0;
      while (a.length > 1 && size(copy) > limit) {
        if (dropped) a.pop(); // the marker
        a.pop();
        dropped++;
        a.push(`…${dropped} more`);
      }
      if (size(copy) <= limit) return copy;
    }
    return undefined;
  }
  return copy;
}

/** Raw source payload as a blob (convention: blobs[0] of the first event of a line). */
export function rawBlob(ctx: NormalizeContext, raw: unknown): Promise<BlobRef> {
  return ctx.blob(typeof raw === "string" ? raw : JSON.stringify(raw) ?? "null");
}

/** Best-effort plain text of tool output shapes (string, {stdout,stderr}, content blocks, …). */
export function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (isObj(x) && typeof x.text === "string" ? x.text : typeof x === "string" ? x : "")).filter(Boolean);
    return parts.length ? parts.join("\n") : JSON.stringify(v);
  }
  if (isObj(v)) {
    const out = [v.stdout, v.stderr].filter((x): x is string => typeof x === "string" && x !== "");
    if (out.length) return out.join("\n");
    for (const k of ["output", "aggregated_output", "result", "content", "text"]) {
      const t = outputText(v[k]);
      if (t) return t;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

// ---------------------------------------------------------------- usage

/** Anthropic-style usage (input_tokens excludes cache reads/writes). */
export function anthropicUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const out: Usage = {};
  if (num(u.input_tokens) !== undefined) out.inputTokens = u.input_tokens as number;
  if (num(u.output_tokens) !== undefined) out.outputTokens = u.output_tokens as number;
  if (num(u.cache_read_input_tokens) !== undefined) out.cacheReadTokens = u.cache_read_input_tokens as number;
  if (num(u.cache_creation_input_tokens) !== undefined) out.cacheWriteTokens = u.cache_creation_input_tokens as number;
  const cost = num(u.total_cost_usd) ?? num(u.cost_usd) ?? num(u.costUsd);
  if (cost !== undefined) out.costUsd = cost;
  return Object.keys(out).length ? out : undefined;
}

/**
 * OpenAI-style usage (input_tokens INCLUDES cached tokens). Normalized so that
 * inputTokens is the uncached part, matching the Anthropic convention:
 * total input = inputTokens + cacheReadTokens (+ cacheWriteTokens).
 */
export function openaiUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const input = num(u.input_tokens) ?? num(u.prompt_tokens);
  const cached = num(u.cached_input_tokens) ?? num(obj(u.input_tokens_details).cached_tokens) ?? num(obj(u.prompt_tokens_details).cached_tokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  const out: Usage = {};
  if (input !== undefined) out.inputTokens = Math.max(0, input - (cached ?? 0));
  if (cached !== undefined) out.cacheReadTokens = cached;
  if (output !== undefined) out.outputTokens = output;
  return Object.keys(out).length ? out : undefined;
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const out: Usage = {};
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const s = (a[k] ?? 0) + (b[k] ?? 0);
    if (a[k] !== undefined || b[k] !== undefined) out[k] = k === "costUsd" ? Math.round(s * 1e6) / 1e6 : s;
  }
  return out;
}

// ---------------------------------------------------------------- emitter

export interface EmitBase {
  agent: AgentId;
  sessionId: string;
  ts: number;
  cwd?: string;
  model?: string;
  agentVersion?: string;
  runId?: string;
  turnId?: string;
  subagentId?: string;
}

export type EmitExtra = Partial<Omit<AgentEvent, "id" | "v" | "kind" | "payload" | "agent">> & {
  /**
   * Natural key (e.g. a tool_use_id) — id becomes sha(agent, session, kind, …key),
   * so the same tool call seen live and in a backfilled transcript dedupes.
   */
  key?: (string | number)[];
};

/**
 * Collects events for one source record. Ids are deterministic:
 * ctx.id(agent, sessionId, …source, index) unless a natural `key` is given.
 * Undefined fields are omitted so golden fixtures stay stable.
 */
/**
 * Id parts that identify one spool line: its spool position (file + byte
 * offset, set by ingest) when known, else ts + pid. The position is unique
 * per line even when one process writes two lines in the same millisecond,
 * and stays the same when the line is re-read, so ids remain deterministic.
 */
export function lineKey(line: Pick<SpoolLine, "ts" | "pid">, ctx: Pick<NormalizeContext, "source">): (string | number)[] {
  return ctx.source ? ["at", ctx.source.file, ctx.source.offset] : [line.ts, line.pid];
}

export class Emitter {
  readonly events: AgentEvent[] = [];
  readonly ctx: NormalizeContext;
  base: EmitBase;
  readonly source: (string | number)[];

  constructor(ctx: NormalizeContext, base: EmitBase, source: (string | number)[]) {
    this.ctx = ctx;
    this.base = base;
    this.source = source;
  }

  emit(kind: EventKind, payload: Record<string, unknown>, extra: EmitExtra = {}): AgentEvent {
    const { key, ...rest } = extra;
    const sessionId = rest.sessionId ?? this.base.sessionId;
    const id = key ? this.ctx.id(this.base.agent, sessionId, kind, ...key) : this.ctx.id(this.base.agent, sessionId, ...this.source, this.events.length);
    const e: AgentEvent = {
      id,
      v: SCHEMA_VERSION,
      sessionId,
      ts: this.base.ts,
      agent: this.base.agent,
      kind,
      payload: compact(payload),
    };
    for (const k of ["cwd", "model", "agentVersion", "runId", "turnId", "subagentId"] as const) {
      const v = this.base[k];
      if (v !== undefined) (e as unknown as Record<string, unknown>)[k] = v;
    }
    // Explicit extras override the base; an explicit undefined clears a base field
    // (e.g. subagentId when a child-session line emits into the parent session).
    for (const [k, v] of Object.entries(rest)) {
      if (k === "sessionId") continue;
      if (v === undefined) delete (e as unknown as Record<string, unknown>)[k];
      else (e as unknown as Record<string, unknown>)[k] = v;
    }
    if (e.blobs && e.blobs.length === 0) delete e.blobs;
    this.events.push(e);
    return e;
  }

  /** Prepend the raw-payload blob to the first emitted event (convention: blobs[0]). */
  async attachRaw(raw: unknown): Promise<void> {
    const first = this.events[0];
    if (!first || raw === undefined) return;
    const ref = await rawBlob(this.ctx, raw);
    first.blobs = [ref, ...(first.blobs ?? []).filter((b) => b !== ref)];
  }
}

/**
 * Key for a usage-summary notification (running session totals). Snapshots are
 * keyed by their totals, so a larger snapshot is a new event instead of a
 * duplicate of the first; buildSession counts only the latest one.
 */
export function usageSnapshotKey(u: Usage): (string | number)[] {
  return ["usage-summary", u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0, u.costUsd ?? 0];
}

/** Drop undefined values (shallow) so payloads serialize identically. */
export function compact(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return out;
}

/** Collects distinct blob refs, skipping undefined. */
export function blobList(...refs: (BlobRef | undefined)[]): BlobRef[] | undefined {
  const out = [...new Set(refs.filter((r): r is BlobRef => !!r))];
  return out.length ? out : undefined;
}

/**
 * session.start payload fields that link a child (subagent) session to its parent
 * (schema: { parentSessionId, parentEventId?, subagentId?, subagentType? }).
 * parentEventId is the parent's subagent.start event, whose id every adapter
 * derives from the natural key [subagentId] — so it is computable from either side.
 */
export function parentLink(ctx: NormalizeContext, agent: AgentId, parentSessionId: string, subagentId: string, subagentType?: string): Record<string, unknown> {
  return compact({ parentSessionId, parentEventId: ctx.id(agent, parentSessionId, "subagent.start", subagentId), subagentId, subagentType });
}

/** Deterministic child-session id for a subagent run inside `parentSessionId`. */
export function childSessionId(parentSessionId: string, subagentId: string): string {
  return `${parentSessionId}:sub:${subagentId}`;
}

/**
 * The file as the backfill cursor should see it. A transcript gone quiet reads
 * differently from the same bytes still being written: once idle, a backfill
 * closes its open turn and ends the session or subagent. An idle file reports
 * its mtime 1 ms later, so the cursor takes the idle transition for a change and
 * the file is read once more, even though it never changes again (no extra reads otherwise).
 */
export function cursorView<F extends BackfillFile>(f: F, idleMs: number, now = Date.now()): F {
  return now - f.mtimeMs > idleMs ? { ...f, mtimeMs: f.mtimeMs + 1 } : f;
}
