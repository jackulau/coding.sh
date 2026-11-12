// session_replay's answers kept under the character limit, in two steps.
//
// 1. Rows first, uncut. A page takes whole rows (file lists, the step list) by their measured size,
//    as many as fit beside the rest of the answer, at least one. A page with fewer rows than asked
//    says so with `limitUsed`, and `nextCursor` starts at the first row left out.
// 2. `fitAnswer` cuts only what is still too long: one budget allocation over the answer, top down.
//    Each object or array gives the children that fit under their fair share their full size, and
//    splits the rest among the larger ones. Strings are cut at a character boundary by their escaped
//    length. When there are too many children to give each a useful share, the first ones are kept
//    whole in order and the rest dropped. Ids, paths, cursors and flags are never cut. Each cut is
//    flagged on the object that holds it (`diffTruncated`, `filesTruncated` with `filesTotal`,
//    `truncatedKeys`); a cut inside a recorded tool input is flagged on its holder as `inputTruncated`,
//    never inside the input. `truncated` and `note` are set only when this step cut something.
import type { RangeView, ReplayIndex, StepView } from "../core/replay.ts";
import { toolText } from "./protocol.ts";

type Obj = Record<string, unknown>;

/** The smallest share of characters worth cutting a child to; below it the child is dropped instead. */
const MIN_SHARE = 200;
/** Room kept free for the page's cursor and `limitUsed`. */
const SLACK = 80;

const NOTE = "Text and lists were cut to keep the answer under 25,000 characters (the fields marked truncated, with their Total). A smaller limit gives each diff more room; step with file gives one file's content.";

/** Keys whose text is never cut (ids, paths, names the reader needs to follow the answer). */
const PROTECTED = new Set(["note", "truncated", "nextCursor", "limitUsed", "sessionId", "id", "eventId", "toolUseId", "n", "path", "file", "kind", "tool", "op", "status", "root", "baseline", "from", "to"]);

const jlen = (v: unknown): number => toolText(v)?.length ?? 0;
const isContainer = (v: unknown): v is object => typeof v === "object" && v !== null;

interface Info {
  keys?: string[];
  vals: unknown[];
  /** Serialized size of each value. */
  sizes: number[];
  /** What each entry costs besides its value: the key and a comma. */
  over: number[];
  /** Serialized size of the whole container. */
  total: number;
}

/** The serialized size of every object and array under `root`, bottom up with an explicit stack (any depth). */
function measure(root: object): Map<object, Info> {
  const infos = new Map<object, Info>();
  const open = (v: object) => {
    if (Array.isArray(v)) return { v, keys: undefined as string[] | undefined, vals: v as unknown[], sizes: [] as number[], i: 0 };
    const entries = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== "function" && typeof x !== "symbol");
    return { v, keys: entries.map(([k]) => k), vals: entries.map(([, x]) => x), sizes: [] as number[], i: 0 };
  };
  const stack = [open(root)];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i < f.vals.length) {
      const c = f.vals[f.i];
      if (isContainer(c)) {
        const known = infos.get(c);
        if (!known) {
          stack.push(open(c));
          continue;
        }
        f.sizes.push(known.total);
      } else f.sizes.push(jlen(c === undefined ? null : c));
      f.i++;
      continue;
    }
    const over = f.vals.map((_, i) => (f.keys ? jlen(f.keys[i]!) + 1 : 0) + 1);
    const n = f.vals.length;
    const total = 2 + over.reduce((a, b) => a + b, 0) + f.sizes.reduce((a, b) => a + b, 0) - (n ? 1 : 0);
    infos.set(f.v, { keys: f.keys, vals: f.vals, sizes: f.sizes, over, total });
    stack.pop();
  }
  return infos;
}

/** The longest prefix of `s` whose JSON text (with its quotes) is at most `budget` characters, cut between characters. */
function cutString(s: string, budget: number): string {
  const room = Math.max(0, budget - 2);
  let used = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let cost = 1;
    let step = 1;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) step = 2;
    else if (c >= 0xd800 && c <= 0xdfff) cost = 6;
    else if (c < 0x20) cost = c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c === 34 || c === 92) cost = 2;
    if (step === 2) cost = 2;
    if (used + cost > room) break;
    used += cost;
    i += step;
  }
  return s.slice(0, i);
}

