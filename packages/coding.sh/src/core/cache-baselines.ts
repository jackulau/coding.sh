// Published prompt-cache hit rates per coding agent, for `usage --baseline`: a reference point for
// the hit rate coding.sh measures. Requesty's April 2026 dataset (CC BY 4.0), from the rows of its
// data.json. Requesty gives no sample size or method beyond "cached_tokens / input_tokens" over its
// gateway traffic; coding.sh's rate is cache reads / (input + cache reads + cache writes) over the
// sessions captured here. The comparison is directional, never coding.sh's own claim.

export interface CacheBaseline {
  /** The published hit rate, 0-1. */
  rate: number;
  /** The setup as the source names it. */
  name: string;
  source: "requesty";
  period: "2026-04";
  url: string;
}

const URL = "https://www.requesty.ai/data/coding-agent-cache-hit-rate-apr-2026";

const row = (name: string, rate: number): CacheBaseline => Object.freeze({ rate, name, source: "requesty" as const, period: "2026-04" as const, url: URL });

/** By coding.sh agent id. Setups coding.sh has no adapter for (Zed, Roo Code, Forge, Cline, Kilo Code) are listed under their own names. */
export const CACHE_BASELINES: Readonly<Record<string, CacheBaseline>> = Object.freeze({
  "claude-code": row("Claude Code", 0.919),
  opencode: row("OpenCode", 0.89),
  aider: row("Aider", 0.84),
  zed: row("Zed", 0.801),
  "roo-code": row("Roo Code", 0.736),
  forge: row("Forge", 0.639),
  cline: row("Cline", 0.614),
  "kilo-code": row("Kilo Code", 0.455),
});

/** What the source says, for a note next to the numbers. */
export const CACHE_BASELINE_NOTE = `VS PUBLISHED: Requesty's reported prompt-cache hit rate per coding agent for Apr 2026 (cached_tokens / input_tokens on its gateway; no sample size or method given; ${URL}). coding.sh's rate is cacheRead / (input + cacheRead + cacheWrite) over your sessions, which may differ from Requesty's denominator, so the delta is directional. The lever is stats.cacheBreaks: coding.sh cache doctor ranks what breaks the prefix.`;

/** The published baseline for a coding.sh agent id, or undefined: no guess for an agent the source does not list. */
export function cacheBaseline(agent: string): CacheBaseline | undefined {
  return Object.hasOwn(CACHE_BASELINES, agent) ? CACHE_BASELINES[agent] : undefined;
}
