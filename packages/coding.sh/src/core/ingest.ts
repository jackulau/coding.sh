// Ingest: spool → adapter.normalize → redact → index + blobs → sinks.
//
// Cursors are byte offsets into spool files, keyed by the file's relative path
// for the local index and by `sink:<name>:<path>` for each sink. A cursor only
// moves after the data before it is durably written (events *and* the session
// rows derived from them), so a crash at any point means re-reading some lines,
// which is harmless: event ids are deterministic and putEvents is idempotent.
//
// Sinks replay from their own cursors by re-normalizing spool lines, so an
// offline remote never blocks local capture and catches up when it returns.
//
// Transcript import (backfill) sends to the sinks too: the events it stores,
// in batches of the sink's size, with the rows of their sessions as they are
// once the import has folded them (see "backfill → sinks" below).
//
// One ingest at a time: a lockfile in the spool dir (core/lock.ts, with stale
// detection) keeps two processes from reading the same range and sending it
// to the sinks twice. The holder checks it still owns the lock before every
// cursor write and sink send, and stops with LockLostError otherwise.
//
// No lost wakeups: the hook touches `spool/.ingest.pending` after appending an
// end event and before looking at the lock (spool/kick.ts). The holder clears
// the marker before each pass and, after releasing, runs another pass when it
// is back (bounded), so a session that ended mid-ingest is never left waiting
// for an unrelated trigger.
//
// Order: spool files are read oldest first (listSpoolFiles), and cursors move
// at run-level checkpoints, so a tool.end read before its tool.start (another
// hook process, another file) still gets its duration filled in.
//
// Enrichment applied to every event, whatever the adapter:
// - `source` defaults to the capture path ("hook", "wrapper", "transcript").
// - tool.end without durationMs gets end.ts − start.ts from the tool.start
//   with the same toolUseId (this run, or already in the index).
// - A child session named only by a parent's subagent.* childSessionId is
//   linked even when the child arrives in a later run (the link is kept in
//   the index kv when the store has one).
// - Backfilled (transcript) copies of prompts/replies that a live capture
//   path already recorded for the same session are dropped: live wins. A live
//   prompt a backfill already stored is kept out of the local index. A
//   session.start, session.end or compaction the other path already stored
//   for the session is dropped too (./message-copies.ts).
// - Model calls with tokens but no cost get a list-price costUsd (built-in
//   prices with `[prices]` overrides, ./pricing.ts), as serve does.
// - Adapters keep the raw source payload as blobs[0] on the FIRST event each
//   spool line produces (not on every event), so one payload is stored once.
// - A session with a cwd inside a git work tree but no repo state (hooks and
//   transcripts do no git work) gets a HEAD-only start state (./repo-state.ts).
// - A live end-of-turn/session event ingested soon after it happened (the hook
//   kicks an ingest on Stop/SessionEnd) gets a working-tree snapshot as the
//   session's endSnapshot, so `eval new` has a reference patch.
//
// Backfill keeps a per-file cursor (size, mtime, since) for adapters that
// report their source files, skips files unchanged since the last run, and
// recomputes only sessions that received new events.
//
// A fold that throws (a coding.sh bug on some stored events) never stops an
// ingest or a backfill: the session gets a row with what its events say
// directly, tagged fold:error with Session.stats.foldError, and the error is
// reported. Before, one such session ended the run there, and every session
// after it kept its events with no row (RT-11). `repair` (`coding.sh ingest`)
// folds sessions that have events but no row, and fold:error rows, again.
import type { AgentEvent, Session } from "../schema/index.ts";
import { isEventKind } from "../schema/index.ts";
import type { Adapter, BackfillFile, BlobStore, Config, IndexStore, NormalizeContext, OpenSession, Sink, SinkAck, SpoolLine } from "./types.ts";
import { resolveRepoConfig, isExcluded } from "./config.ts";
import { acquireLock, LockBusyError, wakeMarker, type Lock, type LockOptions } from "./lock.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { dirname, join } from "node:path";
import { hashParts, sha256Hex } from "./ids.ts";
import { paths } from "./paths.ts";
import { createRedactor, noteBlobHits, redactBlobValue, redactEventCounted, redactionTally, sessionToMetadata, toMetadata, type RedactionTally, type Redactor } from "./redact.ts";
import { buildSession, byTime, FLAGS, foldSession, foldStamp, isBackfillEvent, isFoldState, isRealPrompt, isVerifyToolStart, sessionOf, sessionState, type SessionState } from "./sessions.ts";
import { copyFilter } from "./message-copies.ts";
import { priceEvent, pricesFor } from "./pricing.ts";
import { listSpoolFiles, readSpoolFile, type SpoolFile } from "./spool-read.ts";
import { repoResolver, type RepoResolver } from "./repo-state.ts";
import { snapshot } from "./snapshot.ts";
import { isWrapperLine } from "../adapters/more/wrapper.ts";
import { rememberTraceSessions } from "../adapters/_shared/traceparent.ts";
import { traceKvKey } from "../otel/map.ts";
import { linkSpawned } from "../spool/spawned.ts";
import { matchSpawnedParent, openAt } from "../spool/spawned-match.ts";

export const PUT_BATCH = 500;
const DEFAULT_CHECKPOINT_EVENTS = 5000;
/** A run that stored more events than this folds the store's write-ahead log back in before it returns. */
export const BULK_WRITE_EVENTS = 10_000;
const DEFAULT_SINK_BATCH = 500;
/** Backoff for a sink that failed without saying when to retry (e.g. 401). */
const PERMANENT_FAILURE_BACKOFF_MS = 10 * 60_000;
const MAX_ERRORS = 500;
/**
 * An end-of-turn/session event older than this when ingested gets no end
 * snapshot: the working tree has likely moved on since, and a later state
 * would be recorded as the agent's work.
 */
export const END_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
/** Passes one ingest() call runs at most while the wake-up marker keeps coming back. */
const MAX_PASSES = 3;

export const sinkCursorKey = (sink: string, source: string): string => `sink:${sink}:${source}`;
export const sinkRetryKey = (sink: string): string => `sink:${sink}#retryAt`;

export interface IngestOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  sinks?: Sink[];
  adapters: Map<string, Adapter>;
  env?: NodeJS.ProcessEnv;
  /** Spool directory (default paths(env).spool). */
  spoolDir?: string;
  /** Events buffered before a checkpoint (session recompute + cursor advance). */
  checkpointEvents?: number;
  now?: () => number;
  /** Cross-process lock (default: `<spoolDir>/.ingest.lock`, wait 30 s). false = no lock. */
  lock?: false | (LockOptions & { path?: string });
  /**
   * Stop at the next checkpoint once Date.now() passes this (ms epoch) and at least one
   * file has been read (so every run makes progress). Cursors cover exactly what was stored, so the next ingest resumes there; `pendingFiles` says how
   * many spool files still hold unread lines. Reads use it to answer from what is indexed.
   */
  deadline?: number;
  /** Like `deadline`, on abort: stop at the next checkpoint (`coding.sh ui` shutting down its ingest worker). */
  signal?: AbortSignal;
  /** Called with the number of spool files still holding unread lines: once listed, then after each checkpoint. */
  onProgress?: (p: { filesPending: number }) => void;
  /** Also fold sessions that have events but no row, and rows tagged fold:error (repairSessions), under the lock. */
  repair?: boolean;
}

export interface IngestError {
  source?: string;
  offset?: number;
  sink?: string;
  message: string;
}

export interface SinkReport {
  name: string;
  /** Events acknowledged by the sink in this run. */
  sent: number;
  ok: boolean;
  error?: string;
  /** Set when the sink is backing off and was skipped (ms epoch). */
  retryAt?: number;
}

export interface IngestResult {
  /** Spool lines newly consumed by the local index. */
  lines: number;
  /** Events newly inserted (0 on a re-run). */
  events: number;
  /** Sessions recomputed and upserted. */
  sessions: number;
  /** Lines skipped because their cwd matched capture.exclude. */
  excluded: number;
  errors: IngestError[];
  sinks: SinkReport[];
  /** Spool files left with unread lines because `deadline` passed or `signal` aborted (0 otherwise). */
  pendingFiles: number;
  /** With `repair`: sessions that had events but no row, or a fold:error row, folded again. Unset when there were none. */
  repaired?: number;
}

interface LineEvents {
  offset: number;
  nextOffset: number;
  events: AgentEvent[];
}

export interface CaptureProfile {
  config: Config;
  redactor: Redactor;
}

/** Per-cwd capture settings (repo overrides), cached for one run. A bad repo config falls back to the user one. */
export function profileCache(config: Config, env: NodeJS.ProcessEnv, error: (e: IngestError) => void): (cwd: string | undefined) => CaptureProfile {
  const profiles = new Map<string, CaptureProfile>();
  return (cwd) => {
    const key = cwd ?? "";
    let p = profiles.get(key);
    if (!p) {
      let cfg = config;
      if (cwd) {
        try {
          cfg = resolveRepoConfig(config, cwd, env);
        } catch (err) {
          error({ message: `ignoring repo config for ${cwd}: ${(err as Error).message}` });
        }
      }
      p = { config: cfg, redactor: createRedactor({ redact: cfg.capture.redact, patterns: cfg.capture.redactPatterns, env }) };
      profiles.set(key, p);
    }
    return p;
  };
}

/**
 * Adapter.parseVersion for a session's agent (default 1). A name with no
 * adapter of its own is a `coding.sh run --agent <name>` wrapper session.
 */
