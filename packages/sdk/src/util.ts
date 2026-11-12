// Small runtime helpers with no Node-only imports, so the SDK can load on
// edge runtimes too (best effort). There is no top-level await: require() of
// the package works on Node 22+. Ids come from the global WebCrypto; where a
// runtime has none (Node 18) from node:crypto, taken from
// process.getBuiltinModule when it exists, else imported in the background.

type Rand = { randomUUID(): string; fill(buf: Uint8Array): void };

const web = (globalThis as { crypto?: Crypto }).crypto;
let rand: Rand | undefined =
  web && typeof web.randomUUID === "function" ? { randomUUID: () => web.randomUUID(), fill: (b) => void web.getRandomValues(b) } : undefined;

type NodeCrypto = { randomUUID(): string; randomFillSync(buf: Uint8Array): unknown };
const fromNode = (c: NodeCrypto): Rand => ({ randomUUID: () => c.randomUUID(), fill: (b) => void c.randomFillSync(b) });

if (!rand) {
  const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  const c = typeof builtin === "function" ? (builtin("node:crypto") as NodeCrypto | undefined) : undefined;
  if (c) rand = fromNode(c);
  else void import("node:crypto").then((m) => (rand = fromNode(m as NodeCrypto)), () => {});
}

// Only before that import has finished (the first ticks of a Node 18 process): ids that are unique, not secret.
const fallback: Rand = {
  randomUUID: () => `${hexOf(4)}-${hexOf(2)}-4${hexOf(2).slice(1)}-a${hexOf(2).slice(1)}-${hexOf(6)}`,
  fill: (b) => {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  },
};
function hexOf(bytes: number): string {
  const b = new Uint8Array(bytes);
  fallback.fill(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Client event id: fixed when the event is created, reused on every retry. */
export const uuid = (): string => (rand ?? fallback).randomUUID();

function hex(bytes: number): string {
  const b = new Uint8Array(bytes);
  (rand ?? fallback).fill(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return /^0+$/.test(s) ? hex(bytes) : s;
}

/** 16-byte OTel trace id, lowercase hex. */
export const newTraceId = (): string => hex(16);
/** 8-byte OTel span id, lowercase hex. */
export const newSpanId = (): string => hex(8);

const perf = (globalThis as { performance?: { timeOrigin: number; now(): number } }).performance;

const defaultClock = (): number => (perf && perf.timeOrigin ? perf.timeOrigin + perf.now() : Date.now());
let clock = defaultClock;

/** Epoch milliseconds with sub-millisecond precision where the runtime has it. */
export const nowMs = (): number => clock();

/** Test hook: replace the clock (undefined restores the real one). */
export function _setClock(fn: (() => number) | undefined): void {
  clock = fn ?? defaultClock;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Longest text kept in one payload field. The server moves large payloads to blobs; this only bounds batch size. */
export const MAX_TEXT_BYTES = 64 * 1024;

/** Cuts a string to at most maxBytes of UTF-8 (on a code point boundary). */
export function truncate(s: string, maxBytes = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  if (s.length * 3 <= maxBytes) return { text: s, truncated: false };
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** JSON for tool inputs/outputs: strings stay as they are, everything else is serialized (never throws). */
export function safeJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, jsonReplacer()) ?? String(v);
  } catch {
    return String(v);
  }
}

/** A JSON.stringify replacer: a BigInt becomes its digits, a value inside itself becomes "[Circular]" (a repeat that is no cycle stays). */
function jsonReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const parents: unknown[] = [];
  return function (this: unknown, _key, value) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object" || value === null) return value;
    while (parents.length && parents[parents.length - 1] !== this) parents.pop();
    if (parents.includes(value)) return "[Circular]";
    parents.push(value);
    return value;
  };
}

/** Error → short message, never a stack or request details. */
export function errorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.message || err.name;
  else if (isObj(err) && typeof err.message === "string") msg = err.message;
  else msg = String(err);
  return truncate(msg, 1000).text;
}

/**
 * Text of message content in any of the common shapes: a string, or parts
 * such as { type: "text", text }, { type: "input_text", text }, { text }.
 */
export function contentText(c: unknown, depth = 0): string {
  if (depth > 6 || c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => contentText(p, depth + 1))
      .filter(Boolean)
      .join("\n");
  if (isObj(c)) {
    if (typeof c.text === "string") return c.text;
    if (c.content !== undefined) return contentText(c.content, depth + 1);
  }
  return "";
}

/** Text of the last user message in a chat-style messages array (OpenAI, Anthropic, Responses input). */
export function lastUserText(messages: unknown): string | undefined {
  if (typeof messages === "string") return messages || undefined;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isObj(m) && (m.role === "user" || (m.role === undefined && m.type === "message"))) {
      const t = contentText(m.content);
      if (t) return t;
    }
  }
  return undefined;
}

/** Never-throwing wrapper for observation code: the SDK must never break the app. */
export function quiet<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch {
      // observation failed; the app's own result is untouched
    }
  };
}
