// A proxied call's conversation stored as content-addressed blocks, so a long
// session costs about its own size in blobs instead of growing with the square
// of its length (each call re-sends every earlier message).
//
// The request document (format 2) keeps the messages field (`messages`, or a
// Responses `input` array) as `{ "$blocks": [ref…], "$tail": [entry…] }`.
// - An entry is one message: the message itself, or, when its JSON is over
//   BIG_BYTES or it is a bare string, the ref of a blob holding its JSON.
// - A block is a blob `{"l": level, "e": [...]}`. A level 0 block holds FANOUT
//   entries; a level k block holds the refs of FANOUT level k-1 blocks. Block
//   boundaries sit at fixed message positions (multiples of FANOUT^(k+1)), so
//   two calls that start with the same messages share the blocks covering them.
// - `$blocks` lists the fewest blocks, highest level first, that cover the
//   messages before the tail; the tail is the rest. The last HOLD_BACK messages
//   always stay in the tail: Claude Code moves its cache_control markers along
//   them every turn, and a block sealed with a marker in it would be stored
//   again without it on the next call.
// Reading puts the array back exactly as it was stored (redacted), key order
// and all. Format 1 documents (the whole body in one blob) still read as before.
//
// gc keeps the blocks and message blobs of every stored request (core/gc.ts,
// via requestBlobRefs); purge rewrites the blocks and documents that point at a
// message blob it rewrote (store/purge.ts).
import { sha256Hex } from "../core/ids.ts";
import type { BlobStore } from "../core/types.ts";

/** Entries (or child blocks) per block. */
export const FANOUT = 16;
/** Messages that always stay in the tail. */
export const HOLD_BACK = 4;
/** A message whose JSON is over this many bytes goes to a blob of its own. */
export const BIG_BYTES = 2048;
/** Blob reads or writes in flight per call. */
const PARALLEL = 16;

export interface StoredMessages {
  $blocks: string[];
  $tail: unknown[];
}

interface Block {
  l: number;
  e: unknown[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isStoredMessages(v: unknown): v is StoredMessages {
  return isObj(v) && Array.isArray(v.$blocks) && Array.isArray(v.$tail) && Object.keys(v).length === 2 && v.$blocks.every((p) => typeof p === "string");
}

const isBlock = (v: unknown): v is Block => isObj(v) && typeof v.l === "number" && Number.isInteger(v.l) && v.l >= 0 && Array.isArray(v.e);

/** The body field holding the conversation, when it is an array: `messages`, or a Responses `input`. */
export function messagesKey(api: string, body: Record<string, unknown>): "messages" | "input" | undefined {
  if ((api === "messages" || api === "count_tokens" || api === "chat") && Array.isArray(body.messages)) return "messages";
  if (api === "responses" && Array.isArray(body.input)) return "input";
  return undefined;
}

/**
 * Refs this process put recently, so a call does not re-put (and re-read, to
 * verify) the blocks it shares with the call before it. An entry lasts `ttlMs`,
 * well under gc's minimum blob age, so a blob gc could have swept since is put again.
 */
export class RecentBlobs {
  private readonly at = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  constructor(ttlMs = 10 * 60_000, max = 100_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }
  has(ref: string, now = Date.now()): boolean {
    const t = this.at.get(ref);
    return t !== undefined && now - t < this.ttlMs;
  }
  add(ref: string, now = Date.now()): void {
    this.at.delete(ref);
    this.at.set(ref, now);
    if (this.at.size > this.max) this.at.delete(this.at.keys().next().value!);
  }
}

/** What putMessages asks of RecentBlobs: whether a ref is known stored, and that one now is. */
export type Seen = Pick<RecentBlobs, "has" | "add">;

/** Runs `fn` over `xs` with at most PARALLEL in flight, results in order. */
async function pool<T, R>(xs: readonly T[], fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, xs.length) }, worker));
  return out;
}

async function putText(blobs: BlobStore, text: string, recent: Seen | undefined): Promise<string> {
  if (recent) {
    const ref = sha256Hex(text);
    if (recent.has(ref)) return ref;
  }
  const ref = await blobs.put(text);
  recent?.add(ref);
  return ref;
}

