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
import type { AgentEvent, Session } from "../schema/index.ts";
import { isEventKind } from "../schema/index.ts";
import type { Adapter, BackfillFile, BlobStore, Config, IndexStore, NormalizeContext, Sink, SpoolLine } from "./types.ts";
import { resolveRepoConfig, isExcluded } from "./config.ts";
import { acquireLock, LockBusyError, wakeMarker, type Lock, type LockOptions } from "./lock.ts";
import { existsSync, rmSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { join } from "node:path";
import { hashParts, sha256Hex } from "./ids.ts";
import { paths } from "./paths.ts";
import { createRedactor, noteBlobHits, redactEventCounted, redactionTally, sessionToMetadata, toMetadata, type RedactionTally, type Redactor } from "./redact.ts";
import { byTime, foldSession, isBackfillEvent, isRealPrompt, isVerifyToolStart, SESSION_FOLD_VERSION, sessionOf, sessionState, type SessionState } from "./sessions.ts";
import { copyFilter } from "./message-copies.ts";
import { priceEvent, pricesFor } from "./pricing.ts";
import { listSpoolFiles, readSpoolFile, type SpoolFile } from "./spool-read.ts";
import { repoResolver, type RepoResolver } from "./repo-state.ts";
import { snapshot } from "./snapshot.ts";
import { isWrapperLine } from "../adapters/more/wrapper.ts";

export const PUT_BATCH = 500;
const DEFAULT_CHECKPOINT_EVENTS = 5000;
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

/** Cursor holding the SESSION_FOLD_VERSION every stored session was last folded with (core/reparse.ts refolds the rest). */
export const REFOLD_CURSOR = "reparse:fold";

/** A store with no sessions yet has nothing to refold: marks it current before its first session lands. */
async function markFreshStore(index: IndexStore): Promise<void> {
  if ((await index.getCursor(REFOLD_CURSOR)) === SESSION_FOLD_VERSION) return;
  if (!(await index.listSessions({ limit: 1 })).length) await index.setCursor(REFOLD_CURSOR, SESSION_FOLD_VERSION);
}

/** kv key holding a pending parent link for a child session. */
export const childLinkKey = (childId: string): string => `child-link:${childId}`;

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
      const r = await ingestLocked(opts, env, spoolDir, () => lock.assertHeld());
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
  const sinkStates = new Map<Sink, SinkReport & { failed: boolean }>();
  for (const sink of opts.sinks ?? []) {
    const retryAt = await index.getCursor(sinkRetryKey(sink.name));
    const state = { name: sink.name, sent: 0, ok: true, failed: false } as SinkReport & { failed: boolean };
    if (retryAt > now()) {
      state.retryAt = retryAt;
      state.failed = true;
    }
    sinkStates.set(sink, state);
  }
  const sinkBatchSize = (sink: Sink) => config.sinks.find((s) => (s.name ?? s.kind) === sink.name)?.batchSize ?? DEFAULT_SINK_BATCH;
  const touchedAll = new Set<string>();

  const normalize = spoolNormalizer({ adapters, blobs: blobStore, env, profileFor, error, excluded: () => result.excluded++ });

  const durations = toolDurationFiller(index);

  const linker = childLinker(index);
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
  const recompute = async (ids: Iterable<string>) => {
    for (const id of ids) {
      if (await recomputeSession(index, id, { linker, repo, versionFor })) touchedAll.add(id);
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
      if (s.endSnapshot !== before) await index.upsertSession(s);
    }
  };
  const atomically = <T>(fn: () => Promise<T>): Promise<T> => (index.transaction ? index.transaction(fn) : fn());

  const sendToSink = async (sink: Sink, file: SpoolFile, window: LineEvents[], readPos: number) => {
    const state = sinkStates.get(sink)!;
    if (state.failed) return;
    const key = sinkCursorKey(sink.name, file.source);
    const from = await index.getCursor(key);
    const lines = window.filter((l) => l.offset >= from);
    const size = sinkBatchSize(sink);
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
        fence();
        let ack;
        try {
          ack = await sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, blobStore);
        } catch (err) {
          ack = { ok: false, error: (err as Error).message };
        }
        if (!ack.ok) {
          state.ok = false;
          state.failed = true;
          state.error = ack.error ?? "sink rejected the batch";
          state.retryAt = now() + (ack.retryAfterMs ?? PERMANENT_FAILURE_BACKOFF_MS);
          fence();
          await index.setCursor(sinkRetryKey(sink.name), state.retryAt);
          error({ sink: sink.name, source: file.source, message: state.error });
          return;
        }
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

  // Applied after every file so a child ingested before its parent is still linked.
  for (const id of await linker.apply()) touchedAll.add(id);

  result.sessions = touchedAll.size;
  for (const s of sinkStates.values()) {
    const { failed: _failed, ...report } = s;
    result.sinks.push(report);
  }
  if (droppedErrors) result.errors.push({ message: `…and ${droppedErrors} more errors` });
  return result;
}

