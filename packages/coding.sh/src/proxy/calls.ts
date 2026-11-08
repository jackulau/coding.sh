// One logged model call, read back: the event, the request as the client sent
// it (system prompt and tools re-inlined from their blobs), and the response.
// And what changed between two calls, in the order the provider's prompt cache
// reads a request (tools, then system, then messages), so a cache miss comes
// with its cause.
import type { BlobStore, IndexStore } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import { type Api, parseRequest, type RequestInfo } from "./wire.ts";

/** The request document stored in the requestRef blob. */
export interface StoredRequest {
  provider: string;
  api: Api;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface StoredResponse {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface LoadedCall {
  event: AgentEvent;
  /** Absent in metadata mode, or when the blob is gone. */
  request?: StoredRequest;
  response?: StoredResponse;
  info?: RequestInfo;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Minimum length of an event id prefix. */
export const MIN_CALL_PREFIX = 6;

export class CallRefError extends Error {
  readonly reason: "not_found" | "ambiguous";
  readonly candidates: string[];
  constructor(message: string, reason: "not_found" | "ambiguous", candidates: string[] = []) {
    super(message);
    this.name = "CallRefError";
    this.reason = reason;
    this.candidates = candidates;
  }
}

const isCall = (e: AgentEvent) => e.kind === "llm.call";

/**
 * A session's model calls in order: the ones coding.sh proxy logged when there
 * are any (their requests are stored), else every llm.call (transcript, OTel).
 */
export async function sessionCalls(index: IndexStore, sessionId: string): Promise<AgentEvent[]> {
  const all = await index.listEvents(sessionId, { kinds: ["llm.call"] });
  const proxied = all.filter((e) => e.source === "proxy");
  return proxied.length ? proxied : all;
}

/** The model call before `e` in its session (proxy calls before a proxy call), if any. */
export async function previousCall(index: IndexStore, e: AgentEvent): Promise<AgentEvent | undefined> {
  const calls = (await index.listEvents(e.sessionId, { kinds: ["llm.call"] })).filter((x) => (x.source === "proxy") === (e.source === "proxy"));
  const i = calls.findIndex((x) => x.id === e.id);
  return i > 0 ? calls[i - 1] : undefined;
}

/**
 * The llm.call a reference names: an event id, a unique id prefix (6+
 * characters), or `<session>#<n>`: the n-th model call of a session (1-based;
 * `#-1` is the last; counting proxy-logged calls only when the session has
 * any). The session part may be an id prefix, or `latest`.
 */
export async function resolveCall(index: IndexStore, ref: string): Promise<AgentEvent> {
  const hash = ref.lastIndexOf("#");
  if (hash > 0) {
    const sref = ref.slice(0, hash);
    const n = Number(ref.slice(hash + 1));
    if (!Number.isInteger(n) || n === 0) throw new CallRefError(`${JSON.stringify(ref)}: after # comes a call number, 1 for the first, -1 for the last`, "not_found");
    let sid = sref === "latest" || sref === "last" ? (await index.listSessions({ limit: 1, parentSessionId: null }))[0]?.id : (await index.getSession(sref))?.id;
    if (!sid && sref.length >= 4) {
      const ids = index.sessionIdsByPrefix ? await index.sessionIdsByPrefix(sref, 2) : (await index.listSessions()).map((s) => s.id).filter((x) => x.startsWith(sref)).slice(0, 2);
      if (ids.length > 1) throw new CallRefError(`Session id prefix ${JSON.stringify(sref)} is ambiguous`, "ambiguous", ids);
      sid = ids[0];
    }
    if (!sid) throw new CallRefError(`Can't find session ${JSON.stringify(sref)}`, "not_found");
    const calls = await sessionCalls(index, sid);
    const e = n > 0 ? calls[n - 1] : calls[calls.length + n];
    if (!e) throw new CallRefError(`Session ${sid} has ${calls.length} model call${calls.length === 1 ? "" : "s"}; no #${n}`, "not_found");
    return e;
  }
  if (ref.length < MIN_CALL_PREFIX) throw new CallRefError(`Can't find call ${JSON.stringify(ref)} (an id prefix needs at least ${MIN_CALL_PREFIX} characters)`, "not_found");
  let found: AgentEvent[];
  if (index.eventsByIdPrefix) found = (await index.eventsByIdPrefix(ref, 11)).filter(isCall);
  else {
    // Stores without the lookup: scan recent sessions.
    found = [];
    for (const s of await index.listSessions({ limit: 500 })) {
      for (const e of await index.listEvents(s.id, { kinds: ["llm.call"] })) if (e.id.startsWith(ref)) found.push(e);
      if (found.length > 10) break;
    }
  }
  const exact = found.find((e) => e.id === ref);
  if (exact) return exact;
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new CallRefError(`Can't find call ${JSON.stringify(ref)}`, "not_found");
  throw new CallRefError(`Call id prefix ${JSON.stringify(ref)} is ambiguous`, "ambiguous", found.map((e) => e.id));
}

async function blobJson(blobs: BlobStore, ref: unknown): Promise<unknown> {
  if (typeof ref !== "string") return undefined;
  const text = await blobs.getText(ref);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Replaces `{ "$blob": sha }` fields of the stored body with the blob's JSON. */
async function inline(blobs: BlobStore, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = { ...body };
  for (const [k, v] of Object.entries(out)) {
    if (isObj(v) && typeof v.$blob === "string" && Object.keys(v).length === 1) {
      const val = await blobJson(blobs, v.$blob);
      if (val !== undefined) out[k] = val;
    }
  }
  return out;
}

/** The call with its stored request (re-inlined) and response, where full capture kept them. */
export async function loadCall(blobs: BlobStore, event: AgentEvent): Promise<LoadedCall> {
  const out: LoadedCall = { event };
  const req = await blobJson(blobs, event.payload.requestRef);
  if (isObj(req) && isObj(req.body)) {
    const body = await inline(blobs, req.body);
    out.request = {
      provider: String(req.provider ?? event.payload.provider ?? ""),
      api: String(req.api ?? event.payload.api ?? "other") as Api,
      method: String(req.method ?? "POST"),
      path: String(req.path ?? ""),
      headers: isObj(req.headers) ? (req.headers as Record<string, string>) : {},
      body,
    };
    out.info = parseRequest(out.request.api, body);
  }
  const res = await blobJson(blobs, event.payload.responseRef);
  if (isObj(res)) out.response = { ...(typeof res.status === "number" ? { status: res.status } : {}), headers: isObj(res.headers) ? (res.headers as Record<string, string>) : {}, body: res.body };
  return out;
}

// ---------------------------------------------------------------- diff

export interface LineOp {
  op: "+" | "-" | " ";
  text: string;
}

/** Line diff (LCS), with `context` unchanged lines around each change; undefined when too long to diff. */
export function lineDiff(a: string, b: string, context = 2, maxLines = 4000): LineOp[] | undefined {
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim the shared head and tail first: most system prompt edits are small.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  if (xs.length * ys.length > maxLines * maxLines) return undefined;
  const n = xs.length;
  const m = ys.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = xs[i] === ys[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const mid: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) mid.push({ op: " ", text: xs[i++]! }), j++;
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) mid.push({ op: "-", text: xs[i++]! });
    else mid.push({ op: "+", text: ys[j++]! });
  }
  const all: LineOp[] = [...x.slice(0, head).map((text): LineOp => ({ op: " ", text })), ...mid, ...x.slice(x.length - tail).map((text): LineOp => ({ op: " ", text }))];
  // Keep changes and `context` lines around them; "…" marks a gap.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.op === " ") return;
    for (let d = -context; d <= context; d++) if (all[k + d]) keep[k + d] = true;
  });
  const out: LineOp[] = [];
  let gap = false;
  all.forEach((l, k) => {
    if (keep[k]) {
      if (gap && out.length) out.push({ op: " ", text: "…" });
      out.push(l);
      gap = false;
    } else gap = true;
  });
  return out;
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
};

