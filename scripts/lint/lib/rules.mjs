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
import { SECRET_PATTERNS } from "../../release/secret-patterns.mjs";

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

// ---------------------------------------------------------------- vendor-literal

/** Vendor prefixes a string must not end with before a `+`: esbuild folds `"ghp_" + x` back into one literal. */
const VENDOR_PREFIX = String.raw`(?:sk_test_|sk_live_|AKIA|ghp_|github_pat_|xox[abprs]-|sk-ant-|npm_)`;
const SPLIT_LITERAL = new RegExp(String.raw`(["'\x60])(?:(?!\1)[^\\\n]|\\.)*?${VENDOR_PREFIX}\1\s*\+`, "g");
/** The AWS docs example key, which GitHub's secret scanning knows by shape. */
const AWS_EXAMPLE = /AKIA[0-9A-Z]{12}EXAMPLE/g;
/**
 * The shapes a secret scanner on a push reads as real. A made-up Anthropic key
 * or a private key header is not one, so tests and docs may name them; the
 * dist scan still catches them.
 */
const VENDOR_SHAPES = SECRET_PATTERNS.filter((p) => p.name !== "private-key" && p.name !== "anthropic-api-key");

/**
 * A whole vendor-shaped secret in a tracked file (push protection and the
 * release scan read it as a real one), or a string split with `+` so the
 * whole never appears: esbuild folds the split back into one literal in dist.
 * Build such values with [..].join("").
 */
function vendorLiteral(path, src) {
  const found = [];
  for (const p of VENDOR_SHAPES) {
    for (const m of src.matchAll(new RegExp(p.source, "g"))) found.push({ offset: m.index, message: `vendor-shaped literal (${p.name}); build it with [..].join("") so no whole value is in the file` });
  }
  for (const m of src.matchAll(AWS_EXAMPLE)) found.push({ offset: m.index, message: 'the AWS docs example key is vendor-shaped; build it with [..].join("")' });
  if (JS_EXT.test(path)) {
    for (const m of blankJs(src, { keepStrings: true }).matchAll(SPLIT_LITERAL)) found.push({ offset: m.index, message: 'build vendor-shaped literals with [..].join(""); esbuild folds +' });
  }
  return found;
}

// ---------------------------------------------------------------- site-voice

/** Words that read as marketing, not as a description. Whole words, any case. */
const MARKETING = new RegExp(
  String.raw`\b(?:seamless(?:ly)?|unlock(?:s|ed|ing)?|powerful|effortless(?:ly)?|supercharge[sd]?|revolutionary|game-?chang(?:er|ing)|cutting-edge|state-of-the-art|best-in-class|world-class|next-generation|blazing(?:ly)?[- ]fast|turnkey|elevate[sd]?|delve[sd]?|empower(?:s|ed|ing)?)\b`,
  "gi",
);
const NOT_X_BUT_Y = /\bnot (?:just|only|merely) [^.\n]{1,60}, but\b|\bisn't just\b/gi;
const SPACED_EM_DASH = /\S — \S/g;
const ID_LABEL = /\b[a-z]_[0-9a-f]{6,}\b/g;
const HOOK_EVENTS = "SessionStart|SessionEnd|PreToolUse|PostToolUse|PostToolUseFailure|UserPromptSubmit|SubagentStart|SubagentStop|PreCompact|PostCompact|Notification|Stop";
const HOOK_HEADING_HTML = new RegExp(String.raw`<h([1-3])\b[^>]*>\s*(?:${HOOK_EVENTS})\s*</h\1>`, "g");
const HOOK_HEADING_MD = new RegExp(String.raw`^#{1,3}[ \t]+(?:${HOOK_EVENTS})[ \t]*$`, "gm");

/** Visible text of a table-free Markdown file: code, comments, links and table rows blanked. */
function proseOnly(src) {
  const v = markdownVisible(src);
  return v
    .split("\n")
    .map((l) => (/^\s*\|/.test(l) ? " ".repeat(l.length) : l))
    .join("\n");
}

