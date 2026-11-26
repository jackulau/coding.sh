// Which session flags are failures. Every count and rate of failures uses this
// rule: stats FAIL%, `is:flagged` in every store, the sessions footer, tree, the
// viewer, /metrics, MCP, evals and the status line. A flag with a colon is a tag
// (gateway:vercel, skill:pdf). A flag that FLAG_DIAGNOSIS marks context-only
// (compaction, step-retried, resumed) describes the session and is not a
// failure either.
import { FLAG_DIAGNOSIS } from "../refine/taxonomy.ts";

/** Flags with no colon that are context, not failures: compaction, step-retried and resumed. */
export const CONTEXT_FLAGS: readonly string[] = Object.freeze(Object.keys(FLAG_DIAGNOSIS).filter((f) => !f.includes(":") && FLAG_DIAGNOSIS[f] === "context-only"));

const CONTEXT = new Set(CONTEXT_FLAGS);

/** A flag that names a failure: it has no colon and is not in CONTEXT_FLAGS. */
export const isFailureFlag = (f: string): boolean => !f.includes(":") && !CONTEXT.has(f);

/** The failure flags among `flags`, in their order. */
export const failureFlags = (flags: readonly string[]): string[] => flags.filter(isFailureFlag);
