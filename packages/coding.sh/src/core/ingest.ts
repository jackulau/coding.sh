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
// to the sinks twice.
//
// Enrichment applied to every event, whatever the adapter:
// - `source` defaults to the capture path ("hook", "wrapper", "transcript").
// - tool.end without durationMs gets end.ts − start.ts from the tool.start
//   with the same toolUseId (this run, or already in the index).
// - A child session named only by a parent's subagent.* childSessionId is
//   linked even when the child arrives in a later run (the link is kept in
//   the index kv when the store has one).
// - Backfilled (transcript) copies of prompts/replies that a live capture
//   path already recorded for the same session are dropped: live wins.
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
import { acquireLock, type Lock, type LockOptions } from "./lock.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashParts, sha256Hex } from "./ids.ts";
import { paths } from "./paths.ts";
import { createRedactor, sessionToMetadata, toMetadata, type Redactor } from "./redact.ts";
import { buildSession, isBackfillEvent, isVerifyToolStart } from "./sessions.ts";
import { listSpoolFiles, readSpoolFile, type SpoolFile } from "./spool-read.ts";
import { repoResolver, type RepoResolver } from "./repo-state.ts";
import { snapshot } from "./snapshot.ts";

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
}

interface LineEvents {
  offset: number;
  nextOffset: number;
  events: AgentEvent[];
}

interface CaptureProfile {
  config: Config;
  redactor: Redactor;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function validEvent(e: AgentEvent): string | undefined {
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

/** kv key holding a pending parent link for a child session. */
export const childLinkKey = (childId: string): string => `child-link:${childId}`;

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const env = opts.env ?? process.env;
  const spoolDir = opts.spoolDir ?? paths(env).spool;
  let lock: Lock | undefined;
  // No spool dir = nothing to read; don't create one just to lock it.
  if (opts.lock !== false && existsSync(spoolDir)) {
    const lo = opts.lock ?? {};
    lock = await acquireLock(lo.path ?? join(spoolDir, ".ingest.lock"), lo);
  }
  try {
    return await ingestLocked(opts, env, spoolDir);
  } finally {
    lock?.release();
  }
}

async function ingestLocked(opts: IngestOptions, env: NodeJS.ProcessEnv, spoolDir: string): Promise<IngestResult> {
  const { config, index, blobs, adapters } = opts;
  const now = opts.now ?? Date.now;
  const checkpointEvents = opts.checkpointEvents ?? DEFAULT_CHECKPOINT_EVENTS;
  const result: IngestResult = { lines: 0, events: 0, sessions: 0, excluded: 0, errors: [], sinks: [] };
  let droppedErrors = 0;
  const error = (e: IngestError) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(e);
    else droppedErrors++;
  };

  // Per-cwd capture settings (repo overrides), cached for the run.
  const profiles = new Map<string, CaptureProfile>();
  const profileFor = (cwd: string | undefined): CaptureProfile => {
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
      p = {
        config: cfg,
        redactor: createRedactor({ redact: cfg.capture.redact, patterns: cfg.capture.redactPatterns, env }),
      };
      profiles.set(key, p);
    }
    return p;
  };
  // Fail fast on a bad user config (e.g. invalid redact pattern) before touching anything.
  profileFor(undefined);

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

  const normalize = async (line: SpoolLine, source: string, offset: number): Promise<AgentEvent[]> => {
    const profile = profileFor(line.cwd);
    const capture = profile.config.capture;
    if (line.cwd && isExcluded(line.cwd, capture.exclude, env)) {
      result.excluded++;
      return [];
    }
    const adapter = adapters.get(line.agent);
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
    const capturePath = line.agent === "wrapper" ? "wrapper" : "hook";
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

  const durations = toolDurationFiller(index);

  const linker = childLinker(index);
  const repo = repoResolver();
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
      if (await recomputeSession(index, id, linker, repo, endSnapshot)) touchedAll.add(id);
    }
  };

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
        let ack;
        try {
          ack = await sink.write(meta ? batch.map(toMetadata) : batch, meta ? sessions.map(sessionToMetadata) : sessions, blobs);
        } catch (err) {
          ack = { ok: false, error: (err as Error).message };
        }
        if (!ack.ok) {
          state.ok = false;
          state.failed = true;
          state.error = ack.error ?? "sink rejected the batch";
          state.retryAt = now() + (ack.retryAfterMs ?? PERMANENT_FAILURE_BACKOFF_MS);
          await index.setCursor(sinkRetryKey(sink.name), state.retryAt);
          error({ sink: sink.name, source: file.source, message: state.error });
          return;
        }
        state.sent += batch.length;
      }
      await index.setCursor(key, lines[end - 1]!.nextOffset);
      i = end;
    }
    // Covers trailing lines with no events (blank, invalid, excluded).
    if (readPos > from) await index.setCursor(key, readPos);
  };

  for (const file of await listSpoolFiles(spoolDir)) {
    let local = await index.getCursor(file.source);
    if (local > file.size) {
      error({ source: file.source, message: `cursor ${local} is past the end of the file (${file.size} bytes); re-reading from the start` });
      local = 0;
    }
    const active = [...sinkStates].filter(([, s]) => !s.failed).map(([sink]) => sink);
    const sinkFrom = await Promise.all(active.map((s) => index.getCursor(sinkCursorKey(s.name, file.source))));
    const start = Math.min(local, ...sinkFrom);
    if (start >= file.size) continue;

    let window: LineEvents[] = [];
    let windowEvents = 0;
    let pending: AgentEvent[] = [];
    const touched = new Set<string>();
    let readPos = start;
    const keepWindow = active.length > 0;

    const flush = async () => {
      if (!pending.length) return;
      for (let i = 0; i < pending.length; i += PUT_BATCH) {
        const { inserted } = await index.putEvents(pending.slice(i, i + PUT_BATCH));
        result.events += inserted;
      }
      pending = [];
    };
    const checkpoint = async () => {
      await flush();
      await recompute(touched);
      touched.clear();
      if (readPos > local) {
        local = readPos;
        await index.setCursor(file.source, local);
      }
      for (const sink of active) await sendToSink(sink, file, window, readPos);
      window = [];
      windowEvents = 0;
    };

    const reader = readSpoolFile(spoolDir, file.path, start, {
      onError: (e) => {
        if (e.offset >= local) error({ source: e.source, offset: e.offset, message: e.message });
        readPos = Math.max(readPos, e.nextOffset);
      },
    });
    for await (const rec of reader) {
      const events = await durations(await normalize(rec.line, rec.source, rec.offset));
      readPos = rec.nextOffset;
      if (rec.offset >= local) {
        result.lines++;
        pending.push(...events);
        for (const e of events) {
          touched.add(e.sessionId);
          if ((e.kind === "turn.end" || e.kind === "session.end") && !isBackfill(e) && !e.repo?.snapshot) {
            freshEnds.set(e.sessionId, Math.max(e.ts, freshEnds.get(e.sessionId) ?? -Infinity));
          }
        }
        if (pending.length >= PUT_BATCH) await flush();
      }
      if (keepWindow) window.push({ offset: rec.offset, nextOffset: rec.nextOffset, events });
      // Bounds memory (sink window) and how much work a crash can force us to redo.
      windowEvents += events.length;
      if (windowEvents >= checkpointEvents) await checkpoint();
    }
    await checkpoint();
  }

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

