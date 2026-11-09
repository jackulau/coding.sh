// Line keys and diff parsing for attribution.
//
// A line is compared by its normalized text: leading and trailing whitespace
// dropped and inner runs of whitespace collapsed, so a reindent or a CRLF
// checkout does not hide a match. Only a short hash of it is kept (LineKey),
// never the text, so a cached session source holds no code.
//
// A key starts with its class:
// - "t" trivial: brackets, punctuation, `else`, `end`, blank. These are too
//   common to say who wrote them, so they only match next to a line that did.
// - "s" short: matches in the same file only.
// - "l" long (24+ characters normalized): may also match in another file
//   (a moved or renamed file), at lower confidence.
//
// parseUnifiedDiff reads `git diff -U0` / `git log -p -U0` output into the
// added lines of each file with their new line numbers. filePatchId is the
// idea behind `git patch-id --stable`, per file: a hash of the removed and
// added lines with whitespace and line numbers ignored, so the same change
// rebased onto another base keeps its id.
import { createHash } from "node:crypto";

export type LineKey = string;

export interface AddedLine {
  /** 1-based line number in the new file. */
  line: number;
  key: LineKey;
}

export interface FilePatch {
  /** Repo-relative path ("/"-separated) in the new tree. */
  path: string;
  added: AddedLine[];
  /** Keys of removed lines, for the patch id. */
  removed: LineKey[];
  binary?: boolean;
  /** True when the file was deleted (no new path). */
  deleted?: boolean;
}

/** Normalized lines at least this long may match across files. */
export const LONG_LINE = 24;

const TRIVIAL_WORDS = new Set([
  "else",
  "end",
  "fi",
  "done",
  "esac",
  "pass",
  "return",
  "return;",
  "break",
  "break;",
  "continue",
  "continue;",
  "} else {",
  "}else{",
  "} else",
  "else {",
  "*/",
  "/*",
  "/**",
  "*",
  "#",
  "//",
  "--",
  "end;",
  "begin",
  "try {",
  "} catch {",
  "} finally {",
  "default:",
  "</div>",
  "<div>",
]);

export function normalizeLine(text: string): string {
  return text.replace(/\r$/, "").trim().replace(/\s+/g, " ");
}

/** True when a normalized line carries no authorship signal on its own. */
export function isTrivial(norm: string): boolean {
  if (norm.length <= 2) return true;
  if (TRIVIAL_WORDS.has(norm)) return true;
  return /^[\p{P}\p{S}\s]*$/u.test(norm);
}

export function lineKey(text: string): LineKey {
  const norm = normalizeLine(text);
  const cls = isTrivial(norm) ? "t" : norm.length >= LONG_LINE ? "l" : "s";
  return cls + createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export const isTrivialKey = (k: LineKey): boolean => k.startsWith("t");
export const isLongKey = (k: LineKey): boolean => k.startsWith("l");

/** Per-file patch id: removed and added keys in order, line numbers ignored. Undefined for an empty or binary change. */
export function filePatchId(f: Pick<FilePatch, "added" | "removed" | "binary">): string | undefined {
  if (f.binary || (!f.added.length && !f.removed.length)) return undefined;
  const h = createHash("sha256");
  for (const k of f.removed) h.update("-" + k + "\n");
  for (const a of f.added) h.update("+" + a.key + "\n");
  return h.digest("hex").slice(0, 24);
}

/** Unquote a git C-quoted path ("a\tb" → a<TAB>b, octal escapes as UTF-8 bytes). */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip the a/ or b/ prefix of a ---/+++ path (after unquoting). */
function sidePath(raw: string): string | undefined {
  const p = unquoteGitPath(raw.replace(/\t.*$/, "").trimEnd());
  if (p === "/dev/null") return undefined;
  return p.replace(/^[ab]\//, "");
}

/** The b/ path of a `diff --git a/x b/y` header (quoted or not). */
function headerNewPath(rest: string): string | undefined {
  if (rest.endsWith('"')) {
    const i = rest.lastIndexOf(' "b/');
    return i >= 0 ? unquoteGitPath('"' + rest.slice(i + 4)) : undefined;
  }
  const i = rest.lastIndexOf(" b/");
  return i >= 0 ? rest.slice(i + 3) : undefined;
}

/**
 * Added lines per file from a unified diff (any -U; context lines are
 * skipped). Lines before the first `diff --git` (a log record header) are
 * ignored. Returns files in diff order.
 */
export function parseUnifiedDiff(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | undefined;
  let oldPath: string | undefined;
  let newLine = 0;
  let inHunk = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ")) {
      cur = undefined;
      oldPath = undefined;
      inHunk = false;
      // The path comes from ---/+++; a binary or mode-only change has none, so take it from the header.
      const headerPath = headerNewPath(l.slice("diff --git ".length));
      if (headerPath) {
        cur = { path: headerPath, added: [], removed: [] };
        files.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (l.startsWith("--- ")) {
        oldPath = sidePath(l.slice(4));
        continue;
      }
      if (l.startsWith("+++ ")) {
        const p = sidePath(l.slice(4));
        if (p) cur.path = p;
        else {
          cur.deleted = true;
          if (oldPath) cur.path = oldPath;
        }
        continue;
      }
      if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) {
        cur.binary = true;
        continue;
      }
      if (l.startsWith("deleted file mode")) cur.deleted = true;
    }
    if (l.startsWith("@@")) {
      const m = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m) {
        newLine = Number(m[1]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;
    const c = l[0];
    if (c === "+") {
      cur.added.push({ line: newLine, key: lineKey(l.slice(1)) });
      newLine++;
    } else if (c === "-") {
      cur.removed.push(lineKey(l.slice(1)));
    } else if (c === " ") {
      newLine++;
    } else if (c === "\\") {
      // "\ No newline at end of file"
    } else {
      // Anything else ends the hunk (next record header, blank separator line).
      inHunk = false;
    }
  }
  return files;
}

/** sha256 of a range's normalized lines, for Agent Trace content_hash. */
export function contentHash(keys: readonly LineKey[]): string {
  return "sha256:" + createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
}
