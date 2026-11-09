// Tool-output cap for the model driver (Y-15). A prefix byte slice of a JSON
// result is broken JSON and silently drops every top-level key that comes
// after the cut; `structure` shrinks JSON while keeping it valid and every
// top-level key present, and cuts other text on whole lines (head and tail).
// `prefix` reproduces the old byte slice for A/B runs; `none` turns the cap off.
// Output under the cap is returned unchanged in every mode. Pure: no I/O.

export type CapMode = "structure" | "prefix" | "none";
export const CAP_MODES: readonly CapMode[] = ["structure", "prefix", "none"];
export const DEFAULT_CAP_BYTES = 16 * 1024;

export interface OutputCapConfig {
  mode?: CapMode;
  maxBytes?: number;
}

export interface OutputCut {
  mode: CapMode;
  originalBytes: number;
  deliveredBytes: number;
  /** The original output was JSON. */
  json: boolean;
  /** What the model received parses as JSON. */
  jsonValid: boolean;
  /** Top-level keys of the original JSON object. */
  topKeys?: string[];
  /** Top-level keys whose whole value reached the model. */
  topKeysKept?: string[];
  /** Non-JSON structure cut: lines left out between head and tail. */
  omittedLines?: number;
  totalLines?: number;
}

export interface CapResult {
  text: string;
  cut?: OutputCut;
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a character. */
export function prefixBytes(s: string, max: number): string {
  if (max <= 0) return "";
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  let end = max;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}

/** The longest suffix of `s` that fits in `max` UTF-8 bytes. */
function suffixBytes(s: string, max: number): string {
  if (max <= 0) return "";
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  let start = b.length - max;
  while (start < b.length && (b[start]! & 0xc0) === 0x80) start++;
  return b.subarray(start).toString("utf8");
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

const parses = (text: string): boolean => tryJson(text).ok;

/**
 * Byte offset where each top-level key's value ends in a JSON object text.
 * A small scanner (strings and nesting only): the text is known to be valid.
 */
function topValueEnds(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let depth = 0;
  let i = 0;
  let key: string | undefined;
  let expectKey = false;
  let byte = 0;
  const n = text.length;
  const adv = (ch: string) => {
    const c = ch.charCodeAt(0);
    byte += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3;
  };
  for (; i < n; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      adv(ch);
      i++;
      for (; i < n; i++) {
        const c = text[i]!;
        adv(c);
        if (c === "\\") {
          i++;
          adv(text[i]!);
        } else if (c === '"') break;
      }
      if (depth === 1 && expectKey) {
        key = JSON.parse(text.slice(start, i + 1)) as string;
        expectKey = false;
      }
      continue;
    }
    adv(ch);
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth === 1 && ch === "{") expectKey = true;
    } else if (ch === "}" || ch === "]") {
      if (depth === 1 && key !== undefined) {
        out.set(key, byte - 1);
        key = undefined;
      }
      depth--;
    } else if (ch === "," && depth === 1) {
      if (key !== undefined) out.set(key, byte - 1);
      key = undefined;
      expectKey = true;
    }
  }
  return out;
}

// ------------------------------------------------------------ JSON shrink

const MIN_T = 24;

/**
 * Serializes `v` with every node larger than `t` bytes cut down to about `t`:
 * a string to a prefix plus `…[N chars]`, an array to its leading items plus a
 * `…N more items` marker. Objects keep every key (their values shrink).
 */
function render(v: unknown, t: number): string {
  if (typeof v === "string") {
    const full = JSON.stringify(v);
    if (bytes(full) <= t) return full;
    const keep = prefixBytes(v, Math.max(0, t - 24));
    const chars = [...keep].length;
    const omitted = [...v].length - chars;
    const cut = JSON.stringify(`${keep}…[${omitted} chars]`);
    return bytes(cut) < bytes(full) ? cut : full;
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => render(x, t));
    const full = `[${items.join(",")}]`;
    if (bytes(full) <= t) return full;
    const kept: string[] = [];
    let size = 2;
    for (const it of items) {
      const b = bytes(it) + (kept.length ? 1 : 0);
      if (size + b > t) break;
      kept.push(it);
      size += b;
    }
    const more = v.length - kept.length;
    kept.push(JSON.stringify(`…${more} more items`));
    return `[${kept.join(",")}]`;
  }
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${render(x, t)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function shrinkJson(value: unknown, originalBytes: number, maxBytes: number): string {
  const compact = JSON.stringify(value);
  if (bytes(compact) <= maxBytes) return compact;
  // Largest node threshold that still fits (output size grows with t).
  let lo = MIN_T;
  let hi = Math.max(MIN_T, bytes(compact));
  let best: string | undefined;
  const atLo = render(value, lo);
  if (bytes(atLo) <= maxBytes) {
    best = atLo;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const s = render(value, mid);
      if (bytes(s) <= maxBytes) {
        lo = mid;
        best = s;
      } else hi = mid - 1;
    }
    return best;
  }
  // Too many keys even with every value cut: name what was there.
  const keys = isObj(value) ? Object.keys(value) : [];
  const fallback = (ks: string[], more: number) => JSON.stringify({ _truncated: true, keys: more ? [...ks, `…${more} more keys`] : ks, originalBytes });
  let n = keys.length;
  let s = fallback(keys, 0);
  while (bytes(s) > maxBytes && n > 0) {
    n = Math.floor(n / 2);
    s = fallback(keys.slice(0, n), keys.length - n);
  }
  return bytes(s) <= maxBytes ? s : JSON.stringify({ _truncated: true, originalBytes });
}

