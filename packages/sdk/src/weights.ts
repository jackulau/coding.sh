// Weight edits: one `notification` event per edit, `payload.kind` "weights.edit",
// and one per saved file, `payload.kind` "weights.checkpoint".
//
//   weightsEdit({
//     tensor: "model.layers.3.mlp.down_proj.weight",
//     shape: [4096, 11008],
//     changed: 1204,
//     l2: 0.0183,
//     maxAbs: 0.004,
//     baseSha256: shaBefore,
//     editedSha256: shaAfter,
//   });
//   weightsCheckpoint({ sha256: shaOfEditedFile, baseSha256: shaOfBaseFile });
//
// The caller's script computes the hashes and norms; this module only checks
// them and sends them. weightsEdit() and weightsCheckpoint() never throw into
// the app: a bad value drops the event with a warning (once per process) and
// they return false. weightsDelta() is a helper you call on purpose, so it
// throws on bad input. The Python SDK's weights_edit() and weights_checkpoint()
// send the same events (packages/sdk-python, _weights.py);
// test/fixtures/weights-edit.json holds what both must send. Payload fields are
// in docs/reference/api.md.
import { config, warnOnce } from "./client.ts";
import { recordNotification } from "./context.ts";
import { errorMessage, quiet, truncate } from "./util.ts";

const KIND = "weights.edit";
const CHECKPOINT_KIND = "weights.checkpoint";
const SHA256 = /^[0-9a-fA-F]{64}$/;
const MAX_DIMS = 16;

/** One weight edit, as `weightsEdit()` records it. */
export interface WeightsEdit {
  /** The tensor's name. */
  tensor: string;
  /** Its dimensions: at most 16 non-negative integers. */
  shape: readonly number[];
  /** How many weights differ: an integer from 0 to the product of `shape`. */
  changed: number;
  /** L2 norm of the change (edited minus base): a finite number >= 0. */
  l2: number;
  /** Largest absolute value of the change: a finite number >= 0. */
  maxAbs: number;
  /** sha256 of the tensor before the edit: 64 hex characters, sent in lowercase. */
  baseSha256: string;
  /** sha256 of the tensor after the edit: 64 hex characters, sent in lowercase. */
  editedSha256: string;
  /** Free text, kept only in full capture mode. */
  note?: string;
}

/** One saved weights file, as `weightsCheckpoint()` records it. */
export interface WeightsCheckpoint {
  /** sha256 of the whole weights file, the value `coding.sh exp run --weights` takes: 64 hex characters, sent in lowercase. */
  sha256: string;
  /** sha256 of the file the edits started from: 64 hex characters, sent in lowercase. */
  baseSha256?: string;
  /** Free text, kept only in full capture mode. */
  note?: string;
}

/** What `weightsDelta()` returns. It spreads into `weightsEdit()`. */
export interface WeightsDelta {
  /** Dimensions of both arrays. */
  shape: number[];
  /** How many values differ. */
  changed: number;
  /** L2 norm of edited minus base. */
  l2: number;
  /** Largest absolute value of edited minus base. */
  maxAbs: number;
}

/** What `weightsDelta()` reads: nested arrays of numbers, typed arrays such as `Float32Array`, or arrays of typed arrays. */
export type WeightsArray = readonly number[] | (ArrayBufferView & ArrayLike<number>) | readonly WeightsArray[];

const shown = (v: unknown): string => truncate(typeof v === "string" ? JSON.stringify(v) : String(v), 80).text;

function count(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer, got ${shown(v)}`);
  return v;
}

function norm(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${what} must be a finite number >= 0, got ${shown(v)}`);
  return v;
}

function sha(v: unknown, what: string): string {
  if (typeof v !== "string" || !SHA256.test(v)) throw new Error(`${what} must be 64 hex characters`);
  return v.toLowerCase();
}

/** A string field, cut like every other SDK string. */
function put(p: Record<string, unknown>, key: string, s: string): void {
  const t = truncate(s);
  p[key] = t.text;
  if (t.truncated) p.truncated = true;
}

