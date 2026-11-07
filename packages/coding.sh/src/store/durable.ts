// Crash-safe file replacement: temp file, flushed, rename, fsync the directory.
// After a crash or power loss the path holds the old content or the new, never
// a torn or empty file, and a completed write survives.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface DurableWriteOpts {
  /**
   * For content-addressed files: true when the file already at the path is as
   * good as ours, so a rename that loses a race to it drops the temp file instead.
   */
  existingIsGood?: () => Promise<boolean>;
}

/** Atomically replaces `path` with `data` and makes the result durable. */
export async function writeFileDurable(path: string, data: Uint8Array | string, opts: DurableWriteOpts = {}): Promise<void> {
  const tmp = await writeTemp(path, data);
  try {
    await renameOver(tmp, path, opts.existingIsGood);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dirname(path));
}

/**
 * The first half of writeFileDurable: `data` in a new temp file next to `path`
 * (`<path>.<pid>.<hex>.tmp`), written out to the device. Returns its path;
 * renameOver it into place, then syncDir. Nothing is left behind when it fails.
 *
 * Small files are opened O_DSYNC, so the write itself is the flush (one call,
 * not write + fsync). On macOS that pushes the data to the drive but not
 * through its cache: the F_FULLFSYNC of the syncDir that follows does that for
 * every file written before it. Windows has no O_DSYNC here: fsync.
 */
export async function writeTemp(path: string, data: Uint8Array | string): Promise<string> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const dsync = O_DSYNC !== undefined && (typeof data === "string" ? data.length * 3 : data.byteLength) <= DSYNC_MAX_BYTES;
  try {
    const fh = await open(tmp, dsync ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_DSYNC : "wx");
    try {
      await fh.writeFile(data);
      if (!dsync) await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return tmp;
}

/** Undefined where Node does not expose it (Windows). */
const O_DSYNC: number | undefined = (constants as { O_DSYNC?: number }).O_DSYNC;
/** Larger writes go out in chunks, each a flush under O_DSYNC: one fsync at the end is cheaper. */
const DSYNC_MAX_BYTES = 256 * 1024;

const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename(from, to), replacing `to`. On Windows that fails with EPERM, EACCES or
 * EBUSY while another handle has `to` open (a reader, a concurrent rename onto
 * the same name, an indexer) and clears once it closes, so it is retried for up
 * to ~2s. When `existingIsGood` says the file already at `to` will do (same
 * content-addressed name), `from` is removed instead. POSIX renames never fail
 * this way, so there this is a plain rename.
 */
export async function renameOver(from: string, to: string, existingIsGood?: () => Promise<boolean>): Promise<void> {
  for (let waited = 0, ms = 5; ; ms = Math.min(ms * 2, 200)) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !BUSY.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      if (existingIsGood && (await existingIsGood().catch(() => false))) return await unlink(from);
      if (waited >= 2000) throw err;
      await sleep(ms);
      waited += ms;
    }
  }
}

/** fsync a directory so a rename or a new entry in it survives a power loss. */
export async function syncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch (err) {
    // Windows cannot open or fsync a directory; there the rename is as durable as it gets.
    if (!["EISDIR", "EPERM", "EINVAL", "EACCES", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await fh?.close();
  }
}
