// Crash-safe file replacement: temp file, fsync, rename, fsync the directory.
// After a crash or power loss the path holds the old content or the new, never
// a torn or empty file, and a completed write survives.
import { randomBytes } from "node:crypto";
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
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameOver(tmp, path, opts.existingIsGood);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dirname(path));
}

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