function normalizeContext(profile: CaptureProfile, blobs: BlobStore, metadata: boolean, source?: { file: string; offset: number }): NormalizeContext {
  const ctx: NormalizeContext = {
    maxInlineBytes: profile.config.capture.maxInlineBytes,
    id: (...parts) => hashParts(...parts),
    blob: async (data) => {
      const clean = redactBlob(data, profile.redactor);
      // Metadata mode keeps no content locally either: hand back the ref, store nothing.
      if (metadata) return sha256Hex(clean);
      return blobs.put(clean);
    },
  };
  if (source) ctx.source = source;
  return ctx;
}

/** Redaction, then metadata stripping (keeping the "a check ran" signal the no-verification detector needs). */
function finishEvent(e: AgentEvent, profile: CaptureProfile, metadata: boolean): AgentEvent {
  let ev = profile.redactor.event(e);
  if (metadata) {
    const verify = isVerifyToolStart(ev);
    ev = toMetadata(ev);
    if (verify) ev.payload.verify = true;
  }
  return ev;
}

/**
 * Fills tool.end durationMs from the tool.start with the same toolUseId when the
 * adapter could not. Starts seen in this run are remembered; earlier ones are
 * looked up in the index once per session.
 */
function toolDurationFiller(index: IndexStore): (events: AgentEvent[]) => Promise<AgentEvent[]> {
  const starts = new Map<string, Map<string, number>>();
  const loaded = new Set<string>();
  const remember = (e: AgentEvent) => {
    const id = e.payload.toolUseId;
    if (e.kind !== "tool.start" || typeof id !== "string") return;
    let m = starts.get(e.sessionId);
    if (!m) starts.set(e.sessionId, (m = new Map()));
    if (!m.has(id)) m.set(id, e.ts);
  };
  return async (events) => {
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
        if (start === undefined || e.ts < start) continue;
        ms = e.ts - start;
      }
      events[i] = { ...e, durationMs: ms, payload: own === undefined ? { ...e.payload, durationMs: ms } : e.payload };
    }
    return events;
  };
}

