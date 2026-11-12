// The join between sessions and experiments on a weights file's SHA-256.
// A session records the hash of the file it saved in a `weights.checkpoint`
// event (Session.stats.weightEdits.checkpoints); an experiment records the hash
// of the file its task ran in its weights stamp (`exp run --weights`). The same
// hash on both sides says which session's edits an experiment evaluated, and
// which experiments ran what a session produced.
//
// Both lookups are extras on top of what a command prints anyway: when the
// store can't answer (a store plugin without the key, no experiments), they
// return nothing and the caller prints nothing more.
import type { IndexStore } from "../core/types.ts";
import { weightEditsText } from "../core/weights.ts";
import type { ExperimentResult } from "../datasets/types.ts";
import { findSessions } from "../query/run.ts";
import { parseWhere } from "../query/where.ts";
import type { WeightEditStats } from "../schema/index.ts";
import { parseWeights, weightsOf, type WeightsStamp } from "./weights.ts";

/** Sessions named per weights hash, newest first. */
export const CHECKPOINT_SESSIONS_MAX = 5;
/** Sessions read per query. */
const SCAN_MAX = 1000;
/**
 * Hashes asked for in one query. A `--where` query holds 2,000 characters at most (parseWhere), and
 * `weights.checkpoint:` with 25 hashes and their commas is 1,643: a list of experiments with more
 * distinct stamps than that is looked up in several queries.
 */
const HASHES_PER_QUERY = 25;
/** Experiments read to find the ones that ran a session's checkpoints, newest first. */
const EXPERIMENTS_MAX = 200;

/** A session whose `weights.checkpoint` event recorded a hash, with the edits it recorded. */
export interface CheckpointSession {
  id: string;
  edits: WeightEditStats;
}

/** Weights hash → the sessions that recorded it as a checkpoint. A hash no session recorded has no entry. */
export type CheckpointSessions = ReadonlyMap<string, readonly CheckpointSession[]>;

/**
 * The sessions that recorded each of these hashes as a checkpoint: newest first, at most
 * CHECKPOINT_SESSIONS_MAX per hash. Values that are not a SHA-256 are skipped. Empty when
 * none matches or the session index can't answer the query.
 */
export async function checkpointSessions(index: IndexStore, hashes: Iterable<string | undefined>): Promise<CheckpointSessions> {
  const want = new Set<string>();
  for (const h of hashes) {
    const sha = parseWeights(h);
    if (sha) want.add(sha);
  }
  const out = new Map<string, CheckpointSession[]>();
  if (!want.size) return out;
  const all = [...want];
  try {
    for (let i = 0; i < all.length; i += HASHES_PER_QUERY) {
      // A hash is in one query only, so each hash's sessions arrive in that query's order: newest first.
      const asked = new Set(all.slice(i, i + HASHES_PER_QUERY));
      const { sessions } = await findSessions(index, parseWhere(`weights.checkpoint:${[...asked].join(",")}`), { limit: SCAN_MAX });
      for (const s of sessions) {
        const edits = s.stats.weightEdits;
        for (const sha of edits?.checkpoints ?? []) {
          if (!asked.has(sha)) continue;
          const list = out.get(sha) ?? [];
          if (list.length < CHECKPOINT_SESSIONS_MAX) list.push({ id: s.id, edits: edits! });
          out.set(sha, list);
        }
      }
    }
  } catch {
    // An older store plugin has no SQL for the key, or the index is not there: nothing to add.
    return new Map();
  }
  return out;
}

/**
 * One line per session that recorded this hash, for under the line that shows the stamp:
 * `  edits    <session id>  2 edits, 2 tensors, 66,560 weights changed`.
 */
export function checkpointLines(sha256: string | undefined, by: CheckpointSessions | undefined): string[] {
  return ((sha256 !== undefined && by?.get(sha256)) || []).map((s) => `  edits    ${s.id}  ${weightEditsText(s.edits)}`);
}

/** Sets `sessions` (the ids) on a stamp whose hash some session recorded; leaves any other stamp as it is. */
export function withSessions<T extends { weights?: WeightsStamp }>(o: T, by: CheckpointSessions): T {
  const found = o.weights ? by.get(o.weights.sha256) : undefined;
  if (o.weights && found?.length) o.weights = { ...o.weights, sessions: found.map((s) => s.id) };
  return o;
}

/** An experiment that ran a checkpoint. */
export interface CheckpointExperiment {
  id: string;
  name: string;
}

/**
 * The experiments stamped with each of these hashes, newest first, among the newest
 * EXPERIMENTS_MAX. A hash no experiment ran has no entry. Empty when the experiments can't be read.
 */
export async function checkpointExperiments(store: { listExperiments(filter: { limit: number }): Promise<ExperimentResult[]> }, hashes: readonly string[] | undefined): Promise<Map<string, CheckpointExperiment[]>> {
  const out = new Map<string, CheckpointExperiment[]>();
  if (!hashes?.length) return out;
  try {
    for (const e of await store.listExperiments({ limit: EXPERIMENTS_MAX })) {
      const sha = weightsOf(e);
      if (sha === undefined || !hashes.includes(sha)) continue;
      out.set(sha, [...(out.get(sha) ?? []), { id: e.id, name: e.name }]);
    }
  } catch {
    return new Map();
  }
  return out;
}
