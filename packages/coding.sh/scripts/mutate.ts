// Mutation testing for coding.sh's own tests: which plausible bugs in one source file would the
// named test files miss? It makes mutants of the file, each one small change, runs the test files
// against each mutant, and counts it killed when they fail, survived when they pass, and timed out
// when they run past the limit.
//
// The changes, by operator:
//   cmp-boundary  < to <=, <= to <, > to >=, >= to >
//   cmp-negate    < to >=, <= to >, > to <=, >= to <, === to !==, !== to ===, == to !=, != to ==
//   logic-swap    && to ||, || to &&
//   negate-cond   the condition of an if or a while wrapped in !( )
//   drop-not      a unary ! removed, where it does not start an if or while condition
//   num-inc       a number plus 1
//   num-dec       a number minus 1
//   drop-stmt     a statement in a block removed: not a declaration
//   return-zero   `return <zero>;` first in a function body: 0, "", false, [], {}, new Map() and so
//                 on by the declared return type; plain `return;` for void, undefined and a type it
//                 does not know
//   regex-quant   a quantifier in a regular expression literal: + to *, * to +, ? removed, lazy to
//                 greedy, and each bound of {n}, {n,} and {n,m} moved by 1
//
// The file is read through Node's type stripping (node:module stripTypeScriptTypes), which keeps
// every offset, so mutants land on code and never on types, comments or strings. A mutant that
// does not parse, or whose regular expression is not valid, is left out. At most --max mutants run
// (default 80), the same ones every time: spread evenly over the operators, and within each one
// evenly over the file. The ones left out are listed in --json.
//
// The worktree is never written. Each job gets its own copy of the package in the temp folder: a
// mutant is written into the copy, the tests run there, and a `finally` writes the original back
// and checks it byte for byte. The copies are removed at the end, also after Ctrl-C. Each test run
// gets its own HOME, USERPROFILE, CODING_SH_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and temp folder,
// and runs without the variables that mark an agent session or name a built CLI.
//
//   node --no-warnings scripts/mutate.ts --file src/core/redact.ts --test test/verify/redact-prop.test.ts
//     --package <dir>     the package --file and --test are in (default packages/coding.sh)
//     --list              print the mutants and which ones would run, and run nothing
//     --max <n>           mutants to run (default 80)
//     --lines <a>-<b>     only mutants on lines a to b of the file, such as one function
//     --only <id,...>     run these mutants (ids as a run prints them, such as cmp-boundary@146:62)
//     --survivors <json>  run the mutants a saved run lists as survived
//     --jobs <n>          mutants at a time (default 4)
//     --timeout <s>       per mutant (default 5 times the run without a mutant, at least 60)
//     --json <path>       save the run: every mutant, the ones left out, and each result
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { removeSync } from "../src/core/remove.ts";

// ---------------------------------------------------------------- tokens

export interface Token {
  type: "id" | "num" | "str" | "tmpl" | "regex" | "punct";
  value: string;
  start: number;
  end: number;
}

const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
/** Words after which a `/` starts a regular expression rather than a division. */
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const ID_START = /[A-Za-z_$\u0080-\uffff]/;
const ID_PART = /[\w$\u0080-\uffff]/;

function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.type === "id") return BEFORE_REGEX.has(prev.value);
  if (prev.type === "punct") return ![")", "]", "++", "--"].includes(prev.value);
  // A template part that ends with `${` starts an expression.
  return prev.type === "tmpl" && prev.value.endsWith("${");
}

/** The end of a regular expression literal that starts at `i`, or -1 when a line ends first (a division, then). */
function regexEnd(js: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < js.length; j++) {
    const c = js[j];
    if (c === "\n" || c === "\r") return -1;
    if (c === "\\") j++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "/") {
      let k = j + 1;
      while (k < js.length && /[a-z]/i.test(js[k] ?? "")) k++;
      return k;
    }
  }
  return -1;
}

function numberEnd(js: string, i: number): number {
  let j = i;
  const at = (k: number): string => js[k] ?? "";
  if (at(i) === "0" && /[xob]/i.test(at(i + 1))) {
    j = i + 2;
    while (/[0-9a-f_]/i.test(at(j))) j++;
  } else {
    while (/[0-9_]/.test(at(j))) j++;
    if (at(j) === ".") {
      j++;
      while (/[0-9_]/.test(at(j))) j++;
    }
    if (/e/i.test(at(j)) && /[0-9+-]/.test(at(j + 1))) {
      j += 2;
      while (/[0-9_]/.test(at(j))) j++;
    }
  }
  if (at(j) === "n") j++;
  return j;
}

