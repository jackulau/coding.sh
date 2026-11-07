// RFC 4180 CSV cells for `coding.sh sql --csv` and `coding.sh export --format csv`.

/**
 * One CSV cell. Quoted when it holds a comma, quote, CR or LF. Text that a
 * spreadsheet would run as a formula (= + - @ or a leading tab/CR) gets a leading
 * apostrophe, since captured agent text is untrusted. Numbers are written as is.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: readonly unknown[]): string => cells.map(csvCell).join(",") + "\r\n";