export function parseVersionFor(adapters: ReadonlyMap<string, Adapter>, agent: string): number | undefined {
  const a = adapters.get(agent) ?? adapters.get("wrapper");
  return a ? (a.parseVersion ?? 1) : undefined;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function validEvent(e: AgentEvent): string | undefined {
  if (!e || typeof e !== "object") return "adapter returned a non-object event";
  if (typeof e.id !== "string" || !e.id) return "event has no id";
  if (typeof e.sessionId !== "string" || !e.sessionId) return `event ${e.id} has no sessionId`;
  if (typeof e.kind !== "string" || !isEventKind(e.kind)) return `event ${e.id} has unknown kind ${JSON.stringify(e.kind)}`;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return `event ${e.id} has no numeric ts`;
  if (typeof e.payload !== "object" || e.payload === null) return `event ${e.id} has no payload object`;
  return undefined;
}

export { BACKFILL_SOURCES } from "./sessions.ts";
const isBackfill = isBackfillEvent;

/** Cursor holding the foldStamp() every stored session was last folded with (core/reparse.ts refolds the rest). */
export const REFOLD_CURSOR = "reparse:fold";

/** A store with no sessions yet has nothing to refold: marks it current before its first session lands. */
async function markFreshStore(index: IndexStore): Promise<void> {
  if ((await index.getCursor(REFOLD_CURSOR)) === foldStamp()) return;
  if (!(await index.listSessions({ limit: 1 })).length) await index.setCursor(REFOLD_CURSOR, foldStamp());
}

/** kv key holding a pending parent link for a child session. */
export const childLinkKey = (childId: string): string => `child-link:${childId}`;
/** kv key holding the ids (a JSON array) of sessions whose hook named this session as their parent when that link did not hold (childLinker). */
export const childWaitKey = (parentId: string): string => `child-wait:${parentId}`;
/** Most children kept waiting on one named parent: a shell with a stale id can start any number. */
const MAX_WAITING = 50;

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const env = opts.env ?? process.env;
  const spoolDir = opts.spoolDir ?? paths(env).spool;
  // No spool dir = nothing to read; don't create one just to lock it.
  if (opts.lock === false || !existsSync(spoolDir)) return ingestLocked(opts, env, spoolDir, () => {});
  const lo = opts.lock ?? {};
  const lockPath = lo.path ?? join(spoolDir, ".ingest.lock");
  const marker = wakeMarker(lockPath);
  let total: IngestResult | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let lock: Lock;
    try {
      lock = await acquireLock(lockPath, pass === 0 ? lo : { ...lo, waitMs: 0 });
    } catch (e) {
      // Another ingest took over after our release: it clears and handles the marker.
      if (total && e instanceof LockBusyError) break;
      throw e;
    }
    try {
      // Cleared before listing files: a hook appends, then touches the marker,
      // so a file this pass misses always leaves the marker set.
      rmSync(marker, { force: true });
      // Repair once: a later pass only drains what hooks appended meanwhile.
      const r = await ingestLocked(pass === 0 ? opts : { ...opts, repair: false }, env, spoolDir, () => lock.assertHeld());
      total = total ? mergeResults(total, r) : r;
    } finally {
      lock.release();
    }
    // Out of time: the marker stays for whoever ingests next.
    if (total.pendingFiles) break;
    // Checked after release: a hook that saw the lock held touched the marker before it looked.
    if (!existsSync(marker)) break;
  }
  return total!;
}

/** Spool files whose local cursor is short of their end: what an ingest has yet to read (without taking the lock). */
export async function spoolBacklog(index: IndexStore, spoolDir: string): Promise<number> {
  let n = 0;
  for (const f of await listSpoolFiles(spoolDir)) if ((await index.getCursor(f.source)) < f.size) n++;
  return n;
}

function mergeResults(a: IngestResult, b: IngestResult): IngestResult {
  const sinks = a.sinks.map((s) => ({ ...s }));
  for (const s of b.sinks) {
    const prev = sinks.find((x) => x.name === s.name);
    if (!prev) {
      sinks.push({ ...s });
      continue;
    }
    prev.sent += s.sent;
    prev.ok &&= s.ok;
    if (s.error !== undefined) prev.error = s.error;
    if (s.retryAt !== undefined) prev.retryAt = s.retryAt;
  }
  return {
    lines: a.lines + b.lines,
    events: a.events + b.events,
    sessions: a.sessions + b.sessions,
    excluded: a.excluded + b.excluded,
    errors: [...a.errors, ...b.errors].slice(0, MAX_ERRORS + 1),
    sinks,
    pendingFiles: b.pendingFiles,
    ...(a.repaired || b.repaired ? { repaired: (a.repaired ?? 0) + (b.repaired ?? 0) } : {}),
  };
}

