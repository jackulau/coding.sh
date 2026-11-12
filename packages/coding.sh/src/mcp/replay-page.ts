// session_replay's answers kept under the character limit. The file lists (`tree`, `changes`, `files`,
// `unchanged`, the step list) are paged with limit and cursor. Then one pass over the final answer
// cuts what is still too long: arrays that are not paged are cut to the length that fits (with a
// `<key>Total`), and the longest strings are cut to a common length. Each cut is flagged on the
// object that holds it (`diffTruncated`, `filesTruncated`, …); a cut inside a recorded tool input is
// flagged on `detail` as `inputTruncated`, never inside the input. Nothing is cut when the answer fits.
import type { RangeView, StepView } from "../core/replay.ts";
import { cutChars, toolText } from "./protocol.ts";

type Obj = Record<string, unknown>;

/** Text is never cut below this many characters. */
const FLOOR = 64;
/** A page takes rows until they add up to this many characters, each counted at most ROW_SHARE. */
const PAGE_BUDGET = 20_000;
const ROW_SHARE = 2_500;

const NOTE = "Text and lists were cut to keep the answer under 25,000 characters (the fields marked truncated, with their Total). A smaller limit gives each diff more room; step with file gives one file's content.";

const jlen = (v: unknown): number => JSON.stringify(v)?.length ?? 0;

interface Hit {
  owner: Obj;
  key: string;
  /** The object that gets the flag, and its name. */
  flagObj: Obj;
  flagKey: string;
  /** False inside a recorded tool input: no `<key>Total` is written there. */
  total: boolean;
}

/** Strings and arrays in `v` that may be cut: everything but the paged arrays at the top. */
function collect(root: Obj, exempt: ReadonlySet<string>): { strings: Hit[]; arrays: Hit[] } {
  const strings: Hit[] = [];
  const arrays: Hit[] = [];
  const walk = (v: unknown, input: Obj | undefined, top: boolean, depth: number): void => {
    if (depth > 10 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, input, false, depth + 1);
      return;
    }
    const o = v as Obj;
    for (const [k, x] of Object.entries(o)) {
      const inInput = input ?? (k === "input" ? o : undefined);
      const hit = { owner: o, key: k, flagObj: inInput ?? o, flagKey: inInput ? "inputTruncated" : `${k}Truncated`, total: !inInput };
      if (typeof x === "string") strings.push(hit);
      else if (Array.isArray(x)) {
        if (!(top && exempt.has(k))) arrays.push(hit);
        walk(x, inInput, false, depth + 1);
      } else walk(x, inInput, false, depth + 1);
    }
  };
  walk(root, undefined, true, 0);
  return { strings, arrays };
}

/** `a`'s array cut to its first `keep` items. */
function capArray(a: Hit, keep: number): void {
  const list = a.owner[a.key] as unknown[];
  if (a.total && a.owner[`${a.key}Total`] === undefined) a.owner[`${a.key}Total`] = list.length;
  a.owner[a.key] = list.slice(0, keep);
  a.flagObj[a.flagKey] = true;
}

/** The most items of `list` whose JSON fits `budget` characters. */
function itemsWithin(list: unknown[], budget: number): number {
  let used = 2;
  let k = 0;
  while (k < list.length && used + jlen(list[k]) + 1 <= budget) used += jlen(list[k++]) + 1;
  return k;
}

/**
 * Cuts `page` (in place) until its text is at most `limit` characters: arrays over a quarter of the
 * limit first, then the longest strings down to a common length (not below FLOOR), then the longest
 * arrays by halves. `exempt` names the top-level arrays that are already paged. `truncated` and
 * `note` are set only when this pass cut something, and are counted in the length.
 */
