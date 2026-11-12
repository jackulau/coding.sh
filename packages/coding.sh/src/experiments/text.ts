// Plain-text rendering primitives for CLI output. Color is opt-in per call
// (`{color: boolean}`): callers enable it only for a TTY without NO_COLOR, so
// piped output and `--json` stay clean.

import { cutToWidth, padToWidth, textWidth } from "../core/width.ts";

export interface RenderOpts {
  color: boolean;
  /** Max rows in per-case lists (regressions, noisy labels, failures). Default 20. */
  limit?: number;
}

const CODES = { red: 31, green: 32, yellow: 33, dim: 2, bold: 1, cyan: 36 } as const;
export type Style = keyof typeof CODES;

export function paint(s: string, style: Style, color: boolean): string {
  return color ? `\u001b[${CODES[style]}m${s}\u001b[0m` : s;
}

/** Display width in terminal cells: strips ANSI; wide (CJK) characters count 2. */
export const width = textWidth;

const pad = padToWidth;

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** Aligned columns separated by two spaces; header underlined with dashes. No trailing spaces. */
export function table(columns: readonly Column[], rows: readonly (readonly string[])[], opts: { color: boolean }): string {
  const widths = columns.map((c, i) => Math.max(width(c.header), ...rows.map((r) => width(r[i] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => pad(c, widths[i] as number, columns[i]?.align ?? "left"))
      .join("  ")
      .replace(/\s+$/, "");
  const header = paint(line(columns.map((c) => c.header)), "bold", opts.color);
  const rule = paint(widths.map((w) => "-".repeat(w)).join("  "), "dim", opts.color);
  return [header, rule, ...rows.map(line)].join("\n");
}

export function pct(x: number, digits = 1): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—";
}

export function signedPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "—";
  const s = (x * 100).toFixed(digits);
  return x > 0 ? `+${s}pp` : `${s}pp`;
}

export function fixed(x: number | undefined, digits = 2): string {
  return x !== undefined && Number.isFinite(x) ? x.toFixed(digits) : "—";
}

export function ms(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x < 1000) return `${Math.round(x)}ms`;
  if (x < 60_000) return `${(x / 1000).toFixed(1)}s`;
  return `${(x / 60_000).toFixed(1)}m`;
}

export function pValue(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}

/** The text on one line, cut to `n` terminal cells. */
export function truncate(s: string, n: number): string {
  return cutToWidth(s.replace(/\s+/g, " ").trim(), n);
}