/** `fence` throws when this run no longer owns the ingest lock; called before every cursor write and sink send. */
async function ingestLocked(opts: IngestOptions, env: NodeJS.ProcessEnv, spoolDir: string, fence: () => void): Promise<IngestResult> {
  const { config, index, blobs, adapters } = opts;
  const now = opts.now ?? Date.now;
  const checkpointEvents = opts.checkpointEvents ?? DEFAULT_CHECKPOINT_EVENTS;
  const result: IngestResult = { lines: 0, events: 0, sessions: 0, excluded: 0, errors: [], sinks: [], pendingFiles: 0 };
  await markFreshStore(index);
  let droppedErrors = 0;
  const error = (e: IngestError) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(e);
    else droppedErrors++;
  };

  const profileFor = profileCache(config, env, error);
  // Fail fast on a bad user config (e.g. invalid redact pattern) before touching anything.
  profileFor(undefined);

  // Blob puts write behind; checkpoint() flushes them before any row that references them.
  const blobBatch = blobs.batch?.();
  const blobStore = blobBatch ?? blobs;

  // Sinks currently allowed to send (not backing off).
  const sinkStates = await sinkStatesFor(index, opts.sinks ?? [], now);
  const touchedAll = new Set<string>();

  const durations = toolDurationFiller(index);

  const linker = childLinker(index);
  const normalize = spoolNormalizer({ adapters, blobs: blobStore, env, profileFor, error, excluded: () => result.excluded++, spawned: (child, link) => linker.offer(child, link) });
  const repo = repoResolver();
  const versionFor = (agent: string) => parseVersionFor(adapters, agent);
  // Latest live end-of-turn/session ts per session, from lines new in this run.
  const freshEnds = new Map<string, number>();
  const endSnapshot = async (s: Session) => {
    const endTs = freshEnds.get(s.id);
    if (endTs === undefined) return;
    freshEnds.delete(s.id);
    const root = s.repo?.root;
    if (!root || s.runId || now() - endTs > END_SNAPSHOT_MAX_AGE_MS) return;
    const snap = profileFor(s.cwd).config.snapshot;
    if (!snap.enabled) return;
    try {
      const state = await snapshot(root, { env, maxFiles: snap.maxFiles, timeoutMs: snap.timeoutMs, message: `coding.sh end ${s.id}` });
      if (state?.snapshot && state.root === root) s.endSnapshot = state.snapshot;
    } catch (err) {
      error({ message: `end snapshot of ${root} for session ${s.id} failed: ${(err as Error).message}` });
    }
  };
  const onFoldError = (f: FoldFailure) => error({ message: foldFailureMessage(f) });
  const recompute = async (ids: Iterable<string>) => {
    for (const id of ids) {
      if (await recomputeSession(index, id, { linker, repo, versionFor, onFoldError })) touchedAll.add(id);
    }
  };
  // After the checkpoint commits: git can take seconds, too long to hold the index's write lock.
  const snapshotEnded = async () => {
    for (const id of [...freshEnds.keys()]) {
      const s = await index.getSession(id);
      if (!s) {
        freshEnds.delete(id);
        continue;
      }
      const before = s.endSnapshot;
      await endSnapshot(s);
      if (s.endSnapshot === before) continue;
      // Git took a while: the snapshot goes on the row as it is now, which another process may have written meanwhile (storeEnrichment).
      const snap = s.endSnapshot;
      await inTransaction(index, async () => {
        const row = await index.getSession(id);
        if (row) await index.upsertSession({ ...row, endSnapshot: snap });
      });
    }
  };
  const atomically = <T>(fn: () => Promise<T>): Promise<T> => inTransaction(index, fn);

  const sendToSink = async (sink: Sink, file: SpoolFile, window: LineEvents[], readPos: number) => {
    const state = sinkStates.get(sink)!;
    if (state.failed) return;
    const key = sinkCursorKey(sink.name, file.source);
    const from = await index.getCursor(key);
    const lines = window.filter((l) => l.offset >= from);
    const size = sinkBatchSize(config, sink);
    let i = 0;
    while (i < lines.length) {
      const batch: AgentEvent[] = [];
      let end = i;
      // Never split a line's events across batches: the cursor is per line.
      while (end < lines.length && (batch.length === 0 || batch.length + lines[end]!.events.length <= size)) {
        batch.push(...lines[end]!.events);
        end++;
      }
      if (batch.length) {
        const sessions = await sessionsFor(index, batch);
        const meta = sink.mode === "metadata";
        const sent = await sinkSend(index, sink, state, () => sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, blobStore), { now, fence, error: (message) => error({ sink: sink.name, source: file.source, message }) });
        if (!sent) return;
        state.sent += batch.length;
      }
      fence();
      await index.setCursor(key, lines[end - 1]!.nextOffset);
      i = end;
    }
    // Covers trailing lines with no events (blank, invalid, excluded).
    if (readPos > from) {
      fence();
      await index.setCursor(key, readPos);
    }
  };

  // Files read since the last checkpoint. Events are buffered across files and
  // cursors move together at run-level checkpoints (flush → recompute → cursors
  // → sinks), so a tool.end read before its tool.start in a later file is
  // still filled in before either is stored or sent.
  interface FileRun {
    file: SpoolFile;
    local: number;
    readPos: number;
    active: Sink[];
    window: LineEvents[];
  }
  let open: FileRun[] = [];
  let pending: AgentEvent[] = [];
  const copies = copyFilter(index);
  let windowEvents = 0;
  const touched = new Set<string>();
  const checkpoint = async () => {
    // Durable blobs first: no committed row may reference one a power loss could take back.
    await blobBatch?.flush();
    // Events, the session rows folded from them and the cursors past their lines commit
    // as one transaction (when the store has them), so a crash leaves the index exactly
    // at the previous checkpoint and the next run re-reads from there.
    const inserted = await atomically(async () => {
      let n = 0;
      for (let i = 0; i < pending.length; i += PUT_BATCH) n += (await index.putEvents(pending.slice(i, i + PUT_BATCH))).inserted;
      // Hook events in an agent's OTel trace (a traceparent): that trace's spans join their session.
      await rememberTraceSessions(index, pending, traceKvKey);
      durations.settle();
      await recompute(touched);
      for (const f of open) {
        if (f.readPos <= f.local) continue;
        fence();
        await index.setCursor(f.file.source, f.readPos);
      }
      return n;
    });
    result.events += inserted;
    pending = [];
    touched.clear();
    for (const f of open) f.local = Math.max(f.local, f.readPos);
    await snapshotEnded();
    for (const f of open) {
      for (const sink of f.active) await sendToSink(sink, f.file, f.window, f.readPos);
      f.window = [];
    }
    open = [];
    windowEvents = 0;
  };

  const files = await listSpoolFiles(spoolDir);
  // The deadline counts once a file has been read, so a budgeted run always makes progress
  // (a slow start, such as loading the adapters, never leaves a read with nothing new).
  let readAny = false;
  const outOfTime = () => !!opts.signal?.aborted || (readAny && opts.deadline !== undefined && Date.now() >= opts.deadline);
  /** Files from `from` on whose local cursor is short of their end. */
  const unread = async (from: number) => {
    let n = 0;
    for (let i = from; i < files.length; i++) if ((await index.getCursor(files[i]!.source)) < files[i]!.size) n++;
    return n;
  };
  let left = opts.onProgress ? await unread(0) : 0;
  opts.onProgress?.({ filesPending: left });
  let stopped = false;
  for (let fi = 0; fi < files.length && !stopped; fi++) {
    const file = files[fi]!;
    if (outOfTime()) {
      result.pendingFiles = await unread(fi);
      break;
    }
    let local = await index.getCursor(file.source);
    if (local > file.size) {
      // Recreated at the same path (pid reuse after gc, say): start over for every consumer.
      error({ source: file.source, message: `cursor ${local} is past the end of the file (${file.size} bytes); re-reading from the start` });
      local = 0;
      fence();
      await index.setCursor(file.source, 0);
    }
    const sinkFrom = new Map<Sink, number>();
    for (const sink of sinkStates.keys()) {
      const key = sinkCursorKey(sink.name, file.source);
      let c = await index.getCursor(key);
      if (c > file.size) {
        error({ sink: sink.name, source: file.source, message: `sink cursor ${c} is past the end of the file (${file.size} bytes); re-sending from the start` });
        c = 0;
        fence();
        await index.setCursor(key, 0);
      }
      sinkFrom.set(sink, c);
    }
    const active = [...sinkStates].filter(([, s]) => !s.failed).map(([sink]) => sink);
    const start = Math.min(local, ...active.map((s) => sinkFrom.get(s)!));
    if (start >= file.size) continue;

    readAny = true;
    const fr: FileRun = { file, local, readPos: start, active, window: [] };
    open.push(fr);
    const keepWindow = active.length > 0;
    const reader = readSpoolFile(spoolDir, file.path, start, {
      onError: (e) => {
        if (e.offset >= fr.local) error({ source: e.source, offset: e.offset, message: e.message });
        fr.readPos = Math.max(fr.readPos, e.nextOffset);
      },
    });
    for await (const rec of reader) {
      const events = await durations(await normalize(rec.line, rec.source, rec.offset));
      fr.readPos = rec.nextOffset;
      if (rec.offset >= fr.local) {
        result.lines++;
        // A prompt a backfill already stored stays out of the local index (sinks still get it).
        for (const e of events) if (!(await copies.isCopy(e))) pending.push(e);
        for (const e of events) {
          touched.add(e.sessionId);
          if ((e.kind === "turn.end" || e.kind === "session.end") && !isBackfill(e) && !e.repo?.snapshot) {
            freshEnds.set(e.sessionId, Math.max(e.ts, freshEnds.get(e.sessionId) ?? -Infinity));
          }
        }
      }
      if (keepWindow) fr.window.push({ offset: rec.offset, nextOffset: rec.nextOffset, events });
      // Bounds memory (buffered events, sink windows) and how much work a crash can force us to redo.
      windowEvents += events.length;
      if (windowEvents >= checkpointEvents) {
        await checkpoint();
        open = [fr];
        opts.onProgress?.({ filesPending: left });
        if (outOfTime()) {
          stopped = true;
          break;
        }
      }
    }
    if (stopped) result.pendingFiles = (fr.readPos < file.size ? 1 : 0) + (await unread(fi + 1));
    else if (local < file.size) left--;
  }
  await checkpoint();
  opts.onProgress?.({ filesPending: result.pendingFiles });

  if (opts.repair) {
    fence();
    const repaired = await repairSessions(index, { linker, repo, versionFor, onFoldError });
    for (const id of repaired) touchedAll.add(id);
    if (repaired.length) result.repaired = repaired.length;
  }

  // Applied after every file so a child ingested before its parent is still linked.
  for (const id of await linker.apply()) touchedAll.add(id);

  result.sessions = touchedAll.size;
  // A bulk drain leaves a WAL as big as what it wrote until some later read-write close.
  if (result.events > BULK_WRITE_EVENTS) await Promise.all([index.checkpoint?.(), blobs.checkpoint?.()]);
  result.sinks.push(...sinkReports(sinkStates));
  if (droppedErrors) result.errors.push({ message: `…and ${droppedErrors} more errors` });
  return result;
}

// ---------------------------------------------------------------- sinks

/** A sink in one run: its report, and `failed` once it is backing off or a send failed (nothing more goes to it in this run). */
type SinkState = SinkReport & { failed: boolean };

/** Every configured sink's state as a run starts: one still backing off (sinkRetryKey) starts failed. */
async function sinkStatesFor(index: IndexStore, sinks: Sink[], now: () => number): Promise<Map<Sink, SinkState>> {
  const states = new Map<Sink, SinkState>();
  for (const sink of sinks) {
    const retryAt = await index.getCursor(sinkRetryKey(sink.name));
    const state: SinkState = { name: sink.name, sent: 0, ok: true, failed: false };
    if (retryAt > now()) {
      state.retryAt = retryAt;
      state.failed = true;
    }
    states.set(sink, state);
  }
  return states;
}

const sinkReports = (states: Map<Sink, SinkState>): SinkReport[] => [...states.values()].map(({ failed: _failed, ...report }) => report);

const sinkBatchSize = (config: Config, sink: Sink): number => config.sinks.find((s) => (s.name ?? s.kind) === sink.name)?.batchSize ?? DEFAULT_SINK_BATCH;

/**
 * One write to a sink. False when it was refused or threw: the sink is failed
 * for the rest of the run, its backoff is stored (so later runs skip it until
 * then) and the error reported. `fence` runs before the send and the cursor write.
 */
async function sinkSend(index: IndexStore, sink: Sink, state: SinkState, write: () => Promise<SinkAck>, o: { now: () => number; fence: () => void; error: (message: string) => void }): Promise<boolean> {
  o.fence();
  let ack: SinkAck;
  try {
    ack = await write();
  } catch (err) {
    ack = { ok: false, error: (err as Error).message };
  }
  if (ack.ok) return true;
  state.ok = false;
  state.failed = true;
  state.error = ack.error ?? "sink rejected the batch";
  state.retryAt = o.now() + (ack.retryAfterMs ?? PERMANENT_FAILURE_BACKOFF_MS);
  o.fence();
  await index.setCursor(sinkRetryKey(sink.name), state.retryAt);
  o.error(state.error);
  return false;
}

/** `fn` as one transaction when the store has them. */
const inTransaction = <T>(index: IndexStore, fn: () => Promise<T>): Promise<T> => (index.transaction ? index.transaction(fn) : fn());

// ---------------------------------------------------------------- shared steps

export interface SpoolNormalizerOptions {
  adapters: Map<string, Adapter>;
  blobs: BlobStore;
  env: NodeJS.ProcessEnv;
  profileFor: (cwd: string | undefined) => CaptureProfile;
  error: (e: IngestError) => void;
  /** A line skipped because its cwd matched capture.exclude. */
  excluded: () => void;
  /** A session whose hook's env named another agent's session (SpoolLine.spawnedBy): the parent link it offers, unchecked. */
  spawned?: (childSessionId: string, link: NonNullable<Session["parent"]>) => Promise<void>;
  /** A file a line reads a session's events from is gone or out of reach (NormalizeContext.missing). */
  missing?: (path: string, sessionId: string) => void;
}

/**
 * Spool line → stored-form events: the line's adapter (a `coding.sh run` line
 * with no adapter of its own goes to the wrapper), then the enrichment every
 * event gets (runId, capture-path source, gateway, host), redaction, metadata
 * stripping and list prices. Invalid events and adapter failures are reported.
 */
