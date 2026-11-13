// Weight edits: `notification` events with `payload.kind: "weights.edit"` (the SDKs'
// weights_edit helpers, or any client of /v1/ingest), folded into
// Session.stats.weightEdits and the `weights:edited` session tag, and read
// into one line of text for the CLI, the MCP server and the viewer's rows.
//
// A checkpoint: one `notification` with `payload.kind: "weights.checkpoint"` and
// the SHA-256 of the weights file the session saved. An edit hashes one tensor;
// `exp run --weights` records the hash of the whole file. The checkpoint event
// carries that file hash, so a session of edits and the experiments that ran its
// result name each other (Session.stats.weightEdits.checkpoints, the
// `weights:checkpoint` tag, `--where weights.checkpoint:<sha256>`).
import type { AgentEvent, WeightEditStats } from "../schema/index.ts";
import { isSha256Hex } from "./ids.ts";

export const WEIGHTS_EDIT_KIND = "weights.edit";
/** A tag, not a failure: the session recorded at least one weight edit. */
export const WEIGHTS_EDITED = "weights:edited";
export const WEIGHTS_CHECKPOINT_KIND = "weights.checkpoint";
/** A tag, not a failure: the session recorded the hash of a weights file it saved. */
export const WEIGHTS_CHECKPOINT = "weights:checkpoint";
/** Distinct tensor names kept per session; `tensors` stops counting there. */
const TENSORS_MAX = 10_000;
/** Distinct checkpoint hashes kept per session, in arrival order; later ones are not kept. */
export const CHECKPOINTS_MAX = 16;
/** Dimensions a shape may have (what the SDKs accept); a longer one is not read as a shape. */
const SHAPE_MAX = 16;

/** What the fold keeps. Serializable (node:v8). */
export interface WeightEditState {
  events: number;
  weightsChanged: number;
  tensors: Set<string>;
  /** Distinct file hashes of the session's weights.checkpoint events, in arrival order (CHECKPOINTS_MAX). */
  checkpoints: string[];
}

export const weightEditState = (): WeightEditState => ({ events: 0, weightsChanged: 0, tensors: new Set(), checkpoints: [] });

/** True for a weights.edit event. */
export const isWeightsEdit = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.kind === WEIGHTS_EDIT_KIND;

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const norm = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A SHA-256 as stored: trimmed and lowercased; undefined when it is not 64 hex characters. */
export function parseWeights(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  return isSha256Hex(s) ? s : undefined;
}

/** The first 12 hex characters: how every weights hash (a tensor's, a file's) is written in a line of text. */
export const shortWeights = (sha256: string): string => sha256.slice(0, 12);

/** The fields of a weights.edit payload that are present and well-formed. Metadata capture keeps only the numbers. */
export interface WeightsEdit {
  tensor?: string;
  shape?: number[];
  changed?: number;
  l2?: number;
  maxAbs?: number;
  baseSha256?: string;
  editedSha256?: string;
  note?: string;
}

