// The weights stamp of an experiment: the SHA-256 of the checkpoint file the
// task ran, as the user gave it to `exp run --weights`. coding.sh hashes
// nothing itself; it stores the value in `metadata.weights` and shows it where
// two experiments are compared, so "base vs edited" names both checkpoints and
// a comparison of one checkpoint with itself is called out.
import { isSha256Hex } from "../core/ids.ts";
import type { ExperimentResult } from "../datasets/types.ts";

/** `ExperimentResult.metadata.weights`. */
export interface WeightsStamp {
  /** SHA-256 of the checkpoint file: 64 lowercase hex characters. */
  sha256: string;
}

/** A `--weights` value as stored: trimmed and lowercased; undefined when it is not 64 hex characters. */
export function parseWeights(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  return isSha256Hex(s) ? s : undefined;
}

/** The stamp an experiment carries, or undefined (never stamped, or a value that is not a SHA-256). */
export function weightsOf(e: Pick<ExperimentResult, "metadata"> | undefined): string | undefined {
  const w = e?.metadata?.weights;
  return w && typeof w === "object" ? parseWeights((w as { sha256?: unknown }).sha256) : undefined;
}

/** The first 12 hex characters, for a line of text. */
export const shortWeights = (sha256: string): string => sha256.slice(0, 12);

/** Metadata with the stamp set; `metadata` itself when there is no stamp. */
export function withWeights(metadata: Record<string, unknown> | undefined, sha256: string | undefined): Record<string, unknown> | undefined {
  return sha256 === undefined ? metadata : { ...(metadata ?? {}), weights: { sha256 } satisfies WeightsStamp };
}

/** `o` with `weights` set when there is a stamp; `o` itself otherwise, so an unstamped object gains no key. */
export function stampedWith<T extends object>(o: T, sha256: string | undefined): T & { weights?: WeightsStamp } {
  return sha256 === undefined ? o : { ...o, weights: { sha256 } };
}

/**
 * What a comparison says about the two stamps beyond showing them. Undefined
 * when neither side is stamped, when they differ, or when one side regrades
 * the other's outputs (the same weights by construction).
 */
export function weightsWarning(a: string | undefined, b: string | undefined, regrade: boolean): string | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) {
    const [has, lacks, sha] = a !== undefined ? ["A", "B", a] : ["B", "A", b!];
    return `only ${has} records which weights it ran (${shortWeights(sha)}); ${lacks} was run without --weights, so nothing here says whether the two ran different weights`;
  }
  if (a !== b || regrade) return undefined;
  return `A and B ran the same weights (${shortWeights(a)}): B − A is not a difference between two models`;
}