export function spoolNormalizer(o: SpoolNormalizerOptions): (line: SpoolLine, source: string, offset: number) => Promise<AgentEvent[]> {
  const { adapters, blobs, env, profileFor, error } = o;
  return async (line, source, offset) => {
    const profile = profileFor(line.cwd);
    const capture = profile.config.capture;
    if (line.cwd && isExcluded(line.cwd, capture.exclude, env)) {
      o.excluded();
      return [];
    }
    // `coding.sh run --agent my-agent -- …` spools under any name: an id with no
    // adapter of its own is still a wrapper session, recorded under that name.
    const adapter = adapters.get(line.agent) ?? (isWrapperLine(line) ? adapters.get("wrapper") : undefined);
    if (!adapter) {
      error({ source, offset, message: `no adapter registered for agent ${JSON.stringify(line.agent)}; line skipped` });
      return [];
    }
    const metadata = capture.mode === "metadata";
    const ctx = normalizeContext(profile, blobs, metadata, { file: source, offset });
    if (o.missing) ctx.missing = o.missing;
    let raw: AgentEvent[];
    try {
      raw = await adapter.normalize(line, ctx);
    } catch (err) {
      error({ source, offset, message: `${adapter.id}.normalize failed: ${(err as Error).message}` });
      return [];
    }
    const capturePath = line.agent === "wrapper" || adapter.id === "wrapper" ? "wrapper" : "hook";
    const out: AgentEvent[] = [];
    for (const e of raw) {
      const problem = validEvent(e);
      if (problem) {
        error({ source, offset, message: `${adapter.id}: ${problem}` });
        continue;
      }
      let ev = e;
      if (ev.runId === undefined && line.runId) ev = { ...ev, runId: line.runId };
      if (ev.source === undefined) ev = { ...ev, source: capturePath };
      // Gateway routing seen in the hook's env: mark model calls, and the line's
      // first event so the session is tagged even when no call is in this line.
      if (line.gateway && ev.payload.gateway === undefined && (ev.kind === "llm.call" || out.length === 0)) ev = { ...ev, payload: { ...ev.payload, gateway: line.gateway } };
      // Host app (T3 Code) that launched the agent: buildSession attributes the session to it.
      if (line.host && ev.payload.via === undefined) ev = { ...ev, payload: { ...ev.payload, via: line.host.id, ...(line.host.thread ? { hostThreadId: line.host.thread } : {}) } };
      // Started from another agent's shell tool (spool/spawned.ts): the linker gets the session the
      // hook's env named. Nothing is written into the event: the marker can be stale, and only the
      // linker, once the run's sessions are in the index, can tell (childLinker.apply).
      if (line.spawnedBy) {
        const link = linkSpawned(line.spawnedBy, ev.sessionId);
        if (link) await o.spawned?.(ev.sessionId, { sessionId: link.parentSessionId!, type: "harness" });
      }
      // HEAD a 0.1.3 hook read from .git as the session started: the start commit (./repo-state.ts).
      // Later hooks do no git work; their sessions' start commit comes from the reflog.
      if (line.git && ev.kind === "session.start" && ev.payload.git === undefined) {
        const git: Record<string, string> = {};
        if (line.git.head) git.commit = line.git.head;
        if (line.git.branch) git.branch = line.git.branch;
        if (git.commit || git.branch) ev = { ...ev, payload: { ...ev.payload, git } };
      }
      out.push(finishEvent(ev, profile, metadata));
    }
    return out;
  };
}

export function normalizeContext(profile: CaptureProfile, blobs: Pick<BlobStore, "put">, metadata: boolean, source?: { file: string; offset: number }): NormalizeContext {
  const ctx: NormalizeContext = {
    maxInlineBytes: profile.config.capture.maxInlineBytes,
    id: (...parts) => hashParts(...parts),
    blob: async (data) => {
      const tally = redactionTally();
      const clean = redactBlob(data, profile.redactor, tally);
      // Metadata mode keeps no content locally either: hand back the ref, store nothing.
      const ref = metadata ? sha256Hex(clean) : await blobs.put(clean);
      noteBlobHits(ref, tally.kinds);
      return ref;
    },
    blobValue: async (value) => {
      const tally = redactionTally();
      const clean = redactBlobValue(profile.redactor, value, tally);
      const ref = metadata ? sha256Hex(clean) : await blobs.put(clean);
      noteBlobHits(ref, tally.kinds);
      return ref;
    },
  };
  if (source) ctx.source = source;
  return ctx;
}

/**
 * Redaction, then metadata stripping (keeping the "a check ran" signal the
 * no-verification detector needs), then a list-price cost on model calls that
 * report tokens but no cost (built-in prices, `[prices]` overrides), as serve does.
 */
export function finishEvent(e: AgentEvent, profile: CaptureProfile, metadata: boolean): AgentEvent {
  let ev = redactEventCounted(profile.redactor, e);
  if (metadata) {
    const verify = isVerifyToolStart(ev);
    ev = toMetadata(ev);
    if (verify) ev.payload.verify = true;
  }
  return priceEvent(ev, pricesFor(profile.config.pricing));
}

/**
 * Fills tool.end durationMs from the tool.start with the same toolUseId when the
 * adapter could not. Starts seen in this run are remembered; earlier ones are
 * looked up in the index once per session. A tool.end whose start has not been
 * seen yet is kept, and filled in place when the start arrives later in the
 * run (another hook process's file read after this one), as long as that is
 * before the next checkpoint stores it: settle() marks that point.
 */
export type DurationFiller = ((events: AgentEvent[]) => Promise<AgentEvent[]>) & { settle(): void };
export function toolDurationFiller(index: IndexStore): DurationFiller {
  const starts = new Map<string, Map<string, number>>();
  const loaded = new Set<string>();
  // sessionId → toolUseId → tool.end still waiting for its start (not yet stored).
  const orphans = new Map<string, Map<string, AgentEvent>>();
  const remember = (e: AgentEvent) => {
    const id = e.payload.toolUseId;
    if (e.kind !== "tool.start" || typeof id !== "string") return;
    let m = starts.get(e.sessionId);
    if (!m) starts.set(e.sessionId, (m = new Map()));
    if (!m.has(id)) m.set(id, e.ts);
    const end = orphans.get(e.sessionId)?.get(id);
    if (end) {
      orphans.get(e.sessionId)!.delete(id);
      if (end.ts >= e.ts) {
        end.durationMs = end.ts - e.ts;
        end.payload = { ...end.payload, durationMs: end.durationMs };
      }
    }
  };
  const fill = async (events: AgentEvent[]) => {
    for (const e of events) remember(e);
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const id = e.payload.toolUseId;
      if (e.kind !== "tool.end" || typeof id !== "string") continue;
      const own = typeof e.payload.durationMs === "number" ? e.payload.durationMs : undefined;
      if (e.durationMs !== undefined) continue;
      let ms = own;
      if (ms === undefined) {
        let start = starts.get(e.sessionId)?.get(id);
        if (start === undefined && !loaded.has(e.sessionId)) {
          loaded.add(e.sessionId);
          for (const s of await index.listEvents(e.sessionId, { kinds: ["tool.start"] })) remember(s);
          start = starts.get(e.sessionId)?.get(id);
        }
        if (start === undefined) {
          // Its start may still come later in this run: fill this very object then.
          const copy = { ...e };
          events[i] = copy;
          let m = orphans.get(e.sessionId);
          if (!m) orphans.set(e.sessionId, (m = new Map()));
          m.set(id, copy);
          continue;
        }
        if (e.ts < start) continue;
        ms = e.ts - start;
      }
      events[i] = { ...e, durationMs: ms, payload: own === undefined ? { ...e.payload, durationMs: ms } : e.payload };
    }
    return events;
  };
  return Object.assign(fill, { settle: () => orphans.clear() });
}

export interface ChildLinker {
  /** Remember links named by these (parent) events. */
  observe(parentId: string, events: AgentEvent[]): Promise<void>;
  /** Remember a link the child named itself (a harness child's spool line) for apply() to check, unless one is known already. */
  offer(childId: string, link: NonNullable<Session["parent"]>): Promise<void>;
  /** A pending link for a session that has none, if any. */
  pending(childId: string): Promise<NonNullable<Session["parent"]> | undefined>;
  /** False for a link the child named itself whose parent is not in the index, or was not open when the child started. */
  holds(child: Pick<Session, "startedAt">, link: NonNullable<Session["parent"]>): Promise<boolean>;
  /** A session new to the index that nothing links: apply() matches it to another session's shell call. */
  consider(childId: string): void;
  /** A session's row was written: children that named it before their link held offer it again. */
  arrived(parent: Session): Promise<void>;
  /** Applies links observed this run to children already in the index. Returns updated ids. */
  apply(): Promise<string[]>;
}

/**
 * Parent links named only by a parent's subagent.start|end { childSessionId }:
 * kept in memory for this run and, when the store has kv, durably, so a child
 * ingested in a later run than its parent is still linked.
 *
 * A child started from another agent's shell tool offers its own link (its
 * spool lines' spawnedBy, type "harness"). The id comes from the hook's env,
 * which can be stale (a shell that outlived the agent that started it), so the
 * link is kept only when it holds(): the named session is in the index and was
 * open when the child started. apply() checks it, after the whole run, so a
 * parent whose lines came later in the run counts. A link that does not hold is
 * not made and the session stays top-level. The named session may still be its
 * parent: one known only from its transcript is read later than the child's
 * hooks, and ends at its last activity so far, which is the shell call that
 * started the child until that call returns. So the child waits under that
 * session's id (kv, the newest MAX_WAITING), and is offered again when the
 * session's row is written (arrived()), as it is by its own later lines.
 *
 * New sessions linked by neither are matched at apply() to a shell call of
 * another session that ran their agent's CLI (spool/spawned-match.ts).
 */