export function weightsEditOf(p: Record<string, unknown>): WeightsEdit {
  const out: WeightsEdit = {};
  const set = <K extends keyof WeightsEdit>(k: K, v: WeightsEdit[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("tensor", text(p.tensor));
  if (Array.isArray(p.shape) && p.shape.length <= SHAPE_MAX && p.shape.every((d) => count(d) !== undefined)) out.shape = p.shape as number[];
  set("changed", count(p.changed));
  set("l2", norm(p.l2));
  set("maxAbs", norm(p.maxAbs));
  set("baseSha256", text(p.baseSha256));
  set("editedSha256", text(p.editedSha256));
  set("note", text(p.note));
  return out;
}

/**
 * OTLP: a span or a log record named `weights.edit` carries the edit in these attributes.
 * otel/map.ts reads them and sinks/otlp.ts writes them, so an edit keeps its fields both ways.
 */
export const WEIGHTS_EDIT_ATTRS: Record<keyof WeightsEdit, string> = {
  tensor: "coding_sh.weights.tensor",
  shape: "coding_sh.weights.shape",
  changed: "coding_sh.weights.changed",
  l2: "coding_sh.weights.l2",
  maxAbs: "coding_sh.weights.max_abs",
  baseSha256: "coding_sh.weights.base_sha256",
  editedSha256: "coding_sh.weights.edited_sha256",
  note: "coding_sh.weights.note",
};
/** The attributes that name the tensor or the checkpoints: metadata capture leaves them out, as it does the payload fields. */
export const WEIGHTS_EDIT_CONTENT_ATTRS: string[] = (["tensor", "shape", "baseSha256", "editedSha256", "note"] as const).map((k) => WEIGHTS_EDIT_ATTRS[k]);

/** A weights.edit payload as OTLP attributes: the fields that are present and well-formed. */
export function weightsEditAttrs(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(weightsEditOf(p))) out[WEIGHTS_EDIT_ATTRS[k as keyof WeightsEdit]] = v;
  return out;
}

/** A weights.checkpoint payload: the saved file's hash, and what is present and well-formed of the rest. */
export interface WeightsCheckpoint {
  /** SHA-256 of the saved weights file, 64 lowercase hex: the value `exp run --weights` takes. */
  sha256: string;
  /** SHA-256 of the weights file the edits started from. */
  baseSha256?: string;
  note?: string;
}

/**
 * The checkpoint a payload records, hashes lowercased. Undefined when `kind` is not
 * weights.checkpoint or `sha256` is not 64 hex characters: without the file's hash there
 * is nothing to join on, so the event is not read as a checkpoint. A `baseSha256` that is
 * not a SHA-256 is left out.
 */
export function weightsCheckpointOf(p: Record<string, unknown>): WeightsCheckpoint | undefined {
  const sha256 = p.kind === WEIGHTS_CHECKPOINT_KIND ? parseWeights(p.sha256) : undefined;
  if (sha256 === undefined) return undefined;
  const out: WeightsCheckpoint = { sha256 };
  const base = parseWeights(p.baseSha256);
  if (base !== undefined) out.baseSha256 = base;
  const note = text(p.note);
  if (note !== undefined) out.note = note;
  return out;
}

/** True for a weights.checkpoint event with a well-formed `sha256`. */
export const isWeightsCheckpoint = (e: AgentEvent): boolean => e.kind === "notification" && weightsCheckpointOf(e.payload) !== undefined;

/** True for an event that gets a `weights` line: a weight edit, or a checkpoint. */
export const isWeightsEvent = (e: AgentEvent): boolean => isWeightsEdit(e) || isWeightsCheckpoint(e);

/**
 * OTLP: a span or a log record named `weights.checkpoint` carries the checkpoint in these
 * attributes. The base hash and the note share their names with a weight edit's.
 */
export const WEIGHTS_CHECKPOINT_ATTRS: Record<keyof WeightsCheckpoint, string> = {
  sha256: "coding_sh.weights.sha256",
  baseSha256: WEIGHTS_EDIT_ATTRS.baseSha256,
  note: WEIGHTS_EDIT_ATTRS.note,
};

/** A weights.checkpoint payload as OTLP attributes; empty when it is not a checkpoint. */
export function weightsCheckpointAttrs(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(weightsCheckpointOf(p) ?? {})) out[WEIGHTS_CHECKPOINT_ATTRS[k as keyof WeightsCheckpoint]] = v;
  return out;
}

export function foldWeightEdits(s: WeightEditState, e: AgentEvent): void {
  if (e.kind !== "notification") return;
  const c = weightsCheckpointOf(e.payload);
  if (c && s.checkpoints.length < CHECKPOINTS_MAX && !s.checkpoints.includes(c.sha256)) s.checkpoints.push(c.sha256);
  if (!isWeightsEdit(e)) return;
  const w = weightsEditOf(e.payload);
  s.events++;
  s.weightsChanged += w.changed ?? 0;
  if (w.tensor && s.tensors.size < TENSORS_MAX) s.tensors.add(w.tensor);
}

/**
 * Session.stats.weightEdits, or undefined when the session recorded no weight edit and no
 * checkpoint. A session with a checkpoint and no edit has `events: 0`.
 */
export function weightEditsOf(s: WeightEditState | undefined): WeightEditStats | undefined {
  if (!s || (!s.events && !s.checkpoints.length)) return undefined;
  const out: WeightEditStats = { events: s.events, weightsChanged: s.weightsChanged };
  if (s.tensors.size) out.tensors = s.tensors.size;
  if (s.checkpoints.length) out.checkpoints = [...s.checkpoints];
  return out;
}

export function weightEditFlags(s: WeightEditState | undefined): string[] {
  const out: string[] = [];
  if (s?.events) out.push(WEIGHTS_EDITED);
  if (s?.checkpoints.length) out.push(WEIGHTS_CHECKPOINT);
  return out;
}