interface Flag {
  obj: Obj;
  key: string;
}
interface Task {
  info: Info;
  out: Obj | unknown[];
  budget: number;
  /** Where a cut in here is flagged. */
  flag: Flag | undefined;
  /** Inside a recorded tool input: nothing but `inputTruncated` is written. */
  inInput: boolean;
  /** For an array held by an object key: that object and key, for `<key>Total`. */
  self: Flag | undefined;
}

/** A copy of `root` that serializes to at most `budget` characters (when the protected text allows). Originals are not changed. */
function allocate(root: Obj, infos: Map<object, Info>, budget: number): { out: Obj; cut: boolean } {
  const out: Obj = {};
  let cut = false;
  const stack: Task[] = [{ info: infos.get(root)!, out, budget, flag: undefined, inInput: false, self: undefined }];
  while (stack.length) {
    const t = stack.pop()!;
    const { info: I } = t;
    const n = I.vals.length;
    const cost = (i: number) => I.over[i]! + I.sizes[i]!;
    // decide[i]: Infinity keeps it whole, -1 drops it, anything else is the budget for its value.
    const decide: number[] = new Array(n).fill(Infinity);
    let remaining = t.budget - 1;
    const rest: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = I.vals[i];
      // Ids and paths, and numbers, booleans and null (a few characters each), are never cut or dropped.
      if (!isContainer(v) && (typeof v !== "string" || (I.keys && PROTECTED.has(I.keys[i]!)))) remaining -= cost(i);
      else rest.push(i);
    }
    let sum = 0;
    for (const i of rest) sum += cost(i);
    if (sum > remaining) {
      const order = [...rest].sort((a, b) => cost(a) - cost(b));
      let rem = remaining;
      let left = order.length;
      let pos = 0;
      while (pos < order.length && cost(order[pos]!) <= rem / left) rem -= cost(order[pos++]!), left--;
      if (left > 0 && rem / left >= MIN_SHARE) {
        for (; pos < order.length; pos++) decide[order[pos]!] = Math.max(2, Math.floor(rem / left) - I.over[order[pos]!]!);
      } else if (left > 0) {
        // Too many children for each to get a useful share: keep the first ones whole, cut the next, drop the rest.
        let r = remaining;
        let dropping = false;
        for (const i of rest) {
          if (dropping) decide[i] = -1;
          else if (cost(i) <= r) r -= cost(i);
          else {
            const vb = r - I.over[i]!;
            decide[i] = vb >= MIN_SHARE ? vb : -1;
            dropping = true;
          }
        }
      }
    }
    const isArr = Array.isArray(t.out);
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      const d = decide[i]!;
      if (d === -1) {
        dropped++;
        continue;
      }
      const val = I.vals[i];
      const key = I.keys?.[i];
      // Where a cut at this entry is flagged.
      const flag: Flag | undefined = isArr ? t.flag : t.inInput ? t.flag : key === "input" ? { obj: t.out as Obj, key: "inputTruncated" } : { obj: t.out as Obj, key: `${key}Truncated` };
      const inInput = t.inInput || key === "input";
      let nv = val;
      if (d !== Infinity && typeof val === "string") {
        nv = cutString(val, d);
        cut = true;
        if (flag) flag.obj[flag.key] = true;
      } else if (d !== Infinity && isContainer(val)) {
        const child: Obj | unknown[] = Array.isArray(val) ? [] : {};
        cut = true;
        stack.push({ info: infos.get(val)!, out: child, budget: d, flag, inInput, self: Array.isArray(val) && key !== undefined && !inInput ? { obj: t.out as Obj, key } : undefined });
        nv = child;
      }
      if (isArr) (t.out as unknown[]).push(nv);
      else (t.out as Obj)[key!] = nv;
    }
    if (dropped) {
      cut = true;
      if (t.flag) t.flag.obj[t.flag.key] = true;
      if (!t.inInput) {
        if (t.self) t.self.obj[`${t.self.key}Total`] = n;
        else if (!isArr) (t.out as Obj).truncatedKeys = dropped;
      }
    }
  }
  return { out, cut };
}

/**
 * `page`, or a copy of it cut to at most `cap` characters. Nothing is cut when it fits. `truncated`
 * and `note` are set when something was cut, and counted in the length. A last resort replaces the
 * largest top-level entries with `{truncated: true, chars}` when protected text alone is too long.
 */