export function childLinker(index: IndexStore): ChildLinker {
  const links = new Map<string, NonNullable<Session["parent"]>>();
  /** Links children named themselves this run (the first one each), unchecked until apply(). */
  const offers = new Map<string, NonNullable<Session["parent"]>>();
  const unlinked = new Set<string>();
  const kv = index.kvGet && index.kvSet ? { get: index.kvGet.bind(index), set: index.kvSet.bind(index) } : undefined;
  const waiting = (raw: string | undefined): string[] => {
    try {
      const ids: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const wait = async (childId: string, parentId: string): Promise<void> => {
    if (!kv) return;
    const ids = waiting(await kv.get(childWaitKey(parentId)));
    if (!ids.includes(childId)) await kv.set(childWaitKey(parentId), JSON.stringify([...ids, childId].slice(-MAX_WAITING)));
  };
  // A link with a call event was named by the parent's own events, or matched to its shell call: that parent is stored.
  const holds: ChildLinker["holds"] = async (child, link) => {
    if (link.type !== "harness" || link.eventId !== undefined) return true;
    const parent = await index.getSession(link.sessionId);
    return parent !== undefined && openAt(parent, child.startedAt);
  };
  return {
    holds,
    async observe(parentId, events) {
      for (const e of events) {
        const child = e.payload.childSessionId;
        if ((e.kind !== "subagent.start" && e.kind !== "subagent.end") || typeof child !== "string" || child === parentId) continue;
        const link: NonNullable<Session["parent"]> = { sessionId: parentId, eventId: e.id };
        const subagentId = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
        if (subagentId) link.subagentId = subagentId;
        if (typeof e.payload.type === "string") link.type = e.payload.type;
        // A start names the link; an end only when nothing has (in this run, or stored by an earlier one).
        if (e.kind !== "subagent.start" && (links.has(child) || (kv && (await kv.get(childLinkKey(child)))))) continue;
        const prev = links.get(child);
        links.set(child, link);
        if (kv && JSON.stringify(prev) !== JSON.stringify(link)) await kv.set(childLinkKey(child), JSON.stringify(link));
      }
    },
    async offer(childId, link) {
      if (childId === link.sessionId || offers.has(childId) || links.has(childId)) return;
      offers.set(childId, link);
    },
    async pending(childId) {
      const mem = links.get(childId);
      if (mem) return mem;
      const raw = kv ? await kv.get(childLinkKey(childId)) : undefined;
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as NonNullable<Session["parent"]>;
      } catch {
        return undefined;
      }
    },
    consider(childId) {
      unlinked.add(childId);
    },
    async arrived(parent) {
      const raw = kv ? await kv.get(childWaitKey(parent.id)) : undefined;
      if (!raw) return;
      const ids = waiting(raw);
      const still: string[] = [];
      for (const childId of ids) {
        const child = await index.getSession(childId);
        // Gone, or linked since: it waits no longer.
        if (!child || child.parent) continue;
        still.push(childId);
        if (openAt(parent, child.startedAt) && !offers.has(childId) && !links.has(childId)) offers.set(childId, { sessionId: parent.id, type: "harness" });
      }
      if (still.length !== ids.length) await kv!.set(childWaitKey(parent.id), still.length ? JSON.stringify(still) : undefined);
    },
    async apply() {
      const updated: string[] = [];
      for (const [childId, link] of links) {
        const child = await index.getSession(childId);
        if (!child || child.parent) continue;
        await index.upsertSession({ ...child, parent: link });
        updated.push(childId);
      }
      // After the whole run, so a parent whose lines came later in it (another agent's spool) is in the index.
      for (const [childId, link] of offers) {
        const child = links.has(childId) ? undefined : await index.getSession(childId);
        if (!child || child.parent) continue;
        if (!(await holds(child, link))) {
          await wait(childId, link.sessionId);
          continue;
        }
        await index.upsertSession({ ...child, parent: link });
        updated.push(childId);
      }
      offers.clear();
      for (const childId of unlinked) {
        const child = links.has(childId) ? undefined : await index.getSession(childId);
        if (!child || child.parent) continue;
        const link = await matchSpawnedParent(index, child);
        if (!link) continue;
        await index.upsertSession({ ...child, parent: link });
        updated.push(childId);
      }
      unlinked.clear();
      return updated;
    },
  };
}

export interface RecomputeOptions {
  linker: ChildLinker;
  repo: RepoResolver;
  /** Parse version a session new to the index is stamped with (an existing one keeps its own). */
  versionFor?: (agent: string) => number | undefined;
  /** Stamp this parse version whatever the stored one (re-parse). */
  parseVersion?: number;
  /** Called when the fold threw and the session got a row tagged fold:error instead. */
  onFoldError?: (f: FoldFailure) => void;
}

/** A session whose fold threw: its row is tagged fold:error (recomputeSession). */
export interface FoldFailure {
  sessionId: string;
  agent: string;
  message: string;
}

/** The ingest/backfill/re-parse error line for a FoldFailure. */
export const foldFailureMessage = (f: FoldFailure): string => `${f.agent} session ${f.sessionId}: folding its events failed (${f.message}); its row is tagged ${FLAGS.foldError}`;

/** What a fold (foldSession or sessionOf) threw on a session's stored events: a coding.sh bug, not a store failure. */
export class FoldError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FoldError";
    this.sessionId = sessionId;
  }
}

/** foldSession, with what it throws wrapped in a FoldError. */
function foldInto(state: SessionState, e: AgentEvent): void {
  try {
    foldSession(state, e);
  } catch (err) {
    throw new FoldError(e.sessionId, err);
  }
}

/** Longest Session.stats.foldError kept. */
const FOLD_ERROR_MAX = 500;

/**
 * Folds a session's stored events into its row and upserts it. False when it
 * has no events. When the fold throws (FoldError), the session still gets a
 * row, tagged fold:error (flagFoldError), so one bad session never hides the
 * others or stops the run that folds them.
 *
 * The linker and git are awaited between reading the events and writing the
 * row, and another process may store events for the session meanwhile
 * (storeEnrichment, a collector). So the row is written only if the session
 * got no events since they were read (checked and written as one transaction,
 * when the store has them); otherwise it is folded again, REFOLD_TRIES times
 * at most.
 */
export async function recomputeSession(index: IndexStore, id: string, o: RecomputeOptions): Promise<boolean> {
  const { linker, repo } = o;
  const prev = await index.getSession(id);
  let start: Awaited<ReturnType<RepoResolver["start"]>>;
  for (let tries = 1; ; tries++) {
    let folded: Awaited<ReturnType<typeof foldRow>>;
    try {
      folded = await foldRow(index, id, prev, o.parseVersion !== undefined);
    } catch (err) {
      if (!(err instanceof FoldError)) throw err;
      return flagFoldError(index, id, prev, err, o);
    }
    if (!folded) return false;
    const { state, session, mark } = folded;
    // parseVersion 0: a row the proxy created before any hook or transcript event (proxy/record.ts).
    const unstamped = !prev || prev.parseVersion === 0;
    const version = o.parseVersion ?? (unstamped ? o.versionFor?.(session.agent) : undefined);
    if (version !== undefined) session.parseVersion = version;
    // A link the child named itself is kept only while it holds (childLinker): an older build stored it unchecked.
    const stale = session.parent !== undefined && !(await linker.holds(session, session.parent));
    if (stale) {
      // Offered again, so it waits for the session it named like any other.
      await linker.offer(id, session.parent!);
      delete session.parent;
    }
    if (!session.parent) {
      const link = await linker.pending(id);
      if (link && (await linker.holds(session, link))) session.parent = link;
      // New to the index (or its named parent was not one) and linked by nothing: maybe started by another session's shell call (spool/spawned-match.ts).
      else if (!prev || stale) linker.consider(id);
    }
    if (!session.repo) {
      start ??= await repo.start(session, { start: state.gitStart, live: state.live });
      if (start) session.repo = start;
    }
    const written = await inTransaction(index, async () => {
      if (tries < REFOLD_TRIES && (await storedSince(index, id, mark))) return false;
      await index.upsertSession(session);
      return true;
    });
    if (!written) continue;
    await linker.arrived(session);
    await linker.observe(id, folded.read);
    return true;
  }
}

/** Folds of one session by one recomputeSession call: the last one is written whatever was stored meanwhile (the writer that stored it folds the session too). */
const REFOLD_TRIES = 3;

/**
 * True when the session got events since a fold read them. `mark` is that
 * fold's (foldStoredSession): the store's highest sequence number among the
 * session's events then, or their count for a store without sequence numbers.
 */
async function storedSince(index: IndexStore, id: string, mark: number): Promise<boolean> {
  if (canFold(index)) return (await index.listEventsSince(id, { seq: mark, ts: Number.MAX_VALUE })).events.length > 0;
  return (await index.listEvents(id, { offset: mark, limit: 1 })).length > 0;
}

/**
 * Stores events that add to sessions already in the index (gateway enrich:
 * billed cost and serving provider, as spans next to their llm calls) and
 * builds the rows of those sessions again. Returns the sessions' ids.
 *
 * With a store that has transactions it is one: nothing another process
 * stores lands between the events and the rows built from them. A fold of one
 * of the sessions that runs in another process meanwhile (ingest, backfill,
 * re-parse, refold) read its events either with these or without; without,
 * recomputeSession sees that they were stored since and folds again.
 *
 * It does not take the ingest lock. Whoever holds that lock is taken to be
 * ingesting: a background ingest that finds it held exits and leaves the spool
 * and a due re-parse to the holder, and a hook leaves the holder a wake marker.
 * A re-parse also takes it again the moment it lets go (reparse.ts underLock),
 * so a wait for it lasts as long as the re-parse.
 */
export async function storeEnrichment(index: IndexStore, events: AgentEvent[]): Promise<string[]> {
  const ids = [...new Set(events.map((e) => e.sessionId))];
  if (!ids.length) return ids;
  await inTransaction(index, async () => {
    await index.putEvents(events);
    for (const id of ids) {
      const all = await index.listEvents(id);
      if (all.length) await index.upsertSession(buildSession(all, await index.getSession(id)));
    }
  });
  return ids;
}

/**
 * The row of a session whose fold threw, tagged fold:error with the error in
 * stats.foldError: its stored row as it was, else what its events say
 * directly (agent, start, last event, cwd, event count). False: no events.
 */
