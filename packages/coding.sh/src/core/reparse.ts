// Re-parse: sessions stored by an older adapter parse get their rows rebuilt
// from the source they came from, so an upgrade fixes data already captured.
//
// Each adapter has a parse version (Adapter.parseVersion, default 1), bumped
// when a change alters the rows it stores for the same input. Ingest stamps a
// new session with it, and a session keeps the version it was created with as
// later events arrive (Session.parseVersion). A session whose version is older
// than its adapter's is stale.
//
// A session's rows come from up to three places, each rebuilt only when its
// source still exists, and never added where the session had none:
// - backfill rows (source transcript/backfill/store): re-read from the agent's
//   transcript, rollout or database (adapter.backfill over every file);
// - hook rows (source hook/wrapper, or one the spool's normalize gives):
//   re-normalized from the spool lines still on disk (gc keeps them
//   retention.keepSpoolDays, 7 by default), when those lines span the stored
//   hook rows' whole time range;
// - anything else (OTel, SDK batches, gateway companions): kept as is.
// The two capture paths are then deduped as ingest does (message-copies.ts:
// live wins), and also by tool call id, which matches a transcript row to a
// hook row the old parse gave another id. Where nothing could be re-read, the
// stored rows are only deduped that way ("hook-row dedupe") and the session is
// kept at its old version; why is stored under kv `reparse:kept:<id>`.
//
// Readers never wait and never see a half-rebuilt session: transcripts and
// spool are read with no lock held, and each session is swapped in one
// transaction (IndexStore.replaceSessionEvents) under the ingest lock, held
// for at most LOCK_HOLD_MS at a time. Between holds, when a hook or a read
// left the ingest wake marker, the spool is ingested (onWake), so captures
// keep landing during a long re-parse and a read never waits for it. Blob
// puts go through a write-behind batch, flushed before any row is written.
// One re-parse runs at a time (`<data>/reparse.lock`); it is incremental: a
// session is stamped with the new version as it is rebuilt, so a re-parse
// cut short resumes with the sessions still stale. Memory is bounded: only
// stale sessions' events are buffered, flushed between transcript files once
// FLUSH_EVENTS pile up; a session whose transcript spans files flushed apart
// is rebuilt by the first flush and topped up by the later ones.
//
// Automatic runs (`ingest --background`, which reads and the viewer start when
// due) do the stale sessions once per set of adapter versions: a stamp of the
// versions is kept under the cursor REPARSE_CURSOR. `ingest --rebuild` does
// every session (optionally of some agents) now.
//
// Refold: when the fold stamp changes (core/sessions.ts foldStamp: the
// SESSION_FOLD_VERSION of how stats and flags are derived from stored events,
// and the shape of the fold state), an automatic run then folds every other
// session again from its stored rows, with no source re-read, under the same
// short lock holds. Its progress is kept (REFOLD_AFTER), so a cut-short pass
// resumes; the stamp it finished is kept under REFOLD_CURSOR, so a store last
// folded by another build is folded again once.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent } from "../schema/index.ts";
import type { Adapter, BackfillFile, BlobStore, Config, IndexStore } from "./types.ts";
import { sha256Hex } from "./ids.ts";
import { acquireLock, wakeMarker, type Lock, type LockOptions } from "./lock.ts";
import { paths } from "./paths.ts";
import { foldStamp, isBackfillEvent } from "./sessions.ts";
import { COPY_SLACK_MS, copyFilter, messageKey } from "./message-copies.ts";
import { listSpoolFiles, readSpoolFile } from "./spool-read.ts";
import { repoResolver } from "./repo-state.ts";
import { isWrapperLine } from "../adapters/more/wrapper.ts";
export { REFOLD_CURSOR } from "./ingest.ts";
import {
  backfillEvent,
  childLinker,
  normalizeContext,
  parseVersionFor,
  profileCache,
  recomputeSession,
  REFOLD_CURSOR,
  spoolNormalizer,
  toolDurationFiller,
  type IngestError,
} from "./ingest.ts";

