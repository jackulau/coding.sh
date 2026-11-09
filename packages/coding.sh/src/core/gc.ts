// Garbage collection: mark-and-sweep of unreferenced blobs, plus removal of
// spool files every consumer (local index and each sink) has fully read.
//
// Retention: blobs held only by tool.end events older than
// retention.toolOutputDays (full tool output, file reads) count as
// unreferenced; the event and its truncated inline output stay. Diffs, eval
// tasks, bundles and run artifacts are never expired. The judge verdict cache
// is size-capped (oldest-used entries first).
//
// A proxied model call's request document points at its message pages and
// message blobs (proxy/blocks.ts) rather than its event: those are marked by
// reading the documents of the calls marked `requestPaged`.
//
// Safety: blobs younger than `minBlobAgeMs` are never swept, so an ingest that
// has stored a blob but not yet committed the event referencing it is safe.
// Dedupe hits refresh a blob's mtime (FsBlobStore), extending the same guard.
// That guard alone has a gap: an ingest that dedupes onto an OLD unreferenced
// blob between the sweep's stat and its delete would commit an event pointing
// at a deleted blob. So a real (non-dry) run holds the ingest lock
// (core/lock.ts) across the blob mark+sweep and the spool phase; a spool file
// is then never deleted mid-read either, nor while hooks still append to it
// (the current UTC day). Deleting a spool file also resets its cursors, so a
// file recreated at the same path is read from the start.
import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BlobRef } from "../schema/index.ts";
import type { BlobStore, Config, IndexStore } from "./types.ts";
import { paths } from "./paths.ts";
import { bundleBlobs, runBlobs, taskBlobs } from "../store/common.ts";
import { requestBlobRefs } from "../proxy/blocks.ts";
import { gcJudgeCache, type JudgeCacheGcResult } from "../judge/cache.ts";
import { sinkCursorKey } from "./ingest.ts";
import { acquireLock, type Lock, type LockOptions } from "./lock.ts";
import { listSpoolFiles, rawFilesOf, spoolFileDay, type SpoolFile } from "./spool-read.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** An unreferenced raw side file younger than this may belong to a hook between its two writes. */
const MIN_ORPHAN_RAW_AGE_MS = 3_600_000;

export interface GcOptions {
  index: IndexStore;
  blobs: BlobStore;
  config: Config;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  spoolDir?: string;
  now?: number;
  /** Unreferenced blobs younger than this are kept (default 1 day). */
  minBlobAgeMs?: number;
  /** Judge cache dir (default paths(env).judgeCache); false skips it. */
  judgeCacheDir?: string | false;
  /** Judge cache size cap in bytes (default 256 MB). */
  judgeCacheMaxBytes?: number;
  /** Also reclaim index space (IndexStore.compact) when not a dry run. */
  compact?: boolean;
  /**
   * The ingest lock held across the blob and spool phases of a real run
   * (default: `<spoolDir>/.ingest.lock`, wait 30 s, taken only when the spool
   * dir exists). false = no lock (the caller serializes ingest and gc itself).
   */
  lock?: false | (LockOptions & { path?: string });
}

export interface GcResult {
  dryRun: boolean;
  blobs: {
    scanned: number;
    referenced: number;
    /** Unreferenced and old enough: deleted (or would be, in a dry run). */
    deleted: number;
    /** Compressed bytes freed (or that would be). */
    bytes: number;
    /** Unreferenced but younger than minBlobAgeMs. */
    skippedYoung: number;
    /** Unreferenced, but the store can't report age, so kept to be safe. */
    skippedNoAge: number;
    /** Referenced only by tool output older than retention.toolOutputDays (counted in deleted when swept). */
    expired: number;
    /** Orphan temp files of interrupted blob writes older than minBlobAgeMs, removed (or that would be). */
    tmpFiles: number;
    /** Their bytes (not counted in `bytes`). */
    tmpBytes: number;
  };
  judgeCache?: JudgeCacheGcResult;
  /** True when the index was compacted. */
  compacted?: boolean;
  /** Small blob files moved into the blob store's pack by --compact (file store only). */
  blobsPacked?: number;
  spool: {
    scanned: number;
    deleted: number;
    bytes: number;
    /** Side files (large raw payloads) removed: with their spool file, or unreferenced and older than keepSpoolDays. */
    rawFiles: number;
  };
}

type Stat = { size: number; mtimeMs: number };
type DeleteIfOlder = (ref: BlobRef, opts: { olderThanMs: number; now?: number }) => Promise<number | "kept" | undefined>;
type SweepTmp = (opts: { olderThanMs: number; now?: number; dryRun?: boolean }) => Promise<{ files: number; bytes: number }>;
type StatFn = (ref: BlobRef) => Promise<Stat | undefined>;
type CompactBlobs = () => Promise<{ packed: number }>;

/** Optional capability: stores that can report blob age implement stat(ref). */
function statOf(blobs: BlobStore): StatFn | undefined {
  const s = (blobs as BlobStore & { stat?: StatFn }).stat;
  return typeof s === "function" ? s.bind(blobs) : undefined;
}

