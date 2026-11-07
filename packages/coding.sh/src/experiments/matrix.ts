// Experiment matrices (Z-4): one controlled comparison per spec. A base config
// plus either named `variants` (override maps keyed by JSON Pointer) or a
// `matrix` of axes expanded to the full cross-product, with one baseline cell.
// `vary` lists the JSON Pointer paths allowed to differ from the baseline; any
// other difference is a plan-time error, so a typo can't turn a one-factor
// comparison into a confounded one. Pure: no I/O. The format follows Vally's
// experiment file (https://microsoft.github.io/vally/reference/experiment-file/).

export class MatrixPlanError extends Error {
  /** The spec field the error is about (`matrix.model`, `baseline`, …), when there is one. */
  readonly field?: string;
  /** Cells whose config differs from the baseline outside `vary`: cell name → offending pointers. */
  readonly cells?: Record<string, string[]>;
  constructor(message: string, o: { field?: string; cells?: Record<string, string[]> } = {}) {
    super(message);
    this.name = "MatrixPlanError";
    if (o.field !== undefined) this.field = o.field;
    if (o.cells) this.cells = o.cells;
  }
}

export interface MatrixAxis {
  /** JSON Pointer into the config this axis sets. */
  path: string;
  /** Scalars (labelled by their string form) or single-key {label: value} maps. */
  values: unknown[];
}

export interface MatrixSpec {
  /** JSON Pointer paths allowed to differ from the baseline. Required with variants; derived from the axes with a matrix. */
  vary?: string[];
  /** A variant name, or with a matrix an axis → label map naming exactly one cell. */
  baseline?: string | Record<string, string>;
  /** Named override maps: {cellName: {pointer: value}}. At least two. */
  variants?: Record<string, Record<string, unknown>>;
  /** Axes by name, in declaration order (axis names are never purely numeric, so the order holds). */
  matrix?: Record<string, MatrixAxis>;
}

export interface MatrixCell {
  name: string;
  /** Axis → label (matrix cells only). */
  labels?: Record<string, string>;
  /** The base config with this cell's overrides merged in. */
  config: Record<string, unknown>;
  /** This cell's overrides, pointer → value (null deletes). */
  overrides: Record<string, unknown>;
}

export interface MatrixPlan {
  cells: MatrixCell[];
  /** Name of the baseline cell. */
  baseline: string;
  vary: string[];
}

export const MAX_CELLS = 256;
const NAME = /^[A-Za-z0-9._-]+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** RFC 6901 reference tokens of a pointer (`/a~1b/c~0d` → ["a/b", "c~d"]). The root pointer "" is rejected. */
export function parsePointer(p: string): string[] {
  if (typeof p !== "string" || !p.startsWith("/")) throw new MatrixPlanError(`${JSON.stringify(p)} is not a JSON Pointer: it must start with "/", like /task/env/MODEL`);
  return p
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");
const pointerOf = (tokens: readonly string[]) => tokens.map((t) => `/${escapeToken(t)}`).join("");

export function getAt(root: unknown, tokens: readonly string[]): unknown {
  let cur = root;
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = cur[Number(t)];
    else if (isObj(cur)) cur = cur[t];
    else return undefined;
  }
  return cur;
}

/** Set (or with `undefined`, delete) the value at `tokens`, creating missing parents as objects. Mutates `root`. */
export function setAt(root: Obj, tokens: readonly string[], value: unknown): void {
  let cur: Obj | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i] as string;
    const next: unknown = Array.isArray(cur) ? cur[Number(t)] : cur[t];
    if (isObj(next) || Array.isArray(next)) cur = next;
    else {
      if (value === undefined) return; // nothing to delete
      const made: Obj = {};
      if (Array.isArray(cur)) cur[Number(t)] = made;
      else cur[t] = made;
      cur = made;
    }
  }
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(cur)) {
    if (value === undefined) cur.splice(Number(last), 1);
    else cur[Number(last)] = value;
  } else if (value === undefined) delete cur[last];
  else cur[last] = value;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Maps deep-merge, scalars and arrays replace, null deletes. Returns a new value. */
function mergeValue(base: unknown, over: unknown): unknown {
  if (!isObj(over) || !isObj(base)) return clone(over);
  const out: Obj = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = mergeValue(out[k], v);
  }
  return out;
}

/** The base config with each pointer's override merged in (Vally rules). Never mutates `base`. */
export function mergeOverrides(base: Obj, overrides: Record<string, unknown>): Obj {
  const out = clone(base);
  for (const [p, v] of Object.entries(overrides)) {
    const tokens = parsePointer(p);
    if (v === null) setAt(out, tokens, undefined);
    else setAt(out, tokens, mergeValue(getAt(out, tokens), v));
  }
  return out;
}

