// session_replay's answers kept under the character limit. The file lists (`tree`, `changes`, `files`,
// `unchanged`) are paged with limit and cursor; the text in them (diffs, file content, tool output) is
// cut to fit what is left, and the answer says so (`truncated`, plus the field's own flag).
import type { RangeView, StepView } from "../core/replay.ts";
import { cutChars, toolText } from "./protocol.ts";

type Obj = Record<string, unknown>;

/** Text is never cut below this many characters when it sits in a row of a list, or outside one. */
const ROW_FLOOR = 600;
const FIXED_FLOOR = 2000;
/** The most a diff or file shows (the replay is loaded with the same cap). */
export const TEXT_MAX = 16 * 1024;

const FLAG: Record<string, string> = { diff: "diffTruncated", content: "contentTruncated", output: "outputTruncated", text: "textTruncated" };

const NOTE = "Text was cut to keep the answer under 25,000 characters (the fields marked truncated). A smaller limit gives each diff more room (limit 1: up to 16 KB); step with file gives one file's content.";

interface Slot {
  owner: Obj;
  key: string;
  floor: number;
}

function collect(v: unknown, inRow: boolean, out: Slot[], depth = 0): void {
  if (depth > 8 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) collect(x, true, out, depth + 1);
    return;
  }
  const o = v as Obj;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "string") {
      const floor = inRow ? ROW_FLOOR : FIXED_FLOOR;
      if (x.length > floor) out.push({ owner: o, key: k, floor });
    } else collect(x, inRow, out, depth + 1);
  }
}

/** Whether any field in `v` is flagged as cut (`diffTruncated`, `contentTruncated`, …). */
function hasFlag(v: unknown, depth = 0): boolean {
  if (depth > 8 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasFlag(x, depth + 1));
  return Object.entries(v as Obj).some(([k, x]) => (k.endsWith("Truncated") && x === true) || hasFlag(x, depth + 1));
}

/**
 * Cuts the longest strings in `page` (in place) until its text is at most `limit` characters, or no string
 * is left above its floor. The longest are cut down to a common length, so short text stays whole.
 * Sets `truncated` and `note` on the page, and the field's own flag (`diffTruncated`, …) beside a cut one.
 */
export function fitTexts(page: Obj, limit: number): Obj {
  let len = toolText(page).length;
  if (len <= limit) return hasFlag(page) ? { ...page, truncated: true, note: NOTE } : page;
  const slots: Slot[] = [];
  collect(page, false, slots);
  let margin = 1.1;
  for (let round = 0; round < 6 && len > limit && slots.length; round++, margin += 0.4) {
    const need = Math.ceil((len - limit) * margin) + 64;
    const size = (s: Slot) => (s.owner[s.key] as string).length;
    const after = (s: Slot, level: number) => Math.max(s.floor, Math.min(size(s), level));
    const saved = (level: number) => slots.reduce((sum, s) => sum + size(s) - after(s, level), 0);
    let lo = 0;
    let hi = Math.max(...slots.map(size));
    // The highest level that still saves `need` characters (or the lowest there is).
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (saved(mid) >= need) lo = mid;
      else hi = mid - 1;
    }
    let cut = false;
    for (const s of slots) {
      const to = after(s, lo);
      if (to >= size(s)) continue;
      s.owner[s.key] = cutChars(s.owner[s.key] as string, to);
      const flag = FLAG[s.key];
      if (flag) s.owner[flag] = true;
      cut = true;
    }
    if (!cut) break;
    len = toolText({ ...page, truncated: true, note: NOTE }).length;
  }
  return { ...page, truncated: true, note: NOTE };
}

/** A diff cut to `max` characters at a line end, flagged when cut. */
function capDiff(o: { diff?: string; diffTruncated?: boolean }, max: number): void {
  if (o.diff === undefined || o.diff.length <= max) return;
  let cut = cutChars(o.diff, max);
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  o.diff = cut;
  o.diffTruncated = true;
}

/** Characters each row's diff may use on a page of n rows. */
const perRow = (n: number) => Math.min(TEXT_MAX, Math.max(ROW_FLOOR, Math.floor(18_000 / n)));

/** A page of a step's view: the file lists from `offset`; the step's own detail and file only on the first page. */
export function pageStep(view: StepView, offset: number, n: number, limit: number): Obj {
  const first: Obj = {};
  if (offset === 0) {
    first.detail = view.detail;
    if (view.file) first.file = view.file;
  }
  const page = structuredClone({
    sessionId: view.sessionId,
    steps: view.steps,
    step: view.step,
    ...first,
    tree: view.tree.slice(offset, offset + n),
    changes: view.changes.slice(offset, offset + n),
    treeTotal: view.tree.length,
    changesTotal: view.changes.length,
  }) as Obj & { changes: { diff?: string; diffTruncated?: boolean }[]; nextCursor?: string };
  for (const c of page.changes) capDiff(c, perRow(n));
  if (offset + n < Math.max(view.tree.length, view.changes.length)) page.nextCursor = String(offset + n);
  return fitTexts(page, limit);
}

/** A page of a range's view. */
export function pageRange(view: RangeView, offset: number, n: number, limit: number): Obj {
  const page = structuredClone({
    sessionId: view.sessionId,
    from: view.from,
    to: view.to,
    files: view.files.slice(offset, offset + n),
    unchanged: view.unchanged.slice(offset, offset + n),
    filesTotal: view.files.length,
    unchangedTotal: view.unchanged.length,
  }) as Obj & { files: { diff?: string; diffTruncated?: boolean }[]; nextCursor?: string };
  for (const f of page.files) capDiff(f, perRow(n));
  if (offset + n < Math.max(view.files.length, view.unchanged.length)) page.nextCursor = String(offset + n);
  return fitTexts(page, limit);
}
