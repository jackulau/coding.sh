// Plan usage windows (the 5-hour and weekly limits of a subscription), as the agents report them.
// Claude Code sends `rate_limits` on status-line stdin: `coding.sh statusline` shows it and saves
// the reading to <CODING_SH_HOME>/quota.json. Codex writes `rate_limits` into the token_count
// events of its rollouts: we read the tail of the newest ones. Nothing here touches the index.
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dateMs } from "../core/dates.ts";

export type QuotaAgent = "claude-code" | "codex";
export const QUOTA_AGENTS: readonly QuotaAgent[] = ["claude-code", "codex"];
/** Claude Code's spend limit behind a Claude apps gateway is the window "spend". */
export const QUOTA_WINDOWS = ["5h", "7d", "spend"] as const;

/** One plan window as last read. */
export interface QuotaReading {
  agent: QuotaAgent;
  /** "5h", "7d" or "spend" (another length prints as its minutes, hours or days: "90m", "3h", "2d"). */
  window: string;
  /** 0 to 100 (above 100 once over the limit). */
  usedPercent: number;
  /** When the window resets (ms since epoch), when the agent said. */
  resetsAt?: number;
  /** The spend limit only: what was spent and the limit, in USD, when the gateway said. */
  usedUsd?: number;
  limitUsd?: number;
  /** The spend limit only: the period it counts over, as the gateway names it. */
  period?: string;
  /** When the agent reported it (ms since epoch). */
  readAt: number;
}

export interface QuotaReport {
  windows: QuotaReading[];
  /** Agents with no reading, and how to get one. */
  missing: { agent: QuotaAgent; how: string }[];
}

const HOW: Record<QuotaAgent, string> = {
  "claude-code":
    "Claude Code sends plan usage on its status line (Pro, Max and Ultra plans, after a session's first reply). Install the coding.sh status line to record it: coding.sh statusline install",
  codex: "Codex writes plan usage into its session rollouts under CODEX_HOME/sessions when you sign in with ChatGPT. Run a Codex session to record one.",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** USD amounts and percents in JSON output: at most 4 decimals. */
export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The spend limit's optional fields, only those set. */
function spendFields(usedUsd: unknown, limitUsd: unknown, period: unknown): Pick<QuotaReading, "usedUsd" | "limitUsd" | "period"> {
  const out: Pick<QuotaReading, "usedUsd" | "limitUsd" | "period"> = {};
  const used = num(usedUsd);
  const limit = num(limitUsd);
  if (used !== undefined) out.usedUsd = used;
  if (limit !== undefined) out.limitUsd = limit;
  if (typeof period === "string" && period) out.period = period;
  return out;
}

function reading(agent: QuotaAgent, window: string, usedPercent: number, resetsAt: number | undefined, readAt: number): QuotaReading {
  const r: QuotaReading = { agent, window, usedPercent, readAt };
  // A reset time out of the Date range is left out, as when the agent gives none.
  const at = dateMs(resetsAt);
  if (at !== undefined) r.resetsAt = at;
  return r;
}

// ---------------------------------------------------------------- Claude Code

const CLAUDE_KEYS: [string, string][] = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["spend_limit", "spend"], // behind a Claude apps gateway; used_percentage may pass 100
];

/** The windows in a status-line payload's `rate_limits`, or [] when it has none (some Claude Code versions leave it out). */
export function claudeRateLimits(payload: unknown, now = Date.now()): QuotaReading[] {
  if (!isObj(payload) || !isObj(payload.rate_limits)) return [];
  const rl = payload.rate_limits;
  const out: QuotaReading[] = [];
  for (const [key, window] of CLAUDE_KEYS) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const used = num(w.used_percentage);
    if (used === undefined) continue;
    const resets = num(w.resets_at);
    const r = reading("claude-code", window, used, resets === undefined ? undefined : resets * 1000, now);
    out.push(window === "spend" ? { ...r, ...spendFields(w.used_usd, w.limit_usd, w.period) } : r);
  }
  return out;
}

/** `5h 62% 7d 41% spend 63%`: only the windows there are; "" for none. */
export function quotaPart(windows: readonly QuotaReading[]): string {
  return windows.map((w) => `${w.window} ${Math.round(w.usedPercent)}%`).join(" ");
}

/** Saves Claude Code's reading: a temp file, then a rename, so a reader never sees half a file. */
export function saveClaudeQuota(file: string, windows: readonly QuotaReading[]): void {
  if (!windows.length) return;
  const doc = {
    agent: "claude-code",
    readAt: windows[0]!.readAt,
    windows: windows.map((w) => ({ window: w.window, usedPercent: w.usedPercent, resetsAt: w.resetsAt, ...spendFields(w.usedUsd, w.limitUsd, w.period) })),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc) + "\n");
  } catch {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(doc) + "\n");
  }
  renameSync(tmp, file);
}

export function readClaudeQuota(file: string): QuotaReading[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isObj(doc) || !Array.isArray(doc.windows)) return [];
  const readAt = dateMs(num(doc.readAt));
  if (readAt === undefined) return [];
  const out: QuotaReading[] = [];
  for (const w of doc.windows) {
    if (!isObj(w) || typeof w.window !== "string") continue;
    const used = num(w.usedPercent);
    if (used === undefined) continue;
    const resets = num(w.resetsAt);
    out.push({ ...reading("claude-code", w.window, used, resets, readAt), ...spendFields(w.usedUsd, w.limitUsd, w.period) });
  }
  return out;
}

