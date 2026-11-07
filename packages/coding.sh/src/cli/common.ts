// Helpers shared by command modules (loaded only after dispatch).
import { existsSync, readFileSync } from "node:fs";
import { openContext, type Context } from "../core/context.ts";
import type { IngestError } from "../core/ingest.ts";
import type { EvalTask, Session } from "../core/types.ts";
import type { GateOpts } from "../stats/tests.ts";
import { runningCli } from "../mcp/launch.ts";
import { spawnBackgroundIngest } from "../spool/kick.ts";
import { UsageError, type FlagValue } from "./args.ts";
import { ago, CliError, plural, type Output } from "./output.ts";
import type { CommandContext } from "./types.ts";

export async function withContext<T>(c: CommandContext, fn: (ctx: Context) => Promise<T>): Promise<T> {
  let ctx: Context;
  try {
    ctx = await openContext({ env: c.env, cwd: c.cwd });
  } catch (e) {
    throw new CliError(`Couldn't open the coding.sh store: ${e instanceof Error ? e.message : String(e)}`, {
      reason: "store_unavailable",
      next: ["Check the [store] section of the config:", "coding.sh config path"],
    });
  }
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/** Another ingest holds (or took over) the spool lock: it, or the next read, picks the events up. */
export function lockContention(e: unknown): boolean {
  const name = (e as Error | undefined)?.name;
  return name === "LockBusyError" || name === "LockLostError";
}

/** How long a read waits on ingest before answering from what is indexed (`--fresh` waits for all). */
export const READ_INGEST_BUDGET_MS = 1500;

export interface AutoIngestOptions {
  /**
   * Answer after this long even when the spool is not drained: the rest goes to
   * a background `coding.sh ingest` and a note to stderr. Unset: wait for all.
   */
  budgetMs?: number;
  /** Where the "not yet ingested" note goes. */
  out?: Output;
  /** Environment of the background ingest (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Stops the spool ingest at its next checkpoint and skips transcripts (the viewer's worker shutting down). */
  signal?: AbortSignal;
  /** Spool files still holding unread lines, as the ingest goes. */
  onProgress?: (p: { filesPending: number }) => void;
  /** Per-line problems the spool ingest reported (bad lines, adapter failures); the read goes on. */
  onErrors?: (errors: IngestError[]) => void;
}

/** What autoIngest left undone: source files not yet indexed, and whether an ingest is now working on them. */
export interface IngestBacklog {
  pendingFiles: number;
  /** A background ingest was started, or another ingest holds the lock. */
  indexing: boolean;
}

/**
 * The machine-readable form of a read's backlog: `{ pending: { files, indexing } }` while
 * captures are still waiting to be indexed (the answer is partial), else nothing.
 */
export function pendingField(b: IngestBacklog): { pending?: { files: number; indexing: boolean } } {
  return b.pendingFiles ? { pending: { files: b.pendingFiles, indexing: b.indexing } } : {};
}

/** The read budget: CODING_SH_READ_BUDGET_MS when it is a number >= 0, else READ_INGEST_BUDGET_MS. */
export function readBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CODING_SH_READ_BUDGET_MS?.trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : READ_INGEST_BUDGET_MS;
}

/**
 * Budgeted autoIngest options for a read command (`status`, `sessions`, `search`):
 * no budget with `--fresh`; CODING_SH_READ_BUDGET_MS overrides the default.
 */
export function readIngest(c: CommandContext): AutoIngestOptions {
  const base = { out: c.out, env: c.env };
  if (c.flags.fresh === true) return base;
  return { ...base, budgetMs: readBudgetMs(c.env) };
}

/**
 * Drains pending hook events before a read so `sessions`/`show` see what was
 * just captured. Skips quietly when another ingest holds the lock. With a
 * budget it stops at the next checkpoint once the budget is spent (cursors
 * cover exactly what was stored) and leaves the rest to a background ingest,
 * so a big backlog never blanks a read. Returns the source files still waiting.
 * While another ingest holds the lock, the spool files it has yet to read count as waiting.
 */