interface ChildLinker {
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
function childLinker(index: IndexStore): ChildLinker {
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
        if (links.has(child) && e.kind !== "subagent.start") continue;
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

async function recomputeSession(
  index: IndexStore,
  id: string,
  linker: ChildLinker,
  repo: RepoResolver,
  enrich?: (session: Session) => Promise<void>,
): Promise<boolean> {
  const events = await index.listEvents(id);
  if (!events.length) return false;
  const prev = await index.getSession(id);
  const session = buildSession(events, prev);
  if (!session.parent) {
    const link = await linker.pending(id);
    if (link) session.parent = link;
  }
  if (!session.repo) {
    const state = await repo.start(session, events);
    if (state) session.repo = state;
  }
  await enrich?.(session);
  await index.upsertSession(session);
  await linker.observe(id, events);
  return true;
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
}

const MESSAGE_KINDS = ["user.message", "assistant.message"];

/** Cursor keys for one backfill source file: size, mtime (floored ms) and the `since` it was read with. */
export const backfillCursorKey = (agent: string, path: string, field: "size" | "mtime" | "since"): string => `backfill:${agent}:${path}#${field}`;

/** Natural key for a prompt/reply: kind + whitespace-folded text. */
function messageKey(e: AgentEvent): string | undefined {
  if (!MESSAGE_KINDS.includes(e.kind) || typeof e.payload.text !== "string") return undefined;
  const t = e.payload.text.replace(/\s+/g, " ").trim().slice(0, 4000);
  return t ? `${e.kind}\u0000${t}` : undefined;
}

/**
 * Imports historical sessions from each adapter's local transcripts, with the
 * same redaction, metadata and exclusion rules as spool ingest. Prompts and
 * replies a live path (hook, plugin, OTel) already captured for the session
 * are skipped, since they share no natural id with the transcript copy.
 */
export async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  const { config, index, blobs } = opts;
  const env = opts.env ?? process.env;
  const result: BackfillResult = { events: 0, duplicates: 0, sessions: 0, excluded: 0, errors: [], agents: [] };
  const profiles = new Map<string, CaptureProfile>();
  const profileFor = (cwd: string | undefined): CaptureProfile => {
    const key = cwd ?? "";
    let p = profiles.get(key);
    if (!p) {
      let cfg = config;
      if (cwd) {
        try {
          cfg = resolveRepoConfig(config, cwd, env);
        } catch (err) {
          result.errors.push({ message: `ignoring repo config for ${cwd}: ${(err as Error).message}` });
        }
      }
      p = { config: cfg, redactor: createRedactor({ redact: cfg.capture.redact, patterns: cfg.capture.redactPatterns, env }) };
      profiles.set(key, p);
    }
    return p;
  };
  const base = profileFor(undefined);
  const metadata = base.config.capture.mode === "metadata";
  // Blobs are redacted with the user-level profile: backfill can't know an event's cwd before normalizing it.
  const ctx = normalizeContext(base, blobs, metadata);
  const live = new Map<string, Set<string>>();
  const liveKeys = async (sessionId: string) => {
    let set = live.get(sessionId);
    if (!set) {
      set = new Set();
      for (const e of await index.listEvents(sessionId, { kinds: MESSAGE_KINDS })) {
        if (isBackfill(e)) continue;
        const k = messageKey(e);
        if (k) set.add(k);
      }
      live.set(sessionId, set);
    }
    return set;
  };
  const durations = toolDurationFiller(index);
  // Sessions to recompute: those that received new events, plus every session
  // of a file read for the first time (so sessions imported before file cursors
  // existed get recomputed once) or of an adapter that reports no files.
  const touched = new Set<string>();
  const since = opts.since ?? 0;
  // File cursors to commit once the events they cover are stored and their sessions recomputed.
  const fileCursors: { agent: string; file: BackfillFile }[] = [];
  for (const adapter of opts.adapters) {
    if (!adapter.backfill) continue;
    const report = { agent: adapter.id, events: 0 } as BackfillResult["agents"][number];
    result.agents.push(report);
    let pending: AgentEvent[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = await durations(pending);
      pending = [];
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
      firstRead = !seen;
      files.push(f);
      return true;
    };
    const adapterOpts = opts.since !== undefined ? { since: opts.since, changed } : { changed };
    try {
      for await (const e of adapter.backfill(ctx, adapterOpts)) {
        const problem = validEvent(e);
        if (problem) {
          if (result.errors.length < MAX_ERRORS) result.errors.push({ message: `${adapter.id}: ${problem}` });
          continue;
        }
        const profile = profileFor(e.cwd);
        if (e.cwd && isExcluded(e.cwd, profile.config.capture.exclude, env)) {
          result.excluded++;
          continue;
        }
        const ev = e.source === undefined ? { ...e, source: "transcript" } : e;
        const key = isBackfill(ev) ? messageKey(ev) : undefined;
        if (key && (await liveKeys(ev.sessionId)).has(key)) {
          result.duplicates++;
          continue;
        }
        pending.push(finishEvent(ev, profile, metadata));
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
  const linker = childLinker(index);
  const repo = repoResolver();
  const updated = new Set<string>();
  for (const id of touched) if (await recomputeSession(index, id, linker, repo)) updated.add(id);
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

async function sessionsFor(index: IndexStore, batch: AgentEvent[]): Promise<Session[]> {
  const out: Session[] = [];
  for (const id of new Set(batch.map((e) => e.sessionId))) {
    const s = await index.getSession(id);
    if (s) out.push(s);
  }
  return out;
}

/** Redacts text blobs (utf-8); binary data is stored as-is. */
function redactBlob(data: string | Uint8Array, redactor: Redactor): string | Uint8Array {
  if (typeof data === "string") return redactor.string(data);
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    return data;
  }
  const clean = redactor.string(text);
  return clean === text ? data : clean;
}
