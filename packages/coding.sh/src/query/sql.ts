// `coding.sh sql`: one read-only SELECT against the SQLite index.
//
// Three layers keep it read-only: a lexical check (one statement, starting with
// SELECT or WITH, no write or ATTACH/PRAGMA keyword outside quotes), a connection
// opened with SQLITE_OPEN_READONLY, and `PRAGMA query_only`. The query runs in a
// child process so a runaway join can be killed at the timeout: node:sqlite has no
// progress handler or interrupt.
import { spawn } from "node:child_process";

/** Keywords that start a write, schema change or connection change. REPLACE is allowed as the replace() function. */
const FORBIDDEN = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "DROP", "CREATE", "ALTER", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX"]);

export class SqlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlRejected";
  }
}

/**
 * Throws SqlRejected unless `sql` is one SELECT/WITH statement with no write keyword
 * outside string literals, quoted identifiers and comments.
 */
export function checkReadOnlySql(sql: string): void {
  const words: { word: string; next: string }[] = [];
  let ended = false;
  let i = 0;
  const n = sql.length;
  const nextChar = (from: number): string => {
    for (let j = from; j < n; j++) if (!/\s/.test(sql[j]!)) return sql[j]!;
    return "";
  };
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ended) throw new SqlRejected("only one statement is allowed (found text after ';')");
    if (ch === ";") {
      ended = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) throw new SqlRejected(`unterminated ${ch === "'" ? "string" : "quoted identifier"}`);
        // '' inside a string (and "" inside an identifier) is an escaped quote.
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        i = k + 1;
        break;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      words.push({ word: sql.slice(i, j).toUpperCase(), next: nextChar(j) });
      i = j;
      continue;
    }
    i++;
  }
  const first = words[0]?.word;
  if (first !== "SELECT" && first !== "WITH") throw new SqlRejected(`only SELECT and WITH queries are allowed${first ? ` (got ${first})` : ""}`);
  for (const w of words) {
    if (!FORBIDDEN.has(w.word)) continue;
    if (w.word === "REPLACE" && w.next === "(") continue;
    throw new SqlRejected(`${w.word} is not allowed: coding.sh sql is read-only`);
  }
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  /** More rows matched than the row cap. */
  truncated: boolean;
}

export interface SqlOptions {
  /** Row cap (rows beyond it are not read). */
  limit: number;
  /** Abandon the query after this long. */
  timeoutMs: number;
}

export class SqlTimeout extends Error {
  constructor(ms: number) {
    super(`the query ran past ${ms / 1000}s and was stopped`);
    this.name = "SqlTimeout";
  }
}

/** The error SQLite raised (bad column, syntax, a write the read-only connection refused). */
export class SqlFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlFailed";
  }
}

// CommonJS source for the query child (`node -e`): works from src/ and from the bundled dist/ alike.
// The job arrives as JSON on stdin; the answer leaves as one JSON line on stdout.
const CHILD = `
const { DatabaseSync } = require("node:sqlite");
const cell = (v) => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let answer;
  try {
    const job = JSON.parse(input);
    const db = new DatabaseSync(job.path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("PRAGMA query_only = ON");
    const st = db.prepare(job.sql);
    const arrays = typeof st.setReturnArrays === "function";
    if (arrays) st.setReturnArrays(true);
    let columns = typeof st.columns === "function" ? st.columns().map((c) => c.name) : undefined;
    const rows = [];
    let truncated = false;
    for (const r of st.iterate()) {
      if (rows.length >= job.limit) { truncated = true; break; }
      if (!columns) columns = Object.keys(r);
      rows.push((arrays ? r : Object.values(r)).map(cell));
    }
    db.close();
    answer = { columns: columns || [], rows, truncated };
  } catch (e) {
    answer = { error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(answer) + "\\n");
});
`;

/**
 * Runs a checked query against the SQLite file at `path`, read-only, in a child
 * process that is killed at the timeout (a worker thread stuck in one long native
 * SQLite step cannot be stopped).
 */
export async function runSql(path: string, sql: string, o: SqlOptions): Promise<SqlResult> {
  checkReadOnlySql(sql);
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=commonjs", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return new Promise<SqlResult>((resolve, reject) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new SqlTimeout(o.timeoutMs)));
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("error", (e) => finish(() => reject(new SqlFailed(e.message))));
    child.once("close", (code) =>
      finish(() => {
        let m: (SqlResult & { error?: string }) | undefined;
        try {
          m = JSON.parse(out) as SqlResult & { error?: string };
        } catch {
          return reject(new SqlFailed(`the query process exited (${code})${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""}`));
        }
        if (m.error !== undefined) reject(new SqlFailed(m.error));
        else resolve({ columns: m.columns, rows: m.rows, truncated: m.truncated });
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path, sql, limit: o.limit }));
  });
}
