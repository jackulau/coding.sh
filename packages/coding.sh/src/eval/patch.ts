// Minimal unified-diff model: enough to split a patch into files and hunks,
// drop hunks (near-miss generation) and extract added text (leakage scan).
// Binary sections and anything we don't understand are kept verbatim.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second "@@" (function context), including leading space. */
  section: string;
  /** Body lines (" ", "+", "-", "\\"), without trailing newline. */
  lines: string[];
}

export interface PatchFile {
  /** Header lines from "diff --git" (or "---") through "+++", verbatim. */
  header: string[];
  oldPath?: string;
  newPath?: string;
  hunks: Hunk[];
  /** Unrecognised lines after the last hunk (e.g. a format-patch signature), kept in place. */
  trailer: string[];
  /** True when the section has no textual hunks (binary, mode-only, rename-only). */
  opaque: boolean;
}

export interface Patch {
  /** Lines before the first file section (e.g. a commit message). */
  preamble: string[];
  files: PatchFile[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | undefined {
  const t = p.split("\t")[0]?.trim() ?? "";
  if (t === "/dev/null") return undefined;
  return t.replace(/^"?[ab]\//, "").replace(/"$/, "");
}

export function parsePatch(text: string): Patch {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const patch: Patch = { preamble: [], files: [] };
  let cur: PatchFile | undefined;
  let i = 0;
  // Inside a section, header lines are consumed by the header loop and hunk
  // bodies by line counts, so at this level "---"/"+++" always opens a file.
  const startsFile = (j: number): boolean => {
    const l = lines[j] ?? "";
    return l.startsWith("diff --git ") || (l.startsWith("--- ") && (lines[j + 1] ?? "").startsWith("+++ "));
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    if (startsFile(i)) {
      cur = { header: [line], hunks: [], trailer: [], opaque: true };
      patch.files.push(cur);
      if (line.startsWith("diff --git ")) {
        const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
        if (m) {
          cur.oldPath = m[1];
          cur.newPath = m[2];
        }
      } else {
        cur.oldPath = stripPrefix(line.slice(4));
      }
      i++;
      // Header continues until the first hunk or next file.
      while (i < lines.length && !HUNK_RE.test(lines[i] as string) && !(lines[i] as string).startsWith("diff --git ")) {
        const h = lines[i] as string;
        cur.header.push(h);
        if (h.startsWith("--- ")) cur.oldPath = stripPrefix(h.slice(4));
        if (h.startsWith("+++ ")) cur.newPath = stripPrefix(h.slice(4));
        i++;
      }
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm && cur) {
      const hunk: Hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5] ?? "",
        lines: [],
      };
      i++;
      let oldSeen = 0;
      let newSeen = 0;
      while (i < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines)) {
        const b = lines[i] as string;
        const c = b[0];
        if (c === " " || b === "") {
          oldSeen++;
          newSeen++;
        } else if (c === "-") oldSeen++;
        else if (c === "+") newSeen++;
        else if (c !== "\\") break;
        hunk.lines.push(b === "" ? " " : b);
        i++;
      }
      while (i < lines.length && (lines[i] as string).startsWith("\\")) {
        hunk.lines.push(lines[i] as string);
        i++;
      }
      cur.hunks.push(hunk);
      cur.opaque = false;
      continue;
    }
    if (cur) (cur.hunks.length ? cur.trailer : cur.header).push(line);
    else patch.preamble.push(line);
    i++;
  }
  return patch;
}

function hunkHeader(h: Hunk): string {
  const r = (start: number, n: number) => (n === 1 ? `${start}` : `${start},${n}`);
  return `@@ -${r(h.oldStart, h.oldLines)} +${r(h.newStart, h.newLines)} @@${h.section}`;
}

