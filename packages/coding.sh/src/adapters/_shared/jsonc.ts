// JSON with comments (JSONC), parsed and edited in place. Agent settings files
// (Gemini CLI settings.json, VS Code-style configs) often carry `//` and `/* */`
// comments and trailing commas. Re-serializing such a file with JSON.stringify
// throws the comments away for good, so edits here are text splices: only the
// members whose values change are touched, and every other byte stays as is.
//
// editJsonc(text, next) diffs the parsed text against `next` and applies the
// smallest set of member inserts, deletes and value replacements, re-parsing
// after each one. Objects are diffed key by key; arrays and scalars are
// replaced whole.

interface Span {
  start: number;
  end: number;
}

interface Member extends Span {
  key: string;
  keyStart: number;
  value: Node;
  /** Offset of the comma after the value, or -1. */
  comma: number;
}

type Node =
  | (Span & { kind: "object"; members: Member[] })
  | (Span & { kind: "array"; items: Node[] })
  | (Span & { kind: "scalar" });

export class JsoncError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "JsoncError";
    this.offset = offset;
  }
}

class Parser {
  readonly s: string;
  i: number;
  constructor(s: string) {
    this.s = s;
    this.i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  fail(what: string): never {
    const before = this.s.slice(0, this.i);
    const line = before.split("\n").length;
    const col = this.i - before.lastIndexOf("\n");
    throw new JsoncError(`${what} at line ${line} column ${col}`, this.i);
  }

  /** Skips whitespace and comments. */
  ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "/" && s[this.i + 1] === "/") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("Unterminated comment");
        this.i = end + 2;
      } else return;
    }
  }

  value(): [Node, unknown] {
    this.ws();
    const s = this.s;
    const start = this.i;
    const c = s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') {
      const v = this.string();
      return [{ kind: "scalar", start, end: this.i }, v];
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(this.i, this.i + 64));
    if (!m || /[A-Za-z0-9_$]/.test(s[this.i + m[0].length] ?? "")) this.fail(c === undefined ? "Unexpected end of input" : `Unexpected token ${JSON.stringify(c)}`);
    this.i += m[0].length;
    return [{ kind: "scalar", start, end: this.i }, JSON.parse(m[0]) as unknown];
  }

  string(): string {
    const s = this.s;
    const start = this.i;
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === "\\") this.i += 2;
      else if (c === '"') {
        this.i++;
        try {
          return JSON.parse(s.slice(start, this.i)) as string;
        } catch {
          this.i = start;
          this.fail("Bad string");
        }
      } else if (c === "\n") break;
      else this.i++;
    }
    this.i = start;
    return this.fail("Unterminated string");
  }

  object(): [Node, Record<string, unknown>] {
    const start = this.i++;
    const members: Member[] = [];
    const value: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") break;
      if (this.s[this.i] !== '"') this.fail("Expected property name or '}'");
      const keyStart = this.i;
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ":") this.fail("Expected ':'");
      this.i++;
      const [node, v] = this.value();
      Object.defineProperty(value, key, { value: v, enumerable: true, writable: true, configurable: true });
      const m: Member = { key, keyStart, start: keyStart, end: node.end, value: node, comma: -1 };
      members.push(m);
      this.ws();
      if (this.s[this.i] === ",") {
        m.comma = this.i++;
        continue;
      }
      if (this.s[this.i] === "}") break;
      this.fail("Expected ',' or '}'");
    }
    this.i++;
    return [{ kind: "object", start, end: this.i, members }, value];
  }

  array(): [Node, unknown[]] {
    const start = this.i++;
    const items: Node[] = [];
    const value: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") break;
      const [node, v] = this.value();
      items.push(node);
      value.push(v);
      this.ws();
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "]") break;
      this.fail("Expected ',' or ']'");
    }
    this.i++;
    return [{ kind: "array", start, end: this.i, items }, value];
  }
}

function parseTree(text: string): { node: Node | undefined; value: unknown } {
  const p = new Parser(text);
  p.ws();
  if (p.i >= text.length) return { node: undefined, value: undefined };
  const [node, value] = p.value();
  p.ws();
  if (p.i < text.length) p.fail("Unexpected content after the top-level value");
  return { node, value };
}

