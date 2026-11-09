// Anti-slop rules. Each rule reads one file and returns findings with an
// offset into it. Pure: no I/O. See CONTRIBUTING.md "Lint and git hooks".
import {
  blankJs,
  blankMatches,
  codeView,
  enclosingOpen,
  keepRanges,
  matchClose,
  matchOpen,
  skipType,
  skipWs,
  skipWsBack,
  stringsOnly,
  wordAt,
} from "./source.mjs";

const TS_EXT = /\.(?:ts|tsx|mts|cts|astro)$/;
const JS_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|astro)$/;
/** Words that end an expression yet may stand before a grouping paren: `return (x as A) as B`. */
const KEYWORDS_BEFORE_PAREN = new Set(["return", "typeof", "await", "yield", "case", "in", "of", "void", "throw", "delete", "else", "do"]);

// ---------------------------------------------------------------- chained-as

/** `x as A as B` and `(x as A) as B`: a cast that launders a type through another. */
function chainedAs(path, src) {
  let b = codeView(path, src);
  // `import { a as b }`, `export { a as b }` and `* as ns` rename; they are not casts.
  b = blankMatches(b, /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g);
  b = blankMatches(b, /\*\s*as\s+[\w$]+/g);
  const found = [];
  for (const m of b.matchAll(/(?<![\w$.])as\s/g)) {
    const before = skipWsBack(b, m.index - 1);
    if (before < 0 || !/[\w$)\]"'`}!]/.test(b[before])) continue;
    let t = skipType(b, m.index + 2);
    if (t === m.index + 2) continue;
    let next = skipWs(b, t);
    if (b[next] === ")") {
      const open = matchOpen(b, next);
      if (open < 0) continue;
      const p = skipWsBack(b, open - 1);
      let word = "";
      for (let k = p; k >= 0 && /[\w$]/.test(b[k]); k--) word = b[k] + word;
      const call = p >= 0 && (word ? !KEYWORDS_BEFORE_PAREN.has(word) : /[)\]>]/.test(b[p]));
      if (call) continue;
      next = skipWs(b, next + 1);
    }
    if (wordAt(b, next, "as")) found.push({ offset: m.index, message: "chained `as` cast; check the value at runtime or fix the source type" });
  }
  return found;
}

// ---------------------------------------------------------------- unknown-param

/** Evidence that a function checks its `unknown` parameter at runtime. */
function checks(body, name) {
  const n = name.replace(/\$/g, "\\$");
  return [
    new RegExp(`\\btypeof\\s+${n}\\b`),
    new RegExp(`\\bArray\\.isArray\\(\\s*${n}\\b`),
    new RegExp(`(?<![\\w$.])${n}\\s+instanceof\\b`),
    new RegExp(`(?<![\\w$.])${n}\\s*[!=]==?\\s*(?:null|undefined)\\b`),
    new RegExp(`\\b(?:null|undefined)\\s*[!=]==?\\s*${n}(?![\\w$])`),
    new RegExp(`\\bin\\s+${n}(?![\\w$])`),
    // Handed to another function first: that function owns the check.
    new RegExp(`(?<![\\w$.])(?!String\\b|Number\\b|Boolean\\b)[\\w$.]+\\(\\s*${n}\\s*[,)]`),
  ].some((re) => re.test(body));
}

/** Function names that mark a trust boundary: the function exists to check its input. */
const BOUNDARY_NAME = /^(?:is|as|assert|parse|validate|check|guard|ensure|decode|coerce|normalize|sanitize|from)(?:[A-Z_$]|$)/;

/** Name of the function whose parameter list opens at `open`, or "". */
function functionName(b, open) {
  let p = skipWsBack(b, open - 1);
  const word = () => {
    let w = "";
    for (; p >= 0 && /[\w$]/.test(b[p]); p--) w = b[p] + w;
    p = skipWsBack(b, p);
    return w;
  };
  if (b[p] === ">") {
    // Generic parameters: name<T>(...).
    let depth = 0;
    for (; p >= 0; p--) {
      if (b[p] === ">") depth++;
      else if (b[p] === "<" && --depth === 0) break;
    }
    p = skipWsBack(b, p - 1);
  }
  let w = word();
  if (w === "async") w = word();
  if (w === "function") w = word();
  if (w) return w;
  // const name = (...) => / name: (...) => / name = function (...)
  if (b[p] === "=" || b[p] === ":") {
    p = skipWsBack(b, p - 1);
    return word();
  }
  return "";
}

