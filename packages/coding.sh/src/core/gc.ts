// Garbage collection: mark-and-sweep of unreferenced blobs, plus removal of
// spool files every consumer (local index and each sink) has fully read.
//
// Retention: blobs held only by tool.end events older than
// retention.toolOutputDays (full tool output, file reads) count as
// unreferenced; the event and its truncated inline output stay. Diffs, eval
// tasks, bundles and run artifacts are never expired. The judge verdict cache
// is size-capped (oldest-used entries first).
//
// Safety: blobs younger than `minBlobAgeMs` are never swept, so an ingest that
// has stored a blob but not yet committed the event referencing it is safe.
// Dedupe hits refresh a blob's mtime (FsBlobStore), extending the same guard.
import { stat, unlink } from "node:fs/promises";
import type { BlobRef } from "../schema/index.ts";
import type { BlobStore, Config, IndexStore } from "./types.ts";
import { paths } from "./paths.ts";
import { bundleBlobs, runBlobs, taskBlobs } from "../store/common.ts";
import { gcJudgeCache, type JudgeCacheGcResult } from "../judge/cache.ts";
import { sinkCursorKey } from "./ingest.ts";
import { listSpoolFiles, rawFilesOf } from "./spool-read.ts";

const DAY = 86_400_000;

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
  };
  judgeCache?: JudgeCacheGcResult;
  /** True when the index was compacted. */
  compacted?: boolean;
  spool: {
    scanned: number;
    deleted: number;
    bytes: number;
    /** Side files (large raw payloads) removed with their spool file. */
    rawFiles: number;
  };
}

type Stat = { size: number; mtimeMs: number };
type StatFn = (ref: BlobRef) => Promise<Stat | undefined>;

/** Optional capability: stores that can report blob age implement stat(ref). */
function statOf(blobs: BlobStore): StatFn | undefined {
  const s = (blobs as BlobStore & { stat?: StatFn }).stat;
  return typeof s === "function" ? s.bind(blobs) : undefined;
}

export async function gc(opts: GcOptions): Promise<GcResult> {
  const { index, blobs, config } = opts;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? Date.now();
  const minAge = opts.minBlobAgeMs ?? DAY;
  const result: GcResult = {
    dryRun,
    blobs: { scanned: 0, referenced: 0, deleted: 0, bytes: 0, skippedYoung: 0, skippedNoAge: 0, expired: 0 },
    spool: { scanned: 0, deleted: 0, bytes: 0, rawFiles: 0 },
  };

  // ---- blobs: mark
  const referenced = new Set<BlobRef>();
  for await (const ref of index.referencedBlobs()) referenced.add(ref);
  const days = config.retention.toolOutputDays;
  if (days > 0) {
    for (const ref of await expiredToolOutput(index, now - days * DAY)) {
      if (referenced.delete(ref)) result.blobs.expired++;
    }
  }
  result.blobs.referenced = referenced.size;

  // ---- blobs: sweep
  const statFn = statOf(blobs);
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
    if (!dryRun) await blobs.delete(ref);
    result.blobs.deleted++;
    result.blobs.bytes += s.size;
  }

  // ---- spool
  const spoolDir = opts.spoolDir ?? paths(opts.env ?? process.env).spool;
  const keepMs = config.retention.keepSpoolDays * DAY;
  const sinkNames = config.sinks.map((s) => s.name ?? s.kind);
  for (const file of await listSpoolFiles(spoolDir)) {
    result.spool.scanned++;
    if (now - file.mtimeMs < keepMs) continue;
    const cursors = [await index.getCursor(file.source)];
    for (const name of sinkNames) cursors.push(await index.getCursor(sinkCursorKey(name, file.source)));
    if (cursors.some((c) => c < file.size)) continue;
    const raws = await rawFilesOf(spoolDir, file.path);
    let bytes = file.size;
    for (const raw of raws) bytes += await stat(raw).then((s) => s.size, () => 0);
    if (!dryRun) {
      for (const raw of raws) await unlink(raw).catch(() => {});
      await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    result.spool.deleted++;
    result.spool.rawFiles += raws.length;
    result.spool.bytes += bytes;
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
  return result;
}

/**
 * Blob refs held only by tool.end events older than `cutoff`. A ref also held
 * by a newer event, any other kind of event, a task, bundle or run is kept.
 */
async function expiredToolOutput(index: IndexStore, cutoff: number): Promise<Set<BlobRef>> {
  const candidates = new Set<BlobRef>();
  const keep = new Set<BlobRef>();
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const sessions = await index.listSessions({ limit: PAGE, offset });
    for (const s of sessions) {
      for (const e of await index.listEvents(s.id)) {
        if (!e.blobs?.length) continue;
        const target = e.kind === "tool.end" && e.ts < cutoff ? candidates : keep;
        for (const ref of e.blobs) target.add(ref);
      }
    }
    if (sessions.length < PAGE) break;
  }
  if (!candidates.size) return candidates;
  for (const t of await index.listTasks()) for (const r of taskBlobs(t)) keep.add(r);
  for (const b of await index.listBundles()) for (const r of bundleBlobs(b)) keep.add(r);
  for (const r of await index.listRuns()) for (const ref of runBlobs(r)) keep.add(ref);
  for (const ref of keep) candidates.delete(ref);
  return candidates;
}