/** Leaf pointers where two configs differ; arrays of one length compare by index, others whole; a map missing on one side lists its leaves. */
function diffLeaves(a: unknown, b: unknown, path: string[], out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diffLeaves(x, b[i], [...path, String(i)], out));
    return;
  }
  if (isObj(a) || isObj(b)) {
    if ((a !== undefined && !isObj(a)) || (b !== undefined && !isObj(b))) {
      out.push(pointerOf(path));
      return;
    }
    const x = (a ?? {}) as Obj;
    const y = (b ?? {}) as Obj;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) diffLeaves(x[k], y[k], [...path, k], out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(pointerOf(path));
}

/** True when `entry` equals `pointer` or is a parent of it (token boundary). */
function covers(entry: string, pointer: string): boolean {
  return pointer === entry || pointer.startsWith(`${entry}/`);
}

/** Pointers where `cell` differs from `baseline` that no `vary` entry equals or prefixes; empty when the cell only varies what it may. */
export function checkOnlyVaried(baseline: unknown, cell: unknown, vary: readonly string[]): string[] {
  const diffs: string[] = [];
  diffLeaves(baseline, cell, [], diffs);
  return diffs.filter((p) => !vary.some((v) => covers(v, p))).sort();
}

function checkName(name: string, what: string, field: string): void {
  if (!NAME.test(name)) throw new MatrixPlanError(`${what} ${JSON.stringify(name)} may use only letters, digits, ".", "_" and "-"`, { field });
}

/** An axis value's label and value: a scalar labelled by its string form, or a single-key {label: value} map. */
function labelled(v: unknown, field: string): { label: string; value: unknown } {
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length !== 1) throw new MatrixPlanError(`${field}: a map value needs exactly one key, its label ({"label": value}); got ${keys.length}`, { field });
    return { label: keys[0] as string, value: v[keys[0] as string] };
  }
  if (v === null || Array.isArray(v) || typeof v === "object") throw new MatrixPlanError(`${field}: values are scalars or {"label": value} maps`, { field });
  return { label: String(v), value: v };
}

/**
 * Expand a matrix or variants spec over a base config into named cells, check
 * every name and the baseline, and refuse any cell that differs from the
 * baseline outside `vary`. Cells come in declaration order, the last axis
 * fastest.
 */
