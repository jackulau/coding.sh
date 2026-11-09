// Source helpers for the anti-slop lint. Every transform keeps the text the
// same length and keeps newlines, so an offset in the transformed text is the
// offset (and line) in the file. Zero dependencies.

const IDENT = /[\w$]/;
/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
const REGEX_AFTER_CHAR = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/** Replaces [a, b) with spaces, keeping line breaks. */
function blankRange(out, a, b) {
  for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
}

/** The word that ends at `end` (exclusive), or "". */
function wordBefore(s, end) {
  let k = end;
  while (k > 0 && IDENT.test(s[k - 1])) k--;
  return s.slice(k, end);
}

/**
 * JS/TS source with comments blanked and the contents of string, template and
 * regex literals blanked. Quote characters stay, so `"x"` becomes `" "`;
 * `${...}` inside a template stays code. With `keepStrings`, only comments
 * and regex bodies are blanked.
 */
export function blankJs(src, { keepStrings = false } = {}) {
  const out = src.split("");
  /** Blanks literal text unless the caller keeps strings. */
  const blankText = (a, b) => {
    if (!keepStrings) blankRange(out, a, b);
  };
  const n = src.length;
  /** Brace depth at which each open `${` started. */
  const templates = [];
  let depth = 0;
  /** Last significant character of code, for telling a regex from a division. */
  let prev = "";
  let prevEnd = 0;

  /** Scans template text from `j` to its end or to a `${`; returns where code resumes. */
  const template = (j) => {
    const start = j;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") {
        blankText(start, j);
        prev = "`";
        prevEnd = j + 1;
        return j + 1;
      }
      if (c === "$" && src[j + 1] === "{") {
        blankText(start, j);
        templates.push(depth);
        depth++;
        prev = "{";
        prevEnd = j + 2;
        return j + 2;
      }
      j++;
    }
    blankText(start, n);
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blankRange(out, i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blankRange(out, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blankText(i + 1, Math.min(j, n));
      prev = c;
      i = j + 1;
      prevEnd = i;
      continue;
    }
    if (c === "`") {
      i = template(i + 1);
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth--;
        i = template(i + 1);
        continue;
      }
      depth--;
    }
    if (c === "/") {
      const word = IDENT.test(prev) ? wordBefore(src, prevEnd) : "";
      const regex = prev === "" || (word ? REGEX_AFTER_WORD.has(word) : REGEX_AFTER_CHAR.has(prev));
      if (regex) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== "\n") {
          const r = src[j];
          if (r === "\\") {
            j += 2;
            continue;
          }
          if (r === "[") cls = true;
          else if (r === "]") cls = false;
          else if (r === "/" && !cls) break;
          j++;
        }
        blankRange(out, i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        prev = "/";
        prevEnd = j;
        i = j;
        continue;
      }
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevEnd = i + 1;
    }
    i++;
  }
  return out.join("");
}

/** Keeps only [start, end) ranges of `src`; everything else becomes spaces (newlines kept). */
export function keepRanges(src, ranges) {
  const out = src.split("");
  let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    blankRange(out, at, a);
    at = Math.max(at, b);
  }
  blankRange(out, at, src.length);
  return out.join("");
}

/** Blanks every match of `re` (global) in `s`. */
export function blankMatches(s, re) {
  const out = s.split("");
  for (const m of s.matchAll(re)) blankRange(out, m.index, m.index + m[0].length);
  return out.join("");
}

/** Code regions of an .astro file: the frontmatter and every <script> body. */
export function astroCodeRanges(src) {
  const ranges = [];
  const fm = /^(\s*)---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (fm) {
    const start = fm[1].length + 3;
    ranges.push([start, start + 1 + fm[2].length]);
  }
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m.index + m[0].indexOf(">") + 1;
    ranges.push([body, body + m[1].length]);
  }
  return ranges;
}

/** The code a TS rule reads: blanked JS/TS, or the code regions of an .astro file. */
export function codeView(path, src) {
  if (path.endsWith(".astro")) return blankJs(keepRanges(src, astroCodeRanges(src)));
  return blankJs(src);
}