/** The tokens of JavaScript, without comments and white space. A template's text parts are `tmpl` tokens. */
export function tokenize(js: string): Token[] {
  const out: Token[] = [];
  const braces: ("{" | "${")[] = [];
  const push = (type: Token["type"], start: number, end: number): void => void out.push({ type, value: js.slice(start, end), start, end });
  // Template text from `i` to its end: past the closing backquote, or past a `${`.
  const template = (from: number, i: number): number => {
    for (let j = i; j < js.length; j++) {
      const c = js[j];
      if (c === "\\") j++;
      else if (c === "`") {
        push("tmpl", from, j + 1);
        return j + 1;
      } else if (c === "$" && js[j + 1] === "{") {
        push("tmpl", from, j + 2);
        braces.push("${");
        return j + 2;
      }
    }
    throw new SyntaxError(`a template at offset ${from} does not end`);
  };
  let i = 0;
  while (i < js.length) {
    const c = js[i] ?? "";
    const d = js[i + 1] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "/" && d === "/") {
      const e = js.indexOf("\n", i);
      i = e < 0 ? js.length : e;
    } else if (c === "/" && d === "*") {
      const e = js.indexOf("*/", i + 2);
      if (e < 0) throw new SyntaxError(`a comment at offset ${i} does not end`);
      i = e + 2;
    } else if (c === "#" && d === "!" && i === 0) {
      const e = js.indexOf("\n");
      i = e < 0 ? js.length : e;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < js.length && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      push("str", i, j + 1);
      i = j + 1;
    } else if (c === "`") i = template(i, i + 1);
    else if (c === "}" && braces.at(-1) === "${") {
      braces.pop();
      i = template(i, i + 1);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d))) {
      const e = numberEnd(js, i);
      push("num", i, e);
      i = e;
    } else if (ID_START.test(c) || (c === "#" && ID_START.test(d))) {
      let j = i + 1;
      while (j < js.length && ID_PART.test(js[j] ?? "")) j++;
      push("id", i, j);
      i = j;
    } else {
      const e = c === "/" && regexAllowed(out.at(-1)) ? regexEnd(js, i) : -1;
      if (e > 0) {
        push("regex", i, e);
        i = e;
        continue;
      }
      const p = PUNCT.find((x) => js.startsWith(x, i) && !(x === "?." && /[0-9]/.test(js[i + 2] ?? ""))) ?? c;
      if (p === "{") braces.push("{");
      else if (p === "}") braces.pop();
      push("punct", i, i + p.length);
      i += p.length;
    }
  }
  return out;
}

/** For each bracket token, the index of its partner; -1 for every other token. */
export function matchBrackets(tokens: readonly Token[]): number[] {
  const match = new Array<number>(tokens.length).fill(-1);
  const open: number[] = [];
  tokens.forEach((t, i) => {
    if (t.type !== "punct") return;
    if (t.value === "(" || t.value === "[" || t.value === "{") open.push(i);
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      const o = open.pop();
      if (o === undefined) throw new SyntaxError(`an unmatched ${t.value} at offset ${t.start}`);
      match[o] = i;
      match[i] = o;
    }
  });
  if (open.length) throw new SyntaxError(`an unclosed bracket at offset ${tokens[open.at(-1) ?? 0]?.start}`);
  return match;
}

// ---------------------------------------------------------------- blocks and statements

/** What a `{` opens: a block of statements, a function body (also a block), an object or pattern, or a class body. */
type BraceKind = "block" | "body" | "object" | "class";

const CONTROL = new Set(["if", "while", "for", "with", "catch", "switch"]);
const DECLARATIONS = new Set(["const", "let", "var", "function", "class", "import", "export", "using"]);

interface Code {
  source: string;
  tokens: Token[];
  match: number[];
  kinds: Map<number, BraceKind>;
}

function read(source: string): Code {
  const js = stripTypeScriptTypes(source);
  const tokens = tokenize(js);
  const match = matchBrackets(tokens);
  const code: Code = { source, tokens, match, kinds: classifyBraces(tokens, match) };
  // A { where a statement starts is a block: after a case label, the token before it alone reads as an object.
  const work = [...code.kinds].filter(([, k]) => k === "block" || k === "body").map(([i]) => i);
  for (let open = work.pop(); open !== undefined; open = work.pop()) {
    for (const s of statementsIn(code, open)) {
      if (s.kind !== "block" || code.kinds.get(s.start) !== "object") continue;
      code.kinds.set(s.start, "block");
      work.push(s.start);
    }
  }
  return code;
}

const val = (c: Code, i: number): string => c.tokens[i]?.value ?? "";
const isWord = (c: Code, i: number, w: string): boolean => c.tokens[i]?.type === "id" && c.tokens[i]?.value === w && val(c, i - 1) !== "." && val(c, i - 1) !== "?.";