export function expandMatrix(base: Obj, spec: MatrixSpec, opts: { maxCells?: number } = {}): MatrixPlan {
  const maxCells = opts.maxCells ?? MAX_CELLS;
  if (spec.matrix !== undefined && spec.variants !== undefined) throw new MatrixPlanError(`"matrix" and "variants" are exclusive: give one`, { field: "matrix" });
  let cells: MatrixCell[];
  let baseline: string;
  let vary: string[];
  if (spec.matrix !== undefined) {
    if (spec.vary !== undefined) throw new MatrixPlanError(`"vary" is derived from matrix axes; remove it`, { field: "vary" });
    if (!isObj(spec.matrix)) throw new MatrixPlanError(`"matrix" must map axis names to {"path", "values"}`, { field: "matrix" });
    const axes = Object.entries(spec.matrix).map(([name, axis]) => {
      const field = `matrix.${name}`;
      checkName(name, "axis name", field);
      if (/^\d+$/.test(name)) throw new MatrixPlanError(`axis name ${JSON.stringify(name)} is purely numeric; JSON objects reorder numeric keys, so give it a word`, { field });
      if (!isObj(axis) || typeof axis.path !== "string" || !Array.isArray(axis.values)) throw new MatrixPlanError(`${field} needs {"path": "/json/pointer", "values": [...]}`, { field });
      parsePointer(axis.path);
      if (!axis.values.length) throw new MatrixPlanError(`${field} has no values`, { field });
      const values = axis.values.map((v) => labelled(v, field));
      const seen = new Set<string>();
      for (const { label } of values) {
        checkName(label, `${field} label`, field);
        if (seen.has(label)) throw new MatrixPlanError(`${field} has the label ${JSON.stringify(label)} twice`, { field });
        seen.add(label);
      }
      return { name, path: axis.path, values };
    });
    const count = axes.reduce((n, a) => n * a.values.length, 1);
    if (count < 2 || count > maxCells) throw new MatrixPlanError(`a matrix needs 2 to ${maxCells} cells; this one has ${count}`, { field: "matrix" });
    cells = [];
    const idx = axes.map(() => 0);
    for (let n = 0; n < count; n++) {
      const labels: Record<string, string> = {};
      const overrides: Record<string, unknown> = {};
      axes.forEach((a, i) => {
        const v = a.values[idx[i] as number]!;
        labels[a.name] = v.label;
        overrides[a.path] = v.value;
      });
      cells.push({ name: axes.map((a) => `${a.name}=${labels[a.name]}`).join(","), labels, config: mergeOverrides(base, overrides), overrides });
      for (let i = axes.length - 1; i >= 0; i--) {
        idx[i] = (idx[i] as number) + 1;
        if ((idx[i] as number) < axes[i]!.values.length) break;
        idx[i] = 0;
      }
    }
    const b = spec.baseline;
    if (!isObj(b)) throw new MatrixPlanError(`"baseline" must map every axis to one of its labels, e.g. ${JSON.stringify(Object.fromEntries(axes.map((a) => [a.name, a.values[0]!.label])))}`, { field: "baseline" });
    for (const a of axes) {
      const want = b[a.name];
      if (want === undefined) throw new MatrixPlanError(`"baseline" does not name axis ${a.name}`, { field: "baseline" });
      if (!a.values.some((v) => v.label === want)) throw new MatrixPlanError(`"baseline" names ${a.name}=${String(want)}, which is not one of its labels (${a.values.map((v) => v.label).join(", ")})`, { field: "baseline" });
    }
    for (const k of Object.keys(b)) if (!axes.some((a) => a.name === k)) throw new MatrixPlanError(`"baseline" names ${k}, which is not an axis`, { field: "baseline" });
    baseline = axes.map((a) => `${a.name}=${b[a.name]}`).join(",");
    vary = [...new Set(axes.map((a) => a.path))];
  } else if (spec.variants !== undefined) {
    if (!isObj(spec.variants)) throw new MatrixPlanError(`"variants" must map names to {"/json/pointer": value} overrides`, { field: "variants" });
    const entries = Object.entries(spec.variants);
    if (entries.length < 2 || entries.length > maxCells) throw new MatrixPlanError(`"variants" needs 2 to ${maxCells} entries; got ${entries.length}`, { field: "variants" });
    if (!Array.isArray(spec.vary) || !spec.vary.length) throw new MatrixPlanError(`"variants" needs "vary": the JSON Pointer paths the variants may change, e.g. ["/task/env/MODEL"]`, { field: "vary" });
    for (const p of spec.vary) parsePointer(p);
    cells = entries.map(([name, overrides]) => {
      const field = `variants.${name}`;
      checkName(name, "variant name", field);
      if (!isObj(overrides)) throw new MatrixPlanError(`${field} must map JSON Pointers to values`, { field });
      return { name, config: mergeOverrides(base, overrides), overrides };
    });
    if (typeof spec.baseline !== "string") throw new MatrixPlanError(`"baseline" must name one of the variants (${entries.map(([n]) => n).join(", ")})`, { field: "baseline" });
    if (!spec.variants[spec.baseline]) throw new MatrixPlanError(`"baseline" names ${spec.baseline}, which is not a variant (${entries.map(([n]) => n).join(", ")})`, { field: "baseline" });
    baseline = spec.baseline;
    vary = [...spec.vary];
  } else throw new MatrixPlanError(`a matrix spec needs "matrix" or "variants"`, { field: "matrix" });
  const lower = new Map<string, string>();
  for (const c of cells) {
    const k = c.name.toLowerCase();
    if (lower.has(k)) throw new MatrixPlanError(`cells ${lower.get(k)} and ${c.name} differ only in case; stored names must differ on case-insensitive file systems`, { field: "matrix" });
    lower.set(k, c.name);
  }
  const base0 = cells.find((c) => c.name === baseline)!.config;
  const bad: Record<string, string[]> = {};
  for (const c of cells) {
    const off = checkOnlyVaried(base0, c.config, vary);
    if (off.length) bad[c.name] = off;
  }
  if (Object.keys(bad).length) {
    const lines = Object.entries(bad).map(([n, ps]) => `${n}: ${ps.join(", ")}`);
    throw new MatrixPlanError(`cells differ from the baseline outside "vary" (${vary.join(", ")}): ${lines.join("; ")}`, { field: "vary", cells: bad });
  }
  return { cells, baseline, vary };
}

/**
 * One line per cell: its name, `(baseline)`, or the `vary` entries under which
 * it differs from the baseline, each with the cell's value there, in `vary` order.
 */
export function planText(plan: MatrixPlan): string {
  const base = plan.cells.find((c) => c.name === plan.baseline)!;
  const width = Math.max(...plan.cells.map((c) => c.name.length));
  return plan.cells
    .map((c) => {
      if (c.name === plan.baseline) return `${c.name.padEnd(width)}  (baseline)`;
      const diffs: string[] = [];
      diffLeaves(base.config, c.config, [], diffs);
      const pairs = plan.vary
        .filter((v) => diffs.some((p) => covers(v, p)))
        .map((p) => {
          const v = getAt(c.config, parsePointer(p));
          return `${p}=${v === undefined ? "(unset)" : JSON.stringify(v)}`;
        });
      return `${c.name.padEnd(width)}  ${pairs.join(" ") || "(same as baseline)"}`;
    })
    .join("\n");
}