/**
 * Landing and docs copy that reads as written by a model: marketing words,
 * "not just X, but Y", spaced em dashes, id-style labels (`s_8f3a21`) and
 * headings that are only a hook event name.
 */
function siteVoice(path, src) {
  let text;
  let headings;
  let headingText;
  if (/\.(?:astro|html?)$/.test(path)) {
    text = headingText = astroVisible(src);
    headings = HOOK_HEADING_HTML;
  } else if (/\.mdx?$/.test(path)) {
    text = proseOnly(src);
    // Headings are prose too, but a code fence's `# comment` is not a heading.
    headingText = blankMatches(blankMatches(src, /^(\s*)(```|~~~)[\s\S]*?^\s*\2/gm), /<!--[\s\S]*?-->/g);
    headings = HOOK_HEADING_MD;
  } else {
    text = stringsOnly(src);
  }
  const found = [];
  for (const m of text.matchAll(MARKETING)) found.push({ offset: m.index, message: `"${m[0]}" is a marketing word; say what coding.sh does in plain words` });
  for (const m of text.matchAll(NOT_X_BUT_Y)) found.push({ offset: m.index, message: '"not just X, but Y" reads as written by a model; say the plain thing' });
  for (const m of text.matchAll(SPACED_EM_DASH)) found.push({ offset: m.index + 1, message: "spaced em dash in prose; use a period, a comma or a colon" });
  for (const m of text.matchAll(ID_LABEL)) found.push({ offset: m.index, message: `"${m[0]}" is an id-style label that shows as text; name the thing` });
  if (headings) for (const m of headingText.matchAll(headings)) found.push({ offset: m.index, message: "a heading that is only a hook event name; say what happens in plain words" });
  return found;
}

// ---------------------------------------------------------------- CSS rules

/** The CSS of a file, same length as the file: a .css file whole, the <style> bodies of a template. */
function cssText(path, src) {
  let css;
  if (path.endsWith(".css")) css = src;
  else {
    const ranges = [];
    for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const body = m.index + m[0].indexOf(">") + 1;
      ranges.push([body, body + m[1].length]);
    }
    css = keepRanges(src, ranges);
  }
  return blankMatches(css, /\/\*[\s\S]*?\*\//g);
}

const CSS_FILE = (path) => /\.css$/.test(path) || /\.(?:astro|html?)$/.test(path);
const STYLED = (path) => /^apps\/site\/src\/.+\.(?:css|astro|html?)$/.test(path) || path === "packages/coding.sh/src/viewer/ui/index.html" || /^packages\/coding\.sh\/src\/viewer\/ui\/.+\.css$/.test(path);

/** A selector whose last compound is `*`: `*`, `*::before`, `.theme-transition *`. */
const UNIVERSAL = /(?:^|[\s>+~(])\*(?:::?[\w-]+(?:\([^)]*\))?)*$/;
const NO_TRANSITION = /^(?:none|0s|0ms|initial|unset|revert)\b/i;

/** Rules that hold declarations (`selector { ... }`), not other rules: selector text, body text and the body's offset. Linear. */
function leafRules(css) {
  const rules = [];
  const brace = /[{}]/g;
  let from = 0;
  let pending;
  for (let m = brace.exec(css); m; m = brace.exec(css)) {
    if (m[0] === "{") pending = { selectors: css.slice(from, m.index), at: m.index + 1 };
    else if (pending) {
      rules.push({ ...pending, body: css.slice(pending.at, m.index) });
      pending = undefined;
    }
    from = m.index + 1;
  }
  return rules;
}

/** `transition` on `*`: it runs on every element, and a large DOM stalls on a theme toggle. */
function universalTransition(path, src) {
  const found = [];
  for (const rule of leafRules(cssText(path, src))) {
    if (!rule.selectors.split(",").some((sel) => UNIVERSAL.test(sel.trim()))) continue;
    for (const d of rule.body.matchAll(/(?:^|[;\s])(transition(?:-property)?)\s*:\s*([^;]*)/g)) {
      if (NO_TRANSITION.test(d[2].replace(/!important/i, "").trim())) continue;
      found.push({ offset: rule.at + d.index + d[0].indexOf(d[1]), message: "`transition` on `*`; scope it to the properties and elements that change" });
    }
  }
  return found;
}

/** Keyframes and `animation` declarations that name an animation. */
const ANIMATION = /@keyframes\b|(?:^|[;{\s])animation(?:-name)?\s*:\s*(?!none\b|inherit\b|initial\b|unset\b)[\w-]/gm;

/** A file that animates needs a `prefers-reduced-motion` query in the same file. */
function reducedMotion(path, src) {
  const css = cssText(path, src);
  if (/prefers-reduced-motion/.test(css)) return [];
  const m = ANIMATION.exec(css);
  ANIMATION.lastIndex = 0;
  return m ? [{ offset: m.index + (m[0].length - m[0].trimStart().length), message: "this file animates but has no `@media (prefers-reduced-motion)` query; turn the motion off or shorten it there" }] : [];
}

// ---------------------------------------------------------------- global-install

const NPM_GLOBAL = /\bnpm\s+(?:i|install|add)\b[^\n|;&]*?(?:\s-g\b|\s--global\b)|["']i(?:nstall)?["']\s*,\s*["'](?:-g|--global)["']/;
const INSTALL_SH = /(?:\b(?:ba)?sh|\bexec)\s+(?:"[^"\n]*|\S*)install\.sh\b|\bcurl\b[^\n]*\|\s*(?:ba)?sh\b/;
const PREFIX = /--prefix\b|npm_config_prefix|NPM_CONFIG_PREFIX|\bprefix=/;
/** Where installers get exercised for real: repo scripts, workflows, examples and deploy recipes. Unit tests only record the command they would run. */
const INSTALLER_SCOPE = /^(?:scripts\/|\.github\/workflows\/|examples\/|deploy\/)/;

/**
 * `npm i -g` or `install.sh` run in a script or workflow that names no
 * throwaway npm prefix: a temp HOME does not stop npm writing to the real
 * global prefix. A script or test counts as safe when it mentions a prefix
 * anywhere (it sets it once for every child); a workflow, when one is within
 * 25 lines of the command.
 */
function globalInstall(path, src) {
  const text = JS_EXT.test(path) ? blankJs(src, { keepStrings: true }) : src;
  const lines = text.split("\n");
  const workflow = /\.ya?ml$/.test(path);
  if (!workflow && PREFIX.test(text)) return [];
  const found = [];
  let at = 0;
  for (const [i, line] of lines.entries()) {
    const start = at;
    at += line.length + 1;
    if (!NPM_GLOBAL.test(line) && !INSTALL_SH.test(line)) continue;
    if (/^\s*(?:#|\/\/|\*)/.test(line)) continue;
    if (workflow && PREFIX.test(lines.slice(Math.max(0, i - 25), i + 26).join("\n"))) continue;
    found.push({ offset: start + line.search(/\S/), message: "a global install with no throwaway npm prefix; set npm_config_prefix=$TMP/prefix (a temp HOME does not stop npm writing to the real one)" });
  }
  return found;
}

// ---------------------------------------------------------------- personal-data

/** Names that stand for no one. */
const DUMMY_NAMES = new Set(["user", "users", "you", "me", "x", "u", "dev", "demo", "runner", "someone", "ann", "test", "tester", "alice", "bob", "name", "username", "yourname", "foo", "work"]);
const HOME_PATH = /(?<![\w.-])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)([A-Za-z0-9][\w.-]*)(?=[\\/]|$)/g;
const EMAIL = /(?<![\w.%+-])([\w.%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
/** Domains that reach no one, plus the ones the repo may name. */
const SAFE_DOMAIN =
  /(?:^|\.)(?:example(?:\.[a-z.]+)?|test|localhost|internal|local|invalid)$|^(?:users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com)$/i;
/**
 * Our own domain: an address there could reach someone, and a commit made with it is not a
 * GitHub account. `coding.sh.invalid` is under the reserved `.invalid` TLD (RFC 2606), so it
 * reaches no one and passes like any other reserved name.
 */
const OWN_DOMAIN = /^coding\.sh$/i;
const FILE_EXT = /^(?:png|jpe?g|gif|webp|svg|json|js|mjs|ts|css|html|md|txt|yml|yaml|py|toml|lock|jsonl|mark|fixture|parametrize|skip)$/i;

/**
 * A real home path (a person's `/Users/<name>/`) or an email at a domain that is not
 * reserved for examples. Synthetic commit identities say why in the allowlist.
 */
function personalData(path, src) {
  const found = [];
  for (const m of src.matchAll(HOME_PATH)) {
    if (DUMMY_NAMES.has(m[1].toLowerCase())) continue;
    found.push({ offset: m.index, message: `a home path with a real-looking user name (${m[1]}); use /home/user or /work/demo` });
  }
  for (const m of src.matchAll(EMAIL)) {
    const domain = m[2];
    const own = OWN_DOMAIN.test(domain);
    if (!own && (FILE_EXT.test(domain.split(".").pop()) || /^\d+x$/.test(m[1]))) continue;
    if (src[m.index - 1] === ":") continue; // user:password@host
    if (!own && SAFE_DOMAIN.test(domain)) continue;
    found.push({ offset: m.index, message: `an email address at ${domain}; use user@example.test, or allowlist a synthetic identity with the reason` });
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
  {
    id: "vendor-literal",
    description: 'A whole vendor-shaped secret (sk_test_, AKIA..., ghp_, xox...) or one split with `+`; build it with [..].join("")',
    applies: (path) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|md|json|ya?ml|astro)$/.test(path) && !path.endsWith(".d.ts") && !/(?:^|\/)package-lock\.json$/.test(path),
    check: vendorLiteral,
  },
  {
    id: "site-voice",
    description: "Site and README copy that reads as written by a model: marketing words, em dashes, id-style labels, hook names as headings",
    applies: (path, site) =>
      (/^apps\/site\/src\//.test(path) && /\.(?:astro|html?|mdx?|ts|tsx|js|mjs)$/.test(path) && !/\.d\.ts$/.test(path)) || site.has(path) || path === "README.md" || /^packages\/[^/]+\/README\.md$/.test(path),
    check: siteVoice,
  },
  {
    id: "universal-transition",
    description: "`transition` on the `*` selector",
    applies: (path) => CSS_FILE(path) && STYLED(path),
    check: universalTransition,
  },
  {
    id: "reduced-motion",
    description: "A stylesheet with @keyframes or an animation and no prefers-reduced-motion query",
    applies: (path) => CSS_FILE(path) && STYLED(path),
    check: reducedMotion,
  },
  {
    id: "global-install",
    description: "`npm i -g` or install.sh run with no throwaway npm prefix nearby",
    applies: (path) => /\.(?:sh|mjs|cjs|js|ts|ya?ml)$/.test(path) && INSTALLER_SCOPE.test(path),
    check: globalInstall,
  },
  {
    id: "personal-data",
    description: "A real-looking home path or an email at a domain not reserved for examples",
    fixtures: true,
    applies: (path) => /\.(?:ts|tsx|mts|js|mjs|cjs|md|json|jsonl|ya?ml|astro|html?|sh|py|toml|txt|css)$/.test(path) && !/(?:^|\/)package-lock\.json$/.test(path),
    check: personalData,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