export async function gc(opts: GcOptions): Promise<GcResult> {
  const { index } = opts;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? Date.now();
  const minAge = opts.minBlobAgeMs ?? DAY;
  const result: GcResult = {
    dryRun,
    blobs: { scanned: 0, referenced: 0, deleted: 0, bytes: 0, skippedYoung: 0, skippedNoAge: 0, expired: 0, tmpFiles: 0, tmpBytes: 0 },
    spool: { scanned: 0, deleted: 0, bytes: 0, rawFiles: 0 },
  };

  const spoolDir = opts.spoolDir ?? paths(opts.env ?? process.env).spool;
  let lock: Lock | undefined;
  if (!dryRun && opts.lock !== false && existsSync(spoolDir)) {
    const lo = opts.lock ?? {};
    lock = await acquireLock(lo.path ?? join(spoolDir, ".ingest.lock"), lo);
  }
  try {
    await sweepBlobs(opts, result, now, minAge, lock);
    await sweepSpool(opts, result, now, spoolDir, lock);
  } finally {
    lock?.release();
  }

  // ---- judge cache
  const jdir = opts.judgeCacheDir ?? paths(opts.env ?? process.env).judgeCache;
  if (jdir !== false) {
    const jopts: { dryRun: boolean; maxBytes?: number } = { dryRun };
    if (opts.judgeCacheMaxBytes !== undefined) jopts.maxBytes = opts.judgeCacheMaxBytes;
    result.judgeCache = await gcJudgeCache(jdir, jopts);
  }

  if (opts.compact && !dryRun && index.compact) {
    await index.compact();
    result.compacted = true;
  }
  const compactBlobs = (opts.blobs as BlobStore & { compact?: CompactBlobs }).compact;
  if (opts.compact && !dryRun && typeof compactBlobs === "function") result.blobsPacked = (await compactBlobs.call(opts.blobs)).packed;
  return result;
}

async function sweepBlobs(opts: GcOptions, result: GcResult, now: number, minAge: number, lock: Lock | undefined): Promise<void> {
  const { index, blobs, config, dryRun } = opts;
  // ---- blobs: mark
  const referenced = new Set<BlobRef>();
  for await (const ref of index.referencedBlobs()) referenced.add(ref);
  const days = config.retention.toolOutputDays;
  const scan = await scanEvents(index, days > 0 ? now - days * DAY : undefined);
  for (const ref of scan.expired) {
    if (referenced.delete(ref)) result.blobs.expired++;
  }
  const seenPages = new Set<BlobRef>();
  for (const doc of scan.pagedRequests) for (const ref of await requestBlobRefs(blobs, doc, seenPages)) referenced.add(ref);
  result.blobs.referenced = referenced.size;

  // ---- blobs: sweep
  const statFn = statOf(blobs);
  const deleteIfOlder = (blobs as BlobStore & { deleteIfOlder?: DeleteIfOlder }).deleteIfOlder;
  for await (const ref of blobs.list()) {
    result.blobs.scanned++;
    if (referenced.has(ref)) continue;
    if (!statFn) {
      result.blobs.skippedNoAge++;
      continue;
    }
    const s = await statFn(ref);
    if (!s) continue; // removed concurrently
    if (now - s.mtimeMs < minAge) {
      result.blobs.skippedYoung++;
      continue;
    }
    let size = s.size;
    if (!dryRun) {
      lock?.assertHeld();
      if (typeof deleteIfOlder === "function") {
        // Writers outside the ingest lock (backfill, otel, eval) may re-capture it right now.
        const removed = await deleteIfOlder.call(blobs, ref, { olderThanMs: minAge, now });
        if (removed === "kept") result.blobs.skippedYoung++;
        if (typeof removed !== "number") continue;
        size = removed;
      } else await blobs.delete(ref);
    }
    result.blobs.deleted++;
    result.blobs.bytes += size;
  }

  // ---- blobs: temp files of writes that never reached their rename (FsBlobStore)
  const sweepTmp = (blobs as BlobStore & { sweepTmp?: SweepTmp }).sweepTmp;
  if (typeof sweepTmp === "function") {
    if (!dryRun) lock?.assertHeld();
    const t = await sweepTmp.call(blobs, { olderThanMs: minAge, now, dryRun: !!dryRun });
    result.blobs.tmpFiles += t.files;
    result.blobs.tmpBytes += t.bytes;
  }
}

