// The search text an event is indexed under (events.search_text, read through
// the ngram skip index), and which stored rows need it written again.
import { searchableText, searchTerms, type AgentEvent } from "coding.sh/store";

/** Cap on indexed text per event, as the Postgres store. */
const SEARCH_TEXT_CAP = 200_000;

/** Folded search text with a leading space, so a word-prefix match is `LIKE '% term%'`. Empty when the event has none. */
export function searchText(e: AgentEvent): string {
  const text = searchableText(e);
  if (text === undefined) return "";
  let folded = searchTerms(text).join(" ");
  if (!folded) return "";
  if (folded.length > SEARCH_TEXT_CAP) {
    const cut = folded.lastIndexOf(" ", SEARCH_TEXT_CAP);
    folded = folded.slice(0, cut > 0 ? cut : SEARCH_TEXT_CAP);
  }
  return ` ${folded}`;
}

/**
 * Of these stored event rows (`SELECT *`), the ones whose search_text is not what
 * searchText gives now, each with the new text. A payload that is not JSON is left.
 */
export function staleSearchRows<R extends { kind?: unknown; payload?: unknown; search_text?: unknown }>(rows: readonly R[]): R[] {
  const out: R[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(r.payload)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = searchText({ kind: r.kind, payload } as AgentEvent);
    if (text !== r.search_text) out.push({ ...r, search_text: text });
  }
  return out;
}
