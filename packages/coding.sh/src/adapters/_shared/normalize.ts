// Building blocks for normalize()/backfill(): an event emitter with
// deterministic ids, payload clipping (large values → blobs), usage mapping
// and small type guards for untyped agent JSON.
import type { AgentEvent, AgentId, BlobRef, EventKind, Usage } from "../../schema/index.ts";
import { SCHEMA_VERSION } from "../../schema/index.ts";
import { geoValue } from "../../core/pricing.ts";
import type { BackfillFile, NormalizeContext, SpoolLine } from "../../core/types.ts";
import { resolveRaw } from "../../spool/write.ts";
// (tools.ts imports this module too: skillFieldsOf is only called at emit time.)
import { skillFieldsOf } from "./tools.ts";

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
  if (ctx.blobValue) return ctx.blobValue(raw ?? "null");
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
  else {
    // Only the 5-minute / 1-hour split: its sum is the total.
    const { m5, h1 } = cacheSplit(u);
    if (m5 !== undefined || h1 !== undefined) out.cacheWriteTokens = (m5 ?? 0) + (h1 ?? 0);
  }
  const cost = num(u.total_cost_usd) ?? num(u.cost_usd) ?? num(u.costUsd);
  if (cost !== undefined) out.costUsd = cost;
  return Object.keys(out).length ? out : undefined;
}

const cacheSplit = (u: Record<string, unknown>): { m5?: number; h1?: number } => {
  const c = isObj(u.cache_creation) ? u.cache_creation : {};
  return { m5: num(c.ephemeral_5m_input_tokens), h1: num(c.ephemeral_1h_input_tokens) };
};

/**
 * What Anthropic usage says about a call's price beyond token counts, for the
 * llm.call payload (pricing.ts priceEvent): `cacheWrite1hTokens`, the part of the
 * cache writes that went to a 1-hour cache (`cache_creation.ephemeral_1h_input_tokens`;
 * the rest, `ephemeral_5m_input_tokens`, is the 5-minute default), and `inferenceGeo`
 * (`inference_geo` when not global, e.g. "us").
 */
export function anthropicPriceHints(u: unknown): { cacheWrite1hTokens?: number; inferenceGeo?: string } {
  if (!isObj(u)) return {};
  const { h1 } = cacheSplit(u);
  const geo = geoValue(u.inference_geo);
  return { ...(h1 ? { cacheWrite1hTokens: h1 } : {}), ...(geo ? { inferenceGeo: geo } : {}) };
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

/**
 * The spool lines of one hook firing land at most this far apart: the agent
 * starts every command registered for the event when it fires. Real firings
 * with one payload are further apart (a prompt sent again, a second Stop).
 */
export const FIRING_WINDOW_MS = 2_000;

/** Recent firings by payload id: the time of the first line seen and the slot its ids use. Bounded, oldest out first. */
const firings = new Map<string, { ts: number; slot: number }>();
const FIRINGS_KEPT = 4096;

/**
 * Id parts that identify one hook firing, whichever command spooled it. An
 * agent runs every hook command registered for an event, so with coding.sh
 * hooks in two settings files whose commands differ (`/bin/sh hook.sh` in one,
 * `node hook.mjs` in the other) one firing is two spool lines: the same
 * payload, a few ms apart, from two pids at two offsets. The parts are the
 * payload's hash (under `scope`: agent, session, event) and a time slot of
 * FIRING_WINDOW_MS, never the line's position, so both lines give the same
 * event ids and the store keeps one copy. The same payload after the window
 * is another firing.
 *
 * A line within the window of the first line seen for its payload takes that
 * line's slot, so two copies either side of a slot boundary still match. That
 * memory lasts one process: copies read by two ingest passes match only inside
 * one slot. A line with no payload falls back to lineKey.
 */
export function firingKey(line: Pick<SpoolLine, "ts" | "pid">, ctx: Pick<NormalizeContext, "id" | "source">, raw: unknown, ...scope: (string | number)[]): (string | number)[] {
  // Both hooks hand over the agent's bytes, parsed by one reader: equal payloads serialize equally.
  const body = typeof raw === "string" ? raw.trim() : isObj(raw) ? JSON.stringify(raw) : "";
  if (!body || body === "{}") return lineKey(line, ctx);
  const firing = ctx.id("firing", ...scope, body);
  let first = firings.get(firing);
  if (!first || Math.abs(line.ts - first.ts) > FIRING_WINDOW_MS) {
    first = { ts: line.ts, slot: Math.floor(line.ts / FIRING_WINDOW_MS) };
    firings.delete(firing);
    firings.set(firing, first);
    if (firings.size > FIRINGS_KEPT) firings.delete(firings.keys().next().value!);
  }
  return ["firing", firing, first.slot];
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
      // A call that loads a skill says which (payload.skill, payload.skills; _shared/tools.ts skillLoadsOf).
      payload: compact(kind === "tool.start" && payload.skill === undefined ? { ...payload, ...skillFieldsOf(payload.tool, payload.input) } : payload),
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

/** Coarse error class of a failed model call, for filters and charts (the proxy and the adapters). */
export function errorClass(status: number | undefined, type: string | undefined, network?: string): string | undefined {
  if (network) return /timed? ?out|ETIMEDOUT/i.test(network) ? "timeout" : "network";
  if (status === undefined || status < 400) return type ? "api" : undefined;
  if (status === 429) return "rate_limit";
  if (status === 529 || type === "overloaded_error") return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status === 413) return "too_large";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "invalid_request";
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