async function flagFoldError(index: IndexStore, id: string, prev: Session | undefined, err: FoldError, o: RecomputeOptions): Promise<boolean> {
  const events = await index.listEvents(id);
  if (!events.length && !prev) return false;
  // A saved fold may hold part of the fold that threw.
  await index.putSessionFold?.(id, undefined);
  let row: Session;
  if (prev) row = { ...prev, stats: { ...prev.stats }, flags: prev.flags.filter((f) => f !== FLAGS.foldError) };
  else {
    const sorted = byTime(events);
    const first = sorted[0]!;
    row = { id, agent: first.agent, startedAt: first.ts, endedAt: sorted.at(-1)!.ts, stats: { events: events.length, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] };
    const cwd = sorted.find((e) => e.cwd)?.cwd;
    if (cwd) row.cwd = cwd;
    if (first.agentVersion) row.agentVersion = first.agentVersion;
    if (first.project && first.project !== "default") row.project = first.project;
    const link = await o.linker.pending(id);
    if (link && (await o.linker.holds(row, link))) row.parent = link;
  }
  const version = o.parseVersion ?? (!prev || prev.parseVersion === 0 ? o.versionFor?.(row.agent) : undefined);
  if (version !== undefined) row.parseVersion = version;
  row.stats.foldError = err.message.length > FOLD_ERROR_MAX ? `${err.message.slice(0, FOLD_ERROR_MAX - 1)}…` : err.message;
  row.flags.push(FLAGS.foldError);
  await index.upsertSession(row);
  await o.linker.observe(id, events);
  o.onFoldError?.({ sessionId: id, agent: row.agent, message: err.message });
  return true;
}

/**
 * Folds again the sessions that have stored events but no row (an import cut
 * short, or one an older build's throwing fold stopped: RT-11), and the rows
 * tagged fold:error. The first kind needs IndexStore.sessionsWithoutRow.
 * Returns the ids now folded cleanly; one that throws again stays tagged
 * (o.onFoldError says so).
 */
export async function repairSessions(index: IndexStore, o: RecomputeOptions): Promise<string[]> {
  const ids = new Set<string>();
  for (const s of (await index.sessionsWithoutRow?.()) ?? []) ids.add(s.sessionId);
  for (const s of await index.listSessions({ flag: FLAGS.foldError })) ids.add(s.id);
  const failed = new Set<string>();
  const each: RecomputeOptions = {
    ...o,
    onFoldError: (f) => {
      failed.add(f.sessionId);
      o.onFoldError?.(f);
    },
  };
  const done: string[] = [];
  for (const id of ids) if ((await recomputeSession(index, id, each)) && !failed.has(id)) done.push(id);
  return done;
}

/**
 * A session's row folded from its stored events, as recomputeSession folds it
 * (from the saved fold when the store keeps one), without the parse version,
 * parent link and repo that recomputeSession adds. Undefined: no events. When
 * the store keeps folds and the session is `simple`, `state` is the fold of
 * every event stored up to `seq`, in time order, for a writer to fold newer
 * events into (proxy/record.ts storeWriter).
 */
export async function foldSessionRow(index: IndexStore, id: string, prev: Session | undefined): Promise<{ session: Session; state: SessionState; seq?: number } | undefined> {
  const folded = await foldRow(index, id, prev, false);
  return folded && { session: folded.session, state: folded.state, ...(folded.seq !== undefined ? { seq: folded.seq } : {}) };
}

/**
 * foldStoredSession, then sessionOf. A saved fold that passed readFold but
 * throws once newer events are folded into it, or once the row is derived from
 * it (another build's fold with the same sub-states holding other data), is
 * dropped: the session is folded again from all its events.
 */
async function foldRow(index: IndexStore, id: string, prev: Session | undefined, rebuild: boolean) {
  const row = async (rebuild: boolean) => {
    const folded = await foldStoredSession(index, id, prev, rebuild);
    if (!folded) return undefined;
    let session: Session;
    try {
      session = sessionOf(folded.state, prev, folded.events);
    } catch (err) {
      throw new FoldError(id, err);
    }
    return { ...folded, session };
  };
  if (rebuild || !prev || !canFold(index)) return row(rebuild);
  try {
    return await row(false);
  } catch {
    return row(true);
  }
}

/**
 * How far a saved session fold stays behind the newest event. Events are not
 * always stored in time order: at a Stop, the Claude Code hook reads the turn's
 * transcript, whose model calls are stamped from the prompt on, after the turn's
 * tool calls were stored. So a fold ends before the last prompt the user typed,
 * and at least this long before the newest event; what comes after is folded
 * again on every recompute. An event stamped before the fold's end still means
 * a rebuild from all the session's events.
 */
export const FOLD_LAG_MS = 15 * 60_000;
/** A prompt's transcript entry and its hook event are stamped this close. */
const PROMPT_SLACK_MS = 5_000;

/** A saved fold: the state of every event stored up to seq and stamped up to upTo. */
interface SavedFold {
  /** foldStamp() of the build that saved it. */
  v: number;
  seq: number;
  upTo: number;
  state: SessionState;
}

/**
 * A saved fold this build can fold on: its stamp is this build's, and its state
 * has every sub-state a fresh one has. Another build's fold (a stamp of the
 * same SESSION_FOLD_VERSION from a differently shaped state, or a state missing
 * a sub-state) is undefined, and the session is folded from all its events.
 */
function readFold(bytes: Uint8Array | undefined): SavedFold | undefined {
  if (!bytes) return undefined;
  try {
    const f = deserialize(bytes) as SavedFold;
    return f?.v === foldStamp() && isFoldState(f.state) && Number.isFinite(f.seq) && typeof f.upTo === "number" ? f : undefined;
  } catch {
    return undefined;
  }
}

type FoldStore = IndexStore & Required<Pick<IndexStore, "listEventsSince" | "getSessionFold" | "putSessionFold">>;
const canFold = (index: IndexStore): index is FoldStore => !!(index.listEventsSince && index.getSessionFold && index.putSessionFold);

/**
 * A session's stored events folded (SessionState), for sessionOf. With a
 * store that keeps folds: from the saved fold plus the events stored or
 * stamped after it, when one applies, else from all events; the fold is then
 * saved again, up to FOLD_LAG_MS (and the last prompt) behind the newest event.
 * `events` (all of them, in time order) is set when the state needs them (see
 * sessionOf); `read` is what was read from the store; `seq`, for a simple
 * state, the store's sequence number it covers; `mark` says how far the store
 * was read (storedSince). Undefined: no events.
 */
async function foldStoredSession(index: IndexStore, id: string, prev: Session | undefined, rebuild: boolean): Promise<{ state: SessionState; events?: AgentEvent[]; read: AgentEvent[]; seq?: number; mark: number } | undefined> {
  const all = (events: AgentEvent[], mark = events.length) => {
    const state = sessionState();
    for (const e of events) foldInto(state, e);
    return { state, events, read: events, mark };
  };
  if (!canFold(index)) {
    const events = await index.listEvents(id);
    return events.length ? all(byTime(events)) : undefined;
  }
  let saved = rebuild || !prev ? undefined : readFold(await index.getSessionFold(id));
  let tail = saved ? await index.listEventsSince(id, { seq: saved.seq, ts: saved.upTo }) : undefined;
  // Stamped before the fold's end: it belongs in the middle of what was folded.
  if (saved && tail!.events.length && tail!.events[0]!.ts < saved.upTo) saved = undefined;
  if (!saved) tail = await index.listEventsSince(id, { seq: 0, ts: -Infinity });
  const { events, seq } = tail!;
  if (!saved && !events.length) {
    await index.putSessionFold(id, undefined);
    return undefined;
  }
  const state = saved?.state ?? sessionState();
  let lastPrompt = state.lastPromptTs;
  for (const e of events) if (isRealPrompt(e)) lastPrompt = e.ts;
  const lastTs = Math.max(state.lastTs ?? -Infinity, events.at(-1)?.ts ?? -Infinity);
  const from = saved?.upTo ?? -Infinity;
  const upTo = Math.max(from, Math.min(lastTs - FOLD_LAG_MS, lastPrompt === undefined ? Infinity : lastPrompt - PROMPT_SLACK_MS));
  let i = 0;
  for (; i < events.length && events[i]!.ts <= upTo; i++) foldInto(state, events[i]!);
  if (state.simple && (!saved || i > 0 || seq !== saved.seq || upTo !== from)) await index.putSessionFold(id, serialize({ v: foldStamp(), seq, upTo, state } satisfies SavedFold));
  for (; i < events.length; i++) foldInto(state, events[i]!);
  if (state.simple) return { state, read: events, seq, mark: seq };
  // Spans or enrichment: sessionOf needs every event, and no fold is kept.
  await index.putSessionFold(id, undefined);
  if (!saved) return { state, events, read: events, mark: seq };
  const whole = await index.listEventsSince(id, { seq: 0, ts: -Infinity });
  return all(whole.events, whole.seq);
}

// ---------------------------------------------------------------- backfill
//
// backfill → sinks. A sink gets each event the import stores, once, with the
// current rows of the sessions the batch touches (stripped for a metadata sink,
// as in spool ingest). Events the store already held are not sent: a live
// capture path stored them and the spool path sends those.
//
// Per sink and transcript source (a file the adapter reports, else the adapter),
// a cursor says whether the sink has what the index stored from it: the file's
// mtime, as the import's own cursor (SINK_CURRENT for an adapter with no files).
// A sink whose cursor says so gets only what this run inserts. Any other value
// means it is behind: the file is read again for it, even when the index has it
// all, and the sink gets every event read (ids are deterministic, so one it had
// is the same span or row again). A sink falls behind when a send fails, when
// events are stored while it backs off, and for the length of a run: its cursor
// is SINK_BEHIND from before the first event is stored until the sink has
// acknowledged the source's last one, so a run that dies in between is made up
// for by the next. A failed sink never stops the import.
//
// A sink that sends its session record only with session.end (otlp) has the
// record refreshed (writeOpenSessions) for sessions that got events without one:
// a transcript read after the session's end changes its totals.
//
// Sends wait until the sessions are folded: at the end of the run, and whenever
// SINK_QUEUE_EVENTS are waiting. With sinks, one import runs at a time (a lock,
// paths.sinkLock): what a sink is owed is what this process inserted, which
// holds only while no other process inserts from the same files.

