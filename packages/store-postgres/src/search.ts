// The search text an event is indexed under (events.search_folded, read by the
// GIN-indexed tsvector), and the migration step that indexes again the rows
// whose search text changed after they were stored.
import { searchableText, searchTerms, type AgentEvent } from "coding.sh/store";

/**
 * Cap on indexed text per event. tsvector values must stay under 1 MB; message
 * text has no cap of its own (tool text is already capped by searchableText).
 */
const SEARCH_TEXT_CAP = 200_000;

/** Search text for the tsvector: folded terms, so "Café" matches "cafe" like FTS5 remove_diacritics. */
export function searchFolded(e: AgentEvent): string | null {
  const text = searchableText(e);
  if (text === undefined) return null;
  const folded = searchTerms(text).join(" ");
  if (!folded) return null;
  if (folded.length <= SEARCH_TEXT_CAP) return folded;
  const cut = folded.lastIndexOf(" ", SEARCH_TEXT_CAP);
  return folded.slice(0, cut > 0 ? cut : SEARCH_TEXT_CAP);
}

export type StoredSearchRow = {
  id: string;
  kind: string;
  payload: string;
  search_folded: string | null;
};

/** The rows whose stored search text is not what searchFolded gives now, with the new text. */
export function staleSearchText(rows: readonly StoredSearchRow[]): { id: string; folded: string | null }[] {
  const out: { id: string; folded: string | null }[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const folded = searchFolded({ kind: r.kind, payload } as AgentEvent);
    if (folded !== r.search_folded) out.push({ id: r.id, folded });
  }
  return out;
}

/** What the backfill needs of a pg client: one query at a time. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Rows read per FETCH of the backfill cursor. */
export const REINDEX_BATCH = 2000;

/**
 * Error text is searchable: error events, and failed model calls, tool results, subagent
 * ends and session ends (payload.error is text). Rows stored before have no search text
 * for it, or tool text without the error. This reads the events that can have error text
 * and writes search_folded again where it changed; the stored tsvector follows.
 * One cursor, so the table is read once. Runs inside the migration's transaction.
 * The kinds are written out (not taken from searchableText's) so this step never changes.
 */
export async function reindexErrorText(c: Queryable, s: string, batch = REINDEX_BATCH): Promise<number> {
  await c.query(`DECLARE coding_sh_reindex NO SCROLL CURSOR FOR
    SELECT id, kind, payload, search_folded FROM ${s}.events
    WHERE kind = 'error' OR (kind IN ('llm.call', 'tool.end', 'subagent.end', 'session.end') AND payload LIKE '%"error":"%')`);
  let updated = 0;
  for (;;) {
    const { rows } = await c.query(`FETCH ${batch} FROM coding_sh_reindex`);
    const stale = staleSearchText(rows as StoredSearchRow[]);
    if (stale.length) {
      await c.query(
        `UPDATE ${s}.events AS e SET search_folded = v.f FROM unnest($1::text[], $2::text[]) AS v(id, f) WHERE e.id = v.id`,
        [stale.map((r) => r.id), stale.map((r) => r.folded)],
      );
      updated += stale.length;
    }
    if (rows.length < batch) break;
  }
  // On a failure the transaction rolls back, which closes the cursor too.
  await c.query("CLOSE coding_sh_reindex");
  return updated;
}
