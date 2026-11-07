// Small runtime helpers with no Node-only imports, so the SDK can load on
// edge runtimes too (best effort). Node 18 has no global WebCrypto without a
// flag, so ids fall back to node:crypto there.

type Rand = { randomUUID(): string; fill(buf: Uint8Array): void };

const web = (globalThis as { crypto?: Crypto }).crypto;
const rand: Rand =
  web && typeof web.randomUUID === "function"
    ? { randomUUID: () => web.randomUUID(), fill: (b) => void web.getRandomValues(b) }
    : await (async () => {
        const c = await import("node:crypto");
        return { randomUUID: () => c.randomUUID(), fill: (b: Uint8Array) => void c.randomFillSync(b) };
      })();

/** Client event id: fixed when the event is created, reused on every retry. */
export const uuid = (): string => rand.randomUUID();

function hex(bytes: number): string {
  const b = new Uint8Array(bytes);
  rand.fill(b);
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
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
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
