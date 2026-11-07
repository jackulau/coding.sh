// coding.sh sql "<SELECT …>" [--csv] [--limit N] [--timeout S]
//
// One read-only query against the SQLite index (src/query/sql.ts has the guards).
// Other stores get a clear error: query them with their own client.
import { loadConfig } from "../../core/config.ts";
import { csvRow } from "../../query/csv.ts";
import { checkReadOnlySql, runSql, SqlFailed, SqlRejected, SqlTimeout, type SqlResult } from "../../query/sql.ts";
import { fileUrlPath, parseStoreUrl } from "../../store/factory.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, oneLine, readIngest, withContext } from "../common.ts";
import { CliError, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Redacts the user:password part of a store URL for messages. */
const safeUrl = (url: string): string => url.replace(/\/\/[^@/]*@/, "//…@");

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const sql = c.positionals.join(" ").trim();
  if (!sql) throw new UsageError("give a query, e.g. coding.sh sql \"select count(*) from sessions\"");
  try {
    checkReadOnlySql(sql);
  } catch (e) {
    if (e instanceof SqlRejected) throw new UsageError(e.message, { reason: "read_only" });
    throw e;
  }
  const limit = positiveInt(c.flags.limit, "limit") ?? 1000;
  const timeout = c.flags.timeout === undefined ? 10 : (c.flags.timeout as number);
  if (typeof timeout !== "number" || !(timeout > 0)) throw new UsageError(`--timeout must be a number of seconds above 0, got ${JSON.stringify(c.flags.timeout)}`);

  const url = loadConfig({ env: c.env }).store.index;
  const { scheme, rest } = parseStoreUrl(url);
  if (scheme !== "sqlite" || rest === ":memory:") {
    throw new CliError(`coding.sh sql reads the SQLite index; this store is ${safeUrl(url)}`, {
      reason: "unsupported_store",
      next: [
        "Export rows from any store instead:",
        "coding.sh export sessions --format csv",
        `Or query the ${scheme} database with its own client and a read-only role.`,
      ],
    });
  }
  const path = fileUrlPath(rest);

  let r: SqlResult;
  try {
    r = await withContext(c, async (ctx) => {
      await autoIngest(ctx, readIngest(c));
      return runSql(path, sql, { limit, timeoutMs: timeout * 1000 });
    });
  } catch (e) {
    if (e instanceof SqlTimeout) throw new CliError(e.message, { reason: "timeout", next: ["Narrow the query, or allow longer:", "coding.sh sql --timeout 60 \"…\""] });
    if (e instanceof SqlFailed) {
      const write = /readonly|read-only|query_only|not authorized/i.test(e.message);
      throw write ? new UsageError(`${e.message}: coding.sh sql is read-only`, { reason: "read_only" }) : new CliError(`SQLite: ${e.message}`, { reason: "sql_error", next: ["List the tables and columns:", "coding.sh sql \"select name, sql from sqlite_schema where type = 'table'\""] });
    }
    throw e;
  }

  if (out.json) {
    out.data({ columns: r.columns, rows: r.rows.map((row) => Object.fromEntries(uniqueNames(r.columns).map((k, i) => [k, row[i] ?? null]))), rowCount: r.rows.length, truncated: r.truncated });
    return 0;
  }
  if (c.flags.csv === true) {
    process.stdout.write(csvRow(r.columns) + r.rows.map(csvRow).join(""));
  } else if (!r.rows.length) {
    out.note("No rows");
  } else {
    const tty = out.stdoutTTY;
    const text = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
      return tty ? oneLine(clean(s), 80) : clean(s).replace(/[\t\n\r]+/g, " ");
    };
    out.table(r.columns, r.rows.map((row) => row.map(text)));
  }
  if (r.truncated) out.note(`Showing the first ${r.rows.length} rows (--limit raises the cap)`);
  return 0;
}

/** Column names as JSON keys: a repeated name gets `:2`, `:3`, … */
function uniqueNames(cols: string[]): string[] {
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}:${n}`;
  });
}
