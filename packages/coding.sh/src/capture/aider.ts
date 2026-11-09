// Live usage for `coding.sh run -- aider …`.
//
// The wrapper hands Aider the terminal (stdio inherited), so it never sees the
// "Tokens: … Cost: …" lines Aider prints. Aider writes the same numbers to two files,
// and this tap reads both while the session runs:
//
// - The analytics log (`--analytics-log FILE`, env AIDER_ANALYTICS_LOG). Aider appends one
//   JSON line per event even when remote analytics are off. A `message_send` event carries
//   exact `prompt_tokens`, `completion_tokens` and `cost` for one model reply, plus
//   `main_model` (shown as "provider/REDACTED" when Aider's model database doesn't know it).
//   When the user hasn't named a log (argv, env or .aider.conf.yml), the tap gives Aider a
//   temp file through AIDER_ANALYTICS_LOG and deletes it afterwards. This doesn't turn
//   analytics on or change Aider's opt-in prompt: the log is written locally either way.
//   A log the user named is read in place (from its size at start), so if two Aider sessions
//   write it at once, each wrapped session counts both.
// - The chat history (`.aider.chat.history.md` at the git root, `--chat-history-file`).
//   Aider quotes each usage report there ("> Tokens: 18k sent, 2.4k cache write, 12k cache
//   hit, 30 received."), which is the only place the cache split appears. Counts are
//   rounded ("2.4k"), so a history line is matched to an analytics event when its
//   rounded sent/received counts agree, and it adds only the cache fields.
//
// Token semantics (Aider 0.86.2 with its pinned litellm, checked against a real run):
// "sent" is litellm's prompt_tokens, which already includes cache reads and writes, and
// Aider adds the cache writes once more. inputTokens here is the uncached part, as
// everywhere else in coding.sh: sent - cacheRead - 2 × cacheWrite, never below 0.
//
// Cost: Aider reports 0 when it has no price for the model, so 0 is stored as unknown
// (no costUsd) and the price table may estimate it later.
//
// Only numbers and the model name leave these files; the analytics lines' other fields
// (user id, platform) and the chat text are never spooled.
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Usage } from "../schema/index.ts";

/** One model reply Aider reported. `ts` is ms (Aider logs whole seconds). */
export interface AiderUsageRecord {
  ts: number;
  model?: string;
  usage: Usage;
  /** Aider's running session cost after this reply, when it knows the price. */
  sessionCostUsd?: number;
}

export interface AiderUsageTap {
  /** Env to merge into Aider's environment (empty when the user names their own log). */
  env: Record<string, string>;
  /** The analytics log being read. */
  logFile: string;
  /** New replies since the last call. */
  poll(): AiderUsageRecord[];
  /** Last poll, then remove the temp log if the tap made one. */
  close(): AiderUsageRecord[];
}

export interface AiderTapOptions {
  args: string[];
  cwd: string;
  /** Aider's environment (process.env plus the wrapper's overrides). */
  env: NodeJS.ProcessEnv;
  /** Git root of cwd when known: Aider keeps its chat history and a config file there. */
  gitRoot?: string;
  /** Records older than this are clamped to it (Aider's whole-second times would land before session.start). */
  startedAt?: number;
}

/** Value of the last `--flag value` / `--flag=value` among `names`. */
function flagValue(args: string[], ...names: string[]): string | undefined {
  let v: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (names.includes(a) && i + 1 < args.length) v = args[++i];
    else {
      const eq = a.indexOf("=");
      if (eq > 0 && names.includes(a.slice(0, eq))) v = a.slice(eq + 1);
    }
  }
  return v;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `key: value` from Aider's YAML config files, with Aider's precedence (`-c FILE` alone, else cwd > git root > home). */
function configValue(key: string, o: AiderTapOptions): string | undefined {
  const explicit = flagValue(o.args, "-c", "--config");
  const files = explicit ? [resolve(o.cwd, explicit)] : [join(o.cwd, ".aider.conf.yml"), ...(o.gitRoot ? [join(o.gitRoot, ".aider.conf.yml")] : []), join(o.env.HOME || o.env.USERPROFILE || homedir(), ".aider.conf.yml")];
  const re = new RegExp(`^${key.replace(/[-]/g, "\\-")}:[ \\t]*(.*?)[ \\t]*$`, "m");
  for (const f of files) {
    const m = re.exec(readText(f) ?? "");
    const v = m?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
    if (v) return v;
  }
  return undefined;
}

/** Where Aider will write `flag` (argv, then AIDER_* env, then its config files). */
function aiderPath(flag: string, o: AiderTapOptions): string | undefined {
  const envKey = `AIDER_${flag.toUpperCase().replace(/-/g, "_")}`;
  const v = flagValue(o.args, `--${flag}`) ?? (o.env[envKey] || undefined) ?? configValue(flag, o);
  return v === undefined ? undefined : isAbsolute(v) ? v : resolve(o.cwd, v);
}