// ---------------------------------------------------------------- Codex

/** How much of a rollout's end is read: the latest token_count is near the end. */
export const ROLLOUT_TAIL_BYTES = 256 * 1024;
/** Rollouts tried, newest first, when the newest has no reading yet (a session that just started). */
const ROLLOUTS_TRIED = 3;

/** `primary`/`secondary` length in minutes, as a label: 300 is "5h", 10080 is "7d". */
export function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const digitsDesc = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
};

/**
 * The newest rollouts under `<codexHome>/sessions/YYYY/MM/DD`, newest first by mtime. Only the two
 * newest day folders that hold a rollout are listed (a session started yesterday may still be
 * writing), never every file.
 */
export function newestRollouts(codexHome: string, max = ROLLOUTS_TRIED): string[] {
  const root = join(codexHome, "sessions");
  const files: { path: string; mtime: number }[] = [];
  let days = 0;
  outer: for (const y of digitsDesc(root)) {
    for (const m of digitsDesc(join(root, y))) {
      for (const d of digitsDesc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => /^rollout-.*\.jsonl$/.test(n));
        } catch {
          continue;
        }
        if (!names.length) continue;
        for (const n of names) {
          try {
            files.push({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs });
          } catch {
            // gone since the listing
          }
        }
        if (++days >= 2) break outer;
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((f) => f.path);
}

/** The last `bytes` of a file, starting at a whole line. */
export function readTail(file: string, bytes = ROLLOUT_TAIL_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

function codexWindow(w: unknown, fallback: string, readAt: number): QuotaReading | undefined {
  if (!isObj(w)) return undefined;
  const used = num(w.used_percent);
  if (used === undefined) return undefined;
  const minutes = num(w.window_minutes);
  const resetsAtSec = num(w.resets_at);
  const resetsIn = num(w.resets_in_seconds); // older Codex versions
  const resetsAt = resetsAtSec !== undefined ? resetsAtSec * 1000 : resetsIn !== undefined ? readAt + resetsIn * 1000 : undefined;
  return reading("codex", minutes !== undefined && minutes > 0 ? windowLabel(minutes) : fallback, used, resetsAt, readAt);
}

/** The windows of the last token_count event in a rollout's text that carries any, or []. */
export function codexRateLimits(text: string): QuotaReading[] {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a line cut while Codex writes it
    }
    if (!isObj(o) || !isObj(o.payload) || o.payload.type !== "token_count" || !isObj(o.payload.rate_limits)) continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const rl = o.payload.rate_limits;
    const out = [codexWindow(rl.primary, "5h", ts), codexWindow(rl.secondary, "7d", ts)].filter((w): w is QuotaReading => !!w);
    if (out.length) return out;
  }
  return [];
}

export function readCodexQuota(codexHome: string): QuotaReading[] {
  for (const file of newestRollouts(codexHome)) {
    let text: string;
    try {
      text = readTail(file);
    } catch {
      continue;
    }
    const w = codexRateLimits(text);
    if (w.length) return w;
  }
  return [];
}

// ---------------------------------------------------------------- report

const windowRank = (w: string) => {
  const i = (QUOTA_WINDOWS as readonly string[]).indexOf(w);
  return i < 0 ? 9 : i;
};

export function quotaReport(opts: { claudeFile: string; codexHome: string }): QuotaReport {
  const byAgent: Record<QuotaAgent, QuotaReading[]> = { "claude-code": readClaudeQuota(opts.claudeFile), codex: readCodexQuota(opts.codexHome) };
  const windows: QuotaReading[] = [];
  const missing: QuotaReport["missing"] = [];
  for (const agent of QUOTA_AGENTS) {
    const ws = byAgent[agent];
    if (ws.length) windows.push(...[...ws].sort((a, b) => windowRank(a.window) - windowRank(b.window)));
    else missing.push({ agent, how: HOW[agent] });
  }
  return { windows, missing };
}

/** Whether the window has room again: it reset, or its use is under `below` percent. */
export function hasRoom(w: QuotaReading, below: number, now = Date.now()): boolean {
  return (w.resetsAt !== undefined && w.resetsAt <= now) || w.usedPercent < below;
}

/** The spend limit's USD fields and period for JSON, rounded to 4 decimals; {} for the other windows. */
export function spendJson(w: QuotaReading): { usedUsd?: number; limitUsd?: number; period?: string } {
  const out: { usedUsd?: number; limitUsd?: number; period?: string } = {};
  if (w.usedUsd !== undefined) out.usedUsd = round4(w.usedUsd);
  if (w.limitUsd !== undefined) out.limitUsd = round4(w.limitUsd);
  if (w.period !== undefined) out.period = w.period;
  return out;
}

/** The report as JSON (CLI --json and the MCP status tool): ISO times and the reading's age. */
export function quotaJson(r: QuotaReport, now = Date.now()) {
  return {
    windows: r.windows.map((w) => ({
      agent: w.agent,
      window: w.window,
      usedPercent: round4(w.usedPercent),
      resetsAt: w.resetsAt === undefined ? undefined : new Date(w.resetsAt).toISOString(), // undefined drops out of the JSON
      reset: w.resetsAt !== undefined && w.resetsAt <= now,
      readAt: new Date(w.readAt).toISOString(),
      ageSeconds: Math.max(0, Math.round((now - w.readAt) / 1000)),
      ...spendJson(w),
    })),
    missing: r.missing,
  };
}
