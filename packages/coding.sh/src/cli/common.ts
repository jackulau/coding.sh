// Helpers shared by command modules (loaded only after dispatch).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigEnvError, ConfigError } from "../core/config.ts";
import { openContext, storeOpenNext, StoreMissingError, type Context } from "../core/context.ts";
import type { IngestError } from "../core/ingest.ts";
import { AmbiguousRef, findSessionRef, MIN_ID_PREFIX } from "../core/session-ref.ts";
import type { EvalTask, IndexStore, Session } from "../core/types.ts";
import type { GateOpts } from "../stats/tests.ts";
import { andQuery, parseWhere, QueryError, QueryUnsupported, timeBounds, type Node, type Query } from "../query/where.ts";
import { utcOffset, wallText, type When } from "../query/time.ts";
import { runningCli } from "../mcp/launch.ts";
import { StoreOwnerError, StoreVersionError, upgradeStoreCommand } from "../core/store-guard.ts";
import { spoolSize } from "../core/ingest-health.ts";
import { paths } from "../core/paths.ts";
import { listBackups, StoreNewerError } from "../store/upgrade.ts";
import { version } from "./meta.ts";
import { acquireLock, isLocked, type LockOptions, wakeMarker } from "../core/lock.ts";
import { spawnBackgroundIngest } from "../spool/kick.ts";
import { suggest, UsageError, type FlagValue } from "./args.ts";
import { ago, CliError, plural, type Output } from "./output.ts";
import type { CommandContext } from "./types.ts";
import { noSessionsNext, noSessionsNextLines } from "./first-session.ts";

/**
 * Opens the store for a command. `create: false` is for reads: a SQLite file named by --store or
 * CODING_SH_STORE_URL that does not exist is reported (store_missing), not created.
 */
