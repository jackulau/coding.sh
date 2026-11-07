// Pull a JSON value out of model (or program) text that may wrap it in prose,
// markdown fences, or trail it with commentary. Tries, in order: the whole
// text, each fenced block, then every balanced {...} / [...] span; each with
// and without trailing-comma repair. Returns the first candidate that parses.

function balancedSpans(s: string, open: string, close: string): string[] {
  const out: string[] = [];
  for (let start = s.indexOf(open); start !== -1; start = s.indexOf(open, start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          out.push(s.slice(start, i + 1));
          break;
        }
      }
    }
    if (out.length >= 32) break;
  }
  return out;
}

function repair(s: string): string {
  // Trailing commas before } or ], outside strings.
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += s[i + 1] ?? "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j] as string)) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  for (const cand of [s, repair(s)]) {
    try {
      return { ok: true, value: JSON.parse(cand) };
    } catch {
      // next
    }
  }
  return { ok: false };
}

export interface ExtractOpts {
  /** Only accept values this predicate likes (e.g. "has a score field"). */
  accept?: (v: unknown) => boolean;
}

/** First JSON value found in `text`, or undefined. */
export function extractJson(text: string, opts: ExtractOpts = {}): unknown {
  const accept = opts.accept ?? (() => true);
  const t = text.trim().replace(/^﻿/, "");
  const candidates: string[] = [t];
  for (const m of t.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g)) candidates.push((m[1] as string).trim());
  candidates.push(...balancedSpans(t, "{", "}"), ...balancedSpans(t, "[", "]"));
  for (const c of candidates) {
    if (!c) continue;
    const r = tryParse(c);
    if (r.ok && accept(r.value)) return r.value;
  }
  return undefined;
}

/** Parse a value that may be JSON text; non-JSON strings come back unchanged. */
export function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const found = extractJson(v);
  return found === undefined ? v : found;
}
