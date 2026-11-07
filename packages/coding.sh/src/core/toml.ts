// A small, strict TOML parser and serializer covering what coding.sh config
// files need: tables, [[arrays of tables]], dotted keys, basic/literal strings
// (single- and multi-line), integers (dec/hex/oct/bin), floats, booleans,
// arrays and inline tables. Date/time values are rejected with a clear error.
//
// Values are assigned with defineProperty so keys like "__proto__" become
// ordinary own properties instead of mutating prototypes.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  readonly line: number;
  readonly column: number;
  readonly file?: string;
  constructor(message: string, line: number, column: number, file?: string) {
    super(`${file ? `${file}:` : ""}${line}:${column}: ${message}`);
    this.name = "TomlError";
    this.line = line;
    this.column = column;
    this.file = file;
  }
}

function setOwn(obj: TomlTable, key: string, value: TomlValue): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

function isTable(v: unknown): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Parser {
  private pos = 0;
  readonly root: TomlTable = {};
  private current: TomlTable = this.root;
  // Bookkeeping for TOML's "define once" rules.
  private readonly headerTables = new WeakSet<TomlTable>();
  private readonly dottedTables = new WeakSet<TomlTable>();
  private readonly inlineTables = new WeakSet<TomlTable>();
  private readonly arraysOfTables = new WeakSet<TomlValue[]>();

  private readonly src: string;
  private readonly file?: string;

  constructor(src: string, file?: string) {
    this.src = src;
    this.file = file;
  }

  private fail(message: string, at = this.pos): never {
    // Line/column are derived from the offset only on error, keeping the hot path lean.
    let line = 1;
    let start = 0;
    for (let i = 0; i < at && i < this.src.length; i++) {
      if (this.src[i] === "\n") {
        line++;
        start = i + 1;
      }
    }
    throw new TomlError(message, line, at - start + 1, this.file);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private skipWs(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.pos < this.src.length && this.peek() !== "\n") {
      const c = this.src.charCodeAt(this.pos);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0d) || c === 0x7f) this.fail("control character in comment");
      this.pos++;
    }
  }

  private newline(): boolean {
    if (this.peek() === "\n") {
      this.pos++;
      return true;
    }
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.pos += 2;
      return true;
    }
    return false;
  }

  /** Whitespace, comments and newlines (inside arrays). */
  private skipAll(): void {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (!this.newline()) return;
    }
  }

  private endOfLine(): void {
    this.skipWs();
    this.skipComment();
    if (this.pos >= this.src.length) return;
    if (!this.newline()) this.fail(`expected end of line, found ${JSON.stringify(this.peek())}`);
  }

  parse(): TomlTable {
    if (this.src.charCodeAt(0) === 0xfeff) this.pos = 1;
    while (this.pos < this.src.length) {
      this.skipWs();
      this.skipComment();
      if (this.newline()) continue;
      if (this.pos >= this.src.length) break;
      if (this.peek() === "[") this.header();
      else this.keyValue(this.current);
      this.endOfLine();
    }
    return this.root;
  }

  // ------------------------------------------------------------------ keys

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"') {
        if (this.startsWith('"""')) this.fail("multi-line strings cannot be keys");
        parts.push(this.basicString());
      } else if (c === "'") {
        if (this.startsWith("'''")) this.fail("multi-line strings cannot be keys");
        parts.push(this.literalString());
      } else {
        const start = this.pos;
        while (BARE_KEY.test(this.peek())) this.pos++;
        if (start === this.pos) this.fail(c ? `invalid character ${JSON.stringify(c)} in key` : "expected a key");
        parts.push(this.src.slice(start, this.pos));
      }
      this.skipWs();
      if (this.peek() !== ".") return parts;
      this.pos++;
    }
  }

  // ------------------------------------------------------------------ tables

  private header(): void {
    const at = this.pos;
    const isArray = this.startsWith("[[");
    this.pos += isArray ? 2 : 1;
    const path = this.key();
    if (isArray) {
      if (!this.startsWith("]]")) this.fail("expected ]] to close array-of-tables header");
      this.pos += 2;
    } else {
      if (this.peek() !== "]") this.fail("expected ] to close table header");
      this.pos++;
    }
    const name = path.join(".");
    const parent = this.walk(this.root, path.slice(0, -1), at, "header");
    const last = path[path.length - 1]!;
    const existing = Object.hasOwn(parent, last) ? parent[last] : undefined;

    if (isArray) {
      let arr: TomlValue[];
      if (existing === undefined) {
        arr = [];
        this.arraysOfTables.add(arr);
        setOwn(parent, last, arr);
      } else if (Array.isArray(existing) && this.arraysOfTables.has(existing)) {
        arr = existing;
      } else {
        this.fail(`cannot define [[${name}]]: key already holds a ${Array.isArray(existing) ? "static array" : "value"}`, at);
      }
      const t: TomlTable = {};
      this.headerTables.add(t);
      arr.push(t);
      this.current = t;
      return;
    }

    if (existing === undefined) {
      const t: TomlTable = {};
      this.headerTables.add(t);
      setOwn(parent, last, t);
      this.current = t;
      return;
    }
    if (!isTable(existing)) this.fail(`cannot define table [${name}]: key already holds a value`, at);
    if (this.headerTables.has(existing) || this.dottedTables.has(existing) || this.inlineTables.has(existing)) {
      this.fail(`table [${name}] is defined more than once`, at);
    }
    // Created implicitly by a deeper header (e.g. [a.b] before [a]): now defined.
    this.headerTables.add(existing);
    this.current = existing;
  }

  /** Walks/creates intermediate tables for a header or a dotted key. */
  private walk(from: TomlTable, path: string[], at: number, mode: "header" | "dotted"): TomlTable {
    let t = from;
    for (const k of path) {
      const v = Object.hasOwn(t, k) ? t[k] : undefined;
      if (v === undefined) {
        const n: TomlTable = {};
        if (mode === "dotted") this.dottedTables.add(n);
        setOwn(t, k, n);
        t = n;
      } else if (Array.isArray(v)) {
        if (mode === "dotted" || !this.arraysOfTables.has(v)) this.fail(`key ${JSON.stringify(k)} is an array, not a table`, at);
        const lastEl = v[v.length - 1];
        if (!isTable(lastEl)) this.fail(`key ${JSON.stringify(k)} is not a table`, at);
        t = lastEl;
      } else if (isTable(v)) {
        if (this.inlineTables.has(v)) this.fail(`inline table ${JSON.stringify(k)} cannot be extended`, at);
        if (mode === "dotted" && this.headerTables.has(v)) this.fail(`table ${JSON.stringify(k)} was defined by a header and cannot be extended by a dotted key`, at);
        t = v;
      } else {
        this.fail(`key ${JSON.stringify(k)} already holds a value`, at);
      }
    }
    return t;
  }

  private keyValue(table: TomlTable): void {
    const at = this.pos;
    const path = this.key();
    if (this.peek() !== "=") this.fail(`expected = after key ${JSON.stringify(path.join("."))}`);
    this.pos++;
    this.skipWs();
    const value = this.value();
    const target = this.walk(table, path.slice(0, -1), at, "dotted");
    const last = path[path.length - 1]!;
    if (Object.hasOwn(target, last)) this.fail(`duplicate key ${JSON.stringify(path.join("."))}`, at);
    setOwn(target, last, value);
  }

  // ------------------------------------------------------------------ values

  private value(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.startsWith('"""') ? this.multiBasicString() : this.basicString();
    if (c === "'") return this.startsWith("'''") ? this.multiLiteralString() : this.literalString();
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    if (c === "" || c === "\n" || c === "\r" || c === "#") this.fail("expected a value");
    return this.scalar();
  }

  private scalar(): TomlValue {
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s,\]}#]/.test(this.peek())) this.pos++;
    const tok = this.src.slice(start, this.pos);
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^[+-]?inf$/.test(tok)) return tok.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(tok)) return NaN;
    if (/^\d{4}-\d{2}-\d{2}/.test(tok) || /^\d{2}:\d{2}/.test(tok)) this.fail("date/time values are not supported; use a string", start);
    const dec = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
    if (dec.test(tok)) return this.safeInt(Number(tok.replace(/_/g, "")), start);
    const prefixed = /^0([xob])([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)$/.exec(tok);
    if (prefixed) {
      const radix = prefixed[1] === "x" ? 16 : prefixed[1] === "o" ? 8 : 2;
      const digits = prefixed[2]!.replace(/_/g, "");
      const valid = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
      if (!valid.test(digits)) this.fail(`invalid number ${JSON.stringify(tok)}`, start);
      return this.safeInt(parseInt(digits, radix), start);
    }
    const float = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
    if (float.test(tok) && /[.eE]/.test(tok)) return Number(tok.replace(/_/g, ""));
    if (tok === "") this.fail("expected a value", start);
    if (/^[A-Za-z]/.test(tok)) this.fail(`invalid value ${JSON.stringify(tok)} (strings must be quoted)`, start);
    this.fail(`invalid value ${JSON.stringify(tok)}`, start);
  }

  private safeInt(n: number, at: number): number {
    if (!Number.isSafeInteger(n)) this.fail("integer is outside the safe range (±2^53-1)", at);
    return n;
  }

  private escape(): string {
    const at = this.pos;
    this.pos++; // backslash
    const c = this.peek();
    this.pos++;
    switch (c) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case '"': return '"';
      case "\\": return "\\";
      case "e": return "\u001b";
      case "u":
      case "U": {
        const len = c === "u" ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) this.fail(`invalid \\${c} escape`, at);
        this.pos += len;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail("escape is not a valid unicode scalar value", at);
        return String.fromCodePoint(cp);
      }
      default:
        this.fail(`invalid escape sequence \\${c}`, at);
    }
  }

  private checkControl(allowNewline: boolean): void {
    const c = this.src.charCodeAt(this.pos);
    if (c === 0x0a && allowNewline) return;
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      if (c === 0x0a || c === 0x0d) this.fail("unterminated string");
      this.fail("control characters must be escaped in strings");
    }
  }

  private basicString(): string {
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.fail("unterminated string");
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      this.checkControl(false);
      out += c;
      this.pos++;
    }
  }

  private literalString(): string {
    this.pos++;
    const start = this.pos;
    for (;;) {
      if (this.pos >= this.src.length) this.fail("unterminated string");
      if (this.peek() === "'") break;
      this.checkControl(false);
      this.pos++;
    }
    const s = this.src.slice(start, this.pos);
    this.pos++;
    return s;
  }

  private multilineStart(): void {
    this.pos += 3;
    // A newline immediately after the opening delimiter is trimmed.
    if (this.peek() === "\n") this.pos++;
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.pos += 2;
  }

  private multiBasicString(): string {
    const begin = this.pos;
    this.multilineStart();
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.fail("unterminated multi-line string", begin);
      if (this.startsWith('"""')) {
        // Up to two quotes may directly precede the closing delimiter.
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const c = this.peek();
      if (c === "\\") {
        // Line-ending backslash: trim the newline and following whitespace.
        let j = this.pos + 1;
        while (this.src[j] === " " || this.src[j] === "\t") j++;
        if (this.src[j] === "\n" || (this.src[j] === "\r" && this.src[j + 1] === "\n")) {
          while (/[ \t\r\n]/.test(this.src[j] ?? "")) j++;
          this.pos = j;
          continue;
        }
        out += this.escape();
        continue;
      }
      if (c === "\r" && this.peek(1) === "\n") {
        out += "\n";
        this.pos += 2;
        continue;
      }
      this.checkControl(true);
      out += c;
      this.pos++;
    }
  }

  private multiLiteralString(): string {
    const begin = this.pos;
    this.multilineStart();
    const start = this.pos;
    for (;;) {
      if (this.pos >= this.src.length) this.fail("unterminated multi-line string", begin);
      if (this.startsWith("'''")) {
        let extra = 0;
        while (this.peek(3 + extra) === "'" && extra < 2) extra++;
        const s = this.src.slice(start, this.pos + extra).replace(/\r\n/g, "\n");
        this.pos += 3 + extra;
        return s;
      }
      if (!(this.peek() === "\r" && this.peek(1) === "\n")) this.checkControl(true);
      this.pos++;
    }
  }

  private array(): TomlValue[] {
    this.pos++;
    const arr: TomlValue[] = [];
    for (;;) {
      this.skipAll();
      if (this.peek() === "]") {
        this.pos++;
        return arr;
      }
      if (this.pos >= this.src.length) this.fail("unterminated array");
      arr.push(this.value());
      this.skipAll();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === "]") {
        this.pos++;
        return arr;
      }
      this.fail("expected , or ] in array");
    }
  }

  private inlineTable(): TomlTable {
    this.pos++;
    const t: TomlTable = {};
    this.skipWs();
    if (this.peek() === "}") {
      this.pos++;
      this.inlineTables.add(t);
      return t;
    }
    for (;;) {
      this.skipWs();
      if (this.peek() === "\n" || this.peek() === "\r") this.fail("inline tables must be on a single line");
      this.keyValue(t);
      this.skipWs();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWs();
        if (this.peek() === "}") this.fail("trailing comma is not allowed in an inline table");
        continue;
      }
      if (this.peek() === "}") {
        this.pos++;
        this.inlineTables.add(t);
        markInline(t, this.inlineTables);
        return t;
      }
      this.fail("expected , or } in inline table");
    }
  }
}