/** Index of the bracket that closes the one at `i` (`(`, `[`, `{` or `<`), or -1. Reads blanked code. */
export function matchClose(b, i) {
  const open = b[i];
  const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open];
  let depth = 0;
  for (let k = i; k < b.length; k++) {
    const c = b[k];
    if (open === "<" && c === ">" && b[k - 1] === "=") continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return k;
  }
  return -1;
}

/** Index of the bracket that opens the one closing at `i`, or -1. Reads blanked code. */
export function matchOpen(b, i) {
  const close = b[i];
  const open = { ")": "(", "]": "[", "}": "{" }[close];
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    const c = b[k];
    if (c === close) depth++;
    else if (c === open && --depth === 0) return k;
  }
  return -1;
}

/** Index of the innermost unclosed `(`, `[` or `{` before `i`, or -1. */
export function enclosingOpen(b, i) {
  const stack = [];
  for (let k = i - 1; k >= 0; k--) {
    const c = b[k];
    if (c === ")" || c === "]" || c === "}") stack.push(c);
    else if (c === "(" || c === "[" || c === "{") {
      if (!stack.length) return k;
      stack.pop();
    }
  }
  return -1;
}

export const skipWs = (b, i) => {
  while (i < b.length && /\s/.test(b[i])) i++;
  return i;
};

export const skipWsBack = (b, i) => {
  while (i >= 0 && /\s/.test(b[i])) i--;
  return i;
};

/** True when `word` starts at `i` and is a whole word. */
export const wordAt = (b, i, word) => b.startsWith(word, i) && !IDENT.test(b[i + word.length] ?? "") && !IDENT.test(b[i - 1] ?? "");

/**
 * End of the TS type that starts at `i` (after whitespace): names, generics,
 * arrays, tuples, object and function types, unions and intersections.
 * Reads blanked code. Returns `i` when no type starts there.
 */
export function skipType(b, i) {
  let k = skipWs(b, i);
  const begin = k;
  for (;;) {
    for (const w of ["keyof", "typeof", "readonly", "unique", "infer", "asserts"]) {
      if (wordAt(b, k, w)) k = skipWs(b, k + w.length);
    }
    const c = b[k];
    if (c === "(" || c === "[" || c === "{") {
      const e = matchClose(b, k);
      if (e < 0) return k;
      k = e + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const e = b.indexOf(c, k + 1);
      if (e < 0) return k;
      k = e + 1;
    } else if (c === "-" && /\d/.test(b[k + 1] ?? "")) {
      k++;
      while (/[\w.]/.test(b[k] ?? "")) k++;
    } else if (IDENT.test(c ?? "")) {
      while (/[\w$.]/.test(b[k] ?? "")) k++;
    } else return k === begin ? i : k;
    for (;;) {
      const j = skipWs(b, k);
      if (b[j] === "<") {
        const e = matchClose(b, j);
        if (e < 0) break;
        k = e + 1;
      } else if (b[j] === "[") {
        const e = matchClose(b, j);
        if (e < 0) break;
        k = e + 1;
      } else if (b[j] === "=" && b[j + 1] === ">") {
        k = skipType(b, j + 2);
      } else break;
    }
    const j = skipWs(b, k);
    if ((b[j] === "|" && b[j + 1] !== "|") || (b[j] === "&" && b[j + 1] !== "&")) {
      k = skipWs(b, j + 1);
      continue;
    }
    if (wordAt(b, j, "extends") || wordAt(b, j, "is")) {
      k = skipWs(b, j + (b[j] === "e" ? 7 : 2));
      continue;
    }
    return k;
  }
}

/** Offsets of each line start, for turning offsets into 1-based lines. */
export function lineStarts(s) {
  const starts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") starts.push(i + 1);
  return starts;
}

export function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Only the text inside string and template literals; code and comments blanked. */
export function stringsOnly(src) {
  const kept = blankJs(src, { keepStrings: true });
  const bare = blankJs(src);
  const out = src.split("");
  for (let k = 0; k < src.length; k++) if (out[k] !== "\n" && out[k] !== "\r" && kept[k] === bare[k]) out[k] = " ";
  return out.join("");
}
