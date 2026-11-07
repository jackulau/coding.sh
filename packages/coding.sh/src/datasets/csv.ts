// RFC 4180 CSV, hand-rolled: quoted fields, "" escapes, CRLF / LF / CR record
// separators, newlines inside quotes, a leading UTF-8 BOM. Lenient where the
// RFC is silent (a bare quote inside an unquoted field is kept literally),
// strict where silence would corrupt data (an unterminated quote throws).

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "CsvError";
    this.line = line;
  }
}

export interface CsvParseOpts {
  /** Field delimiter (default ","). */
  delimiter?: string;
  /** Drop records that are a single empty field (blank lines). Default true. */
  skipEmptyLines?: boolean;
}

/** Parse CSV text into records (arrays of fields). */
export function parseCsv(text: string, opts: CsvParseOpts = {}): string[][] {
  const delim = opts.delimiter ?? ",";
  if (delim.length !== 1 || delim === '"' || delim === "\n" || delim === "\r") {
    throw new RangeError(`parseCsv: invalid delimiter ${JSON.stringify(delim)}`);
  }
  const skipEmpty = opts.skipEmptyLines ?? true;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  let line = 1;
  let quoted = false;
  let quoteLine = 0;
  // True once the current record has seen any character (so "a,b\n" does not
  // produce a trailing empty record but "\n" between records can be detected).
  let started = false;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (!(skipEmpty && record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    started = false;
  };

  while (i < s.length) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        // After a closing quote only a delimiter or record end may follow; be
        // lenient and append anything else literally (common in hand-edited files).
        continue;
      }
      if (ch === "\r" && s[i + 1] === "\n") {
        field += "\r\n";
        i += 2;
        line++;
        continue;
      }
      if (ch === "\n" || ch === "\r") line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      // A quote opens a quoted field only at the field's start.
      quoted = true;
      quoteLine = line;
      started = true;
      i++;
      continue;
    }
    if (ch === delim) {
      endField();
      started = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      line++;
      continue;
    }
    field += ch;
    started = true;
    i++;
  }
  if (quoted) throw new CsvError("unterminated quoted field", quoteLine);
  if (started || field !== "" || record.length > 0) endRecord();
  return records;
}

/** Parse CSV with a header row into objects keyed by header name. */
export function parseCsvObjects(text: string, opts: CsvParseOpts = {}): Record<string, string>[] {
  const rows = parseCsv(text, opts);
  if (rows.length === 0) return [];
  const header = (rows[0] as string[]).map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) throw new CsvError(`duplicate column ${JSON.stringify(h)}`, 1);
    seen.add(h);
  }
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as string[];
    if (row.length > header.length) {
      throw new CsvError(`record has ${row.length} fields, header has ${header.length}`, r + 1);
    }
    const o: Record<string, string> = {};
    header.forEach((h, j) => {
      o[h] = row[j] ?? "";
    });
    out.push(o);
  }
  return out;
}

function quoteField(v: string, delim: string): string {
  if (v === "") return "";
  if (v.includes(delim) || v.includes('"') || v.includes("\n") || v.includes("\r") || v.trim() !== v) {
    return `"${v.replaceAll('"', '""')}"`;
  }
  return v;
}

/** Serialize records as RFC 4180 CSV (CRLF line breaks, trailing CRLF). */
export function stringifyCsv(rows: readonly (readonly string[])[], opts: { delimiter?: string } = {}): string {
  const d = opts.delimiter ?? ",";
  return rows.map((r) => r.map((f) => quoteField(f, d)).join(d) + "\r\n").join("");
}