async function sweepSpool(opts: GcOptions, result: GcResult, now: number, spoolDir: string, lock: Lock | undefined): Promise<void> {
  const { index, config, dryRun } = opts;
  const keepMs = config.retention.keepSpoolDays * DAY;
  const sinkNames = config.sinks.map((s) => s.name ?? s.kind);
  const kept: SpoolFile[] = [];
  // Hooks append to the current UTC day's file without the lock, so it is never deleted (an
  // append between the check below and the unlink would be lost); nor is yesterday's for the
  // first hour, for a hook that took its timestamp just before midnight.
  const writable = new Date(now - HOUR).toISOString().slice(0, 10);
  for (const file of await listSpoolFiles(spoolDir)) {
    result.spool.scanned++;
    const day = spoolFileDay(file.source.slice(file.source.lastIndexOf("/") + 1));
    if (now - file.mtimeMs < keepMs || (day && day >= writable)) {
      kept.push(file);
      continue;
    }
    const cursors = [await index.getCursor(file.source)];
    for (const name of sinkNames) cursors.push(await index.getCursor(sinkCursorKey(name, file.source)));
    if (cursors.some((c) => c < file.size)) {
      kept.push(file);
      continue;
    }
    const raws = await rawFilesOf(spoolDir, file.path);
    let bytes = file.size;
    for (const raw of raws) bytes += await stat(raw).then((s) => s.size, () => 0);
    if (!dryRun) {
      // Appended since it was listed (the `coding.sh run` wrapper writes without the lock): keep it.
      const s = await stat(file.path).catch(() => undefined);
      if (s && (s.size !== file.size || s.mtimeMs !== file.mtimeMs)) {
        kept.push(file);
        continue;
      }
      lock?.assertHeld();
      for (const raw of raws) await unlink(raw).catch(() => {});
      await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      // A later file at this path is new content: every consumer starts it from 0.
      await index.setCursor(file.source, 0);
      for (const name of sinkNames) await index.setCursor(sinkCursorKey(name, file.source), 0);
    }
    result.spool.deleted++;
    result.spool.rawFiles += raws.length;
    result.spool.bytes += bytes;
  }
  await sweepOrphanRaw(opts, result, now, spoolDir, keepMs, kept, lock);
}

/**
 * Raw side files no remaining spool line references (the hook died, or its
 * append failed, between writing the side file and the line). They can hold
 * whole prompts or tool output, so they follow keepSpoolDays too.
 */
async function sweepOrphanRaw(opts: GcOptions, result: GcResult, now: number, spoolDir: string, keepMs: number, kept: SpoolFile[], lock: Lock | undefined): Promise<void> {
  const minAge = Math.max(keepMs, MIN_ORPHAN_RAW_AGE_MS);
  const candidates: { path: string; size: number }[] = [];
  for (const agent of await readdir(spoolDir).catch(() => [] as string[])) {
    const rawDir = join(spoolDir, agent, "raw");
    for (const name of await readdir(rawDir).catch(() => [] as string[])) {
      const path = join(rawDir, name);
      const s = await stat(path).catch(() => undefined);
      if (s?.isFile() && now - s.mtimeMs >= minAge) candidates.push({ path, size: s.size });
    }
  }
  if (!candidates.length) return;
  const referenced = new Set<string>();
  for (const file of kept) {
    for (const raw of await rawFilesOf(spoolDir, file.path).catch(() => [] as string[])) referenced.add(raw);
  }
  for (const c of candidates) {
    if (referenced.has(c.path)) continue;
    if (!opts.dryRun) {
      lock?.assertHeld();
      await unlink(c.path).catch(() => {});
    }
    result.spool.rawFiles++;
    result.spool.bytes += c.size;
  }
}

/**
 * One pass over the stored events. `expired`: blob refs held only by tool.end
 * events older than `cutoff` (none without a cutoff); a ref also held by a newer
 * event, any other kind of event, a task, bundle or run is kept.
 * `pagedRequests`: request documents whose messages are in blocks.
 */
async function scanEvents(index: IndexStore, cutoff: number | undefined): Promise<{ expired: Set<BlobRef>; pagedRequests: Set<BlobRef> }> {
  const candidates = new Set<BlobRef>();
  const keep = new Set<BlobRef>();
  const pagedRequests = new Set<BlobRef>();
  const PAGE = 500;
  // Without a cutoff only model calls matter.
  const opts = cutoff === undefined ? { kinds: ["llm.call"] } : undefined;
  for (let offset = 0; ; offset += PAGE) {
    const sessions = await index.listSessions({ limit: PAGE, offset });
    for (const s of sessions) {
      for (const e of await index.listEvents(s.id, opts)) {
        if (e.payload?.requestPaged === true && typeof e.payload.requestRef === "string") pagedRequests.add(e.payload.requestRef);
        if (cutoff === undefined || !e.blobs?.length) continue;
        const target = e.kind === "tool.end" && e.ts < cutoff ? candidates : keep;
        for (const ref of e.blobs) target.add(ref);
      }
    }
    if (sessions.length < PAGE) break;
  }
  if (!candidates.size) return { expired: candidates, pagedRequests };
  for (const t of await index.listTasks()) for (const r of taskBlobs(t)) keep.add(r);
  for (const b of await index.listBundles()) for (const r of bundleBlobs(b)) keep.add(r);
  for (const r of await index.listRuns()) for (const ref of runBlobs(r)) keep.add(ref);
  for (const ref of keep) candidates.delete(ref);
  return { expired: candidates, pagedRequests };
}
