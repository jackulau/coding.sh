// A small JSONPath subset: `$`, `.key`, `['key']` / `["key"]`, `[0]`, `[-1]`,
// `[*]` / `.*` wildcards, and `..key` recursive descent. Enough to point a
// grader at one field of an agent's structured output.

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "wild" } | { kind: "descend"; key: string };

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathError";
  }
}

export function parseJsonPath(path: string): Segment[] {
  const p = path.trim();
  let i = 0;
  if (p[0] === "$") i = 1;
  const segs: Segment[] = [];
  const ident = /^[A-Za-z_$][\w$-]*/;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "." && p[i + 1] === ".") {
      const m = ident.exec(p.slice(i + 2));
      if (!m) throw new JsonPathError(`expected a key after ".." at ${i} in ${path}`);
      segs.push({ kind: "descend", key: m[0] });
      i += 2 + m[0].length;
    } else if (ch === ".") {
      if (p[i + 1] === "*") {
        segs.push({ kind: "wild" });
        i += 2;
        continue;
      }
      const m = ident.exec(p.slice(i + 1));
      if (!m) throw new JsonPathError(`expected a key after "." at ${i} in ${path}`);
      segs.push({ kind: "key", key: m[0] });
      i += 1 + m[0].length;
    } else if (ch === "[") {
      const close = findClose(p, i);
      const body = p.slice(i + 1, close).trim();
      if (body === "*") segs.push({ kind: "wild" });
      else if (/^-?\d+$/.test(body)) segs.push({ kind: "index", index: Number(body) });
      else if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) {
        const q = body[0] as string;
        segs.push({ kind: "key", key: body.slice(1, -1).replaceAll(`\\${q}`, q).replaceAll("\\\\", "\\") });
      } else throw new JsonPathError(`unsupported selector [${body}] in ${path}`);
      i = close + 1;
    } else if (i === 0 && ident.test(p)) {
      // Bare "a.b" (no leading $) is accepted for convenience.
      const m = ident.exec(p) as RegExpExecArray;
      segs.push({ kind: "key", key: m[0] });
      i = m[0].length;
    } else {
      throw new JsonPathError(`unexpected ${JSON.stringify(ch)} at ${i} in ${path}`);
    }
  }
  return segs;
}

function findClose(p: string, open: number): number {
  let quote: string | undefined;
  for (let j = open + 1; j < p.length; j++) {
    const c = p[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "]") return j;
  }
  throw new JsonPathError(`unterminated [ in ${p}`);
}

function children(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === "object") return Object.values(v);
  return [];
}

function descend(v: unknown, key: string, out: unknown[]): void {
  if (v === null || typeof v !== "object") return;
  if (!Array.isArray(v) && Object.hasOwn(v, key)) out.push((v as Record<string, unknown>)[key]);
  for (const c of children(v)) descend(c, key, out);
}

/** All values the path selects (empty when nothing matches). */
export function queryJsonPath(value: unknown, path: string): unknown[] {
  let cur: unknown[] = [value];
  for (const seg of parseJsonPath(path)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (seg.kind === "key") {
        if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, seg.key)) next.push((v as Record<string, unknown>)[seg.key]);
      } else if (seg.kind === "index") {
        if (Array.isArray(v)) {
          const i = seg.index < 0 ? v.length + seg.index : seg.index;
          if (i >= 0 && i < v.length) next.push(v[i]);
        }
      } else if (seg.kind === "wild") next.push(...children(v));
      else descend(v, seg.key, next);
    }
    cur = next;
  }
  return cur;
}
