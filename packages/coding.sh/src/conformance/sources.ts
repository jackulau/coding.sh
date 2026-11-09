// Where each adapter's backfill reads, so the checker can tell "nothing to
// import" from "files there, nothing imported" (finding F3: an OpenCode
// schema the adapter did not know imported 395 sessions as zero events, with
// no warning). The paths come from the adapters' own helpers and match what
// their backfill walks; only names, sizes and mtimes are read.
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeConfigDir } from "../adapters/claude-code.ts";
import { codexHome } from "../adapters/codex.ts";
import { cursorConfigDir } from "../adapters/cursor.ts";
import { AGY_PRODUCT_DIRS } from "../adapters/more/antigravity.ts";
import { copilotHome } from "../adapters/more/copilot-cli.ts";
import { factoryDir } from "../adapters/more/droid.ts";
import { geminiDir } from "../adapters/more/gemini-cli.ts";
import { gooseSessionsDb } from "../adapters/more/goose.ts";
import { piSessionsDir } from "../adapters/more/pi.ts";
import { opencodeDataDir } from "../adapters/opencode.ts";
import { t3UserData } from "../adapters/t3code.ts";
import { userHome } from "../core/paths.ts";

/** A file, or a directory walked to `depth` for files whose name (and path) match. */
export interface SourceRoot {
  path: string;
  match?: (name: string, full: string) => boolean;
  depth?: number;
}

export interface SourceSummary {
  /** Non-empty source files (modified at or after `since`, when given). */
  files: number;
  bytes: number;
}

const jsonl = (n: string) => n.endsWith(".jsonl");

/** Source roots per agent id, read from `env` as the adapter reads them. Agents without a backfill have none. */
export const SOURCES: Record<string, (env: NodeJS.ProcessEnv) => SourceRoot[]> = {
  "claude-code": (env) => [{ path: join(claudeConfigDir(env), "projects"), match: jsonl, depth: 6 }],
  codex: (env) => ["sessions", "archived_sessions"].map((d) => ({ path: join(codexHome(env), d), match: (n: string) => /^rollout-.*\.jsonl$/.test(n), depth: 4 })),
  opencode: (env) => [
    { path: env.OPENCODE_DB && env.OPENCODE_DB !== ":memory:" ? env.OPENCODE_DB : join(opencodeDataDir(env), "opencode.db") },
    { path: join(opencodeDataDir(env), "storage", "session"), match: (n) => n.endsWith(".json"), depth: 2 },
  ],
  cursor: (env) => [{ path: join(env.CURSOR_DATA_DIR || cursorConfigDir(env), "projects"), match: (n, p) => n.endsWith(".jsonl") && /[\\/]agent-transcripts[\\/]/.test(p), depth: 4 }],
  t3code: (env) => [{ path: join(t3UserData(env), "statev2.sqlite") }, { path: join(t3UserData(env), "state.sqlite") }],
  "gemini-cli": (env) => [{ path: join(geminiDir(env), "tmp"), match: (n, p) => /^session-.*\.jsonl?$/.test(n) || (n.endsWith(".jsonl") && /[\\/]chats[\\/]/.test(p)), depth: 4 }],
  antigravity: (env) =>
    AGY_PRODUCT_DIRS.map((d) => ({
      path: join(userHome(env), ".gemini", d, "brain"),
      match: (n: string, p: string) => (n === "transcript.jsonl" || n === "transcript_full.jsonl") && basename(dirname(p)) === "logs",
      depth: 4,
    })),
  "copilot-cli": (env) => [{ path: join(copilotHome(env), "session-state"), match: jsonl, depth: 1 }],
  droid: (env) => [{ path: join(factoryDir(env), "sessions"), match: jsonl, depth: 2 }],
  goose: (env) => [{ path: gooseSessionsDb(env) }],
  pi: (env) => [{ path: piSessionsDir(env), match: jsonl, depth: 2 }],
};

/** At most this many files are stat'ed per agent: enough to know there is something. */
const MAX_FILES = 2000;

/**
 * Non-empty source files of an agent (modified at or after `since`), or
 * undefined when coding.sh does not know where the agent keeps them.
 */
export function sourceSummary(agent: string, opts: { env?: NodeJS.ProcessEnv; since?: number } = {}): SourceSummary | undefined {
  const roots = SOURCES[agent]?.(opts.env ?? process.env);
  if (!roots) return undefined;
  const out: SourceSummary = { files: 0, bytes: 0 };
  const take = (full: string, size: number, mtimeMs: number) => {
    if (size <= 0 || (opts.since !== undefined && mtimeMs < opts.since)) return;
    out.files++;
    out.bytes += size;
  };
  for (const root of roots) {
    let st;
    try {
      st = statSync(root.path);
    } catch {
      continue;
    }
    if (st.isFile()) {
      take(root.path, st.size, st.mtimeMs);
      continue;
    }
    if (!st.isDirectory()) continue;
    let seen = 0;
    const walk = (dir: string, depth: number): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (seen >= MAX_FILES) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < (root.depth ?? 4)) walk(full, depth + 1);
        } else if (e.isFile() && (!root.match || root.match(e.name, full))) {
          seen++;
          try {
            const s = statSync(full);
            take(full, s.size, s.mtimeMs);
          } catch {
            // gone since the listing
          }
        }
      }
    };
    walk(root.path, 0);
  }
  return out;
}
