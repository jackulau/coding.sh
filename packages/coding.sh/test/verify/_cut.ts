// Cut inputs for the adapter checks in this folder: what a payload or a JSON line looks like when its writer
// stopped part way, as the hook stores it and as a JSON text closed after the cut.
import { stdinText } from "./_common.ts";

/** A payload as the hook stores it and ingest reads it back: the UTF-8 text without a leading BOM, as the JSON it parses to, else as the text. */
export function storedPayload(bytes: Buffer): unknown {
  const text = stdinText(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type Part = { text: string; done: boolean };

/**
 * Closes what a JSON text cut at its end left open: what its writer would have sent had it closed what it
 * opened. A cut string is closed (a partial escape dropped), a cut number keeps its longest valid prefix,
 * a cut literal, a cut key or a trailing comma is dropped with the item it began, and open arrays and
 * objects are closed. Undefined when no value is left (an empty text, a cut literal or a lone "-"). Throws on
 * a text that does not start a JSON text.
 */
export function closeJson(s: string): string | undefined {
  let i = 0;
  const fail = (): never => {
    throw new Error(`not the start of a JSON text at offset ${i}`);
  };
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  const string = (): Part => {
    const start = i;
    let j = i + 1;
    while (j < s.length) {
      const ch = s[j];
      if (ch === '"') {
        i = j + 1;
        return { text: s.slice(start, i), done: true };
      }
      if (ch === "\\") {
        if (j + 1 >= s.length) break;
        if (s[j + 1] === "u") {
          if (j + 6 > s.length) break;
          j += 6;
        } else j += 2;
        continue;
      }
      j++;
    }
    const end = Math.min(j, s.length);
    i = s.length;
    return { text: s.slice(start, end) + '"', done: false };
  };
  const number = (): Part | undefined => {
    const text = /^-?\d*(\.\d*)?([eE][+-]?\d*)?/.exec(s.slice(i))![0];
    i += text.length;
    if (i < s.length) return { text, done: true };
    const valid = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text)?.[0];
    return valid ? { text: valid, done: false } : undefined;
  };
  const value = (): Part | undefined => {
    ws();
    if (i >= s.length) return undefined;
    const c = s[i]!;
    if (c === "{" || c === "[") return container(c);
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const literal of ["true", "false", "null"]) {
      if (s.startsWith(literal, i)) {
        i += literal.length;
        return { text: literal, done: true };
      }
      if (literal.startsWith(s.slice(i))) {
        i = s.length;
        return undefined;
      }
    }
    return fail();
  };
  const container = (open: "{" | "["): Part => {
    const close = open === "{" ? "}" : "]";
    i++;
    const items: string[] = [];
    const cut = (): Part => ({ text: open + items.join(",") + close, done: false });
    for (;;) {
      ws();
      if (i >= s.length) return cut();
      if (s[i] === close) {
        i++;
        return { text: open + items.join(",") + close, done: true };
      }
      if (items.length) {
        if (s[i] !== ",") fail();
        i++;
        ws();
        if (i >= s.length) return cut();
      }
      let key = "";
      if (open === "{") {
        if (s[i] !== '"') fail();
        const k = string();
        if (!k.done) return cut();
        ws();
        if (i >= s.length) return cut();
        if (s[i] !== ":") fail();
        i++;
        key = k.text + ":";
      }
      const v = value();
      if (v === undefined) return cut();
      items.push(key + v.text);
      if (!v.done) return cut();
    }
  };
  return value()?.text;
}