export interface BackfillOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  /** Adapters whose backfill() to run. */
  adapters: Adapter[];
  /** Sinks that get the events this import stores. */
  sinks?: Sink[];
  env?: NodeJS.ProcessEnv;
  since?: number;
  /** Read no further source files (after the first) once Date.now() passes this (ms epoch); they count in `pendingFiles`. */
  deadline?: number;
  /** Called as the import goes: source files read so far and events stored, for the agent being read. */
  onProgress?: (p: BackfillProgress) => void;
  now?: () => number;
  /**
   * Only with sinks: the cross-process lock one import holds while it stores and sends
   * (default: paths(env).sinkLock; wait 30 s, or not at all with a `deadline`). false = no lock.
   */
  lock?: false | (LockOptions & { path?: string });
}

export interface BackfillProgress {
  agent: string;
  /** Changed source files read so far, over every agent. */
  files: number;
  /** Events stored so far, over every agent. */
  events: number;
}

export interface BackfillResult {
  /** Events newly inserted. */
  events: number;
  /** Backfilled prompts/replies dropped because a live capture already had them. */
  duplicates: number;
  sessions: number;
  excluded: number;
  errors: IngestError[];
  agents: { agent: string; events: number; error?: string }[];
  /** Changed source files left unread because `deadline` passed (0 otherwise). */
  pendingFiles: number;
  /** Per sink, what this import sent it. Absent without sinks. */
  sinks?: SinkReport[];
  /** Another import was storing and sending to the sinks: this one read nothing. */
  busy?: true;
}

/** Cursor keys for one backfill source file: size, mtime (floored ms) and the `since` it was read with. */
export const backfillCursorKey = (agent: string, path: string, field: "size" | "mtime" | "since"): string => `backfill:${agent}:${path}#${field}`;

/**
 * A sink's cursor for one transcript source: a file a backfill reports, else
 * the adapter. It holds the file's mtime (floored ms) once the sink has every
 * event the index stored from the file as it was then, SINK_CURRENT for an
 * adapter with no files, and SINK_BEHIND while it is owed some.
 */
export const sinkBackfillKey = (sink: string, agent: string, path?: string): string => sinkCursorKey(sink, path === undefined ? `backfill:${agent}` : `backfill:${agent}:${path}`);
/** Never a file's mtime, nor 0 (a source the sink has not seen). */
export const SINK_BEHIND = 1;
export const SINK_CURRENT = 2;
/** Events waiting for the sinks before an import folds its sessions and sends them, mid-run. */
const SINK_QUEUE_EVENTS = DEFAULT_CHECKPOINT_EVENTS;

/** One transcript source being read, for the sinks. */
interface SinkSource {
  /** Cursor name after the sink's: `backfill:<agent>[:<path>]`. */
  name: string;
  key: (sink: Sink) => string;
  /** What a sink's cursor holds once it has everything stored from this source. */
  current: number;
  /** Sinks sent to from this source → true: every event read (the sink is behind); false: only what this run inserts. */
  takes: Map<Sink, boolean>;
  /** Events waiting to be sent, per sink. */
  queue: Map<Sink, AgentEvent[]>;
  /** Sinks owed events of this source that they were not sent: marked SINK_BEHIND. */
  owed: Set<Sink>;
  /** Fully read. */
  done: boolean;
}

/**
 * Imports historical sessions from each adapter's local transcripts, with the
 * same redaction, metadata and exclusion rules as spool ingest. Prompts and
 * replies a live path (hook, plugin, OTel) already captured for the session
 * are skipped, since they share no natural id with the transcript copy. The
 * events it stores go to the sinks (see "backfill → sinks" above).
 */
export async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  const env = opts.env ?? process.env;
  if (!opts.sinks?.length || opts.lock === false) return backfillLocked(opts, env, () => {});
  const lo = opts.lock ?? {};
  const lockPath = lo.path ?? paths(env).sinkLock;
  mkdirSync(dirname(lockPath), { recursive: true });
  // A budgeted read does not wait: the import holding the lock is reading the same transcripts.
  const waits = lo.waitMs !== undefined || opts.deadline === undefined;
  let lock: Lock;
  try {
    lock = await acquireLock(lockPath, waits ? lo : { ...lo, waitMs: 0 });
  } catch (e) {
    if (!(e instanceof LockBusyError)) throw e;
    const holder = e.holder ? `pid ${e.holder.pid}` : "another process";
    const errors = waits ? [{ message: `transcripts not read: another import (${holder}) is sending to the sinks; run this again when it is done` }] : [];
    return { events: 0, duplicates: 0, sessions: 0, excluded: 0, errors, agents: [], pendingFiles: 0, busy: true };
  }
  try {
    return await backfillLocked(opts, env, () => lock.assertHeld());
  } finally {
    lock.release();
  }
}