/** End of an arrow function's expression body that starts at `i`. */
function expressionEnd(b, i) {
  for (let k = i; k < b.length; k++) {
    const c = b[k];
    if (c === "(" || c === "[" || c === "{") {
      const e = matchClose(b, k);
      if (e < 0) return b.length;
      k = e;
    } else if (c === ")" || c === "]" || c === "}" || c === ";" || c === ",") return k;
  }
  return b.length;
}

/**
 * A parameter typed `unknown` that the function casts with `as` and never
 * checks. `unknown` belongs at trust boundaries, where the value is checked
 * (typeof, Array.isArray, instanceof, `in`, a null check, or handed to
 * another function), or the function is a type guard or is named for the
 * check (is*, parse*, validate*, ...).
 */
function unknownParam(path, src) {
  const b = codeView(path, src);
  const found = [];
  for (const m of b.matchAll(/(?<![\w$])([\w$]+)\s*\??\s*:\s*unknown\b(?=\s*[,)=])(?!\s*=>)/g)) {
    const name = m[1];
    const lead = skipWsBack(b, m.index - 1);
    const leadOk = b[lead] === "(" || b[lead] === "," || (b[lead] === "." && b.slice(lead - 2, lead + 1) === "...");
    if (!leadOk) continue;
    const open = enclosingOpen(b, m.index);
    if (open < 0 || b[open] !== "(") continue;
    const p = skipWsBack(b, open - 1);
    let word = "";
    for (let k = p; k >= 0 && /[\w$]/.test(b[k]); k--) word = b[k] + word;
    if (word === "catch" || name === "this") continue;
    if (BOUNDARY_NAME.test(functionName(b, open))) continue;
    const close = matchClose(b, open);
    if (close < 0) continue;
    let k = skipWs(b, close + 1);
    if (b[k] === ":") {
      const r = skipWs(b, k + 1);
      // A type guard or assertion function is the trust boundary itself.
      if (wordAt(b, r, "asserts") || new RegExp(`^[\\w$]+\\s+is\\b`).test(b.slice(r, r + 80))) continue;
      k = skipWs(b, skipType(b, k + 1));
    }
    let body = "";
    if (b[k] === "=" && b[k + 1] === ">") {
      const s = skipWs(b, k + 2);
      body = b[s] === "{" ? b.slice(s, matchClose(b, s) + 1) : b.slice(s, expressionEnd(b, s));
    } else if (b[k] === "{") {
      const e = matchClose(b, k);
      body = b.slice(k, e < 0 ? b.length : e + 1);
    } else continue;
    const n = name.replace(/\$/g, "\\$");
    const cast = new RegExp(`(?<![\\w$.])${n}\\s+as\\s+(?!unknown\\b|const\\b)`).test(body);
    if (cast && !checks(body, name)) {
      found.push({ offset: m.index, message: `\`${name}: unknown\` is cast with \`as\` and never checked; give it a real type or check it at runtime` });
    }
  }
  return found;
}

// ---------------------------------------------------------------- conditional-empty-spread

const EMPTY = String.raw`(?:\{\s*\}|\[\s*\])`;
const EMPTY_ELSE = new RegExp(String.raw`:\s*${EMPTY}\s*$`);
const EMPTY_THEN = new RegExp(String.raw`\?\s*${EMPTY}\s*:`);

/** Top-level text of a bracket's contents: nested brackets blanked. */
function topLevel(s) {
  const out = s.split("");
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "(" || c === "[" || c === "{") {
      if (depth++ > 0) out[k] = " ";
    } else if (c === ")" || c === "]" || c === "}") {
      if (--depth > 0) out[k] = " ";
    } else if (depth > 0 && c !== "\n") out[k] = " ";
  }
  return out.join("");
}