/** Stores a conversation (already redacted) as blocks and a tail. */
export async function putMessages(blobs: BlobStore, items: readonly unknown[], recent?: Seen): Promise<StoredMessages> {
  const sealed = Math.max(0, items.length - HOLD_BACK);
  const full = sealed - (sealed % FANOUT);
  const entry = async (m: unknown): Promise<unknown> => {
    const text = JSON.stringify(m) ?? "null";
    return typeof m === "string" || Buffer.byteLength(text) > BIG_BYTES ? putText(blobs, text, recent) : m;
  };
  // Level 0 blocks over [0, full), then each level over the one below, while it fills a block.
  let level: string[] = await pool(Array.from({ length: full / FANOUT }, (_, k) => k), async (k) => {
    const e = await Promise.all(items.slice(k * FANOUT, (k + 1) * FANOUT).map(entry));
    return putText(blobs, JSON.stringify({ l: 0, e }), recent);
  });
  // levels[k]: the level k blocks not covered by a level k+1 block.
  const loose: string[][] = [];
  for (let l = 1; level.length; l++) {
    const whole = level.length - (level.length % FANOUT);
    loose.push(level.slice(whole));
    const kids = level;
    level = await pool(Array.from({ length: whole / FANOUT }, (_, k) => k), (k) => putText(blobs, JSON.stringify({ l, e: kids.slice(k * FANOUT, (k + 1) * FANOUT) }), recent));
  }
  const tail = await pool(items.slice(full), entry);
  return { $blocks: loose.reverse().flat(), $tail: tail };
}

async function json(blobs: BlobStore, ref: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await blobs.getText(ref).catch(() => undefined);
  if (text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The entries under some blocks, in order; undefined when one is gone. */
async function entriesOf(blobs: BlobStore, refs: readonly string[]): Promise<unknown[] | undefined> {
  const blocks = await pool(refs, (r) => json(blobs, r));
  const out: unknown[] = [];
  for (const b of blocks) {
    if (!b.ok || !isBlock(b.value)) return undefined;
    if (b.value.l === 0) out.push(...b.value.e);
    else {
      const kids = b.value.e.filter((x): x is string => typeof x === "string");
      const sub = kids.length === b.value.e.length ? await entriesOf(blobs, kids) : undefined;
      if (!sub) return undefined;
      out.push(...sub);
    }
  }
  return out;
}

/** The conversation back, exactly as stored; undefined when a block or message blob is gone. */
export async function getMessages(blobs: BlobStore, stored: StoredMessages): Promise<unknown[] | undefined> {
  const head = await entriesOf(blobs, stored.$blocks);
  if (!head) return undefined;
  let missing = false;
  const out = await pool([...head, ...stored.$tail], async (e) => {
    if (typeof e !== "string") return e;
    const m = await json(blobs, e);
    if (!m.ok) missing = true;
    return m.ok ? m.value : undefined;
  });
  return missing ? undefined : out;
}

/**
 * Every blob a stored request document points at through its messages (blocks
 * and message blobs), for gc. `seen` is shared across documents: a block read
 * once is not read again (its refs were collected then). A missing document or
 * block adds nothing below it.
 */
export async function requestBlobRefs(blobs: BlobStore, docRef: string, seen: Set<string>): Promise<string[]> {
  const doc = await json(blobs, docRef);
  if (!doc.ok || !isObj(doc.value) || doc.value.v !== 2 || !isObj(doc.value.body)) return [];
  const out: string[] = [];
  const walk = async (refs: readonly string[]): Promise<void> => {
    const fresh = refs.filter((r) => !seen.has(r));
    for (const r of fresh) seen.add(r);
    const blocks = await pool(fresh, (r) => json(blobs, r));
    for (const b of blocks) {
      if (!b.ok || !isBlock(b.value)) continue;
      const strings = b.value.e.filter((x): x is string => typeof x === "string");
      if (b.value.l === 0) out.push(...strings);
      else {
        out.push(...strings);
        await walk(strings);
      }
    }
  };
  for (const v of Object.values(doc.value.body)) {
    if (!isStoredMessages(v)) continue;
    out.push(...v.$blocks);
    for (const e of v.$tail) if (typeof e === "string") out.push(e);
    await walk(v.$blocks);
  }
  return out;
}
