// Text-level TOML edits that preserve the user's comments and formatting.
// We never re-serialize a user's TOML file: we add/remove marked blocks and
// marked single lines, then validate the result with the strict parser.
import { parseToml } from "../../core/toml.ts";

const BEGIN = (id: string) => `# >>> coding.sh:${id} (managed by coding.sh; remove with \`coding.sh uninstall\`)`;
const END = (id: string) => `# <<< coding.sh:${id}`;
const LINE_TAG = "# coding.sh";

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function blockRange(lines: string[], id: string): [number, number] | undefined {
  const b = BEGIN(id).split(" (")[0]!;
  const start = lines.findIndex((l) => l.trim().startsWith(b));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.trim() === END(id));
  return end < 0 ? undefined : [start, end];
}

/** Throws when `text` is not valid TOML (so a bad edit is never written). */
export function assertValidToml(text: string, file?: string): void {
  parseToml(text, file);
}

/**
 * Insert or replace the marked block `id`. A block of top-level keys goes before
 * the first table header (appended after a table it would silently become part
 * of that table); a block that starts with a table header is appended.
 */
export function upsertTomlBlock(text: string | undefined, id: string, body: string): string {
  const src = text ?? "";
  const nl = eol(src);
  const lines = src.split(/\r?\n/);
  const block = [BEGIN(id), ...body.replace(/\s+$/, "").split(/\r?\n/), END(id)];
  const range = blockRange(lines, id);
  let out: string[];
  if (range) {
    out = [...lines.slice(0, range[0]), ...block, ...lines.slice(range[1] + 1)];
  } else if (!/^\s*\[/.test(body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#")) ?? "[") && firstHeader(lines) !== undefined) {
    const h = firstHeader(lines)!;
    out = [...lines.slice(0, h), ...block, "", ...lines.slice(h)];
  } else {
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
    out = trimmed.length ? [...trimmed, "", ...block, ""] : [...block, ""];
  }
  return out.join(nl);
}

/** Remove the marked block `id` (and one blank line before it). */
export function removeTomlBlock(text: string, id: string): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  const range = blockRange(lines, id);
  if (!range) return text;
  let [s, e] = range;
  if (s > 0 && lines[s - 1] === "") s--;
  else if (lines[e + 1] === "" && e + 2 < lines.length) e++;
  return [...lines.slice(0, s), ...lines.slice(e + 1)].join(nl);
}

/** Index of the first table header line outside our marked blocks. */
function firstHeader(lines: string[]): number | undefined {
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("# >>> coding.sh:")) inBlock = true;
    else if (l.startsWith("# <<< coding.sh:")) inBlock = false;
    else if (!inBlock && /^\s*\[/.test(l)) return i;
  }
  return undefined;
}

export function hasTomlBlock(text: string | undefined, id: string): boolean {
  return !!text && blockRange(text.split(/\r?\n/), id) !== undefined;
}

function headerName(line: string): string | undefined {
  const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  return m ? m[1]!.replace(/\s*\.\s*/g, ".").replace(/"/g, "") : undefined;
}

function keyRe(key: string): RegExp {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:${k}|"${k}")\\s*=\\s*(.*?)\\s*$`);
}

function stripComment(v: string): string {
  // Values we manage are simple scalars; a '#' outside quotes starts a comment.
  let inStr: string | undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inStr) {
      if (c === inStr && v[i - 1] !== "\\") inStr = undefined;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === "#") return v.slice(0, i).trim();
  }
  return v.trim();
}

/**
 * Ensure `[table] key = value` (value is a TOML literal, e.g. "true").
 * Adds the key (tagged `# coding.sh`) to an existing table, or appends a
 * tagged table. A different existing value is replaced and remembered as
 * `# coding.sh (was: <old>)` so revertTomlKey can restore it.
 */
export function ensureTomlKey(text: string | undefined, table: string, key: string, value: string): string {
  const src = text ?? "";
  const nl = eol(src);
  const lines = src.split(/\r?\n/);
  let current: string | undefined = "";
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = headerName(line);
    if (h !== undefined) {
      current = h;
      if (h === table && !/^\s*\[\[/.test(line)) headerIdx = i;
      continue;
    }
    // Dotted form at top level: features.hooks = true
    const dotted = current === "" ? keyRe(`${table}.${key}`).exec(line) : null;
    const m = current === table ? keyRe(key).exec(line) : dotted;
    if (m) {
      const old = stripComment(m[1] ?? "");
      if (old === value) return src;
      const prefix = line.slice(0, line.indexOf("=") + 1);
      lines[i] = `${prefix} ${value} ${LINE_TAG} (was: ${old})`;
      return lines.join(nl);
    }
  }
  if (headerIdx >= 0) {
    lines.splice(headerIdx + 1, 0, `${key} = ${value} ${LINE_TAG}`);
    return lines.join(nl);
  }
  const trimmed = [...lines];
  while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
  const block = [`[${table}] ${LINE_TAG}`, `${key} = ${value} ${LINE_TAG}`];
  return (trimmed.length ? [...trimmed, "", ...block, ""] : [...block, ""]).join(nl);
}

/** Undo ensureTomlKey: restore `(was: …)` values, drop lines/tables we added. */
export function revertTomlKey(text: string, table: string, key: string): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  let current: string | undefined = "";
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = headerName(line);
    if (h !== undefined) {
      current = h;
      if (h === table && line.includes(LINE_TAG)) {
        // Our table: drop it if it holds nothing but our tagged key (and blanks).
        let j = i + 1;
        const body: string[] = [];
        while (j < lines.length && headerName(lines[j]!) === undefined) body.push(lines[j++]!);
        const meaningful = body.filter((l) => l.trim() !== "" && !(keyRe(key).test(l) && l.includes(LINE_TAG)));
        if (meaningful.length === 0) {
          if (out.length && out[out.length - 1] === "") out.pop();
          i = j - 1;
          if (j >= lines.length) out.push("");
          continue;
        }
        out.push(line.replace(/\s*# coding\.sh\s*$/, ""));
        continue;
      }
      out.push(line);
      continue;
    }
    const inTable = current === table ? keyRe(key).exec(line) : current === "" ? keyRe(`${table}.${key}`).exec(line) : null;
    if (inTable && line.includes(LINE_TAG)) {
      const was = /# coding\.sh \(was: (.*)\)\s*$/.exec(line);
      if (was) out.push(`${line.slice(0, line.indexOf("=") + 1)} ${was[1]}`);
      continue;
    }
    out.push(line);
  }
  return out.join(nl);
}
