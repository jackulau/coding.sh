// The landing page's `coding.sh usage --since 7d` table, read from the real
// command's output on the screenshot home (seed.mjs writes it to
// src/data/usage-rows.json and src/pages/index.astro imports it).

/** The columns the landing shows, by their header in the command's output. */
export const USAGE_COLUMNS = ["AGENT", "SESSIONS", "TOKENS", "COST"];

/** Rows of those columns from the tab-separated output of `coding.sh usage` (what it prints when piped). */
export function usageRows(output) {
  const [head, ...lines] = output.split("\n").filter((l) => l.trim());
  const cols = head.split("\t");
  const at = USAGE_COLUMNS.map((c) => cols.indexOf(c));
  if (at.includes(-1)) throw new Error(`usage output has no ${USAGE_COLUMNS.filter((_, i) => at[i] === -1).join(", ")} column: ${head}`);
  return { command: "coding.sh usage --since 7d", head: USAGE_COLUMNS, rows: lines.map((l) => at.map((i) => l.split("\t")[i])) };
}
