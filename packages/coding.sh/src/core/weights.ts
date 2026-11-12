// Weight edits: `notification` events with `payload.kind: "weights.edit"` (the SDKs'
// weights_edit helpers, or any client of /v1/ingest), folded into
// Session.stats.weightEdits and the `weights:edited` session tag, and read
// into one line of text for the CLI, the MCP server and the viewer's rows.
import type { AgentEvent, WeightEditStats } from "../schema/index.ts";
import { isSha256Hex } from "./ids.ts";

export const WEIGHTS_EDIT_KIND = "weights.edit";
/** A tag, not a failure: the session recorded at least one weight edit. */
export const WEIGHTS_EDITED = "weights:edited";
/** Distinct tensor names kept per session; `tensors` stops counting there. */
const TENSORS_MAX = 10_000;
/** Dimensions a shape may have (what the SDKs accept); a longer one is not read as a shape. */
const SHAPE_MAX = 16;

/** What the fold keeps. Serializable (node:v8). */
export interface WeightEditState {
  events: number;
  weightsChanged: number;
  tensors: Set<string>;
}

export const weightEditState = (): WeightEditState => ({ events: 0, weightsChanged: 0, tensors: new Set() });

/** True for a weights.edit event. */
export const isWeightsEdit = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.kind === WEIGHTS_EDIT_KIND;

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const norm = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

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

export function foldWeightEdits(s: WeightEditState, e: AgentEvent): void {
  if (!isWeightsEdit(e)) return;
  const w = weightsEditOf(e.payload);
  s.events++;
  s.weightsChanged += w.changed ?? 0;
  if (w.tensor && s.tensors.size < TENSORS_MAX) s.tensors.add(w.tensor);
}

/** Session.stats.weightEdits, or undefined when the session recorded no weight edit. */
export function weightEditsOf(s: WeightEditState | undefined): WeightEditStats | undefined {
  if (!s?.events) return undefined;
  const out: WeightEditStats = { events: s.events, weightsChanged: s.weightsChanged };
  if (s.tensors.size) out.tensors = s.tensors.size;
  return out;
}

export const weightEditFlags = (s: WeightEditState | undefined): string[] => (s?.events ? [WEIGHTS_EDITED] : []);

const int = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Four significant digits; a number that rounds past the largest double is written as it is. */
const real = (n: number): string => {
  const r = Number(n.toPrecision(4));
  return String(Number.isFinite(r) ? r : n);
};

/** A SHA-256 as stored: trimmed and lowercased; undefined when it is not 64 hex characters. */
export function parseWeights(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  return isSha256Hex(s) ? s : undefined;
}

/** The first 12 hex characters: how every weights hash (a tensor's, a file's) is written in a line of text. */
export const shortWeights = (sha256: string): string => sha256.slice(0, 12);

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

/** The session line: `2 edits, 2 tensors, 66,560 weights changed`. */
export function weightEditsText(w: WeightEditStats): string {
  const parts = [`${int(w.events)} ${w.events === 1 ? "edit" : "edits"}`];
  if (w.tensors) parts.push(`${int(w.tensors)} ${w.tensors === 1 ? "tensor" : "tensors"}`);
  parts.push(`${int(w.weightsChanged)} ${w.weightsChanged === 1 ? "weight" : "weights"} changed`);
  return parts.join(", ");
}