export function fitAnswer(page: Obj, cap: number): Obj {
  const infos = measure(page);
  if (infos.get(page)!.total <= cap) return page;
  let budget = cap - jlen(NOTE) - 40 - 256;
  let out: Obj = page;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = allocate(page, infos, budget);
    out = r.out;
    if (r.cut) {
      out.truncated = true;
      out.note = NOTE;
    }
    const len = jlen(out);
    if (len <= cap) return out;
    budget -= len - cap + 32;
  }
  out.truncated = true;
  out.note = NOTE;
  const replaced = new Set<string>();
  for (let len = jlen(out); len > cap; len = jlen(out)) {
    let big: string | undefined;
    let bigSize = 0;
    for (const [k, v] of Object.entries(out)) {
      if (replaced.has(k) || k === "note" || k === "truncated" || k === "nextCursor" || k === "limitUsed") continue;
      const s = jlen(v);
      if (s > bigSize) [big, bigSize] = [k, s];
    }
    if (big === undefined) break;
    out[big] = { truncated: true, chars: bigSize };
    replaced.add(big);
  }
  return out;
}

/** How many rows a page takes from `offset`: up to n, while the answer (`fixed` characters besides the rows) fits `cap`; at least one. */
function takeRows(n: number, offset: number, total: number, fixed: number, cap: number, cost: (i: number) => number): number {
  let used = fixed + SLACK;
  let k = 0;
  for (let i = offset; i < total && k < n; i++) {
    const c = cost(i);
    if (k > 0 && used + c > cap) break;
    used += c;
    k++;
  }
  return k;
}

/** Cursor and `limitUsed` for a page of k rows, out of n asked, from `offset`. */
function paging(page: Obj, offset: number, k: number, n: number, total: number): void {
  if (offset + k < total) page.nextCursor = String(offset + k);
  if (k < Math.min(n, total - offset)) page.limitUsed = k;
}

const rowLen = (list: unknown[], i: number): number => (i < list.length ? jlen(list[i]) + 1 : 0);

/** A page of a step's view: the file lists from `offset`; the step's own detail and file only on the first page. */
export function pageStep(view: StepView, offset: number, n: number, cap: number): Obj {
  const total = Math.max(view.tree.length, view.changes.length);
  const page: Obj = { sessionId: view.sessionId, steps: view.steps, step: view.step };
  if (offset === 0) {
    page.detail = view.detail;
    if (view.file) page.file = view.file;
  }
  page.treeTotal = view.tree.length;
  page.changesTotal = view.changes.length;
  const k = takeRows(n, offset, total, jlen(page) + 24, cap, (i) => rowLen(view.tree, i) + rowLen(view.changes, i));
  page.tree = view.tree.slice(offset, offset + k);
  page.changes = view.changes.slice(offset, offset + k);
  paging(page, offset, k, n, total);
  return fitAnswer(page, cap);
}

/** A page of a range's view. */
export function pageRange(view: RangeView, offset: number, n: number, cap: number): Obj {
  const total = Math.max(view.files.length, view.unchanged.length);
  const page: Obj = { sessionId: view.sessionId, from: view.from, to: view.to, filesTotal: view.files.length, unchangedTotal: view.unchanged.length };
  const k = takeRows(n, offset, total, jlen(page) + 28, cap, (i) => rowLen(view.files, i) + rowLen(view.unchanged, i));
  page.files = view.files.slice(offset, offset + k);
  page.unchanged = view.unchanged.slice(offset, offset + k);
  paging(page, offset, k, n, total);
  return fitAnswer(page, cap);
}

/** A page of the step list: steps and the session's file paths, side by side. */
export function pageIndex(index: ReplayIndex, offset: number, n: number, cap: number): Obj {
  const total = Math.max(index.steps.length, index.files.length);
  const page: Obj = { sessionId: index.sessionId, total: index.steps.length, filesTotal: index.files.length, baseline: index.baseline };
  if (index.root !== undefined) page.root = index.root;
  const k = takeRows(n, offset, total, jlen(page) + 24, cap, (i) => rowLen(index.steps, i) + rowLen(index.files, i));
  page.steps = index.steps.slice(offset, offset + k);
  page.files = index.files.slice(offset, offset + k);
  paging(page, offset, k, n, total);
  return fitAnswer(page, cap);
}