// ------------------------------------------------------------ text cut

function cutLines(text: string, maxBytes: number): { text: string; omitted: number; total: number } {
  const lines = text.split("\n");
  const total = lines.length;
  const marker = (omitted: number) => `[… omitted ${omitted} of ${total} lines …]`;
  const budget = maxBytes - bytes(marker(total)) - 2;
  const headBudget = Math.floor(budget * 0.6);
  const head: string[] = [];
  let used = 0;
  for (const l of lines) {
    const b = bytes(l) + 1;
    if (used + b > headBudget) break;
    head.push(l);
    used += b;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  const tailBudget = budget - used;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const b = bytes(lines[i]!) + 1;
    if (tailUsed + b > tailBudget) break;
    tail.unshift(lines[i]!);
    tailUsed += b;
  }
  const omitted = total - head.length - tail.length;
  if (head.length + tail.length > 0 && omitted > 0) {
    return { text: [...head, marker(omitted), ...tail].join("\n"), omitted, total };
  }
  // One line longer than the whole budget: fall back to a head and tail of bytes.
  const m = `\n[… omitted ${"9".repeat(String(bytes(text)).length)} bytes …]\n`;
  const room = Math.max(0, maxBytes - bytes(m));
  const h = prefixBytes(text, Math.floor(room * 0.6));
  const t = suffixBytes(text, room - bytes(h));
  const gone = bytes(text) - bytes(h) - bytes(t);
  return { text: `${h}\n[… omitted ${gone} bytes …]\n${t}`, omitted: 0, total };
}

// ------------------------------------------------------------ entry

/** Caps one tool result. Under the cap (or mode `none`) the text comes back unchanged with no cut. */
export function capOutput(text: string, o: OutputCapConfig = {}): CapResult {
  const mode = o.mode ?? "structure";
  const maxBytes = o.maxBytes ?? DEFAULT_CAP_BYTES;
  const originalBytes = bytes(text);
  if (mode === "none" || originalBytes <= maxBytes) return { text };
  const parsed = tryJson(text);
  const topKeys = parsed.ok && isObj(parsed.value) ? Object.keys(parsed.value) : undefined;
  let out: string;
  let cutExtra: Partial<OutputCut> = {};
  let kept: string[] | undefined;
  if (mode === "prefix") {
    const head = prefixBytes(text, maxBytes);
    out = `${head}\n[truncated ${originalBytes - bytes(head)} bytes]`;
    if (topKeys) {
      const ends = topValueEnds(text);
      const at = bytes(head);
      kept = topKeys.filter((k) => (ends.get(k) ?? Infinity) <= at);
    }
  } else if (parsed.ok) {
    out = shrinkJson(parsed.value, originalBytes, maxBytes);
    if (topKeys) {
      const got = tryJson(out);
      kept = got.ok && isObj(got.value) && got.value._truncated !== true ? topKeys.filter((k) => k in (got.value as Record<string, unknown>)) : [];
    }
  } else {
    const c = cutLines(text, maxBytes);
    out = c.text;
    cutExtra = { omittedLines: c.omitted, totalLines: c.total };
  }
  const cut: OutputCut = {
    mode,
    originalBytes,
    deliveredBytes: bytes(out),
    json: parsed.ok,
    jsonValid: parses(out),
    ...(topKeys ? { topKeys, topKeysKept: kept ?? [] } : {}),
    ...cutExtra,
  };
  return { text: out, cut };
}

/** Problems with an `outputCap` table, for config errors. */
export function outputCapProblems(v: unknown): string[] {
  if (!isObj(v)) return ["outputCap must be a table { mode, maxBytes }"];
  const out: string[] = [];
  if (v.mode !== undefined && !CAP_MODES.includes(v.mode as CapMode)) out.push(`outputCap.mode must be one of ${CAP_MODES.join(", ")}, got ${JSON.stringify(v.mode)}`);
  if (v.maxBytes !== undefined && !(typeof v.maxBytes === "number" && Number.isInteger(v.maxBytes) && v.maxBytes > 0)) out.push(`outputCap.maxBytes must be a whole number above 0, got ${JSON.stringify(v.maxBytes)}`);
  for (const k of Object.keys(v)) if (k !== "mode" && k !== "maxBytes") out.push(`outputCap has unknown key ${k}`);
  return out;
}

/** Two cuts of one result (stdout and stderr) as one. */
export function mergeCuts(a: OutputCut | undefined, b: OutputCut | undefined): OutputCut | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, originalBytes: a.originalBytes + b.originalBytes, deliveredBytes: a.deliveredBytes + b.deliveredBytes };
}