/** Cursor holding the stamp of the adapter versions the last automatic re-parse covered. */
export const REPARSE_CURSOR = "reparse:stamp";
/** kv: why a session was kept at its old parse version. */
export const reparseKeptKey = (sessionId: string): string => `reparse:kept:${sessionId}`;
/** kv: JSON summary of the last re-parse (when, counts, first errors). */
export const REPARSE_LAST = "reparse:last";
/** kv: `{ v, id }` of an unfinished refold: sessions up to id (in id order) are done. */
const REFOLD_AFTER = "reparse:fold-after";
/** Refolded sessions between progress saves. */
const REFOLD_SAVE_EVERY = 100;

/** Buffered transcript events that trigger a flush at the next file boundary. */
const FLUSH_EVENTS = 20_000;
/** Longest ingest-lock hold while sessions are written (at least one session per hold). */
const LOCK_HOLD_MS = 1_000;
/** Slack when checking that spool lines span the stored hook rows. */
const SPAN_SLACK_MS = 60_000;
const MAX_ERRORS = 100;
/** Capture-path sources ingest gives hook and wrapper lines. Rows with no source predate the field (hooks only). */
const SPOOL_SOURCES = new Set(["hook", "wrapper"]);

/** Positive int that changes whenever any adapter's parse version does. */
export function parseStamp(adapters: ReadonlyMap<string, Adapter>): number {
  const pairs = [...adapters.values()].map((a) => `${a.id}:${a.parseVersion ?? 1}`).sort();
  return parseInt(sha256Hex(pairs.join("\n")).slice(0, 12), 16) || 1;
}

export interface ReparseProgress {
  phase: "spool" | "transcripts" | "sessions" | "refold";
  /** Agent whose transcripts are being read (phase "transcripts"). */
  agent?: string;
  /** Sessions done so far, of `total` (phase "refold": sessions refolded, of those to refold). */
  done: number;
  total: number;
}

export interface ReparseOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  adapters: Map<string, Adapter>;
  env?: NodeJS.ProcessEnv;
  /** Spool directory (default paths(env).spool). */
  spoolDir?: string;
  /** Every session (`ingest --rebuild`), not only those stored by an older parse. */
  all?: boolean;
  /** Only sessions of these agents (the session's agent or the agent a host ran). */
  agents?: string[];
  onProgress?: (p: ReparseProgress) => void;
  /** One re-parse at a time (default paths(env).reparseLock, no wait: busy throws LockBusyError). false = none. */
  runLock?: false | (LockOptions & { path?: string });
  /** Held while sessions are written (default `<spoolDir>/.ingest.lock` when the spool dir exists, wait 30 s). false = none. */
  ingestLock?: false | (LockOptions & { path?: string });
  /** Run between ingest-lock holds while the lock's wake marker is set (a hook or a read has spool lines waiting): an ingest. */
  onWake?: () => Promise<void>;
  now?: () => number;
}

export interface KeptSession {
  id: string;
  agent: string;
  reason: string;
}

export interface ReparseResult {
  /** Sessions looked at. */
  sessions: number;
  /** Rebuilt from their transcript or spool (all of it that still exists). */
  reparsed: number;
  /** Kept at their old version: nothing to re-read them from. Stored rows still deduped. */
  kept: number;
  keptSessions: KeptSession[];
  /** Rows deleted and inserted. */
  removed: number;
  inserted: number;
  /** Sessions folded again from their stored rows because the fold stamp changed. */
  refolded: number;
  errors: IngestError[];
}

const versionOf = (adapters: ReadonlyMap<string, Adapter>, agent: string) => parseVersionFor(adapters, agent);

/** Sessions stored by an older parse than their adapter's (unset = not adapter-made, never stale). */
async function staleSessions(index: IndexStore, adapters: ReadonlyMap<string, Adapter>) {
  return (await index.listSessions({})).filter((s) => {
    const v = versionOf(adapters, s.agent);
    // 0: created by the proxy and not parsed by an adapter yet (ingest stamps it).
    return v !== undefined && s.parseVersion !== undefined && s.parseVersion !== 0 && s.parseVersion < v;
  });
}

/**
 * True when stale sessions wait for an automatic re-parse, or stored sessions
 * for a refold. Two cursor reads while the adapter versions match the last
 * run's stamp and the fold version its refold; otherwise a scan of the
 * session rows, and the stamp is set right away when none is stale.
 */