const toolName = (t: unknown): string => {
  if (!isObj(t)) return "?";
  if (typeof t.name === "string") return t.name;
  if (isObj(t.function) && typeof t.function.name === "string") return t.function.name;
  return typeof t.type === "string" ? t.type : "?";
};

/** The value without cache_control markers: they mark cache breakpoints (Claude Code moves them every turn), not content. */
const noMarkers = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(noMarkers);
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== "cache_control") out[k] = noMarkers(x);
  return out;
};
const contentKey = (v: unknown): string => stable(noMarkers(v));

export interface CallSide {
  id: string;
  sessionId: string;
  ts: number;
  model?: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
}

export interface CallDiff {
  a: CallSide;
  b: CallSide;
  /** "full" when both requests were stored; "metadata" compares hashes and counts only. */
  content: "full" | "metadata";
  model?: { a?: string; b?: string };
  params: { key: string; a?: unknown; b?: unknown }[];
  tools: { same: boolean; added: string[]; removed: string[]; changed: string[]; reordered: boolean };
  system: { same: boolean; a?: string; b?: string; lines?: LineOp[] };
  messages: { a: number; b: number; shared: number; rewritten: boolean };
  cache: { reused: boolean; expected: number; read: number; write: number; gapMs: number; cause?: string };
}