const int = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Four significant digits; a number that rounds past the largest double is written as it is. */
const real = (n: number): string => {
  const r = Number(n.toPrecision(4));
  return String(Number.isFinite(r) ? r : n);
};

/**
 * One line for a weights.edit payload, most useful part first:
 * `layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · 9f2c1a7e03b5 → 4b1d0c33a9e2`.
 * A part whose field is missing is left out, so an event captured in metadata mode reads
 * `1,204 weights · L2 0.0183 · max 0.004`.
 */
export function weightsEditText(p: Record<string, unknown>): string {
  const w = weightsEditOf(p);
  const parts: string[] = [];
  const dims = w.shape?.length ? `[${w.shape.join("×")}]` : "";
  if (w.tensor || dims) parts.push([w.tensor, dims].filter(Boolean).join(" "));
  if (w.changed !== undefined) {
    // The tensor's size, when the shape gives one the count fits in.
    const size = w.shape?.length ? w.shape.reduce((a, b) => a * b, 1) : undefined;
    const total = size !== undefined && Number.isSafeInteger(size) && w.changed <= size ? size : undefined;
    parts.push(`${int(w.changed)}${total !== undefined ? ` of ${int(total)}` : ""} ${w.changed === 1 && total === undefined ? "weight" : "weights"}`);
  }
  if (w.l2 !== undefined) parts.push(`L2 ${real(w.l2)}`);
  if (w.maxAbs !== undefined) parts.push(`max ${real(w.maxAbs)}`);
  if (w.baseSha256 && w.editedSha256) parts.push(`${shortWeights(w.baseSha256)} → ${shortWeights(w.editedSha256)}`);
  return parts.join(" · ");
}

/**
 * One line for a weights.checkpoint payload: `checkpoint 58899f90572c ← 0496e5111097`, the
 * saved file's hash and the base file's, or `checkpoint 58899f90572c` when no base was
 * recorded. Empty when the payload is not a checkpoint.
 */
export function weightsCheckpointText(p: Record<string, unknown>): string {
  const c = weightsCheckpointOf(p);
  if (!c) return "";
  return `checkpoint ${shortWeights(c.sha256)}${c.baseSha256 ? ` ← ${shortWeights(c.baseSha256)}` : ""}`;
}

/**
 * The `weights` line of an event's payload, for `coding.sh show`, MCP session_get and the
 * viewer's rows: a weight edit's (empty when no field is readable) or a checkpoint's.
 * Undefined when the payload is neither.
 */
export function weightsEventText(p: Record<string, unknown>): string | undefined {
  if (p.kind === WEIGHTS_EDIT_KIND) return weightsEditText(p);
  return weightsCheckpointOf(p) ? weightsCheckpointText(p) : undefined;
}

/** The edits of a session: `2 edits, 2 tensors, 66,560 weights changed`, or `no edits` for a session that only recorded a checkpoint. */
export function weightEditsText(w: WeightEditStats): string {
  if (!w.events) return "no edits";
  const parts = [`${int(w.events)} ${w.events === 1 ? "edit" : "edits"}`];
  if (w.tensors) parts.push(`${int(w.tensors)} ${w.tensors === 1 ? "tensor" : "tensors"}`);
  parts.push(`${int(w.weightsChanged)} ${w.weightsChanged === 1 ? "weight" : "weights"} changed`);
  return parts.join(", ");
}

/**
 * The session's summary row: its edits, then the checkpoints it recorded.
 * `2 edits, 2 tensors, 66,560 weights changed, checkpoint 58899f90572c`; a session with a
 * checkpoint and no edit reads `checkpoint 58899f90572c`.
 */
export function weightsSummaryText(w: WeightEditStats): string {
  const parts = w.events ? [weightEditsText(w)] : [];
  const cps = w.checkpoints ?? [];
  if (cps.length) parts.push(`${cps.length === 1 ? "checkpoint" : "checkpoints"} ${cps.map(shortWeights).join(", ")}`);
  return parts.join(", ");
}

/** `58899f90572c ran in edited (exp_…), edited-again (exp_…)`: the experiments stamped with one checkpoint's hash. */
export function checkpointRunsText(sha256: string, experiments: readonly { id: string; name: string }[]): string {
  return `${shortWeights(sha256)} ran in ${experiments.map((e) => `${e.name} (${e.id})`).join(", ")}`;
}