/** Reads what was appended to a file since the last call, in whole lines. */
class Tail {
  readonly file: string;
  private offset: number;
  private rest = "";
  constructor(file: string) {
    this.file = file;
    this.offset = sizeOf(file);
  }
  lines(): string[] {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // truncated or replaced
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const text = this.rest + buf.subarray(0, n).toString("utf8");
      const cut = text.lastIndexOf("\n");
      this.rest = text.slice(cut + 1);
      return cut < 0 ? [] : text.slice(0, cut).split("\n");
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function sizeOf(file: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** "2.1k" → 2100, "18k" → 18000, "345" → 345. */
function count(s: string): number {
  const m = /^([\d.,]+)\s*([kKmM]?)$/.exec(s.trim());
  if (!m) return NaN;
  const n = Number(m[1]!.replace(/,/g, ""));
  const unit = m[2]!.toLowerCase();
  return Math.round(unit === "k" ? n * 1e3 : unit === "m" ? n * 1e6 : n);
}

interface HistoryReport {
  sent: number;
  received: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A quoted usage report from the chat history: "> Tokens: 18k sent, 2.4k cache write, 12k cache hit, 30 received." */
export function parseHistoryReport(line: string): HistoryReport | undefined {
  const m = /Tokens:\s*(.*?)\s+received\./.exec(line);
  if (!m) return undefined;
  const r: HistoryReport = { sent: NaN, received: NaN, cacheWrite: 0, cacheRead: 0 };
  for (const part of `${m[1]} received`.split(/,\s*/)) {
    const p = /^(.+?)\s+(sent|received|cache write|cache hit)$/.exec(part.trim());
    if (!p) continue;
    const n = count(p[1]!);
    if (p[2] === "sent") r.sent = n;
    else if (p[2] === "received") r.received = n;
    else if (p[2] === "cache write") r.cacheWrite = n;
    else r.cacheRead = n;
  }
  return Number.isFinite(r.sent) && Number.isFinite(r.received) ? r : undefined;
}

/** True when `shown` is Aider's format_tokens(exact): exact under 1000, one decimal k under 10k, whole k above. */
function roundsTo(shown: number, exact: number): boolean {
  if (exact < 1000) return shown === exact;
  return Math.abs(shown - exact) <= (exact < 10_000 ? 50 : 500);
}

interface MessageSend {
  time?: number;
  model?: string;
  sent: number;
  received: number;
  cost?: number;
  totalCost?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A `message_send` line from Aider's analytics log. */
export function parseAnalyticsLine(line: string): MessageSend | undefined {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object") return undefined;
  const e = o as { event?: unknown; properties?: Record<string, unknown>; time?: unknown };
  if (e.event !== "message_send" || !e.properties) return undefined;
  const p = e.properties;
  const sent = num(p.prompt_tokens);
  const received = num(p.completion_tokens);
  if (sent === undefined || received === undefined) return undefined;
  const model = typeof p.main_model === "string" && p.main_model && p.main_model !== "None" && !p.main_model.endsWith("/REDACTED") ? p.main_model : undefined;
  return { time: num(e.time), model, sent, received, cost: num(p.cost), totalCost: num(p.total_cost) };
}

/** One analytics event, with the cache split from its matching history report when there is one. */
export function toRecord(m: MessageSend, h: HistoryReport | undefined, startedAt = 0): AiderUsageRecord {
  const cacheRead = h?.cacheRead ?? 0;
  const cacheWrite = h?.cacheWrite ?? 0;
  const usage: Usage = { inputTokens: Math.max(0, m.sent - cacheRead - 2 * cacheWrite), outputTokens: m.received };
  if (cacheRead) usage.cacheReadTokens = cacheRead;
  if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
  if (m.cost && m.cost > 0) usage.costUsd = m.cost;
  const r: AiderUsageRecord = { ts: Math.max(startedAt, (m.time ?? 0) * 1000), usage };
  if (m.model) r.model = m.model;
  if (m.totalCost && m.totalCost > 0) r.sessionCostUsd = m.totalCost;
  return r;
}

/** Start reading Aider's usage for one wrapped session. Never throws; returns undefined if nothing can be read. */
export function aiderUsageTap(o: AiderTapOptions): AiderUsageTap | undefined {
  try {
    const env: Record<string, string> = {};
    let logFile = aiderPath("analytics-log", o);
    let tempDir: string | undefined;
    if (!logFile) {
      tempDir = mkdtempSync(join(tmpdir(), "coding.sh-aider-"));
      logFile = join(tempDir, "analytics.jsonl");
      env.AIDER_ANALYTICS_LOG = logFile;
    }
    const historyFile = aiderPath("chat-history-file", o) ?? join(o.gitRoot ?? o.cwd, ".aider.chat.history.md");
    const log = new Tail(logFile);
    const history = new Tail(historyFile);
    let pending: HistoryReport[] = [];
    const poll = (): AiderUsageRecord[] => {
      // The analytics log first: Aider writes the history line before the event, so every
      // event read here already has its history line on disk.
      const sends = log.lines().map(parseAnalyticsLine).filter((m): m is MessageSend => !!m);
      for (const l of history.lines()) {
        const h = parseHistoryReport(l);
        if (h) pending.push(h);
      }
      return sends.map((m) => {
        const i = pending.findIndex((h) => roundsTo(h.sent, m.sent) && roundsTo(h.received, m.received));
        const h = i >= 0 ? pending[i] : undefined;
        if (i >= 0) pending = pending.slice(i + 1);
        return toRecord(m, h, o.startedAt);
      });
    };
    return {
      env,
      logFile,
      poll,
      close() {
        const last = poll();
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        return last;
      },
    };
  } catch {
    return undefined;
  }
}