// ---------------------------------------------------------------- shared steps

export interface SpoolNormalizerOptions {
  adapters: Map<string, Adapter>;
  blobs: BlobStore;
  env: NodeJS.ProcessEnv;
  profileFor: (cwd: string | undefined) => CaptureProfile;
  error: (e: IngestError) => void;
  /** A line skipped because its cwd matched capture.exclude. */
  excluded: () => void;
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
      out.push(finishEvent(ev, profile, metadata));
    }
    return out;
  };
}

export function normalizeContext(profile: CaptureProfile, blobs: BlobStore, metadata: boolean, source?: { file: string; offset: number }): NormalizeContext {
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
  /** A pending link for a session that has none, if any. */
  pending(childId: string): Promise<NonNullable<Session["parent"]> | undefined>;
  /** Applies links observed this run to children already in the index. Returns updated ids. */
  apply(): Promise<string[]>;
}

/**
 * Parent links named only by a parent's subagent.start|end { childSessionId }.
 * Kept in memory for this run and, when the store has kv, durably, so a child
 * ingested in a later run than its parent is still linked.
 */
export function childLinker(index: IndexStore): ChildLinker {
  const links = new Map<string, NonNullable<Session["parent"]>>();
  const kv = index.kvGet && index.kvSet ? { get: index.kvGet.bind(index), set: index.kvSet.bind(index) } : undefined;
  return {
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
    async apply() {
      const updated: string[] = [];
      for (const [childId, link] of links) {
        const child = await index.getSession(childId);
        if (!child || child.parent) continue;
        await index.upsertSession({ ...child, parent: link });
        updated.push(childId);
      }
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
}

/** Folds a session's stored events into its row and upserts it. False when it has no events. */
export async function recomputeSession(index: IndexStore, id: string, o: RecomputeOptions): Promise<boolean> {
  const { linker, repo } = o;
  const prev = await index.getSession(id);
  const folded = await foldStoredSession(index, id, prev, o.parseVersion !== undefined);
  if (!folded) return false;
  const { state } = folded;
  const session = sessionOf(state, prev, folded.events);
  // parseVersion 0: a row the proxy created before any hook or transcript event (proxy/record.ts).
  const unstamped = !prev || prev.parseVersion === 0;
  const version = o.parseVersion ?? (unstamped ? o.versionFor?.(session.agent) : undefined);
  if (version !== undefined) session.parseVersion = version;
  if (!session.parent) {
    const link = await linker.pending(id);
    if (link) session.parent = link;
  }
  if (!session.repo) {
    const start = await repo.start(session, { start: state.gitStart, live: state.live });
    if (start) session.repo = start;
  }
  await index.upsertSession(session);
  await linker.observe(id, folded.read);
  return true;
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
  v: number;
  seq: number;
  upTo: number;
  state: SessionState;
}

function readFold(bytes: Uint8Array | undefined): SavedFold | undefined {
  if (!bytes) return undefined;
  try {
    const f = deserialize(bytes) as SavedFold;
    return f?.v === SESSION_FOLD_VERSION && f.state?.v === SESSION_FOLD_VERSION ? f : undefined;
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
 * sessionOf); `read` is what was read from the store. Undefined: no events.
 */
async function foldStoredSession(index: IndexStore, id: string, prev: Session | undefined, rebuild: boolean): Promise<{ state: SessionState; events?: AgentEvent[]; read: AgentEvent[] } | undefined> {
  const all = (events: AgentEvent[]) => {
    const state = sessionState();
    for (const e of events) foldSession(state, e);
    return { state, events, read: events };
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
  for (; i < events.length && events[i]!.ts <= upTo; i++) foldSession(state, events[i]!);
  if (state.simple && (!saved || i > 0 || seq !== saved.seq || upTo !== from)) await index.putSessionFold(id, serialize({ v: SESSION_FOLD_VERSION, seq, upTo, state } satisfies SavedFold));
  for (; i < events.length; i++) foldSession(state, events[i]!);
  if (state.simple) return { state, read: events };
  // Spans or enrichment: sessionOf needs every event, and no fold is kept.
  await index.putSessionFold(id, undefined);
  if (!saved) return { state, events, read: events };
  return all((await index.listEventsSince(id, { seq: 0, ts: -Infinity })).events);
}

// ---------------------------------------------------------------- backfill

export interface BackfillOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  /** Adapters whose backfill() to run. */
  adapters: Adapter[];
  env?: NodeJS.ProcessEnv;
  since?: number;
  /** Read no further source files (after the first) once Date.now() passes this (ms epoch); they count in `pendingFiles`. */
  deadline?: number;
  /** Called as the import goes: source files read so far and events stored, for the agent being read. */
  onProgress?: (p: BackfillProgress) => void;
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
}

/** Cursor keys for one backfill source file: size, mtime (floored ms) and the `since` it was read with. */
export const backfillCursorKey = (agent: string, path: string, field: "size" | "mtime" | "since"): string => `backfill:${agent}:${path}#${field}`;

/**
 * Imports historical sessions from each adapter's local transcripts, with the
 * same redaction, metadata and exclusion rules as spool ingest. Prompts and
 * replies a live path (hook, plugin, OTel) already captured for the session
 * are skipped, since they share no natural id with the transcript copy.
 */
export async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  const { config, index, blobs } = opts;
  const env = opts.env ?? process.env;
  const result: BackfillResult = { events: 0, duplicates: 0, sessions: 0, excluded: 0, errors: [], agents: [], pendingFiles: 0 };
  await markFreshStore(index);
  const profileFor = profileCache(config, env, (e) => result.errors.push(e));
  const base = profileFor(undefined);
  const metadata = base.config.capture.mode === "metadata";
  // Blobs are redacted with the user-level profile: backfill can't know an event's cwd before normalizing it.
  // Puts write behind and are flushed before the rows that reference them.
  const blobBatch = blobs.batch?.();
  const ctx = normalizeContext(base, blobBatch ?? blobs, metadata);
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
      for (const [id, events] of bySession) {
        const { inserted } = await index.putEvents(events);
        if (inserted) touched.add(id);
        result.events += inserted;
        report.events += inserted;
      }
      opts.onProgress?.({ agent: adapter.id, files: accepted, events: result.events });
    };
    // Whether events now being yielded come from a file this adapter reported as
    // read for the first time; undefined = the adapter reports no files.
    let firstRead: boolean | undefined;
    const files: BackfillFile[] = [];
    const changed = async (f: BackfillFile): Promise<boolean> => {
      const key = (field: "size" | "mtime" | "since") => backfillCursorKey(adapter.id, f.path, field);
      const [size, mtime, readSince] = await Promise.all([index.getCursor(key("size")), index.getCursor(key("mtime")), index.getCursor(key("since"))]);
      const seen = mtime > 0;
      // Unchanged, and last read with a window at least as wide as this one.
      if (seen && size === f.size && mtime === Math.floor(f.mtimeMs) && readSince <= since) return false;
      // Out of time (after reading one, so every run makes progress): left for the next backfill, which finds it still changed.
      if (accepted > 0 && opts.deadline !== undefined && Date.now() >= opts.deadline) {
        result.pendingFiles++;
        return false;
      }
      accepted++;
      firstRead = !seen;
      files.push(f);
      opts.onProgress?.({ agent: adapter.id, files: accepted, events: result.events });
      return true;
    };
    const adapterOpts = opts.since !== undefined ? { since: opts.since, changed } : { changed };
    try {
      for await (const e of adapter.backfill(ctx, adapterOpts)) {
        const ev = backfillEvent(e, profileFor, metadata, env);
        if (typeof ev === "string") {
          if (ev === "excluded") result.excluded++;
          else if (result.errors.length < MAX_ERRORS) result.errors.push({ message: `${adapter.id}: ${ev}` });
          continue;
        }
        if (await copies.isCopy(ev)) {
          result.duplicates++;
          continue;
        }
        pending.push(ev);
        if (firstRead !== false) touched.add(ev.sessionId);
        if (pending.length >= PUT_BATCH) await flush();
      }
      await flush();
      for (const file of files) fileCursors.push({ agent: adapter.id, file });
    } catch (err) {
      await flush().catch(() => {});
      report.error = (err as Error).message;
      result.errors.push({ message: `${adapter.id}.backfill failed: ${report.error}` });
    }
  }
  // Blobs whose events were all dropped: renamed into place (unreferenced, gc removes them) rather than left as temp files.
  await blobBatch?.flush();
  const linker = childLinker(index);
  const repo = repoResolver();
  const byId = new Map(opts.adapters.map((a) => [a.id, a]));
  const versionFor = (agent: string) => parseVersionFor(byId, agent);
  const updated = new Set<string>();
  for (const id of touched) if (await recomputeSession(index, id, { linker, repo, versionFor })) updated.add(id);
  for (const id of await linker.apply()) updated.add(id);
  for (const { agent, file } of fileCursors) {
    await index.setCursor(backfillCursorKey(agent, file.path, "size"), file.size);
    await index.setCursor(backfillCursorKey(agent, file.path, "since"), since);
    // mtime last: it marks the file as read.
    await index.setCursor(backfillCursorKey(agent, file.path, "mtime"), Math.floor(file.mtimeMs));
  }
  result.sessions = updated.size;
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