export function formatPatch(p: Patch): string {
  const out: string[] = [...p.preamble];
  for (const f of p.files) {
    out.push(...f.header);
    for (const h of f.hunks) out.push(hunkHeader(h), ...h.lines);
    out.push(...f.trailer);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export function hunkCount(p: Patch): number {
  let n = 0;
  for (const f of p.files) n += f.hunks.length;
  return n;
}

function isNewFile(f: PatchFile): boolean {
  return f.oldPath === undefined || f.header.some((h) => h.startsWith("new file mode"));
}

/**
 * Remove one hunk. Later hunks in the same file get their new-side start
 * shifted so the result is still a well-formed patch. A file whose last hunk
 * is dropped disappears entirely (for a new file, it is simply not created).
 */
export function dropHunk(p: Patch, fileIndex: number, hunkIndex: number): Patch {
  const files: PatchFile[] = [];
  p.files.forEach((f, fi) => {
    if (fi !== fileIndex) {
      files.push(f);
      return;
    }
    const dropped = f.hunks[hunkIndex];
    if (!dropped) {
      files.push(f);
      return;
    }
    const delta = dropped.newLines - dropped.oldLines;
    const hunks = f.hunks
      .filter((_, hi) => hi !== hunkIndex)
      .map((h, idx) => (idx >= hunkIndex ? { ...h, newStart: h.newStart - delta } : h));
    if (hunks.length === 0) return;
    files.push({ ...f, hunks });
  });
  return { preamble: p.preamble, files };
}

export interface Mutation {
  label: string;
  patch: string;
}

/**
 * Simple near-miss mutations of a reference patch: drop each hunk on its own
 * (only meaningful when the patch has more than one hunk). Opaque sections are
 * never dropped. `max` bounds the cost of validation on big patches.
 */
export function nearMissMutations(patchText: string, opts: { max?: number } = {}): Mutation[] {
  const p = parsePatch(patchText);
  if (hunkCount(p) < 2) return [];
  const out: Mutation[] = [];
  const max = opts.max ?? 10;
  p.files.forEach((f, fi) => {
    f.hunks.forEach((h, hi) => {
      if (out.length >= max) return;
      const name = f.newPath ?? f.oldPath ?? `file#${fi}`;
      const what = isNewFile(f) && f.hunks.length === 1 ? "skip creating" : `drop hunk ${hi + 1}/${f.hunks.length} (@@ -${h.oldStart})`;
      out.push({ label: `${what} in ${name}`, patch: formatPatch(dropHunk(p, fi, hi)) });
    });
  });
  return out;
}

/** Files touched by the patch (new path, else old path). */
export function patchPaths(patchText: string): string[] {
  return parsePatch(patchText)
    .files.map((f) => f.newPath ?? f.oldPath)
    .filter((x): x is string => typeof x === "string");
}

/** Keep only file sections whose path does not satisfy `drop`. */
export function filterPatch(patchText: string, drop: (path: string) => boolean): string {
  const p = parsePatch(patchText);
  return formatPatch({ preamble: p.preamble, files: p.files.filter((f) => !drop(f.newPath ?? f.oldPath ?? "")) });
}

/** The text of all "+" lines (excluding "+++" headers), one per line. */
export function addedLines(patchText: string): string[] {
  const out: string[] = [];
  for (const f of parsePatch(patchText).files) {
    for (const h of f.hunks) for (const l of h.lines) if (l.startsWith("+")) out.push(l.slice(1));
  }
  return out;
}

/** Contiguous runs of "+" lines, one string per run (each is real, adjacent code). */
export function addedBlocks(patchText: string): string[] {
  const out: string[] = [];
  for (const f of parsePatch(patchText).files) {
    for (const h of f.hunks) {
      let cur: string[] = [];
      for (const l of h.lines) {
        if (l.startsWith("+")) cur.push(l.slice(1));
        else if (!l.startsWith("\\")) {
          if (cur.length) out.push(cur.join("\n"));
          cur = [];
        }
      }
      if (cur.length) out.push(cur.join("\n"));
    }
  }
  return out;
}
