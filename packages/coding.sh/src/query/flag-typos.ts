// A session flag typed wrong (`--flag no-verificaton`, `--where flag:no-verificaton`). After a
// command finds nothing, a flag name that coding.sh never sets and no stored session carries, but
// that is near one that exists, is a typo: rejected with the nearest flag, as an unknown --agent is.
import { suggest, UsageError } from "../cli/args.ts";
import { FLAGS } from "../core/sessions.ts";
import type { IndexStore } from "../core/types.ts";
import { facetCounts } from "./run.ts";
import type { Node, Query } from "./where.ts";

/** Most of the stored sessions' flags a suggestion picks from, the most common first. */
const STORED_FLAGS = 500;

/**
 * The `flag:` values a query asks for: plain values (no wildcard) outside a negation. A plain value
 * matches a flag exactly, case included, as `--flag` does.
 */
export function flagValues(n: Node | undefined): string[] {
  if (!n) return [];
  if (n.t === "and" || n.t === "or") return n.items.flatMap(flagValues);
  if (n.t !== "cmp" || n.key !== "flag" || n.op !== ":") return [];
  return n.values.filter((v) => v.kind === "eq").map((v) => v.raw);
}

/**
 * After an empty result: a `--flag` value, or a `flag:` value in `where`, that coding.sh never sets
 * and no stored session carries, but that is near a flag coding.sh sets or a session carries, is a
 * usage error naming that flag. A value some session carries is no typo, though this search found
 * none; nor is one near nothing, such as a tag of your own.
 */
export async function rejectFlagTypos(index: IndexStore, flag: string | undefined, where: Query | undefined): Promise<void> {
  const typed = flagValues(where?.root).map((value) => ({ value, option: false }));
  if (flag !== undefined) typed.unshift({ value: flag, option: true });
  if (!typed.length) return;
  const set: string[] = Object.values(FLAGS);
  let stored: string[] | undefined;
  for (const { value, option } of typed) {
    if (set.includes(value)) continue;
    if ((await index.listSessions({ flag: value, limit: 1 })).length) continue;
    stored ??= ((await facetCounts(index, {}, ["flag"], { limit: STORED_FLAGS })).flag ?? []).map((f) => f.value);
    const near = suggest(value, [...new Set([...set, ...stored])]);
    if (near) throw new UsageError(`Unknown session flag ${JSON.stringify(value)}`, { suggestion: option ? `--flag ${near}` : `flag:${near}`, reason: "unknown_flag" });
  }
}