/** Parses JSONC (comments, trailing commas, a BOM). Empty text → {}. Throws JsoncError on bad input. */
export function parseJsonc(text: string): unknown {
  const { node, value } = parseTree(text);
  return node === undefined ? {} : value;
}

// ---------------------------------------------------------------- editing

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isPlain(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** True when two JSON values are equal (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

type Op = { op: "set"; path: string[]; value: unknown } | { op: "delete"; path: string[] };

function diff(before: unknown, after: unknown, path: string[], ops: Op[]): void {
  if (jsonEqual(before, after)) return;
  if (isPlain(before) && isPlain(after)) {
    for (const k of Object.keys(before)) if (!Object.hasOwn(after, k) || after[k] === undefined) ops.push({ op: "delete", path: [...path, k] });
    for (const [k, v] of Object.entries(after)) {
      if (v === undefined) continue;
      if (Object.hasOwn(before, k)) diff(before[k], v, [...path, k], ops);
      else ops.push({ op: "set", path: [...path, k], value: v });
    }
    return;
  }
  ops.push({ op: "set", path, value: after });
}

function lineStart(s: string, i: number): number {
  return s.lastIndexOf("\n", i - 1) + 1;
}

function indentAt(s: string, i: number): string {
  const ls = lineStart(s, i);
  return /^[ \t]*/.exec(s.slice(ls))![0];
}

/** The indent unit of a JSON text (first indented line), default two spaces. */
function indentUnit(s: string): string {
  const m = /\n([ \t]+)\S/.exec(s);
  if (!m) return "  ";
  return m[1]!.startsWith("\t") ? "\t" : m[1]!;
}

/** True when the object/array is laid out over several lines. */
const multiline = (s: string, n: Span) => s.slice(n.start, n.end).includes("\n");

function compact(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(compact).join(", ")}]`;
  if (isPlain(v)) {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function serialize(v: unknown, baseIndent: string, unit: string, multi: boolean): string {
  if (!multi) return compact(v);
  return JSON.stringify(v, null, unit).replace(/\n/g, `\n${baseIndent}`);
}

const isComplex = (v: unknown) => (isPlain(v) && Object.keys(v).length > 0) || (Array.isArray(v) && v.length > 0);

function find(node: Node, path: string[]): { parent: Node & { kind: "object" }; member: Member | undefined } | undefined {
  let cur = node;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur.kind !== "object") return undefined;
    const m = cur.members.findLast((x) => x.key === path[i]);
    if (!m) return undefined;
    cur = m.value;
  }
  if (cur.kind !== "object") return undefined;
  return { parent: cur, member: cur.members.findLast((x) => x.key === path[path.length - 1]) };
}

/** Where the line holding offset `i` ends if only spaces or a `//` comment follow; else `i`. */
function restOfLine(s: string, i: number): number {
  let j = i;
  while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
  if (s[j] === "/" && s[j + 1] === "/") while (j < s.length && s[j] !== "\n") j++;
  if (j >= s.length || s[j] === "\n" || s[j] === "\r") return j;
  return i;
}

function splice(s: string, start: number, end: number, text: string): string {
  return s.slice(0, start) + text + s.slice(end);
}

function applyOp(s: string, op: Op): string {
  const { node } = parseTree(s);
  if (!node) throw new JsoncError("empty document", 0);
  const unit = indentUnit(s);
  if (op.path.length === 0) {
    if (op.op === "delete") throw new JsoncError("cannot delete the top-level value", 0);
    return splice(s, node.start, node.end, serialize(op.value, indentAt(s, node.start), unit, node.kind === "scalar" || multiline(s, node)));
  }
  const loc = find(node, op.path);
  if (!loc) throw new JsoncError(`no object at ${op.path.slice(0, -1).join(".") || "top level"}`, 0);
  const { parent, member } = loc;
  const multi = multiline(s, parent) || (parent.members.length === 0 && s.includes("\n"));

  if (op.op === "set" && member) {
    const v = member.value;
    // An object or array keeps its own layout; a scalar turned into one follows its parent's.
    const m = v.kind === "scalar" ? multi && isComplex(op.value) : multiline(s, v);
    return splice(s, v.start, v.end, serialize(op.value, indentAt(s, member.keyStart), unit, m));
  }

  if (op.op === "delete") return deleteMember(s, op.path, parent, member);

  // Insert a new member at the end of `parent`.
  const key = JSON.stringify(op.path[op.path.length - 1]);
  const last = parent.members.at(-1);
  if (!last) {
    const inner = s.slice(parent.start + 1, parent.end - 1);
    if (!multi) return splice(s, parent.start + 1, parent.end - 1, `${key}: ${compact(op.value)}${inner.trim() ? ` ${inner.trim()}` : ""}`);
    const base = indentAt(s, parent.start);
    const ind = base + unit;
    const text = `${key}: ${serialize(op.value, ind, unit, true)}`;
    if (!inner.trim()) return splice(s, parent.start + 1, parent.end - 1, `\n${ind}${text}\n${base}`);
    return splice(s, parent.start + 1, parent.start + 1, `\n${ind}${text}`);
  }
  const trailing = last.comma >= 0;
  const afterLast = trailing ? last.comma + 1 : last.end;
  if (!multi) return splice(s, afterLast, afterLast, `${trailing ? " " : ", "}${key}: ${compact(op.value)}${trailing ? "," : ""}`);
  const ind = /^[ \t]*$/.test(s.slice(lineStart(s, last.keyStart), last.keyStart)) ? indentAt(s, last.keyStart) : indentAt(s, parent.start) + unit;
  const text = `${key}: ${serialize(op.value, ind, unit, true)}`;
  const eol = restOfLine(s, afterLast);
  if (eol === afterLast && eol < s.length && s[eol] !== "\n" && s[eol] !== "\r") {
    // Something else follows on the same line (e.g. `"a": 1 }`): insert right there.
    return splice(s, afterLast, afterLast, `${trailing ? "" : ","}\n${ind}${text}${trailing ? "," : ""}`);
  }
  // After the rest of the line (a `//` comment stays with its member). The
  // file's trailing-comma style is kept; a missing comma goes right after the value.
  let out = splice(s, eol, eol, `\n${ind}${text}${trailing ? "," : ""}`);
  if (!trailing) out = splice(out, last.end, last.end, ",");
  return out;
}

function deleteMember(s: string, path: string[], parent: Node & { kind: "object" }, member: Member | undefined): string {
  if (!member) return s;
  const idx = parent.members.indexOf(member);
  const ls = lineStart(s, member.keyStart);
  let start = member.keyStart;
  let end = member.comma >= 0 ? member.comma + 1 : member.end;
  const eol = restOfLine(s, end);
  const lineClean = eol >= s.length || s[eol] === "\n" || s[eol] === "\r";
  if (/^[ \t]*$/.test(s.slice(ls, member.keyStart)) && lineClean) {
    // The member owns its line(s): remove them whole, with a trailing `//` comment.
    start = ls;
    end = eol >= s.length ? eol : eol + (s[eol] === "\r" && s[eol + 1] === "\n" ? 2 : 1);
  } else {
    while (s[end] === " " || s[end] === "\t") end++;
  }
  let out = splice(s, start, end, "");
  // The last member had no comma of its own: drop the one before it.
  if (member.comma < 0 && idx > 0) {
    const prev = parent.members[idx - 1]!;
    if (prev.comma >= 0) out = splice(out, prev.comma, prev.comma + 1, "");
  }
  // An object left with nothing but whitespace collapses to {}.
  const { node: again } = parseTree(out);
  const p2 = again && find(again, path)?.parent;
  if (p2 && p2.members.length === 0 && /^\{\s*\}$/.test(out.slice(p2.start, p2.end))) out = splice(out, p2.start, p2.end, "{}");
  return out;
}

/**
 * Rewrites JSONC `text` so it parses to `next`, changing only the members whose
 * values differ (comments, layout and untouched members stay byte-for-byte).
 * Empty text gets a fresh two-space document.
 */
export function editJsonc(text: string, next: unknown): string {
  const { node, value } = parseTree(text);
  if (node === undefined) return `${JSON.stringify(next, null, 2)}\n`;
  const ops: Op[] = [];
  diff(value, next, [], ops);
  let out = text;
  for (const op of ops) out = applyOp(out, op);
  const check = parseJsonc(out);
  if (!jsonEqual(check, next)) throw new JsoncError("edit did not produce the expected value", 0);
  return out;
}