export async function autoIngest(ctx: Context, o: AutoIngestOptions = {}): Promise<IngestBacklog> {
  // A remote store (--store / CODING_SH_STORE_URL) is read as is: never push this machine's spool into it.
  if (ctx.storeOverridden) return { pendingFiles: 0, indexing: false };
  const deadline = o.budgetMs !== undefined ? Date.now() + o.budgetMs : undefined;
  let pending = 0;
  let busy = false;
  let indexing = false;
  if (existsSync(ctx.paths.spool)) {
    try {
      const r = await ctx.ingest({
        lock: { waitMs: Math.min(1500, o.budgetMs ?? 1500) },
        ...(deadline !== undefined ? { deadline } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      });
      pending += r.pendingFiles;
      if (r.errors.length) o.onErrors?.(r.errors);
    } catch (e) {
      if (!lockContention(e)) throw e;
      busy = true;
      const { spoolBacklog } = await import("../core/ingest.ts");
      pending += await spoolBacklog(ctx.index, ctx.paths.spool).catch(() => 0);
    }
  }
  if (!o.signal?.aborted) pending += await tailIngest(ctx, deadline);
  if (pending && o.budgetMs !== undefined) {
    // An ingest holding the lock finishes the spool (and the transcripts) itself; else start one
    // (not with CODING_SH_NO_AUTO_INGEST=1, which also keeps the hook from starting them).
    const env = o.env ?? process.env;
    const started = !busy && env.CODING_SH_NO_AUTO_INGEST !== "1" && spawnBackgroundIngest(ingestCli(ctx.paths.cliPointer), env);
    indexing = busy || !!started;
    o.out?.note(`${plural(pending, "file")} not yet ingested${indexing ? ", indexing in the background" : ""}; showing what is indexed so far (--fresh waits for all)`);
    if (started) reparseKicked = true; // that ingest re-parses too when due
  }
  await kickReparse(ctx, o.env ?? process.env);
  return { pendingFiles: pending, indexing };
}

let reparseKicked = false;

/**
 * Sessions stored by an older adapter parse (after an upgrade) are rebuilt by
 * a detached `ingest --background`, once per process, never in the read
 * itself. Skipped while one runs, without a CLI to start, and when
 * CODING_SH_NO_AUTO_INGEST=1. Never fails a read.
 */
async function kickReparse(ctx: Context, env: NodeJS.ProcessEnv): Promise<void> {
  if (reparseKicked || env.CODING_SH_NO_AUTO_INGEST === "1") return;
  try {
    if (!(await ctx.reparseDue())) return;
    reparseKicked = true;
    const { isLocked } = await import("../core/lock.ts");
    if (!isLocked(ctx.paths.reparseLock)) spawnBackgroundIngest(ingestCli(ctx.paths.cliPointer), env);
  } catch {
    // a store that can't answer must not break `coding.sh sessions`
  }
}

/** The CLI a background ingest runs: this one (the bundle, or src/cli/main.ts from source), else the one init recorded. */
function ingestCli(pointer: string): string | undefined {
  const argv1 = process.argv[1];
  if (argv1 && /[\\/]cli[\\/]main\.ts$/.test(argv1)) return argv1;
  const running = runningCli();
  if (running) return running;
  try {
    return readFileSync(pointer, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Imports from adapters whose store is a capture path (Adapter.tail). Never fails a read. Returns the files left unread at `deadline`. */
export async function tailIngest(ctx: Context, deadline?: number): Promise<number> {
  let pending = 0;
  const d = deadline !== undefined ? { deadline } : {};
  try {
    const { ADAPTERS } = await import("../adapters/index.ts");
    const agents = ADAPTERS.filter((a) => a.tail?.()).map((a) => a.id);
    if (agents.length) pending += (await ctx.backfill({ agents, ...d })).pendingFiles;
    // Agents whose hooks are installed but not firing yet: their transcripts
    // are the capture path until they are (a fresh `init` with Codex).
    for (const a of ADAPTERS) {
      const t = a.tailWhenUnhooked?.();
      if (t) pending += (await ctx.backfill({ agents: [a.id], ...(t.since !== undefined ? { since: t.since } : {}), ...d })).pendingFiles;
    }
  } catch {
    // a broken third-party store must not break `coding.sh sessions`
  }
  return pending;
}

/**
 * A task by id, else by its unique name (`eval new --name` is what users
 * remember; the id is a hash). Never prefix-matches.
 */
export async function resolveTask(ctx: Context, ref: string): Promise<EvalTask> {
  const byId = await ctx.index.getTask(ref);
  if (byId) return byId;
  const named = (await ctx.index.listTasks()).filter((t) => t.name === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new CliError(`${named.length} tasks are named ${JSON.stringify(ref)}`, { reason: "ambiguous", next: ["Pass one of their ids:", ...named.map((t) => t.id)] });
  }
  throw new CliError(`Can't find task ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List tasks:", "coding.sh eval list"] });
}

/** Exact session id, or "latest" (newest top-level session). Never prefix-matches. */
export async function resolveSession(ctx: Context, id: string): Promise<Session> {
  if (id === "latest" || id === "last") {
    const [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    if (!s) throw new CliError("No sessions captured yet", { reason: "not_found", next: ["Install capture hooks:", "coding.sh init"] });
    return s;
  }
  const s = (await ctx.index.getSession(id)) ?? (await sessionByPrefix(ctx, id));
  if (!s) {
    const short = id.length < MIN_ID_PREFIX ? ` (an id prefix needs at least ${MIN_ID_PREFIX} characters)` : "";
    throw new CliError(`Can't find session ${JSON.stringify(id)}${short}`, { reason: "not_found", next: ["List sessions:", "coding.sh sessions"] });
  }
  return s;
}

/** Shortest prefix that may stand for a session id (git's minimum for short hashes). */
export const MIN_ID_PREFIX = 4;
const MAX_CANDIDATES = 10;

/**
 * The session a unique id prefix names, like a git short hash. An ambiguous
 * prefix fails with the candidates listed (data.candidates in --json).
 */
async function sessionByPrefix(ctx: Context, prefix: string): Promise<Session | undefined> {
  if (prefix.length < MIN_ID_PREFIX) return undefined;
  const ids = ctx.index.sessionIdsByPrefix
    ? await ctx.index.sessionIdsByPrefix(prefix, MAX_CANDIDATES + 1)
    : (await ctx.index.listSessions()).map((s) => s.id).filter((x) => x.startsWith(prefix)).sort().slice(0, MAX_CANDIDATES + 1);
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return ctx.index.getSession(ids[0]!);
  const shown = (await Promise.all(ids.slice(0, MAX_CANDIDATES).map((x) => ctx.index.getSession(x)))).filter((x): x is Session => x !== undefined);
  shown.sort((a, b) => b.startedAt - a.startedAt);
  const lines = shown.map((x) => `  ${x.id}  ${x.agent}  ${ago(x.startedAt)}  ${oneLine(x.title ?? "", 50)}`.trimEnd());
  if (ids.length > MAX_CANDIDATES) lines.push(`  …and more`);
  throw new CliError(`Session id prefix ${JSON.stringify(prefix)} is ambiguous. It matches:\n${lines.join("\n")}`, {
    reason: "ambiguous",
    next: ["Use more of the id, or list sessions:", "coding.sh sessions"],
    data: { candidates: shown.map((x) => ({ id: x.id, agent: x.agent, startedAt: new Date(x.startedAt).toISOString(), title: x.title ?? null })), more: ids.length > MAX_CANDIDATES },
  });
}

export function str(v: FlagValue): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function list(v: FlagValue): string[] {
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

export function num(v: FlagValue): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * `--gate [--lambda N] [--gate-alpha A] [--tau T]`: the acceptance gate's
 * settings, undefined without --gate. The tuning flags alone are a usage error.
 */
export function gateFlags(flags: Record<string, FlagValue>): GateOpts | undefined {
  const lambda = num(flags.lambda);
  const alpha = num(flags["gate-alpha"]);
  const tau = num(flags.tau);
  if (flags.gate !== true) {
    for (const [name, v] of [["lambda", lambda], ["gate-alpha", alpha], ["tau", tau]] as const) {
      if (v !== undefined) throw new UsageError(`--${name} needs --gate`, { reason: "invalid_argument" });
    }
    return undefined;
  }
  if (lambda !== undefined && !(lambda >= 1 && Number.isFinite(lambda))) throw new UsageError(`--lambda must be a number of at least 1, got ${lambda}`, { reason: "invalid_argument" });
  if (alpha !== undefined && !(alpha > 0 && alpha <= 1)) throw new UsageError(`--gate-alpha must be above 0 and at most 1, got ${alpha}`, { reason: "invalid_argument" });
  if (tau !== undefined && !(tau >= 0 && tau <= 1)) throw new UsageError(`--tau must be between 0 and 1, got ${tau}`, { reason: "invalid_argument" });
  return { ...(lambda !== undefined ? { lambda } : {}), ...(alpha !== undefined ? { alpha } : {}), ...(tau !== undefined ? { tau } : {}) };
}

/** The Pareto promotion gate's settings (`compare --promote`). */
export interface PromoteOpts {
  gamma?: number;
  epsQ?: number;
  epsC?: number;
  draws?: number;
}

/**
 * `--promote [--gamma G] [--eps-q Q] [--eps-c C|inf] [--draws N]`: the Pareto
 * promotion gate's settings, undefined without --promote. The tuning flags
 * alone are a usage error.
 */
export function promoteFlags(flags: Record<string, FlagValue>): PromoteOpts | undefined {
  const gamma = num(flags.gamma);
  const epsQ = num(flags["eps-q"]);
  const rawC = str(flags["eps-c"]);
  const draws = num(flags.draws);
  if (flags.promote !== true) {
    for (const [name, v] of [["gamma", gamma], ["eps-q", epsQ], ["eps-c", rawC], ["draws", draws]] as const) {
      if (v !== undefined) throw new UsageError(`--${name} needs --promote`, { reason: "invalid_argument" });
    }
    return undefined;
  }
  const epsC = rawC === undefined ? undefined : /^\+?inf(inity)?$/i.test(rawC.trim()) ? Infinity : Number(rawC);
  if (gamma !== undefined && !(gamma > 0 && gamma <= 1)) throw new UsageError(`--gamma must be above 0 and at most 1, got ${gamma}`, { reason: "invalid_argument" });
  if (epsQ !== undefined && !(epsQ >= 0 && epsQ <= 1)) throw new UsageError(`--eps-q must be between 0 and 1, got ${epsQ}`, { reason: "invalid_argument" });
  if (epsC !== undefined && !(epsC >= 0)) throw new UsageError(`--eps-c must be a number of at least 0 or inf, got ${JSON.stringify(rawC)}`, { reason: "invalid_argument" });
  if (draws !== undefined && !(Number.isInteger(draws) && draws >= 100 && draws <= 1_000_000)) throw new UsageError(`--draws must be a whole number from 100 to 1000000, got ${draws}`, { reason: "invalid_argument" });
  return { ...(gamma !== undefined ? { gamma } : {}), ...(epsQ !== undefined ? { epsQ } : {}), ...(epsC !== undefined ? { epsC } : {}), ...(draws !== undefined ? { draws } : {}) };
}

/** `--port` as a TCP port (0 = any free port), else a usage error. */
export function port(v: FlagValue, fallback: number): number {
  const p = num(v) ?? fallback;
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new UsageError(`--port must be 0-65535, got ${p}`);
  return p;
}

/**
 * Consent for writes outside coding.sh's own data (agent configs): `--yes`,
 * or an interactive y/N. Non-interactive without --yes fails with
 * confirmation_required (exit 2) and writes nothing.
 */
export async function requireConsent(c: CommandContext, question: string, rerun: string, opts: { defaultYes?: boolean } = {}): Promise<void> {
  if (c.flags.yes === true) return;
  if (!c.out.interactive) {
    throw new UsageError(`${question.replace(/\?$/, "")} needs confirmation. Pass --yes to confirm`, { reason: "confirmation_required", suggestion: rerun });
  }
  if (!(await c.out.confirm(question, opts))) throw new CliError("Canceled. Nothing was changed", { reason: "canceled", exitCode: 130 });
}

/** Parses JSON from an inline string or a path to a .json file. */
export async function jsonArg(v: string, what: string): Promise<unknown> {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch (e) {
      throw new UsageError(`${what} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(v, "utf8");
  } catch {
    throw new UsageError(`${what} must be JSON or a path to a JSON file; can't read ${JSON.stringify(v)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new UsageError(`${v} is not valid JSON: ${(e as Error).message}`);
  }
}

/** First line, whitespace-folded and cut to n chars. */
export function oneLine(s: string | undefined, n = 80): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function sessionJson(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    agent: s.agent,
    ...(s.provider ? { provider: s.provider } : {}),
    ...(s.project ? { project: s.project } : {}),
    title: s.title ?? null,
    model: s.model ?? null,
    cwd: s.cwd ?? null,
    repo: s.repo?.root ?? null,
    branch: s.repo?.branch ?? null,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt !== undefined ? new Date(s.endedAt).toISOString() : null,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : null,
    parentSessionId: s.parent?.sessionId ?? null,
    flags: s.flags,
    stats: s.stats,
  };
}