export async function reparseDue(index: IndexStore, adapters: ReadonlyMap<string, Adapter>): Promise<boolean> {
  if (!index.replaceSessionEvents) return false;
  if ((await index.getCursor(REFOLD_CURSOR)) !== foldStamp()) {
    if ((await index.listSessions({ limit: 1 })).length) return true;
    await index.setCursor(REFOLD_CURSOR, foldStamp());
  }
  const stamp = parseStamp(adapters);
  if ((await index.getCursor(REPARSE_CURSOR)) === stamp) return false;
  if ((await staleSessions(index, adapters)).length) return true;
  await index.setCursor(REPARSE_CURSOR, stamp);
  return false;
}

/** Natural key of one tool call's row, shared by its hook and transcript copies whatever ids the parse gave them. */
function callKey(e: AgentEvent): string | undefined {
  const id = e.payload.toolUseId;
  if (typeof id !== "string" || !id) return undefined;
  if (e.kind === "tool.start" || e.kind === "tool.end" || e.kind === "test.result") return `${e.kind}\u0000${id}`;
  if (e.kind === "file.change" && typeof e.payload.path === "string") return `${e.kind}\u0000${id}\u0000${e.payload.path}`;
  return undefined;
}

/** JSON with sorted keys and no undefined fields: equal for a row and its stored copy. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** A read-only index over one session's rows, for the copy filter and duration filler. */
function viewOf(rows: AgentEvent[]): IndexStore {
  const sorted = rows.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
  const listEvents = async (sessionId: string, o: { kinds?: string[] } = {}) => sorted.filter((e) => e.sessionId === sessionId && (!o.kinds?.length || o.kinds.includes(e.kind)));
  return { listEvents } as unknown as IndexStore;
}

/**
 * Drops live rows that repeat an earlier live row (same tool call; same prompt
 * or reply within COPY_SLACK_MS), then backfill rows a live row already has
 * (ingest's copy filter, tool call ids). Live wins, as at ingest.
 */
async function dedupe(live: AgentEvent[], backfill: AgentEvent[]): Promise<AgentEvent[]> {
  const keptLive: AgentEvent[] = [];
  const calls = new Set<string>();
  const messages = new Map<string, number[]>();
  const ids = new Set<string>();
  for (const e of [...live].sort((a, b) => a.ts - b.ts)) {
    if (ids.has(e.id)) continue;
    const call = callKey(e);
    if (call !== undefined && calls.has(call)) continue;
    const msg = messageKey(e);
    if (msg !== undefined && messages.get(msg)?.some((t) => Math.abs(t - e.ts) <= COPY_SLACK_MS)) continue;
    ids.add(e.id);
    if (call !== undefined) calls.add(call);
    if (msg !== undefined) messages.set(msg, [...(messages.get(msg) ?? []), e.ts]);
    keptLive.push(e);
  }
  const copies = copyFilter(viewOf(keptLive));
  const out = keptLive;
  for (const e of backfill) {
    if (ids.has(e.id)) continue;
    const call = callKey(e);
    if (call !== undefined && calls.has(call)) continue;
    if (await copies.isCopy(e)) continue;
    ids.add(e.id);
    out.push(e);
  }
  return out;
}