function classifyBraces(tokens: readonly Token[], match: readonly number[]): Map<number, BraceKind> {
  const c: Code = { source: "", tokens: [...tokens], match: [...match], kinds: new Map() };
  const kinds = c.kinds;
  // A class body is the first { after `class` at the same depth.
  tokens.forEach((t, i) => {
    if (!isWord(c, i, "class") || val(c, i + 1) === ":") return;
    for (let j = i + 1; j < tokens.length; j++) {
      const v = val(c, j);
      if (v === "{") {
        kinds.set(j, "class");
        return;
      }
      if (v === "(" || v === "[") j = match[j] ?? j;
      if (v === ";" || v === "}" || v === ")") return;
    }
  });
  tokens.forEach((t, i) => {
    if (t.type !== "punct" || t.value !== "{" || kinds.has(i)) return;
    const p = tokens[i - 1];
    let kind: BraceKind = "object";
    if (!p) kind = "block";
    else if (p.type === "punct" && p.value === ")") {
      const o = match[i - 1] ?? -1;
      const before = o - 1;
      const control = CONTROL.has(val(c, before)) && tokens[before]?.type === "id" && val(c, before - 1) !== ".";
      kind = control || (val(c, before) === "await" && val(c, before - 1) === "for") ? "block" : "body";
    } else if (p.type === "punct" && p.value === "=>") kind = "body";
    else if (p.type === "id" && ["else", "try", "finally", "do", "catch"].includes(p.value)) kind = "block";
    else if (p.type === "punct" && (p.value === ";" || p.value === "}")) kind = "block";
    else if (p.type === "punct" && p.value === "{") kind = kinds.get(i - 1) === "block" || kinds.get(i - 1) === "body" ? "block" : "object";
    kinds.set(i, kind);
  });
  return kinds;
}

interface Statement {
  start: number;
  /** One past the last token. */
  end: number;
  kind: string;
}

/** The token after a statement body that starts at `j`: a block, or one statement. */
function bodyEnd(c: Code, j: number, limit: number): number {
  return val(c, j) === "{" ? (c.match[j] ?? j) + 1 : statementAt(c, j, limit).end;
}

function statementAt(c: Code, i: number, limit: number): Statement {
  const t = c.tokens[i];
  const v = t?.value ?? "";
  const word = t?.type === "id";
  const after = (j: number): number => (c.match[j] ?? j) + 1;
  if (v === ";") return { start: i, end: i + 1, kind: "empty" };
  if (t?.type === "punct" && v === "{") return { start: i, end: after(i), kind: "block" };
  if (word && (v === "case" || v === "default")) {
    let j = i + 1;
    while (j < limit && val(c, j) !== ":") j = ["(", "[", "{"].includes(val(c, j)) ? after(j) : j + 1;
    return { start: i, end: j + 1, kind: "label" };
  }
  if (word && v === "if") {
    let j = bodyEnd(c, after(i + 1), limit);
    if (isWord(c, j, "else")) j = bodyEnd(c, j + 1, limit);
    return { start: i, end: j, kind: "if" };
  }
  if (word && (v === "for" || v === "while" || v === "with")) {
    const k = val(c, i + 1) === "await" ? i + 2 : i + 1;
    return { start: i, end: bodyEnd(c, after(k), limit), kind: v };
  }
  if (word && v === "do") {
    let j = bodyEnd(c, i + 1, limit);
    if (isWord(c, j, "while")) j = after(j + 1);
    if (val(c, j) === ";") j++;
    return { start: i, end: j, kind: "do" };
  }
  if (word && v === "try") {
    let j = after(i + 1);
    if (isWord(c, j, "catch")) {
      j++;
      if (val(c, j) === "(") j = after(j);
      j = after(j);
    }
    if (isWord(c, j, "finally")) j = after(j + 1);
    return { start: i, end: j, kind: "try" };
  }
  if (word && v === "switch") return { start: i, end: after(after(i + 1)), kind: "switch" };
  if (word && (v === "function" || v === "class" || (v === "async" && val(c, i + 1) === "function"))) {
    let j = i + 1;
    while (j < limit && val(c, j) !== "{") j = val(c, j) === "(" || val(c, j) === "[" ? after(j) : j + 1;
    return { start: i, end: after(j), kind: "declaration" };
  }
  if (word && val(c, i + 1) === ":") return { start: i, end: i + 2, kind: "label" };
  let j = i;
  while (j < limit) {
    const u = val(c, j);
    if (u === ";") {
      j++;
      break;
    }
    if (u === "}") break;
    j = u === "(" || u === "[" || u === "{" ? after(j) : j + 1;
  }
  const kind = word && DECLARATIONS.has(v) ? "declaration" : word && ["return", "throw", "break", "continue"].includes(v) ? v : "expression";
  return { start: i, end: Math.max(j, i + 1), kind };
}

/** The statements directly inside the block that opens at token `open`. */
function statementsIn(c: Code, open: number): Statement[] {
  const close = c.match[open] ?? open;
  const out: Statement[] = [];
  for (let i = open + 1; i < close; ) {
    const s = statementAt(c, i, close);
    out.push(s);
    i = Math.max(s.end, i + 1);
  }
  return out;
}