export async function withContext<T>(c: CommandContext, fn: (ctx: Context) => Promise<T>, opts: { create?: boolean } = {}): Promise<T> {
  let ctx: Context;
  try {
    ctx = await openContext({ env: c.env, cwd: c.cwd, create: opts.create ?? true });
  } catch (e) {
    throw storeOpenError(e, c.env);
  }
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/** Why the store did not open, with the next step that fits: what named the store, or the Node to install. */
export function storeOpenError(e: unknown, env: NodeJS.ProcessEnv): CliError {
  if (e instanceof StoreOwnerError) return storeOwnedError(e);
  if (e instanceof StoreVersionError) return storeVersionError(e);
  if (e instanceof StoreNewerError) return storeNewerError(e, env);
  if (e instanceof StoreMissingError) return new CliError(e.message, { reason: e.reason, next: e.next, data: { path: e.path } });
  // A config.toml that does not load for a key outside [store] ([capture], [snapshot], invalid TOML…): the
  // file is the problem, as `config get` says, not the store it names.
  if (e instanceof ConfigError && !(e instanceof ConfigEnvError) && !configStoreKey(e)) {
    const file = e.file ?? paths(env).config;
    return new CliError(`Can't read config: ${e.message}`, { reason: "invalid_config", next: ["Fix the file at:", file] });
  }
  // NoFts5Error (store/sqlite.ts, not loaded here until a store opens).
  if (e instanceof Error && (e as { reason?: unknown }).reason === "no_fts5") return new CliError(`Couldn't open the coding.sh store: ${e.message}`, { reason: "no_fts5", next: ["Install Node 22.16 or newer"] });
  return new CliError(`Couldn't open the coding.sh store: ${e instanceof Error ? e.message : String(e)}`, { reason: "store_unavailable", next: storeOpenNext(env, e) });
}

/** Whether a config error is about the [store] section (its keys, or the store URL they make). */
function configStoreKey(e: ConfigError): boolean {
  const msg = e.file && e.message.startsWith(`${e.file}: `) ? e.message.slice(e.file.length + 2) : e.message;
  return /^(\[store\]|store\b)/.test(msg);
}

/** Pending migrations of a store another install owns: the user decides on `upgrade-store` (e.command runs this install). */
export function storeOwnedError(e: StoreOwnerError): CliError {
  return new CliError(e.detail, {
    reason: "store_owned",
    askUser: true,
    next: ["Migrate it for this install (hooks then run this one):", e.command],
    data: { path: e.path, from: e.from, to: e.to, version: e.version, owner: e.owner, ownerVersion: e.ownerVersion ?? null },
  });
}

/** Pending migrations this build is not the one to run on its own: the user decides on `upgrade-store` (e.command runs this build). */
export function storeVersionError(e: StoreVersionError): CliError {
  return new CliError(e.detail, {
    reason: "store_version",
    askUser: true,
    next: ["Migrate it with this build (a copy of the index is kept, and --restore puts it back):", e.command],
    data: { path: e.path, from: e.from, to: e.to, version: e.version, writer: e.writer ?? null },
  });
}

/**
 * A store a newer coding.sh migrated. Says what the person fears first (nothing is
 * lost: the hook keeps spooling), how much waits, and which coding.sh opens it.
 */
export function storeNewerError(e: StoreNewerError, env: NodeJS.ProcessEnv): CliError {
  const p = paths(env);
  const spool = spoolSize(p.spool);
  const by = e.writer ? `, written by coding.sh ${e.writer.version}` : "";
  const waiting = spool.files ? `${plural(spool.files, "capture file")} wait${spool.files === 1 ? "s" : ""} in the spool (${p.spool})` : `new captures wait in the spool (${p.spool})`;
  // The index from before the migration, when this coding.sh can open it.
  const backup = listBackups(e.path).find((b) => b.schema <= e.known);
  // Inside the message, not a next line Output names for the shell: name the CLI here, as a command that runs this install.
  const restore = backup ? ` To go back instead, ${upgradeStoreCommand(["--restore"], { env })} puts back the index from before the migration (v${backup.schema}).` : "";
  return new CliError(`${e.path} uses index schema v${e.schema}${by}, but this coding.sh ${version()} only knows up to v${e.known}. Your captures are safe: ${waiting} and ${spool.files === 1 ? "is" : "are"} indexed once a coding.sh that knows v${e.schema} runs.${restore}`, {
    reason: "store_newer",
    next: [`Install ${e.writer ? `coding.sh ${e.writer.version} or newer` : `a coding.sh that knows index schema v${e.schema}`}:`, "coding.sh update"],
    data: { path: e.path, schema: e.schema, known: e.known, version: version(), writer: e.writer?.version ?? null, spool: { path: p.spool, files: spool.files }, backup: backup?.path ?? null },
  });
}

/** Another ingest holds (or took over) the spool lock: it, or the next read, picks the events up. */
export function lockContention(e: unknown): boolean {
  const name = (e as Error | undefined)?.name;
  return name === "LockBusyError" || name === "LockLostError";
}

/**
 * Runs a history import while holding paths.importLock, so one runs at a time and the
 * viewer can say one is running. Undefined when another import holds the lock.
 */
export async function underImportLock<T>(ctx: Context, waitMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  mkdirSync(dirname(ctx.paths.importLock), { recursive: true });
  let lock;
  try {
    lock = await acquireLock(ctx.paths.importLock, { waitMs });
  } catch (e) {
    if (lockContention(e)) return undefined;
    throw e;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** How long a read waits on ingest before answering from what is indexed (`--fresh` waits for all). */
export const READ_INGEST_BUDGET_MS = 1500;

export interface AutoIngestOptions {
  /**
   * Answer after this long even when the spool is not drained: the rest goes to
   * a background `coding.sh ingest` and a note to stderr. Unset: wait for all.
   */
  budgetMs?: number;
  /**
   * How long to wait for another ingest's lock before reading what is indexed
   * (default 1.5 s, or the budget when smaller). A command that needs the session
   * that just ended (`eval init --sessions`) waits for the ingest its hook started.
   */
  lockWaitMs?: number;
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
  /** A re-parse holds reparse.lock: the read did not ingest, the re-parse indexes the files between its steps. */
  reparsing?: true;
}

/**
 * The machine-readable form of a read's backlog: `{ pending: { files, indexing } }` while
 * captures are still waiting to be indexed (the answer is partial), else nothing.
 * `reparsing: true` is there only while a re-parse runs.
 */
export function pendingField(b: IngestBacklog): { pending?: { files: number; indexing: boolean; reparsing?: true } } {
  return b.pendingFiles ? { pending: { files: b.pendingFiles, indexing: b.indexing, ...(b.reparsing ? { reparsing: true as const } : {}) } } : {};
}

/** A not_found error that may only be not indexed yet: says so, and carries the backlog in data.pending. */
export function notFoundWithBacklog(e: unknown, b: IngestBacklog): unknown {
  if (!(e instanceof CliError) || e.reason !== "not_found" || !b.pendingFiles) return e;
  const data = { ...(e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {}), ...pendingField(b) };
  return new CliError(`${e.message}; it may be in the ${plural(b.pendingFiles, "file")} not yet ingested. Retry in a moment, or pass --fresh`, { reason: e.reason, exitCode: e.exitCode, next: e.next, details: e.details, data });
}

/** Sessions a window's totals (`usage`, `cache doctor`) read before they stop and say so: CODING_SH_SCAN_CAP when it is a whole number >= 1, else the default (100,000). */
export function scanCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.CODING_SH_SCAN_CAP?.trim();
  return raw && /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : undefined;
}

/** `Stopped after 100,000 sessions: narrow --since or --where.`: the totals above it cover only the newest sessions. */
export const stoppedAfter = (cap: number): string => `Stopped after ${cap.toLocaleString("en-US")} sessions: narrow --since or --where.`;

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
 * While a re-parse runs, the read takes the lock only if it is free right now: the re-parse
 * holds it in short stretches and ingests between them what the wake marker says is waiting.
 */
export async function autoIngest(ctx: Context, o: AutoIngestOptions = {}): Promise<IngestBacklog> {
  // A remote store (--store / CODING_SH_STORE_URL) is read as is: never push this machine's spool into it.
  if (ctx.storeOverridden) return { pendingFiles: 0, indexing: false };
  // A re-parse holds the store: a budgeted read leaves the spool to it (it ingests between its
  // steps when the wake marker says something waits) and answers from what is indexed.
  if (o.budgetMs !== undefined && isLocked(ctx.paths.reparseLock)) return reparseBacklog(ctx, o);
  const deadline = o.budgetMs !== undefined ? Date.now() + o.budgetMs : undefined;
  let pending = 0;
  let busy = false;
  let indexing = false;
  if (existsSync(ctx.paths.spool)) {
    const reparsing = isLocked(ctx.paths.reparseLock);
    try {
      const r = await ctx.ingest({
        lock: { waitMs: o.lockWaitMs ?? (reparsing ? 0 : Math.min(1500, o.budgetMs ?? 1500)) },
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
      const waiting = await spoolBacklog(ctx.index, ctx.paths.spool).catch(() => 0);
      pending += waiting;
      if (waiting && reparsing) {
        try {
          writeFileSync(wakeMarker(ctx.paths.ingestLock), "", { mode: 0o600 });
        } catch {
          // the re-parse ingests at its next hook's marker instead
        }
      }
    }
  }
  const spoolPending = pending;
  let tail: TailIngestResult = { pending: 0, busy: false };
  // A caller with a stop signal (the viewer's worker) comes back in a few seconds: it does not wait on another tail import.
  if (!o.signal?.aborted) tail = await (deadline !== undefined ? tailIngestWithin(ctx, deadline) : tailIngest(ctx, o.signal ? { signal: o.signal, waitMs: 0 } : {}));
  pending += tail.pending;
  if (o.budgetMs !== undefined) {
    const env = o.env ?? process.env;
    // Git work the ingest left (end snapshots, repo states) is done by a background ingest, with no note: the answer is whole.
    const deferred = !busy && !pending && (await import("../core/ingest-deferred.ts").then((m) => m.hasDeferred(ctx.index)).catch(() => false));
    // An ingest holding the lock finishes the spool (and the transcripts) itself, and a process holding the tail lock the
    // transcripts; else start one, at most one per read (not with CODING_SH_NO_AUTO_INGEST=1, which also keeps the hook
    // from starting them). Transcripts another process is reading need none: a read finds them indexed when it is done.
    const tailOnly = !spoolPending && !deferred;
    const wanted = !busy && (pending > 0 || deferred) && !(tailOnly && (tail.busy || isLocked(ctx.paths.tailLock)));
    const started = wanted && env.CODING_SH_NO_AUTO_INGEST !== "1" && spawnBackgroundIngest(ingestCli(ctx.paths.cliPointer), env);
    indexing = busy || tail.busy || !!started;
    if (pending) o.out?.note(`${plural(pending, "file")} not yet ingested${indexing ? ", indexing in the background" : ""}; showing what is indexed so far (--fresh waits for all)`);
    if (started) reparseKicked = true; // that ingest re-parses too when due
  }
  await kickReparse(ctx, o.env ?? process.env);
  return { pendingFiles: pending, indexing };
}

/** The backlog while a re-parse runs: the spool files still waiting, and a wake marker so the re-parse picks them up. */
async function reparseBacklog(ctx: Context, o: AutoIngestOptions): Promise<IngestBacklog> {
  let pending = 0;
  if (existsSync(ctx.paths.spool)) {
    const { spoolBacklog } = await import("../core/ingest.ts");
    pending = await spoolBacklog(ctx.index, ctx.paths.spool).catch(() => 0);
  }
  if (pending) {
    try {
      writeFileSync(wakeMarker(ctx.paths.ingestLock), "", { mode: 0o600 });
    } catch {
      // the re-parse ingests at its next hook's marker instead
    }
    o.out?.note(`${plural(pending, "file")} not yet ingested; a re-parse is running and indexes them between its steps; showing what is indexed so far (--fresh waits for all)`);
  }
  return { pendingFiles: pending, indexing: true, reparsing: true };
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
    // A re-parse already running: don't scan the session rows to find out it is due.
    if (isLocked(ctx.paths.reparseLock)) return;
    if (!(await ctx.reparseDue())) return;
    reparseKicked = true;
    spawnBackgroundIngest(ingestCli(ctx.paths.cliPointer), env);
  } catch {
    // a store that can't answer must not break `coding.sh sessions`
  }
}

/**
 * Whether the index is being rebuilt after an upgrade: a re-parse holds reparse.lock, the
 * sessions were last folded by an older coding.sh and the background ingest kickReparse starts
 * folds them again, or this open left repricing stored cost estimates to that ingest
 * (store/factory.ts). A session is rewritten whole, so one not reached yet shows the stats and
 * cost estimates of before. A few reads of the cursors table; never fails a read.
 */
export async function refolding(ctx: Context, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // A remote store is not rebuilt by this machine's ingest.
  if (ctx.storeOverridden) return false;
  try {
    if (isLocked(ctx.paths.reparseLock)) return true;
    const { repricePending } = await import("../core/reprice.ts");
    if (await repricePending(ctx.index)) return true;
    // Nothing refolds with background ingests off, or in a store that keeps no event rows to fold from.
    if (env.CODING_SH_NO_AUTO_INGEST === "1" || !ctx.index.replaceSessionEvents) return false;
    const [{ REFOLD_CURSOR }, { foldStamp }] = await Promise.all([import("../core/ingest.ts"), import("../core/sessions.ts")]);
    if ((await ctx.index.getCursor(REFOLD_CURSOR)) === foldStamp()) return false;
    return (await ctx.index.listSessions({ limit: 1 })).length > 0;
  } catch {
    return false;
  }
}

/** The CLI a background ingest runs: this one (the bundle, or src/cli/main.ts from source), else the one init recorded. */
export function ingestCli(pointer: string): string | undefined {
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

/** Starts `node <cli> <args>` detached (it outlives this process, no output). Returns false without a CLI file to run. */
export function spawnDetachedCli(cli: string | undefined, args: string[], env: NodeJS.ProcessEnv): boolean {
  if (!cli || !existsSync(cli)) return false;
  const child = process.getBuiltinModule("node:child_process").spawn(process.execPath, [cli, ...args], { detached: true, stdio: "ignore", windowsHide: true, env: { ...env, NODE_OPTIONS: undefined } });
  child.on("error", () => {});
  child.unref();
  return true;
}

/**
 * tailIngest for a budgeted read: answers by `deadline` however long the adapters' reads take
 * (several seconds on a machine with T3 Code's database and a big projects dir), counting the
 * source it left as one file not yet ingested. Runs in a child process, and only when an adapter has a source to read.
 * Another process reading them (paths.tailLock) counts as one file too: the read answers before that import is done.
 */
async function tailIngestWithin(ctx: Context, deadline: number): Promise<TailIngestResult> {
  try {
    const { ADAPTERS } = await import("../adapters/index.ts");
    if (!ADAPTERS.some((a) => a.tail?.() || a.tailWhenUnhooked?.())) return { pending: 0, busy: false };
    // Another process is reading them: no child to start, that one has them.
    if (isLocked(ctx.paths.tailLock)) return { pending: 1, busy: true };
    const { tailWithin } = await import("./ingest-worker.ts");
    const r = await tailWithin({ env: ctx.env, cwd: process.cwd(), deadline });
    return r.busy ? { pending: 1, busy: true } : { pending: r.pending, busy: false };
  } catch {
    return { pending: 0, busy: false };
  }
}

/** What tailIngest left: files unread at its deadline or stop, and whether another process was reading the same sources. */
export interface TailIngestResult {
  pending: number;
  /** Another process held paths.tailLock past `waitMs`: this one read nothing, that one reads them. */
  busy: boolean;
}

/**
 * Imports from adapters whose store is a capture path (Adapter.tail), under paths.tailLock so one
 * process reads them at a time (a read's tail child, a background ingest and `--fresh` all do):
 * several reading the same transcripts at once only repeat each other's work. Waits `waitMs` for
 * another one (default 30 s; 0 skips while one runs), and not past an abort. Never fails a read.
 */
export async function tailIngest(ctx: Context, o: { deadline?: number; signal?: AbortSignal; waitMs?: number } = {}): Promise<TailIngestResult> {
  let pending = 0;
  const d: { deadline?: number; signal?: AbortSignal } = {};
  if (o.deadline !== undefined) d.deadline = o.deadline;
  if (o.signal) d.signal = o.signal;
  try {
    const { ADAPTERS } = await import("../adapters/index.ts");
    const agents = ADAPTERS.filter((a) => a.tail?.()).map((a) => a.id);
    // Agents whose hooks are installed but not firing yet: their transcripts
    // are the capture path until they are (a fresh `init` with Codex).
    const unhooked = ADAPTERS.flatMap((a) => {
      const t = a.tailWhenUnhooked?.();
      return t ? [{ id: a.id, since: t.since }] : [];
    });
    if (!agents.length && !unhooked.length) return { pending: 0, busy: false };
    mkdirSync(dirname(ctx.paths.tailLock), { recursive: true });
    let lock;
    try {
      const wait: LockOptions = { waitMs: o.waitMs ?? 30_000 };
      if (o.signal) wait.signal = o.signal;
      lock = await acquireLock(ctx.paths.tailLock, wait);
    } catch (e) {
      if (lockContention(e)) return { pending: 0, busy: true };
      throw e;
    }
    try {
      if (agents.length) pending += (await ctx.backfill({ agents, ...d })).pendingFiles;
      for (const t of unhooked) {
        if (o.signal?.aborted) break;
        pending += (await ctx.backfill({ agents: [t.id], ...(t.since !== undefined ? { since: t.since } : {}), ...d })).pendingFiles;
      }
    } finally {
      lock.release();
    }
  } catch {
    // a broken third-party store must not break `coding.sh sessions`
  }
  return { pending, busy: false };
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

/**
 * The session a reference names (core/session-ref.ts findSessionRef, which the MCP tools and
 * `work show` use too): the exact id, "latest" or "last" (the newest top-level session worth
 * opening), the x_ alias shortestRef prints, a unique prefix of at least MIN_ID_PREFIX characters
 * like a git short hash, an SDK id without its default project, a subagent's own id, or a short
 * subagent id (shortSessionId). An ambiguous prefix fails with the candidates listed
 * (data.candidates in --json).
 */
export async function resolveSession(ctx: Context, id: string): Promise<Session> {
  let s: Session | undefined;
  try {
    s = await findSessionRef(ctx.index, id);
  } catch (e) {
    if (e instanceof AmbiguousRef) throw ambiguousError(e);
    throw e;
  }
  if (s) return s;
  if (id === "latest" || id === "last") throw new CliError("No sessions captured yet", { reason: "not_found", next: noSessionsNextLines(ctx.env) });
  const short = id.length < MIN_ID_PREFIX ? ` (an id prefix needs at least ${MIN_ID_PREFIX} characters)` : "";
  throw new CliError(`Can't find session ${JSON.stringify(id)}${short}`, { reason: "not_found", next: ["List sessions:", "coding.sh sessions"] });
}

/** An ambiguous prefix as the CLI reports it: each candidate by the shortest id that names it alone. */
function ambiguousError(e: AmbiguousRef): CliError {
  const lines = e.candidates.map((x) => `  ${x.shortId}  ${x.agent}  ${ago(x.startedAt)}  ${oneLine(x.title ?? "", 50)}`.trimEnd());
  if (e.more) lines.push(`  …and more`);
  return new CliError(`Session id prefix ${JSON.stringify(e.ref)} is ambiguous. It matches:\n${lines.join("\n")}`, {
    reason: "ambiguous",
    next: ["Pass one of these ids, more of the id, or list sessions:", "coding.sh sessions"],
    data: { candidates: e.candidates.map((x) => ({ id: x.id, shortId: x.shortId, agent: x.agent, startedAt: new Date(x.startedAt).toISOString(), title: x.title ?? null })), more: e.more },
  });
}

// In args.ts, so main.ts quotes its hints without loading this module.
export { shellQuote } from "./args.ts";

export { latestSession, MIN_ID_PREFIX, shortSessionId, wholeRef } from "../core/session-ref.ts";

/** `--where <query>`, parsed; undefined without the flag. A bad query is a usage error (exit 2) naming where it broke. */
export function whereFlag(c: CommandContext): Query | undefined {
  const raw = str(c.flags.where);
  if (raw === undefined) return undefined;
  try {
    return parseWhere(raw);
  } catch (e) {
    throw queryCliError(e, raw);
  }
}

/**
 * The window a command read: what --since / --until and a since: / until: clause every match
 * of --where must meet resolved to. `local`: a bound was written as a day or a clock time
 * without a zone (2026-11-09, today), so this machine's zone decided the instant.
 */
export interface TimeWindow {
  since?: number;
  until?: number;
  local: boolean;
}

export function timeWindow(flags: { since?: When | undefined; until?: When | undefined }, where?: Query): TimeWindow {
  const q = timeBounds(where);
  const since = Math.max(flags.since?.ms ?? -Infinity, q.since ?? -Infinity);
  const until = Math.min(flags.until?.ms ?? Infinity, q.until ?? Infinity);
  const w: TimeWindow = { local: Boolean(flags.since?.zoned || flags.until?.zoned || q.zoned) };
  if (Number.isFinite(since)) w.since = since;
  if (Number.isFinite(until)) w.until = until;
  return w;
}

/** `window` in --json: the bounds as instants, and the UTC offset a date without a zone was read in. */
export function windowJson(w: TimeWindow, now = Date.now()): { since?: string; until?: string; utcOffset: string } {
  const bounds: { since?: string; until?: string } = {};
  if (w.since !== undefined) bounds.since = new Date(w.since).toISOString();
  if (w.until !== undefined) bounds.until = new Date(w.until).toISOString();
  return { ...bounds, utcOffset: utcOffset(new Date(w.since ?? w.until ?? now).getTimezoneOffset()) };
}

/** One line on stderr saying which instants a day word or a date without a zone became; silent for ages (7d). */
export function windowNote(out: Output, w: TimeWindow): void {
  if (!w.local || (w.since === undefined && w.until === undefined)) return;
  const at = (ms: number) => `${wallText(ms)} (UTC${utcOffset(new Date(ms).getTimezoneOffset())})`;
  out.note(w.since === undefined ? `Window: before ${at(w.until!)}, local time` : `Window: ${at(w.since)} to ${w.until === undefined ? "now" : at(w.until)}, local time`);
}

/** QueryError → exit 2 with reason, offset and a hint; QueryUnsupported → exit 1 (unsupported_store); anything else as is. */
export function queryCliError(e: unknown, raw?: string): unknown {
  if (e instanceof QueryError) {
    const where = raw === undefined ? "" : ` at character ${e.offset + 1}`;
    const details: [string, string][] = raw === undefined ? [] : [["Query", raw], ["", `${" ".repeat(e.offset)}^`]];
    return new CliError(`--where: ${e.message}${where}`, { reason: e.reason, exitCode: 2, next: e.next, details, data: { offset: e.offset } });
  }
  if (e instanceof QueryUnsupported) return new CliError(e.message, { reason: e.reason, next: ["coding.sh config get store.index shows which store is in use"] });
  return e;
}

export function str(v: FlagValue): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function list(v: FlagValue): string[] {
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

/** `--agent`: every agent named, repeated or as a comma list (the parser splits those), each once. */
export function agentsFlag(c: CommandContext): string[] {
  return [...new Set(list(c.flags.agent))];
}

/** The `--agent` names with no stored session at all (a typo, or an agent not captured yet). */
export async function agentsWithoutSessions(index: IndexStore, agents: readonly string[]): Promise<string[]> {
  const none: string[] = [];
  for (const agent of agents) if (!(await index.listSessions({ agent, limit: 1 })).length) none.push(agent);
  return none;
}

/**
 * After an empty result: an `--agent` that names no adapter and no stored session but is close to
 * an adapter id, as `suggest` judges it, is a typo (`claud-code`), rejected the way `harness audit`
 * rejects it. An SDK agent's own id is not near an adapter id, so it still filters to an empty list.
 */
export async function rejectAgentTypos(index: IndexStore, agents: readonly string[]): Promise<void> {
  if (!agents.length) return;
  const { ADAPTERS } = await import("../adapters/index.ts");
  const ids = ADAPTERS.map((a) => a.id as string);
  for (const agent of await agentsWithoutSessions(index, agents.filter((a) => !ids.includes(a)))) {
    const s = suggest(agent, ids);
    if (s) throw new UsageError(`Unknown agent ${JSON.stringify(agent)}`, { suggestion: `--agent ${s}`, reason: "unknown_agent" });
  }
}

/**
 * The agents as a store filter: one agent is SessionFilter.agent; several become an
 * `agent:a,b` clause and-joined to the `--where` query, so every read path filters the same way.
 */
export function agentScope(agents: readonly string[], where: Query | undefined): { agent?: string; where?: Query } {
  if (agents.length === 0) return where ? { where } : {};
  if (agents.length === 1) return { agent: agents[0]!, ...(where ? { where } : {}) };
  return { where: agentQuery(agents, where) };
}

/** `where` narrowed to sessions of any of `agents` (the session's agent, as `agent:` in --where is). */
export function agentQuery(agents: readonly string[], where: Query | undefined): Query {
  const cmp: Node = { t: "cmp", key: "agent", op: ":", values: agents.map((raw) => ({ raw, quoted: true, kind: "eq" as const })), at: 0 };
  // Wrapped in a group: the flag filters like SessionFilter.agent, so an agent facet must not drop
  // it the way it drops a typed `agent:` clause (withoutKey only removes top-level clauses).
  return andQuery(where ?? {}, { t: "or", items: [cmp] });
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
 * Consent for writes outside coding.sh's own data (agent configs) and for paid runs: `--yes`,
 * or an interactive y/N. Non-interactive without --yes fails with
 * confirmation_required (exit 2, askUser) and writes nothing: an agent asks the user
 * before it passes --yes.
 */
export async function requireConsent(c: CommandContext, question: string, rerun: string, opts: { defaultYes?: boolean } = {}): Promise<void> {
  if (c.flags.yes === true) return;
  if (!c.out.interactive) {
    throw new UsageError(`${question.replace(/\?$/, "")} needs confirmation from the user`, { reason: "confirmation_required", suggestion: rerun, askUser: true });
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

/** What a session's --json keeps past the digest. */
export interface SessionJsonKeep {
  /** Each derail's event locators (`eventId`, `index`): for `show`, where the events are. */
  derailEvents?: boolean;
  /** `stats.phases`: for --fields, which picks from the whole session. */
  phases?: boolean;
  /** Each model's turn times (`stats.turnsByModel.<model>.durationsMs`, up to 500): for `show` and --fields. */
  turnDurations?: boolean;
}

/**
 * A --json copy of stats with float noise taken out: a `...Usd` number rounds to 1e-9 dollars
 * (0.0041400000000000005 prints 0.00414, as the summed costs do), and so does every number in
 * an `estimatedCostBy...` map (by tier, by token type); a `...Ms` number rounds to whole ms.
 */
export function tidyNumbers<T>(v: T, key = ""): T {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || Number.isInteger(v)) return v;
    if (key.endsWith("Usd")) return (Math.round(v * 1e9) / 1e9) as T;
    if (key.endsWith("Ms")) return Math.round(v) as T;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => tidyNumbers(x, key)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    const usd = key.startsWith("estimatedCostBy");
    for (const [k, x] of Object.entries(v)) out[k] = tidyNumbers(x, usd ? "Usd" : k);
    return out as T;
  }
  return v;
}

/**
 * A session for --json. List and tree rows are a digest: `stats.phases` is left out (`show --json`
 * has the phases at its top level), so is each model's list of turn times, and a derail says what
 * happened and when, without the event it started at. Every other stat is as stored, with float
 * noise taken out (tidyNumbers).
 */
export function sessionJson(s: Session, keep: SessionJsonKeep = {}): Record<string, unknown> {
  const { phases, derails, ...rest } = tidyNumbers(s.stats);
  const stats: Record<string, unknown> = rest;
  if (derails) stats.derails = keep.derailEvents ? derails : derails.map(({ eventId: _e, index: _i, ...d }) => d);
  if (keep.phases && phases) stats.phases = phases;
  // The turn times grow with the session, as phases do: a row keeps each model's counts.
  if (rest.turnsByModel && !keep.turnDurations) {
    stats.turnsByModel = Object.fromEntries(Object.entries(rest.turnsByModel).map(([model, { durationsMs: _d, ...t }]) => [model, t]));
  }
  const out: Record<string, unknown> = { id: s.id, agent: s.agent };
  // The host app that drove the agent (T3 Code): absent for a session no host drove.
  if (s.host) out.host = s.host;
  Object.assign(out, {
    ...(s.provider ? { provider: s.provider } : {}),
    ...(s.project ? { project: s.project } : {}),
    title: s.title ?? null,
    model: s.model ?? null,
    cwd: s.cwd ?? null,
    repo: s.repo?.root ?? null,
  });
  // A linked worktree's session: the main checkout's root (RepoState.main). Absent elsewhere.
  if (s.repo?.main) out.repoMain = s.repo.main;
  return Object.assign(out, {
    branch: s.repo?.branch ?? null,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt !== undefined ? new Date(s.endedAt).toISOString() : null,
    durationMs: s.endedAt !== undefined ? Math.round(s.endedAt - s.startedAt) : null,
    parentSessionId: s.parent?.sessionId ?? null,
    flags: s.flags,
    stats,
  });
}

/** The fields of one session in --json, for --fields. */
export const SESSION_FIELDS = ["id", "agent", "host", "provider", "project", "title", "model", "cwd", "repo", "repoMain", "branch", "startedAt", "endedAt", "durationMs", "parentSessionId", "flags", "stats"] as const;

/**
 * --fields: the paths to keep of a --json document (`id,title,stats.usage.costUsd`), or undefined
 * without the flag. The first name of each path must be one of `known`.
 */
export function fieldsFlag(c: CommandContext, known: readonly string[]): string[][] | undefined {
  const raw = list(c.flags.fields);
  if (!raw.length) return undefined;
  if (!c.out.json) throw new UsageError("--fields picks from the --json document: add --json", { reason: "invalid_argument" });
  const paths = raw.map((f) => f.split("."));
  for (const [i, p] of paths.entries()) {
    if (p.some((k) => !k)) throw new UsageError(`--fields: ${JSON.stringify(raw[i])} is not a field path (id, stats.usage.costUsd)`, { reason: "invalid_argument" });
    if (!known.includes(p[0]!)) throw new UsageError(`--fields: no field ${JSON.stringify(p[0])}. Fields: ${known.join(", ")}`, { reason: "invalid_argument" });
  }
  return paths;
}

/** `doc` with only the listed paths. A path through a list picks from each item; a path that names nothing is left out. */
export function pickFields(doc: unknown, paths: readonly (readonly string[])[]): unknown {
  if (paths.some((p) => !p.length)) return doc;
  if (Array.isArray(doc)) return doc.map((x) => pickFields(x, paths)).filter((x) => x !== undefined);
  if (!doc || typeof doc !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    const under = paths.filter((p) => p[0] === k).map((p) => p.slice(1));
    const picked = under.length ? pickFields(v, under) : undefined;
    if (picked !== undefined) out[k] = picked;
  }
  return out;
}

/**
 * After an empty result: when the store holds no session at all, say how the first one gets here
 * (the same step as `show latest` and `stats`); otherwise `widen`, when given, is the next step.
 */
export async function emptyStateNext(out: Output, env: NodeJS.ProcessEnv, index: IndexStore, widen?: { label: string; command: string }): Promise<void> {
  if (!(await index.listSessions({ limit: 1 })).length) {
    const n = noSessionsNext(env);
    out.next(n.label, n.command);
  } else if (widen) out.next(widen.label, widen.command);
}