/** The event payload for an edit. Throws an Error that says which value is invalid. */
function payloadOf(edit: WeightsEdit): Record<string, unknown> {
  if (typeof edit !== "object" || edit === null) throw new Error("expected an object with tensor, shape, changed, l2, maxAbs, baseSha256 and editedSha256");
  const { tensor, shape, changed, l2, maxAbs, baseSha256, editedSha256, note } = edit as { [K in keyof WeightsEdit]: unknown };
  if (typeof tensor !== "string" || !tensor) throw new Error("tensor must be a non-empty string");
  if (!Array.isArray(shape) || shape.length > MAX_DIMS) throw new Error(`shape must be an array of at most ${MAX_DIMS} integers`);
  // Array.from visits the holes of a sparse array, so they are rejected like any other non-integer.
  const dims = Array.from(shape, (d) => count(d, "shape dimension"));
  const n = count(changed, "changed");
  // Exact for this comparison: a product past 2^53 only rounds to a value still above any `changed`.
  const total = dims.reduce((a, d) => a * d, 1);
  if (n > total) throw new Error(`changed (${n}) is larger than the tensor (${total} weights)`);
  const p: Record<string, unknown> = { kind: KIND };
  put(p, "tensor", tensor);
  p.shape = dims;
  p.changed = n;
  p.l2 = norm(l2, "l2");
  p.maxAbs = norm(maxAbs, "maxAbs");
  p.baseSha256 = sha(baseSha256, "baseSha256");
  p.editedSha256 = sha(editedSha256, "editedSha256");
  putNote(p, note, "weights-edit-note", "weightsEdit");
  return p;
}

/** Sets `note` in full capture mode. One that is not a string is dropped with a warning; the event is still recorded. */
function putNote(p: Record<string, unknown>, note: unknown, key: string, fn: string): void {
  if (note === undefined || note === null) return;
  if (typeof note !== "string") quiet(warnOnce)(key, `[coding.sh] ${fn} ignored a note that is not a string`);
  else if (note && config().capture === "full") put(p, "note", note);
}

/** The event payload for a checkpoint. Throws an Error that says which value is invalid. */
function checkpointPayloadOf(checkpoint: WeightsCheckpoint): Record<string, unknown> {
  if (typeof checkpoint !== "object" || checkpoint === null) throw new Error("expected an object with sha256");
  const { sha256, baseSha256, note } = checkpoint as { [K in keyof WeightsCheckpoint]: unknown };
  const p: Record<string, unknown> = { kind: CHECKPOINT_KIND, sha256: sha(sha256, "sha256") };
  if (baseSha256 !== undefined && baseSha256 !== null) p.baseSha256 = sha(baseSha256, "baseSha256");
  putNote(p, note, "weights-checkpoint-note", "weightsCheckpoint");
  return p;
}

/**
 * Records one weight edit as a `notification` event with `payload.kind` "weights.edit".
 * The Python SDK's `weights_edit()` sends the same event.
 *
 * Returns true only when the event was queued. Returns false when a value is
 * invalid, with one warning per process. Returns false without a warning when
 * the SDK is off or shut down or the queue is full. Never throws.
 *
 * A `note` that is not a string is dropped with one warning; the edit is still
 * recorded. Inside `trace()` or `span()` the edit joins that trace. Outside
 * them it gets a session of its own, or a turn of the `withSession()` session,
 * so group a run of edits inside `trace()`.
 */
export function weightsEdit(edit: WeightsEdit): boolean {
  try {
    let payload: Record<string, unknown>;
    try {
      payload = payloadOf(edit);
    } catch (err) {
      quiet(warnOnce)("weights-edit", `[coding.sh] weightsEdit dropped an event: ${errorMessage(err)}`);
      return false;
    }
    return recordNotification(KIND, payload);
  } catch {
    return false;
  }
}

/**
 * Records one saved weights file as a `notification` event with `payload.kind`
 * "weights.checkpoint". The Python SDK's `weights_checkpoint()` sends the same event.
 *
 * `sha256` is the hash of the whole file, as your script computed it: the value
 * `coding.sh exp run --weights` takes, so the session that recorded the edits and
 * the experiment that ran the file name each other. `baseSha256` is the hash of
 * the file the edits started from.
 *
 * Returns true only when the event was queued. Returns false when a value is
 * invalid, with one warning per process. Returns false without a warning when
 * the SDK is off or shut down or the queue is full. Never throws.
 *
 * A `note` that is not a string is dropped with one warning; the checkpoint is
 * still recorded. Inside `trace()` or `span()` the checkpoint joins that trace.
 * Outside them it gets a session of its own, or a turn of the `withSession()`
 * session, so record it inside the `trace()` that recorded the edits.
 */