/** `...(c ? { a } : {})`, `...(c ? [] : [a])` and `...(c && { a })`. */
function conditionalEmptySpread(path, src) {
  const b = codeView(path, src);
  const found = [];
  for (const m of b.matchAll(/\.\.\.\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(b, open);
    if (close < 0) continue;
    const inner = b.slice(open + 1, close);
    const top = topLevel(inner);
    const ternary = /(?<!\?)\?(?![.?])/.test(top) && (EMPTY_ELSE.test(inner) || EMPTY_THEN.test(inner));
    const and = /&&\s*[{[]/.test(top);
    if (ternary || and) {
      found.push({ offset: m.index, message: "conditional spread with an empty branch; assign the field in an `if`, or build the object with a helper that drops empty values" });
    }
  }
  return found;
}

// ---------------------------------------------------------------- barrel-file

const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])[^"']*\1\s*;?/g;
const IMPORT = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,?\s*)?(?:\*\s+as\s+[\w$]+|\{[^}]*\})?\s*(?:from\s*)?(["'])[^"']*\1\s*;?/g;
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{[^}]*\}\s*;?/g;

/**
 * A module that only re-exports other modules: `export ... from` lines, or
 * imports passed straight on with `export { ... }`.
 */
function barrelFile(path, src) {
  const b = blankJs(src);
  const reexports = [...b.matchAll(REEXPORT)];
  const imports = [...b.matchAll(IMPORT)];
  const lists = [...b.matchAll(EXPORT_LIST)].filter((m) => !/^export\s+(?:type\s+)?\{\s*\}/.test(m[0]));
  if (!reexports.length && !(imports.length && lists.length)) return [];
  const rest = blankMatches(blankMatches(blankMatches(b, REEXPORT), IMPORT), EXPORT_LIST);
  if (rest.trim()) return [];
  const first = Math.min(...[...reexports, ...imports, ...lists].map((m) => m.index));
  return [{ offset: first, message: "barrel file: it only re-exports other modules; import from the module that defines the name" }];
}

// ---------------------------------------------------------------- site-placeholder

/**
 * Words that say the page is unfinished. Case-insensitive. "planned" counts as
 * a label ("(planned)", "is planned.", "Planned, no adapter yet"), not as an
 * adjective before a noun ("planned looks", "a planned edit").
 */
const UNFINISHED =
  /\bplanned\b(?=\s*(?:$|[^\w\s]|(?:and|but|or|for|in|on|to|as|so|not|yet|do|does|is|are|will|until|soon|only|features?|items?|work|support)\b))|\b(?:coming soon|not (?:yet )?implemented|under construction|lorem ipsum|placeholder (?:text|content|data))\b/gim;
/** Case-sensitive markers. */
const MARKERS = /\b(?:TODO|TBD|WIP|FIXME)\b/g;
/** A demo labelled as fake. */
const SAMPLE = /\b(?:sample|demo|dummy|fake|mock) (?:data|sessions?|traces?|runs?|events?|output|content)\b|\(samples?\)/gi;
/** A label that is just the word. */
const SAMPLE_LABEL = /^\s*samples?\s*$/i;
/** Attributes whose values never show on the page. */
const HIDDEN_ATTR = /^(?:alt|class|classname|class:list|id|href|src|srcset|style|name|type|rel|target|for|role|lang|charset|loading|decoding|width|height|key|slot|is|set:html|data-[\w-]+|aria-hidden|aria-controls|aria-describedby|aria-labelledby|tabindex|method|action|viewbox|d|fill|stroke|xmlns|transition:[\w-]+|client:[\w-]+)$/i;

function scanText(text, base, found) {
  for (const re of [UNFINISHED, MARKERS, SAMPLE]) {
    for (const m of text.matchAll(re)) found.push({ offset: base + m.index, message: `"${m[0]}" shows on the site; ship the feature or drop the line` });
  }
}

/** Visible text of an .astro or HTML template, blanked elsewhere. */
function astroVisible(src) {
  const fm = /^(\s*)---\r?\n[\s\S]*?\r?\n---/.exec(src);
  let v = keepRanges(src, [[fm ? fm[0].length : 0, src.length]]);
  for (const re of [/<script\b[\s\S]*?<\/script>/gi, /<style\b[\s\S]*?<\/style>/gi, /<!--[\s\S]*?-->/g, /<(code|pre|kbd|samp)\b[\s\S]*?<\/\1>/gi]) v = blankMatches(v, re);
  // JSX expressions are code.
  const out = v.split("");
  for (let k = 0; k < v.length; k++) {
    if (v[k] !== "{") continue;
    const e = matchClose(blankJs(v.slice(k, Math.min(v.length, k + 20000))), 0);
    const end = e < 0 ? v.length : k + e + 1;
    for (let j = k; j < end; j++) if (out[j] !== "\n") out[j] = " ";
    k = end - 1;
  }
  return out.join("");
}

function sitePlaceholderTemplate(src) {
  const v = astroVisible(src);
  const found = [];
  // Attributes: visible ones are checked, hidden ones are dropped.
  let text = v.split("");
  for (const tag of v.matchAll(/<\/?[A-Za-z][\w.:-]*\b((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>/g)) {
    const attrsAt = tag.index + tag[0].indexOf(tag[1]);
    for (const a of tag[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = a[2] ?? a[3] ?? "";
      const valueAt = attrsAt + a.index + a[0].length - value.length - 1;
      if (HIDDEN_ATTR.test(a[1])) continue;
      scanText(value, valueAt, found);
      if (SAMPLE_LABEL.test(value)) found.push({ offset: valueAt, message: `"${value.trim()}" label shows on the site; show the command or the real data instead` });
    }
    for (let j = tag.index; j < tag.index + tag[0].length; j++) if (text[j] !== "\n") text[j] = " ";
  }
  text = text.join("");
  scanText(text, 0, found);
  for (const seg of text.matchAll(/[^\n]+/g)) {
    if (SAMPLE_LABEL.test(seg[0])) found.push({ offset: seg.index, message: `"${seg[0].trim()}" label shows on the site; show the command or the real data instead` });
  }
  return found;
}

/** Prose of a Markdown file: code fences and code spans blanked. */
function markdownVisible(src) {
  let v = blankMatches(src, /^(\s*)(```|~~~)[\s\S]*?^\s*\2/gm);
  v = blankMatches(v, /`[^`\n]*`/g);
  v = blankMatches(v, /<!--[\s\S]*?-->/g);
  v = blankMatches(v, /\]\([^)]*\)/g);
  return v;
}

function sitePlaceholder(path, src) {
  if (/\.(?:astro|html?)$/.test(path)) return sitePlaceholderTemplate(src);
  const found = [];
  if (/\.mdx?$/.test(path)) {
    scanText(markdownVisible(src), 0, found);
    return found;
  }
  const strings = stringsOnly(src);
  scanText(strings, 0, found);
  // A string that is only the word: "sample".
  for (const m of src.matchAll(/(["'`])(\s*samples?\s*)\1/gi)) {
    const at = m.index + 1;
    if (strings.slice(at, at + m[2].length) === m[2]) found.push({ offset: at, message: `"${m[2].trim()}" label shows on the site; show the command or the real data instead` });
  }
  return found;
}

// ---------------------------------------------------------------- registry

/**
 * `applies(path)` picks the files a rule reads. Paths are repo-relative with
 * forward slashes. `site` is the set of repo docs the site renders.
 */
export const RULES = [
  {
    id: "chained-as",
    description: "A chained `as` cast (`x as unknown as T`, `(x as A) as B`) that skips the type checker",
    applies: (path) => TS_EXT.test(path) && !path.endsWith(".d.ts"),
    check: chainedAs,
  },
  {
    id: "unknown-param",
    description: "A parameter typed `unknown` that the function casts with `as` and never checks (outside a trust boundary)",
    applies: (path) => TS_EXT.test(path) && !path.endsWith(".d.ts"),
    check: unknownParam,
  },
  {
    id: "conditional-empty-spread",
    description: "A conditional spread with an empty branch: `...(c ? { a } : {})`, `...(c && { a })`",
    applies: (path) => JS_EXT.test(path) && !path.endsWith(".d.ts"),
    check: conditionalEmptySpread,
  },
  {
    id: "barrel-file",
    description: "A module that only re-exports other modules",
    applies: (path) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) && !path.endsWith(".d.ts"),
    check: barrelFile,
  },
  {
    id: "site-placeholder",
    description: 'Visible "sample", "planned", "coming soon", TODO or lorem ipsum text on the site',
    applies: (path, site) =>
      (/^apps\/site\/src\//.test(path) && /\.(?:astro|html?|mdx?|ts|tsx|js|mjs)$/.test(path) && !/\.d\.ts$/.test(path)) || site.has(path),
    check: sitePlaceholder,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