export function fitAnswer(page: Obj, limit: number, exempt: readonly string[] = []): Obj {
  if (jlen(page) <= limit) return page;
  const ex = new Set(exempt);
  page.truncated = true;
  page.note = NOTE;
  let cut = false;
  const over = () => jlen(page) - limit;
  const quarter = Math.floor(limit / 4);
  for (const a of collect(page, ex).arrays) {
    const list = a.owner[a.key] as unknown[];
    if (jlen(list) > quarter) {
      capArray(a, itemsWithin(list, quarter));
      cut = true;
    }
  }
  for (let round = 0, margin = 1.1; round < 6 && over() > 0; round++, margin += 0.4) {
    const slots = collect(page, ex).strings.filter((s) => (s.owner[s.key] as string).length > FLOOR);
    if (!slots.length) break;
    const need = Math.ceil(over() * margin) + 64;
    const size = (s: Hit) => (s.owner[s.key] as string).length;
    const after = (s: Hit, level: number) => Math.max(FLOOR, Math.min(size(s), level));
    const saved = (level: number) => slots.reduce((sum, s) => sum + size(s) - after(s, level), 0);
    let lo = FLOOR;
    let hi = Math.max(...slots.map(size));
    // The highest common length that still saves `need` characters (or the lowest there is).
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (saved(mid) >= need) lo = mid;
      else hi = mid - 1;
    }
    for (const s of slots) {
      const to = after(s, lo);
      if (to >= size(s)) continue;
      s.owner[s.key] = cutChars(s.owner[s.key] as string, to);
      s.flagObj[s.flagKey] = true;
      cut = true;
    }
  }
  while (over() > 0) {
    const arrays = collect(page, ex).arrays.filter((a) => (a.owner[a.key] as unknown[]).length > 0);
    if (!arrays.length) break;
    const big = arrays.reduce((m, a) => (jlen(a.owner[a.key]) > jlen(m.owner[m.key]) ? a : m));
    capArray(big, Math.floor((big.owner[big.key] as unknown[]).length / 2));
    cut = true;
  }
  if (!cut) {
    delete page.truncated;
    delete page.note;
  }
  return page;
}

/** How many rows a page takes from `offset`: up to n, while their text adds up to PAGE_BUDGET (at least one). */
function takeRows(n: number, offset: number, total: number, cost: (i: number) => number): number {
  let used = 0;
  let k = 0;
  for (let i = offset; i < total && k < n; i++) {
    const c = cost(i);
    if (k > 0 && used + c > PAGE_BUDGET) break;
    used += c;
    k++;
  }
  return k;
}

const costs = new WeakMap<object, number[]>();
/** The size of each row of a view (its list entries side by side), computed once. */
function rowCosts(key: object, count: number, row: (i: number) => number): number[] {
  let c = costs.get(key);
  if (!c) costs.set(key, (c = Array.from({ length: count }, (_, i) => row(i))));
  return c;
}

const share = (v: unknown): number => Math.min(ROW_SHARE, jlen(v));

/** A page of a step's view: the file lists from `offset`; the step's own detail and file only on the first page. */
export function pageStep(view: StepView, offset: number, n: number, limit: number): Obj {
  const total = Math.max(view.tree.length, view.changes.length);
  const c = rowCosts(view, total, (i) => (i < view.tree.length ? jlen(view.tree[i]) : 0) + (i < view.changes.length ? share(view.changes[i]) : 0));
  const k = takeRows(n, offset, total, (i) => c[i]!);
  const page: Obj = { sessionId: view.sessionId, steps: view.steps, step: view.step };
  if (offset === 0) {
    page.detail = view.detail;
    if (view.file) page.file = view.file;
  }
  page.tree = view.tree.slice(offset, offset + k);
  page.changes = view.changes.slice(offset, offset + k);
  page.treeTotal = view.tree.length;
  page.changesTotal = view.changes.length;
  if (offset + k < total) page.nextCursor = String(offset + k);
  return fitAnswer(structuredClone(page), limit, ["tree", "changes"]);
}

/** A page of a range's view. */
export function pageRange(view: RangeView, offset: number, n: number, limit: number): Obj {
  const total = Math.max(view.files.length, view.unchanged.length);
  const c = rowCosts(view, total, (i) => (i < view.files.length ? share(view.files[i]) : 0) + (i < view.unchanged.length ? jlen(view.unchanged[i]) : 0));
  const k = takeRows(n, offset, total, (i) => c[i]!);
  const page: Obj = { sessionId: view.sessionId, from: view.from, to: view.to };
  page.files = view.files.slice(offset, offset + k);
  page.unchanged = view.unchanged.slice(offset, offset + k);
  page.filesTotal = view.files.length;
  page.unchangedTotal = view.unchanged.length;
  if (offset + k < total) page.nextCursor = String(offset + k);
  return fitAnswer(structuredClone(page), limit, ["files", "unchanged"]);
}