export function weightsCheckpoint(checkpoint: WeightsCheckpoint): boolean {
  try {
    let payload: Record<string, unknown>;
    try {
      payload = checkpointPayloadOf(checkpoint);
    } catch (err) {
      quiet(warnOnce)("weights-checkpoint", `[coding.sh] weightsCheckpoint dropped an event: ${errorMessage(err)}`);
      return false;
    }
    return recordNotification(CHECKPOINT_KIND, payload);
  } catch {
    return false;
  }
}

const isTyped = (x: unknown): x is ArrayBufferView & ArrayLike<unknown> => ArrayBuffer.isView(x) && !(x instanceof DataView);

const isArrayish = (x: unknown): x is ArrayLike<unknown> => Array.isArray(x) || isTyped(x);

/** Checks that x is a rectangular array of finite numbers and returns its shape. */
function shapeOf(x: unknown): number[] {
  if (!isArrayish(x)) throw new TypeError(`expected an array or a typed array, got ${x === null ? "null" : typeof x}`);
  const shape: number[] = [];
  let leafDepth = -1;
  const walk = (v: unknown, depth: number): void => {
    if (isArrayish(v)) {
      if (depth >= MAX_DIMS) throw new RangeError(`nested more than ${MAX_DIMS} levels deep`);
      if (shape.length === depth) shape.push(v.length);
      else if (shape[depth] !== v.length) throw new RangeError("ragged array");
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1);
      return;
    }
    if (leafDepth === -1) leafDepth = depth;
    else if (leafDepth !== depth) throw new RangeError("ragged array");
    if (typeof v !== "number") throw new TypeError(`values must be numbers, got ${shown(v)}`);
    if (!Number.isFinite(v)) throw new RangeError(`values must be finite, got ${v}`);
  };
  walk(x, 0);
  if (leafDepth !== -1 && leafDepth !== shape.length) throw new RangeError("ragged array");
  return shape;
}

interface Sums {
  changed: number;
  sq: number;
  peak: number;
}

/** Adds up edited minus base over two arrays that shapeOf() found to have the same shape. */
function diff(a: ArrayLike<unknown>, b: ArrayLike<unknown>, sums: Sums): void {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (typeof x !== "number") {
      diff(x as ArrayLike<unknown>, b[i] as ArrayLike<unknown>, sums);
      continue;
    }
    const d = Math.abs((b[i] as number) - x);
    if (d === 0) continue;
    sums.changed++;
    sums.sq += d * d;
    if (d > sums.peak) sums.peak = d;
  }
}

/**
 * Computes `{ shape, changed, l2, maxAbs }` for two arrays of the same shape,
 * ready to spread into `weightsEdit()`. The Python SDK's `weights_delta()`
 * gives the same numbers, with `max_abs` for `maxAbs`.
 *
 * Takes nested arrays of numbers, typed arrays such as `Float32Array`, or
 * arrays of typed arrays, up to 16 levels deep, holding finite numbers. It
 * reads every value twice on the calling thread and copies nothing.
 *
 * A pure helper you call on purpose, unlike the never-throw `weightsEdit()`:
 * it throws on bad input. A `TypeError` for an argument that is not an array
 * or a value that is not a number (null and BigInt included). A `RangeError`
 * for a shape mismatch, ragged or too deep nesting, NaN or Infinity.
 */
export function weightsDelta(base: WeightsArray, edited: WeightsArray): WeightsDelta {
  const shape = shapeOf(base);
  const other = shapeOf(edited);
  if (shape.length !== other.length || shape.some((d, i) => d !== other[i])) throw new RangeError(`shapes differ: [${shape.join(", ")}] and [${other.join(", ")}]`);
  const sums: Sums = { changed: 0, sq: 0, peak: 0 };
  diff(base as ArrayLike<unknown>, edited as ArrayLike<unknown>, sums);
  return { shape, changed: sums.changed, l2: Math.sqrt(sums.sq), maxAbs: sums.peak };
}
