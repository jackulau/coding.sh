// Gold-only coupling (Z-3): hidden tests that name something only the reference
// solution introduces, so a valid solution written differently fails.
//
// SessionFarmer (arXiv 2611.02440, RQ2) names this as the main cause of verifier
// false rejects: tests asserting private helper names or file paths that exist
// only in the gold patch. The check is deterministic and needs no model:
//
//   1. Gold-introduced names: identifiers defined on added non-test lines of the
//      reference patch (function X, const|let|var X =, class X, def X, func X,
//      fn X, export {X}, type X, interface X) that the start tree does not
//      already contain. Gold-introduced paths: non-test files the reference creates.
//   2. A test line that names one (word boundary; an import specifier matches a
//      new file when the file's path, extension dropped, ends with it) is a coupling, unless the instruction names it
//      too: then a valid solution is told to use that name.
//
// Names of 3 chars or less and a short stop list are skipped. Everything here is
// pure; the start-tree lookup is injected (startTreeLookup reads a directory).
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { VerifierCoupling } from "../core/types.ts";
import { safeJoin } from "../runner/fsutil.ts";
import { isTestPath, type TestFileText } from "./impossible.ts";
import { parsePatch } from "./patch.ts";

export type Coupling = VerifierCoupling;

/** What the start tree (before the reference) already has. */
export interface StartTree {
  /** The identifier occurs somewhere in the start tree. */
  has(name: string): boolean;
  /** The repo-relative path exists in the start tree. */
  exists(path: string): boolean;
}

export interface CouplingInput {
  testFiles: readonly TestFileText[];
  refPatch: string;
  startTree: StartTree;
  instruction: string;
}

const STOP = new Set(["test", "main", "init", "run", "handler", "self", "this", "args", "props", "default", "result", "value", "index"]);

/** Definition sites, each capturing the defined name (group 1), or a brace list for `export {…}`. */
const DEF_RES: RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\bdef\s+([A-Za-z_]\w*)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\bfn\s+([A-Za-z_]\w*)/g,
  /\btype\s+([A-Za-z_$][\w$]*)/g,
  /\binterface\s+([A-Za-z_$][\w$]*)/g,
];
const EXPORT_LIST_RE = /\bexport\s*\{([^}]*)\}/g;

const keep = (name: string) => name.replace(/^[_$]+/, "").length > 3 && !STOP.has(name.toLowerCase());

/** Names and new files the reference introduces (before the start-tree filter). */
export function goldCandidates(refPatch: string): { names: Map<string, string>; paths: string[] } {
  const names = new Map<string, string>();
  const paths: string[] = [];
  for (const f of parsePatch(refPatch).files) {
    const path = f.newPath;
    if (!path || isTestPath(path)) continue;
    if (f.oldPath === undefined) paths.push(path);
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (!l.startsWith("+")) continue;
        const line = l.slice(1);
        for (const re of DEF_RES) for (const m of line.matchAll(re)) if (keep(m[1]!) && !names.has(m[1]!)) names.set(m[1]!, path);
        for (const m of line.matchAll(EXPORT_LIST_RE)) {
          for (const part of m[1]!.split(",")) {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
            if (/^[A-Za-z_$][\w$]*$/.test(name) && keep(name) && !names.has(name)) names.set(name, path);
          }
        }
      }
    }
  }
  return { names, paths: paths.sort() };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Word-boundary match that treats `$` as a word char and ignores leading underscores. */
const wordRe = (name: string, leading = false) => new RegExp(`(?<![\\w$])${leading ? "_*" : ""}${esc(leading ? name.replace(/^_+/, "") : name)}(?![\\w$])`);
const stem = (p: string) => basename(p, extname(p));
const noExt = (p: string) => p.slice(0, p.length - extname(p).length);
/** `../src/acl/util.js` or `acl.util` names src/acl/util.ts: the path, extension dropped, ends with the specifier. */
function specNames(spec: string, path: string): boolean {
  const s = noExt(spec.replace(/^(?:\.{1,2}\/)+/, "").replace(/^@\//, ""));
  const p = noExt(path);
  return s.length > 0 && stem(s) === stem(p) && (p === s || p.endsWith(`/${s}`));
}

/** Module specifiers a test line imports: JS/TS import/require, Python import/from. */
function specifiers(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) out.push(m[1]!);
  const py = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
  if (py) out.push((py[1] ?? py[2]!).replace(/\./g, "/"));
  return out;
}

export function goldOnlyCoupling(input: CouplingInput): Coupling[] {
  const { names, paths } = goldCandidates(input.refPatch);
  const goldNames = [...names].filter(([n]) => !input.startTree.has(n));
  const goldPaths = paths.filter((p) => !input.startTree.exists(p) && stem(p).length > 3 && !STOP.has(stem(p).toLowerCase()));
  const named = (s: string, leading: boolean) => wordRe(s, leading).test(input.instruction);
  const nameRes = goldNames.filter(([n]) => !named(n, true)).map(([n, def]) => ({ name: n, def, re: wordRe(n) }));
  const pathTargets = goldPaths.filter((p) => !input.instruction.includes(p) && !named(stem(p), false));
  const out: Coupling[] = [];
  const seen = new Set<string>();
  const add = (c: Coupling) => {
    const k = `${c.testFile}\0${c.kind}\0${c.symbol}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const tf of input.testFiles) {
    for (const [i, line] of tf.text.split("\n").entries()) {
      for (const n of nameRes) if (n.re.test(line)) add({ testFile: tf.path, line: i + 1, symbol: n.name, kind: "identifier", definedIn: n.def });
      if (!pathTargets.length) continue;
      const specs = specifiers(line);
      for (const p of pathTargets) {
        if (line.includes(p) || specs.some((s) => specNames(s, p))) add({ testFile: tf.path, line: i + 1, symbol: p, kind: "path", definedIn: p });
      }
    }
  }
  return out;
}

/** One note per coupling, for validation output. */
export function couplingNote(c: Coupling): string {
  return c.kind === "identifier"
    ? `hidden test ${c.testFile}:${c.line} uses \`${c.symbol}\`, which only the reference defines (in ${c.definedIn}) and the instruction never names: valid solutions will fail`
    : `hidden test ${c.testFile}:${c.line} imports ${c.symbol}, a file only the reference creates and the instruction never names: valid solutions will fail`;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024;

/**
 * StartTree over a materialized directory: `exists` checks the path, `has` reports
 * whether any of `names` occurs in a text file (one bounded walk, done up front).
 */
export async function startTreeLookup(dir: string, names: Iterable<string>): Promise<StartTree> {
  const pending = new Set(names);
  const found = new Set<string>();
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    if (!pending.size || files >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!pending.size || files >= MAX_FILES) return;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      try {
        if ((await stat(abs)).size > MAX_BYTES) continue;
        const buf = await readFile(abs);
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");
        for (const n of pending) {
          if (text.includes(n) && wordRe(n).test(text)) {
            found.add(n);
            pending.delete(n);
          }
        }
      } catch {
        // unreadable: skip
      }
    }
  };
  await walk(dir);
  return {
    has: (n) => found.has(n),
    exists: (p) => {
      try {
        return existsSync(safeJoin(dir, p));
      } catch {
        return false;
      }
    },
  };
}