const side = (e: AgentEvent): CallSide => ({
  id: e.id,
  sessionId: e.sessionId,
  ts: e.ts,
  ...(e.model ? { model: e.model } : {}),
  usage: { ...(e.usage ?? {}) },
});

/** Anthropic's default prompt cache lifetime. */
export const CACHE_TTL_MS = 5 * 60_000;

/** What changed from call `a` to call `b`, and why `b` missed the prompt cache if it did. */
export function diffCalls(a: LoadedCall, b: LoadedCall): CallDiff {
  const pa = a.event.payload;
  const pb = b.event.payload;
  const full = !!a.info && !!b.info;
  const ma = a.event.model ?? (pa.requestModel as string | undefined);
  const mb = b.event.model ?? (pb.requestModel as string | undefined);
  const d: CallDiff = {
    a: side(a.event),
    b: side(b.event),
    content: full ? "full" : "metadata",
    params: [],
    tools: { same: true, added: [], removed: [], changed: [], reordered: false },
    system: { same: true },
    messages: { a: Number(pa.messageCount ?? a.info?.messages.length ?? 0), b: Number(pb.messageCount ?? b.info?.messages.length ?? 0), shared: 0, rewritten: false },
    cache: { reused: false, expected: 0, read: b.event.usage?.cacheReadTokens ?? 0, write: b.event.usage?.cacheWriteTokens ?? 0, gapMs: b.event.ts - (a.event.ts + (a.event.durationMs ?? 0)) },
  };
  if (ma !== mb) d.model = { ...(ma ? { a: ma } : {}), ...(mb ? { b: mb } : {}) };

  if (full) {
    const ia = a.info!;
    const ib = b.info!;
    for (const k of [...new Set([...Object.keys(ia.params), ...Object.keys(ib.params)])].sort()) {
      if (stable(ia.params[k]) !== stable(ib.params[k])) d.params.push({ key: k, ...(ia.params[k] !== undefined ? { a: ia.params[k] } : {}), ...(ib.params[k] !== undefined ? { b: ib.params[k] } : {}) });
    }
    const ta = new Map(ia.tools.map((t) => [toolName(t), contentKey(t)]));
    const tb = new Map(ib.tools.map((t) => [toolName(t), contentKey(t)]));
    d.tools.added = [...tb.keys()].filter((n) => !ta.has(n));
    d.tools.removed = [...ta.keys()].filter((n) => !tb.has(n));
    d.tools.changed = [...ta.keys()].filter((n) => tb.has(n) && ta.get(n) !== tb.get(n));
    const order = (m: Map<string, string>, other: Map<string, string>) => [...m.keys()].filter((n) => other.has(n));
    d.tools.reordered = !d.tools.added.length && !d.tools.removed.length && order(ta, tb).join("\n") !== order(tb, ta).join("\n");
    d.tools.same = !d.tools.added.length && !d.tools.removed.length && !d.tools.changed.length && !d.tools.reordered;
    const sa = ia.system ?? "";
    const sb = ib.system ?? "";
    d.system.same = sa === sb;
    if (!d.system.same) {
      const lines = lineDiff(sa, sb);
      if (lines) d.system.lines = lines;
    }
    const ka = ia.messages.map(contentKey);
    const kb = ib.messages.map(contentKey);
    let shared = 0;
    while (shared < ka.length && shared < kb.length && ka[shared] === kb[shared]) shared++;
    d.messages = { a: ka.length, b: kb.length, shared, rewritten: shared < ka.length };
  } else {
    // Metadata mode: the short hashes and counts the event keeps.
    d.tools.same = pa.toolsHash === pb.toolsHash;
    if (!d.tools.same) {
      const na = new Set((pa.toolNames as string[] | undefined) ?? []);
      const nb = new Set((pb.toolNames as string[] | undefined) ?? []);
      d.tools.added = [...nb].filter((n) => !na.has(n));
      d.tools.removed = [...na].filter((n) => !nb.has(n));
    }
    d.system.same = pa.systemHash === pb.systemHash;
    if (typeof pa.systemHash === "string") d.system.a = pa.systemHash;
    if (typeof pb.systemHash === "string") d.system.b = pb.systemHash;
    d.messages.shared = Math.min(d.messages.a, d.messages.b);
  }

  // The cache: b should have read what a read or wrote, when it extends a's prompt.
  const aCached = (a.event.usage?.cacheReadTokens ?? 0) + (a.event.usage?.cacheWriteTokens ?? 0);
  d.cache.expected = aCached;
  d.cache.reused = d.cache.read > 0 && d.cache.read >= aCached * 0.9;
  if (aCached > 0 && !d.cache.reused) d.cache.cause = cacheCause(d);
  return d;
}

