// `coding.sh blame <path>[:line[-end]]`: git blame, with the session that
// wrote each line. git blame names the commit that last changed the line and
// the line's number in that commit; attributeRepo says which session wrote
// that commit line. A line no session wrote has no session.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot } from "../core/git.ts";
import { blame } from "./git.ts";
import { attributeRepo, AttributionError, type AttributeOptions, type AttributionReport, type SessionSummary } from "./index.ts";
import type { AttributionMethod } from "./match.ts";
import type { SourceContext } from "./sources.ts";

export interface BlameRow {
  line: number;
  commit: string;
  text: string;
  sessionId?: string;
  agent?: string;
  model?: string;
  confidence?: number;
  method?: AttributionMethod;
}

export interface BlameResult {
  root: string;
  rev: string;
  path: string;
  rows: BlameRow[];
  /** Sessions credited with at least one of these lines, most lines first. */
  sessions: SessionSummary[];
  /** Lines no session wrote. */
  unattributed: number;
}

/** "src/a.ts:12" / "src/a.ts:12-20" / "src/a.ts" → path and optional range. A Windows drive colon is kept. */
export function parseBlameTarget(arg: string): { path: string; lines?: [number, number] } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(arg);
  if (!m || !m[1]) return { path: arg };
  const a = Number(m[2]);
  const b = m[3] !== undefined ? Number(m[3]) : a;
  if (a < 1) throw new AttributionError(`${arg}: line numbers start at 1`, "invalid_range");
  if (b < a) throw new AttributionError(`${arg}: the range ends before it starts (${a}-${b})`, "invalid_range");
  return { path: m[1], lines: [a, b] };
}

export async function blameFile(ctx: SourceContext, opts: Omit<AttributeOptions, "since"> & { path: string; lines?: [number, number]; report?: AttributionReport }): Promise<BlameResult> {
  const root = await repoRoot(opts.cwd);
  if (!root) throw new AttributionError(`not a git repository: ${opts.cwd}`, "not_a_repo");
  const abs = isAbsolute(opts.path) ? opts.path : resolve(opts.cwd, opts.path);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new AttributionError(`${opts.path} is outside ${root}`, "not_found");
  const path = rel.split(sep).join("/");
  const report = opts.report ?? (await attributeRepo(ctx, opts));
  let lines;
  try {
    lines = await blame(root, path, report.rev, opts.lines);
  } catch (e) {
    // git says why after "fatal:": "no such path x in HEAD", "file x has only 2 lines". The git
    // command line before it is not for the reader.
    const msg = (e as Error).message;
    const why = /fatal:\s*(.+)/.exec(msg)?.[1]?.trim() ?? msg.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "git blame failed";
    const at = report.rev.slice(0, 8);
    const only = /has only (\d+) lines?/.exec(why);
    if (only) {
      const n = Number(only[1]);
      throw new AttributionError(`${path} has ${n} line${n === 1 ? "" : "s"} at ${at}; ask for lines 1-${n}`, "not_found", ["Blame the whole file:", `coding.sh blame ${/^[\w./@:+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`}`]);
    }
    if (/no such path|does not exist|not in /i.test(why)) throw new AttributionError(`${path} is not in ${at}`, "not_found");
    throw new AttributionError(`${path} at ${at}: ${why}`, "not_found");
  }
  const commits = new Map(report.commits.map((c) => [c.commit, c]));
  const counts = new Map<string, number>();
  const rows: BlameRow[] = lines.map((l) => {
    const row: BlameRow = { line: l.line, commit: l.commit, text: l.text };
    const c = commits.get(l.commit);
    const a = c?.attributions.find((x) => x.path === l.origPath && x.ranges.some((r) => r.start <= l.origLine && l.origLine <= r.end));
    if (a) {
      row.sessionId = a.sessionId;
      row.agent = a.agent;
      if (a.model) row.model = a.model;
      row.confidence = a.confidence;
      row.method = a.method;
      counts.set(a.sessionId, (counts.get(a.sessionId) ?? 0) + 1);
    }
    return row;
  });
  const sessions = report.sessions
    .filter((s) => counts.has(s.id))
    .map((s) => ({ ...s, lines: counts.get(s.id)!, commits: new Set(rows.filter((r) => r.sessionId === s.id).map((r) => r.commit)).size }))
    .sort((a, b) => b.lines - a.lines);
  return { root, rev: report.rev, path, rows, sessions, unattributed: rows.filter((r) => !r.sessionId).length };
}