/** `fence` throws when this run no longer owns the sink lock; called before every sink send and sink cursor write. */
async function backfillLocked(opts: BackfillOptions, env: NodeJS.ProcessEnv, fence: () => void): Promise<BackfillResult> {
  const { config, index, blobs } = opts;
  const now = opts.now ?? Date.now;
  const result: BackfillResult = { events: 0, duplicates: 0, sessions: 0, excluded: 0, errors: [], agents: [], pendingFiles: 0 };
  await markFreshStore(index);
  const error = (e: IngestError) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(e);
  };
  const profileFor = profileCache(config, env, (e) => result.errors.push(e));
  const base = profileFor(undefined);
  const metadata = base.config.capture.mode === "metadata";
  // Blobs are redacted with the user-level profile: backfill can't know an event's cwd before normalizing it.
  // Puts write behind and are flushed before the rows that reference them.
  const blobBatch = blobs.batch?.();
  const blobStore = blobBatch ?? blobs;
  const ctx = normalizeContext(base, blobStore, metadata);
  const copies = copyFilter(index);
  const durations = toolDurationFiller(index);
  // Sessions to recompute: those that received new events, plus every session
  // of a file read for the first time (so sessions imported before file cursors
  // existed get recomputed once) or of an adapter that reports no files.
  const touched = new Set<string>();
  const since = opts.since ?? 0;
  // File cursors to commit once the events they cover are stored and their sessions recomputed.
  const fileCursors: { agent: string; file: BackfillFile }[] = [];
  /** Changed files read so far (the deadline only defers files after the first). */
  let accepted = 0;

  const linker = childLinker(index);
  const repo = repoResolver();
  const byId = new Map(opts.adapters.map((a) => [a.id, a]));
  const versionFor = (agent: string) => parseVersionFor(byId, agent);
  const updated = new Set<string>();
  const onFoldError = (f: FoldFailure) => error({ message: foldFailureMessage(f) });
  const recompute = async () => {
    for (const id of touched) if (await recomputeSession(index, id, { linker, repo, versionFor, onFoldError })) updated.add(id);
    touched.clear();
  };

  // ---- sinks (see "backfill → sinks" above). Nothing below runs without one.
  const sinkStates = await sinkStatesFor(index, opts.sinks ?? [], now);
  /** Sources read in this run that a sink still has events or a cursor to get for, in read order. */
  let sources: SinkSource[] = [];
  /** The source the events now being yielded come from. */
  let src: SinkSource | undefined;
  let queued = 0;
  const markBehind = async (s: SinkSource, sink: Sink) => {
    fence();
    await index.setCursor(s.key(sink), SINK_BEHIND);
  };
  /** `sink` did not get events of `s` it should have: behind on it until a later run reads the source again. */
  const owe = async (s: SinkSource, sink: Sink) => {
    s.takes.delete(sink);
    s.queue.delete(sink);
    if (s.owed.has(sink)) return;
    s.owed.add(sink);
    await markBehind(s, sink);
  };
  /**
   * A source about to be read. `had`: what the cursor of a sink that has all the index
   * stored from it holds; `at`: each sink's cursor now; `reading`: the index may get new
   * events from it. Undefined when no sink has anything to get from it.
   */
  const openSource = async (agent: string, path: string | undefined, o: { current: number; had: number; at: Map<Sink, number>; reading: boolean }): Promise<SinkSource | undefined> => {
    const s: SinkSource = { name: path === undefined ? `backfill:${agent}` : `backfill:${agent}:${path}`, key: (sink) => sinkBackfillKey(sink.name, agent, path), current: o.current, takes: new Map(), queue: new Map(), owed: new Set(), done: false };
    for (const [sink, at] of o.at) {
      if (at !== o.had) s.takes.set(sink, true);
      else if (o.reading) {
        // Behind from before anything new is stored until it has it: a run that dies in between owes it.
        await markBehind(s, sink);
        s.takes.set(sink, false);
      }
    }
    if (!s.takes.size && !o.reading) return undefined;
    sources.push(s);
    return s;
  };
  /** Each listening sink's cursor for a source. */
  const sinkCursors = async (agent: string, path?: string): Promise<Map<Sink, number>> => {
    const at = new Map<Sink, number>();
    for (const [sink, state] of sinkStates) if (!state.failed) at.set(sink, await index.getCursor(sinkBackfillKey(sink.name, agent, path)));
    return at;
  };
  /** A flushed batch of `from` (`stored` of its events were new): queued for the sinks that take it. */
  const enqueue = async (from: SinkSource, batch: AgentEvent[], fresh: AgentEvent[] | undefined, stored: number) => {
    for (const [sink, state] of sinkStates) {
      const all = from.takes.get(sink);
      if (all === undefined || state.failed) {
        // Not sent to (it backs off, or a send failed in this run): owed what it would have got.
        if (all ? batch.length : stored) await owe(from, sink);
        continue;
      }
      const list = all ? batch : fresh!;
      if (!list.length) continue;
      const q = from.queue.get(sink);
      if (q) q.push(...list);
      else from.queue.set(sink, [...list]);
      queued += list.length;
    }
  };
  /** Folds the sessions that got events, sends what is queued, and moves the cursor of each sink that now has a whole source. */
  const deliver = async () => {
    if (!sources.length) return;
    await recompute();
    for (const [sink, state] of sinkStates) {
      const size = sinkBatchSize(config, sink);
      const meta = sink.mode === "metadata";
      const sent: SinkSource[] = [];
      /** Sessions sent events here with no session.end among them → their latest event. */
      const open = new Map<string, number>();
      const ended = new Set<string>();
      for (const s of sources) {
        const events = s.queue.get(sink);
        if (!events) continue;
        s.queue.delete(sink);
        const send = { now, fence, error: (message: string) => error({ sink: sink.name, source: s.name, message }) };
        for (let i = 0; i < events.length && !state.failed; i += size) {
          const batch = events.slice(i, i + size);
          const sessions = await sessionsFor(index, batch);
          if (!(await sinkSend(index, sink, state, () => sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, blobStore), send))) break;
          state.sent += batch.length;
          for (const e of batch) {
            open.set(e.sessionId, Math.max(open.get(e.sessionId) ?? -Infinity, e.ts));
            if (e.kind === "session.end") ended.add(e.sessionId);
          }
        }
        if (state.failed) await owe(s, sink);
        else sent.push(s);
      }
      for (const id of ended) open.delete(id);
      if (!state.failed && sink.writeOpenSessions && open.size) {
        const rows: OpenSession[] = [];
        for (const [id, lastEventAt] of open) {
          const session = await index.getSession(id);
          if (session) rows.push({ session: meta ? sessionToMetadata(session) : session, lastEventAt });
        }
        const send = { now, fence, error: (message: string) => error({ sink: sink.name, message }) };
        for (let i = 0; i < rows.length; i += size) if (!(await sinkSend(index, sink, state, () => sink.writeOpenSessions!(rows.slice(i, i + size), blobStore), send))) break;
        // Their events went out, the records that total them did not: sent again with the events.
        if (state.failed) for (const s of sent) await owe(s, sink);
      }
      // A source read to its end whose events the sink has (or that had none for it).
      for (const s of sources) {
        if (!s.done || !s.takes.has(sink)) continue;
        s.takes.delete(sink);
        fence();
        await index.setCursor(s.key(sink), s.current);
      }
    }
    sources = sources.filter((s) => !s.done);
    queued = 0;
  };

  for (const adapter of opts.adapters) {
    if (!adapter.backfill) continue;
    const report = { agent: adapter.id, events: 0 } as BackfillResult["agents"][number];
    result.agents.push(report);
    let pending: AgentEvent[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = await durations(pending);
      durations.settle(); // stored next: a later start can no longer fill these in place
      pending = [];
      await blobBatch?.flush();
      // Per session, so a session is recomputed only when it actually gained rows.
      const bySession = new Map<string, AgentEvent[]>();
      for (const e of batch) {
        const list = bySession.get(e.sessionId);
        if (list) list.push(e);
        else bySession.set(e.sessionId, [e]);
      }
      // With a sink that gets only what is new, which events the store lacked matters: putEvents
      // counts them, so each is put by itself (in one transaction when the store has them).
      const from = src;
      const fresh: AgentEvent[] | undefined = from && [...from.takes.values()].includes(false) ? [] : undefined;
      let stored = 0;
      for (const [id, events] of bySession) {
        let inserted: number;
        if (fresh) {
          const before = fresh.length;
          await inTransaction(index, async () => {
            for (const e of events) if ((await index.putEvents([e])).inserted) fresh.push(e);
          });
          inserted = fresh.length - before;
        } else ({ inserted } = await index.putEvents(events));
        if (inserted) touched.add(id);
        stored += inserted;
        result.events += inserted;
        report.events += inserted;
      }
      if (from) {
        await enqueue(from, batch, fresh, stored);
        if (queued >= SINK_QUEUE_EVENTS) await deliver();
      }
      opts.onProgress?.({ agent: adapter.id, files: accepted, events: result.events });
    };
    /** The source being read has yielded its last event. */
    const endSource = async () => {
      if (!src) return;
      await flush();
      src.done = true;
      src = undefined;
    };
    // Whether events now being yielded come from a file this adapter reported as
    // read for the first time; undefined = the adapter reports no files.
    let firstRead: boolean | undefined;
    const files: BackfillFile[] = [];
    const changed = async (f: BackfillFile): Promise<boolean> => {
      await endSource();
      const key = (field: "size" | "mtime" | "since") => backfillCursorKey(adapter.id, f.path, field);
      const [size, mtime, readSince] = await Promise.all([index.getCursor(key("size")), index.getCursor(key("mtime")), index.getCursor(key("since"))]);
      const seen = mtime > 0;
      const current = Math.floor(f.mtimeMs);
      // Unchanged, and last read with a window at least as wide as this one.
      const unchanged = seen && size === f.size && mtime === current && readSince <= since;
      // A sink that lacks what the index stored from the file has it read again.
      const at = sinkStates.size ? await sinkCursors(adapter.id, f.path) : undefined;
      const behind = at !== undefined && [...at.values()].some((c) => c !== mtime);
      if (unchanged && !behind) return false;
      // Out of time (after reading one, so every run makes progress): left for the next backfill, which finds it still changed.
      if (accepted > 0 && opts.deadline !== undefined && Date.now() >= opts.deadline) {
        if (!unchanged) result.pendingFiles++;
        return false;
      }
      accepted++;
      if (at) src = await openSource(adapter.id, f.path, { current, had: mtime, at, reading: !unchanged });
      firstRead = unchanged ? false : !seen;
      // Read only for a sink: the index's own cursors stay as they are.
      if (!unchanged) files.push(f);
      opts.onProgress?.({ agent: adapter.id, files: accepted, events: result.events });
      return true;
    };
    const adapterOpts = opts.since !== undefined ? { since: opts.since, changed } : { changed };
    try {
      for await (const e of adapter.backfill(ctx, adapterOpts)) {
        const ev = backfillEvent(e, profileFor, metadata, env);
        if (typeof ev === "string") {
          if (ev === "excluded") result.excluded++;
          else error({ message: `${adapter.id}: ${ev}` });
          continue;
        }
        if (await copies.isCopy(ev)) {
          result.duplicates++;
          continue;
        }
        // Read from no file (an adapter that reports none): the adapter is the source.
        if (!src && sinkStates.size) src = await openSource(adapter.id, undefined, { current: SINK_CURRENT, had: SINK_CURRENT, at: await sinkCursors(adapter.id), reading: true });
        pending.push(ev);
        if (firstRead !== false) touched.add(ev.sessionId);
        if (pending.length >= PUT_BATCH) await flush();
      }
      await flush();
      await endSource();
      for (const file of files) fileCursors.push({ agent: adapter.id, file });
    } catch (err) {
      await flush().catch(() => {});
      // Cut short: its sinks stay behind on it.
      src = undefined;
      report.error = (err as Error).message;
      result.errors.push({ message: `${adapter.id}.backfill failed: ${report.error}` });
    }
  }
  // Blobs whose events were all dropped: renamed into place (unreferenced, gc removes them) rather than left as temp files.
  await blobBatch?.flush();
  await recompute();
  for (const id of await linker.apply()) updated.add(id);
  for (const { agent, file } of fileCursors) {
    await index.setCursor(backfillCursorKey(agent, file.path, "size"), file.size);
    await index.setCursor(backfillCursorKey(agent, file.path, "since"), since);
    // mtime last: it marks the file as read.
    await index.setCursor(backfillCursorKey(agent, file.path, "mtime"), Math.floor(file.mtimeMs));
  }
  // After the rows are linked and the index's cursors are in: a sink's cursor never runs ahead of them.
  await deliver();
  result.sessions = updated.size;
  if (sinkStates.size) result.sinks = sinkReports(sinkStates);
  if (result.events > BULK_WRITE_EVENTS) await Promise.all([index.checkpoint?.(), blobs.checkpoint?.()]);
  return result;
}

/**
 * A backfilled event in stored form (source "transcript" unless the adapter
 * set one, redacted, metadata-stripped, priced), the form a live copy was
 * stored in; "excluded" for a capture.exclude cwd, or why it is invalid.
 */
export function backfillEvent(e: AgentEvent, profileFor: (cwd: string | undefined) => CaptureProfile, metadata: boolean, env: NodeJS.ProcessEnv): AgentEvent | string {
  const problem = validEvent(e);
  if (problem) return problem;
  const profile = profileFor(e.cwd);
  if (e.cwd && isExcluded(e.cwd, profile.config.capture.exclude, env)) return "excluded";
  return finishEvent(e.source === undefined ? { ...e, source: "transcript" } : e, profile, metadata);
}

async function sessionsFor(index: IndexStore, batch: AgentEvent[]): Promise<Session[]> {
  const out: Session[] = [];
  for (const id of new Set(batch.map((e) => e.sessionId))) {
    const s = await index.getSession(id);
    if (s) out.push(s);
  }
  return out;
}

/** Redacts text blobs (utf-8); binary data is stored as-is. */
function redactBlob(data: string | Uint8Array, redactor: Redactor, tally?: RedactionTally): string | Uint8Array {
  if (typeof data === "string") return redactor.string(data, tally);
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    return data;
  }
  const clean = redactor.string(text, tally);
  return clean === text ? data : clean;
}