/** The first change in cache order (tools, system, messages), or the lifetime. */
function cacheCause(d: CallDiff): string {
  if (d.model) return `the model changed (${d.model.a ?? "?"} → ${d.model.b ?? "?"}); each model has its own cache`;
  const t = d.tools;
  if (!t.same) {
    const parts = [t.added.length ? `added ${t.added.join(", ")}` : "", t.removed.length ? `removed ${t.removed.join(", ")}` : "", t.changed.length ? `changed ${t.changed.join(", ")}` : "", t.reordered ? "reordered" : ""].filter(Boolean);
    return `the tool definitions changed${parts.length ? ` (${parts.join("; ")})` : ""}; tools come first in the cached prefix`;
  }
  if (!d.system.same) {
    const first = d.system.lines?.find((l) => l.op !== " ");
    return `the system prompt changed${first ? ` (first change: ${first.op} ${first.text.trim().slice(0, 80)})` : ""}`;
  }
  if (d.messages.rewritten) return `the history was rewritten from message ${d.messages.shared + 1} (compaction or an edit)`;
  if (d.cache.gapMs > CACHE_TTL_MS) return `${Math.round(d.cache.gapMs / 60_000)} min passed between the calls; the default cache lasts 5 min`;
  if (d.content === "metadata") return "the prefix looks the same by hash; the stored content would say more (capture mode full)";
  return "same prefix and within 5 min: the cache entry may have been evicted, or the cache breakpoints moved";
}