/** Re-parses stale sessions (or every session with `all`) from their transcripts and spool. */
export async function reparse(opts: ReparseOptions): Promise<ReparseResult> {
  const { config, index, blobs, adapters } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const spoolDir = opts.spoolDir ?? paths(env).spool;
  const result: ReparseResult = { sessions: 0, reparsed: 0, kept: 0, keptSessions: [], removed: 0, inserted: 0, refolded: 0, errors: [] };
  const error = (e: IngestError) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(e);
  };
  if (!index.replaceSessionEvents) {
    error({ message: `the ${index.kind} index store can't replace a session's events; sessions were not re-parsed` });
    return result;
  }

  let runLock: Lock | undefined;
  if (opts.runLock !== false) {
    const lo = opts.runLock ?? {};
    const path = lo.path ?? paths(env).reparseLock;
    mkdirSync(dirname(path), { recursive: true });
    runLock = await acquireLock(path, { waitMs: 0, ...lo });
  }
  try {
    await run();
  } finally {
    runLock?.release();
  }
  return result;

  async function run(): Promise<void> {
    const stamp = parseStamp(adapters);
    const wanted = opts.agents?.length ? new Set(opts.agents) : undefined;
    // The parsers are the ones the last finished run used: what is still stale is what it kept (no source left), so only refold.
    const sameParsers = !opts.all && !wanted && (await index.getCursor(REPARSE_CURSOR)) === stamp;
    const targets = (opts.all ? await index.listSessions({}) : sameParsers ? [] : await staleSessions(index, adapters)).filter(
      (s) => versionOf(adapters, s.agent) !== undefined && (!wanted || wanted.has(s.agent) || (s.provider !== undefined && wanted.has(s.provider))),
    );
    result.sessions = targets.length;
    const done = new Set<string>();
    const failed = new Set<string>();
    const progress = (p: Omit<ReparseProgress, "done" | "total">) => opts.onProgress?.({ ...p, done: done.size + failed.size, total: targets.length });

    // Which sources to read: the adapters that made each target's backfill and hook rows.
    const agents = new Map(targets.map((s) => [s.id, s.agent]));
    const transcriptAdapters = new Set<string>();
    const spoolAdapters = new Set<string>();
    const fromTranscript = new Set<string>();
    for (const s of targets) {
      for (const e of await index.listEvents(s.id)) {
        const a = adapters.get(e.agent) ?? adapters.get("wrapper");
        if (!a) continue;
        if (isBackfillEvent(e)) {
          if (a.backfill) transcriptAdapters.add(a.id);
          fromTranscript.add(s.id);
        } else spoolAdapters.add(a.id);
      }
    }

    // Blob puts write behind (most are hits: the content is already stored); flushed before any row is written.
    const blobBatch = blobs.batch?.();
    const blobStore = blobBatch ?? blobs;

    // Hook rows: every spool line still on disk, re-normalized.
    const profileFor = profileCache(config, env, error);
    const spoolEvents = new Map<string, AgentEvent[]>();
    const spoolSources = new Set(SPOOL_SOURCES);
    if (spoolAdapters.size && existsSync(spoolDir)) {
      progress({ phase: "spool" });
      const normalize = spoolNormalizer({ adapters, blobs: blobStore, env, profileFor, error, excluded: () => {} });
      for (const file of await listSpoolFiles(spoolDir)) {
        for await (const rec of readSpoolFile(spoolDir, file.path, 0, { onError: () => {} })) {
          const a = adapters.get(rec.line.agent) ?? (isWrapperLine(rec.line) ? adapters.get("wrapper") : undefined);
          if (!a || !spoolAdapters.has(a.id)) continue;
          for (const e of await normalize(rec.line, rec.source, rec.offset)) {
            if (!agents.has(e.sessionId)) continue;
            if (e.source !== undefined) spoolSources.add(e.source);
            const list = spoolEvents.get(e.sessionId);
            if (list) list.push(e);
            else spoolEvents.set(e.sessionId, [e]);
          }
        }
      }
    }

    const linker = childLinker(index);
    const repo = repoResolver();

    /** Rebuilds one session: transcript events read for it (undefined = none found) and its re-normalized spool events. */
    const rebuild = async (id: string, transcript: AgentEvent[] | undefined): Promise<void> => {
      const agent = agents.get(id)!;
      const version = versionOf(adapters, agent)!;
      const stored = await index.listEvents(id);
      if (done.has(id)) {
        // More of a transcript flushed apart: top the rebuilt session up.
        const add = await dedupe(stored.filter((e) => !isBackfillEvent(e)), [...stored.filter(isBackfillEvent), ...(transcript ?? [])]);
        const have = new Set(stored.map((e) => e.id));
        const fresh = add.filter((e) => !have.has(e.id));
        if (fresh.length) {
          const r = await index.replaceSessionEvents!(id, [], await toolDurationFiller(viewOf([...stored, ...fresh]))(fresh));
          result.inserted += r.inserted;
          await recomputeSession(index, id, { linker, repo });
        }
        return;
      }
      done.add(id);
      const bfRows = stored.filter(isBackfillEvent);
      const spoolRows = stored.filter((e) => !isBackfillEvent(e) && (e.source === undefined || spoolSources.has(e.source)));
      const otherRows = stored.filter((e) => !isBackfillEvent(e) && !(e.source === undefined || spoolSources.has(e.source)));
      const spool = spoolEvents.get(id) ?? [];
      const span = (rows: AgentEvent[]) => [Math.min(...rows.map((e) => e.ts)), Math.max(...rows.map((e) => e.ts))] as const;
      const replaceBf = bfRows.length > 0 && transcript !== undefined && transcript.length > 0;
      let replaceSpool = false;
      if (spoolRows.length && spool.length) {
        const [from, to] = span(spoolRows);
        const [sFrom, sTo] = span(spool);
        replaceSpool = sFrom <= from + SPAN_SLACK_MS && sTo >= to - SPAN_SLACK_MS;
      }
      const live = [...otherRows, ...(replaceSpool ? spool : spoolRows)];
      const final = await dedupe(live, replaceBf ? transcript : bfRows);
      const old = new Set(stored);
      const keep = new Set(final.filter((e) => old.has(e)).map((e) => e.id));
      // A re-derived row identical to the stored one stays (a second run writes nothing).
      const byId = new Map(stored.map((e) => [e.id, e]));
      const write: AgentEvent[] = [];
      for (const e of await toolDurationFiller(viewOf(final))(final.filter((e) => !old.has(e)))) {
        const was = byId.get(e.id);
        if (was && canonical(was) === canonical(e)) keep.add(e.id);
        else write.push(e);
      }
      const remove = [...byId.keys()].filter((x) => !keep.has(x));
      const reparsed = replaceBf || replaceSpool;
      if (remove.length || write.length) {
        const r = await index.replaceSessionEvents!(id, remove, write);
        result.removed += r.removed;
        result.inserted += r.inserted;
      }
      await recomputeSession(index, id, reparsed ? { linker, repo, parseVersion: version } : { linker, repo });
      if (reparsed) {
        result.reparsed++;
        await index.kvSet?.(reparseKeptKey(id), undefined);
        return;
      }
      const why: string[] = [];
      if (bfRows.length) why.push("its transcript is gone");
      if (spoolRows.length) why.push(spool.length ? "the spool lines left don't cover its hook rows" : "its spool lines were removed by gc (retention.keepSpoolDays)");
      if (!why.length) why.push("its rows were not made by an adapter (OTel or SDK)");
      const deduped = stored.length - final.length;
      const reason = `${why.join("; ")}${deduped > 0 ? `; ${deduped} duplicate row${deduped === 1 ? "" : "s"} removed` : ""}`;
      result.kept++;
      result.keptSessions.push({ id, agent, reason });
      await index.kvSet?.(reparseKeptKey(id), JSON.stringify({ version: version, reason, at: now() }));
    };

    // Writes run under the ingest lock, held LOCK_HOLD_MS at most; spool lines waiting are ingested between holds.
    const lockOpts = opts.ingestLock !== false && existsSync(spoolDir) ? opts.ingestLock ?? {} : undefined;
    const lockPath = lockOpts && (lockOpts.path ?? join(spoolDir, ".ingest.lock"));
    const underLock = async <T>(items: T[], each: (item: T) => Promise<void>) => {
      let i = 0;
      while (i < items.length) {
        const lock = lockPath ? await acquireLock(lockPath, lockOpts) : undefined;
        const until = now() + LOCK_HOLD_MS;
        try {
          do {
            lock?.assertHeld();
            await each(items[i++]!);
          } while (i < items.length && now() < until);
        } finally {
          lock?.release();
        }
        if (lockPath && opts.onWake && existsSync(wakeMarker(lockPath))) {
          await opts.onWake().catch((err: Error) => error({ message: `ingest between re-parse batches failed: ${err.message}` }));
        }
      }
    };
    const writeBatch = async (items: [string, AgentEvent[] | undefined][]) => {
      await blobBatch?.flush();
      await underLock(items, async ([id, transcript]) => {
        try {
          await rebuild(id, transcript);
        } catch (err) {
          failed.add(id);
          error({ message: `re-parse of session ${id} failed: ${(err as Error).message}` });
        }
        progress({ phase: "sessions" });
      });
    };

    // Backfill rows: each adapter's transcripts, every file, keeping only the targets' events.
    const ctxBase = profileFor(undefined);
    const metadata = ctxBase.config.capture.mode === "metadata";
    const ctx = normalizeContext(ctxBase, blobStore, metadata);
    for (const id of transcriptAdapters) {
      const adapter = adapters.get(id)!;
      progress({ phase: "transcripts", agent: id });
      const pending = new Map<string, AgentEvent[]>();
      let buffered = 0;
      // Events of the file being read: complete once the next file starts or the backfill ends.
      let current: AgentEvent[] = [];
      const settle = () => {
        for (const e of current) {
          const list = pending.get(e.sessionId);
          if (list) list.push(e);
          else pending.set(e.sessionId, [e]);
        }
        buffered += current.length;
        current = [];
      };
      const flush = async () => {
        const items = [...pending].filter(([sid]) => !failed.has(sid));
        pending.clear();
        buffered = 0;
        await writeBatch(items);
      };
      const changed = async (_f: BackfillFile) => {
        settle();
        if (buffered >= FLUSH_EVENTS) await flush();
        return true;
      };
      try {
        for await (const raw of adapter.backfill!(ctx, { changed })) {
          if (!fromTranscript.has(raw.sessionId)) continue;
          const ev = backfillEvent(raw, profileFor, metadata, env);
          if (typeof ev === "string") {
            if (ev !== "excluded") error({ message: `${id}: ${ev}` });
            continue;
          }
          current.push(ev);
        }
        settle();
      } catch (err) {
        // The file being read is incomplete: its sessions keep their rows.
        for (const e of current) failed.add(e.sessionId);
        current = [];
        error({ message: `${id}.backfill failed: ${(err as Error).message}` });
      }
      await flush();
    }

    async function refold(): Promise<void> {
      let after = "";
      try {
        const saved = JSON.parse((await index.kvGet?.(REFOLD_AFTER)) ?? "null") as { v?: number; id?: string } | null;
        if (saved?.v === foldStamp() && typeof saved.id === "string") after = saved.id;
      } catch {
        // unreadable progress: start over
      }
      const ids = (await index.listSessions({}))
        .map((s) => s.id)
        .filter((id) => id > after && !done.has(id) && !failed.has(id))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      let n = 0;
      opts.onProgress?.({ phase: "refold", done: 0, total: ids.length });
      await underLock(ids, async (id) => {
        try {
          if (await recomputeSession(index, id, { linker, repo })) result.refolded++;
        } catch (err) {
          error({ message: `refold of session ${id} failed: ${(err as Error).message}` });
        }
        n++;
        if (n % REFOLD_SAVE_EVERY === 0) await index.kvSet?.(REFOLD_AFTER, JSON.stringify({ v: foldStamp(), id }));
        opts.onProgress?.({ phase: "refold", done: n, total: ids.length });
      });
    }

    // Everything not rebuilt from a transcript: spool only, or nothing left to read.
    await writeBatch(targets.filter((s) => !done.has(s.id) && !failed.has(s.id)).map((s) => [s.id, undefined]));

    // Refold: every session not rebuilt above (OTel and SDK sessions too), from its stored rows, once per fold stamp.
    if (!wanted && (await index.getCursor(REFOLD_CURSOR)) !== foldStamp()) {
      await refold();
      await index.setCursor(REFOLD_CURSOR, foldStamp());
      await index.kvSet?.(REFOLD_AFTER, undefined);
    }
    await linker.apply();

    if (!wanted) await index.setCursor(REPARSE_CURSOR, stamp);
    await index.kvSet?.(REPARSE_LAST, JSON.stringify({ at: now(), all: !!opts.all, sessions: result.sessions, reparsed: result.reparsed, kept: result.kept, refolded: result.refolded, errors: result.errors.slice(0, 5) }));
  }
}