// ---------------------------------------------------------------- mutants

export interface Mutant {
  /** `<op>@<line>:<column>`, plus `~n` when one place has more than one change of that kind. */
  id: string;
  op: string;
  line: number;
  column: number;
  /** The source text from `start` to `end` becomes `replacement`. */
  start: number;
  end: number;
  replacement: string;
}

export function applyMutant(source: string, m: Pick<Mutant, "start" | "end" | "replacement">): string {
  return source.slice(0, m.start) + m.replacement + source.slice(m.end);
}

/** Splits a type on its top-level `|`. */
function unionParts(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(type.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(type.slice(from).trim());
  return parts.filter(Boolean);
}

/** What `return-zero` returns for a declared return type: an expression, or "" for a plain `return;`. */
export function zeroOf(annotation: string, isAsync: boolean): string {
  let type = annotation.trim().replace(/^:/, "").trim();
  if (isAsync) type = /^Promise\s*<([\s\S]*)>$/.exec(type)?.[1]?.trim() ?? "";
  if (/^asserts\b/.test(type) || /^[\w$]+\s+is\s/.test(type)) return /^asserts\b/.test(type) ? "" : "false";
  const parts = unionParts(type);
  if (!parts.length || parts.some((p) => p === "void" || p === "undefined" || p === "never")) return "";
  if (parts.includes("null")) return "null";
  const t = parts[0] ?? "";
  if (t === "number") return "0";
  if (t === "bigint") return "0n";
  if (t === "string") return '""';
  if (t === "boolean") return "false";
  if (/^(true|false|-?\d[\d_.]*|"[^"]*"|'[^']*')$/.test(t)) return t;
  if (/\[\]$/.test(t) || /^(readonly\s|Array<|ReadonlyArray<)/.test(t)) return "[]";
  if (/^(Map|ReadonlyMap)</.test(t)) return "new Map()";
  if (/^(Set|ReadonlySet)</.test(t)) return "new Set()";
  if (/^(Record<|\{)/.test(t)) return "{}";
  const promised = /^Promise\s*<([\s\S]*)>$/.exec(t)?.[1];
  if (promised !== undefined) return `Promise.resolve(${zeroOf(promised, false) || "undefined"})`;
  return "";
}

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const NEGATE: Record<string, string> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===", "==": "!=", "!=": "==" };

/** Each change to the quantifiers of a regular expression body, as offsets into the body. */
export function quantifierChanges(body: string): { start: number; end: number; to: string }[] {
  const out: { start: number; end: number; to: string }[] = [];
  let inClass = false;
  let canQuantify = false;
  for (let i = 0; i < body.length; ) {
    const ch = body[i] ?? "";
    if (ch === "\\") {
      const n = body[i + 1] ?? "";
      if (/[pPu]/.test(n) && body[i + 2] === "{") i = body.indexOf("}", i) + 1 || body.length;
      else if (n === "k" && body[i + 2] === "<") i = body.indexOf(">", i) + 1 || body.length;
      else i += 2;
      canQuantify = !inClass;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
        canQuantify = true;
      }
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (ch === "(") {
      const prefix = /^\(\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>)?/.exec(body.slice(i))?.[0] ?? "(";
      i += prefix.length;
      canQuantify = false;
      continue;
    }
    const quant = canQuantify ? /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(body.slice(i)) : null;
    if (quant) {
      const len = quant[0].length;
      const lazy = body[i + len] === "?";
      const suffix = lazy ? "?" : "";
      const whole = { start: i, end: i + len + (lazy ? 1 : 0) };
      const q = quant[0];
      if (q === "*") out.push({ ...whole, to: `+${suffix}` });
      else if (q === "+") out.push({ ...whole, to: `*${suffix}` });
      else if (q === "?") out.push({ ...whole, to: "" });
      else {
        const lo = Number(quant[1]);
        const comma = quant[2] !== undefined;
        const hi = quant[3] ? Number(quant[3]) : undefined;
        const bounds: [number, number | undefined][] = [];
        if (!comma || hi === undefined) {
          if (lo > 0) bounds.push([lo - 1, hi]);
          bounds.push([lo + 1, hi]);
        } else {
          if (lo + 1 <= hi) bounds.push([lo + 1, hi]);
          if (lo > 0) bounds.push([lo - 1, hi]);
          if (hi - 1 >= lo) bounds.push([lo, hi - 1]);
          bounds.push([lo, hi + 1]);
        }
        for (const [a, b] of bounds) out.push({ ...whole, to: `{${a}${comma ? `,${b ?? ""}` : ""}}${suffix}` });
      }
      if (lazy) out.push({ start: i + len, end: i + len + 1, to: "" });
      i = whole.end;
      canQuantify = false;
      continue;
    }
    canQuantify = !(ch === "|" || ch === "^" || ch === "$");
    i++;
  }
  return out;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Every mutant of a TypeScript source that parses, in source order. */
export function mutantsOf(source: string): Mutant[] {
  const c = read(source);
  const { tokens, match, kinds } = c;
  const starts = lineStarts(source);
  const raw: Omit<Mutant, "id" | "line" | "column">[] = [];
  const add = (op: string, start: number, end: number, replacement: string): void => void raw.push({ op, start, end, replacement });

  // Conditions of if and while: wrapped by negate-cond, so a ! that starts one is not dropped too.
  const conditionStarts = new Set<number>();
  tokens.forEach((t, i) => {
    if (!(isWord(c, i, "if") || isWord(c, i, "while")) || val(c, i + 1) !== "(") return;
    const close = match[i + 1] ?? -1;
    const first = tokens[i + 2];
    const last = tokens[close - 1];
    if (!first || !last || close <= i + 2) return;
    conditionStarts.add(i + 2);
    add("negate-cond", first.start, last.end, `!(${source.slice(first.start, last.end)})`);
  });

  tokens.forEach((t, i) => {
    if (t.type === "punct") {
      if (BOUNDARY[t.value]) add("cmp-boundary", t.start, t.end, BOUNDARY[t.value] ?? t.value);
      if (NEGATE[t.value]) add("cmp-negate", t.start, t.end, NEGATE[t.value] ?? t.value);
      if (t.value === "&&" || t.value === "||") add("logic-swap", t.start, t.end, t.value === "&&" ? "||" : "&&");
      if (t.value === "!" && !conditionStarts.has(i)) add("drop-not", t.start, t.end, "");
    } else if (t.type === "num") {
      const text = t.value.replace(/_/g, "");
      if (/n$/.test(text)) {
        const v = BigInt(text.slice(0, -1));
        add("num-inc", t.start, t.end, `${v + 1n}n`);
        if (v > 0n) add("num-dec", t.start, t.end, `${v - 1n}n`);
      } else {
        const v = Number(text);
        if (!Number.isFinite(v)) return;
        const show = (x: number): string => (x < 0 ? `(${x})` : /^0x/i.test(text) ? `0x${x.toString(16)}` : String(x));
        add("num-inc", t.start, t.end, show(v + 1));
        add("num-dec", t.start, t.end, show(v - 1));
      }
    } else if (t.type === "regex") {
      const slash = t.value.lastIndexOf("/");
      const body = t.value.slice(1, slash);
      const flags = t.value.slice(slash + 1);
      for (const q of quantifierChanges(body)) {
        const next = body.slice(0, q.start) + q.to + body.slice(q.end);
        try {
          new RegExp(next, flags);
        } catch {
          continue;
        }
        add("regex-quant", t.start + 1 + q.start, t.start + 1 + q.end, q.to);
      }
    }
  });

  for (const [open, kind] of kinds) {
    if (kind !== "block" && kind !== "body") continue;
    for (const s of statementsIn(c, open)) {
      if (["empty", "label", "declaration"].includes(s.kind)) continue;
      const first = tokens[s.start];
      const last = tokens[s.end - 1];
      if (first && last) add("drop-stmt", first.start, last.end, "");
    }
    if (kind === "body" && val(c, open + 1) !== "}") {
      const zero = returnZero(c, open);
      if (zero !== undefined) add("return-zero", tokens[open]?.end ?? 0, tokens[open]?.end ?? 0, ` return${zero ? ` ${zero}` : ""};`);
    }
  }

  raw.sort((a, b) => a.start - b.start || a.end - b.end || a.op.localeCompare(b.op));
  const seen = new Map<string, number>();
  const out: Mutant[] = [];
  for (const r of raw) {
    const mutated = applyMutant(source, r);
    if (mutated === source) continue;
    try {
      stripTypeScriptTypes(mutated);
    } catch {
      continue;
    }
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= r.start) line++;
    const column = r.start - (starts[line] ?? 0) + 1;
    const base = `${r.op}@${line + 1}:${column}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ ...r, id: n === 1 ? base : `${base}~${n}`, line: line + 1, column });
  }
  return out;
}

/** The zero `return-zero` puts first in the function body that opens at `open`, or undefined to leave it be. */
function returnZero(c: Code, open: number): string | undefined {
  const { tokens, match, source } = c;
  const prev = open - 1;
  let paramsEnd: number;
  let headStart: number;
  let annotationEnd: number;
  if (val(c, prev) === "=>") {
    annotationEnd = tokens[prev]?.start ?? 0;
    if (val(c, prev - 1) === ")") {
      paramsEnd = prev - 1;
      headStart = match[paramsEnd] ?? paramsEnd;
    } else {
      paramsEnd = prev - 1;
      headStart = prev - 1;
    }
  } else if (val(c, prev) === ")") {
    paramsEnd = prev;
    headStart = match[prev] ?? prev;
    annotationEnd = tokens[open]?.start ?? 0;
  } else return undefined;
  const name = headStart - 1;
  if (val(c, name) === "constructor" || val(c, name) === "*" || val(c, name - 1) === "*") return undefined;
  if (isWord(c, name, "function") && val(c, name + 1) === "*") return undefined;
  const isSetter = isWord(c, name - 1, "set") && tokens[name]?.type === "id";
  const isAsync = [name - 1, name, name - 2].some((k) => isWord(c, k, "async")) || (val(c, prev) === "=>" && isWord(c, headStart - 1, "async"));
  if (isSetter) return "";
  const annotation = source.slice(tokens[paramsEnd]?.end ?? 0, annotationEnd);
  return zeroOf(annotation, isAsync);
}

/**
 * At most `max` of `all`, the same ones every time: each operator gets an equal share of the
 * budget (capped at its count, the rest shared out again), taken evenly spaced through the file.
 */
export function selectMutants<T extends { op: string; start: number }>(all: readonly T[], max: number): T[] {
  const groups = new Map<string, T[]>();
  for (const m of all) groups.set(m.op, [...(groups.get(m.op) ?? []), m]);
  const ops = [...groups.keys()].sort();
  const quota = new Map<string, number>(ops.map((op) => [op, 0]));
  let left = Math.min(max, all.length);
  for (let open = ops; left > 0 && open.length; ) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const op of open) {
      const have = quota.get(op) ?? 0;
      const take = Math.min(share, (groups.get(op)?.length ?? 0) - have, left);
      quota.set(op, have + take);
      left -= take;
      if (!left) break;
    }
    open = open.filter((op) => (quota.get(op) ?? 0) < (groups.get(op)?.length ?? 0));
  }
  const chosen: T[] = [];
  for (const op of ops) {
    const ms = groups.get(op) ?? [];
    const k = quota.get(op) ?? 0;
    for (let i = 0; i < k; i++) {
      const m = ms[Math.floor(((i + 0.5) * ms.length) / k)];
      if (m) chosen.push(m);
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- running

type Status = "killed" | "survived" | "timeout";

interface Outcome {
  status: Status;
  ms: number;
  /** The tests that passed, as the test runner counts them. */
  passed?: number;
  /** The end of the test output, for a run that failed. */
  tail?: string;
}

const running = new Set<ChildProcess>();
let stopping = false;

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
}

/** The environment of a test run: its own home and temp folder, no agent session, no built CLI. */
function testEnv(run: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_ENTRYPOINT", "CODING_SH_TEST_CLI", "CODING_SH_DEV_REAL_STORE", "NODE_TEST_CONTEXT"]) delete env[k];
  const home = join(run, "home");
  const dirs: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODING_SH_HOME: join(run, "coding.sh"),
    CLAUDE_CONFIG_DIR: join(run, "claude"),
    CODEX_HOME: join(run, "codex"),
    TMPDIR: join(run, "tmp"),
    TMP: join(run, "tmp"),
    TEMP: join(run, "tmp"),
  };
  for (const [k, dir] of Object.entries(dirs)) {
    mkdirSync(dir, { recursive: true });
    env[k] = dir;
  }
  return env;
}

async function runTests(cwd: string, tests: readonly string[], run: string, timeoutMs: number): Promise<Outcome> {
  removeSync(run);
  const env = testEnv(run);
  const t0 = performance.now();
  const child = spawn(process.execPath, ["--no-warnings", "--test", "--test-concurrency=1", ...tests], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  running.add(child);
  let out = "";
  const keep = (b: Buffer): void => {
    out += b.toString();
    if (out.length > 200_000) out = out.slice(-100_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killTree(child.pid);
  }, timeoutMs);
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.on("error", fail);
      child.on("close", (c) => done(c));
    });
    const ms = Math.round(performance.now() - t0);
    if (timedOut) return { status: "timeout", ms };
    // The summary line: `ℹ pass 12` from the spec reporter, `# pass 12` from tap.
    const passed = Number(/^(?:ℹ|#) pass (\d+)/m.exec(out)?.[1] ?? 0);
    if (code === 0) return { status: "survived", ms, passed };
    return { status: "killed", ms, passed, tail: failureOf(out) };
  } finally {
    clearTimeout(timer);
    running.delete(child);
    removeSync(run);
  }
}

/** The failing tests and the first error from a test run's output, at most a few hundred characters. */
function failureOf(out: string): string {
  const lines = out.split(/\r?\n/);
  const failing = lines.findIndex((l) => /failing tests:/.test(l));
  const from = failing >= 0 ? lines.slice(failing + 1) : lines.filter((l) => /✖|not ok|Error|assert/i.test(l));
  return from
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(0, 8)
    .join("\n")
    .slice(0, 800);
}

/** The line a mutant changes, before and after, cut to about 100 characters around the change. */
function showChange(source: string, m: Mutant): { before: string; after: string } {
  const lineStart = source.lastIndexOf("\n", m.start - 1) + 1;
  const lineEnd = source.indexOf("\n", m.end) < 0 ? source.length : source.indexOf("\n", m.end);
  const cut = (text: string, at: number): string => {
    const from = Math.max(0, at - 50);
    return `${from > 0 ? "…" : ""}${text.slice(from, from + 100).replace(/\s+/g, " ")}${from + 100 < text.length ? "…" : ""}`;
  };
  const before = source.slice(lineStart, lineEnd);
  const after = before.slice(0, m.start - lineStart) + m.replacement + before.slice(m.end - lineStart);
  return { before: cut(before, m.start - lineStart), after: cut(after, m.start - lineStart) };
}

function copyPackage(pkg: string, to: string): void {
  cpSync(pkg, to, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return name !== "node_modules" && name !== "dist" && name !== ".git";
    },
  });
}

function sha256(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

interface SavedRun {
  file: string;
  sourceSha256: string;
  tests: string[];
  results: (Mutant & Outcome)[];
}

const HELP = `mutate.ts --file <src file> --test <test file> [--test <test file>]... [--package dir]
  [--list] [--max n] [--lines a-b] [--only id,...] [--survivors run.json] [--jobs n] [--timeout s] [--json path]
--file and --test are relative to the package, packages/coding.sh unless --package names another.
See the header of scripts/mutate.ts.`;

/** The value of option `name` as a whole number of 1 or more, or undefined when it is not given. */
function wholeNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} takes a whole number of 1 or more, not ${value}`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      package: { type: "string" },
      file: { type: "string" },
      test: { type: "string", multiple: true },
      list: { type: "boolean" },
      lines: { type: "string" },
      max: { type: "string" },
      only: { type: "string" },
      survivors: { type: "string" },
      jobs: { type: "string" },
      timeout: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const pkg = values.package ? resolve(values.package) : resolve(fileURLToPath(new URL("..", import.meta.url)));
  const inPackage = (p: string): string => {
    const rel = relative(pkg, isAbsolute(p) ? p : resolve(pkg, p)).split("\\").join("/");
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(join(pkg, rel))) throw new Error(`${p} is not a file in ${pkg}`);
    return rel;
  };
  if (!values.file || (!values.list && !values.test?.length)) {
    console.error(HELP);
    return 2;
  }
  const file = inPackage(values.file);
  const tests = (values.test ?? []).map(inPackage);
  const original = readFileSync(join(pkg, file));
  const source = original.toString("utf8");
  const range = values.lines ? /^(\d+)-(\d+)$/.exec(values.lines) : undefined;
  if (range === null) throw new Error(`--lines takes <first>-<last>, such as 120-180, not ${values.lines}`);
  const all = mutantsOf(source).filter((m) => !range || (m.line >= Number(range[1]) && m.line <= Number(range[2])));
  let chosen: Mutant[];
  if (values.only || values.survivors) {
    const ids = new Set<string>(values.only ? values.only.split(",").map((s) => s.trim()) : []);
    if (values.survivors) {
      const saved = JSON.parse(readFileSync(values.survivors, "utf8")) as SavedRun;
      if (saved.file !== file || saved.sourceSha256 !== sha256(original)) throw new Error(`${values.survivors} is a run of another version of ${file}`);
      for (const r of saved.results) if (r.status === "survived") ids.add(r.id);
    }
    chosen = all.filter((m) => ids.has(m.id));
    const missing = [...ids].filter((id) => !chosen.some((m) => m.id === id));
    if (missing.length) throw new Error(`no such mutants: ${missing.join(", ")}`);
  } else chosen = selectMutants(all, wholeNumber("max", values.max) ?? 80);
  const chosenIds = new Set(chosen.map((m) => m.id));
  const left = all.filter((m) => !chosenIds.has(m.id));
  const byOp = (ms: readonly Mutant[]): string => {
    const counts = new Map<string, number>();
    for (const m of ms) counts.set(m.op, (counts.get(m.op) ?? 0) + 1);
    return [...counts].sort().map(([op, n]) => `${op} ${n}`).join(", ");
  };
  console.log(`${file}: ${all.length} mutants (${byOp(all)})`);
  console.log(`running ${chosen.length}: ${byOp(chosen)}; left out ${left.length}: ${byOp(left) || "none"}`);
  if (values.list) {
    for (const m of all) {
      const { before, after } = showChange(source, m);
      console.log(`${chosenIds.has(m.id) ? "*" : " "} ${m.id}\n    ${before}\n    ${after}`);
    }
    return 0;
  }

  const jobs = Math.min(wholeNumber("jobs", values.jobs) ?? 4, chosen.length || 1);
  const timeout = wholeNumber("timeout", values.timeout);
  const root = mkdtempSync(join(tmpdir(), "coding-sh-mutate-"));
  const copies: string[] = [];
  const results: (Mutant & Outcome)[] = [];
  const onSignal = (): void => {
    stopping = true;
    for (const child of running) if (child.pid) killTree(child.pid);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const started = performance.now();
  const elapsed = (): string => `${((performance.now() - started) / 1000).toFixed(1)} s`;
  try {
    for (let w = 0; w < jobs; w++) {
      const copy = join(root, `pkg${w}`);
      copyPackage(pkg, copy);
      copies.push(copy);
    }
    console.log(`copied the package ${jobs} times in ${elapsed()}`);
    const first = copies[0] ?? "";
    const base = await runTests(first, tests, join(root, "run0"), 30 * 60_000);
    if (base.status !== "survived") throw new Error(`the tests fail without a mutant:\n${base.tail ?? ""}`);
    if (!base.passed) throw new Error("the test files ran no tests");
    const timeoutMs = timeout ? timeout * 1000 : Math.max(60_000, 5 * base.ms);
    console.log(`without a mutant ${base.passed} tests pass in ${(base.ms / 1000).toFixed(1)} s; limit per mutant ${Math.round(timeoutMs / 1000)} s; ${jobs} at a time`);
    const queue = [...chosen];
    let done = 0;
    const failures: unknown[] = [];
    await Promise.all(
      copies.map(async (copy, w) => {
        const target = join(copy, file);
        try {
          for (;;) {
            const m = queue.shift();
            if (!m || stopping) return;
            if (!readFileSync(target).equals(original)) throw new Error(`${target} is not the original before ${m.id}`);
            writeFileSync(target, applyMutant(source, m));
            let outcome: Outcome;
            try {
              outcome = await runTests(copy, tests, join(root, `run${w}`), timeoutMs);
            } finally {
              writeFileSync(target, original);
              if (!readFileSync(target).equals(original)) throw new Error(`could not restore ${target} after ${m.id}`);
            }
            if (stopping) return;
            results.push({ ...m, ...outcome });
            done++;
            console.log(`[${done}/${chosen.length}] ${outcome.status.padEnd(8)} ${m.id} (${(outcome.ms / 1000).toFixed(1)} s, at ${elapsed()})`);
          }
        } catch (e) {
          // Stop the other jobs too; the copies are removed once every job has stopped.
          failures.push(e);
          stopping = true;
          for (const child of running) if (child.pid) killTree(child.pid);
        }
      }),
    );
    if (failures.length) throw failures[0];
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const copy of copies) {
      const target = join(copy, file);
      if (existsSync(target) && !readFileSync(target).equals(original)) console.error(`warning: ${target} differed from the original at the end; removing the copy`);
    }
    if (!readFileSync(join(pkg, file)).equals(original)) console.error(`warning: ${file} changed in the package during the run (not by this script, which never writes it)`);
    removeSync(root, { maxRetries: 10 });
    console.log(`removed the copies; ${elapsed()} in all`);
  }

  results.sort((a, b) => a.start - b.start);
  const ops = [...new Set(results.map((r) => r.op))].sort();
  const count = (rs: readonly Outcome[], s: Status): number => rs.filter((r) => r.status === s).length;
  const row = (name: string, rs: readonly Outcome[]): string =>
    `${name.padEnd(14)}${String(rs.length).padStart(5)}${String(count(rs, "killed")).padStart(8)}${String(count(rs, "survived")).padStart(10)}${String(count(rs, "timeout")).padStart(9)}`;
  console.log(`\n${"operator".padEnd(14)}${"run".padStart(5)}${"killed".padStart(8)}${"survived".padStart(10)}${"timeout".padStart(9)}`);
  for (const op of ops) console.log(row(op, results.filter((r) => r.op === op)));
  console.log(row("total", results));
  const detected = count(results, "killed") + count(results, "timeout");
  if (results.length) console.log(`kill rate ${((100 * detected) / results.length).toFixed(1)}% (killed or timed out, over mutants run)`);
  const survivors = results.filter((r) => r.status === "survived");
  if (survivors.length) console.log("\nsurvived:");
  for (const m of survivors) {
    const { before, after } = showChange(source, m);
    console.log(`  ${m.id}\n    - ${before}\n    + ${after}`);
  }
  if (values.json) {
    const saved: SavedRun & { left: Mutant[] } = { file, sourceSha256: sha256(original), tests, results, left };
    writeFileSync(values.json, `${JSON.stringify(saved, null, 2)}\n`);
  }
  if (stopping) {
    console.error("stopped: the results above are partial");
    return 130;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