/** Nested tables created by dotted keys inside an inline table are sealed too. */
function markInline(t: TomlTable, set: WeakSet<TomlTable>): void {
  for (const v of Object.values(t)) {
    if (isTable(v)) {
      set.add(v);
      markInline(v, set);
    }
  }
}

/** Parses TOML text. Throws TomlError (with line/column) on invalid input. */
export function parseToml(src: string, file?: string): TomlTable {
  return new Parser(src, file).parse();
}

// ---------------------------------------------------------------- serializer

function quoteKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : quoteString(k);
}

function quoteString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function inlineValue(v: unknown, path: string): string {
  if (typeof v === "string") return quoteString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    if (Number.isInteger(v)) {
      if (!Number.isSafeInteger(v)) return v.toExponential().replace("e+", "e");
      return String(v);
    }
    return String(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map((x, i) => {
      if (x === null || x === undefined) throw new TypeError(`cannot serialize ${String(x)} in array at ${path}[${i}]`);
      return inlineValue(x, `${path}[${i}]`);
    }).join(", ")}]`;
  }
  if (isPlainObject(v)) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${quoteKey(k)} = ${inlineValue(x, `${path}.${k}`)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  throw new TypeError(`cannot serialize ${typeof v} at ${path || "<root>"} as TOML`);
}

function isArrayOfTables(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
}

function emitTable(obj: Record<string, unknown>, path: string[], out: string[], header: "table" | "array" | "none"): void {
  const scalars: [string, unknown][] = [];
  const tables: [string, Record<string, unknown>][] = [];
  const arrays: [string, Record<string, unknown>[]][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (isArrayOfTables(v)) arrays.push([k, v]);
    else if (isPlainObject(v)) tables.push([k, v]);
    else scalars.push([k, v]);
  }
  const name = path.map(quoteKey).join(".");
  // Headers are only needed when the table holds values directly, is empty,
  // or is an array element; otherwise children headers define it implicitly.
  const needsHeader = header === "array" || (header === "table" && (scalars.length > 0 || (tables.length === 0 && arrays.length === 0)));
  if (needsHeader) {
    if (out.length) out.push("");
    out.push(header === "array" ? `[[${name}]]` : `[${name}]`);
  }
  for (const [k, v] of scalars) out.push(`${quoteKey(k)} = ${inlineValue(v, [...path, k].join("."))}`);
  for (const [k, v] of tables) emitTable(v, [...path, k], out, "table");
  for (const [k, list] of arrays) for (const el of list) emitTable(el, [...path, k], out, "array");
}

/** Serializes a plain object to TOML. null/undefined values are omitted (TOML has no null). */
export function stringifyToml(obj: Record<string, unknown>): string {
  if (!isPlainObject(obj)) throw new TypeError("stringifyToml expects a plain object");
  const out: string[] = [];
  emitTable(obj, [], out, "none");
  return out.length ? out.join("\n") + "\n" : "";
}
